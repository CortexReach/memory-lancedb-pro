import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");
const { isOwnedByAgent } = jiti("../src/reflection-store.ts");
const { parseAgentIdFromSessionKey } = jiti("../src/scopes.ts");

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "scope-owner-leak-"));
  const store = new MemoryStore({ dbPath: dir, vectorDim: 3 });
  return { store, dir };
}

describe("(a) MemoryStore.list() no longer passes NULL-scope rows through a scope filter", () => {
  it("excludes a NULL-scope legacy row when a real scope filter is given", async () => {
    const { store, dir } = makeStore();
    try {
      // upsert() writes the row as-is (unlike store()/bulkStore(), it does not
      // normalize a missing scope to "global"), so it can simulate a genuine
      // pre-scoping legacy row with no scope at all.
      await store.upsert({
        id: "legacy-null-scope",
        timestamp: Date.now(),
        text: "legacy row with no scope",
        vector: [0.1, 0.2, 0.3],
        category: "fact",
        scope: null,
        importance: 0.5,
        metadata: "{}",
      });
      await store.store({
        text: "agent-a scoped row",
        vector: [0.4, 0.5, 0.6],
        category: "fact",
        scope: "agent-a",
        importance: 0.5,
        metadata: "{}",
      });

      const results = await store.list(["agent-a"], undefined, 20, 0);

      assert.equal(results.length, 1, "only the agent-a scoped row should be visible");
      assert.equal(results[0].text, "agent-a scoped row");
      assert.ok(
        !results.some((r) => r.id === "legacy-null-scope"),
        "the NULL-scope legacy row must not leak into an agent-a scoped read",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still returns rows correctly scoped to the requested scope (regression)", async () => {
    const { store, dir } = makeStore();
    try {
      await store.store({
        text: "agent-b scoped row",
        vector: [0.7, 0.8, 0.9],
        category: "fact",
        scope: "agent-b",
        importance: 0.5,
        metadata: "{}",
      });

      const results = await store.list(["agent-b"], undefined, 20, 0);
      assert.equal(results.length, 1);
      assert.equal(results[0].text, "agent-b scoped row");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("(a2) sibling read paths no longer pass NULL-scope rows through a scope filter", () => {
  async function seedNullScopeAndScopedRow(store) {
    // Same simulation technique as (a): upsert() writes the row as-is, so a
    // NULL scope genuinely reaches the table (store()/bulkStore() would
    // normalize a missing scope to "global" before it ever gets there).
    await store.upsert({
      id: "legacy-null-scope",
      timestamp: Date.now(),
      text: "legacy row with no scope talking about rockets",
      vector: [0.1, 0.2, 0.3],
      category: "fact",
      scope: null,
      importance: 0.5,
      metadata: "{}",
    });
    await store.store({
      text: "agent-a scoped row talking about rockets",
      vector: [0.4, 0.5, 0.6],
      category: "fact",
      scope: "agent-a",
      importance: 0.5,
      metadata: "{}",
    });
  }

  it("vectorSearch excludes a NULL-scope legacy row when a real scope filter is given", async () => {
    const { store, dir } = makeStore();
    try {
      await seedNullScopeAndScopedRow(store);
      // Include "global" in the requested scopes: a NULL-scope row's app-layer
      // display default (`row.scope ?? "global"`) coerces it to "global" before
      // the double-check runs, so a filter that legitimately includes "global"
      // (a common agent-scope + shared-scope config) is what actually exercises
      // the leak — a filter of just ["agent-a"] would be masked by that
      // app-layer double-check and pass even against the unfixed query.
      const results = await store.vectorSearch([0.4, 0.5, 0.6], 20, 0, ["agent-a", "global"]);
      assert.ok(
        !results.some((r) => r.entry.id === "legacy-null-scope"),
        "the NULL-scope legacy row must not leak into an agent-a+global scoped vector search",
      );
      assert.ok(
        results.some((r) => r.entry.id !== "legacy-null-scope"),
        "the actually-scoped row must still be returned (regression)",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bm25Search (and its lexical fallback) excludes a NULL-scope legacy row when a real scope filter is given", async () => {
    const { store, dir } = makeStore();
    try {
      await seedNullScopeAndScopedRow(store);
      // See the vectorSearch case above for why "global" must be in the filter
      // to actually exercise the leak past the app-layer double-check.
      const results = await store.bm25Search("rockets", 20, ["agent-a", "global"]);
      assert.ok(
        !results.some((r) => r.entry.id === "legacy-null-scope"),
        "the NULL-scope legacy row must not leak into an agent-a+global scoped keyword search",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stats does not fold a NULL-scope legacy row's count into a requesting agent's scope stats", async () => {
    const { store, dir } = makeStore();
    try {
      await seedNullScopeAndScopedRow(store);
      const result = await store.stats(["agent-a"]);
      assert.equal(result.totalCount, 1, "only the agent-a scoped row should be counted");
      assert.equal(result.scopeCounts["agent-a"], 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fetchForCompaction excludes a NULL-scope legacy row when a real scope filter is given", async () => {
    const { store, dir } = makeStore();
    try {
      await seedNullScopeAndScopedRow(store);
      const results = await store.fetchForCompaction(Date.now() + 60_000, ["agent-a"], 200);
      assert.ok(
        !results.some((r) => r.id === "legacy-null-scope"),
        "the NULL-scope legacy row must not leak into an agent-a scoped compaction fetch",
      );
      assert.ok(
        results.some((r) => r.id !== "legacy-null-scope"),
        "the actually-scoped row must still be returned (regression)",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("(b) isOwnedByAgent no longer grants universal main or blank-owner access", () => {
  it("rejects a blank-owner legacy/invariant row for any requesting agent", () => {
    const metadata = { type: "memory-reflection", agentId: "" };
    assert.equal(isOwnedByAgent(metadata, "agent-two"), false);
    assert.equal(isOwnedByAgent(metadata, "main"), false);
  });

  it("rejects a main-owned legacy/invariant row when a different agent requests it", () => {
    const metadata = { type: "memory-reflection", agentId: "main" };
    assert.equal(isOwnedByAgent(metadata, "agent-two"), false, "main ownership must not be universally inheritable");
  });

  it("still grants main access to its own main-owned row (regression)", () => {
    const metadata = { type: "memory-reflection", agentId: "main" };
    assert.equal(isOwnedByAgent(metadata, "main"), true);
  });

  it("still grants an agent access to its own exactly-owned row (regression)", () => {
    const metadata = { type: "memory-reflection", agentId: "agent-two" };
    assert.equal(isOwnedByAgent(metadata, "agent-two"), true);
    assert.equal(isOwnedByAgent(metadata, "carol"), false);
  });

  it("still fail-closes a blank-owner derived item (itemKind=derived, pre-existing regression)", () => {
    const metadata = { type: "memory-reflection-item", itemKind: "derived", agentId: "" };
    assert.equal(isOwnedByAgent(metadata, "agent-two"), false);
  });
});

describe("(c) reflection ownership is never minted as main when the sessionKey fails to parse", () => {
  // Mirrors the fixed derivation in index.ts's runMemoryReflection:
  //   const parsedAgentId = parseAgentIdFromSessionKey(sessionKey);
  //   const ownerAgentId = parsedAgentId || "";
  // (previously: const sourceAgentId = parseAgentIdFromSessionKey(sessionKey) || "main";
  //  used directly as the persisted ownership agentId)
  function deriveOwnerAgentId(sessionKey) {
    return parseAgentIdFromSessionKey(sessionKey) || "";
  }

  it("does not mint a main-owned row for a sessionKey that fails to parse to an agent", () => {
    const sessionKey = "channel:example:998877"; // does not start with "agent:"
    assert.equal(parseAgentIdFromSessionKey(sessionKey), undefined, "sanity: this sessionKey must fail to parse");

    const ownerAgentId = deriveOwnerAgentId(sessionKey);
    assert.equal(ownerAgentId, "", "parse failure must not fall back to main");

    const metadata = { type: "memory-reflection", agentId: ownerAgentId };
    assert.equal(isOwnedByAgent(metadata, "main"), false, "must not be inheritable by main");
    assert.equal(isOwnedByAgent(metadata, "agent-two"), false, "must not be inheritable by any other agent either");
  });

  it("attributes to the true agent when the sessionKey does parse (regression)", () => {
    const sessionKey = "agent:agent-two:session:xyz";
    const ownerAgentId = deriveOwnerAgentId(sessionKey);
    assert.equal(ownerAgentId, "agent-two");

    const metadata = { type: "memory-reflection", agentId: ownerAgentId };
    assert.equal(isOwnedByAgent(metadata, "agent-two"), true);
    assert.equal(isOwnedByAgent(metadata, "main"), false);
  });

  it("persisting a reflection with a blank owner is genuinely not inheritable end-to-end", async () => {
    const { store, dir } = makeStore();
    try {
      const { storeReflectionToLanceDB } = jiti("../src/reflection-store.ts");
      const ownerAgentId = deriveOwnerAgentId("channel:example:998877");

      await storeReflectionToLanceDB({
        reflectionText: ["## Invariants", "- Some invariant from an unparseable session.", "## Derived", "- Some derived note."].join("\n"),
        sessionKey: "channel:example:998877",
        sessionId: "session-unparseable",
        agentId: ownerAgentId,
        command: "command:new",
        scope: "global",
        toolErrorSignals: [],
        runAt: Date.now(),
        usedFallback: false,
        embedPassage: async () => [0.5, 0.5, 0.5],
        vectorSearch: async () => [],
        store: async (entry) => store.store(entry),
      });

      const stored = await store.list(["global"], "reflection", 20, 0);
      assert.ok(stored.length > 0, "expected the reflection to have been persisted");
      for (const entry of stored) {
        const metadata = JSON.parse(entry.metadata);
        assert.notEqual(metadata.agentId, "main", "must never persist as main-owned on parse failure");
        assert.equal(isOwnedByAgent(metadata, "main"), false);
        assert.equal(isOwnedByAgent(metadata, "agent-two"), false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
