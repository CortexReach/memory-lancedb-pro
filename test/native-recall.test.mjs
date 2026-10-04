import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";

const here = path.dirname(fileURLToPath(import.meta.url));
const jiti = jitiFactory(import.meta.url, { interopDefault: true, alias: {
  "openclaw/plugin-sdk/memory-recall": path.join(here, "helpers/memory-recall-sdk-stub.mjs"),
  "openclaw/plugin-sdk": path.join(here, "helpers/openclaw-plugin-sdk-stub.mjs"),
} });
const sdk = jiti("./helpers/memory-recall-sdk-stub.mjs");
const retrieverModule = jiti("../src/retriever.ts");
const embedderModule = jiti("../src/embedder.ts");
let retrieve;
const retriever = { retrieve: (...args) => retrieve(...args), getConfig: () => ({ mode: "hybrid" }),
  setAccessTracker() {}, setStatsCollector() {} };
retrieverModule.createRetriever = () => retriever;
embedderModule.createEmbedder = () => ({ embedQuery: async () => [], embedPassage: async () => [] });
const { MemoryStore } = jiti("../src/store.ts");
const originalPatch = MemoryStore.prototype.patchMetadata;
const pluginModule = jiti("../index.ts");
const plugin = pluginModule.default || pluginModule;
const { registerMemoryRecallTool, registerMemoryRecallAliasTool } = jiti("../src/tools.ts");
const { toNativeRecallResults, recordSurfacedRecall } = jiti("../src/native-recall.ts");
const { flushManualRecallMetadataForTest } = jiti("../src/manual-recall-metadata-queue.ts");
let workspaceDir;
let stores;
const query = "Recall the synthetic deployment checklist decisions";
const logger = { info() {}, warn() {}, debug() {}, error() {} };

beforeEach(() => {
  workspaceDir = mkdtempSync(path.join(tmpdir(), "native-recall-"));
  stores = [];
  sdk.resetRecorder();
  pluginModule.resetRegistration();
  MemoryStore.prototype.patchMetadata = async () => null;
  retrieve = async () => [];
});
afterEach(async () => {
  for (const store of stores) await flushManualRecallMetadataForTest(store);
  pluginModule.resetRegistration();
  MemoryStore.prototype.patchMetadata = originalPatch;
  rmSync(workspaceDir, { recursive: true, force: true });
});

function hit(text = "Synthetic deployment checklist requires review before rollout.", metadata = {}, id = "canonical-one") {
  return { entry: { id, text, category: "fact", scope: "global", importance: 0.8, timestamp: Date.now(),
    metadata: JSON.stringify({
      state: "confirmed", memory_layer: "active", openclaw_corpus: true, corpus_source: "memory",
      corpus_path: "memory/2026-01-02.md", corpus_workspace_dir: workspaceDir,
      corpus_start_line: 2, corpus_end_line: 2 + text.split("\n").length - 1,
      corpus_snippet: text, corpus_content_sha256: createHash("sha256").update(text).digest("hex"),
      ...metadata,
    }) }, score: 0.91, sources: { vector: { score: 0.91, rank: 1 } } };
}
function scope(extra = {}) {
  return { workspaceDir, sessionKey: "agent:main:test", runId: "synthetic-run", assertActive() {}, ...extra };
}
function manual(name, results, invocation = scope()) {
  let factory;
  const api = { config: {}, logger, registerTool(fn) { factory = fn; } };
  const store = { count: async () => 0, applyManualRecallMetadataBatch: async (updates) => updates.map((u) => ({ id: u.id, status: "updated" })) };
  stores.push(store);
  const context = { agentId: "main", workspaceDir, store, retriever: {
    retrieve: async ({ limit }) => results.slice(0, limit), getConfig: retriever.getConfig,
  }, scopeManager: { getAccessibleScopes: () => ["global"], isAccessible: () => true }, embedder: {} };
  if (name === "memory_recall") registerMemoryRecallTool(api, context);
  else registerMemoryRecallAliasTool(api, context, name);
  return factory({ ...invocation, agentId: "main", assertInvocationCurrent: invocation.assertActive });
}
function auto(config = {}, invocation = scope()) {
  let hook;
  const api = { config: {}, logger, resolvePath: (p) => path.resolve(workspaceDir, p),
    registerTool() {}, registerCli() {}, registerService() {},
    on(event, handler, meta) { if (event === "before_prompt_build" && meta?.priority === 10) hook = handler; },
    pluginConfig: {
      dbPath: path.join(workspaceDir, "db"), embedding: { apiKey: "synthetic-unused-key" },
      smartExtraction: false, autoCapture: false, autoRecall: true, autoRecallMinLength: 1,
      autoRecallTimeoutMs: 5000, autoRecallMaxItems: 1,
      selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false }, ...config,
    } };
  plugin.register(api);
  assert.equal(typeof hook, "function");
  return () => hook({ prompt: query }, { ...invocation, sessionId: "synthetic", agentId: "main",
    hookInvocation: { assertActive: invocation.assertActive } });
}

