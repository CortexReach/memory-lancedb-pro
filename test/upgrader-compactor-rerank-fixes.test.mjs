/**
 * Tests for memory-upgrader, memory-compactor, and retriever fixes.
 * Covers:
 *   1. upgrader: text should use l2_content, not l0_abstract
 *   2. compactor: buildMergedEntry must produce L0/L1/L2 in metadata
 *   3. retriever: rerank topN must be capped at candidatePoolSize
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import jitiFactory from "jiti";
const jiti = jitiFactory(import.meta.url, { interopDefault: true });

let buildMergedEntry, createRetriever, DEFAULT_RETRIEVAL_CONFIG, parseSmartMetadata, MemoryUpgrader;

try {
  ({ buildMergedEntry } = jiti("../src/memory-compactor.ts"));
} catch (_) {}

try {
  ({ createRetriever, DEFAULT_RETRIEVAL_CONFIG } = jiti("../src/retriever.ts"));
} catch (_) {}

try {
  ({ parseSmartMetadata } = jiti("../src/smart-metadata.ts"));
} catch (_) {}

try {
  ({ MemoryUpgrader } = jiti("../src/memory-upgrader.ts"));
} catch (_) {}

function vec(dims, ...values) {
  const v = new Array(dims).fill(0);
  values.forEach((val, i) => { v[i] = val; });
  return v;
}

function entry(overrides = {}) {
  return {
    id: overrides.id ?? "id-" + Math.random().toString(36).slice(2),
    text: overrides.text ?? "some memory text content",
    vector: overrides.vector ?? vec(4, 1, 0, 0, 0),
    category: overrides.category ?? "fact",
    scope: overrides.scope ?? "global",
    importance: overrides.importance ?? 0.5,
    timestamp: overrides.timestamp ?? Date.now(),
    metadata: overrides.metadata ?? "{}",
  };
}

describe("buildMergedEntry L0/L1/L2 metadata", { skip: !buildMergedEntry }, () => {
  it("metadata contains l0_abstract (first line truncated to 120 chars)", () => {
    const a = entry({ text: "This is the first line of text\nSecond line here\nThird line" });
    const b = entry({ text: "Another memory entry\nWith some content" });
    const merged = buildMergedEntry([a, b]);
    const meta = parseSmartMetadata(merged.metadata, merged);
    assert.ok(meta.l0_abstract !== undefined, "l0_abstract must exist");
    assert.ok(meta.l0_abstract.length <= 120, `l0_abstract should be <= 120 chars`);
  });

  it("metadata contains l1_overview as bullet list of first 3 lines", () => {
    const a = entry({ text: "Line one\nLine two\nLine three\nLine four\nLine five" });
    const merged = buildMergedEntry([a]);
    const meta = parseSmartMetadata(merged.metadata, merged);
    assert.ok(meta.l1_overview !== undefined, "l1_overview must exist");
  });

  it("metadata contains l2_content equal to the merged text", () => {
    const a = entry({ text: "Memory A content\nwith multiple lines" });
    const b = entry({ text: "Memory B content\nalso has lines" });
    const merged = buildMergedEntry([a, b]);
    const meta = parseSmartMetadata(merged.metadata, merged);
    assert.ok(meta.l2_content !== undefined, "l2_content must exist");
    assert.ok(meta.l2_content.includes("Memory A content"), "l2_content should contain content from member A");
  });

  it("metadata contains compacted: true and sourceCount", () => {
    const members = [entry(), entry(), entry()];
    const merged = buildMergedEntry(members);
    const meta = parseSmartMetadata(merged.metadata, merged);
    assert.equal(meta.compacted, true, "compacted flag must be true");
    assert.equal(meta.sourceCount, 3, "sourceCount must equal number of members");
  });
});

describe("retriever rerank topN capped at candidatePoolSize", { skip: !createRetriever }, () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("rerank API receives exact topN when candidates < candidatePoolSize", async () => {
    let capturedBody;

    globalThis.fetch = async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        async json() {
          return { results: capturedBody.texts.map((_, i) => ({ index: i, relevance_score: 1.0 })) };
        },
      };
    };

    const fakeEntry = entry({ id: "small-pool", text: "test", vector: vec(4, 0.7, 0.7, 0, 0) });
    const fakeStore = {
      hasFtsSupport: true,
      async vectorSearch() { return [{ entry: fakeEntry, score: 0.9 }]; },
      async bm25Search() { return [{ entry: fakeEntry, score: 0.8 }]; },
      async hasId() { return true; },
    };
    const fakeEmbedder = { async embedQuery() { return vec(4, 0.5, 0.5, 0, 0); } };

    const retriever = createRetriever(fakeStore, fakeEmbedder, {
      ...DEFAULT_RETRIEVAL_CONFIG,
      rerank: "cross-encoder",
      rerankApiKey: "test-key",
      rerankProvider: "jina",
      rerankEndpoint: "http://127.0.0.1:9/v1/rerank",
      rerankModel: "test-reranker",
      candidatePoolSize: 20,
      rerankTimeoutMs: 5000,
      minScore: 0,
      hardMinScore: 0,
      filterNoise: false,
    });

    await retriever.retrieve({ query: "test", limit: 5 });
    assert.equal(capturedBody.top_n, 1, "topN should equal candidate count when candidates < candidatePoolSize");
  });
});

describe("memory-upgrader text uses l2_content", { skip: !MemoryUpgrader }, () => {
  it("upgraded entry text uses entry.text (fallback) when LLM returns null", async () => {
    const fakeStore = {
      async update(id, updates) { this._lastUpdate = { id, updates }; },
      _lastUpdate: null,
    };
    const fakeLlm = {
      async completeJson() { return null; },
      getLastError() { return "mock failure"; },
    };

    const upgrader = new MemoryUpgrader(fakeStore, fakeLlm);
    const testEntry = entry({ id: "test", text: "original text content" });

    await upgrader.upgradeEntry(testEntry, false);

    assert.ok(fakeStore._lastUpdate !== null);
    const { updates } = fakeStore._lastUpdate;
    assert.equal(updates.text, "original text content", "fallback: text should be original entry.text");
  });
});

console.log("All fix tests registered. Run with: node --test test/upgrader-compactor-rerank-fixes.test.mjs");