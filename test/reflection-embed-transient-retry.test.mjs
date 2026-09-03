/**
 * Transient-retry for reflection-lane persistence embeds.
 *
 * Motivating incident: a session reset ran the distiller and wrote the
 * reflection md, but a single transient embedding abort ("Failed to generate
 * embedding from Jina: Request was aborted.") in the persistence path failed
 * the whole hook, so the cycle's mapped rows never reached storage. The
 * GENERATION path already retries transient upstream failures once; the
 * persistence-path embeds now share that policy, and the abort class the
 * incident surfaced is classified transient.
 *
 * Fixtures are synthetic.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const {
  embedWithReflectionTransientRetry,
  isTransientReflectionUpstreamError,
} = jiti("../src/reflection-retry.ts");

const ABORT_ERROR = new Error("Failed to generate embedding from Jina: Request was aborted.");
const instantSleep = async () => {};

describe("abort classification", () => {
  it("classifies the incident's request-abort error as transient", () => {
    assert.equal(isTransientReflectionUpstreamError(ABORT_ERROR), true);
  });

  it("classifies AbortError-named failures as transient", () => {
    assert.equal(isTransientReflectionUpstreamError(new Error("AbortError: signal is aborted without reason")), true);
  });

  it("keeps auth failures non-transient", () => {
    assert.equal(isTransientReflectionUpstreamError(new Error("invalid api key")), false);
  });
});

describe("embedWithReflectionTransientRetry", () => {
  it("retries once on a transient abort and returns the healed vector", async () => {
    let calls = 0;
    const logs = [];
    const embed = async () => {
      calls += 1;
      if (calls === 1) throw ABORT_ERROR;
      return [0.1, 0.2, 0.3];
    };

    const vector = await embedWithReflectionTransientRetry(
      embed,
      "synthetic mapped row text",
      "mapped-row-embedding",
      (level, message) => logs.push(`${level}: ${message}`),
      instantSleep,
    );

    assert.deepEqual(vector, [0.1, 0.2, 0.3]);
    assert.equal(calls, 2, "exactly one retry may fire");
    assert.ok(logs.some((line) => line.includes("retrying once")), "the retry must be logged");
    assert.ok(logs.some((line) => line.includes("retry succeeded")));
  });

  it("gives up after the single retry and rethrows the last error", async () => {
    let calls = 0;
    const embed = async () => {
      calls += 1;
      throw ABORT_ERROR;
    };

    await assert.rejects(
      () => embedWithReflectionTransientRetry(embed, "text", "mapped-row-embedding", undefined, instantSleep),
      /Request was aborted/,
    );
    assert.equal(calls, 2, "one attempt plus one retry, never more");
  });

  it("does not retry non-transient errors", async () => {
    let calls = 0;
    const embed = async () => {
      calls += 1;
      throw new Error("invalid api key");
    };

    await assert.rejects(
      () => embedWithReflectionTransientRetry(embed, "text", "mapped-row-embedding", undefined, instantSleep),
      /invalid api key/,
    );
    assert.equal(calls, 1, "non-transient failures must fail fast");
  });

  it("gives each call its own retry budget (one healed abort does not spend later rows' budgets)", async () => {
    let firstCalls = 0;
    let secondCalls = 0;
    const flakyOnce = async () => {
      firstCalls += 1;
      if (firstCalls === 1) throw ABORT_ERROR;
      return [1];
    };
    const flakyOnceToo = async () => {
      secondCalls += 1;
      if (secondCalls === 1) throw ABORT_ERROR;
      return [2];
    };

    assert.deepEqual(await embedWithReflectionTransientRetry(flakyOnce, "row one", "mapped-row-embedding", undefined, instantSleep), [1]);
    assert.deepEqual(await embedWithReflectionTransientRetry(flakyOnceToo, "row two", "mapped-row-embedding", undefined, instantSleep), [2]);
    assert.equal(firstCalls, 2);
    assert.equal(secondCalls, 2);
  });
});

const { classifyReflectionRetry } = jiti("../src/reflection-retry.ts");

describe("caller-abort awareness", () => {
  it("classifies a caller-aborted failure as non-retryable even when the message looks transient", () => {
    const decision = classifyReflectionRetry({
      inReflectionScope: true,
      retryCount: 0,
      usefulOutputChars: 0,
      error: ABORT_ERROR,
      callerAborted: true,
    });
    assert.equal(decision.retryable, false);
    assert.equal(decision.reason, "caller_aborted");
  });

  it("does not retry when the caller's signal is already aborted", async () => {
    let calls = 0;
    const embed = async () => {
      calls += 1;
      throw ABORT_ERROR;
    };
    await assert.rejects(
      embedWithReflectionTransientRetry(embed, "text", "unit", undefined, instantSleep, { aborted: true }),
      /Request was aborted/,
    );
    assert.equal(calls, 1, "a caller-requested abort must not spend the retry");
  });

  it("skips the second attempt when the caller aborts during the retry backoff", async () => {
    let calls = 0;
    const embed = async () => {
      calls += 1;
      throw ABORT_ERROR;
    };
    const signal = { aborted: false };
    const abortDuringSleep = async () => {
      signal.aborted = true;
    };
    await assert.rejects(
      embedWithReflectionTransientRetry(embed, "text", "unit", undefined, abortDuringSleep, signal),
      /Request was aborted/,
    );
    assert.equal(calls, 1, "an abort during the backoff must cancel the pending retry");
  });

  it("still retries a transient failure when the provided signal is not aborted", async () => {
    let calls = 0;
    const embed = async () => {
      calls += 1;
      if (calls === 1) throw ABORT_ERROR;
      return [1, 2, 3, 4];
    };
    const result = await embedWithReflectionTransientRetry(
      embed, "text", "unit", undefined, instantSleep, { aborted: false },
    );
    assert.deepEqual(result, [1, 2, 3, 4]);
    assert.equal(calls, 2);
  });
});

// ===== Caller-level integration coverage (mapped-row, slice, session-summary) =====
// Each path runs against a real embedder pointed at a local mock server that
// kills the socket on the FIRST request carrying a poisoned marker text. The
// OpenAI client is constructed with maxRetries: 0, so the transport failure
// surfaces to embedWithReflectionTransientRetry, which must heal it once.

const { describe: describeIntegration } = await import("node:test");
const { beforeEach, afterEach } = await import("node:test");
const http = (await import("node:http")).default;
const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const path = (await import("node:path")).default;

const pluginModule = jiti("../index.ts");
const memoryLanceDBProPlugin = pluginModule.default || pluginModule;
const resetRegistration = pluginModule.resetRegistration ?? (() => {});
const { MemoryStore } = jiti("../src/store.ts");

const EMBEDDING_DIMENSIONS = 4;
const FIXED_VECTOR = [0.5, 0.5, 0.5, 0.5];

function createPoisoningEmbeddingServer(markers) {
  const spent = new Set();
  const requestCounts = new Map(markers.map((m) => [m, 0]));
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let inputs = [];
    try {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      inputs = Array.isArray(payload.input) ? payload.input : [payload.input];
    } catch {
      inputs = [];
    }
    const hitMarkers = markers.filter((m) => inputs.some((t) => typeof t === "string" && t.includes(m)));
    for (const m of hitMarkers) requestCounts.set(m, (requestCounts.get(m) ?? 0) + 1);
    const freshPoison = hitMarkers.find((m) => !spent.has(m));
    if (freshPoison) {
      spent.add(freshPoison);
      req.socket.destroy();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: inputs.map((_, index) => ({ object: "embedding", index, embedding: FIXED_VECTOR })),
      model: "mock-embedding-model",
      usage: { prompt_tokens: 0, total_tokens: 0 },
    }));
  });
  return { server, requestCounts };
}

function createListedApiHarness({ pluginConfig, resolveRoot }) {
  const eventHandlers = new Map();
  const logs = [];
  const api = {
    pluginConfig,
    resolvePath(target) {
      if (typeof target !== "string") return target;
      if (path.isAbsolute(target)) return target;
      return path.join(resolveRoot, target);
    },
    logger: {
      info(m) { logs.push(["info", String(m)]); },
      warn(m) { logs.push(["warn", String(m)]); },
      debug(m) { logs.push(["debug", String(m)]); },
      error(m) { logs.push(["error", String(m)]); },
    },
    registerTool() {},
    registerCli() {},
    registerService() {},
    on(eventName, handler, meta) {
      const list = eventHandlers.get(eventName) || [];
      list.push({ handler, meta });
      eventHandlers.set(eventName, list);
    },
    registerHook(eventName, handler, opts) {
      const list = eventHandlers.get(eventName) || [];
      list.push({ handler, meta: opts });
      eventHandlers.set(eventName, list);
    },
  };
  return { api, eventHandlers, logs };
}

function retryWarnCount(logs) {
  return logs.filter(([level, message]) =>
    level === "warn" && /transient upstream failure detected .*retrying once/.test(message)).length;
}

describeIntegration("persistence paths heal one transient embed abort through the retry wrapper", () => {
  let workDir;
  let poison;
  let baseURL;

  beforeEach(async () => {
    resetRegistration();
    workDir = mkdtempSync(path.join(tmpdir(), "embed-retry-integration-"));
  });
  afterEach(async () => {
    if (poison) await new Promise((resolve) => poison.server.close(resolve));
    poison = null;
    resetRegistration();
    rmSync(workDir, { recursive: true, force: true });
  });

  async function startServer(markers) {
    poison = createPoisoningEmbeddingServer(markers);
    await new Promise((resolve) => poison.server.listen(0, "127.0.0.1", resolve));
    baseURL = `http://127.0.0.1:${poison.server.address().port}/v1`;
  }

  it("slice and mapped-row persistence complete after one transient abort each", async () => {
    const SLICE_MARKER = "poisoned-derived-slice";
    const MAPPED_MARKER = "poisoned-decision-row";
    await startServer([SLICE_MARKER, MAPPED_MARKER]);

    const pluginConfig = {
      dbPath: path.join(workDir, "db"),
      embedding: {
        provider: "openai-compatible",
        apiKey: "dummy",
        model: "text-embedding-3-small",
        baseURL,
        dimensions: EMBEDDING_DIMENSIONS,
      },
      sessionStrategy: "memoryReflection",
      memoryReflection: { timeoutMs: 5000 },
      smartExtraction: false,
      autoCapture: false,
      autoRecall: false,
      selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
    };
    const { api, eventHandlers, logs } = createListedApiHarness({ pluginConfig, resolveRoot: workDir });
    api.runtime = {
      agent: {
        async runEmbeddedPiAgent() {
          return { payloads: [{ text: [
            "## Invariants",
            "- Always run the persistence retry integration checks before merging changes.",
            "## Derived",
            `- Next run exercise the ${SLICE_MARKER} retry path for agent-one end to end.`,
            "## Decisions (durable)",
            `- Adopt the ${MAPPED_MARKER} persistence retry policy for agent-one going forward.`,
          ].join("\n") }] };
        },
      },
    };
    memoryLanceDBProPlugin.register(api);

    const sessionFile = path.join(workDir, "session.jsonl");
    writeFileSync(sessionFile, [
      JSON.stringify({ type: "message", message: { role: "user", content: "Please remember this retry integration scenario." } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: "I will reflect on it." } }),
    ].join("\n"), "utf-8");

    const commandHooks = eventHandlers.get("command:new") || [];
    const hook = commandHooks.find((h) => h.meta?.name === "memory-lancedb-pro.memory-reflection.command-new");
    assert.ok(hook, "expected the command:new reflection hook");
    await hook.handler({
      sessionKey: "agent:agent-one:retry-integration",
      timestamp: 1_800_000_000_000,
      action: "tick",
      context: { cfg: pluginConfig, workspaceDir: workDir,
        sessionEntry: { sessionId: "retry-integration-session", sessionFile } },
    }, { sessionKey: "agent:agent-one:retry-integration", agentId: "agent-one" });

    assert.ok(retryWarnCount(logs) >= 2,
      `expected at least two heal-retry warns (slice + mapped), saw ${retryWarnCount(logs)}: ${JSON.stringify(logs.filter(([l]) => l === "warn"))}`);
    assert.ok((poison.requestCounts.get(SLICE_MARKER) ?? 0) >= 2, "poisoned slice text must be re-requested after the abort");
    assert.ok((poison.requestCounts.get(MAPPED_MARKER) ?? 0) >= 2, "poisoned mapped text must be re-requested after the abort");

    const rows = await new MemoryStore({ dbPath: pluginConfig.dbPath, vectorDim: EMBEDDING_DIMENSIONS })
      .list(undefined, undefined, 100, 0);
    assert.ok(rows.some((r) => r.text.includes(SLICE_MARKER)), "derived slice row must be stored despite the transient abort");
    assert.ok(rows.some((r) => r.text.includes(MAPPED_MARKER)), "mapped decision row must be stored despite the transient abort");
  });

  it("session-summary persistence completes after one transient abort", async () => {
    const SUMMARY_MARKER = "poisoned-session-summary";
    await startServer([SUMMARY_MARKER]);

    const pluginConfig = {
      dbPath: path.join(workDir, "db-summary"),
      embedding: {
        provider: "openai-compatible",
        apiKey: "dummy",
        model: "text-embedding-3-small",
        baseURL,
        dimensions: EMBEDDING_DIMENSIONS,
      },
      sessionStrategy: "systemSessionMemory",
      autoCapture: false,
      autoRecall: false,
    };
    const { api, eventHandlers, logs } = createListedApiHarness({ pluginConfig, resolveRoot: workDir });
    memoryLanceDBProPlugin.register(api);

    const resetHooks = eventHandlers.get("before_reset") || [];
    assert.ok(resetHooks.length > 0, "expected a before_reset hook");
    await resetHooks[0].handler({
      reason: "new",
      messages: [
        { role: "user", content: `Wrap up the ${SUMMARY_MARKER} scenario and store the summary.` },
        { role: "assistant", content: "Summarizing and storing now." },
      ],
    }, {
      agentId: "agent-one",
      sessionKey: "agent:agent-one:webchat:summary-retry",
      sessionId: "session-summary-retry",
      workspaceDir: workDir,
    });

    assert.ok(retryWarnCount(logs) >= 1,
      `expected a heal-retry warn for the summary embed, warns: ${JSON.stringify(logs.filter(([l]) => l === "warn"))}`);
    assert.ok((poison.requestCounts.get(SUMMARY_MARKER) ?? 0) >= 2, "poisoned summary text must be re-requested after the abort");

    const rows = await new MemoryStore({ dbPath: pluginConfig.dbPath, vectorDim: EMBEDDING_DIMENSIONS })
      .list(undefined, undefined, 10, 0);
    assert.equal(rows.length, 1, "the session summary must be stored despite the transient abort");
    assert.match(rows[0].text, /Conversation Summary:/);
  });
});
