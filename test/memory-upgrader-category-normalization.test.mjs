import assert from "node:assert/strict";
import Module from "node:module";
import { describe, it } from "node:test";
import jitiFactory from "jiti";

process.env.NODE_PATH = [
  process.env.NODE_PATH,
  "/opt/homebrew/lib/node_modules/openclaw/node_modules",
  "/opt/homebrew/lib/node_modules",
].filter(Boolean).join(":");
Module._initPaths();

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { createMemoryUpgrader } = jiti("../src/memory-upgrader.ts");

function mappedRow(id, mappedKind, overrides = {}) {
  return {
    id,
    text: `${mappedKind} row ${id}`,
    category: mappedKind === "decision" ? "decision" : mappedKind === "lesson" ? "fact" : "preference",
    scope: "global",
    importance: 0.8,
    timestamp: Date.now(),
    metadata: JSON.stringify({
      type: "memory-reflection-mapped",
      reflectionVersion: 4,
      mappedKind,
      mappedCategory: mappedKind === "decision" ? "decision" : mappedKind === "lesson" ? "fact" : "preference",
      ...overrides,
    }),
  };
}

function makeStore(rows) {
  const updates = [];
  return {
    rows,
    updates,
    async list() {
      return rows;
    },
    async update(id, patch) {
      updates.push({ id, patch });
      const row = rows.find((r) => r.id === id);
      if (row) row.metadata = patch.metadata ?? row.metadata;
      return true;
    },
  };
}

describe("memory-pro upgrade: mapped-row category normalization", () => {
  it("dry-run reports counts without writing anything", async () => {
    const store = makeStore([
      mappedRow("decision-legacy", "decision"), // no memory_category stamped
      mappedRow("preferences-ok", "user-model", { memory_category: "preferences" }), // already correct
    ]);
    const upgrader = createMemoryUpgrader(store, null, { log: () => {} });

    const result = await upgrader.normalizeMappedRowCategories({ dryRun: true });

    assert.equal(result.totalMapped, 2);
    assert.equal(result.normalized, 1);
    assert.equal(result.alreadyCorrect, 1);
    assert.equal(store.updates.length, 0);
  });

  it("re-stamps exactly the mapped rows whose memory_category is missing or wrong, using E1's mapping", async () => {
    const store = makeStore([
      mappedRow("decision-legacy", "decision"),
      mappedRow("lesson-legacy", "lesson"),
      mappedRow("user-model-legacy", "user-model"),
      mappedRow("agent-model-legacy", "agent-model"),
      mappedRow("preferences-ok", "user-model", { memory_category: "preferences" }),
      mappedRow("corrupted", "decision", { memory_category: "events" }), // wrong value
    ]);
    const upgrader = createMemoryUpgrader(store, null, { log: () => {} });

    const result = await upgrader.normalizeMappedRowCategories();

    assert.equal(result.totalMapped, 6);
    assert.equal(result.normalized, 5);
    assert.equal(result.alreadyCorrect, 1);
    assert.equal(result.errors.length, 0);

    const byId = Object.fromEntries(store.rows.map((r) => [r.id, JSON.parse(r.metadata)]));
    assert.equal(byId["decision-legacy"].memory_category, "cases");
    assert.equal(byId["lesson-legacy"].memory_category, "cases");
    assert.equal(byId["user-model-legacy"].memory_category, "preferences");
    assert.equal(byId["agent-model-legacy"].memory_category, "patterns");
    assert.equal(byId["corrupted"].memory_category, "cases");

    // Every other field on the corrected row survives untouched.
    assert.equal(byId["decision-legacy"].mappedKind, "decision");
    assert.equal(byId["decision-legacy"].type, "memory-reflection-mapped");
  });

  it("touches nothing else — non-mapped rows are never scanned into the result", async () => {
    const legacyRow = {
      id: "legacy-plain",
      text: "Plain legacy memory with no smart metadata",
      category: "fact",
      scope: "global",
      importance: 0.7,
      timestamp: Date.now(),
      metadata: "{}",
    };
    const smartExtractorRow = {
      id: "smart-events",
      text: "Attended the release conference",
      category: "decision",
      scope: "global",
      importance: 0.7,
      timestamp: Date.now(),
      metadata: JSON.stringify({ memory_category: "events", type: "smart" }),
    };
    const store = makeStore([
      legacyRow,
      smartExtractorRow,
      mappedRow("decision-legacy", "decision"),
    ]);
    const upgrader = createMemoryUpgrader(store, null, { log: () => {} });

    const result = await upgrader.normalizeMappedRowCategories();

    assert.equal(result.totalMapped, 1);
    assert.equal(result.normalized, 1);
    assert.equal(store.updates.length, 1);
    assert.equal(store.updates[0].id, "decision-legacy");
    // Untouched rows keep their original metadata verbatim.
    assert.equal(legacyRow.metadata, "{}");
    assert.equal(JSON.parse(smartExtractorRow.metadata).memory_category, "events");
  });

  it("is idempotent — a second run is a no-op", async () => {
    const store = makeStore([
      mappedRow("decision-legacy", "decision"),
      mappedRow("lesson-legacy", "lesson"),
    ]);
    const upgrader = createMemoryUpgrader(store, null, { log: () => {} });

    const first = await upgrader.normalizeMappedRowCategories();
    assert.equal(first.normalized, 2);

    const second = await upgrader.normalizeMappedRowCategories();
    assert.equal(second.normalized, 0);
    assert.equal(second.alreadyCorrect, 2);
    assert.equal(store.updates.length, 2, "no additional writes on the second, idempotent run");
  });

  it("scopes to scopeFilter like the rest of the upgrader", async () => {
    const store = makeStore([
      mappedRow("in-scope", "decision", { }),
      mappedRow("out-of-scope", "decision", { }),
    ]);
    store.rows[1].scope = "other-scope";
    const upgrader = createMemoryUpgrader(store, null, { log: () => {} });

    let capturedScope;
    const originalList = store.list.bind(store);
    store.list = async (scopeFilter) => {
      capturedScope = scopeFilter;
      return originalList();
    };

    await upgrader.normalizeMappedRowCategories({ scopeFilter: ["global"] });
    assert.deepEqual(capturedScope, ["global"]);
  });
});
