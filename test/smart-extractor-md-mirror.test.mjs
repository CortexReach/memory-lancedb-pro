/**
 * Test: SmartExtractor onPersisted callback (markdown mirror integration)
 *
 * PROBLEM: SmartExtractor.extractAndPersist() persists memories via
 * store.bulkStore()/store()/update() but never notified any external sink,
 * so the markdown mirror silently never fired for smart-extraction captures
 * (it only fired for the regex-fallback and reflection paths).
 *
 * This test drives the real SmartExtractor class (not a reimplementation)
 * through a create and a merge, and asserts the onPersisted callback fires
 * with the shape the markdown mirror writer expects.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { SmartExtractor } = jiti("../src/smart-extractor.ts");

function makeCandidate(overrides = {}) {
  return {
    category: "preferences",
    abstract: "Tea preference: oolong tea",
    overview: "## Preference\n- Likes oolong tea",
    content: "The user likes oolong tea.",
    ...overrides,
  };
}

/** In-memory store: real create/getById/update semantics, no LanceDB. */
function makeFakeStore({ vectorSearchResult = [] } = {}) {
  const rows = new Map();
  let nextId = 1;

  return {
    rows,
    async vectorSearch() {
      return vectorSearchResult;
    },
    async store(entry) {
      const stored = { ...entry, id: `row-${nextId++}`, timestamp: Date.now() };
      rows.set(stored.id, stored);
      return stored;
    },
    async bulkStore(entries) {
      return entries.map((entry) => {
        const stored = { ...entry, id: `row-${nextId++}`, timestamp: Date.now() };
        rows.set(stored.id, stored);
        return stored;
      });
    },
    async getById(id) {
      return rows.get(id) ?? null;
    },
    async update(id, updates) {
      const existing = rows.get(id);
      if (!existing) return null;
      const updated = { ...existing, ...updates };
      rows.set(id, updated);
      return updated;
    },
  };
}

function makeFakeEmbedder() {
  return {
    async embed() {
      return [1, 0, 0];
    },
  };
}

