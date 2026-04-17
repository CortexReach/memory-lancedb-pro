/**
 * Regression: knowledge vs experience decoupling (arxiv:2602.05665 §III-C, §V-E).
 *
 * Covers the four layers of the MVP:
 *   1. classifyMemoryType maps 6-category + legacy inputs to K/E
 *   2. parseSmartMetadata lazy-backfills memory_type on legacy entries
 *   3. DecayEngine applies per-type half-life multipliers
 *   4. analyzeIntent + applyMemoryTypeBoost route K/E queries correctly
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Module from "node:module";

import jitiFactory from "jiti";

process.env.NODE_PATH = [
  process.env.NODE_PATH,
  "/opt/homebrew/lib/node_modules/openclaw/node_modules",
  "/opt/homebrew/lib/node_modules",
].filter(Boolean).join(":");
Module._initPaths();

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const { classifyMemoryType } = jiti("../src/memory-categories.ts");
const { parseSmartMetadata, buildSmartMetadata, stringifySmartMetadata } =
  jiti("../src/smart-metadata.ts");
const { createDecayEngine, DEFAULT_DECAY_CONFIG } =
  jiti("../src/decay-engine.ts");
const { analyzeIntent, applyMemoryTypeBoost } =
  jiti("../src/intent-analyzer.ts");

// ---------------------------------------------------------------------------
// 1. classifyMemoryType
// ---------------------------------------------------------------------------

describe("classifyMemoryType", () => {
  it("maps the 6 semantic categories correctly", () => {
    assert.equal(classifyMemoryType("profile"), "knowledge");
    assert.equal(classifyMemoryType("preferences"), "knowledge");
    assert.equal(classifyMemoryType("entities"), "knowledge");
    assert.equal(classifyMemoryType("patterns"), "knowledge");
    assert.equal(classifyMemoryType("events"), "experience");
    assert.equal(classifyMemoryType("cases"), "experience");
  });

  it("falls back to legacy category when memory_category is missing", () => {
    assert.equal(classifyMemoryType(undefined, "preference"), "knowledge");
    assert.equal(classifyMemoryType(undefined, "fact"), "knowledge");
    assert.equal(classifyMemoryType(undefined, "entity"), "knowledge");
    assert.equal(classifyMemoryType(undefined, "decision"), "experience");
    assert.equal(classifyMemoryType(undefined, "reflection"), "experience");
  });

  it("defaults to knowledge when neither is informative", () => {
    assert.equal(classifyMemoryType(undefined, undefined), "knowledge");
    assert.equal(classifyMemoryType("totally-unknown"), "knowledge");
  });
});

// ---------------------------------------------------------------------------
// 2. parseSmartMetadata backfill
// ---------------------------------------------------------------------------

describe("parseSmartMetadata memory_type backfill", () => {
  it("derives memory_type from memory_category when not stored", () => {
    const raw = JSON.stringify({
      memory_category: "events",
      l0_abstract: "shipped v1 last Tuesday",
    });
    const meta = parseSmartMetadata(raw, { text: "shipped v1 last Tuesday" });
    assert.equal(meta.memory_type, "experience");
  });

  it("derives memory_type from legacy category when memory_category also missing", () => {
    const meta = parseSmartMetadata(undefined, {
      text: "the user prefers tabs",
      category: "preference",
    });
    assert.equal(meta.memory_type, "knowledge");
  });

  it("respects an explicit stored memory_type", () => {
    const raw = JSON.stringify({
      memory_category: "profile",
      memory_type: "experience", // deliberately mismatched
    });
    const meta = parseSmartMetadata(raw, { text: "x" });
    assert.equal(meta.memory_type, "experience");
  });

  it("buildSmartMetadata updates memory_type when memory_category changes", () => {
    const before = buildSmartMetadata(
      { text: "x", category: "preference" },
      { memory_category: "preferences" },
    );
    assert.equal(before.memory_type, "knowledge");

    const after = buildSmartMetadata(
      { text: "x", metadata: stringifySmartMetadata(before) },
      { memory_category: "cases" },
    );
    assert.equal(after.memory_type, "experience");
  });
});

// ---------------------------------------------------------------------------
// 3. DecayEngine half-life multipliers
// ---------------------------------------------------------------------------

describe("DecayEngine type-aware half-life", () => {
  const now = Date.now();
  const dayMs = 86_400_000;

  const baseMemory = {
    id: "m1",
    importance: 0.5,
    confidence: 1.0,
    tier: "working",
    accessCount: 0,
    createdAt: now - 30 * dayMs, // 30 days old — exactly at base half-life
    lastAccessedAt: now - 30 * dayMs,
  };

  it("knowledge memories decay slower than untyped", () => {
    const engine = createDecayEngine(DEFAULT_DECAY_CONFIG);
    const untyped = engine.score(baseMemory, now);
    const knowledge = engine.score({ ...baseMemory, memoryType: "knowledge" }, now);
    assert.ok(
      knowledge.recency > untyped.recency,
      `knowledge recency ${knowledge.recency} should exceed untyped ${untyped.recency}`,
    );
  });

  it("experience memories decay faster than untyped", () => {
    const engine = createDecayEngine(DEFAULT_DECAY_CONFIG);
    const untyped = engine.score(baseMemory, now);
    const experience = engine.score({ ...baseMemory, memoryType: "experience" }, now);
    assert.ok(
      experience.recency < untyped.recency,
      `experience recency ${experience.recency} should be below untyped ${untyped.recency}`,
    );
  });

  it("disabling multipliers (1.0/1.0) restores legacy behavior", () => {
    const engine = createDecayEngine({
      ...DEFAULT_DECAY_CONFIG,
      knowledgeHalfLifeMultiplier: 1.0,
      experienceHalfLifeMultiplier: 1.0,
    });
    const untyped = engine.score(baseMemory, now);
    const knowledge = engine.score({ ...baseMemory, memoryType: "knowledge" }, now);
    const experience = engine.score({ ...baseMemory, memoryType: "experience" }, now);
    assert.equal(knowledge.recency, untyped.recency);
    assert.equal(experience.recency, untyped.recency);
  });
});

// ---------------------------------------------------------------------------
// 4. analyzeIntent + applyMemoryTypeBoost
// ---------------------------------------------------------------------------

describe("analyzeIntent memoryType routing", () => {
  it("classifies English experience queries", () => {
    const signal = analyzeIntent("last time we deployed to prod, what broke?");
    assert.equal(signal.memoryType, "experience");
  });

  it("classifies Chinese experience queries", () => {
    const signal = analyzeIntent("上次我们是怎么处理这个 bug 的？");
    assert.equal(signal.memoryType, "experience");
  });

  it("classifies English knowledge queries", () => {
    const signal = analyzeIntent("what is the auth API endpoint?");
    assert.equal(signal.memoryType, "knowledge");
  });

  it("classifies Chinese knowledge queries", () => {
    const signal = analyzeIntent("这个接口是怎么配置的？");
    assert.equal(signal.memoryType, "knowledge");
  });

  it("returns undefined memoryType for broad queries", () => {
    const signal = analyzeIntent("write a function to sort arrays");
    assert.equal(signal.memoryType, undefined);
  });
});

describe("applyMemoryTypeBoost", () => {
  function buildEntry(type) {
    return {
      category: "fact",
      metadata: JSON.stringify({ memory_type: type }),
    };
  }

  it("boosts matching type and re-sorts", () => {
    const results = [
      { entry: buildEntry("knowledge"), score: 0.80 },
      { entry: buildEntry("experience"), score: 0.75 },
    ];
    const signal = { categories: [], depth: "full", confidence: "high", label: "experience", memoryType: "experience" };
    const getType = (entry) => parseSmartMetadata(entry.metadata, entry).memory_type;
    const boosted = applyMemoryTypeBoost(results, signal, getType);
    assert.equal(boosted[0].entry.metadata.includes("experience"), true);
    assert.ok(boosted[0].score > 0.75);
  });

  it("returns unchanged when intent has no memoryType", () => {
    const results = [
      { entry: buildEntry("experience"), score: 0.80 },
      { entry: buildEntry("knowledge"), score: 0.60 },
    ];
    const signal = { categories: [], depth: "l0", confidence: "low", label: "broad" };
    const getType = (entry) => parseSmartMetadata(entry.metadata, entry).memory_type;
    const out = applyMemoryTypeBoost(results, signal, getType);
    assert.equal(out[0].score, 0.80);
    assert.equal(out[1].score, 0.60);
  });

  it("caps boosted score at 1.0", () => {
    const results = [{ entry: buildEntry("knowledge"), score: 0.98 }];
    const signal = { categories: [], depth: "l1", confidence: "high", label: "fact", memoryType: "knowledge" };
    const getType = (entry) => parseSmartMetadata(entry.metadata, entry).memory_type;
    const boosted = applyMemoryTypeBoost(results, signal, getType);
    assert.ok(boosted[0].score <= 1.0);
  });
});
