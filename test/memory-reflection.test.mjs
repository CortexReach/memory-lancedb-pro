import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginSdkStubPath = path.resolve(testDir, "helpers", "openclaw-plugin-sdk-stub.mjs");
const jiti = jitiFactory(import.meta.url, {
  interopDefault: true,
  alias: {
    "openclaw/plugin-sdk": pluginSdkStubPath,
  },
});

const { readSessionConversationWithResetFallback, parsePluginConfig } = jiti("../index.ts");
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
  loadReflectionMappedRowsFromEntries,
  REFLECTION_DERIVE_LOGISTIC_K,
  REFLECTION_DERIVE_LOGISTIC_MIDPOINT_DAYS,
  REFLECTION_DERIVE_FALLBACK_BASE_WEIGHT,
} = jiti("../src/reflection-store.ts");
const {
  REFLECTION_INVARIANT_DECAY_MIDPOINT_DAYS,
  REFLECTION_INVARIANT_DECAY_K,
  REFLECTION_INVARIANT_BASE_WEIGHT,
  REFLECTION_DERIVED_DECAY_MIDPOINT_DAYS,
  REFLECTION_DERIVED_DECAY_K,
  REFLECTION_DERIVED_BASE_WEIGHT,
} = jiti("../src/reflection-item-store.ts");
const { buildReflectionMappedMetadata } = jiti("../src/reflection-mapped-metadata.ts");
const { REFLECTION_FALLBACK_SCORE_FACTOR } = jiti("../src/reflection-ranking.ts");

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

  describe("display category tags", () => {
    it("uses scope tag for reflection entries", () => {
      assert.equal(
        getDisplayCategoryTag({
          category: "reflection",
          scope: "project-a",
          metadata: JSON.stringify({ type: "memory-reflection", invariants: ["Always verify output"] }),
        }),
        "reflection:project-a"
      );

      assert.equal(
        getDisplayCategoryTag({
          category: "reflection",
          scope: "project-b",
          metadata: JSON.stringify({
            type: "memory-reflection",
            reflectionVersion: 3,
            invariants: ["Always verify output"],
            derived: ["Next run keep prompts short."],
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
            type: "memory-reflection",
            reflectionVersion: 3,
            invariants: ["Always keep steps auditable."],
            derived: ["Next run keep verification concise."],
            deriveBaseWeight: 0.35,
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
    it("stores event + itemized rows and keeps legacy combined rows by default", async () => {
      const storedEntries = [];
      const vectorSearchCalls = [];

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
        vectorSearch: async (vector) => {
          vectorSearchCalls.push(vector);
          return [];
        },
        store: async (entry) => {
          storedEntries.push(entry);
          return { ...entry, id: `id-${storedEntries.length}`, timestamp: 1_700_000_000_000 };
        },
      });

      assert.equal(result.stored, true);
      assert.deepEqual(result.storedKinds, ["event", "item-invariant", "item-derived", "combined-legacy"]);
      assert.equal(storedEntries.length, 4);
      assert.equal(vectorSearchCalls.length, 1, "legacy combined row keeps compatibility dedupe path");

      const metas = storedEntries.map((entry) => JSON.parse(entry.metadata));
      const eventMeta = metas.find((meta) => meta.type === "memory-reflection-event");
      const invariantMeta = metas.find((meta) => meta.type === "memory-reflection-item" && meta.itemKind === "invariant");
      const derivedMeta = metas.find((meta) => meta.type === "memory-reflection-item" && meta.itemKind === "derived");
      const legacyMeta = metas.find((meta) => meta.type === "memory-reflection");

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

      assert.ok(legacyMeta);
      assert.equal(legacyMeta.reflectionVersion, 3);
      assert.deepEqual(legacyMeta.invariants, ["Always confirm assumptions before changing files."]);
      assert.deepEqual(legacyMeta.derived, ["Next run verify reflection persistence with targeted tests."]);
      assert.equal(legacyMeta.decayModel, "logistic");
      assert.equal(legacyMeta.decayK, REFLECTION_DERIVE_LOGISTIC_K);
      assert.equal(legacyMeta.decayMidpointDays, REFLECTION_DERIVE_LOGISTIC_MIDPOINT_DAYS);
      assert.equal(legacyMeta.deriveBaseWeight, 1);
    });

    it("supports migration mode that disables legacy combined writes", async () => {
      const storedEntries = [];
      const result = await storeReflectionToLanceDB({
        reflectionText: [
          "## Invariants",
          "- Always run tests after edits.",
          "## Derived",
          "- Next run keep post-check output in final summary.",
        ].join("\n"),
        sessionKey: "agent:main:session:def",
        sessionId: "def",
        agentId: "main",
        command: "command:new",
        scope: "global",
        toolErrorSignals: [],
        runAt: 1_700_100_000_000,
        usedFallback: false,
        writeLegacyCombined: false,
        embedPassage: async (text) => [text.length],
        vectorSearch: async () => [],
        store: async (entry) => {
          storedEntries.push(entry);
          return { ...entry, id: `id-${storedEntries.length}`, timestamp: 1_700_100_000_000 };
        },
      });

      assert.deepEqual(result.storedKinds, ["event", "item-invariant", "item-derived"]);
      assert.equal(storedEntries.some((entry) => JSON.parse(entry.metadata).type === "memory-reflection"), false);
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
        writeLegacyCombined: false,
        embedPassage: async (text) => [text.length],
        vectorSearch: async () => [],
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
    it("loads legacy combined rows for backward compatibility", () => {
      const now = Date.UTC(2026, 2, 7);
      const entries = [
        makeEntry({
          timestamp: now - 30 * 60 * 1000,
          metadata: {
            type: "memory-reflection",
            agentId: "main",
            invariants: ["Legacy invariant still applies."],
            derived: ["Legacy derived delta still applies."],
            storedAt: now - 30 * 60 * 1000,
          },
        }),
        makeEntry({
          timestamp: now - 25 * 60 * 1000,
          metadata: {
            type: "memory-reflection",
            agentId: "main",
            reflectionVersion: 3,
            invariants: ["Current invariant applies too."],
            derived: ["Current derived delta still applies."],
            storedAt: now - 25 * 60 * 1000,
            decayModel: "logistic",
            decayMidpointDays: REFLECTION_DERIVE_LOGISTIC_MIDPOINT_DAYS,
            decayK: REFLECTION_DERIVE_LOGISTIC_K,
          },
        }),
      ];

      const slices = loadAgentReflectionSlicesFromEntries({
        entries,
        agentId: "main",
        now,
        deriveMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
      });

      assert.ok(slices.invariants.includes("Legacy invariant still applies."));
      assert.ok(slices.invariants.includes("Current invariant applies too."));
      assert.ok(slices.derived.includes("Legacy derived delta still applies."));
      assert.ok(slices.derived.includes("Current derived delta still applies."));
    });

    it("prefers item rows when both item and legacy layouts exist", () => {
      const now = Date.UTC(2026, 2, 7);
      const day = 24 * 60 * 60 * 1000;

      const entries = [
        makeEntry({
          timestamp: now - 1 * day,
          metadata: {
            type: "memory-reflection",
            agentId: "main",
            invariants: ["Legacy invariant should not be selected when item rows exist."],
            derived: ["Legacy derived should not be selected when item rows exist."],
            storedAt: now - 1 * day,
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

      entries[1].text = "Always use itemized rows first.";
      entries[2].text = "Next run prioritize itemized reflection rows.";

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

    it("defaults writeLegacyCombined=true for memoryReflection config", () => {
      const parsed = parsePluginConfig({
        ...baseConfig(),
        sessionStrategy: "memoryReflection",
        memoryReflection: {},
      });
      assert.equal(parsed.memoryReflection.writeLegacyCombined, true);
    });

    it("allows disabling legacy combined reflection writes", () => {
      const parsed = parsePluginConfig({
        ...baseConfig(),
        sessionStrategy: "memoryReflection",
        memoryReflection: {
          writeLegacyCombined: false,
        },
      });
      assert.equal(parsed.memoryReflection.writeLegacyCombined, false);
    });
  });
});
