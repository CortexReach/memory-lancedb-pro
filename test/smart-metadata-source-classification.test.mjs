/**
 * Regression test for reflection writer-1 (mapped rows) source
 * misclassification.
 *
 * parseSmartMetadata's missing-source fallback only mapped
 * "memory-reflection" / "memory-reflection-item" types to source
 * "reflection". Writer-1 mapped rows (buildReflectionMappedMetadata,
 * src/reflection-mapped-metadata.ts) carry type: "memory-reflection-mapped"
 * and write no source field at all, so every mapped row fell through to
 * "legacy" -- visible in the memory-consolidate source legend and anywhere
 * source is displayed or used.
 *
 * Also covers the memory_layer knock-on: a mapped row's reflection source is
 * provenance only -- the row lives in the general pool. Deriving layer
 * "reflection" from that source hid every judge-admitted mapped row from
 * recall (auto-recall governance and manual recall both exclude the
 * reflection layer), so mapped rows derive category-appropriate general-pool
 * layers while slice rows keep the reflection layer.
 *
 * Fixtures are entirely synthetic -- no real fleet data.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const { parseSmartMetadata } = jiti(path.join(testDir, "..", "src", "smart-metadata.ts"));
const { buildReflectionMappedMetadata } = jiti(path.join(testDir, "..", "src", "reflection-mapped-metadata.ts"));

describe("parseSmartMetadata: source classification for reflection writer-1 mapped rows", () => {
  it("classifies a memory-reflection-mapped row (no explicit source field) as source: reflection, not legacy", () => {
    const raw = JSON.stringify({
      type: "memory-reflection-mapped",
      l0_abstract: "Operator prefers streaming test reporters for long suites.",
    });

    const meta = parseSmartMetadata(raw, { text: "fallback text", timestamp: 1_700_000_000_000 });

    assert.equal(meta.source, "reflection");
  });

  it("still classifies memory-reflection and memory-reflection-item types as source: reflection (unchanged)", () => {
    for (const type of ["memory-reflection", "memory-reflection-item"]) {
      const raw = JSON.stringify({ type, l0_abstract: "some fact" });
      const meta = parseSmartMetadata(raw, { text: "fallback text", timestamp: 1_700_000_000_000 });
      assert.equal(meta.source, "reflection", `type=${type} should classify as reflection`);
    }
  });

  it("still classifies an unrecognized/absent type as source: legacy (unchanged)", () => {
    const raw = JSON.stringify({ l0_abstract: "some fact" });
    const meta = parseSmartMetadata(raw, { text: "fallback text", timestamp: 1_700_000_000_000 });
    assert.equal(meta.source, "legacy");
  });

  it("respects an explicit source field over type-based inference (unchanged)", () => {
    const raw = JSON.stringify({ type: "memory-reflection-mapped", source: "manual", l0_abstract: "some fact" });
    const meta = parseSmartMetadata(raw, { text: "fallback text", timestamp: 1_700_000_000_000 });
    assert.equal(meta.source, "manual");
  });

  it("keeps a mapped row's derived memory_layer in the general pool despite source: reflection", () => {
    // Source "reflection" on a mapped row is provenance, not residence.
    // Mapped rows write no explicit memory_layer field, so the derived value
    // decides their recall visibility: deriving "reflection" here made every
    // judge-admitted mapped row invisible to auto-recall governance and
    // manual recall, which both exclude that layer.
    const raw = JSON.stringify({
      type: "memory-reflection-mapped",
      l0_abstract: "Operator prefers streaming test reporters for long suites.",
    });

    const meta = parseSmartMetadata(raw, { text: "fallback text", category: "preference", timestamp: 1_700_000_000_000 });

    assert.equal(meta.source, "reflection");
    assert.equal(meta.memory_layer, "durable");
    assert.equal(meta.state, "confirmed");
  });
});

describe("parseSmartMetadata: memory_layer derivation for reflection row types", () => {
  it("derives general-pool layers for every mapped row category", () => {
    // The invariant under test is general-pool membership (never the
    // reflection layer). Exact durable-vs-working placement belongs to the
    // category mapping and is asserted only where it is stable: "decision"
    // rows only check pool membership because their legacy-category mapping
    // is an independent axis.
    const generalPoolLayers = ["durable", "working"];
    const cases = [
      { category: "preference", text: "fallback text", expected: "durable" },
      { category: "decision", text: "fallback text", expected: null },
      { category: "fact", text: "Streaming reporters cut suite feedback latency.", expected: "working" },
    ];
    for (const { category, text, expected } of cases) {
      const raw = JSON.stringify({ type: "memory-reflection-mapped", l0_abstract: text });
      const meta = parseSmartMetadata(raw, { text, category, timestamp: 1_700_000_000_000 });
      assert.ok(
        generalPoolLayers.includes(meta.memory_layer),
        `category=${category} should derive a general-pool layer, got ${meta.memory_layer}`,
      );
      if (expected) {
        assert.equal(meta.memory_layer, expected, `category=${category} should derive layer ${expected}`);
      }
    }
  });

  it("still derives the reflection layer for slice row types (recall exclusion intact)", () => {
    for (const type of ["memory-reflection", "memory-reflection-item"]) {
      const raw = JSON.stringify({ type, l0_abstract: "some fact" });
      const meta = parseSmartMetadata(raw, { text: "fallback text", timestamp: 1_700_000_000_000 });
      assert.equal(meta.memory_layer, "reflection", `type=${type} should stay in the reflection layer`);
    }
  });

  it("respects an explicit memory_layer field over derivation (unchanged)", () => {
    const raw = JSON.stringify({ type: "memory-reflection-mapped", memory_layer: "archive", l0_abstract: "some fact" });
    const meta = parseSmartMetadata(raw, { text: "fallback text", timestamp: 1_700_000_000_000 });
    assert.equal(meta.memory_layer, "archive");
  });
});

describe("buildReflectionMappedMetadata: stamps source at write time", () => {
  it("stamps source: reflection on newly-written mapped rows, complementing the read-path fallback for legacy rows", () => {
    const metadata = buildReflectionMappedMetadata({
      mappedItem: {
        text: "Operator prefers streaming test reporters for long suites.",
        category: "preference",
        heading: "User model deltas (about the human)",
        mappedKind: "user-model",
        ordinal: 1,
        groupSize: 1,
      },
      eventId: "event-1",
      agentId: "agent-1",
      sessionKey: "session-key-1",
      sessionId: "session-1",
      runAt: 1_700_000_000_000,
      usedFallback: false,
      toolErrorSignals: [],
    });

    assert.equal(metadata.source, "reflection");
  });
});
