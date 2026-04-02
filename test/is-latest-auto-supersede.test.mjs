/**
 * Test: auto-supersede on memory_store for similar-but-different memories.
 *
 * Tests the real registerMemoryStoreTool handler (not a reimplementation).
 * Uses mock store/embedder to control vectorSearch similarity scores.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Module from "node:module";

import jitiFactory from "jiti";

process.env.NODE_PATH = [
  process.env.NODE_PATH,
  "/opt/homebrew/lib/node_modules/openclaw/node_modules",
  "/opt/homebrew/lib/node_modules",
].filter(Boolean).join(":");
Module._initPaths();

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { registerMemoryStoreTool } = jiti("../src/tools.ts");
const {
  buildSmartMetadata,
  isMemoryActiveAt,
  parseSmartMetadata,
  stringifySmartMetadata,
} = jiti("../src/smart-metadata.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Capture the tool creator from registerMemoryStoreTool. */
function makeApiCapture() {
  let capturedCreator = null;
  const api = {
    registerTool(cb) { capturedCreator = cb; },
    logger: { info() {}, warn() {}, debug() {} },
  };
  return { api, getCreator: () => capturedCreator };
}

function createTool(registerFn, context) {
  const { api, getCreator } = makeApiCapture();
  registerFn(api, context);
  const creator = getCreator();
  assert.ok(typeof creator === "function", "registerTool should capture a creator");
  return creator({});
}

/**
 * Build a mock store that lets tests control vectorSearch results.
 * Entries are stored in-memory; patchMetadata updates them in place.
 */
function makeMockStore() {
  const entries = new Map();
  let nextSearchResults = [];

  return {
    _entries: entries,
    /** Pre-populate an entry (for seeding the "old" memory). */
    seed(entry) { entries.set(entry.id, entry); },
    /** Set what the next vectorSearch call will return. */
    setNextSearchResults(results) { nextSearchResults = results; },

    async store(entry) {
      const id = randomUUID();
      const full = { ...entry, id, timestamp: Date.now() };
      entries.set(id, full);
      return full;
    },
    async vectorSearch(_vector, _limit, _minScore, _scopeFilter, _options) {
      return nextSearchResults;
    },
    async patchMetadata(id, patch, _scopeFilter) {
      const entry = entries.get(id);
      if (!entry) return;
      const meta = parseSmartMetadata(entry.metadata, entry);
      const patched = buildSmartMetadata(entry, patch);
      entry.metadata = stringifySmartMetadata(patched);
    },
    hasFtsSupport: false,
  };
}

function makeOldEntry(id, text, category) {
  return {
    id,
    text,
    vector: [1, 0, 0, 0, 0, 0, 0, 0],
    category,
    scope: "global",
    importance: 0.7,
    timestamp: Date.now() - 60_000,
    metadata: stringifySmartMetadata(
      buildSmartMetadata(
        { text, category, importance: 0.7 },
        {
          l0_abstract: text,
          l1_overview: `- ${text}`,
          l2_content: text,
          source: "manual",
          state: "confirmed",
          memory_layer: "durable",
        },
      ),
    ),
  };
}