for (const name of ["memory_recall", "memory_search", "memory_get"]) {
  test(`${name} records only surfaced canonical text after limits and aliases preserve the real turn`, async () => {
    const text = "First synthetic line.\nSecond synthetic line with enough detail to exercise clipping.\nHidden third line.";
    const tool = manual(name, [hit(text), hit("Beyond limit", {}, "beyond-limit")]);
    const response = await tool.execute("call", { query, limit: 1, maxCharsPerItem: 60 });
    assert.equal(response.details.count, 1);
    assert.equal(sdk.calls.length, 1);
    const recorded = sdk.calls[0];
    assert.equal(recorded.query, query);
    assert.equal(recorded.runId, "synthetic-run");
    assert.equal(recorded.sessionKey, "agent:main:test");
    assert.equal(recorded.workspaceDir, workspaceDir);
    assert.equal(recorded.results.length, 1);
    assert.equal(recorded.results[0].endLine, 3);
    assert.ok(text.startsWith(recorded.results[0].snippet));
    assert.ok(response.content[0].text.includes(recorded.results[0].snippet.replace(/\s+/g, " ")));
    assert.ok(!recorded.results[0].snippet.includes("Hidden"));
  });
}

test("canonical metadata, content hash and workspace provenance are required; no virtual-ID relabeling", () => {
  const valid = hit();
  const cases = [
    hit(undefined, { openclaw_corpus: false }), hit(undefined, { corpus_source: "sessions" }),
    hit(undefined, { corpus_workspace_dir: "/synthetic/other" }), hit(undefined, { corpus_content_sha256: "wrong" }),
    hit(undefined, { corpus_path: "../escape.md" }), hit(undefined, { corpus_path: "/outside.md" }),
    hit(undefined, { corpus_start_line: "2" }), hit(undefined, { corpus_end_line: 1 }),
    hit(undefined, { corpus_absolute_path: "/elsewhere.md" }), hit(undefined, { corpus_snippet: "altered" }),
  ];
  for (const result of cases) {
    assert.deepEqual(toNativeRecallResults(workspaceDir, [{ result, sourceText: result.entry.text, text: result.entry.text, format: "manual" }]), []);
  }
  assert.deepEqual(toNativeRecallResults(workspaceDir, [{ result: valid, sourceText: "Invented abstract", text: "Invented abstract", format: "manual" }]), []);
});

test("manual empty results, virtual records and abstract-only displays do not record", async () => {
  for (const hits of [[], [hit(undefined, { openclaw_corpus: false })], [hit(undefined, { l0_abstract: "Only a generated abstract" })]]) {
    const output = await manual("memory_recall", hits).execute("call", { query });
    assert.equal(output.details.error, undefined);
  }
  assert.equal(sdk.calls.length, 0);
});

