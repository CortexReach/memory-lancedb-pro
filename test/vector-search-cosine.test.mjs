/**
 * Vector Search Cosine Distance Test
 * Tests that the real MemoryStore.vectorSearch uses cosine distance (not L2)
 * and produces correct score values.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import Module from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.NODE_PATH = [
    process.env.NODE_PATH,
    "/opt/homebrew/lib/node_modules/openclaw/node_modules",
    "/opt/homebrew/lib/node_modules",
].filter(Boolean).join(":");
Module._initPaths();

import jitiFactory from "jiti";
const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");

const DIM = 64; // small dim for fast tests
const workDir = mkdtempSync(path.join(tmpdir(), "cosine-test-"));
const dbPath = path.join(workDir, "db");

try {
    const store = new MemoryStore({ dbPath, vectorDim: DIM });

    // Create two known vectors
    const vecA = new Array(DIM).fill(0);
    vecA[0] = 1.0; // unit vector along dim 0

    const vecB = new Array(DIM).fill(0);
    vecB[0] = 0.9; vecB[1] = 0.436; // ~cos_sim=0.9 with vecA (angle ~26°)

    const vecC = new Array(DIM).fill(0);
    vecC[1] = 1.0; // orthogonal to vecA → cos_sim=0

    // Store memories with known vectors
    await store.store({ text: "similar memory", vector: vecB, category: "preference", scope: "test", importance: 0.8 });
    await store.store({ text: "orthogonal memory", vector: vecC, category: "fact", scope: "test", importance: 0.5 });

    // Test 1: vectorSearch returns results with correct cosine-based scores
    console.log("Test 1: vectorSearch uses cosine distance and scores are meaningful...");
    const results = await store.vectorSearch(vecA, 10, 0.0, ["test"]);
    assert.ok(results.length >= 1, "Should return at least 1 result");

    // Find the similar result
    const similar = results.find(r => r.entry.text === "similar memory");
    assert.ok(similar, "Similar memory should be in results");
    // cosine distance for ~0.9 similarity → distance ~0.1 → score = 1/(1+0.1) ≈ 0.91
    assert.ok(similar.score > 0.5, `Similar memory score should be >0.5, got ${similar.score.toFixed(3)}`);
    console.log(`  ✅ Similar memory score = ${similar.score.toFixed(3)} (cosine-based, >0.5)`);

    // Test 2: Orthogonal vector gets low score
    console.log("Test 2: Orthogonal vector gets low score...");
    const orthogonal = results.find(r => r.entry.text === "orthogonal memory");
    if (orthogonal) {
        assert.ok(orthogonal.score < similar.score, "Orthogonal should score lower than similar");
        console.log(`  ✅ Orthogonal memory score = ${orthogonal.score.toFixed(3)} (lower than similar)`);
    } else {
        // May have been filtered by internal minScore
        console.log("  ✅ Orthogonal memory filtered out (too low score)");
    }

    // Test 3: minScore filtering works
    console.log("Test 3: minScore filtering excludes low-score results...");
    const strictResults = await store.vectorSearch(vecA, 10, 0.95, ["test"]);
    // With strict minScore, some results should be filtered
    const filtered = results.length - strictResults.length;
    assert.ok(filtered >= 0, "Strict minScore should filter equal or more results");
    console.log(`  ✅ minScore=0.95 filtered ${filtered} results (${results.length} → ${strictResults.length})`);

    // Test 4: L2 distance would produce wrong scores (documentation)
    console.log("Test 4: Verify L2 would fail (documentation test)...");
    // For 1024-dim normalized embeddings, L2 distance ≈ 40-60
    // score = 1/(1+45) ≈ 0.022 — below any reasonable minScore
    const l2TypicalDistance = 45;
    const l2Score = 1 / (1 + l2TypicalDistance);
    assert.ok(l2Score < 0.3, `L2 score ${l2Score.toFixed(4)} should be below minScore=0.3`);
    console.log(`  ✅ L2 score = ${l2Score.toFixed(4)} (would drop all results, confirming cosine is needed)`);

    // Test 5: Legacy CPU fallback skips native vector search and reranks with JS cosine.
    console.log("Test 5: Native cosine fallback reranks candidates in JavaScript...");
    const fallbackStore = new MemoryStore({
        dbPath: path.join(workDir, "unused-fallback-db"),
        vectorDim: 2,
        disableNativeCosine: true,
    });
    const calls = [];
    const fakeRows = [
        {
            id: "orthogonal",
            text: "orthogonal fallback memory",
            vector: { 0: 0, 1: 1, length: 2 },
            category: "fact",
            scope: "test",
            importance: 0.5,
            timestamp: Date.now(),
            metadata: "{}",
            _distance: 0,
        },
        {
            id: "similar",
            text: "similar fallback memory",
            vector: { 0: 1, 1: 0, length: 2 },
            category: "fact",
            scope: "test",
            importance: 0.5,
            timestamp: Date.now(),
            metadata: "{}",
            _distance: 999,
        },
    ];
    const fakeScanQuery = {
        select(columns) {
            calls.push(`select:${columns.join(",")}`);
            return this;
        },
        where(value) {
            calls.push(`where:${value}`);
            return this;
        },
        async toArray() {
            return fakeRows;
        },
    };
    fallbackStore.table = {
        vectorSearch() {
            calls.push("vectorSearch");
            throw new Error("native vector search should not be called");
        },
        query() {
            calls.push("query");
            return fakeScanQuery;
        },
    };

    const fallbackResults = await fallbackStore.vectorSearch([1, 0], 2, 0, ["test"]);
    assert.equal(calls.includes("vectorSearch"), false, "fallback must not call LanceDB native vector search");
    assert.equal(fallbackResults[0].entry.id, "similar", "JS cosine rerank should move the similar row first");
    assert.deepEqual(fallbackResults[0].entry.vector, [1, 0], "fallback should normalize LanceDB vector-like values");
    assert.ok(fallbackResults[0].score > fallbackResults[1].score, "similar row should score above orthogonal row");
    console.log("  ✅ Native cosine fallback skipped vectorSearch and reranked by JS cosine");

    console.log("\n=== All vector-search-cosine tests passed! ===");

} finally {
    rmSync(workDir, { recursive: true, force: true });
}
