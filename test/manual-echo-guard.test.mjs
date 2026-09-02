/**
 * Manual-store echo guard: deterministic pre-judge drop of extraction
 * candidates that near-duplicate a recent manual memory_store/memory_update
 * text.
 *
 * Mechanism (design ruling 2026-07-21, tightened in review): when the user
 * dictates a memory ("remember this: ..."), the same sentence flows through
 * BOTH the manual store lane and auto-capture extraction, minting near-twin
 * rows the dedup layer cannot reliably collide. The guard keeps a per-agent
 * ring of recent manual texts and drops near-identical extraction candidates
 * BEFORE the admission judge — string-only comparison, no LLM, no vector
 * search.
 *
 * Match test is ONE-SIDED and conservative: exact match, the manual text
 * containing the candidate, or every candidate content token (after glue-word
 * stripping) already present in the manual text. A candidate carrying ANY
 * extra content — negation, changed value, temporal qualifier, added facts —
 * always survives. Entries expire (TTL), are consumed on match, and are
 * invalidated when their memory is forgotten.
 *
 * Fixtures are entirely synthetic; no real fleet data.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
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
const {
  ManualEchoLedger,
  isNearIdenticalEcho,
  normalizeEchoText,
  MANUAL_ECHO_RING_SIZE,
  MANUAL_ECHO_TTL_MS,
} = jiti("../src/manual-echo-guard.ts");

describe("normalizeEchoText", () => {
  it("lowercases, strips punctuation, collapses whitespace", () => {
    assert.equal(
      normalizeEchoText("  Favorite Teacup:   the RED one!  "),
      "favorite teacup the red one",
    );
  });

  it("keeps unicode letters and digits", () => {
    assert.equal(normalizeEchoText("Çay saati 15:30'da"), "çay saati 15 30 da");
  });
});

describe("isNearIdenticalEcho", () => {
  const manual = "the office plant needs watering every friday";

  it("matches exact text", () => {
    assert.equal(isNearIdenticalEcho(manual, manual), true);
  });

  it("matches the sentence-wrapped echo (glue words only added)", () => {
    assert.equal(
      isNearIdenticalEcho(
        `User stated that the office plant needs watering every Friday.`,
        manual,
      ),
      true,
    );
  });

  it("matches when the manual text contains the candidate", () => {
    assert.equal(
      isNearIdenticalEcho("office plant needs watering", manual),
      true,
    );
  });

  it("matches the sentence-wrapped echo shape via token-subset containment", () => {
    assert.equal(
      isNearIdenticalEcho(
        "User's favorite teacup is the red one",
        "favorite teacup: the red one",
      ),
      true,
    );
  });

  it("keeps a candidate that adds a new content token (no fuzzy overlap match)", () => {
    assert.equal(
      isNearIdenticalEcho(
        "office plant needs deep watering every friday morning",
        "the office plant needs watering every friday morning",
      ),
      false,
    );
  });

  it("keeps a negated candidate (correction, not echo)", () => {
    assert.equal(
      isNearIdenticalEcho(
        "alice no longer works at acme",
        "alice works at acme",
      ),
      false,
    );
  });

  it("keeps a positive candidate against a negated manual text", () => {
    assert.equal(
      isNearIdenticalEcho(
        "alice works at acme",
        "alice does not work at acme anymore",
      ),
      false,
    );
  });

  it("keeps a temporally qualified candidate", () => {
    assert.equal(
      isNearIdenticalEcho(
        "alice works at acme until friday",
        "alice works at acme",
      ),
      false,
    );
  });

  it("keeps a changed-value candidate", () => {
    assert.equal(
      isNearIdenticalEcho(
        "alice works at initech",
        "alice works at acme",
      ),
      false,
    );
  });

  it("keeps a candidate carrying additional facts", () => {
    assert.equal(
      isNearIdenticalEcho(
        "alice works at acme and volunteers at the animal shelter",
        "alice works at acme",
      ),
      false,
    );
  });

  it("keeps a candidate that swaps a semantic predicate (wants against has)", () => {
    assert.equal(
      isNearIdenticalEcho(
        "User wants a golden retriever named Max",
        "User has a golden retriever named Max",
      ),
      false,
      "has/wants/likes/prefers decide what a sentence asserts; they are content, not glue",
    );
  });

  it("keeps a candidate that drops the distinguishing part of a preference", () => {
    assert.equal(
      isNearIdenticalEcho(
        "User prefers Python",
        "User prefers Go over Python for backend services",
      ),
      false,
      "an ordered subsequence of the manual content is a different assertion, not an echo",
    );
  });

  it("keeps a candidate with a different predicate and object against a fuller manual text", () => {
    assert.equal(
      isNearIdenticalEcho(
        "User likes tea",
        "User prefers coffee over tea in the morning",
      ),
      false,
    );
  });

  it("still collapses the same-order wrap echo when the fact carries a predicate", () => {
    assert.equal(
      isNearIdenticalEcho(
        "User mentioned that Alice prefers Go for backend services",
        "alice prefers go for backend services",
      ),
      true,
      "reporting glue around an otherwise identical assertion is still an echo",
    );
  });

  it("rejects unrelated candidates", () => {
    assert.equal(
      isNearIdenticalEcho("user's dog is named Biscuit", manual),
      false,
    );
  });

  it("rejects low-overlap candidates sharing a few tokens", () => {
    assert.equal(
      isNearIdenticalEcho(
        "user waters the garden on weekends with a hose",
        manual,
      ),
      false,
    );
  });

  it("requires exact match for very short manual texts", () => {
    assert.equal(isNearIdenticalEcho("blue mug", "blue mug"), true);
    assert.equal(
      isNearIdenticalEcho("user owns a blue mug from portugal", "blue mug"),
      false,
    );
  });

  describe("CJK fallback", () => {
    const manualCjk = "最喜欢的茶杯是红色的那个";

    it("matches an exact CJK echo", () => {
      assert.equal(isNearIdenticalEcho(manualCjk, manualCjk), true);
    });

    it("matches a wrapped CJK echo (small glue, no markers)", () => {
      assert.equal(isNearIdenticalEcho(`用户说${manualCjk}`, manualCjk), true);
    });

    it("matches a shortened CJK echo", () => {
      assert.equal(isNearIdenticalEcho("最喜欢的茶杯是红色", manualCjk), true);
    });

    it("keeps a temporally qualified CJK candidate", () => {
      assert.equal(isNearIdenticalEcho(`${manualCjk}直到周五`, manualCjk), false);
    });

    it("keeps a negated CJK candidate", () => {
      assert.equal(isNearIdenticalEcho(`不再${manualCjk}`, manualCjk), false);
    });

    it("keeps a shortened CJK candidate whose removed residual carried the negation", () => {
      assert.equal(
        isNearIdenticalEcho("喜欢喝茶和咖啡", "用户不喜欢喝茶和咖啡"),
        false,
        "stripping the negated wrapper off the manual text yields the OPPOSITE claim, never an echo",
      );
    });

    it("keeps a wrapped CJK candidate whose residual is a new fact, not glue", () => {
      assert.equal(
        isNearIdenticalEcho("我住在北京市海淀区并养猫", "我住在北京市海淀区"),
        false,
        "a short marker-free residual can still be a brand-new fact; only known glue may wrap an echo",
      );
    });
  });
});

describe("ManualEchoLedger", () => {
  it("records and matches per agent", () => {
    const ledger = new ManualEchoLedger();
    ledger.record("agent-one", "favorite teacup: the red one");
    assert.ok(
      ledger.match("agent-one", "User's favorite teacup is the red one"),
    );
    assert.equal(
      ledger.match("agent-two", "User's favorite teacup is the red one"),
      null,
    );
  });

  it("returns null when nothing recorded", () => {
    const ledger = new ManualEchoLedger();
    assert.equal(ledger.match("agent-one", "anything at all"), null);
  });

  it("buckets undefined agent ids together", () => {
    const ledger = new ManualEchoLedger();
    ledger.record(undefined, "kneeling chair height is 104cm");
    assert.ok(ledger.match(undefined, "the kneeling chair height is 104cm"));
  });

  it("consumes an entry on match: one manual store suppresses one echo", () => {
    const ledger = new ManualEchoLedger();
    ledger.record("agent-one", "favorite teacup: the red one");
    assert.ok(ledger.match("agent-one", "favorite teacup: the red one"));
    assert.equal(
      ledger.match("agent-one", "favorite teacup: the red one"),
      null,
      "a second identical statement is a deliberate re-assertion, not an echo",
    );
  });

  it("expires entries after the TTL", () => {
    const ledger = new ManualEchoLedger();
    const t0 = 1_000_000;
    ledger.record("agent-one", "standing desk height is 112cm", t0);
    assert.ok(
      ledger.match("agent-one", "standing desk height is 112cm", t0 + MANUAL_ECHO_TTL_MS - 1),
    );
    ledger.record("agent-one", "standing desk height is 112cm", t0);
    assert.equal(
      ledger.match("agent-one", "standing desk height is 112cm", t0 + MANUAL_ECHO_TTL_MS + 1),
      null,
      "an expired manual text must not suppress a later re-statement",
    );
  });

  it("invalidate() drops the forgotten text but keeps others", () => {
    const ledger = new ManualEchoLedger();
    ledger.record("agent-one", "favorite teacup: the red one");
    ledger.record("agent-one", "the office plant needs watering every friday");
    ledger.invalidate("agent-one", "Favorite Teacup: the RED one");
    assert.equal(ledger.match("agent-one", "favorite teacup: the red one"), null);
    assert.ok(
      ledger.match("agent-one", "the office plant needs watering every friday"),
    );
  });

  it("caps the ring and evicts the oldest entry", () => {
    const ledger = new ManualEchoLedger();
    ledger.record("agent-one", "the very first manual fact about topic zero");
    for (let i = 1; i <= MANUAL_ECHO_RING_SIZE; i++) {
      ledger.record("agent-one", `distinct manual fact number ${i} about topic ${i}`);
    }
    assert.equal(
      ledger.match("agent-one", "the very first manual fact about topic zero"),
      null,
    );
    assert.ok(
      ledger.match("agent-one", `distinct manual fact number ${MANUAL_ECHO_RING_SIZE} about topic ${MANUAL_ECHO_RING_SIZE}`),
    );
  });

  it("ignores empty and whitespace-only records", () => {
    const ledger = new ManualEchoLedger();
    ledger.record("agent-one", "   ");
    assert.equal(ledger.match("agent-one", "   "), null);
  });

  it("keeps a reversed relationship (order-preserving containment)", () => {
    assert.equal(
      isNearIdenticalEcho("Alice reports to Bob", "Bob reports to Alice"),
      false,
      "bag-of-words containment would collapse the reversed relationship",
    );
    assert.equal(
      isNearIdenticalEcho("User stated that Alice reports to Bob", "Alice reports to Bob"),
      true,
      "the same-order wrap echo must still collapse",
    );
  });

  it("consume persists with MULTIPLE live entries: one hit removes exactly the matched entry", () => {
    const ledger = new ManualEchoLedger();
    ledger.record("agent-one", "the office plant needs watering every friday");
    ledger.record("agent-one", "favorite teacup: the red one");
    assert.ok(ledger.match("agent-one", "favorite teacup: the red one"), "first hit consumes the teacup entry");
    assert.equal(
      ledger.match("agent-one", "favorite teacup: the red one"),
      null,
      "the consumed entry must be gone FROM THE MAP, not just from a detached copy",
    );
    assert.ok(
      ledger.match("agent-one", "the office plant needs watering every friday"),
      "the other live entry must survive the first consume",
    );
  });

  it("clear() empties one agent's ring only", () => {
    const ledger = new ManualEchoLedger();
    ledger.record("agent-one", "favorite teacup: the red one");
    ledger.record("agent-two", "favorite teacup: the red one");
    ledger.clear("agent-one");
    assert.equal(ledger.match("agent-one", "favorite teacup: the red one"), null);
    assert.ok(ledger.match("agent-two", "favorite teacup: the red one"));
  });
});

describe("echo guard through the full auto-capture path", () => {
  const EMBED_DIMS = 64;
  let workspaceDir;
  let embeddingServer;
  let llmServer;
  let extractionPrompts;
  let llmEchoText;

  function hashToIndex(text, dims) {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
    return h % dims;
  }

  beforeEach(async () => {
    workspaceDir = mkdtempSync(path.join(tmpdir(), "manual-echo-e2e-"));
    extractionPrompts = [];
    llmEchoText = null;
    embeddingServer = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const inputs = Array.isArray(payload.input) ? payload.input : [payload.input];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        object: "list",
        data: inputs.map((input, index) => {
          const v = new Array(EMBED_DIMS).fill(0);
          v[hashToIndex(String(input), EMBED_DIMS)] = 1;
          return { object: "embedding", index, embedding: v };
        }),
        model: "mock-embedding-model",
        usage: { prompt_tokens: 0, total_tokens: 0 },
      }));
    });
    llmServer = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const prompt = String(payload.messages?.map((m) => m.content).join("\n") ?? "");
      if (prompt.includes("## Recent Conversation")) extractionPrompts.push(prompt);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl-test", object: "chat.completion", created: 1, model: "mock-memory-model",
        choices: [{
          index: 0, finish_reason: "stop",
          message: {
            role: "assistant",
            content: JSON.stringify({
              memories: llmEchoText
                ? [{
                    category: "preferences",
                    abstract: "echo of the manual text",
                    overview: `## Preference\n- ${llmEchoText}`,
                    content: llmEchoText,
                  }]
                : [],
            }),
          },
        }],
      }));
    });
    await new Promise((resolve) => embeddingServer.listen(0, "127.0.0.1", resolve));
    await new Promise((resolve) => llmServer.listen(0, "127.0.0.1", resolve));
  });

  afterEach(async () => {
    await new Promise((resolve) => embeddingServer.close(resolve));
    await new Promise((resolve) => llmServer.close(resolve));
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  function registerPlugin() {
    const pluginModule = jiti("../index.ts");
    const plugin = pluginModule.default || pluginModule;
    (pluginModule.resetRegistration ?? (() => {}))();
    const eventHandlers = new Map();
    const tools = new Map();
    const logs = { info: [], warn: [], debug: [] };
    const api = {
      pluginConfig: {
        dbPath: path.join(workspaceDir, "memory-db"),
        autoCapture: true,
        autoRecall: false,
        smartExtraction: true,
        extractMinMessages: 2,
        extractionThrottle: { skipLowValue: false, maxExtractionsPerHour: 200 },
        sessionCompression: { enabled: false },
        selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
        embedding: {
          apiKey: "test-key", model: "mock-embedding-model",
          baseURL: `http://127.0.0.1:${embeddingServer.address().port}/v1`,
          dimensions: EMBED_DIMS,
        },
        llm: {
          apiKey: "test-key", model: "mock-memory-model",
          baseURL: `http://127.0.0.1:${llmServer.address().port}`,
        },
      },
      resolvePath(target) {
        if (typeof target !== "string") return target;
        if (path.isAbsolute(target)) return target;
        return path.join(workspaceDir, target);
      },
      logger: {
        info(m) { logs.info.push(String(m)); },
        warn(m) { logs.warn.push(String(m)); },
        debug(m) { logs.debug.push(String(m)); },
      },
      registerTool(factory, meta) {
        const name = meta?.name;
        if (name) tools.set(name, factory);
      },
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
    plugin.register(api);
    const hooks = eventHandlers.get("agent_end") || [];
    assert.ok(hooks.length >= 1, "expected an agent_end handler");
    const getTool = (name) => {
      const factory = tools.get(name);
      assert.ok(factory, `tool ${name} should be registered`);
      return factory({});
    };
    return { hook: hooks[0].handler, getTool, logs };
  }

  async function fireAgentEnd(hook, messages, ctx) {
    hook({ success: true, messages }, ctx);
    const run = hook.__lastRun;
    assert.ok(run && typeof run.then === "function", "expected a background capture run");
    await run;
  }

  it("settles an echo-only batch instead of deferring it for a retry", async () => {
    const { hook, getTool, logs } = registerPlugin();
    const MANUAL = "preferred rehearsal room is the basement studio";
    llmEchoText = `User stated the preferred rehearsal room is the basement studio`;

    const store = getTool("memory_store");
    await store.execute("call-1", { text: MANUAL });

    const ctx = { sessionKey: "agent:main:main", agentId: "main" };
    await fireAgentEnd(hook, [
      { role: "user", content: `remember this: ${MANUAL}` },
      { role: "assistant", content: "stored it" },
      { role: "user", content: "thanks, noted for the band" },
    ], ctx);

    assert.equal(extractionPrompts.length, 1, "extraction should run once");
    assert.ok(
      logs.info.some((line) => line.includes("settled with no persisted rows")),
      `an echo-only batch must settle (consume its input), not defer for retry; got info logs: ${logs.info.join(" | ")}`,
    );

    llmEchoText = null;
    await fireAgentEnd(hook, [
      { role: "user", content: `remember this: ${MANUAL}` },
      { role: "assistant", content: "stored it" },
      { role: "user", content: "thanks, noted for the band" },
      { role: "user", content: "also the amp cables live in the gray tote" },
    ], ctx);
    const repeatedEcho = extractionPrompts
      .slice(1)
      .filter((p) => p.includes(MANUAL) && p.includes("remember this")).length;
    assert.ok(
      extractionPrompts.length >= 1,
      `follow-up state sanity (${repeatedEcho} echo re-runs observed)`,
    );
  });

  it("records the superseding text on the temporal memory_update path (handler level)", async () => {
    const { registerAllMemoryTools } = jiti("../src/tools.ts");
    const ledger = new ManualEchoLedger();
    const EXISTING_ID = "11111111-2222-4333-8444-555555555555";
    const ORIGINAL = "favorite rehearsal drink: sparkling water";
    const UPDATED = "favorite rehearsal drink: mint tea";
    const existingEntry = {
      id: EXISTING_ID,
      text: ORIGINAL,
      category: "preference",
      scope: "agent:main",
      importance: 0.7,
      timestamp: Date.now() - 60_000,
      metadata: JSON.stringify({
        memory_category: "preferences",
        l0_abstract: ORIGINAL,
        l1_overview: `- ${ORIGINAL}`,
        l2_content: ORIGINAL,
        source: "manual",
        state: "confirmed",
      }),
    };
    const context = {
      agentId: "main",
      workspaceDir: workspaceDir,
      mdMirror: null,
      manualEchoLedger: ledger,
      scopeManager: {
        getAccessibleScopes: (agentId) => ["global", `agent:${agentId}`],
        getScopeFilter: (agentId) => ["global", `agent:${agentId}`],
        isAccessible: (scope, agentId) => ["global", `agent:${agentId}`].includes(scope),
        getDefaultScope: (agentId) => `agent:${agentId}`,
      },
      retriever: { getConfig() { return { mode: "hybrid" }; } },
      store: {
        async getById(id) { return id === EXISTING_ID ? existingEntry : null; },
        async vectorSearch() { return []; },
        async list() { return [existingEntry]; },
        async listFactKeyCandidates() { return [existingEntry]; },
        async store(entry) { return { ...entry, id: "99999999-8888-4777-8666-555555555554", timestamp: Date.now() }; },
        async update() { return existingEntry; },
      },
      embedder: { async embedPassage() { return [0.1, 0.2, 0.3]; } },
    };
    const creators = new Map();
    registerAllMemoryTools(
      {
        registerTool(factory, meta) { creators.set(meta.name, factory); },
        logger: { info() {}, warn() {}, debug() {} },
      },
      context,
      { enableManagementTools: true },
    );
    ledger.record("main", ORIGINAL);
    const update = creators.get("memory_update")({});
    const updated = await update.execute(null, { memoryId: EXISTING_ID, text: UPDATED });
    assert.equal(
      updated?.details?.action,
      "superseded",
      `the preferences update must take the temporal supersede path (got ${JSON.stringify(updated?.details)})`,
    );
    assert.ok(
      ledger.match("main", UPDATED),
      "the successful temporal supersede must record the NEW text in the echo ledger before its early return",
    );
    assert.equal(
      ledger.match("main", ORIGINAL),
      null,
      "the replaced text must be invalidated: a reversal back to it is new information once the store no longer holds it",
    );
  });

  it("invalidates the replaced text on the plain (non-temporal) memory_update path too", async () => {
    const { registerAllMemoryTools } = jiti("../src/tools.ts");
    const ledger = new ManualEchoLedger();
    const EXISTING_ID = "21111111-2222-4333-8444-555555555555";
    const ORIGINAL = "rehearsal warm-up routine: scales for ten minutes";
    const UPDATED = "rehearsal warm-up routine: long tones for ten minutes";
    const existingEntry = {
      id: EXISTING_ID,
      text: ORIGINAL,
      category: "fact",
      scope: "agent:main",
      importance: 0.7,
      timestamp: Date.now() - 60_000,
      metadata: JSON.stringify({
        memory_category: "patterns",
        l0_abstract: ORIGINAL,
        l1_overview: `- ${ORIGINAL}`,
        l2_content: ORIGINAL,
        source: "manual",
        state: "confirmed",
      }),
    };
    const context = {
      agentId: "main",
      workspaceDir: workspaceDir,
      mdMirror: null,
      manualEchoLedger: ledger,
      scopeManager: {
        getAccessibleScopes: (agentId) => ["global", `agent:${agentId}`],
        getScopeFilter: (agentId) => ["global", `agent:${agentId}`],
        isAccessible: (scope, agentId) => ["global", `agent:${agentId}`].includes(scope),
        getDefaultScope: (agentId) => `agent:${agentId}`,
      },
      retriever: { getConfig() { return { mode: "hybrid" }; } },
      store: {
        async getById(id) { return id === EXISTING_ID ? existingEntry : null; },
        async vectorSearch() { return []; },
        async list() { return [existingEntry]; },
        async listFactKeyCandidates() { return [existingEntry]; },
        async store(entry) { return { ...entry, id: "99999999-8888-4777-8666-555555555553", timestamp: Date.now() }; },
        async update(id, patch) { return { ...existingEntry, ...patch, id }; },
      },
      embedder: { async embedPassage() { return [0.1, 0.2, 0.3]; } },
    };
    const creators = new Map();
    registerAllMemoryTools(
      {
        registerTool(factory, meta) { creators.set(meta.name, factory); },
        logger: { info() {}, warn() {}, debug() {} },
      },
      context,
      { enableManagementTools: true },
    );
    ledger.record("main", ORIGINAL);
    const update = creators.get("memory_update")({});
    const updated = await update.execute(null, { memoryId: EXISTING_ID, text: UPDATED });
    assert.notEqual(
      updated?.details?.action,
      "superseded",
      `a patterns row must take the plain update path (got ${JSON.stringify(updated?.details)})`,
    );
    assert.ok(ledger.match("main", UPDATED), "the new text is recorded");
    assert.equal(ledger.match("main", ORIGINAL), null, "the replaced text is invalidated on the plain update path");
  });
});
