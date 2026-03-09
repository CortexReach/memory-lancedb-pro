import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginSdkStubPath = path.resolve(testDir, "helpers", "openclaw-plugin-sdk-stub.mjs");
const extensionApiStubPath = path.resolve(testDir, "helpers", "openclaw-extension-api-stub.mjs");
const jiti = jitiFactory(import.meta.url, {
  interopDefault: true,
  alias: {
    "openclaw/plugin-sdk": pluginSdkStubPath,
  },
});

const pluginModule = jiti("../index.ts");
const memoryLanceDBProPlugin = pluginModule.default || pluginModule;
const { readSessionConversationWithResetFallback, parsePluginConfig } = pluginModule;
const { MemoryStore } = jiti("../src/store.ts");
const { getDisplayCategoryTag } = jiti("../src/reflection-metadata.ts");
const {
  classifyReflectionRetry,
  computeReflectionRetryDelayMs,
  isReflectionNonRetryError,
  isTransientReflectionUpstreamError,
  runWithReflectionTransientRetryOnce,
} = jiti("../src/reflection-retry.ts");
const {
  storeReflectionToLanceDB,
  loadAgentReflectionSlicesFromEntries,
  loadAgentDerivedRowsWithScoresFromEntries,
  loadAgentDerivedFocusRowsForHandoffFromEntries,
  loadReflectionMappedRowsFromEntries,
} = jiti("../src/reflection-store.ts");
const { normalizeReflectionSoftKey } = jiti("../src/reflection-normalize.ts");
const { rankDynamicReflectionRecallFromEntries } = jiti("../src/reflection-recall.ts");
const { selectFinalAutoRecallResults } = jiti("../src/auto-recall-final-selection.ts");
const {
  createDynamicRecallSessionState,
  clearDynamicRecallSessionState,
  orchestrateDynamicRecall,
  normalizeRecallTextKey,
} = jiti("../src/recall-engine.ts");
const { shouldSkipRetrieval } = jiti("../src/adaptive-retrieval.ts");
const {
  REFLECTION_INVARIANT_DECAY_MIDPOINT_DAYS,
  REFLECTION_INVARIANT_DECAY_K,
  REFLECTION_INVARIANT_BASE_WEIGHT,
  REFLECTION_DERIVED_DECAY_MIDPOINT_DAYS,
  REFLECTION_DERIVED_DECAY_K,
  REFLECTION_DERIVED_BASE_WEIGHT,
} = jiti("../src/reflection-item-store.ts");
const { buildReflectionMappedMetadata } = jiti("../src/reflection-mapped-metadata.ts");
const { REFLECTION_FALLBACK_SCORE_FACTOR, computeReflectionScore } = jiti("../src/reflection-ranking.ts");
const { MemoryRetriever } = jiti("../src/retriever.ts");

function messageLine(role, text, ts) {
  return JSON.stringify({
    type: "message",
    timestamp: ts,
    message: {
      role,
      content: [{ type: "text", text }],
    },
  });
}

function makeEntry({ timestamp, metadata, category = "reflection", scope = "global" }) {
  return {
    id: `mem-${Math.random().toString(36).slice(2, 8)}`,
    text: "reflection-entry",
    vector: [],
    category,
    scope,
    importance: 0.7,
    timestamp,
    metadata: JSON.stringify(metadata),
  };
}

function baseConfig() {
  return {
    embedding: {
      apiKey: "test-api-key",
    },
  };
}

function createPluginApiHarness({ pluginConfig, resolveRoot }) {
  const eventHandlers = new Map();
  const commandHooks = new Map();
  const logs = [];

  const api = {
    pluginConfig,
    resolvePath(target) {
      if (typeof target !== "string") return target;
      if (path.isAbsolute(target)) return target;
      return path.join(resolveRoot, target);
    },
    logger: {
      info(message) {
        logs.push({ level: "info", message: String(message) });
      },
      warn(message) {
        logs.push({ level: "warn", message: String(message) });
      },
      debug(message) {
        logs.push({ level: "debug", message: String(message) });
      },
    },
    registerTool() {},
    registerCli() {},
    registerService() {},
    on(eventName, handler, meta) {
      const list = eventHandlers.get(eventName) || [];
      list.push({ handler, meta });
      eventHandlers.set(eventName, list);
    },
    registerHook(hookName, handler, meta) {
      const list = commandHooks.get(hookName) || [];
      list.push({ handler, meta });
      commandHooks.set(hookName, list);
    },
  };

  return {
    api,
    eventHandlers,
    commandHooks,
    logs,
  };
}