test("manual neighbor text is not attributed to the canonical primary", async () => {
  const primary = hit("Primary fact.");
  primary.neighbors = [hit("Neighbor fact.", { corpus_path: "memory/2026-01-03.md" }, "neighbor")];
  const output = await manual("memory_recall", [primary]).execute("call", { query, includeFullText: true });
  assert.ok(output.content[0].text.includes("Neighbor fact."));
  assert.equal(sdk.calls[0].results.length, 1);
  assert.equal(sdk.calls[0].results[0].snippet, "Primary fact.");
});

test("old hosts and unavailable APIs preserve successful recall", async () => {
  for (const mode of ["missing", "failing"]) {
    sdk.resetRecorder(mode);
    const output = await manual("memory_recall", [hit()]).execute("call", { query });
    assert.equal(output.details.count, 1);
    assert.equal(output.details.error, undefined);
    assert.equal(sdk.calls.length, 0);
  }
  sdk.resetRecorder();
  await manual("memory_recall", [hit()], scope({ runId: undefined })).execute("call", { query });
  assert.equal(sdk.calls.length, 0);
});

test("expired scope rejects recording without converting recall to failure", async () => {
  const result = hit();
  await recordSurfacedRecall({ config: {}, logger }, scope({ assertActive() { throw new Error("closed"); } }), query,
    [{ result, sourceText: result.entry.text, text: result.entry.text, format: "manual" }]);
  assert.equal(sdk.calls.length, 0);
});

test("auto records only the final budget winner with the real retrieval query", async () => {
  const first = hit("Selected source with enough literal text to be clipped by the configured character budget.");
  retrieve = async () => [first, hit("Excluded second result", {}, "second")];
  const output = await auto({ autoRecallPerItemMaxChars: 60, autoRecallMaxChars: 60 })();
  assert.ok(output.prependContext.includes("Selected source"));
  assert.ok(!output.prependContext.includes("Excluded second"));
  assert.deepEqual(Object.keys(output).sort(), ["ephemeral", "prependContext"]);
  assert.equal(sdk.calls.length, 1);
  assert.equal(sdk.calls[0].query, query);
  assert.equal(sdk.calls[0].results.length, 1);
  assert.ok(output.prependContext.includes(sdk.calls[0].results[0].snippet));
  assert.ok(sdk.calls[0].results[0].snippet.length < first.entry.text.length);
});

test("auto empty or failed retrieval never records", async () => {
  assert.equal(await auto()(), undefined);
  assert.equal(sdk.calls.length, 0);
  pluginModule.resetRegistration();
  retrieve = async () => { throw new Error("synthetic failure"); };
  assert.equal(await auto()(), undefined);
  assert.equal(sdk.calls.length, 0);
});

test("a late auto result after timeout never reaches the native recorder", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let complete;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const finished = new Promise((resolve) => { complete = resolve; });
  retrieve = async () => { entered(); return finished; };
  const pending = auto({ autoRecallTimeoutMs: 5 })();
  await started;
  t.mock.timers.tick(5);
  assert.equal(await pending, undefined);
  complete([hit()]);
  await finished;
  // Drain the bounded continuation chain without a wall-clock sleep.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sdk.calls.length, 0);
});

test("auto governance exclusion and missing invocation capability do not record", async () => {
  retrieve = async () => [hit(undefined, { state: "pending", memory_layer: "working" })];
  assert.equal(await auto()(), undefined);
  pluginModule.resetRegistration();
  retrieve = async () => [hit()];
  const output = await auto({}, scope({ assertActive: undefined }))();
  assert.ok(output.prependContext);
  assert.equal(sdk.calls.length, 0);
});

