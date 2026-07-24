import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";
import { Command } from "commander";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore, normalizeMemoryTimestamp } = jiti("../src/store.ts");
const { isOwnedByAgent } = jiti("../src/reflection-store.ts");
const { parseAgentIdFromSessionKey } = jiti("../src/scopes.ts");

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "scope-owner-leak-"));
  const store = new MemoryStore({ dbPath: dir, vectorDim: 3 });
  return { store, dir };
}

/**
 * Seed a legacy pre-scoping row below the public API: the write contract now
 * rejects scope-less rows, so genuine legacy fixtures go straight to the table.
 */
async function seedLegacyRow(store, row) {
  await store.ensureInitialized();
  await store.table.add([{ metadata: "{}", importance: 0.5, timestamp: Date.now(), ...row }]);
}

describe("(a) MemoryStore.list() no longer passes NULL-scope rows through a scope filter", () => {
  it("excludes a NULL-scope legacy row when a real scope filter is given", async () => {
    const { store, dir } = makeStore();
    try {
      // Seeded below the public API: the write contract rejects scope-less
      // rows, so legacy pre-scoping fixtures are inserted at the table layer.
      await seedLegacyRow(store, {
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
    await seedLegacyRow(store, {
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

describe("(a3) ID-based read/write paths no longer treat a NULL scope as literally \"global\"", () => {
  async function seedNullScopeRow(store) {
    await seedLegacyRow(store, {
      id: "id-path-null-scope",
      timestamp: Date.now(),
      text: "legacy row with no scope, reached by id",
      vector: [0.1, 0.2, 0.3],
      category: "fact",
      scope: null,
      importance: 0.5,
      metadata: "{}",
    });
  }

  it("getById excludes a NULL-scope row when the filter includes \"global\" (previously leaked)", async () => {
    const { store, dir } = makeStore();
    try {
      await seedNullScopeRow(store);
      // A NULL-scope row's *display* default is "global", but that must not make it
      // match an ACL filter that happens to include "global" — the row's real scope
      // is still NULL/absent, and a real scope filter must deny it like every other
      // read path in this PR already does.
      const result = await store.getById("id-path-null-scope", ["agent-a", "global"]);
      assert.equal(result, null, "a NULL-scope row must not be reachable by ID through a \"global\"-inclusive filter");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("getById still returns the row with no scope filter (internal/unrestricted read, regression)", async () => {
    const { store, dir } = makeStore();
    try {
      await seedNullScopeRow(store);
      const result = await store.getById("id-path-null-scope");
      assert.ok(result, "an unrestricted getById must still find the row");
      assert.equal(result.scope, "global", "display-only scope default is unchanged");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deleteExactId refuses to delete a NULL-scope row through a \"global\"-inclusive filter", async () => {
    const { store, dir } = makeStore();
    try {
      await seedNullScopeRow(store);
      await assert.rejects(
        () => store.deleteExactId("id-path-null-scope", ["agent-a", "global"]),
        /outside accessible scopes/,
      );
      const stillThere = await store.getById("id-path-null-scope");
      assert.ok(stillThere, "the row must not have been deleted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("update refuses to update a NULL-scope row through a \"global\"-inclusive filter", async () => {
    const { store, dir } = makeStore();
    try {
      await seedNullScopeRow(store);
      await assert.rejects(
        () => store.update("id-path-null-scope", { text: "hijacked" }, ["agent-a", "global"]),
        /outside accessible scopes/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bulkUpdateExact reports a NULL-scope row as outside accessible scopes through a \"global\"-inclusive filter", async () => {
    const { store, dir } = makeStore();
    try {
      await seedNullScopeRow(store);
      const [result] = await store.bulkUpdateExact(
        [{ id: "id-path-null-scope", updates: { text: "hijacked" } }],
        ["agent-a", "global"],
      );
      assert.equal(result.entry, null);
      assert.match(result.error ?? "", /outside accessible scopes/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("delete (distinct from deleteExactId) refuses to delete a NULL-scope row through a \"global\"-inclusive filter", async () => {
    const { store, dir } = makeStore();
    try {
      // delete() validates ID format (full UUID / hex prefix / legacy mem-md-N) before
      // even reaching the scope check, unlike deleteExactId's exact-string match — use a
      // UUID-shaped id so the assertion below actually exercises the scope-leak path.
      const uuidId = "11111111-2222-4333-8444-555555555555";
      await seedLegacyRow(store, {
        id: uuidId,
        timestamp: Date.now(),
        text: "legacy row with no scope, reached by id",
        vector: [0.1, 0.2, 0.3],
        category: "fact",
        scope: null,
        importance: 0.5,
        metadata: "{}",
      });
      await assert.rejects(
        () => store.delete(uuidId, ["agent-a", "global"]),
        /outside accessible scopes/,
      );
      const stillThere = await store.getById(uuidId);
      assert.ok(stillThere, "the row must not have been deleted");
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

  // Mirrors index.ts's targetScope derivation. Blanking ownerAgentId alone is not
  // enough: the row's DB `scope` column must also avoid main's default scope
  // (getDefaultScope("main") = "agent:main"), or a plain scope-filtered read (one
  // that never calls isOwnedByAgent) can still retrieve an "unattributed" row
  // alongside main's own legitimately-owned rows.
  const UNATTRIBUTED_REFLECTION_SCOPE = "unattributed:reflection";
  function deriveTargetScope(sessionKey, scopeManager) {
    const parsedAgentId = parseAgentIdFromSessionKey(sessionKey);
    if (!parsedAgentId) return UNATTRIBUTED_REFLECTION_SCOPE;
    return scopeManager.getDefaultScope(parsedAgentId || "main");
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
      const targetScope = deriveTargetScope("channel:example:998877", {
        getDefaultScope: (agentId) => (agentId ? `agent:${agentId}` : "global"),
      });
      assert.equal(targetScope, UNATTRIBUTED_REFLECTION_SCOPE, "sanity: parse failure must route to the unattributed scope");

      await storeReflectionToLanceDB({
        reflectionText: ["## Invariants", "- Some invariant from an unparseable session.", "## Derived", "- Some derived note."].join("\n"),
        sessionKey: "channel:example:998877",
        sessionId: "session-unparseable",
        agentId: ownerAgentId,
        command: "command:new",
        scope: targetScope,
        toolErrorSignals: [],
        runAt: Date.now(),
        usedFallback: false,
        embedPassage: async () => [0.5, 0.5, 0.5],
        vectorSearch: async () => [],
        store: async (entry) => store.store(entry),
      });

      const stored = await store.list([targetScope], "reflection", 20, 0);
      assert.ok(stored.length > 0, "expected the reflection to have been persisted");
      for (const entry of stored) {
        const metadata = JSON.parse(entry.metadata);
        assert.notEqual(metadata.agentId, "main", "must never persist as main-owned on parse failure");
        assert.equal(isOwnedByAgent(metadata, "main"), false);
        assert.equal(isOwnedByAgent(metadata, "agent-two"), false);
      }

      // The real leak this closes: a plain scope-filtered read for main's own
      // default scope (no isOwnedByAgent() check at all) must not see this row.
      const mainScopedRead = await store.list(["agent:main"], "reflection", 20, 0);
      assert.ok(
        !mainScopedRead.some((r) => r.id === stored[0]?.id),
        "an unattributed reflection must not be readable via a plain agent:main scope filter",
      );
      const globalScopedRead = await store.list(["global"], "reflection", 20, 0);
      assert.ok(
        !globalScopedRead.some((r) => r.id === stored[0]?.id),
        "an unattributed reflection must not be readable via a plain global scope filter either",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("(e) write-path scope contract", () => {
  it("store() rejects missing and blank scopes before writing", async () => {
    const { store, dir } = makeStore();
    try {
      await assert.rejects(
        () => store.store({ text: "no scope", vector: [1, 0, 0], category: "fact", importance: 0.5, metadata: "{}" }),
        /non-empty scope/,
      );
      await assert.rejects(
        () => store.store({ text: "blank scope", vector: [1, 0, 0], category: "fact", scope: "   ", importance: 0.5, metadata: "{}" }),
        /non-empty scope/,
      );
      const rows = await store.list(undefined, undefined, 10, 0);
      assert.equal(rows.length, 0, "rejected writes must not persist anything");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bulkStore() drops scope-less entries and still stores valid siblings", async () => {
    const { store, dir } = makeStore();
    try {
      const stored = await store.bulkStore([
        { text: "valid sibling", vector: [1, 0, 0], category: "fact", scope: "agent-a", importance: 0.5, metadata: "{}" },
        { text: "scope-less entry", vector: [0, 1, 0], category: "fact", importance: 0.5, metadata: "{}" },
        { text: "blank-scope entry", vector: [0, 0, 1], category: "fact", scope: "", importance: 0.5, metadata: "{}" },
      ]);
      assert.equal(stored.length, 1, "only the valid sibling may be accepted");
      const rows = await store.list(["agent-a"], undefined, 10, 0);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].text, "valid sibling");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("upsert() rejects a scope-less replacement BEFORE deleting the existing row", async () => {
    const { store, dir } = makeStore();
    try {
      await store.upsert({
        id: "guarded-row",
        timestamp: Date.now(),
        text: "original visible row",
        vector: [1, 0, 0],
        category: "fact",
        scope: "agent-a",
        importance: 0.5,
        metadata: "{}",
      });
      await assert.rejects(
        () => store.upsert({
          id: "guarded-row",
          timestamp: Date.now(),
          text: "orphaned replacement",
          vector: [0, 1, 0],
          category: "fact",
          scope: null,
          importance: 0.5,
          metadata: "{}",
        }),
        /non-empty scope/,
      );
      const rows = await store.list(["agent-a"], undefined, 10, 0);
      assert.equal(rows.length, 1, "the existing row must survive the rejected upsert");
      assert.equal(rows[0].text, "original visible row", "the original row must not be replaced by orphaned data");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fetchForCompaction treats an explicitly empty scope filter as deny-all", async () => {
    const { store, dir } = makeStore();
    try {
      await store.store({ text: "compactable", vector: [1, 0, 0], category: "fact", scope: "agent-a", importance: 0.5, metadata: "{}" });
      const denied = await store.fetchForCompaction(Date.now() + 10000, []);
      assert.equal(denied.length, 0, "an empty scope filter must return nothing");
      const scoped = await store.fetchForCompaction(Date.now() + 10000, ["agent-a"]);
      assert.equal(scoped.length, 1, "a real scope filter must still see its own rows");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("(f) legacy NULL/blank-scope migration path", () => {
  it("findLegacyScopeRows surfaces invisible rows and repairLegacyScopes restores visibility", async () => {
    const { store, dir } = makeStore();
    try {
      await seedLegacyRow(store, { id: "legacy-1", text: "legacy null-scope row", vector: [1, 0, 0], category: "fact", scope: null });
      await seedLegacyRow(store, { id: "legacy-2", text: "legacy blank-scope row", vector: [0, 1, 0], category: "fact", scope: "" });
      await store.store({ text: "modern scoped row", vector: [0, 0, 1], category: "fact", scope: "agent-a", importance: 0.5, metadata: "{}" });

      const legacy = await store.findLegacyScopeRows();
      assert.equal(legacy.length, 2, "both legacy rows must be discoverable");

      const globalBefore = await store.list(["global"], undefined, 10, 0);
      assert.equal(globalBefore.length, 0, "legacy rows must be invisible to scoped readers before repair");

      const outcome = await store.repairLegacyScopes("global");
      assert.deepEqual(outcome, { repaired: 2, failed: 0, skipped: 0, unrecovered: [] });

      const globalAfter = await store.list(["global"], undefined, 10, 0);
      assert.equal(globalAfter.length, 2, "repaired rows must be visible under the target scope");
      assert.equal((await store.findLegacyScopeRows()).length, 0, "no legacy rows may remain after repair");

      await assert.rejects(() => store.repairLegacyScopes("  "), /non-empty target scope/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("(d) unrestricted mutations preserve the raw stored scope", () => {
  const LEGACY_ID = "11111111-1111-4111-8111-111111111111";

  async function seedNullScopeRow(store, text) {
    await seedLegacyRow(store, {
      id: LEGACY_ID,
      text,
      vector: [0.1, 0.2, 0.3],
      category: "fact",
      scope: null,
    });
  }

  it("update() on a NULL-scope row keeps the row invisible to scoped readers", async () => {
    const { store, dir } = makeStore();
    try {
      await seedNullScopeRow(store, "legacy row updated without a filter");

      const updated = await store.update(LEGACY_ID, { text: "legacy row text after update" });
      assert.ok(updated, "the unrestricted update must succeed");
      assert.equal(updated.scope, "global", "the RETURNED entry keeps the display mask");

      const throughGlobal = await store.getById(LEGACY_ID, ["global"]);
      assert.equal(
        throughGlobal,
        null,
        'the updated row must stay invisible through a "global"-inclusive filter',
      );

      const legacy = await store.findLegacyScopeRows();
      assert.ok(
        legacy.some((row) => row.id === LEGACY_ID && row.text === "legacy row text after update"),
        "the updated row must still be a NULL-scope legacy row carrying the new text",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bulkUpdateExact() on a NULL-scope row keeps the row invisible to scoped readers", async () => {
    const { store, dir } = makeStore();
    try {
      await seedNullScopeRow(store, "legacy row bulk-updated without a filter");

      const results = await store.bulkUpdateExact([
        { id: LEGACY_ID, updates: { text: "legacy row text after bulk update" } },
      ]);
      assert.equal(results.length, 1);
      assert.ok(results[0].entry, "the unrestricted bulk update must succeed");
      assert.equal(results[0].entry.scope, "global", "the RETURNED entry keeps the display mask");

      const throughGlobal = await store.getById(LEGACY_ID, ["global"]);
      assert.equal(
        throughGlobal,
        null,
        'the bulk-updated row must stay invisible through a "global"-inclusive filter',
      );

      const legacy = await store.findLegacyScopeRows();
      assert.ok(
        legacy.some((row) => row.id === LEGACY_ID && row.text === "legacy row text after bulk update"),
        "the bulk-updated row must still be a NULL-scope legacy row carrying the new text",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("update() rollback restores the raw NULL scope when the replacement write fails", async () => {
    const { store, dir } = makeStore();
    try {
      await seedNullScopeRow(store, "legacy row that survives a failed update");

      const originalAdd = store.table.add.bind(store.table);
      let failNext = true;
      store.table.add = async (rows) => {
        if (failNext) {
          failNext = false;
          throw new Error("synthetic add failure");
        }
        return originalAdd(rows);
      };

      await assert.rejects(store.update(LEGACY_ID, { text: "never persisted" }));

      const legacy = await store.findLegacyScopeRows();
      assert.ok(
        legacy.some((row) => row.id === LEGACY_ID),
        "rollback must restore the row with its raw NULL scope",
      );
      const throughGlobal = await store.getById(LEGACY_ID, ["global"]);
      assert.equal(throughGlobal, null, "the restored row must remain invisible to scoped readers");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("update() canonicalizes whitespace-padded valid scopes instead of masking them", async () => {
    const { store, dir } = makeStore();
    try {
      await seedLegacyRow(store, {
        id: "33333333-3333-4333-8333-333333333333",
        text: "padded scope row",
        vector: [0.1, 0.2, 0.3],
        category: "fact",
        scope: "  agent-a  ",
      });

      await store.update("33333333-3333-4333-8333-333333333333", { text: "padded scope row updated" });

      const throughScope = await store.getById("33333333-3333-4333-8333-333333333333", ["agent-a"]);
      assert.ok(throughScope, "the updated row must be reachable through its trimmed scope");
      assert.equal(throughScope.text, "padded scope row updated");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("(e) legacy-scope repair is BigInt-safe and recoverable", () => {
  it("normalizeMemoryTimestamp bounds BigInt values instead of losing precision", () => {
    assert.equal(normalizeMemoryTimestamp(9223372036854775807n, 0), Number.MAX_SAFE_INTEGER);
    assert.equal(normalizeMemoryTimestamp(1784801288000n, 0), 1784801288000);
    assert.equal(normalizeMemoryTimestamp(1700000000n, 0), 1700000000000);
    assert.equal(normalizeMemoryTimestamp(-5n, 123), 123);
  });

  it("findLegacyScopeRows maps an above-safe-range BigInt timestamp to the bounded value", async () => {
    const { store, dir } = makeStore();
    try {
      await store.ensureInitialized();
      const realTable = store.table;
      store.table = {
        query: () => ({
          where: () => ({
            limit: () => ({
              toArray: async () => [{
                id: "legacy-bigint",
                text: "legacy row with an int64 timestamp",
                vector: [0.1, 0.2, 0.3],
                category: "fact",
                scope: null,
                importance: 0.5,
                timestamp: 9223372036854775807n,
                metadata: "{}",
              }],
            }),
          }),
        }),
      };
      try {
        const rows = await store.findLegacyScopeRows();
        assert.equal(rows.length, 1);
        assert.equal(
          rows[0].timestamp,
          Number.MAX_SAFE_INTEGER,
          "the mapped timestamp must be bounded, not float-rounded",
        );
      } finally {
        store.table = realTable;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("repairLegacyScopes reports rows lost to a double write failure instead of dropping them", async () => {
    const { store, dir } = makeStore();
    try {
      await seedLegacyRow(store, {
        id: "22222222-2222-4222-8222-222222222222",
        text: "legacy row that must not vanish silently",
        vector: [0.1, 0.2, 0.3],
        category: "fact",
        scope: null,
      });

      store.table.add = async () => {
        throw new Error("synthetic persistent add failure");
      };

      const result = await store.repairLegacyScopes("global");
      assert.equal(result.repaired, 0);
      assert.equal(result.failed, 1);
      assert.equal(result.unrecovered.length, 1, "the lost row must be surfaced to the caller");
      assert.equal(result.unrecovered[0].id, "22222222-2222-4222-8222-222222222222");
      assert.equal(result.unrecovered[0].text, "legacy row that must not vanish silently");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("repairLegacyScopes rolls back cleanly on a single write failure (nothing unrecovered)", async () => {
    const { store, dir } = makeStore();
    try {
      await seedLegacyRow(store, {
        id: "44444444-4444-4444-8444-444444444444",
        text: "legacy row restored by rollback",
        vector: [0.1, 0.2, 0.3],
        category: "fact",
        scope: null,
      });

      const originalAdd = store.table.add.bind(store.table);
      let failNext = true;
      store.table.add = async (rows) => {
        if (failNext) {
          failNext = false;
          throw new Error("synthetic add failure");
        }
        return originalAdd(rows);
      };

      const result = await store.repairLegacyScopes("global");
      assert.equal(result.repaired, 0);
      assert.equal(result.failed, 1);
      assert.equal(result.unrecovered.length, 0, "a successful rollback leaves nothing unrecovered");

      const legacy = await store.findLegacyScopeRows();
      assert.ok(
        legacy.some((row) => row.id === "44444444-4444-4444-8444-444444444444"),
        "the rolled-back row must still exist as a legacy NULL-scope row",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("(f) bulkStore write-boundary reporting and canonicalization", () => {
  it("reports each invalid entry with its index and reason instead of silently dropping", async () => {
    const { store, dir } = makeStore();
    try {
      const reports = [];
      const stored = await store.bulkStore([
        { text: "valid entry", vector: [0.1, 0.2, 0.3], category: "fact", scope: "agent-a", importance: 0.5, metadata: "{}" },
        { text: "scope-less entry", vector: [0.1, 0.2, 0.3], category: "fact", scope: "   ", importance: 0.5, metadata: "{}" },
        { text: "", vector: [0.1, 0.2, 0.3], category: "fact", scope: "agent-a", importance: 0.5, metadata: "{}" },
      ], (report) => reports.push(report));

      assert.equal(stored.length, 1, "only the valid entry may be stored");
      assert.deepEqual(reports.map((r) => r.index), [1, 2]);
      assert.match(reports[0].reason, /scope/);
      assert.match(reports[1].reason, /text/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("trims scope whitespace at the write boundary", async () => {
    const { store, dir } = makeStore();
    try {
      await store.bulkStore([
        { text: "padded scope entry", vector: [0.1, 0.2, 0.3], category: "fact", scope: "  agent-a  ", importance: 0.5, metadata: "{}" },
      ]);

      const rows = await store.list(["agent-a"], undefined, 20, 0);
      assert.ok(
        rows.some((row) => row.text === "padded scope entry"),
        "a whitespace-padded scope must canonicalize to the trimmed scope",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("(g) upsert and importEntry persist the canonical trimmed scope", () => {
  it("upsert() trims a padded scope so the replacement stays visible to the canonical filter", async () => {
    const { store, dir } = makeStore();
    try {
      const stored = await store.store({ text: "canonical row", vector: [1, 0, 0], category: "fact", scope: "agent-a", importance: 0.5, metadata: "{}" });

      await store.upsert({ ...stored, text: "replacement row", scope: "  agent-a  " });

      const row = await store.getById(stored.id, ["agent-a"]);
      assert.ok(row, "the replacement must remain visible under the canonical scope filter");
      assert.equal(row.scope, "agent-a", "the persisted scope must be the trimmed canonical form");
      assert.equal(row.text, "replacement row");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("importEntry() trims a padded scope and maps blank or whitespace-only scopes to global", async () => {
    const { store, dir } = makeStore();
    try {
      await store.importEntry({ id: "import-padded", text: "padded import", vector: [1, 0, 0], category: "fact", scope: "  agent-b ", importance: 0.5, timestamp: Date.now(), metadata: "{}" });
      await store.importEntry({ id: "import-blank", text: "whitespace-only import", vector: [0, 1, 0], category: "fact", scope: "   ", importance: 0.5, timestamp: Date.now(), metadata: "{}" });

      const padded = await store.getById("import-padded", ["agent-b"]);
      assert.ok(padded, "a padded import scope must canonicalize to the trimmed scope");
      assert.equal(padded.scope, "agent-b");

      const blank = await store.getById("import-blank", ["global"]);
      assert.ok(blank, "a whitespace-only import scope must fall back to global, not persist as an invisible row");
      assert.equal(blank.scope, "global");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("(h) repairLegacyScopes re-validates each row under the write lock", () => {
  it("skips a row that gained a real scope after discovery, preserving the concurrent write", async () => {
    const { store, dir } = makeStore();
    try {
      await seedLegacyRow(store, { id: "race-reassigned", text: "stale snapshot text", vector: [1, 0, 0], category: "fact", scope: null });
      await seedLegacyRow(store, { id: "still-legacy", text: "still legacy row", vector: [0, 1, 0], category: "fact", scope: "" });

      const realFind = store.findLegacyScopeRows.bind(store);
      store.findLegacyScopeRows = async (limit) => {
        const snapshot = await realFind(limit);
        await store.table.delete("id = 'race-reassigned'");
        await store.table.add([{ id: "race-reassigned", text: "updated by concurrent writer", vector: [1, 0, 0], category: "fact", scope: "agent-live", importance: 0.5, timestamp: Date.now(), metadata: "{}" }]);
        return snapshot;
      };

      const outcome = await store.repairLegacyScopes("global");
      assert.equal(outcome.repaired, 1, "only the still-legacy row may be repaired");
      assert.equal(outcome.skipped, 1, "the concurrently reassigned row must be skipped, not overwritten");
      assert.equal(outcome.failed, 0);

      const live = await store.getById("race-reassigned", ["agent-live"]);
      assert.ok(live, "the concurrent write must survive the repair pass");
      assert.equal(live.text, "updated by concurrent writer");
      assert.equal(live.scope, "agent-live");

      const repairedRow = await store.getById("still-legacy", ["global"]);
      assert.ok(repairedRow, "the genuinely legacy row must still be repaired");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("repairs from the row's current content, not the discovery snapshot", async () => {
    const { store, dir } = makeStore();
    try {
      await seedLegacyRow(store, { id: "race-content", text: "content at discovery time", vector: [1, 0, 0], category: "fact", scope: null });

      const realFind = store.findLegacyScopeRows.bind(store);
      store.findLegacyScopeRows = async (limit) => {
        const snapshot = await realFind(limit);
        await store.table.delete("id = 'race-content'");
        await store.table.add([{ id: "race-content", text: "revised while queued", vector: [1, 0, 0], category: "fact", scope: null, importance: 0.5, timestamp: Date.now(), metadata: "{}" }]);
        return snapshot;
      };

      const outcome = await store.repairLegacyScopes("global");
      assert.equal(outcome.repaired, 1);

      const row = await store.getById("race-content", ["global"]);
      assert.ok(row, "the still-legacy row must be repaired");
      assert.equal(row.text, "revised while queued", "the repair must persist the re-read content, not the stale snapshot");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips a row deleted after discovery instead of resurrecting it from the snapshot", async () => {
    const { store, dir } = makeStore();
    try {
      await seedLegacyRow(store, { id: "race-deleted", text: "deleted before the lock", vector: [1, 0, 0], category: "fact", scope: null });

      const realFind = store.findLegacyScopeRows.bind(store);
      store.findLegacyScopeRows = async (limit) => {
        const snapshot = await realFind(limit);
        await store.table.delete("id = 'race-deleted'");
        return snapshot;
      };

      const outcome = await store.repairLegacyScopes("global");
      assert.equal(outcome.repaired, 0);
      assert.equal(outcome.skipped, 1, "a row deleted between discovery and the lock must be skipped");

      const row = await store.getById("race-deleted");
      assert.equal(row, null, "the deleted row must not be resurrected from the snapshot");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("(i) repair-scopes command wiring", () => {
  function buildCliProgram(storeStubs) {
    const { createMemoryCLI } = jiti("../cli.ts");
    const program = new Command();
    program.exitOverride();
    createMemoryCLI({ store: storeStubs, retriever: {}, scopeManager: {}, migrator: {} })({ program });
    return program;
  }

  async function runRepairScopes(storeStubs, extraArgs = []) {
    const program = buildCliProgram(storeStubs);
    const logs = [];
    const errors = [];
    const originalLog = console.log;
    const originalError = console.error;
    const priorExitCode = process.exitCode;
    console.log = (...parts) => logs.push(parts.join(" "));
    console.error = (...parts) => errors.push(parts.join(" "));
    let exitCode;
    try {
      await program.parseAsync(["node", "cli", "memory-pro", "repair-scopes", ...extraArgs]);
    } finally {
      exitCode = process.exitCode;
      process.exitCode = priorExitCode;
      console.log = originalLog;
      console.error = originalError;
    }
    return { logs: logs.join("\n"), errors: errors.join("\n"), exitCode };
  }

  it("attaches repair-scopes to the memory-pro group the host routes", () => {
    const program = buildCliProgram({});
    const memoryPro = program.commands.find((c) => c.name() === "memory-pro");
    assert.ok(memoryPro, "memory-pro group must be registered");
    const groupNames = memoryPro.commands.map((c) => c.name());
    assert.ok(
      groupNames.includes("repair-scopes"),
      `expected "repair-scopes" under the memory-pro group, got: ${groupNames.join(", ")}`,
    );
  });

  it("exits nonzero when rows failed or were unrecovered, and zero on a clean repair", async () => {
    const failing = await runRepairScopes({
      async findLegacyScopeRows() { return [{ id: "legacy-x", text: "legacy row" }]; },
      async repairLegacyScopes() { return { repaired: 1, failed: 2, skipped: 0, unrecovered: [{ id: "lost-1", text: "lost row" }] }; },
    }, ["--apply"]);
    assert.equal(failing.exitCode, 1, "failed or unrecovered rows must fail the process for non-interactive callers");

    const clean = await runRepairScopes({
      async findLegacyScopeRows() { return [{ id: "legacy-y", text: "legacy row" }]; },
      async repairLegacyScopes() { return { repaired: 1, failed: 0, skipped: 1, unrecovered: [] }; },
    }, ["--apply"]);
    assert.notEqual(clean.exitCode, 1, "a clean repair (skips included) must not fail the exit code");
  });
});
