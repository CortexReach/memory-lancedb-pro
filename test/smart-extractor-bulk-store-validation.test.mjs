import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { SmartExtractor } = jiti("../src/smart-extractor.ts");

function makeCandidates(count) {
  const candidates = [
    {
      category: "preferences",
      abstract: "Tea preference: oolong tea",
      overview: "## Preference\n- Likes oolong tea",
      content: "The user likes oolong tea.",
    },
    {
      category: "entities",
      abstract: "Workspace location: Seattle office",
      overview: "## Entity\n- Seattle office",
      content: "The user works from the Seattle office.",
    },
  ];
  return candidates.slice(0, count);
}

function makeExtractor({
  candidateCount = 1,
  countValues = [],
  bulkStoreImpl,
  hasIdImpl,
}) {
  const logs = [];
  const debugLogs = [];
  const counts = [...countValues];
  const store = {
    async vectorSearch() {
      return [];
    },
    async store() {},
    async bulkStore(entries) {
      return bulkStoreImpl
        ? bulkStoreImpl(entries)
        : entries.map((entry, index) => ({
            ...entry,
            id: `stored-${index + 1}`,
            timestamp: Date.now(),
          }));
    },
    async count() {
      return counts.shift() ?? 0;
    },
    async hasId(id) {
      return hasIdImpl ? hasIdImpl(id) : true;
    },
  };

  const embedder = {
    async embed() {
      return [1, 0, 0];
    },
    async embedBatch(texts) {
      return texts.map((_, index) =>
        index % 2 === 0 ? [1, 0, 0] : [0, 1, 0],
      );
    },
  };

  const llm = {
    async completeJson(_prompt, mode) {
      if (mode === "extract-candidates") {
        return { memories: makeCandidates(candidateCount) };
      }
      throw new Error(`unexpected mode: ${mode}`);
    },
  };

  return {
    extractor: new SmartExtractor(store, embedder, llm, {
      user: "User",
      extractMinMessages: 1,
      extractMaxChars: 8000,
      defaultScope: "global",
      log(msg) {
        logs.push(msg);
      },
      debugLog(msg) {
        debugLogs.push(msg);
      },
    }),
    logs,
    debugLogs,
  };
}

describe("SmartExtractor bulkStore persistence validation", () => {
  it("logs when bulkStore accepts fewer entries than the extractor queued", async () => {
    const { extractor, logs } = makeExtractor({
      candidateCount: 1,
      countValues: [0],
      bulkStoreImpl: async () => [],
    });

    const stats = await extractor.extractAndPersist(
      "The user likes oolong tea.",
      "session-filtered",
      { scope: "global" },
    );

    assert.equal(stats.created, 1);
    assert.ok(
      logs.some((msg) => msg.includes("queued 1 create(s) but bulkStore accepted 0")),
      `expected queued-vs-accepted warning, got logs: ${JSON.stringify(logs)}`,
    );
  });

  it("logs when row count does not increase and returned IDs are missing", async () => {
    const { extractor, logs } = makeExtractor({
      candidateCount: 2,
      countValues: [10, 10],
      hasIdImpl: async (id) => id !== "stored-2",
    });

    const stats = await extractor.extractAndPersist(
      "The user likes oolong tea and works from the Seattle office.",
      "session-partial",
      { scope: "global" },
    );

    assert.equal(stats.created, 2);
    assert.ok(
      logs.some((msg) =>
        msg.includes("expected row delta >= 2") &&
        msg.includes("observed 0") &&
        msg.includes("missing returned IDs=1")
      ),
      `expected row-count validation warning, got logs: ${JSON.stringify(logs)}`,
    );
  });

  it("suppresses the warning when row-count delta is short but returned IDs are readable", async () => {
    const { extractor, logs, debugLogs } = makeExtractor({
      candidateCount: 2,
      countValues: [10, 10],
      hasIdImpl: async () => true,
    });

    await extractor.extractAndPersist(
      "The user likes oolong tea and works from the Seattle office.",
      "session-concurrent-delete",
      { scope: "global" },
    );

    assert.equal(
      logs.some((msg) => msg.includes("bulkStore validation warning")),
      false,
      `did not expect validation warning, got logs: ${JSON.stringify(logs)}`,
    );
    assert.ok(
      debugLogs.some((msg) => msg.includes("likely concurrent delete/compaction")),
      `expected concurrent-delete debug note, got debug logs: ${JSON.stringify(debugLogs)}`,
    );
  });
});