describe("SmartExtractor onPersisted callback (mdMirror integration)", () => {
  it("fires onPersisted after a create, with entry + meta shaped for mdMirror", async () => {
    const store = makeFakeStore({ vectorSearchResult: [] });
    const embedder = makeFakeEmbedder();
    const persisted = [];

    const llm = {
      async completeJson(_prompt, mode) {
        if (mode === "extract-candidates") {
          return { memories: [makeCandidate()] };
        }
        throw new Error(`unexpected mode: ${mode}`);
      },
    };

    const extractor = new SmartExtractor(store, embedder, llm, {
      user: "User",
      extractMinMessages: 1,
      extractMaxChars: 8000,
      defaultScope: "global",
      log() {},
      debugLog() {},
      onPersisted(entry, meta) {
        persisted.push({ entry, meta });
      },
    });

    const stats = await extractor.extractAndPersist(
      "The user likes oolong tea.",
      "session-create",
      { scope: "global", agentId: "agent-one" },
    );

    assert.equal(stats.created, 1);
    assert.equal(persisted.length, 1, "onPersisted should fire exactly once for the create");

    const [{ entry, meta }] = persisted;
    assert.equal(entry.text, "Tea preference: oolong tea");
    assert.equal(entry.category, "preference");
    assert.equal(entry.scope, "global");
    assert.equal(typeof entry.timestamp, "number");
    assert.equal(meta.source, "smart-extraction");
    assert.equal(meta.agentId, "agent-one");
  });

  it("fires onPersisted after a merge, mirroring the post-merge text", async () => {
    const embedder = makeFakeEmbedder();
    const persisted = [];

    // Step 1: create the memory that will later be merged into.
    const createStore = makeFakeStore({ vectorSearchResult: [] });
    const createLlm = {
      async completeJson(_prompt, mode) {
        if (mode === "extract-candidates") {
          return { memories: [makeCandidate()] };
        }
        throw new Error(`unexpected mode: ${mode}`);
      },
    };
    const createExtractor = new SmartExtractor(createStore, embedder, createLlm, {
      user: "User",
      extractMinMessages: 1,
      extractMaxChars: 8000,
      defaultScope: "global",
      log() {},
      debugLog() {},
      onPersisted(entry, meta) {
        persisted.push({ entry, meta });
      },
    });
    await createExtractor.extractAndPersist("The user likes oolong tea.", "session-1", {
      scope: "global",
      agentId: "agent-one",
    });
    assert.equal(persisted.length, 1, "sanity check: create step persisted once");

    const [existingRow] = createStore.rows.values();

    // Step 2: a similar candidate triggers a MERGE against the row created above.
    // Reuse the same store so the merge acts on a row with real smart-metadata.
    const mergeLlm = {
      async completeJson(_prompt, mode) {
        if (mode === "extract-candidates") {
          return {
            memories: [
              makeCandidate({
                abstract: "Tea preference: oolong tea, prefers it strong",
                content: "The user likes strong oolong tea.",
              }),
            ],
          };
        }
        if (mode === "dedup-decision") {
          return { decision: "merge", match_index: 1, reason: "same preference" };
        }
        if (mode === "dedup-decision-batch") {
          return { results: [{ index: 1, decision: "merge", match_index: 1, reason: "same preference" }] };
        }
        if (mode === "merge-memory" || mode === "merge-memory-batch") {
          const merged = {
            abstract: "Tea preference: oolong tea, prefers it strong",
            overview: "## Preference\n- Likes strong oolong tea",
            content: "The user likes strong oolong tea.",
          };
          return mode === "merge-memory-batch" ? { results: [{ index: 1, ...merged }] } : merged;
        }
        throw new Error(`unexpected mode: ${mode}`);
      },
    };
    const mergeExtractor = new SmartExtractor(createStore, embedder, mergeLlm, {
      user: "User",
      extractMinMessages: 1,
      extractMaxChars: 8000,
      defaultScope: "global",
      log() {},
      debugLog() {},
      onPersisted(entry, meta) {
        persisted.push({ entry, meta });
      },
    });
    // makeFakeStore's vectorSearch closed over the constructor-time value, so
    // patch it directly for this second phase of the test.
    createStore.vectorSearch = async () => [{ entry: existingRow, score: 0.95 }];

    const stats = await mergeExtractor.extractAndPersist(
      "The user likes strong oolong tea.",
      "session-2",
      { scope: "global", agentId: "agent-two" },
    );

    assert.equal(stats.merged, 1);
    assert.equal(persisted.length, 2, "onPersisted should now have fired for the create and the merge");

    const [, { entry, meta }] = persisted;
    assert.equal(entry.text, "Tea preference: oolong tea, prefers it strong");
    assert.equal(entry.category, "preference");
    assert.equal(entry.scope, "global");
    assert.equal(typeof entry.timestamp, "number");
    assert.equal(meta.source, "smart-extraction");
    assert.equal(meta.agentId, "agent-two");
  });

  it("does not invoke onPersisted when it is not configured", async () => {
    const store = makeFakeStore({ vectorSearchResult: [] });
    const embedder = makeFakeEmbedder();

    const llm = {
      async completeJson(_prompt, mode) {
        if (mode === "extract-candidates") {
          return { memories: [makeCandidate()] };
        }
        throw new Error(`unexpected mode: ${mode}`);
      },
    };

    const extractor = new SmartExtractor(store, embedder, llm, {
      user: "User",
      extractMinMessages: 1,
      extractMaxChars: 8000,
      defaultScope: "global",
      log() {},
      debugLog() {},
    });

    const stats = await extractor.extractAndPersist("The user likes oolong tea.", "session-none", {
      scope: "global",
    });

    assert.equal(stats.created, 1, "extraction still persists normally without onPersisted configured");
  });

  it("swallows onPersisted failures without failing the underlying store operation", async () => {
    const store = makeFakeStore({ vectorSearchResult: [] });
    const embedder = makeFakeEmbedder();
    const logs = [];

    const llm = {
      async completeJson(_prompt, mode) {
        if (mode === "extract-candidates") {
          return { memories: [makeCandidate()] };
        }
        throw new Error(`unexpected mode: ${mode}`);
      },
    };

    const extractor = new SmartExtractor(store, embedder, llm, {
      user: "User",
      extractMinMessages: 1,
      extractMaxChars: 8000,
      defaultScope: "global",
      log(msg) {
        logs.push(msg);
      },
      debugLog() {},
      onPersisted() {
        throw new Error("simulated mirror failure");
      },
    });

    const stats = await extractor.extractAndPersist("The user likes oolong tea.", "session-fail", {
      scope: "global",
    });

    assert.equal(stats.created, 1, "store operation succeeds even though onPersisted threw");
    assert.ok(
      logs.some((msg) => msg.includes("onPersisted callback failed")),
      "failure should be logged, not thrown",
    );
  });
});
