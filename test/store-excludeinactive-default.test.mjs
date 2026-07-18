// test/store-excludeinactive-default.test.mjs
//
// Item 6 (PR #946 fix round): invalidated/superseded rows must be invisible
// to read surfaces BY DEFAULT, not opt-in. This exercises the store-layer
// choke point directly against a real temporary LanceDB instance (not a
// fake/mocked table) -- store.ts's own typed-array vector bug shipped
// invisibly through mocked-vector unit tests, so any store.ts read-path
// change in this codebase gets a real round-trip test.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

function makeStore(prefix, vectorDim = 4) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const { MemoryStore } = jiti("../src/store.ts");
  return { store: new MemoryStore({ dbPath: dir, vectorDim }), dir };
}

async function storeLiveAndInvalidatedPair(store) {
  const live = await store.store({
    text: "Live fact: user likes cola",
    vector: [1, 0, 0, 0],
    category: "preference",
    scope: "test",
    importance: 0.7,
    metadata: JSON.stringify({
      l0_abstract: "Live fact: user likes cola",
      memory_category: "preferences",
      valid_from: Date.now() - 10_000,
    }),
  });

  const dead = await store.store({
    text: "Dead fact: user liked tea (superseded)",
    vector: [1, 0, 0, 0],
    category: "preference",
    scope: "test",
    importance: 0.7,
    metadata: JSON.stringify({
      l0_abstract: "Dead fact: user liked tea (superseded)",
      memory_category: "preferences",
      valid_from: Date.now() - 20_000,
    }),
  });

  // Invalidate the second row the same way supersede/consolidate does:
  // stamp invalidated_at into the metadata blob via a normal update().
  await store.update(dead.id, {
    metadata: JSON.stringify({
      l0_abstract: "Dead fact: user liked tea (superseded)",
      memory_category: "preferences",
      valid_from: Date.now() - 20_000,
      invalidated_at: Date.now() - 5_000,
      superseded_by: live.id,
    }),
  });

  return { live, dead };
}

describe("store.ts: excludeInactive defaults to true (item 6 choke point)", () => {
  it("vectorSearch excludes the invalidated row by default", async () => {
    const { store, dir } = makeStore("excl-vs-");
    try {
      const { live, dead } = await storeLiveAndInvalidatedPair(store);
      const results = await store.vectorSearch([1, 0, 0, 0], 10, 0, ["test"]);
      const ids = results.map((r) => r.entry.id);
      assert.ok(ids.includes(live.id), "the live row must be returned");
      assert.ok(!ids.includes(dead.id), "the invalidated row must NOT be returned by default");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("vectorSearch still returns the invalidated row when excludeInactive:false is explicit", async () => {
    const { store, dir } = makeStore("excl-vs-optout-");
    try {
      const { live, dead } = await storeLiveAndInvalidatedPair(store);
      const results = await store.vectorSearch([1, 0, 0, 0], 10, 0, ["test"], { excludeInactive: false });
      const ids = results.map((r) => r.entry.id);
      assert.ok(ids.includes(live.id));
      assert.ok(ids.includes(dead.id), "explicit opt-out must still surface the invalidated row");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bm25Search excludes the invalidated row by default", async () => {
    const { store, dir } = makeStore("excl-bm-");
    try {
      const { live, dead } = await storeLiveAndInvalidatedPair(store);
      const results = await store.bm25Search("fact", 10, ["test"]);
      const ids = results.map((r) => r.entry.id);
      assert.ok(ids.includes(live.id));
      assert.ok(!ids.includes(dead.id), "the invalidated row must NOT be returned by default");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("list() excludes the invalidated row by default", async () => {
    const { store, dir } = makeStore("excl-list-");
    try {
      const { live, dead } = await storeLiveAndInvalidatedPair(store);
      const results = await store.list(["test"], undefined, 20, 0);
      const ids = results.map((r) => r.id);
      assert.ok(ids.includes(live.id));
      assert.ok(!ids.includes(dead.id), "list() must exclude invalidated rows by default");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("list() surfaces the invalidated row when excludeInactive:false is explicit", async () => {
    const { store, dir } = makeStore("excl-list-optout-");
    try {
      const { live, dead } = await storeLiveAndInvalidatedPair(store);
      const results = await store.list(["test"], undefined, 20, 0, { excludeInactive: false });
      const ids = results.map((r) => r.id);
      assert.ok(ids.includes(live.id));
      assert.ok(ids.includes(dead.id), "explicit opt-out must still surface the invalidated row");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fetchForCompaction() excludes the invalidated row by default", async () => {
    const { store, dir } = makeStore("excl-fc-");
    try {
      const { live, dead } = await storeLiveAndInvalidatedPair(store);
      const results = await store.fetchForCompaction(Date.now() + 1000, ["test"], 200);
      const ids = results.map((r) => r.id);
      assert.ok(ids.includes(live.id));
      assert.ok(!ids.includes(dead.id), "fetchForCompaction() must exclude invalidated rows by default");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fetchForCompaction() surfaces the invalidated row when excludeInactive:false is explicit", async () => {
    const { store, dir } = makeStore("excl-fc-optout-");
    try {
      const { live, dead } = await storeLiveAndInvalidatedPair(store);
      const results = await store.fetchForCompaction(Date.now() + 1000, ["test"], 200, { excludeInactive: false });
      const ids = results.map((r) => r.id);
      assert.ok(ids.includes(live.id));
      assert.ok(ids.includes(dead.id), "explicit opt-out must still surface the invalidated row");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("getById stays unfiltered by design -- it must still return an invalidated row", async () => {
    const { store, dir } = makeStore("excl-getbyid-");
    try {
      const { dead } = await storeLiveAndInvalidatedPair(store);
      const found = await store.getById(dead.id, ["test"]);
      assert.ok(found, "getById must never filter by invalidation status");
      assert.equal(found.id, dead.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stats() reports both a blended totalCount and a live-only liveCount", async () => {
    const { store, dir } = makeStore("excl-stats-");
    try {
      await storeLiveAndInvalidatedPair(store);
      const stats = await store.stats(["test"]);
      assert.equal(stats.totalCount, 2, "totalCount must still include the invalidated row");
      assert.equal(stats.liveCount, 1, "liveCount must exclude the invalidated row");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
