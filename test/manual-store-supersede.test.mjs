/**
 * Manual memory_store lane: always-store supersede semantics.
 *
 * Design ruling: a manual store ALWAYS takes priority. It skips the admission
 * judge, and dedup treats it "in a different way": when a similar memory
 * exists, the OLD row is superseded/invalidated by the manual one, and the
 * manual text is ALWAYS stored verbatim, never mutated and never dropped.
 *
 * Supersede triggers with `manualStoreSupersede: true` (deterministic, no
 * LLM on this lane):
 *   1. near-identical neighbor (similarity > 0.98) — previously a reject;
 *   2. fact-key collision with an active neighbor at any similarity — the
 *      contradiction/update shape ("favorite drink: tea" vs the fizzwick row);
 *   3. the existing 0.95-0.98 same-category versioned band (unchanged).
 * Anything else creates alongside: a wrong supersede destroys a real fact,
 * a duplicate is fixable noise, so the gray zone stays on the safe side.
 *
 * With the knob off (upstream default) the lane behaves exactly as before,
 * including the > 0.98 duplicate reject.
 *
 * Fixtures are entirely synthetic; no real fleet data.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { registerAllMemoryTools } = jiti("../src/tools.ts");
const { MemoryStore } = jiti("../src/store.ts");
const { parseSmartMetadata, isMemoryActiveAt, deriveFactKey } = jiti("../src/smart-metadata.ts");
const { classifyTemporal, inferExpiry } = jiti("../src/temporal-classifier.ts");

function createToolSet(context) {
  const creators = new Map();
  const api = {
    registerTool(factory, meta) {
      creators.set(meta.name, factory);
    },
    logger: { info() {}, warn() {}, debug() {} },
  };
  registerAllMemoryTools(api, context, { enableManagementTools: true });
  return {
    get(name) {
      const factory = creators.get(name);
      assert.ok(factory, `tool ${name} should be registered`);
      return factory({});
    },
  };
}

function neighborRow({ id = "old-1", text, category = "preference", score, factKey, memoryCategory = "preferences" }) {
  return {
    entry: {
      id,
      text,
      category,
      scope: "agent:main",
      importance: 0.7,
      timestamp: Date.now() - 60_000,
      metadata: JSON.stringify({
        memory_category: memoryCategory,
        l0_abstract: text,
        l1_overview: `- ${text}`,
        l2_content: text,
        source: "auto-capture",
        state: "confirmed",
        ...(factKey ? { fact_key: factKey } : {}),
      }),
    },
    score,
  };
}

function makeContext({ neighbors = [], rows, manualStoreSupersede, patchBehavior } = {}) {
  const storedEntries = [];
  const patchCalls = [];
  // Production-shaped store double: vectorSearch honors the caller's limit and
  // minScore exactly like the real store, and list() pages over ALL rows the
  // store holds (`rows` defaults to the vector neighbors' entries).
  const allRows = rows ?? neighbors.map((neighbor) => neighbor.entry);
  const context = {
    agentId: "main",
    workspaceDir: "/tmp",
    mdMirror: null,
    ...(manualStoreSupersede === undefined ? {} : { manualStoreSupersede }),
    scopeManager: {
      getAccessibleScopes: (agentId) => ["global", `agent:${agentId}`],
      getScopeFilter: (agentId) => ["global", `agent:${agentId}`],
      isAccessible: (scope, agentId) => ["global", `agent:${agentId}`].includes(scope),
      getDefaultScope: (agentId) => `agent:${agentId}`,
    },
    retriever: {
      getConfig() {
        return { mode: "hybrid" };
      },
    },
    store: {
      async vectorSearch(vector, limit = 5, minScore = 0.3) {
        return neighbors
          .filter((neighbor) => neighbor.score >= minScore)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);
      },
      async list(scopeFilter, category, limit = 100, offset = 0) {
        return allRows.slice(offset, offset + limit);
      },
      // Production-shaped double of MemoryStore.listFactKeyCandidates:
      // scope-only narrowing (effective keys hide in any valid JSON layout or
      // derive from the storage category column, so content patterns are
      // unsound) with the bound+1 return contract.
      async listFactKeyCandidates(scopeFilter, bound) {
        const candidates = allRows.filter((row) => {
          if (scopeFilter && scopeFilter.length > 0 && !scopeFilter.includes(row.scope)) return false;
          return true;
        });
        return candidates.slice(0, bound + 1);
      },
      async store(entry) {
        const stored = { ...entry, id: `new-${storedEntries.length + 1}`, timestamp: Date.now() };
        storedEntries.push(stored);
        return stored;
      },
      async patchMetadata(id, patch, scopeFilter) {
        patchCalls.push({ id, patch, scopeFilter });
        return null;
      },
      // Production-shaped double of MemoryStore.storeSuperseding: re-runs the
      // caller's discovery, stores the new row, applies each target patch, and
      // reports CONFIRMED invalidations only. patchBehavior lets tests model
      // null returns, throws, and partial success.
      async storeSuperseding({ entry, discoverTargets, finalizeEntryMetadata, buildTargetPatch, scopeFilter }) {
        const targets = await discoverTargets();
        const stored = { ...entry, id: `new-${storedEntries.length + 1}`, timestamp: Date.now() };
        if (finalizeEntryMetadata) {
          stored.metadata = finalizeEntryMetadata(targets);
        }
        storedEntries.push(stored);
        const supersededIds = [];
        const invalidationFailures = [];
        for (const target of targets) {
          try {
            const patch = buildTargetPatch(target, stored.id);
            patchCalls.push({ id: target.id, patch, scopeFilter });
            const outcome = patchBehavior ? await patchBehavior(target, patch) : { ...target };
            if (outcome == null) {
              invalidationFailures.push({ id: target.id, reason: "update persisted no row" });
            } else {
              supersededIds.push(target.id);
            }
          } catch (err) {
            invalidationFailures.push({ id: target.id, reason: err instanceof Error ? err.message : String(err) });
          }
        }
        return { entry: stored, supersededIds, invalidationFailures };
      },
    },
    embedder: {
      async embedPassage() {
        return [0.1, 0.2, 0.3];
      },
    },
  };
  return { context, storedEntries, patchCalls };
}

describe("manual memory_store always-store supersede semantics", () => {
  it("supersedes instead of rejecting when a near-identical memory exists (knob on)", async () => {
    const { context, storedEntries, patchCalls } = makeContext({
      manualStoreSupersede: true,
      neighbors: [neighborRow({ text: "favorite drink: Fizzwick", score: 0.99, factKey: "preferences:favorite drink" })],
    });
    const tools = createToolSet(context);
    const store = tools.get("memory_store");

    const input = "favorite drink: Fizzwick Zero";
    const res = await store.execute(null, { text: input, category: "preference" });

    assert.equal(res.details.action, "superseded", "a near-identical manual store must land as a supersede, never a reject");
    assert.equal(storedEntries.length, 1, "the manual row must always be stored");
    assert.equal(storedEntries[0].text, input, "the manual text must be stored verbatim, never mutated");
    assert.equal(patchCalls.length, 1, "the old row must be invalidated");
    assert.equal(patchCalls[0].id, "old-1");
    assert.ok(patchCalls[0].patch.invalidated_at > 0);
    assert.equal(patchCalls[0].patch.superseded_by, storedEntries[0].id ?? "new-1");
  });

  it("supersedes on a fact-key collision even at low vector similarity (contradiction shape, knob on)", async () => {
    const { context, storedEntries, patchCalls } = makeContext({
      manualStoreSupersede: true,
      neighbors: [neighborRow({ text: "favorite drink: Fizzwick", score: 0.8, factKey: "preferences:favorite drink" })],
    });
    const tools = createToolSet(context);
    const store = tools.get("memory_store");

    const input = "favorite drink: tea";
    const res = await store.execute(null, { text: input, category: "preference" });

    assert.equal(res.details.action, "superseded", "a same-fact-key update must supersede the old value");
    assert.equal(storedEntries.length, 1);
    assert.equal(storedEntries[0].text, input, "the manual text must be stored verbatim");
    assert.equal(patchCalls.length, 1);
    assert.equal(patchCalls[0].id, "old-1");
  });

  it("creates alongside when the neighbor is similar but a different fact (knob on)", async () => {
    const { context, storedEntries, patchCalls } = makeContext({
      manualStoreSupersede: true,
      neighbors: [neighborRow({ text: "favorite food: lahmacun", score: 0.85, factKey: "preferences:favorite food" })],
    });
    const tools = createToolSet(context);
    const store = tools.get("memory_store");

    const input = "favorite drink: tea";
    const res = await store.execute(null, { text: input, category: "preference" });

    assert.equal(res.details.action, "created", "a different fact must not be invalidated, however vector-close");
    assert.equal(storedEntries.length, 1);
    assert.equal(storedEntries[0].text, input);
    assert.equal(patchCalls.length, 0, "no supersede may fire for an unrelated fact");
  });

  it("force still bypasses the supersede path entirely (knob on)", async () => {
    const { context, storedEntries, patchCalls } = makeContext({
      manualStoreSupersede: true,
      neighbors: [neighborRow({ text: "favorite drink: Fizzwick", score: 0.99, factKey: "preferences:favorite drink" })],
    });
    const tools = createToolSet(context);
    const store = tools.get("memory_store");

    const res = await store.execute(null, { text: "favorite drink: Fizzwick", category: "preference", force: true });

    assert.equal(res.details.action, "created", "force stores alongside without touching the old row");
    assert.equal(storedEntries.length, 1);
    assert.equal(patchCalls.length, 0);
  });

  it("keeps the upstream duplicate reject when the knob is off (compat default)", async () => {
    const { context, storedEntries, patchCalls } = makeContext({
      neighbors: [neighborRow({ text: "favorite drink: Fizzwick", score: 0.99, factKey: "preferences:favorite drink" })],
    });
    const tools = createToolSet(context);
    const store = tools.get("memory_store");

    const res = await store.execute(null, { text: "favorite drink: Fizzwick", category: "preference" });

    assert.equal(res.details.action, "duplicate", "knob off must preserve the upstream duplicate check exactly");
    assert.equal(storedEntries.length, 0);
    assert.equal(patchCalls.length, 0);
  });

  it("supersedes a same-key row the vector top-K cannot see (ranked behind three closer unrelated neighbors)", async () => {
    const staleKeyRow = neighborRow({ id: "old-key", text: "favorite drink: Fizzwick", score: 0.5, factKey: "preferences:favorite drink" });
    const { context, storedEntries, patchCalls } = makeContext({
      manualStoreSupersede: true,
      neighbors: [
        neighborRow({ id: "near-1", text: "favorite snack: simit", score: 0.92, factKey: "preferences:favorite snack" }),
        neighborRow({ id: "near-2", text: "favorite dessert: baklava", score: 0.91, factKey: "preferences:favorite dessert" }),
        neighborRow({ id: "near-3", text: "favorite fruit: fig", score: 0.9, factKey: "preferences:favorite fruit" }),
        staleKeyRow,
      ],
    });
    const tools = createToolSet(context);
    const store = tools.get("memory_store");

    const res = await store.execute(null, { text: "favorite drink: tea", category: "preference" });

    assert.equal(res.details.action, "superseded", "the stale same-key row must be found even when it ranks fourth");
    assert.equal(patchCalls.length, 1, "only the same-key row may be invalidated");
    assert.equal(patchCalls[0].id, "old-key");
    assert.equal(storedEntries.length, 1);
  });

  it("supersedes a same-key row that falls below the vector similarity floor", async () => {
    const { context, storedEntries, patchCalls } = makeContext({
      manualStoreSupersede: true,
      neighbors: [neighborRow({ id: "old-faint", text: "favorite drink: Fizzwick", score: 0.05, factKey: "preferences:favorite drink" })],
    });
    const tools = createToolSet(context);
    const store = tools.get("memory_store");

    const res = await store.execute(null, { text: "favorite drink: tea", category: "preference" });

    assert.equal(res.details.action, "superseded", "the similarity floor must not hide a same-key collision");
    assert.equal(patchCalls.length, 1);
    assert.equal(patchCalls[0].id, "old-faint");
    assert.equal(storedEntries.length, 1);
  });

  it("supersedes EVERY active same-key row, not just the first match", async () => {
    const { context, storedEntries, patchCalls } = makeContext({
      manualStoreSupersede: true,
      neighbors: [
        neighborRow({ id: "old-a", text: "favorite drink: Fizzwick", score: 0.6, factKey: "preferences:favorite drink" }),
        neighborRow({ id: "old-b", text: "favorite drink: ayran", score: 0.55, factKey: "preferences:favorite drink" }),
      ],
    });
    const tools = createToolSet(context);
    const store = tools.get("memory_store");

    const res = await store.execute(null, { text: "favorite drink: tea", category: "preference" });

    assert.equal(res.details.action, "superseded");
    assert.deepEqual([...res.details.supersededIds].sort(), ["old-a", "old-b"], "every active same-key row must be reconciled");
    assert.equal(patchCalls.length, 2, "both stale rows must be invalidated");
    assert.deepEqual(patchCalls.map((call) => call.id).sort(), ["old-a", "old-b"]);
    assert.equal(storedEntries.length, 1, "exactly one new row carries the manual value");
  });

  it("ignores already-invalidated same-key rows (history must not be re-superseded)", async () => {
    const invalidated = neighborRow({ id: "old-history", text: "favorite drink: salep", score: 0.6, factKey: "preferences:favorite drink" });
    const meta = JSON.parse(invalidated.entry.metadata);
    meta.invalidated_at = Date.now() - 1_000;
    invalidated.entry.metadata = JSON.stringify(meta);
    const { context, storedEntries, patchCalls } = makeContext({
      manualStoreSupersede: true,
      neighbors: [invalidated],
    });
    const tools = createToolSet(context);
    const store = tools.get("memory_store");

    const res = await store.execute(null, { text: "favorite drink: tea", category: "preference" });

    assert.equal(res.details.action, "created", "a historical superseded row is not an active collision");
    assert.equal(patchCalls.length, 0);
    assert.equal(storedEntries.length, 1);
  });

  it("keeps the existing 0.95-0.98 same-category band superseding with the knob on (no regression)", async () => {
    const { context, storedEntries, patchCalls } = makeContext({
      manualStoreSupersede: true,
      neighbors: [neighborRow({ text: "favorite drink is Fizzwick for sure", score: 0.96 })],
    });
    const tools = createToolSet(context);
    const store = tools.get("memory_store");

    const input = "favorite drink: Fizzwick Zero";
    const res = await store.execute(null, { text: input, category: "preference" });

    assert.equal(res.details.action, "superseded");
    assert.equal(storedEntries.length, 1);
    assert.equal(storedEntries[0].text, input);
    assert.equal(patchCalls.length, 1);
  });

  it("reports only CONFIRMED invalidations: a null patch outcome is a failure, not a superseded id", async () => {
    const { context, storedEntries } = makeContext({
      manualStoreSupersede: true,
      neighbors: [
        neighborRow({ id: "old-a", text: "favorite drink: Fizzwick", score: 0.6, factKey: "preferences:favorite drink" }),
        neighborRow({ id: "old-b", text: "favorite drink: ayran", score: 0.55, factKey: "preferences:favorite drink" }),
      ],
      patchBehavior: async (target) => (target.id === "old-b" ? null : { ...target }),
    });
    const tools = createToolSet(context);
    const store = tools.get("memory_store");

    const res = await store.execute(null, { text: "favorite drink: tea", category: "preference" });

    assert.equal(res.details.action, "superseded");
    assert.equal(storedEntries.length, 1, "the manual row always lands");
    assert.deepEqual(res.details.supersededIds, ["old-a"], "only the confirmed invalidation may be reported");
    assert.equal(res.details.invalidationFailures.length, 1);
    assert.equal(res.details.invalidationFailures[0].id, "old-b");
    assert.match(res.details.invalidationFailures[0].reason, /persisted no row/);
    assert.match(res.content[0].text, /1 invalidation\(s\) failed/);
  });

  it("reports a thrown patch as a failure and keeps supersededId null when nothing is confirmed", async () => {
    const { context, storedEntries } = makeContext({
      manualStoreSupersede: true,
      neighbors: [neighborRow({ text: "favorite drink: Fizzwick", score: 0.99, factKey: "preferences:favorite drink" })],
      patchBehavior: async () => {
        throw new Error("synthetic patch failure");
      },
    });
    const tools = createToolSet(context);
    const store = tools.get("memory_store");

    const res = await store.execute(null, { text: "favorite drink: tea", category: "preference" });

    assert.equal(res.details.action, "superseded");
    assert.equal(storedEntries.length, 1, "the manual row always lands");
    assert.deepEqual(res.details.supersededIds, [], "an unconfirmed invalidation must not be reported as superseded");
    assert.equal(res.details.supersededId, null);
    assert.equal(res.details.invalidationFailures.length, 1);
    assert.match(res.details.invalidationFailures[0].reason, /synthetic patch failure/);
  });

  it("builds canonical metadata from the REQUESTED category and fact key, not a foreign-category near-duplicate", async () => {
    const foreignDonor = neighborRow({
      id: "foreign-1",
      text: "favorite drink: tea ceremony is my hobby",
      category: "entity",
      memoryCategory: "profile",
      score: 0.99,
      factKey: "profile:owner hobby",
    });
    const donorMeta = JSON.parse(foreignDonor.entry.metadata);
    donorMeta.tier = "core";
    foreignDonor.entry.metadata = JSON.stringify(donorMeta);
    const { context, storedEntries, patchCalls } = makeContext({
      manualStoreSupersede: true,
      neighbors: [foreignDonor],
    });
    const tools = createToolSet(context);
    const store = tools.get("memory_store");

    const input = "favorite drink: tea";
    const res = await store.execute(null, { text: input, category: "preference" });

    assert.equal(res.details.action, "superseded", "the near-identical row is still superseded");
    const meta = JSON.parse(storedEntries[0].metadata);
    assert.equal(meta.memory_category, "preferences", "the requested category is canonical");
    assert.equal(meta.fact_key, deriveFactKey("preferences", input), "the NEW fact key is canonical, never the donor's");
    assert.notEqual(meta.fact_key, "profile:owner hobby");
    assert.notEqual(meta.tier, "core", "tier must not be inherited from a foreign-category donor");
    assert.equal(meta.memory_temporal_type, classifyTemporal(input), "temporal classification must survive the supersede branch");
    assert.equal(meta.valid_until, inferExpiry(input), "temporal expiry must survive the supersede branch");
    assert.equal(patchCalls.length, 1);
    assert.equal(
      patchCalls[0].patch.fact_key,
      undefined,
      "a foreign-category target must not be backfilled with the new fact key",
    );
  });

  it("preserves the verified target's explicit fact key on the default band (knob off)", async () => {
    // The 0.95-0.98 band is the pre-existing default path. Its canonical
    // identity is the ESTABLISHED key on the verified target: deriving a
    // fresh key from the replacement's wording splits the fact's history
    // across two identities, so later fact-key updates miss the replacement.
    // Requested-key precedence belongs to the opt-in manual-priority lane.
    const target = neighborRow({
      text: "User prefers the synthetic dark theme in every editor.",
      score: 0.96,
      factKey: "preferences:theme",
    });
    const { context, storedEntries } = makeContext({
      manualStoreSupersede: false,
      neighbors: [target],
    });
    const tools = createToolSet(context);
    const store = tools.get("memory_store");

    const input = "i prefer the synthetic light mode now";
    const res = await store.execute(null, { text: input, category: "preference" });

    assert.equal(res.details.action, "superseded", "the band still supersedes with the knob off");
    const meta = JSON.parse(storedEntries[0].metadata);
    assert.equal(
      meta.fact_key,
      "preferences:theme",
      "the verified target's established key is the canonical identity on the default band",
    );
    assert.notEqual(meta.fact_key, deriveFactKey("preferences", input));
  });

  it("continues a keyless target's derived identity on the default band (knob off)", async () => {
    // A target without an explicit key still HAS an identity: the metadata
    // parser derives one from the target's own abstract. The replacement
    // inherits that, so both rows keep resolving to the same key; the
    // replacement's wording never mints the identity on the default band.
    const targetText = "User prefers the synthetic dark theme in every editor.";
    const target = neighborRow({ text: targetText, score: 0.96 });
    const { context, storedEntries } = makeContext({
      manualStoreSupersede: false,
      neighbors: [target],
    });
    const tools = createToolSet(context);
    const store = tools.get("memory_store");

    const input = "i prefer the synthetic light mode now";
    const res = await store.execute(null, { text: input, category: "preference" });

    assert.equal(res.details.action, "superseded");
    const meta = JSON.parse(storedEntries[0].metadata);
    assert.equal(
      meta.fact_key,
      deriveFactKey("preferences", targetText),
      "the keyless target's own derived identity carries over to the replacement",
    );
    assert.notEqual(meta.fact_key, deriveFactKey("preferences", input));
  });
});

describe("manual supersede commits atomically at the store layer (real store)", () => {
  function makeRealContext(dir) {
    const store = new MemoryStore({ dbPath: dir, vectorDim: 3 });
    const context = {
      agentId: "main",
      workspaceDir: "/tmp",
      mdMirror: null,
      manualStoreSupersede: true,
      scopeManager: {
        getAccessibleScopes: (agentId) => ["global", `agent:${agentId}`],
        getScopeFilter: (agentId) => ["global", `agent:${agentId}`],
        isAccessible: (scope, agentId) => ["global", `agent:${agentId}`].includes(scope),
        getDefaultScope: (agentId) => `agent:${agentId}`,
      },
      retriever: {
        getConfig() {
          return { mode: "hybrid" };
        },
      },
      store,
      embedder: {
        // Every "favorite drink" text embeds identically, so concurrent writers
        // see each other's rows as near-identical same-key neighbors.
        async embedPassage() {
          return [1, 0, 0];
        },
      },
    };
    return { context, store };
  }

  it("two concurrent same-key writers leave exactly ONE active row (locked recheck supersedes the earlier replacement)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "supersede-atomic-"));
    const { context, store } = makeRealContext(dir);
    try {
      const factKey = deriveFactKey("preferences", "favorite drink: cola");
      await store.store({
        text: "favorite drink: cola",
        vector: [1, 0, 0],
        category: "preference",
        scope: "agent:main",
        importance: 0.7,
        metadata: JSON.stringify({
          memory_category: "preferences",
          fact_key: factKey,
          source: "manual",
          state: "confirmed",
          l0_abstract: "favorite drink: cola",
        }),
      });

      // Barrier: both writers finish their ADVISORY discovery before either
      // commits, forcing the interleaving the lock must survive. Later calls
      // (the locked rechecks) pass through freely.
      const realVectorSearch = store.vectorSearch.bind(store);
      let arrivals = 0;
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      store.vectorSearch = async (...args) => {
        arrivals += 1;
        if (arrivals <= 2) {
          if (arrivals === 2) release();
          await gate;
        }
        return realVectorSearch(...args);
      };

      const tools = createToolSet(context);
      const storeTool = tools.get("memory_store");
      const [resA, resB] = await Promise.all([
        storeTool.execute(null, { text: "favorite drink: tea", category: "preference" }),
        storeTool.execute(null, { text: "favorite drink: coffee", category: "preference" }),
      ]);
      store.vectorSearch = realVectorSearch;

      assert.equal(resA.details.action, "superseded");
      assert.equal(resB.details.action, "superseded");

      const rows = await store.list(undefined, undefined, 100, 0);
      const now = Date.now();
      const activeSameKey = rows.filter((row) => {
        const meta = parseSmartMetadata(row.metadata, row);
        const key = meta.fact_key ?? deriveFactKey(meta.memory_category, row.text);
        return key === factKey && isMemoryActiveAt(meta, now);
      });
      assert.equal(
        activeSameKey.length,
        1,
        `exactly one active row may hold the fact key after concurrent writers (got: ${activeSameKey.map((row) => row.text).join(" | ")})`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("two concurrent FIRST writers of a fact key leave exactly ONE active row (empty advisory still enters the locked path)", async () => {
    // The reviewer-probed gap: with NO pre-existing row, both writers'
    // unlocked advisory discovery comes back empty, and a path that only
    // enters the locked operation on a non-empty advisory lets both fall
    // through to plain store(), leaving two active rows for one fact key.
    // The locked rediscovery is authoritative: the first writer creates, the
    // second must see that row under the lock and supersede it.
    const dir = mkdtempSync(join(tmpdir(), "supersede-firstwrite-"));
    const { context, store } = makeRealContext(dir);
    try {
      const factKey = deriveFactKey("preferences", "favorite drink: tea");

      // Barrier: both writers finish their ADVISORY discovery before either
      // commits. Later calls (the locked rechecks) pass through freely.
      const realVectorSearch = store.vectorSearch.bind(store);
      let arrivals = 0;
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      store.vectorSearch = async (...args) => {
        arrivals += 1;
        if (arrivals <= 2) {
          if (arrivals === 2) release();
          await gate;
        }
        return realVectorSearch(...args);
      };

      const tools = createToolSet(context);
      const storeTool = tools.get("memory_store");
      const [resA, resB] = await Promise.all([
        storeTool.execute(null, { text: "favorite drink: tea", category: "preference" }),
        storeTool.execute(null, { text: "favorite drink: coffee", category: "preference" }),
      ]);
      store.vectorSearch = realVectorSearch;

      const actions = [resA.details.action, resB.details.action].sort();
      assert.deepEqual(
        actions,
        ["created", "superseded"],
        "one writer creates, the other's locked recheck must supersede that row",
      );

      const rows = await store.list(undefined, undefined, 100, 0);
      const now = Date.now();
      const activeSameKey = rows.filter((row) => {
        const meta = parseSmartMetadata(row.metadata, row);
        const key = meta.fact_key ?? deriveFactKey(meta.memory_category, row.text);
        return key === factKey && isMemoryActiveAt(meta, now);
      });
      assert.equal(
        activeSameKey.length,
        1,
        `exactly one active row may hold the fact key after concurrent first writers (got: ${activeSameKey.map((row) => row.text).join(" | ")})`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a second store instance with a stale read snapshot still supersedes the first instance's replacement (nonzero readConsistencyInterval)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "supersede-xinst-"));
    const makeInstance = () => {
      const store = new MemoryStore({ dbPath: dir, vectorDim: 3, readConsistencyInterval: 30 });
      const context = {
        agentId: "main",
        workspaceDir: "/tmp",
        mdMirror: null,
        manualStoreSupersede: true,
        scopeManager: {
          getAccessibleScopes: (agentId) => ["global", `agent:${agentId}`],
          getScopeFilter: (agentId) => ["global", `agent:${agentId}`],
          isAccessible: (scope, agentId) => ["global", `agent:${agentId}`].includes(scope),
          getDefaultScope: (agentId) => `agent:${agentId}`,
        },
        retriever: {
          getConfig() {
            return { mode: "hybrid" };
          },
        },
        store,
        embedder: {
          async embedPassage() {
            return [1, 0, 0];
          },
        },
      };
      return { context, store };
    };
    const first = makeInstance();
    const second = makeInstance();
    try {
      const factKey = deriveFactKey("preferences", "favorite drink: cola");
      await first.store.store({
        text: "favorite drink: cola",
        vector: [1, 0, 0],
        category: "preference",
        scope: "agent:main",
        importance: 0.7,
        metadata: JSON.stringify({
          memory_category: "preferences",
          fact_key: factKey,
          source: "manual",
          state: "confirmed",
          l0_abstract: "favorite drink: cola",
        }),
      });

      // Arm the second instance's table snapshot BEFORE the first writer's
      // supersede commits: with a 30s consistency interval this handle keeps
      // serving that snapshot, so its locked recheck reads stale unless the
      // store re-syncs the handle under the lock.
      await second.store.list(undefined, undefined, 10, 0);

      const toolA = createToolSet(first.context).get("memory_store");
      const toolB = createToolSet(second.context).get("memory_store");

      const resA = await toolA.execute(null, { text: "favorite drink: tea", category: "preference" });
      assert.equal(resA.details.action, "superseded");

      const resB = await toolB.execute(null, { text: "favorite drink: coffee", category: "preference" });
      assert.equal(resB.details.action, "superseded");

      const verifyStore = new MemoryStore({ dbPath: dir, vectorDim: 3 });
      const rows = await verifyStore.list(undefined, undefined, 100, 0);
      const now = Date.now();
      const activeSameKey = rows.filter((row) => {
        const meta = parseSmartMetadata(row.metadata, row);
        const key = meta.fact_key ?? deriveFactKey(meta.memory_category, row.text);
        return key === factKey && isMemoryActiveAt(meta, now);
      });
      assert.equal(
        activeSameKey.length,
        1,
        `the serialized writers must converge on one active row even across stale instance snapshots (got: ${activeSameKey.map((row) => row.text).join(" | ")})`,
      );
      assert.equal(activeSameKey[0].text, "favorite drink: coffee", "the last writer's replacement must be the surviving active row");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("supersedes a legacy empty-metadata row whose key derives from the storage category column (end to end)", async () => {
    // A row with category="preference" and metadata="{}" carries no fact_key
    // and no memory_category field, yet parseSmartMetadata derives its
    // effective key from the legacy storage column plus the row text. A
    // candidate query narrowed on metadata patterns alone never returns it,
    // so the manual write reports "created" and both values stay active.
    const dir = mkdtempSync(join(tmpdir(), "supersede-legacyrow-"));
    const { context, store } = makeRealContext(dir);
    try {
      await store.store({
        text: "favorite drink: cola",
        // Orthogonal to the embedder's constant [1, 0, 0]: the legacy row is
        // invisible to the vector advisory, only the key scan can find it.
        vector: [0, 1, 0],
        category: "preference",
        scope: "agent:main",
        importance: 0.7,
        metadata: "{}",
      });

      const storeTool = createToolSet(context).get("memory_store");
      const result = await storeTool.execute(null, { text: "favorite drink: tea", category: "preference" });
      assert.equal(result.details.action, "superseded");

      const rows = await store.list(undefined, undefined, 100, 0);
      const now = Date.now();
      const factKey = deriveFactKey("preferences", "favorite drink: cola");
      const activeSameKey = rows.filter((row) => {
        const meta = parseSmartMetadata(row.metadata, row);
        const key = meta.fact_key ?? deriveFactKey(meta.memory_category, row.text);
        return key === factKey && isMemoryActiveAt(meta, now);
      });
      assert.equal(
        activeSameKey.length,
        1,
        `exactly one active row may hold the derived key after the manual write (got: ${activeSameKey.map((row) => row.text).join(" | ")})`,
      );
      assert.equal(activeSameKey[0].text, "favorite drink: tea", "the manual write must be the surviving active row");

      const legacyRow = rows.find((row) => row.text === "favorite drink: cola");
      const legacyMeta = parseSmartMetadata(legacyRow.metadata, legacyRow);
      assert.ok(legacyMeta.invalidated_at, "the legacy row must carry an invalidation timestamp");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("supersedes a whitespace-formatted explicit-key row stored under an unrelated storage category (end to end)", async () => {
    // JSON.parse accepts arbitrary layout: '{"fact_key" : "..."}' resolves to
    // the same normalized key but contains neither the compact '"fact_key":'
    // substring nor a same-category stamp, and under storage category "fact"
    // it dodges legacy-category widening too. Any narrowing built on raw
    // serialization layout excludes it from collision discovery, so the
    // manual write reports "created" and both query-equivalent values stay
    // active.
    const dir = mkdtempSync(join(tmpdir(), "supersede-spacedmeta-"));
    const { context, store } = makeRealContext(dir);
    try {
      await store.store({
        text: "favorite drink: cola",
        // Orthogonal to the embedder's constant [1, 0, 0]: invisible to the
        // vector advisory, only the key scan can find it.
        vector: [0, 1, 0],
        category: "fact",
        scope: "agent:main",
        importance: 0.7,
        metadata:
          '{"fact_key" : "Preferences:Favorite Drink", "memory_category" : "preferences", "l0_abstract" : "favorite drink: cola"}',
      });

      const storeTool = createToolSet(context).get("memory_store");
      const result = await storeTool.execute(null, { text: "favorite drink: tea", category: "preference" });
      assert.equal(result.details.action, "superseded");

      const rows = await store.list(undefined, undefined, 100, 0);
      const now = Date.now();
      const activeSameKey = rows.filter((row) => {
        const meta = parseSmartMetadata(row.metadata, row);
        const key = (meta.fact_key ?? deriveFactKey(meta.memory_category, row.text) ?? "").trim().toLowerCase();
        return key === "preferences:favorite drink" && isMemoryActiveAt(meta, now);
      });
      assert.equal(
        activeSameKey.length,
        1,
        `exactly one active row may hold the normalized key after the manual write (got: ${activeSameKey.map((row) => row.text).join(" | ")})`,
      );
      assert.equal(activeSameKey[0].text, "favorite drink: tea", "the manual write must be the surviving active row");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fact-key collision scan cost and normalization", () => {
  const fillerMetadata = JSON.stringify({
    memory_category: "preferences",
    fact_key: "preferences:unrelated filler",
    l0_abstract: "filler row",
    source: "auto-capture",
    state: "confirmed",
  });

  function fillerRows(count) {
    const rows = [];
    for (let i = 0; i < count; i += 1) {
      rows.push({
        id: `filler-${i}`,
        text: `filler row ${i}`,
        category: "preference",
        scope: "agent:main",
        importance: 0.5,
        timestamp: Date.now() - 120_000,
        metadata: fillerMetadata,
      });
    }
    return rows;
  }

  it("collision discovery issues one bounded candidate query per pass and never touches list()", async () => {
    const collision = neighborRow({
      id: "old-key",
      text: "favorite drink: Fizzwick",
      score: 0.5,
      factKey: "preferences:favorite drink",
    }).entry;
    const { context, storedEntries, patchCalls } = makeContext({
      manualStoreSupersede: true,
      neighbors: [],
      rows: [...fillerRows(1200), collision],
    });
    let listCalls = 0;
    let scanCalls = 0;
    const originalList = context.store.list.bind(context.store);
    context.store.list = async (...args) => {
      listCalls += 1;
      return originalList(...args);
    };
    const originalScan = context.store.listFactKeyCandidates.bind(context.store);
    context.store.listFactKeyCandidates = async (...args) => {
      scanCalls += 1;
      return originalScan(...args);
    };
    const tools = createToolSet(context);
    const store = tools.get("memory_store");

    const res = await store.execute(null, { text: "favorite drink: tea", category: "preference" });

    assert.equal(res.details.action, "superseded", "the collision must still be found");
    assert.equal(storedEntries.length, 1);
    assert.equal(patchCalls.length, 1);
    assert.equal(patchCalls[0].id, "old-key");
    assert.equal(
      scanCalls,
      2,
      `discovery must run ONE bounded candidate query per pass (advisory + locked recheck); got ${scanCalls}`,
    );
    assert.equal(listCalls, 0, "the collision scan must never fall back to the full-scope list()");
  });

  it("supersedes a mixed-case explicit fact key that is query-equivalent to the derived key", async () => {
    const legacyRow = neighborRow({
      id: "old-mixed-case",
      text: "favorite drink: Fizzwick",
      score: 0.5,
      factKey: "Preferences:Favorite Drink",
    }).entry;
    const { context, storedEntries, patchCalls } = makeContext({
      manualStoreSupersede: true,
      neighbors: [],
      rows: [legacyRow],
    });
    const tools = createToolSet(context);
    const store = tools.get("memory_store");

    const input = "favorite drink: tea";
    const res = await store.execute(null, { text: input, category: "preference" });

    assert.equal(
      res.details.action,
      "superseded",
      "a mixed-case explicit key must not evade supersession by its query-equivalent lowercase form",
    );
    assert.equal(storedEntries.length, 1);
    assert.equal(storedEntries[0].text, input);
    assert.equal(patchCalls.length, 1);
    assert.equal(patchCalls[0].id, "old-mixed-case");
  });

  it("rejects the opted-in write explicitly when the candidate set exceeds the scan bound", async () => {
    const { context, storedEntries, patchCalls } = makeContext({
      manualStoreSupersede: true,
      neighbors: [],
      rows: fillerRows(20_001),
    });
    const tools = createToolSet(context);
    const store = tools.get("memory_store");

    const res = await store.execute(null, { text: "favorite drink: tea", category: "preference" });

    assert.equal(
      res.details.action,
      "rejected",
      "an over-bound scan must reject the write, never silently store alongside an unfound old value",
    );
    assert.equal(res.details.reason, "fact-key-scan-over-bound");
    assert.match(res.content[0].text, /force/i, "the rejection must name the force escape hatch");
    assert.equal(storedEntries.length, 0, "nothing may be written on a rejected supersede");
    assert.equal(patchCalls.length, 0);
  });

  it("force: true bypasses the collision scan and stores verbatim on an over-bound scope", async () => {
    const { context, storedEntries, patchCalls } = makeContext({
      manualStoreSupersede: true,
      neighbors: [],
      rows: fillerRows(20_001),
    });
    const tools = createToolSet(context);
    const store = tools.get("memory_store");

    const input = "favorite drink: tea";
    const res = await store.execute(null, { text: input, category: "preference", force: true });

    assert.equal(res.details.action, "created", "force stores without entering the supersede path");
    assert.equal(storedEntries.length, 1, "force must always store");
    assert.equal(storedEntries[0].text, input, "the manual text must be stored verbatim");
    assert.equal(patchCalls.length, 0, "force never supersedes");
  });

  it("real store: listFactKeyCandidates narrows database-side and honors its bound", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lancedb-factkey-scan-"));
    try {
      const realStore = new MemoryStore({ dbPath: dir, vectorDim: 3 });
      const seed = async (id, category, scope, metadata, text) =>
        realStore.store({
          text,
          vector: [0.1, 0.2, 0.3],
          importance: 0.5,
          category,
          scope,
          metadata: JSON.stringify(metadata),
        });
      await seed("a", "preference", "agent:main", { memory_category: "preferences", fact_key: "Preferences:Favorite Drink" }, "favorite drink: cola");
      await seed("b", "preference", "agent:main", { memory_category: "preferences" }, "favorite drink: tea");
      await seed("c", "fact", "agent:main", { memory_category: "events" }, "went to the market");
      await seed("d", "preference", "agent:other", { memory_category: "preferences", fact_key: "preferences:favorite drink" }, "favorite drink: soda");
      await seed("e", "preference", "agent:main", {}, "favorite drink: juice");
      await seed("f", "fact", "agent:main", {}, "favorite drink: fanta");

      const candidates = await realStore.listFactKeyCandidates(["agent:main"], 10);
      const texts = candidates.map((row) => row.text).sort();
      assert.deepEqual(
        texts,
        [
          "favorite drink: cola",
          "favorite drink: fanta",
          "favorite drink: juice",
          "favorite drink: tea",
          "went to the market",
        ],
        "candidates are every in-scope row regardless of metadata layout or category; other scopes stay out",
      );

      const bounded = await realStore.listFactKeyCandidates(["agent:main"], 1);
      assert.equal(bounded.length, 2, "an over-bound candidate set returns exactly bound + 1 rows for detection");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
