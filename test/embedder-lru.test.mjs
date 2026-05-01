/**
 * Issue #598 Phase 3 - EmbeddingCache LRU Semantics Test
 * Tests that re-setting an existing key updates its LRU position.
 */

import { describe, it } from "node:test";
import assert from "node:assert";

const jiti = require("jiti")(__filename);

describe("EmbeddingCache LRU semantics", () => {
  it("updates insertion order when re-setting existing key", async () => {
    const { Embedder } = jiti("../src/embedder.ts");

    const embedder = new Embedder({});
    const cache = embedder["cache"];

    // Set two keys
    cache.set("key1", undefined, [1, 0, 0]);
    cache.set("key2", undefined, [0, 1, 0]);

    // Re-set key1 with different value (should move to most recent)
    cache.set("key1", undefined, [1, 1, 0]);

    // Evict one - should evict key2 (oldest), not key1 (which was re-set)
    cache.set("key3", undefined, [0, 0, 1]);

    assert.strictEqual(cache.cache.has("key1"), true, "key1 should remain after re-set");
    assert.strictEqual(cache.cache.has("key2"), false, "key2 should be evicted (oldest)");
    assert.strictEqual(cache.cache.has("key3"), true, "key3 should be added");
  });
});
