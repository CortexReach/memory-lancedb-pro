import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { TopicIndex } = jiti("../src/topic-index.ts");

// ===========================================================================
// Mock MemoryStore
// ===========================================================================

function makeMockStore(entries) {
  let callCount = 0;
  return {
    list(scopeFilter, category, limit, offset) {
      const start = offset || 0;
      const end = start + (limit || 200);
      return Promise.resolve(entries.slice(start, end));
    },
  };
}

function makeMockEmbedder() {
  return {
    embedQuery(text) {
      return Promise.resolve([1, 0, 0]);
    },
    embedPassage(text) {
      return Promise.resolve([1, 0, 0]);
    },
  };
}

function makeEntry(id, topic, vector, importance) {
  const metadata = topic ? JSON.stringify({ topic }) : "{}";
  return {
    id,
    text: `memory-${id}`,
    vector: vector || [Math.random(), Math.random(), Math.random()],
    category: "fact",
    scope: "global",
    importance: importance ?? 0.5,
    timestamp: Date.now(),
    metadata,
  };
}

describe("TopicIndex", () => {
  describe("cold start", () => {
    it("returns empty index when fewer than 100 memories", async () => {
      const entries = Array.from({ length: 50 }, (_, i) =>
        makeEntry(`id-${i}`, `topic-${i % 5}`, [i * 0.1, 0, 0], 0.5),
      );

      const index = new TopicIndex();
      await index.build(makeMockStore(entries), makeMockEmbedder());

      assert.strictEqual(index.isBuilt, false);
      assert.deepStrictEqual(index.findRelevant([1, 0, 0], 3), []);
    });

    it("returns empty index when fewer than 3 topics", async () => {
      // 100 memories but only 2 topics
      const entries = Array.from({ length: 100 }, (_, i) =>
        makeEntry(`id-${i}`, i < 50 ? "topic-a" : "topic-b", [i * 0.01, 0, 0], 0.5),
      );

      const index = new TopicIndex();
      await index.build(makeMockStore(entries), makeMockEmbedder());

      assert.strictEqual(index.isBuilt, false);
    });
  });

  describe("build", () => {
    it("builds index with sufficient memories and topics", async () => {
      // 120 memories across 4 topics
      const entries = Array.from({ length: 120 }, (_, i) => {
        const topicIdx = i % 4;
        return makeEntry(
          `id-${i}`,
          `topic-${topicIdx}`,
          [topicIdx * 0.25, 0.5, i * 0.001],
          0.5 + topicIdx * 0.1,
        );
      });

      const index = new TopicIndex();
      await index.build(makeMockStore(entries), makeMockEmbedder());

      assert.strictEqual(index.isBuilt, true);

      const stats = index.getStats();
      assert.strictEqual(stats.clusterCount, 4);
      assert.strictEqual(stats.uncategorizedCount, 0);
    });

    it("handles memories without topic as _uncategorized", async () => {
      const entries = [];
      // 80 with topics, 40 without
      for (let i = 0; i < 80; i++) {
        entries.push(
          makeEntry(`id-${i}`, `topic-${i % 4}`, [i * 0.01, 0.5, 0], 0.5),
        );
      }
      for (let i = 80; i < 120; i++) {
        entries.push(
          makeEntry(`id-${i}`, undefined, [i * 0.01, 0.5, 0], 0.5),
        );
      }

      const index = new TopicIndex();
      await index.build(makeMockStore(entries), makeMockEmbedder());

      assert.strictEqual(index.isBuilt, true);
      const stats = index.getStats();
      assert.strictEqual(stats.clusterCount, 5); // 4 topics + _uncategorized
      assert.strictEqual(stats.uncategorizedCount, 40);
    });
  });

  describe("findRelevant", () => {
    it("returns clusters sorted by cosine similarity to query", async () => {
      const entries = [];
      // topic-a: vectors near [1, 0, 0]
      for (let i = 0; i < 40; i++) {
        entries.push(makeEntry(`a-${i}`, "topic-a", [1, 0.01 * i, 0], 0.5));
      }
      // topic-b: vectors near [0, 1, 0]
      for (let i = 0; i < 40; i++) {
        entries.push(makeEntry(`b-${i}`, "topic-b", [0, 1, 0.01 * i], 0.5));
      }
      // topic-c: vectors near [0, 0, 1]
      for (let i = 0; i < 40; i++) {
        entries.push(makeEntry(`c-${i}`, "topic-c", [0, 0.01 * i, 1], 0.5));
      }

      const index = new TopicIndex();
      await index.build(makeMockStore(entries), makeMockEmbedder());

      assert.strictEqual(index.isBuilt, true);

      // Query near [1, 0, 0] should prefer topic-a
      const results = index.findRelevant([1, 0, 0], 2);
      assert.strictEqual(results.length, 2);
      assert.strictEqual(results[0].topic, "topic-a");
    });

    it("respects topK limit", async () => {
      const entries = [];
      for (let i = 0; i < 120; i++) {
        entries.push(
          makeEntry(`id-${i}`, `topic-${i % 4}`, [i * 0.01, 0.5, 0], 0.5),
        );
      }

      const index = new TopicIndex();
      await index.build(makeMockStore(entries), makeMockEmbedder());

      const results = index.findRelevant([1, 0, 0], 1);
      assert.strictEqual(results.length, 1);
    });

    it("returns empty array when index not built", () => {
      const index = new TopicIndex();
      const results = index.findRelevant([1, 0, 0], 3);
      assert.deepStrictEqual(results, []);
    });
  });

  describe("addMemory", () => {
    it("adds a memory to an existing cluster and updates centroid", async () => {
      const entries = Array.from({ length: 120 }, (_, i) =>
        makeEntry(`id-${i}`, `topic-${i % 3}`, [i * 0.01, 0, 0], 0.5),
      );

      const index = new TopicIndex();
      await index.build(makeMockStore(entries), makeMockEmbedder());
      assert.strictEqual(index.isBuilt, true);

      const statsBefore = index.getStats();

      // Add a memory to topic-0
      index.addMemory("topic-0", "new-1", [100, 0, 0], 0.9);

      // The cluster should now have one more memory
      const clusters = index.findRelevant([100, 0, 0], 3);
      const topic0 = clusters.find((c) => c.topic === "topic-0");
      assert.ok(topic0, "topic-0 should be in results");
      assert.ok(
        topic0.memoryIds.includes("new-1"),
        "new memory should be in cluster",
      );
    });

    it("creates a new cluster when topic is new", () => {
      const index = new TopicIndex();
      index.addMemory("brand-new-topic", "mem-1", [1, 0, 0], 0.8);

      const stats = index.getStats();
      assert.strictEqual(stats.clusterCount, 1);
    });

    it("uses _uncategorized for empty topic", () => {
      const index = new TopicIndex();
      index.addMemory("", "mem-1", [1, 0, 0], 0.8);

      const stats = index.getStats();
      assert.strictEqual(stats.uncategorizedCount, 1);
    });
  });

  describe("getStats", () => {
    it("returns correct stats for empty index", () => {
      const index = new TopicIndex();
      const stats = index.getStats();

      assert.strictEqual(stats.clusterCount, 0);
      assert.strictEqual(stats.largestCluster, "(none)");
      assert.strictEqual(stats.uncategorizedCount, 0);
    });

    it("identifies the largest cluster", async () => {
      const entries = [];
      // topic-big: 80 entries
      for (let i = 0; i < 80; i++) {
        entries.push(makeEntry(`big-${i}`, "topic-big", [i * 0.01, 0, 0], 0.5));
      }
      // topic-small: 20 entries
      for (let i = 0; i < 20; i++) {
        entries.push(
          makeEntry(`small-${i}`, "topic-small", [0, i * 0.01, 0], 0.5),
        );
      }
      // topic-medium: 30 entries
      for (let i = 0; i < 30; i++) {
        entries.push(
          makeEntry(`med-${i}`, "topic-medium", [0, 0, i * 0.01], 0.5),
        );
      }

      const index = new TopicIndex();
      await index.build(makeMockStore(entries), makeMockEmbedder());

      const stats = index.getStats();
      assert.strictEqual(stats.largestCluster, "topic-big");
    });
  });
});