function makeContext(mockStore) {
  return {
    store: mockStore,
    embedder: { embedPassage: async () => [1, 0, 0, 0, 0, 0, 0, 0] },
    scopeManager: {
      getAccessibleScopes: () => ["global"],
      isAccessible: () => true,
      getDefaultScope: () => "global",
    },
    agentId: "test-agent",
    workspaceDir: "/tmp",
    mdMirror: null,
    workspaceBoundary: {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runTests() {
  // Test 1: similar preference memories trigger auto-supersede
  {
    console.log("Test 1: similar preference memories trigger auto-supersede...");
    const store = makeMockStore();
    const oldId = "old-pref-1";
    const oldEntry = makeOldEntry(oldId, "I like Python", "preference");
    store.seed(oldEntry);
    store.setNextSearchResults([{ entry: oldEntry, score: 0.96 }]);

    const tool = createTool(registerMemoryStoreTool, makeContext(store));
    const res = await tool.execute(null, { text: "I like Rust", category: "preference" });

    assert.equal(res.details.action, "superseded", "should auto-supersede");
    assert.equal(res.details.supersededId, oldId);
    assert.ok(res.details.similarity > 0.95);
    console.log("  ✅ auto-supersede triggered for similar preference");
  }

  // Test 2: old memory metadata has invalidated_at and superseded_by
  {
    console.log("Test 2: old memory metadata has invalidated_at and superseded_by...");
    const store = makeMockStore();
    const oldId = "old-pref-2";
    const oldEntry = makeOldEntry(oldId, "I like tea", "preference");
    store.seed(oldEntry);
    store.setNextSearchResults([{ entry: oldEntry, score: 0.96 }]);

    const tool = createTool(registerMemoryStoreTool, makeContext(store));
    const res = await tool.execute(null, { text: "I like coffee", category: "preference" });

    const updatedOld = store._entries.get(oldId);
    const oldMeta = parseSmartMetadata(updatedOld.metadata, updatedOld);
    assert.ok(oldMeta.invalidated_at, "old memory should have invalidated_at");
    assert.equal(oldMeta.superseded_by, res.details.id, "old memory should point to new");
    console.log("  ✅ old memory metadata updated");
  }

  // Test 3: new memory metadata has supersedes field
  {
    console.log("Test 3: new memory metadata has supersedes field...");
    const store = makeMockStore();
    const oldId = "old-pref-3";
    const oldEntry = makeOldEntry(oldId, "My favorite color is blue", "preference");
    store.seed(oldEntry);
    store.setNextSearchResults([{ entry: oldEntry, score: 0.96 }]);

    const tool = createTool(registerMemoryStoreTool, makeContext(store));
    const res = await tool.execute(null, { text: "My favorite color is green", category: "preference" });

    const newEntry = store._entries.get(res.details.id);
    const newMeta = parseSmartMetadata(newEntry.metadata, newEntry);
    assert.equal(newMeta.supersedes, oldId, "new memory should link to old");
    console.log("  ✅ new memory has supersedes link");
  }

  // Test 4: new memory preserves canonical fields from old entry
  {
    console.log("Test 4: new memory preserves canonical fields from old entry...");
    const store = makeMockStore();
    const oldId = "old-pref-4";
    const oldEntry = makeOldEntry(oldId, "I prefer dark mode", "preference");
    // Patch old entry with specific canonical fields
    const oldMeta = parseSmartMetadata(oldEntry.metadata, oldEntry);
    oldMeta.memory_category = "preferences";
    oldMeta.tier = "core";
    oldMeta.l1_overview = "## Preferences\n- Dark mode preferred";
    oldEntry.metadata = stringifySmartMetadata(oldMeta);
    store.seed(oldEntry);
    store.setNextSearchResults([{ entry: oldEntry, score: 0.96 }]);

    const tool = createTool(registerMemoryStoreTool, makeContext(store));
    const res = await tool.execute(null, { text: "I prefer light mode", category: "preference" });

    const newEntry = store._entries.get(res.details.id);
    const newMeta = parseSmartMetadata(newEntry.metadata, newEntry);
    assert.equal(newMeta.memory_category, "preferences", "should preserve memory_category");
    assert.equal(newMeta.tier, "core", "should preserve tier");
    assert.equal(newMeta.l1_overview, "## Preferences\n- Dark mode preferred", "should preserve l1_overview");
    console.log("  ✅ canonical fields preserved from old entry");
  }

  // Test 5: decision category is NOT auto-superseded
  {
    console.log("Test 5: decision category is NOT auto-superseded...");
    const store = makeMockStore();
    const oldId = "old-dec-1";
    const oldEntry = makeOldEntry(oldId, "Decided to use React", "decision");
    store.seed(oldEntry);
    store.setNextSearchResults([{ entry: oldEntry, score: 0.96 }]);

    const tool = createTool(registerMemoryStoreTool, makeContext(store));
    const res = await tool.execute(null, { text: "Decided to use Vue", category: "decision" });

    assert.equal(res.details.action, "created", "decisions should not be superseded");
    console.log("  ✅ decisions are not auto-superseded");
  }

  // Test 6: reflection category is NOT auto-superseded
  {
    console.log("Test 6: reflection category is NOT auto-superseded...");
    const store = makeMockStore();
    const oldId = "old-ref-1";
    const oldEntry = makeOldEntry(oldId, "Team meeting went well", "reflection");
    store.seed(oldEntry);
    store.setNextSearchResults([{ entry: oldEntry, score: 0.96 }]);

    const tool = createTool(registerMemoryStoreTool, makeContext(store));
    const res = await tool.execute(null, { text: "Team meeting was productive", category: "reflection" });

    assert.equal(res.details.action, "created", "reflections should not be superseded");
    console.log("  ✅ reflections are not auto-superseded");
  }

  // Test 7: entity category IS eligible for auto-supersede
  {
    console.log("Test 7: entity category is eligible for auto-supersede...");
    const store = makeMockStore();
    const oldId = "old-ent-1";
    const oldEntry = makeOldEntry(oldId, "Alice works at Google", "entity");
    store.seed(oldEntry);
    store.setNextSearchResults([{ entry: oldEntry, score: 0.96 }]);

    const tool = createTool(registerMemoryStoreTool, makeContext(store));
    const res = await tool.execute(null, { text: "Alice works at Microsoft", category: "entity" });

    assert.equal(res.details.action, "superseded", "entities should be superseded");
    assert.equal(res.details.supersededId, oldId);
    console.log("  ✅ entities are eligible for auto-supersede");
  }

  // Test 8: different categories do not trigger cross-category supersede
  {
    console.log("Test 8: different categories do not trigger cross-category supersede...");
    const store = makeMockStore();
    const oldId = "old-pref-cross";
    const oldEntry = makeOldEntry(oldId, "I enjoy hiking", "preference");
    store.seed(oldEntry);
    store.setNextSearchResults([{ entry: oldEntry, score: 0.96 }]);

    const tool = createTool(registerMemoryStoreTool, makeContext(store));
    // Store as "entity" not "preference" → different category
    const res = await tool.execute(null, { text: "I enjoy hiking", category: "entity" });

    assert.equal(res.details.action, "created", "cross-category should not supersede");
    console.log("  ✅ cross-category similarities do not trigger supersede");
  }

  // Test 9: fact category is NOT eligible (aligns with TEMPORAL_VERSIONED only)
  {
    console.log("Test 9: fact category is NOT eligible for auto-supersede...");
    const store = makeMockStore();
    const oldId = "old-fact-1";
    const oldEntry = makeOldEntry(oldId, "The API endpoint is /v1/users", "fact");
    store.seed(oldEntry);
    store.setNextSearchResults([{ entry: oldEntry, score: 0.96 }]);

    const tool = createTool(registerMemoryStoreTool, makeContext(store));
    const res = await tool.execute(null, { text: "The API endpoint is /v2/users", category: "fact" });

    assert.equal(res.details.action, "created", "facts should not be auto-superseded");
    console.log("  ✅ facts are not auto-superseded (only preference/entity)");
  }

  console.log("\n✅ All is-latest auto-supersede tests passed!");
}

runTests().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