test("auto escaped line breaks map back to literal source lines; transformed markup is excluded", async () => {
  const text = "First synthetic source line.\nSecond source line.";
  retrieve = async () => [hit(text)];
  const output = await auto()();
  assert.ok(output.prependContext.includes("line.\\nSecond"));
  assert.equal(sdk.calls[0].results[0].snippet, text);
  assert.equal(sdk.calls[0].results[0].endLine, 3);
  sdk.resetRecorder();
  pluginModule.resetRegistration();
  retrieve = async () => [hit("Source <tag>transformed</tag> for display.")];
  assert.ok((await auto()()).prependContext.includes("Source transformed for display."));
  assert.equal(sdk.calls.length, 0);
});

test("auto retains injection on old hosts, absent API, or expired scope without recording", async () => {
  for (const [mode, invocation] of [
    ["missing", scope()], ["failing", scope()],
    ["available", scope({ workspaceDir: undefined })],
    ["available", scope({ runId: undefined })],
    ["available", scope({ assertActive() { throw new Error("closed"); } })],
  ]) {
    sdk.resetRecorder(mode);
    pluginModule.resetRegistration();
    retrieve = async () => [hit()];
    assert.ok((await auto({}, invocation)()).prependContext);
    assert.equal(sdk.calls.length, 0);
  }
});

test("auto generated abstracts are not relabeled as canonical file text", async () => {
  retrieve = async () => [hit(undefined, { l0_abstract: "Generated summary only" })];
  assert.ok((await auto()()).prependContext.includes("Generated summary only"));
  assert.equal(sdk.calls.length, 0);
});

test("duplicate plugin recalls share host identity instead of inventing new turns or query hashes", async () => {
  const same = hit();
  const output = await manual("memory_search", [same, same]).execute("call-one", { query, limit: 2 });
  assert.equal(output.details.count, 2);
  retrieve = async () => [same];
  await auto()();
  assert.equal(sdk.calls.length, 2);
  assert.equal(sdk.calls[0].runId, sdk.calls[1].runId);
  assert.equal(sdk.calls[0].sessionKey, sdk.calls[1].sessionKey);
  assert.equal(sdk.calls[0].query, sdk.calls[1].query);
  // The public host owner, tested in the companion change, performs dedup.
  assert.deepEqual(sdk.calls[0].results[0], sdk.calls[1].results[0]);
});

test("canonical indentation and hard-break whitespace preserve original source bytes", async () => {
  const text = "  Indented canonical source with a Markdown hard break.  \n  Next line.  ";
  const output = await manual("memory_recall", [hit(text)]).execute("call", { query, includeFullText: true });
  assert.equal(output.details.count, 1);
  assert.equal(sdk.calls.length, 1);
  assert.equal(sdk.calls[0].results[0].snippet, text.trimEnd());
  assert.equal(sdk.calls[0].results[0].endLine, 3);
  sdk.resetRecorder();
  pluginModule.resetRegistration();
  retrieve = async () => [hit("  Indented canonical source.  ")];
  assert.ok((await auto()()).prependContext.includes("Indented canonical source."));
  assert.equal(sdk.calls[0].results[0].snippet, "  Indented canonical source.");
});

test("slow optional native recording cannot hold or discard a winning auto injection", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  let enter;
  let release;
  let settle;
  const entered = new Promise((resolve) => { enter = resolve; });
  const pendingWrite = new Promise((resolve) => { release = resolve; });
  const settled = new Promise((resolve) => { settle = resolve; });
  sdk.setRecorder(async (params) => {
    enter();
    try {
      await pendingWrite;
      params.assertActive();
      sdk.calls.push(params);
    } finally { settle(); }
  });
  retrieve = async () => [hit()];
  const pending = auto({ autoRecallTimeoutMs: 5 })();
  await entered;
  t.mock.timers.tick(5);
  const output = await pending;
  assert.ok(output.prependContext.includes("Synthetic deployment checklist"));
  assert.equal(sdk.calls.length, 0);
  release();
  await settled;
  assert.equal(sdk.calls.length, 0, "late native write must fail its retained assertion");
});
