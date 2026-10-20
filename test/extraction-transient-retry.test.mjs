/**
 * extraction-transient-retry.test.mjs
 *
 * completeJson folds every failure into null, so the extraction path could
 * not tell a silent upstream (timeout, 5xx, connection reset) from an unusable
 * answer, and the grounding rejudge failed closed on both, demoting every
 * durable in the batch. The model calls in the extraction path now retry a
 * transient upstream failure once and report the run as unavailable when the
 * model never answered, so the caller defers the batch instead of judging it.
 * Fixtures are synthetic.
 *
 * Run: node --test test/extraction-transient-retry.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginSdkStubPath = path.resolve(testDir, "helpers", "openclaw-plugin-sdk-stub.mjs");
const jiti = jitiFactory(import.meta.url, {
  interopDefault: true,
  alias: { "openclaw/plugin-sdk": pluginSdkStubPath },
});

const { completeJsonWithTransientRetry, isUpstreamRequestFailure } = jiti("../src/extraction-transient-retry.ts");
const { SmartExtractor } = jiti("../src/smart-extractor.ts");
const { MemoryStore } = jiti("../src/store.ts");
const { createEmbedder } = jiti("../src/embedder.ts");

const TRANSIENT_ERROR = "memory-lancedb-pro: llm-client [extract-candidates] request failed for model mock: 503 Service Unavailable";
const HOST_TRANSIENT_ERROR = "memory-lancedb-pro: llm-client [grounding-rejudge] host-transport request failed for model mock: fetch failed";
const AUTH_ERROR = "memory-lancedb-pro: llm-client [extract-candidates] request failed for model mock: 401 Unauthorized";
const PARSE_ERROR = "memory-lancedb-pro: llm-client [extract-candidates] JSON.parse failed: Unexpected token (jsonChars=12)";

function makeScriptedLlm(script) {
  let lastError = null;
  let calls = 0;
  return {
    calls: () => calls,
    async completeJson() {
      const step = script[Math.min(calls, script.length - 1)];
      calls += 1;
      if (step.value !== undefined) {
        lastError = null;
        return step.value;
      }
      lastError = step.error;
      return null;
    },
    getLastError() {
      return lastError;
    },
  };
}

describe("upstream failure detection", () => {
  it("recognizes the request-failed wording of every client and nothing else", () => {
    assert.equal(isUpstreamRequestFailure(TRANSIENT_ERROR), true);
    assert.equal(isUpstreamRequestFailure(HOST_TRANSIENT_ERROR), true);
    assert.equal(isUpstreamRequestFailure(AUTH_ERROR), true);
    assert.equal(isUpstreamRequestFailure(PARSE_ERROR), false);
    assert.equal(isUpstreamRequestFailure(null), false);
    assert.equal(isUpstreamRequestFailure(undefined), false);
  });
});

describe("completeJsonWithTransientRetry", () => {
  const params = (llm, extra = {}) => ({
    llm,
    prompt: "prompt",
    label: "extract-candidates",
    sleep: async () => {},
    random: () => 0,
    ...extra,
  });

  it("returns the first usable answer without retrying", async () => {
    const llm = makeScriptedLlm([{ value: { memories: [] } }]);
    const outcome = await completeJsonWithTransientRetry(params(llm));
    assert.deepEqual(outcome, { value: { memories: [] }, unavailable: false });
    assert.equal(llm.calls(), 1);
  });

  it("retries a transient upstream failure once and returns the retry's answer", async () => {
    const sleeps = [];
    const llm = makeScriptedLlm([{ error: TRANSIENT_ERROR }, { value: { memories: [{ abstract: "x" }] } }]);
    const outcome = await completeJsonWithTransientRetry(params(llm, { sleep: async (ms) => { sleeps.push(ms); } }));
    assert.equal(outcome.unavailable, false);
    assert.deepEqual(outcome.value, { memories: [{ abstract: "x" }] });
    assert.equal(llm.calls(), 2);
    assert.deepEqual(sleeps, [1000], "backoff comes from the shared reflection retry delay");
  });

  it("reports unavailable when the retry also fails upstream", async () => {
    const llm = makeScriptedLlm([{ error: TRANSIENT_ERROR }, { error: HOST_TRANSIENT_ERROR }]);
    const outcome = await completeJsonWithTransientRetry(params(llm));
    assert.equal(outcome.value, null);
    assert.equal(outcome.unavailable, true);
    assert.equal(llm.calls(), 2);
  });

  it("does not retry a non-retryable upstream failure but still reports unavailable", async () => {
    const llm = makeScriptedLlm([{ error: AUTH_ERROR }, { value: { memories: [] } }]);
    const outcome = await completeJsonWithTransientRetry(params(llm));
    assert.equal(outcome.value, null);
    assert.equal(outcome.unavailable, true);
    assert.equal(llm.calls(), 1, "a 401 is not transient; no second attempt");
  });

  it("treats an unusable answer as a verdict: no retry, not unavailable", async () => {
    const llm = makeScriptedLlm([{ error: PARSE_ERROR }, { value: { memories: [] } }]);
    const outcome = await completeJsonWithTransientRetry(params(llm));
    assert.equal(outcome.value, null);
    assert.equal(outcome.unavailable, false);
    assert.equal(llm.calls(), 1);
  });

  it("works with clients that expose no last-error diagnostics", async () => {
    const llm = { async completeJson() { return null; } };
    const outcome = await completeJsonWithTransientRetry(params(llm));
    assert.deepEqual(outcome, { value: null, unavailable: false, error: undefined });
  });
});

const EMBEDDING_DIMENSIONS = 32;

function createEmbeddingServer() {
  return http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const inputs = Array.isArray(payload.input) ? payload.input : [payload.input];
    const embed = (text) => {
      let seed = 2166136261;
      for (const ch of String(text)) seed = Math.imul(seed ^ ch.codePointAt(0), 16777619) >>> 0;
      const vec = Array.from({ length: EMBEDDING_DIMENSIONS }, () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 4294967296 - 0.5;
      });
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
      return vec.map((v) => v / norm);
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: inputs.map((input, index) => ({ object: "embedding", index, embedding: embed(input) })),
      model: "mock",
      usage: { prompt_tokens: 0, total_tokens: 0 },
    }));
  });
}

const REJUDGE_FIRING_EXTRACTION = {
  conversation_register: "mixed",
  memories: [
    {
      category: "preferences",
      abstract: "Keeps a pewter compass on the windowsill",
      overview: "## Preference\n- Pewter compass on the windowsill",
      content: "The user keeps a pewter compass on the windowsill.",
      grounding: "real",
    },
    {
      category: "events",
      abstract: "User explored an imagined observatory scenario",
      overview: "## Event\n- Imagined scenario explored",
      content: "The user explored an imagined observatory-keeper scenario this session.",
      grounding: "real",
    },
  ],
};

describe("grounding rejudge silence defers the batch", () => {
  it("hands the batch back as unavailable instead of failing closed when the judge never answers", async () => {
    const workDir = mkdtempSync(path.join(tmpdir(), "extraction-transient-retry-"));
    const embeddingServer = createEmbeddingServer();
    await new Promise((resolve) => embeddingServer.listen(0, "127.0.0.1", resolve));
    const embeddingPort = embeddingServer.address().port;
    process.env.TEST_EMBEDDING_BASE_URL = `http://127.0.0.1:${embeddingPort}/v1`;
    const logs = [];
    const labels = [];
    try {
      const store = new MemoryStore({ dbPath: path.join(workDir, "db"), vectorDim: EMBEDDING_DIMENSIONS });
      const embedder = createEmbedder({
        provider: "openai-compatible",
        apiKey: "dummy",
        model: "mock",
        baseURL: `http://127.0.0.1:${embeddingPort}/v1`,
        dimensions: EMBEDDING_DIMENSIONS,
      });
      let lastError = null;
      const llm = {
        async completeJson(_prompt, label) {
          labels.push(label);
          if (label === "extract-candidates") {
            lastError = null;
            return REJUDGE_FIRING_EXTRACTION;
          }
          if (label === "grounding-rejudge") {
            lastError = HOST_TRANSIENT_ERROR;
            return null;
          }
          lastError = null;
          return null;
        },
        getLastError() { return lastError; },
      };
      const extractor = new SmartExtractor(store, embedder, llm, {
        user: "User",
        extractMinMessages: 1,
        extractMaxChars: 8000,
        defaultScope: "test",
        log: (msg) => logs.push(msg),
        debugLog: (msg) => logs.push(msg),
        transientRetrySleep: async () => {},
      });

      const stats = await extractor.extractAndPersist(
        "User: I keep a pewter compass on the windowsill.\nAssistant: Noted.",
        "agent:agent-one:session:transient",
        { scope: "test", scopeFilter: ["test"], agentId: "agent-one" },
      );

      assert.equal(stats.extractionFailed, true, "silence is a deferrable failure, not a verdict");
      assert.equal(stats.llmUnavailable, true);
      assert.equal(stats.created, 0);
      assert.deepEqual(labels, ["extract-candidates", "grounding-rejudge", "grounding-rejudge"], "one retry of the judge, then defer");
      const rows = await store.list(["test"], undefined, 50, 0);
      assert.equal(rows.length, 0, "no durable was demoted or persisted");
      assert.ok(logs.some((m) => m.includes("deferring the batch instead of failing closed")), logs.join("\n"));
      assert.ok(!logs.some((m) => m.includes("failing closed, real-tagged durables will be demoted")), logs.join("\n"));
    } finally {
      delete process.env.TEST_EMBEDDING_BASE_URL;
      await new Promise((resolve) => embeddingServer.close(resolve));
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