describe("memory reflection", () => {
  describe("command:new/reset session fallback helper", () => {
    let workDir;

    beforeEach(() => {
      workDir = mkdtempSync(path.join(tmpdir(), "reflection-fallback-test-"));
    });

    afterEach(() => {
      rmSync(workDir, { recursive: true, force: true });
    });

    it("falls back to latest reset snapshot when current session has only slash/control messages", async () => {
      const sessionsDir = path.join(workDir, "sessions");
      const sessionPath = path.join(sessionsDir, "abc123.jsonl");
      const resetOldPath = `${sessionPath}.reset.1700000000`;
      const resetNewPath = `${sessionPath}.reset.1700000001`;
      mkdirSync(sessionsDir, { recursive: true });

      writeFileSync(
        sessionPath,
        [messageLine("user", "/new", 1), messageLine("assistant", "/note self-improvement (before reset): ...", 2)].join("\n") + "\n",
        "utf-8"
      );
      writeFileSync(
        resetOldPath,
        [messageLine("user", "old reset snapshot", 3), messageLine("assistant", "old reset reply", 4)].join("\n") + "\n",
        "utf-8"
      );
      writeFileSync(
        resetNewPath,
        [
          messageLine("user", "Please keep responses concise and factual.", 5),
          messageLine("assistant", "Acknowledged. I will keep responses concise and factual.", 6),
        ].join("\n") + "\n",
        "utf-8"
      );

      const oldTime = new Date("2024-01-01T00:00:00Z");
      const newTime = new Date("2024-01-01T00:00:10Z");
      utimesSync(resetOldPath, oldTime, oldTime);
      utimesSync(resetNewPath, newTime, newTime);

      const conversation = await readSessionConversationWithResetFallback(sessionPath, 10);
      assert.ok(conversation);
      assert.match(conversation, /user: Please keep responses concise and factual\./);
      assert.match(conversation, /assistant: Acknowledged\. I will keep responses concise and factual\./);
      assert.doesNotMatch(conversation, /old reset snapshot/);
      assert.doesNotMatch(conversation, /^user:\s*\/new/m);
    });
  });

  describe("adaptive retrieval control prompt skip gate", () => {
    it("skips session-start boilerplate containing /new or /reset", () => {
      const prompt = "A new session was started via /new or /reset. Keep this in mind.";
      assert.equal(shouldSkipRetrieval(prompt), true);
    });

    it("skips startup boilerplate containing session startup sequence text", () => {
      const prompt = "Execute your Session Startup sequence now before continuing.";
      assert.equal(shouldSkipRetrieval(prompt), true);
    });

    it("skips /note handoff/control prompts", () => {
      const prompt = "Control wrapper line\n/note self-improvement (before reset): preserve incident timeline.";
      assert.equal(shouldSkipRetrieval(prompt), true);
    });

    it("does not skip a normal user task prompt", () => {
      const prompt = "Please draft a rollback checklist for mosdns and rclone incidents.";
      assert.equal(shouldSkipRetrieval(prompt), false);
    });
  });

  describe("display category tags", () => {
    it("uses scope tag for reflection entries", () => {
      assert.equal(
        getDisplayCategoryTag({
          category: "reflection",
          scope: "project-a",
          metadata: JSON.stringify({ type: "memory-reflection-item", itemKind: "invariant" }),
        }),
        "reflection:project-a"
      );

      assert.equal(
        getDisplayCategoryTag({
          category: "reflection",
          scope: "project-b",
          metadata: JSON.stringify({
            type: "memory-reflection-item",
            reflectionVersion: 4,
            itemKind: "derived",
          }),
        }),
        "reflection:project-b"
      );
    });

    it("uses scope tag for reflection rows with optional metadata fields", () => {
      assert.equal(
        getDisplayCategoryTag({
          category: "reflection",
          scope: "global",
          metadata: JSON.stringify({
            type: "memory-reflection-item",
            reflectionVersion: 4,
            itemKind: "invariant",
            baseWeight: 1.1,
          }),
        }),
        "reflection:global"
      );

      assert.equal(
        getDisplayCategoryTag({
          category: "reflection",
          scope: "global",
          metadata: JSON.stringify({
            type: "memory-reflection-event",
            reflectionVersion: 4,
            eventId: "refl-test",
          }),
        }),
        "reflection:global"
      );
    });

    it("preserves non-reflection display categories", () => {
      assert.equal(
        getDisplayCategoryTag({
          category: "fact",
          scope: "global",
          metadata: "{}",
        }),
        "fact:global"
      );
    });
  });

  describe("transient retry classifier", () => {
    it("classifies unexpected EOF as transient upstream error", () => {
      const isTransient = isTransientReflectionUpstreamError(new Error("unexpected EOF while reading upstream response"));
      assert.equal(isTransient, true);
    });

    it("classifies auth/billing/model/context/session/refusal errors as non-retry", () => {
      assert.equal(isReflectionNonRetryError(new Error("401 unauthorized: invalid api key")), true);
      assert.equal(isReflectionNonRetryError(new Error("insufficient credits for this request")), true);
      assert.equal(isReflectionNonRetryError(new Error("model not found: gpt-x")), true);
      assert.equal(isReflectionNonRetryError(new Error("context length exceeded")), true);
      assert.equal(isReflectionNonRetryError(new Error("session expired, please re-authenticate")), true);
      assert.equal(isReflectionNonRetryError(new Error("refusal due to safety policy")), true);
    });

    it("allows retry only in reflection scope with zero useful output and retryCount=0", () => {
      const allowed = classifyReflectionRetry({
        inReflectionScope: true,
        retryCount: 0,
        usefulOutputChars: 0,
        error: new Error("upstream temporarily unavailable (503)"),
      });
      assert.equal(allowed.retryable, true);
      assert.equal(allowed.reason, "transient_upstream_failure");

      const notScope = classifyReflectionRetry({
        inReflectionScope: false,
        retryCount: 0,
        usefulOutputChars: 0,
        error: new Error("unexpected EOF"),
      });
      assert.equal(notScope.retryable, false);
      assert.equal(notScope.reason, "not_reflection_scope");

      const hadOutput = classifyReflectionRetry({
        inReflectionScope: true,
        retryCount: 0,
        usefulOutputChars: 12,
        error: new Error("unexpected EOF"),
      });
      assert.equal(hadOutput.retryable, false);
      assert.equal(hadOutput.reason, "useful_output_present");

      const retryUsed = classifyReflectionRetry({
        inReflectionScope: true,
        retryCount: 1,
        usefulOutputChars: 0,
        error: new Error("unexpected EOF"),
      });
      assert.equal(retryUsed.retryable, false);
      assert.equal(retryUsed.reason, "retry_already_used");
    });

    it("computes jitter delay in the required 1-3s range", () => {
      assert.equal(computeReflectionRetryDelayMs(() => 0), 1000);
      assert.equal(computeReflectionRetryDelayMs(() => 0.5), 2000);
      assert.equal(computeReflectionRetryDelayMs(() => 1), 3000);
    });
  });

  describe("runWithReflectionTransientRetryOnce", () => {
    it("retries once and succeeds for transient failures", async () => {
      let attempts = 0;
      const sleeps = [];
      const logs = [];
      const retryState = { count: 0 };

      const result = await runWithReflectionTransientRetryOnce({
        scope: "reflection",
        runner: "embedded",
        retryState,
        execute: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("unexpected EOF from provider");
          }
          return "ok";
        },
        random: () => 0,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        onLog: (level, message) => logs.push({ level, message }),
      });

      assert.equal(result, "ok");
      assert.equal(attempts, 2);
      assert.equal(retryState.count, 1);
      assert.deepEqual(sleeps, [1000]);
      assert.equal(logs.length, 2);
      assert.match(logs[0].message, /transient upstream failure detected/i);
      assert.match(logs[0].message, /retrying once in 1000ms/i);
      assert.match(logs[1].message, /retry succeeded/i);
    });

    it("does not retry non-transient failures", async () => {
      let attempts = 0;
      const retryState = { count: 0 };

      await assert.rejects(
        runWithReflectionTransientRetryOnce({
          scope: "reflection",
          runner: "cli",
          retryState,
          execute: async () => {
            attempts += 1;
            throw new Error("invalid api key");
          },
          sleep: async () => { },
        }),
        /invalid api key/i
      );

      assert.equal(attempts, 1);
      assert.equal(retryState.count, 0);
    });

    it("does not loop: exhausted after one retry", async () => {
      let attempts = 0;
      const logs = [];
      const retryState = { count: 0 };

      await assert.rejects(
        runWithReflectionTransientRetryOnce({
          scope: "distiller",
          runner: "cli",
          retryState,
          execute: async () => {
            attempts += 1;
            throw new Error("service unavailable 503");
          },
          random: () => 0.1,
          sleep: async () => { },
          onLog: (level, message) => logs.push({ level, message }),
        }),
        /service unavailable/i
      );

      assert.equal(attempts, 2);
      assert.equal(retryState.count, 1);
      assert.equal(logs.length, 2);
      assert.match(logs[1].message, /retry exhausted/i);
    });
  });

  describe("reflection persistence", () => {
    it("stores event + itemized rows", async () => {
      const storedEntries = [];

      const result = await storeReflectionToLanceDB({
        reflectionText: [
          "## Invariants",
          "- Always confirm assumptions before changing files.",
          "## Derived",
          "- Next run verify reflection persistence with targeted tests.",
        ].join("\n"),
        sessionKey: "agent:main:session:abc",
        sessionId: "abc",
        agentId: "main",
        command: "command:reset",
        scope: "global",
        toolErrorSignals: [{ signatureHash: "deadbeef" }],
        runAt: 1_700_000_000_000,
        usedFallback: false,
        sourceReflectionPath: "memory/reflections/2026-03-07/test.md",
        embedPassage: async (text) => [text.length],
        store: async (entry) => {
          storedEntries.push(entry);
          return { ...entry, id: `id-${storedEntries.length}`, timestamp: 1_700_000_000_000 };
        },
      });

      assert.equal(result.stored, true);
      assert.deepEqual(result.storedKinds, ["event", "item-invariant", "item-derived"]);
      assert.equal(storedEntries.length, 3);

      const metas = storedEntries.map((entry) => JSON.parse(entry.metadata));
      const eventMeta = metas.find((meta) => meta.type === "memory-reflection-event");
      const invariantMeta = metas.find((meta) => meta.type === "memory-reflection-item" && meta.itemKind === "invariant");
      const derivedMeta = metas.find((meta) => meta.type === "memory-reflection-item" && meta.itemKind === "derived");

      assert.ok(eventMeta);
      assert.equal(eventMeta.reflectionVersion, 4);
      assert.equal(eventMeta.stage, "reflect-store");
      assert.match(eventMeta.eventId, /^refl-/);
      assert.equal(eventMeta.sourceReflectionPath, "memory/reflections/2026-03-07/test.md");
      assert.equal(eventMeta.usedFallback, false);
      assert.deepEqual(eventMeta.errorSignals, ["deadbeef"]);
      assert.equal(Array.isArray(eventMeta.invariants), false);
      assert.equal(Array.isArray(eventMeta.derived), false);

      assert.ok(invariantMeta);
      assert.equal(invariantMeta.reflectionVersion, 4);
      assert.equal(invariantMeta.itemKind, "invariant");
      assert.equal(invariantMeta.section, "Invariants");
      assert.equal(invariantMeta.ordinal, 0);
      assert.equal(invariantMeta.groupSize, 1);
      assert.equal(invariantMeta.decayMidpointDays, REFLECTION_INVARIANT_DECAY_MIDPOINT_DAYS);
      assert.equal(invariantMeta.decayK, REFLECTION_INVARIANT_DECAY_K);
      assert.equal(invariantMeta.baseWeight, REFLECTION_INVARIANT_BASE_WEIGHT);
      assert.equal(invariantMeta.usedFallback, false);

      assert.ok(derivedMeta);
      assert.equal(derivedMeta.reflectionVersion, 4);
      assert.equal(derivedMeta.itemKind, "derived");
      assert.equal(derivedMeta.section, "Derived");
      assert.equal(derivedMeta.ordinal, 0);
      assert.equal(derivedMeta.groupSize, 1);
      assert.equal(derivedMeta.decayMidpointDays, REFLECTION_DERIVED_DECAY_MIDPOINT_DAYS);
      assert.equal(derivedMeta.decayK, REFLECTION_DERIVED_DECAY_K);
      assert.equal(derivedMeta.baseWeight, REFLECTION_DERIVED_BASE_WEIGHT);
      assert.equal(derivedMeta.usedFallback, false);
    });

    it("writes an event row even when invariant/derived slices are empty", async () => {
      const storedEntries = [];
      const result = await storeReflectionToLanceDB({
        reflectionText: "## Context\n- run had no durable deltas",
        sessionKey: "agent:main:session:ghi",
        sessionId: "ghi",
        agentId: "main",
        command: "command:new",
        scope: "global",
        toolErrorSignals: [],
        runAt: 1_700_200_000_000,
        usedFallback: true,
        embedPassage: async (text) => [text.length],
        store: async (entry) => {
          storedEntries.push(entry);
          return { ...entry, id: `id-${storedEntries.length}`, timestamp: 1_700_200_000_000 };
        },
      });

      assert.deepEqual(result.storedKinds, ["event"]);
      assert.equal(storedEntries.length, 1);
      const meta = JSON.parse(storedEntries[0].metadata);
      assert.equal(meta.type, "memory-reflection-event");
      assert.equal(meta.usedFallback, true);
    });
  });

  describe("reflection slice loading", () => {
    it("loads itemized reflection rows", () => {
      const now = Date.UTC(2026, 2, 7);
      const day = 24 * 60 * 60 * 1000;
      const entries = [
        makeEntry({
          timestamp: now - 1 * day,
          metadata: {
            type: "memory-reflection-item",
            itemKind: "invariant",
            agentId: "main",
            storedAt: now - 1 * day,
            decayMidpointDays: 45,
            decayK: 0.22,
            baseWeight: 1.1,
            quality: 1,
          },
        }),
        makeEntry({
          timestamp: now - 1 * day,
          metadata: {
            type: "memory-reflection-item",
            itemKind: "derived",
            agentId: "main",
            storedAt: now - 1 * day,
            decayMidpointDays: 7,
            decayK: 0.65,
            baseWeight: 1,
            quality: 0.95,
          },
        }),
      ];

      entries[0].text = "Always use itemized rows first.";
      entries[1].text = "Next run prioritize itemized reflection rows.";

      const slices = loadAgentReflectionSlicesFromEntries({
        entries,
        agentId: "main",
        now,
        deriveMaxAgeMs: 7 * day,
      });

      assert.deepEqual(slices.invariants, ["Always use itemized rows first."]);
      assert.deepEqual(slices.derived, ["Next run prioritize itemized reflection rows."]);
    });

    it("aggregates duplicate item text and applies fallback penalty in derived ranking", () => {
      const now = Date.UTC(2026, 2, 7);
      const day = 24 * 60 * 60 * 1000;

      const entries = [
        makeEntry({
          timestamp: now - 1 * day,
          metadata: {
            type: "memory-reflection-item",
            itemKind: "derived",
            agentId: "main",
            storedAt: now - 1 * day,
            decayMidpointDays: 7,
            decayK: 0.65,
            baseWeight: 1,
            quality: 1,
            usedFallback: false,
          },
        }),
        makeEntry({
          timestamp: now - 2 * day,
          metadata: {
            type: "memory-reflection-item",
            itemKind: "derived",
            agentId: "main",
            storedAt: now - 2 * day,
            decayMidpointDays: 7,
            decayK: 0.65,
            baseWeight: 1,
            quality: 1,
            usedFallback: false,
          },
        }),
        makeEntry({
          timestamp: now - 1 * day,
          metadata: {
            type: "memory-reflection-item",
            itemKind: "derived",
            agentId: "main",
            storedAt: now - 1 * day,
            decayMidpointDays: 7,
            decayK: 0.65,
            baseWeight: 1,
            quality: 1,
            usedFallback: true,
          },
        }),
      ];

      entries[0].text = "Repeat verification path";
      entries[1].text = "repeat   verification   path";
      entries[2].text = "Fresh fallback derive";

      const slices = loadAgentReflectionSlicesFromEntries({
        entries,
        agentId: "main",
        now,
        deriveMaxAgeMs: 7 * day,
      });

      assert.equal(slices.derived[0], "Repeat verification path");
      assert.ok(slices.derived.includes("Fresh fallback derive"));
      assert.equal(REFLECTION_FALLBACK_SCORE_FACTOR, 0.75);
    });

    it("returns historical derived rows with retained scores after dedupe+decay", () => {
      const now = Date.UTC(2026, 2, 8);
      const day = 24 * 60 * 60 * 1000;

      const entries = [
        makeEntry({
          timestamp: now - 1 * day,
          metadata: {
            type: "memory-reflection-item",
            itemKind: "derived",
            agentId: "main",
            storedAt: now - 1 * day,
            decayMidpointDays: 7,
            decayK: 0.65,
            baseWeight: 1,
            quality: 1,
          },
        }),
        makeEntry({
          timestamp: now - 50 * day,
          metadata: {
            type: "memory-reflection-item",
            itemKind: "derived",
            agentId: "main",
            storedAt: now - 50 * day,
            decayMidpointDays: 7,
            decayK: 0.65,
            baseWeight: 1,
            quality: 1,
          },
        }),
      ];
      entries[0].text = "Historical high-score derived line";
      entries[1].text = "Historical low-score derived line";

      const rows = loadAgentDerivedRowsWithScoresFromEntries({
        entries,
        agentId: "main",
        now,
        deriveMaxAgeMs: 60 * day,
        limit: 10,
      });

      const highRow = rows.find((row) => row.text === "Historical high-score derived line");
      const lowRow = rows.find((row) => row.text === "Historical low-score derived line");
      assert.ok(highRow && highRow.score > 0.3);
      assert.ok(lowRow && lowRow.score < 0.3);
    });

    it("applies non-linear saturation so exact duplicates do not scale linearly", () => {
      const now = Date.UTC(2026, 2, 8, 12, 0, 0);
      const day = 24 * 60 * 60 * 1000;
      const repeatedLine = "Repeat post-check verification path before declaring success.";

      const entries = Array.from({ length: 12 }, (_, idx) =>
        makeEntry({
          timestamp: now - (idx % 2) * day,
          metadata: {
            type: "memory-reflection-item",
            itemKind: "derived",
            agentId: "main",
            storedAt: now - (idx % 2) * day,
            decayMidpointDays: 7,
            decayK: 0.65,
            baseWeight: 1,
            quality: 1,
            usedFallback: false,
          },
        })
      );
      for (const entry of entries) {
        entry.text = repeatedLine;
      }

      const rows = loadAgentDerivedRowsWithScoresFromEntries({
        entries,
        agentId: "main",
        now,
        deriveMaxAgeMs: 30 * day,
        limit: 36,
      });

      const repeated = rows.find((row) => row.text === repeatedLine);
      assert.ok(repeated);

      const singleItemScore = computeReflectionScore({
        ageDays: 1,
        midpointDays: 7,
        k: 0.65,
        baseWeight: 1,
        quality: 1,
        usedFallback: false,
      });
      const naiveLinear = singleItemScore * 12;
      assert.ok(repeated.score < naiveLinear * 0.25);
      assert.ok(repeated.score > singleItemScore * 0.8);
    });

    it("prefers representative non-fallback text instead of always taking the newest variant", () => {
      const now = Date.UTC(2026, 2, 8, 12, 0, 0);
      const day = 24 * 60 * 60 * 1000;
      const entries = [
        makeEntry({
          timestamp: now - 2 * day,
          metadata: {
            type: "memory-reflection-item",
            itemKind: "derived",
            agentId: "main",
            storedAt: now - 2 * day,
            decayMidpointDays: 7,
            decayK: 0.65,
            baseWeight: 1,
            quality: 1,
            usedFallback: false,
          },
        }),
        makeEntry({
          timestamp: now - 1 * day,
          metadata: {
            type: "memory-reflection-item",
            itemKind: "derived",
            agentId: "main",
            storedAt: now - 1 * day,
            decayMidpointDays: 7,
            decayK: 0.65,
            baseWeight: 1,
            quality: 1,
            usedFallback: true,
          },
        }),
      ];
      entries[0].text = "Use deterministic post-check command list.";
      entries[1].text = "Use deterministic post-check command list!";

      const rows = loadAgentDerivedRowsWithScoresFromEntries({
        entries,
        agentId: "main",
        now,
        deriveMaxAgeMs: 30 * day,
        limit: 36,
      });

      assert.equal(rows[0].text, "Use deterministic post-check command list.");
    });

    it("expands historical shortlist beyond 24 so deeper candidates remain available", () => {
      const now = Date.UTC(2026, 2, 8, 12, 0, 0);
      const day = 24 * 60 * 60 * 1000;

      const entries = Array.from({ length: 32 }, (_, idx) =>
        makeEntry({
          timestamp: now - (idx % 4) * day,
          metadata: {
            type: "memory-reflection-item",
            itemKind: "derived",
            agentId: "main",
            storedAt: now - (idx % 4) * day,
            decayMidpointDays: 7,
            decayK: 0.65,
            baseWeight: 1,
            quality: 0.95,
            usedFallback: false,
          },
        })
      );
      for (let i = 0; i < entries.length; i += 1) {
        entries[i].text = `Shortlist candidate ${i + 1}: preserve deterministic verification evidence.`;
      }

      const rows10 = loadAgentDerivedRowsWithScoresFromEntries({
        entries,
        agentId: "main",
        now,
        deriveMaxAgeMs: 30 * day,
        limit: 10,
      });
      const rows24 = loadAgentDerivedRowsWithScoresFromEntries({
        entries,
        agentId: "main",
        now,
        deriveMaxAgeMs: 30 * day,
        limit: 24,
      });
      const rows36 = loadAgentDerivedRowsWithScoresFromEntries({
        entries,
        agentId: "main",
        now,
        deriveMaxAgeMs: 30 * day,
        limit: 36,
      });

      assert.equal(rows10.length, 10);
      assert.equal(rows24.length, 24);
      assert.equal(rows36.length, 32);
      assert.ok(rows36.slice(24).length > 0);
      assert.ok(rows36.slice(24).every((row) => typeof row.text === "string" && row.text.length > 0));
    });

    it("keeps final derived-focus selection capped at 13 without applying a hard score threshold", () => {
      const now = Date.UTC(2026, 2, 8, 12, 0, 0);
      const day = 24 * 60 * 60 * 1000;

      const strongEntries = Array.from({ length: 12 }, (_, idx) =>
        makeEntry({
          timestamp: now - (idx % 3) * day,
          metadata: {
            type: "memory-reflection-item",
            itemKind: "derived",
            agentId: "main",
            storedAt: now - (idx % 3) * day,
            decayMidpointDays: 7,
            decayK: 0.65,
            baseWeight: 1,
            quality: 0.95,
            usedFallback: false,
          },
        })
      );
      strongEntries.forEach((entry, idx) => {
        entry.text = `Strong candidate ${idx + 1}: keep post-check output deterministic.`;
      });

      const borderline = makeEntry({
        timestamp: now - 35 * day,
        metadata: {
          type: "memory-reflection-item",
          itemKind: "derived",
          agentId: "main",
          storedAt: now - 35 * day,
          decayMidpointDays: 7,
          decayK: 0.65,
          baseWeight: 1,
          quality: 0.6,
          usedFallback: false,
        },
      });
      borderline.text = "Borderline low-score candidate that should still remain eligible without score gating.";

      const veryOldEntries = Array.from({ length: 8 }, (_, idx) =>
        makeEntry({
          timestamp: now - (70 + idx) * day,
          metadata: {
            type: "memory-reflection-item",
            itemKind: "derived",
            agentId: "main",
            storedAt: now - (70 + idx) * day,
            decayMidpointDays: 7,
            decayK: 0.65,
            baseWeight: 1,
            quality: 0.55,
            usedFallback: false,
          },
        })
      );
      veryOldEntries.forEach((entry, idx) => {
        entry.text = `Very old candidate ${idx + 1}: likely ranked below borderline.`;
      });

      const rows = loadAgentDerivedFocusRowsForHandoffFromEntries({
        entries: [...strongEntries, borderline, ...veryOldEntries],
        agentId: "main",
        now,
        deriveMaxAgeMs: 90 * day,
        shortlistLimit: 36,
        finalLimit: 13,
      });
      const borderlineRow = rows.find((row) => row.text.includes("Borderline low-score candidate"));

      assert.equal(rows.length, 13);
      assert.ok(borderlineRow);
      assert.ok(borderlineRow.score < 0.3);
    });

    it("uses diversity-aware ordering so near-duplicate soft-keys do not saturate the final output", () => {
      const now = Date.UTC(2026, 2, 8, 12, 0, 0);
      const day = 24 * 60 * 60 * 1000;
      const similarLines = [
        "Validate /root/work mount health after service restart.",
        "Validate root/work mount health after service restart.",
        "validate root work mount health after service restart",
        "Validate root-work mount health after service restart.",
        "Validate root (work) mount health after service restart.",
        "Validate root\\work mount health after service restart.",
      ];
      const diverseLines = [
        "Keep DNS post-check output with getent host evidence.",
        "Track proxy failover endpoint and retry timing explicitly.",
        "Record exact UTC timestamps for each recovery action.",
        "Confirm reflection handoff note does not include stale loops.",
        "Gate risky service changes behind focused preflight checks.",
        "Capture one-line rollback steps before applying infra edits.",
        "Write recovery commands in execution order to avoid skipped steps.",
        "Tag unresolved blockers explicitly so follow-up runs can prioritize them.",
        "Capture exact command output snippets that prove service recovery.",
        "Prefer a minimal blast-radius rollback command before retries.",
        "Record dependency assumptions before changing shared config files.",
        "Keep one deterministic verification command per subsystem.",
        "Document expected service states before applying risky edits.",
        "List one explicit next owner/action for each open loop.",
      ];

      const entries = [];
      for (const line of similarLines) {
        const entry = makeEntry({
          timestamp: now - 1 * day,
          metadata: {
            type: "memory-reflection-item",
            itemKind: "derived",
            agentId: "main",
            storedAt: now - 1 * day,
            decayMidpointDays: 7,
            decayK: 0.65,
            baseWeight: 1,
            quality: 1,
            usedFallback: false,
          },
        });
        entry.text = line;
        entries.push(entry);
      }
      for (const line of diverseLines) {
        const entry = makeEntry({
          timestamp: now - 1 * day,
          metadata: {
            type: "memory-reflection-item",
            itemKind: "derived",
            agentId: "main",
            storedAt: now - 1 * day,
            decayMidpointDays: 7,
            decayK: 0.65,
            baseWeight: 1,
            quality: 0.62,
            usedFallback: false,
          },
        });
        entry.text = line;
        entries.push(entry);
      }

      const rows = loadAgentDerivedFocusRowsForHandoffFromEntries({
        entries,
        agentId: "main",
        now,
        deriveMaxAgeMs: 30 * day,
        shortlistLimit: 36,
        finalLimit: 13,
      });
      const duplicateSoftKey = normalizeReflectionSoftKey(similarLines[0]);

      const duplicateSoftKeyCount = rows.filter((row) => normalizeReflectionSoftKey(row.text) === duplicateSoftKey).length;
      const uniqueSoftKeys = new Set(rows.map((row) => normalizeReflectionSoftKey(row.text)));

      assert.equal(rows.length, 13);
      assert.equal(duplicateSoftKeyCount, 1);
      assert.ok(uniqueSoftKeys.size >= 12);
    });
  });

  describe("mapped reflection metadata and ranking", () => {
    it("builds enriched mapped metadata with decay defaults and provenance", () => {
      const metadata = buildReflectionMappedMetadata({
        mappedItem: {
          text: "User prefers terse incident updates.",
          category: "preference",
          heading: "User model deltas (about the human)",
          mappedKind: "user-model",
          ordinal: 0,
          groupSize: 2,
        },
        eventId: "refl-20260307-abc123",
        agentId: "main",
        sessionKey: "agent:main:session:abc",
        sessionId: "abc",
        runAt: 1_741_356_000_000,
        usedFallback: false,
        toolErrorSignals: [{ signatureHash: "deadbeef1234abcd" }],
        sourceReflectionPath: "memory/reflections/2026-03-07/test.md",
      });

      assert.equal(metadata.type, "memory-reflection-mapped");
      assert.equal(metadata.reflectionVersion, 4);
      assert.equal(metadata.eventId, "refl-20260307-abc123");
      assert.equal(metadata.mappedKind, "user-model");
      assert.equal(metadata.mappedCategory, "preference");
      assert.equal(metadata.ordinal, 0);
      assert.equal(metadata.groupSize, 2);
      assert.equal(metadata.decayMidpointDays, 21);
      assert.equal(metadata.decayK, 0.3);
      assert.equal(metadata.baseWeight, 1);
      assert.equal(metadata.quality, 0.95);
      assert.deepEqual(metadata.errorSignals, ["deadbeef1234abcd"]);
    });

    it("loads mapped rows with decay-aware ranking and fallback penalty", () => {
      const now = Date.UTC(2026, 2, 7);
      const day = 24 * 60 * 60 * 1000;

      const entries = [
        makeEntry({
          timestamp: now - 1 * day,
          category: "preference",
          metadata: {
            type: "memory-reflection-mapped",
            mappedKind: "user-model",
            agentId: "main",
            storedAt: now - 1 * day,
            decayMidpointDays: 21,
            decayK: 0.3,
            baseWeight: 1,
            quality: 1,
            usedFallback: false,
          },
        }),
        makeEntry({
          timestamp: now - 1 * day,
          category: "preference",
          metadata: {
            type: "memory-reflection-mapped",
            mappedKind: "user-model",
            agentId: "main",
            storedAt: now - 1 * day,
            decayMidpointDays: 21,
            decayK: 0.3,
            baseWeight: 1,
            quality: 1,
            usedFallback: true,
          },
        }),
        makeEntry({
          timestamp: now - 1 * day,
          category: "decision",
          metadata: {
            type: "memory-reflection-mapped",
            mappedKind: "decision",
            agentId: "main",
            storedAt: now - 1 * day,
            decayMidpointDays: 45,
            decayK: 0.25,
            baseWeight: 1.1,
            quality: 1,
            usedFallback: false,
          },
        }),
      ];
      entries[0].text = "User likes concise status checkpoints.";
      entries[1].text = "User likes fallback-generated status checkpoints.";
      entries[2].text = "Keep decision logs with explicit UTC timestamps.";

      const mapped = loadReflectionMappedRowsFromEntries({
        entries,
        agentId: "main",
        now,
        maxAgeMs: 14 * day,
      });

      assert.equal(mapped.userModel[0], "User likes concise status checkpoints.");
      assert.ok(mapped.userModel.includes("User likes fallback-generated status checkpoints."));
      assert.equal(mapped.decision[0], "Keep decision logs with explicit UTC timestamps.");
    });

    it("keeps ordinary display categories for mapped durable rows", () => {
      assert.equal(
        getDisplayCategoryTag({
          category: "preference",
          scope: "global",
          metadata: JSON.stringify({ type: "memory-reflection-mapped", mappedKind: "user-model" }),
        }),
        "preference:global"
      );
    });
  });

  describe("generic auto-recall final selection", () => {
    function makeRetrievalResult({ id, text, score, category, scope, timestamp, vector = [] }) {
      return {
        entry: {
          id,
          text,
          category,
          scope,
          timestamp,
          vector,
          importance: 0.8,
          metadata: "{}",
        },
        score,
        sources: {},
      };
    }

    it("keeps strongest rank-1 while reducing duplicate saturation with light category/scope coverage", () => {
      const now = Date.UTC(2026, 2, 8, 12, 0, 0);
      const day = 24 * 60 * 60 * 1000;
      const rows = [
        makeRetrievalResult({
          id: "dup-1",
          text: "Verify DNS and mount health after service restart.",
          score: 0.99,
          category: "fact",
          scope: "global",
          timestamp: now - 1 * day,
        }),
        makeRetrievalResult({
          id: "dup-2",
          text: "Verify dns and mount health after service restart!",
          score: 0.985,
          category: "fact",
          scope: "global",
          timestamp: now - 1 * day,
        }),
        makeRetrievalResult({
          id: "dup-3",
          text: "verify dns mount health after service restart",
          score: 0.98,
          category: "fact",
          scope: "global",
          timestamp: now - 1 * day,
        }),
        makeRetrievalResult({
          id: "decision-1",
          text: "Record rollback command before changing service units.",
          score: 0.95,
          category: "decision",
          scope: "global",
          timestamp: now - 2 * day,
        }),
        makeRetrievalResult({
          id: "pref-1",
          text: "Prefer concise post-check summaries in final responses.",
          score: 0.945,
          category: "preference",
          scope: "agent:main",
          timestamp: now - 1 * day,
        }),
        makeRetrievalResult({
          id: "entity-1",
          text: "Service dependency map includes mosdns and rclone.",
          score: 0.94,
          category: "entity",
          scope: "project:ops",
          timestamp: now - 3 * day,
        }),
      ];

      const selected = selectFinalAutoRecallResults(rows, { topK: 4, now });

      assert.equal(selected.length, 4);
      assert.equal(selected[0].entry.id, "dup-1");

      const duplicateKey = normalizeRecallTextKey(rows[0].entry.text);
      const duplicateCount = selected.filter((row) => normalizeRecallTextKey(row.entry.text) === duplicateKey).length;
      assert.equal(duplicateCount, 1);
      assert.ok(new Set(selected.map((row) => row.entry.category)).size >= 3);
      assert.ok(new Set(selected.map((row) => row.entry.scope)).size >= 2);
    });

    it("is deterministic for the same candidate set regardless of input order", () => {
      const now = Date.UTC(2026, 2, 8, 12, 0, 0);
      const day = 24 * 60 * 60 * 1000;
      const rows = [
        makeRetrievalResult({
          id: "dup-1",
          text: "Keep DNS and mount post-checks in recovery flow.",
          score: 0.97,
          category: "fact",
          scope: "global",
          timestamp: now - 1 * day,
        }),
        makeRetrievalResult({
          id: "dup-2",
          text: "Keep dns and mount post-checks in recovery flow!",
          score: 0.965,
          category: "fact",
          scope: "global",
          timestamp: now - 1 * day,
        }),
        makeRetrievalResult({
          id: "decision-1",
          text: "Log rollback command and expected service state before edits.",
          score: 0.94,
          category: "decision",
          scope: "global",
          timestamp: now - 2 * day,
        }),
        makeRetrievalResult({
          id: "pref-1",
          text: "Respond with concise and factual status updates.",
          score: 0.938,
          category: "preference",
          scope: "agent:main",
          timestamp: now - 1 * day,
        }),
      ];

      const forward = selectFinalAutoRecallResults(rows, { topK: 3, now });
      const reversed = selectFinalAutoRecallResults([...rows].reverse(), { topK: 3, now });

      assert.deepEqual(
        forward.map((row) => row.entry.id),
        reversed.map((row) => row.entry.id)
      );
    });

    it("suppresses lexical-overlap paraphrases even when normalized keys differ", () => {
      const now = Date.UTC(2026, 2, 8, 12, 0, 0);
      const day = 24 * 60 * 60 * 1000;
      const rows = [
        makeRetrievalResult({
          id: "dup-1",
          text: "Keep DNS/mount post-check command list after service restart.",
          score: 0.99,
          category: "fact",
          scope: "global",
          timestamp: now - 1 * day,
        }),
        makeRetrievalResult({
          id: "dup-2",
          text: "Keep DNS mount post check command list after service restart",
          score: 0.987,
          category: "fact",
          scope: "global",
          timestamp: now - 1 * day,
        }),
        makeRetrievalResult({
          id: "dup-3",
          text: "Keep DNS-mount post check command list after service restart",
          score: 0.984,
          category: "fact",
          scope: "global",
          timestamp: now - 1 * day,
        }),
        makeRetrievalResult({
          id: "decision-1",
          text: "Write rollback command before editing service unit files.",
          score: 0.955,
          category: "decision",
          scope: "global",
          timestamp: now - 2 * day,
        }),
        makeRetrievalResult({
          id: "pref-1",
          text: "Prefer concise status updates after mandatory verification checks.",
          score: 0.951,
          category: "preference",
          scope: "agent:main",
          timestamp: now - 2 * day,
        }),
      ];

      const selected = selectFinalAutoRecallResults(rows, { topK: 3, now });

      assert.equal(selected.length, 3);
      assert.equal(selected[0].entry.id, "dup-1");
      assert.equal(selected.filter((row) => row.entry.id.startsWith("dup-")).length, 1);
      assert.ok(selected.some((row) => row.entry.id === "decision-1"));
      assert.ok(selected.some((row) => row.entry.id === "pref-1"));
    });

    it("suppresses semantic redundancy while preserving strongest top1", () => {
      const now = Date.UTC(2026, 2, 8, 12, 0, 0);
      const day = 24 * 60 * 60 * 1000;
      const rows = [
        makeRetrievalResult({
          id: "sem-1",
          text: "Use rollback checklist before restarting critical services.",
          score: 0.992,
          category: "fact",
          scope: "global",
          timestamp: now - 1 * day,
          vector: [1, 0, 0, 0],
        }),
        makeRetrievalResult({
          id: "sem-2",
          text: "Maintain pre-restart safeguards for high-impact daemons.",
          score: 0.989,
          category: "fact",
          scope: "global",
          timestamp: now - 1 * day,
          vector: [0.995, 0.005, 0, 0],
        }),
        makeRetrievalResult({
          id: "sem-3",
          text: "Record recovery expectations before applying config edits.",
          score: 0.987,
          category: "fact",
          scope: "global",
          timestamp: now - 1 * day,
          vector: [0.996, 0.004, 0, 0],
        }),
        makeRetrievalResult({
          id: "decision-1",
          text: "Run post-check commands and store evidence timestamps.",
          score: 0.956,
          category: "decision",
          scope: "global",
          timestamp: now - 2 * day,
          vector: [0, 1, 0, 0],
        }),
        makeRetrievalResult({
          id: "pref-1",
          text: "Keep responses concise and report only verified outcomes.",
          score: 0.954,
          category: "preference",
          scope: "agent:main",
          timestamp: now - 2 * day,
          vector: [0, 0, 1, 0],
        }),
      ];

      const selected = selectFinalAutoRecallResults(rows, { topK: 3, now });

      assert.equal(selected.length, 3);
      assert.equal(selected[0].entry.id, "sem-1");
      assert.equal(selected.filter((row) => row.entry.id.startsWith("sem-")).length, 1);
      assert.ok(selected.some((row) => row.entry.id === "decision-1"));
      assert.ok(selected.some((row) => row.entry.id === "pref-1"));
    });

    it("keeps deterministic output under reversed order when semantic penalties are active", () => {
      const now = Date.UTC(2026, 2, 8, 12, 0, 0);
      const day = 24 * 60 * 60 * 1000;
      const rows = [
        makeRetrievalResult({
          id: "sem-1",
          text: "Store rollback checks before service restarts.",
          score: 0.986,
          category: "fact",
          scope: "global",
          timestamp: now - 1 * day,
          vector: [1, 0, 0, 0],
        }),
        makeRetrievalResult({
          id: "sem-2",
          text: "Keep safety checklist in place ahead of daemon restarts.",
          score: 0.983,
          category: "fact",
          scope: "global",
          timestamp: now - 1 * day,
          vector: [0.998, 0.002, 0, 0],
        }),
        makeRetrievalResult({
          id: "decision-1",
          text: "Record service state before changing systemd units.",
          score: 0.95,
          category: "decision",
          scope: "global",
          timestamp: now - 2 * day,
          vector: [0, 1, 0, 0],
        }),
        makeRetrievalResult({
          id: "pref-1",
          text: "Keep final status reports concise and factual.",
          score: 0.948,
          category: "preference",
          scope: "agent:main",
          timestamp: now - 2 * day,
          vector: [0, 0, 1, 0],
        }),
      ];

      const forward = selectFinalAutoRecallResults(rows, { topK: 3, now });
      const reversed = selectFinalAutoRecallResults([...rows].reverse(), { topK: 3, now });

      assert.deepEqual(
        forward.map((row) => row.entry.id),
        reversed.map((row) => row.entry.id)
      );
    });

    it("falls back safely to lexical-only behavior when vectors are missing or invalid", () => {
      const now = Date.UTC(2026, 2, 8, 12, 0, 0);
      const day = 24 * 60 * 60 * 1000;
      const rows = [
        makeRetrievalResult({
          id: "dup-1",
          text: "Keep DNS/mount checks mandatory after service edits.",
          score: 0.99,
          category: "fact",
          scope: "global",
          timestamp: now - 1 * day,
          vector: [],
        }),
        makeRetrievalResult({
          id: "dup-2",
          text: "Keep DNS mount checks mandatory after service edits.",
          score: 0.987,
          category: "fact",
          scope: "global",
          timestamp: now - 1 * day,
          vector: [Number.NaN, 1, 2],
        }),
        makeRetrievalResult({
          id: "decision-1",
          text: "Write rollback plan before changing service units.",
          score: 0.955,
          category: "decision",
          scope: "global",
          timestamp: now - 2 * day,
          vector: undefined,
        }),
        makeRetrievalResult({
          id: "pref-1",
          text: "Report only verified outcomes in short status updates.",
          score: 0.951,
          category: "preference",
          scope: "agent:main",
          timestamp: now - 2 * day,
          vector: new Float32Array([0, 1, 0, 0]),
        }),
      ];

      const selected = selectFinalAutoRecallResults(rows, { topK: 3, now });
      const reversed = selectFinalAutoRecallResults([...rows].reverse(), { topK: 3, now });

      assert.equal(selected.length, 3);
      assert.equal(selected[0].entry.id, "dup-1");
      assert.equal(selected.filter((row) => row.entry.id.startsWith("dup-")).length, 1);
      assert.deepEqual(
        selected.map((row) => row.entry.id),
        reversed.map((row) => row.entry.id)
      );
    });
  });

  describe("dynamic reflection recall ranking", () => {
    it("filters stale rows by time window", () => {
      const now = Date.UTC(2026, 2, 8);
      const day = 24 * 60 * 60 * 1000;
      const entries = [
        makeEntry({
          timestamp: now - 2 * day,
          metadata: {
            type: "memory-reflection-item",
            itemKind: "invariant",
            agentId: "main",
            storedAt: now - 2 * day,
            decayMidpointDays: 45,
            decayK: 0.22,
            baseWeight: 1.1,
            quality: 1,
          },
        }),
        makeEntry({
          timestamp: now - 80 * day,
          metadata: {
            type: "memory-reflection-item",
            itemKind: "invariant",
            agentId: "main",
            storedAt: now - 80 * day,
            decayMidpointDays: 45,
            decayK: 0.22,
            baseWeight: 1.1,
            quality: 1,
          },
        }),
      ];
      entries[0].text = "Keep post-checks mandatory after infra edits.";
      entries[1].text = "Stale legacy guidance.";

      const rows = rankDynamicReflectionRecallFromEntries(entries, {
        agentId: "main",
        includeKinds: ["invariant"],
        maxAgeMs: 30 * day,
        maxEntriesPerKey: 10,
        topK: 6,
        minScore: 0,
        now,
      });

      assert.equal(rows.length, 1);
      assert.equal(rows[0].text, "Keep post-checks mandatory after infra edits.");
    });

    it("caps dynamic aggregation to the most recent 10 entries per normalized key", () => {
      const now = Date.UTC(2026, 2, 8);
      const entries = Array.from({ length: 12 }, () =>
        makeEntry({
          timestamp: now,
          metadata: {
            type: "memory-reflection-item",
            itemKind: "invariant",
            agentId: "main",
            storedAt: now,
            decayMidpointDays: 45,
            decayK: 0.22,
            baseWeight: 1.1,
            quality: 1,
          },
        })
      );
      for (const entry of entries) {
        entry.text = "Always verify mount + DNS health after service changes.";
      }

      const capped = rankDynamicReflectionRecallFromEntries(entries, {
        agentId: "main",
        includeKinds: ["invariant"],
        maxAgeMs: 365 * 24 * 60 * 60 * 1000,
        maxEntriesPerKey: 10,
        topK: 6,
        minScore: 0,
        now,
      });
      const uncapped = rankDynamicReflectionRecallFromEntries(entries, {
        agentId: "main",
        includeKinds: ["invariant"],
        maxAgeMs: 365 * 24 * 60 * 60 * 1000,
        maxEntriesPerKey: 20,
        topK: 6,
        minScore: 0,
        now,
      });

      assert.equal(capped[0].repeatCount, 10);
      assert.equal(uncapped[0].repeatCount, 12);
      assert.ok(uncapped[0].score > capped[0].score);
      assert.ok(Number.isFinite(capped[0].score));
      assert.ok(capped[0].score > 0);
    });

    it("reuses helper representative selection so newer fallback phrasing is not always preferred", () => {
      const now = Date.UTC(2026, 2, 8);
      const day = 24 * 60 * 60 * 1000;
      const entries = [
        makeEntry({
          timestamp: now - 2 * day,
          metadata: {
            type: "memory-reflection-item",
            itemKind: "invariant",
            agentId: "main",
            storedAt: now - 2 * day,
            decayMidpointDays: 45,
            decayK: 0.22,
            baseWeight: 1.1,
            quality: 1,
            usedFallback: false,
          },
        }),
        makeEntry({
          timestamp: now - 1 * day,
          metadata: {
            type: "memory-reflection-item",
            itemKind: "invariant",
            agentId: "main",
            storedAt: now - 1 * day,
            decayMidpointDays: 45,
            decayK: 0.22,
            baseWeight: 1.1,
            quality: 1,
            usedFallback: true,
          },
        }),
      ];
      entries[0].text = "Always run DNS and mount post-checks after service restarts.";
      entries[1].text = "Always run DNS and mount post-checks after service restarts!";

      const rows = rankDynamicReflectionRecallFromEntries(entries, {
        agentId: "main",
        includeKinds: ["invariant"],
        maxAgeMs: 90 * day,
        maxEntriesPerKey: 10,
        topK: 6,
        minScore: 0,
        now,
      });

      assert.equal(rows.length, 1);
      assert.equal(rows[0].text, "Always run DNS and mount post-checks after service restarts.");
      assert.equal(rows[0].repeatCount, 2);
    });

    it("preserves kind identity by partitioning aggregation with kind + strictKey semantics", () => {
      const now = Date.UTC(2026, 2, 8, 12, 0, 0);
      const day = 24 * 60 * 60 * 1000;
      const entries = [
        makeEntry({
          timestamp: now - 2 * day,
          metadata: {
            type: "memory-reflection-item",
            itemKind: "invariant",
            agentId: "main",
            storedAt: now - 2 * day,
            decayMidpointDays: 45,
            decayK: 0.22,
            baseWeight: 1.1,
            quality: 1,
            usedFallback: false,
          },
        }),
        makeEntry({
          timestamp: now - 1 * day,
          metadata: {
            type: "memory-reflection-item",
            itemKind: "invariant",
            agentId: "main",
            storedAt: now - 1 * day,
            decayMidpointDays: 45,
            decayK: 0.22,
            baseWeight: 1.1,
            quality: 1,
            usedFallback: false,
          },
        }),
        makeEntry({
          timestamp: now - 2 * day,
          metadata: {
            type: "memory-reflection-item",
            itemKind: "derived",
            agentId: "main",
            storedAt: now - 2 * day,
            decayMidpointDays: 7,
            decayK: 0.65,
            baseWeight: 1,
            quality: 1,
            usedFallback: false,
          },
        }),
        makeEntry({
          timestamp: now - 1 * day,
          metadata: {
            type: "memory-reflection-item",
            itemKind: "derived",
            agentId: "main",
            storedAt: now - 1 * day,
            decayMidpointDays: 7,
            decayK: 0.65,
            baseWeight: 1,
            quality: 1,
            usedFallback: false,
          },
        }),
      ];
      entries[0].text = "Keep DNS and mount post-check evidence after service changes.";
      entries[1].text = "Keep DNS and mount post-check evidence after service changes!";
      entries[2].text = "Keep DNS and mount post-check evidence after service changes.";
      entries[3].text = "Keep DNS and mount post-check evidence after service changes!";

      const rows = rankDynamicReflectionRecallFromEntries(entries, {
        agentId: "main",
        includeKinds: ["invariant", "derived"],
        maxAgeMs: 90 * day,
        maxEntriesPerKey: 1,
        topK: 6,
        minScore: 0,
        now,
      });

      assert.equal(rows.length, 2);
      assert.deepEqual(
        [...new Set(rows.map((row) => row.kind))].sort(),
        ["derived", "invariant"]
      );
      for (const row of rows) {
        assert.match(row.id, /^reflection:(derived|invariant)::/);
      }
      assert.equal(new Set(rows.map((row) => row.id)).size, 2);
      assert.equal(new Set(rows.map((row) => normalizeReflectionSoftKey(row.text))).size, 1);
    });

    it("reuses diversity-aware final ordering in recall and keeps deterministic output", () => {
      const now = Date.UTC(2026, 2, 8, 12, 0, 0);
      const day = 24 * 60 * 60 * 1000;
      const similarLines = [
        "Validate /root/work mount health after service restart.",
        "Validate root/work mount health after service restart.",
        "validate root work mount health after service restart",
        "Validate root-work mount health after service restart.",
      ];
      const diverseLines = [
        "Keep DNS post-check output with getent host evidence.",
        "Record exact UTC timestamps for each recovery action.",
        "Capture exact command output snippets that prove service recovery.",
        "Prefer a minimal blast-radius rollback command before retries.",
        "Document expected service states before applying risky edits.",
      ];

      const entries = [];
      for (const line of similarLines) {
        const entry = makeEntry({
          timestamp: now - 1 * day,
          metadata: {
            type: "memory-reflection-item",
            itemKind: "invariant",
            agentId: "main",
            storedAt: now - 1 * day,
            decayMidpointDays: 45,
            decayK: 0.22,
            baseWeight: 1.1,
            quality: 1,
            usedFallback: false,
          },
        });
        entry.text = line;
        entries.push(entry);
      }

      for (const line of diverseLines) {
        const entry = makeEntry({
          timestamp: now - 1 * day,
          metadata: {
            type: "memory-reflection-item",
            itemKind: "invariant",
            agentId: "main",
            storedAt: now - 1 * day,
            decayMidpointDays: 45,
            decayK: 0.22,
            baseWeight: 1.1,
            quality: 0.6,
            usedFallback: false,
          },
        });
        entry.text = line;
        entries.push(entry);
      }

      const forward = rankDynamicReflectionRecallFromEntries(entries, {
        agentId: "main",
        includeKinds: ["invariant"],
        maxAgeMs: 90 * day,
        maxEntriesPerKey: 10,
        topK: 5,
        minScore: 0,
        now,
      });
      const reversed = rankDynamicReflectionRecallFromEntries([...entries].reverse(), {
        agentId: "main",
        includeKinds: ["invariant"],
        maxAgeMs: 90 * day,
        maxEntriesPerKey: 10,
        topK: 5,
        minScore: 0,
        now,
      });

      const duplicateSoftKey = normalizeReflectionSoftKey(similarLines[0]);
      const duplicateSoftKeyCount = forward.filter((row) => normalizeReflectionSoftKey(row.text) === duplicateSoftKey).length;
      assert.equal(duplicateSoftKeyCount, 1);
      assert.deepEqual(forward, reversed);
    });
  });

  describe("dynamic recall session state hygiene", () => {
    it("clears per-session state so repeated-injection guard resets after session_end cleanup", async () => {
      const state = createDynamicRecallSessionState({ maxSessions: 16 });
      const run = () => orchestrateDynamicRecall({
        channelName: "unit-dynamic-recall",
        prompt: "Need targeted recall",
        minPromptLength: 1,
        minRepeated: 2,
        topK: 1,
        sessionId: "session-a",
        state,
        outputTag: "relevant-memories",
        headerLines: [],
        loadCandidates: async () => [{ id: "rule-a", text: "Always verify post-checks.", score: 0.9 }],
        formatLine: (candidate) => candidate.text,
      });

      const first = await run();
      assert.ok(first);

      const second = await run();
      assert.equal(second, undefined);

      clearDynamicRecallSessionState(state, "session-a");

      const third = await run();
      assert.ok(third);
    });

    it("bounds tracked sessions by maxSessions to avoid unbounded growth", async () => {
      const state = createDynamicRecallSessionState({ maxSessions: 2 });
      const run = (sessionId) => orchestrateDynamicRecall({
        channelName: "unit-dynamic-recall",
        prompt: "Need targeted recall",
        minPromptLength: 1,
        minRepeated: 0,
        topK: 1,
        sessionId,
        state,
        outputTag: "relevant-memories",
        headerLines: [],
        loadCandidates: async () => [{ id: "rule-a", text: "Keep DNS checks in post-flight.", score: 0.9 }],
        formatLine: (candidate) => candidate.text,
      });

      await run("session-a");
      await run("session-b");
      await run("session-c");

      assert.equal(state.turnCounterBySession.size, 2);
      assert.equal(state.historyBySession.size, 2);
      assert.equal(state.updatedAtBySession.size, 2);
      assert.equal(state.turnCounterBySession.has("session-a"), false);
      assert.equal(state.historyBySession.has("session-a"), false);
      assert.equal(state.updatedAtBySession.has("session-a"), false);
    });
  });

  describe("sessionStrategy legacy compatibility mapping", () => {
    it("maps legacy sessionMemory.enabled=true to systemSessionMemory", () => {
      const parsed = parsePluginConfig({
        ...baseConfig(),
        sessionMemory: { enabled: true },
      });
      assert.equal(parsed.sessionStrategy, "systemSessionMemory");
    });

    it("maps legacy sessionMemory.enabled=false to none", () => {
      const parsed = parsePluginConfig({
        ...baseConfig(),
        sessionMemory: { enabled: false },
      });
      assert.equal(parsed.sessionStrategy, "none");
    });

    it("prefers explicit sessionStrategy over legacy sessionMemory.enabled", () => {
      const parsed = parsePluginConfig({
        ...baseConfig(),
        sessionStrategy: "memoryReflection",
        sessionMemory: { enabled: false },
      });
      assert.equal(parsed.sessionStrategy, "memoryReflection");
    });

    it("defaults to systemSessionMemory when neither field is set", () => {
      const parsed = parsePluginConfig(baseConfig());
      assert.equal(parsed.sessionStrategy, "systemSessionMemory");
    });

    it("defaults auto-recall category allowlist to include other while keeping reflection excluded", () => {
      const parsed = parsePluginConfig(baseConfig());
      assert.deepEqual(parsed.autoRecallCategories, ["preference", "fact", "decision", "entity", "other"]);
      assert.equal(parsed.autoRecallExcludeReflection, true);
    });

    it("defaults Reflection-Recall mode to fixed for compatibility", () => {
      const parsed = parsePluginConfig({
        ...baseConfig(),
        sessionStrategy: "memoryReflection",
      });
      assert.equal(parsed.memoryReflection.recall.mode, "fixed");
      assert.equal(parsed.memoryReflection.recall.topK, 6);
    });

    it("parses dynamic Reflection-Recall config fields", () => {
      const parsed = parsePluginConfig({
        ...baseConfig(),
        memoryReflection: {
          recall: {
            mode: "dynamic",
            topK: 9,
            includeKinds: ["invariant", "derived"],
            maxAgeDays: 14,
            maxEntriesPerKey: 7,
            minRepeated: 3,
            minScore: 0.22,
            minPromptLength: 12,
          },
        },
      });
      assert.equal(parsed.memoryReflection.recall.mode, "dynamic");
      assert.equal(parsed.memoryReflection.recall.topK, 9);
      assert.deepEqual(parsed.memoryReflection.recall.includeKinds, ["invariant", "derived"]);
      assert.equal(parsed.memoryReflection.recall.maxAgeDays, 14);
      assert.equal(parsed.memoryReflection.recall.maxEntriesPerKey, 7);
      assert.equal(parsed.memoryReflection.recall.minRepeated, 3);
      assert.equal(parsed.memoryReflection.recall.minScore, 0.22);
      assert.equal(parsed.memoryReflection.recall.minPromptLength, 12);
    });
  });

  describe("memoryReflection injectMode inheritance+derived hook flow", () => {
    let workspaceDir;
    let sessionFile;
    let originalList;
    let originalExtensionApiPath;
    let harness;

    beforeEach(() => {
      workspaceDir = mkdtempSync(path.join(tmpdir(), "reflection-hook-flow-test-"));
      const sessionsDir = path.join(workspaceDir, "sessions");
      mkdirSync(sessionsDir, { recursive: true });
      sessionFile = path.join(sessionsDir, "s1.jsonl");
      writeFileSync(
        sessionFile,
        [
          messageLine("user", "Please keep responses concise and verify test output.", 1),
          messageLine("assistant", "Acknowledged. I will keep responses concise and verify output.", 2),
        ].join("\n") + "\n",
        "utf-8"
      );

      originalList = MemoryStore.prototype.list;
      originalExtensionApiPath = process.env.OPENCLAW_EXTENSION_API_PATH;
      process.env.OPENCLAW_EXTENSION_API_PATH = extensionApiStubPath;

      const now = Date.UTC(2026, 2, 8, 12, 0, 0);
      const day = 24 * 60 * 60 * 1000;
      const reflectionEntries = [
        makeEntry({
          timestamp: now - 1 * day,
          metadata: {
            type: "memory-reflection-item",
            itemKind: "invariant",
            agentId: "main",
            storedAt: now - 1 * day,
            decayMidpointDays: 45,
            decayK: 0.22,
            baseWeight: 1.1,
            quality: 1,
          },
        }),
        makeEntry({
          timestamp: now - 1 * day,
          metadata: {
            type: "memory-reflection-item",
            itemKind: "derived",
            agentId: "main",
            storedAt: now - 1 * day,
            decayMidpointDays: 7,
            decayK: 0.65,
            baseWeight: 1,
            quality: 1,
          },
        }),
        makeEntry({
          timestamp: now - 45 * day,
          metadata: {
            type: "memory-reflection-item",
            itemKind: "derived",
            agentId: "main",
            storedAt: now - 45 * day,
            decayMidpointDays: 7,
            decayK: 0.65,
            baseWeight: 1,
            quality: 1,
          },
        }),
      ];
      reflectionEntries[0].text = "Always verify edits before reporting completion.";
      reflectionEntries[1].text = "Historical derived focus that remains relevant.";
      reflectionEntries[2].text = "Historical stale follow-up should be filtered.";
      MemoryStore.prototype.list = async () => reflectionEntries;

      harness = createPluginApiHarness({
        resolveRoot: workspaceDir,
        pluginConfig: {
          embedding: {
            apiKey: "test-api-key",
          },
          autoCapture: false,
          autoRecall: false,
          sessionStrategy: "memoryReflection",
          selfImprovement: {
            enabled: true,
            beforeResetNote: true,
            ensureLearningFiles: false,
          },
          memoryReflection: {
            injectMode: "inheritance+derived",
            storeToLanceDB: false,
          },
        },
      });
      memoryLanceDBProPlugin.register(harness.api);
    });

    afterEach(() => {
      MemoryStore.prototype.list = originalList;
      if (typeof originalExtensionApiPath === "string") {
        process.env.OPENCLAW_EXTENSION_API_PATH = originalExtensionApiPath;
      } else {
        delete process.env.OPENCLAW_EXTENSION_API_PATH;
      }
      rmSync(workspaceDir, { recursive: true, force: true });
    });

    it("injects inherited-rules in before_prompt_build and builds note with fresh open-loops + historical derived-focus", async () => {
      const beforePromptHooks = harness.eventHandlers.get("before_prompt_build") || [];
      assert.equal(beforePromptHooks.length, 1);
      const inheritedResult = await beforePromptHooks[0].handler({}, {
        sessionKey: "agent:main:session:s1",
        agentId: "main",
      });
      assert.match(inheritedResult.prependContext, /<inherited-rules>/);
      assert.doesNotMatch(inheritedResult.prependContext, /<derived-focus>/);

      const commandNewHooks = harness.commandHooks.get("command:new") || [];
      assert.equal(commandNewHooks.length, 1);
      assert.match(String(commandNewHooks[0].meta?.name || ""), /memory-reflection\.command-new/);

      const messages = [];
      await commandNewHooks[0].handler({
        action: "new",
        sessionKey: "agent:main:session:s1",
        timestamp: Date.UTC(2026, 2, 8, 12, 0, 0),
        messages,
        context: {
          cfg: {},
          workspaceDir,
          commandSource: "cli",
          previousSessionEntry: {
            sessionId: "s1",
            sessionFile,
          },
        },
      });
      assert.equal(messages.length, 1);
      assert.match(messages[0], /^\/note self-improvement \(before reset\):/);
      assert.match(messages[0], /<open-loops>/);
      assert.match(messages[0], /Verify current reflection handoff after reset\./);
      const openLoopsBlock = messages[0].match(/<open-loops>[\s\S]*?<\/open-loops>/);
      assert.ok(openLoopsBlock);
      assert.doesNotMatch(openLoopsBlock[0], /Historical derived focus that remains relevant\./);
      assert.match(messages[0], /<derived-focus>/);
      assert.match(messages[0], /Historical derived focus that remains relevant\./);
      assert.doesNotMatch(messages[0], /Historical stale follow-up should be filtered\./);
    });

    it("keeps error-detected in before_prompt_build and coexists with inherited-rules", async () => {
      const afterToolHooks = harness.eventHandlers.get("after_tool_call") || [];
      const beforePromptHooks = harness.eventHandlers.get("before_prompt_build") || [];
      assert.equal(afterToolHooks.length, 1);
      assert.equal(beforePromptHooks.length, 1);

      await afterToolHooks[0].handler(
        { toolName: "shell", error: "ETIMEDOUT while contacting upstream" },
        { sessionKey: "agent:main:session:s1" }
      );

      const promptResult = await beforePromptHooks[0].handler({}, {
        sessionKey: "agent:main:session:s1",
        agentId: "main",
      });
      assert.match(promptResult.prependContext, /<inherited-rules>/);
      assert.match(promptResult.prependContext, /<error-detected>/);
      assert.match(promptResult.prependContext, /\[shell\]/);
      assert.doesNotMatch(promptResult.prependContext, /<derived-focus>/);
    });
  });

  describe("reflection-recall and auto-recall coexistence", () => {
    let workspaceDir;
    let originalList;
    let originalRetrieve;
    let harness;

    beforeEach(() => {
      workspaceDir = mkdtempSync(path.join(tmpdir(), "reflection-recall-dynamic-test-"));
      originalList = MemoryStore.prototype.list;
      originalRetrieve = MemoryRetriever.prototype.retrieve;

      const now = Date.UTC(2026, 2, 8, 12, 0, 0);
      const day = 24 * 60 * 60 * 1000;
      const reflectionEntries = Array.from({ length: 8 }, (_, i) =>
        makeEntry({
          timestamp: now - i * day,
          metadata: {
            type: "memory-reflection-item",
            itemKind: "invariant",
            agentId: "main",
            storedAt: now - i * day,
            decayMidpointDays: 45,
            decayK: 0.22,
            baseWeight: 1.1,
            quality: 1,
          },
        })
      );
      reflectionEntries.forEach((entry, idx) => {
        entry.text = `Dynamic reflection rule ${idx + 1}`;
      });
      MemoryStore.prototype.list = async (_scopeFilter, category) => {
        if (category === "reflection") return reflectionEntries;
        return reflectionEntries;
      };

      MemoryRetriever.prototype.retrieve = async () => [
        {
          entry: {
            id: "auto-fact-1",
            text: "User prefers concise incident updates.",
            category: "fact",
            scope: "global",
            timestamp: now - 1 * day,
            vector: [],
            importance: 0.8,
            metadata: "{}",
          },
          score: 0.91,
          sources: {},
        },
        {
          entry: {
            id: "auto-reflection-1",
            text: "Reflection row that should stay out of relevant-memories.",
            category: "reflection",
            scope: "global",
            timestamp: now - 1 * day,
            vector: [],
            importance: 0.8,
            metadata: "{}",
          },
          score: 0.88,
          sources: {},
        },
        {
          entry: {
            id: "auto-decision-1",
            text: "Decide to verify services after config edits.",
            category: "decision",
            scope: "global",
            timestamp: now - 2 * day,
            vector: [],
            importance: 0.8,
            metadata: "{}",
          },
          score: 0.85,
          sources: {},
        },
      ];

      harness = createPluginApiHarness({
        resolveRoot: workspaceDir,
        pluginConfig: {
          embedding: { apiKey: "test-api-key" },
          autoCapture: false,
          autoRecall: true,
          autoRecallTopK: 2,
          autoRecallExcludeReflection: true,
          autoRecallMinLength: 6,
          sessionStrategy: "memoryReflection",
          selfImprovement: {
            enabled: false,
            beforeResetNote: false,
            ensureLearningFiles: false,
          },
          memoryReflection: {
            injectMode: "inheritance-only",
            storeToLanceDB: false,
            recall: {
              mode: "dynamic",
              topK: 4,
              includeKinds: ["invariant"],
              maxAgeDays: 45,
              maxEntriesPerKey: 10,
              minRepeated: 2,
              minScore: 0,
              minPromptLength: 6,
            },
          },
        },
      });
      memoryLanceDBProPlugin.register(harness.api);
    });

    afterEach(() => {
      MemoryStore.prototype.list = originalList;
      MemoryRetriever.prototype.retrieve = originalRetrieve;
      rmSync(workspaceDir, { recursive: true, force: true });
    });

    it("keeps fixed inherited-rules compatibility even when autoRecall is enabled", async () => {
      const fixedHarness = createPluginApiHarness({
        resolveRoot: workspaceDir,
        pluginConfig: {
          embedding: { apiKey: "test-api-key" },
          autoCapture: false,
          autoRecall: true,
          autoRecallTopK: 1,
          sessionStrategy: "memoryReflection",
          selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
          memoryReflection: {
            injectMode: "inheritance-only",
            storeToLanceDB: false,
            recall: { mode: "fixed" },
          },
        },
      });
      memoryLanceDBProPlugin.register(fixedHarness.api);

      const autoRecallHooks = fixedHarness.eventHandlers.get("before_agent_start") || [];
      assert.equal(autoRecallHooks.length, 1);
      const promptHooks = fixedHarness.eventHandlers.get("before_prompt_build") || [];
      assert.equal(promptHooks.length, 1);
      const inherited = await promptHooks[0].handler(
        { prompt: "Please recall relevant constraints for this task." },
        { sessionId: "fixed-s1", sessionKey: "agent:main:session:fixed-s1", agentId: "main" }
      );
      assert.ok(inherited);
      assert.match(inherited.prependContext, /Dynamic reflection rule 1|Stable rules inherited from memory-lancedb-pro reflections\./);
    });

    it("keeps dynamic reflection top-k independent from relevant-memories top-k and excludes reflection rows from auto-recall", async () => {
      const beforeAgentStartHooks = harness.eventHandlers.get("before_agent_start") || [];
      const beforePromptHooks = harness.eventHandlers.get("before_prompt_build") || [];
      assert.equal(beforeAgentStartHooks.length, 1);
      assert.equal(beforePromptHooks.length, 1);

      const relevant = await beforeAgentStartHooks[0].handler(
        { prompt: "Need a concise plan and recall prior decisions for this deploy?" },
        { sessionId: "s-dyn", sessionKey: "agent:main:session:s-dyn", agentId: "main" }
      );
      const inherited = await beforePromptHooks[0].handler(
        { prompt: "Need a concise plan and recall prior decisions for this deploy?" },
        { sessionId: "s-dyn", sessionKey: "agent:main:session:s-dyn", agentId: "main" }
      );
      assert.ok(relevant);
      assert.ok(inherited);

      const relevantCount = (relevant.prependContext.match(/^- \[/gm) || []).length;
      const inheritedCount = (inherited.prependContext.match(/^\d+\.\s/gm) || []).length;
      assert.equal(relevantCount, 2);
      assert.equal(inheritedCount, 4);

      assert.doesNotMatch(relevant.prependContext, /auto-reflection-1|Reflection row that should stay out of relevant-memories\./);
      assert.match(relevant.prependContext, /User prefers concise incident updates\./);
      assert.match(relevant.prependContext, /Decide to verify services after config edits\./);
      assert.match(inherited.prependContext, /Dynamic reflection rule 1/);
    });

    it("lets ordinary follow-up prompts receive inherited-rules via before_prompt_build", async () => {
      const beforePromptHooks = harness.eventHandlers.get("before_prompt_build") || [];
      assert.equal(beforePromptHooks.length, 1);

      const followUp = await beforePromptHooks[0].handler(
        { prompt: "继续按这个方案改，并给我步骤" },
        { sessionId: "s-follow-up", sessionKey: "agent:main:session:s-follow-up", agentId: "main" }
      );

      assert.ok(followUp);
      assert.match(followUp.prependContext, /<inherited-rules>/);
      assert.match(followUp.prependContext, /Dynamic reflection rule 1/);
    });

    it("uses the shared skip gate to suppress both auto-recall and reflection recall on control prompts", async () => {
      const beforeAgentStartHooks = harness.eventHandlers.get("before_agent_start") || [];
      const beforePromptHooks = harness.eventHandlers.get("before_prompt_build") || [];
      assert.equal(beforeAgentStartHooks.length, 1);
      assert.equal(beforePromptHooks.length, 1);

      const controlPrompts = [
        "/new",
        "/reset",
        "A new session was started via /new or /reset. Keep this in mind.",
        "Execute your Session Startup sequence now before continuing.",
        "Control wrapper line\n/note self-improvement (before reset): preserve incident timeline.",
      ];

      for (const prompt of controlPrompts) {
        const relevant = await beforeAgentStartHooks[0].handler(
          { prompt },
          { sessionId: `auto-${prompt.length}`, sessionKey: `agent:main:session:auto-${prompt.length}`, agentId: "main" }
        );
        const inherited = await beforePromptHooks[0].handler(
          { prompt },
          { sessionId: `reflect-${prompt.length}`, sessionKey: `agent:main:session:reflect-${prompt.length}`, agentId: "main" }
        );

        assert.equal(relevant, undefined, `expected auto-recall to skip control prompt: ${prompt}`);
        assert.equal(inherited, undefined, `expected reflection recall to skip control prompt: ${prompt}`);
      }
    });
  });

  describe("generic auto-recall selection mode compatibility", () => {
    let workspaceDir;
    let originalRetrieve;
    const now = Date.UTC(2026, 2, 8, 12, 0, 0);
    const day = 24 * 60 * 60 * 1000;

    beforeEach(() => {
      workspaceDir = mkdtempSync(path.join(tmpdir(), "generic-auto-recall-selection-mode-test-"));
      originalRetrieve = MemoryRetriever.prototype.retrieve;
    });

    afterEach(() => {
      MemoryRetriever.prototype.retrieve = originalRetrieve;
      rmSync(workspaceDir, { recursive: true, force: true });
    });

    function buildGenericRecallRows() {
      return [
        {
          entry: {
            id: "dup-1",
            text: "Restart API service after config updates.",
            category: "fact",
            scope: "global",
            timestamp: now - 1 * day,
            vector: [],
            importance: 0.8,
            metadata: "{}",
          },
          score: 0.99,
          sources: {},
        },
        {
          entry: {
            id: "dup-2",
            text: "restart api service after config updates.",
            category: "fact",
            scope: "global",
            timestamp: now - 2 * day,
            vector: [],
            importance: 0.8,
            metadata: "{}",
          },
          score: 0.97,
          sources: {},
        },
        {
          entry: {
            id: "alt-1",
            text: "Run DNS and mount health checks after restart.",
            category: "decision",
            scope: "global",
            timestamp: now - 1 * day,
            vector: [],
            importance: 0.8,
            metadata: "{}",
          },
          score: 0.65,
          sources: {},
        },
      ];
    }

    it("mmr mode bypasses set-wise selector and uses direct truncation", async () => {
      MemoryRetriever.prototype.retrieve = async () => buildGenericRecallRows();

      const harness = createPluginApiHarness({
        resolveRoot: workspaceDir,
        pluginConfig: {
          embedding: { apiKey: "test-api-key" },
          autoCapture: false,
          autoRecall: true,
          autoRecallTopK: 2,
          autoRecallSelectionMode: "mmr",
          autoRecallMinLength: 1,
          selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
        },
      });
      memoryLanceDBProPlugin.register(harness.api);

      const hooks = harness.eventHandlers.get("before_agent_start") || [];
      assert.equal(hooks.length, 1);
      const output = await hooks[0].handler(
        { prompt: "Need rollout memories now." },
        { sessionId: "mmr-mode", sessionKey: "agent:main:session:mmr-mode", agentId: "main" }
      );
      assert.ok(output);
      assert.match(output.prependContext, /<relevant-memories>/);
      assert.match(output.prependContext, /Restart API service after config updates\./);
      assert.match(output.prependContext, /restart api service after config updates\./);
      assert.doesNotMatch(output.prependContext, /Run DNS and mount health checks after restart\./);
    });

    it("legacy alias follows the same direct-truncation path as mmr", async () => {
      MemoryRetriever.prototype.retrieve = async () => buildGenericRecallRows();

      const harness = createPluginApiHarness({
        resolveRoot: workspaceDir,
        pluginConfig: {
          embedding: { apiKey: "test-api-key" },
          autoCapture: false,
          autoRecall: true,
          autoRecallTopK: 2,
          autoRecallSelectionMode: "legacy",
          autoRecallMinLength: 1,
          selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
        },
      });
      memoryLanceDBProPlugin.register(harness.api);

      const hooks = harness.eventHandlers.get("before_agent_start") || [];
      assert.equal(hooks.length, 1);
      const output = await hooks[0].handler(
        { prompt: "Need rollout memories now." },
        { sessionId: "legacy-alias-mode", sessionKey: "agent:main:session:legacy-alias-mode", agentId: "main" }
      );
      assert.ok(output);
      assert.match(output.prependContext, /<relevant-memories>/);
      assert.match(output.prependContext, /Restart API service after config updates\./);
      assert.match(output.prependContext, /restart api service after config updates\./);
      assert.doesNotMatch(output.prependContext, /Run DNS and mount health checks after restart\./);
    });

    it("setwise-v2 mode uses set-wise selector for final top-k", async () => {
      MemoryRetriever.prototype.retrieve = async () => buildGenericRecallRows();

      const harness = createPluginApiHarness({
        resolveRoot: workspaceDir,
        pluginConfig: {
          embedding: { apiKey: "test-api-key" },
          autoCapture: false,
          autoRecall: true,
          autoRecallTopK: 2,
          autoRecallSelectionMode: "setwise-v2",
          autoRecallMinLength: 1,
          selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
        },
      });
      memoryLanceDBProPlugin.register(harness.api);

      const hooks = harness.eventHandlers.get("before_agent_start") || [];
      assert.equal(hooks.length, 1);
      const output = await hooks[0].handler(
        { prompt: "Need rollout memories now." },
        { sessionId: "setwise-mode", sessionKey: "agent:main:session:setwise-mode", agentId: "main" }
      );
      assert.ok(output);
      assert.match(output.prependContext, /<relevant-memories>/);
      assert.match(output.prependContext, /Restart API service after config updates\./);
      assert.match(output.prependContext, /Run DNS and mount health checks after restart\./);
      assert.doesNotMatch(output.prependContext, /restart api service after config updates\./);
    });
  });
});
