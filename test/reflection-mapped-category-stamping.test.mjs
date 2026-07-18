import assert from "node:assert/strict";
import Module from "node:module";
import { describe, it } from "node:test";
import jitiFactory from "jiti";

process.env.NODE_PATH = [
  process.env.NODE_PATH,
  "/opt/homebrew/lib/node_modules/openclaw/node_modules",
  "/opt/homebrew/lib/node_modules",
].filter(Boolean).join(":");
Module._initPaths();

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { buildReflectionMappedMetadata } = jiti("../src/reflection-mapped-metadata.ts");
const { buildReflectionItemPayloads } = jiti("../src/reflection-item-store.ts");
const { parseSmartMetadata } = jiti("../src/smart-metadata.ts");

function buildParams(mappedItem) {
  return {
    mappedItem,
    eventId: "event-1",
    agentId: "agent-1",
    sessionKey: "session-key-1",
    sessionId: "session-1",
    runAt: Date.now(),
    usedFallback: false,
    toolErrorSignals: [],
  };
}

describe("reflection-mapped write-time memory_category stamping", () => {
  it("stamps user-model rows as preferences", () => {
    const metadata = buildReflectionMappedMetadata(buildParams({
      text: "Prefers dark roast coffee in the morning",
      category: "preference",
      heading: "User model deltas (about the human)",
      mappedKind: "user-model",
      ordinal: 0,
      groupSize: 1,
    }));
    assert.equal(metadata.memory_category, "preferences");
  });

  it("stamps agent-model rows as patterns (assistant behavior, not user preferences)", () => {
    const metadata = buildReflectionMappedMetadata(buildParams({
      text: "Should default to terse summaries",
      category: "preference",
      heading: "Agent model deltas (about the assistant/system)",
      mappedKind: "agent-model",
      ordinal: 0,
      groupSize: 1,
    }));
    assert.equal(metadata.memory_category, "patterns");
  });

  it("stamps lesson rows as cases", () => {
    const metadata = buildReflectionMappedMetadata(buildParams({
      text: "Symptom: flaky test / Cause: shared port / Fix: randomize port / Prevention: use ephemeral ports",
      category: "fact",
      heading: "Lessons & pitfalls (symptom / cause / fix / prevention)",
      mappedKind: "lesson",
      ordinal: 0,
      groupSize: 1,
    }));
    assert.equal(metadata.memory_category, "cases");
  });

  it("stamps decision rows as cases, not events", () => {
    const metadata = buildReflectionMappedMetadata(buildParams({
      text: "Chose to use LanceDB over Qdrant for local dev",
      category: "decision",
      heading: "Decisions (durable)",
      mappedKind: "decision",
      ordinal: 0,
      groupSize: 1,
    }));
    assert.equal(metadata.memory_category, "cases");
  });

  it("readers use the stamped memory_category directly, not the row-level category fallback", () => {
    const baseMetadata = buildReflectionMappedMetadata(buildParams({
      text: "Chose to use LanceDB over Qdrant for local dev",
      category: "decision",
      heading: "Decisions (durable)",
      mappedKind: "decision",
      ordinal: 0,
      groupSize: 1,
    }));
    const rawMetadata = JSON.stringify(baseMetadata);
    // Deliberately mismatch entry.category against the stamped mappedKind's
    // category: if the reader ignored the stamp and fell back to deriving
    // from entry.category, "preference" would resolve to "preferences" —
    // proving the parsed result instead matches the stamp ("cases") shows
    // the stamp wins over the row-level fallback derivation.
    const entry = {
      text: "Chose to use LanceDB over Qdrant for local dev",
      category: "preference",
      metadata: rawMetadata,
    };
    const parsed = parseSmartMetadata(entry.metadata, entry);
    assert.equal(parsed.memory_category, "cases");
    assert.notEqual(parsed.memory_category, "preferences");
  });
});

describe("reflection-mapped write-time L0/L1/L2 minting", () => {
  it("mints the three levels deterministically: line as abstract/content, heading-based overview", () => {
    const metadata = buildReflectionMappedMetadata(buildParams({
      text: "Prefers dark roast coffee in the morning",
      category: "preference",
      heading: "User model deltas (about the human)",
      mappedKind: "user-model",
      ordinal: 0,
      groupSize: 1,
    }));
    assert.equal(metadata.l0_abstract, "Prefers dark roast coffee in the morning");
    assert.equal(
      metadata.l1_overview,
      "## User model deltas (about the human)\n- Prefers dark roast coffee in the morning",
    );
    assert.equal(metadata.l2_content, "Prefers dark roast coffee in the morning");
    assert.notEqual(metadata.l1_overview, metadata.l0_abstract, "the overview must carry section context, not echo the line");
  });
});

describe("reflection-item write-time L0/L1/L2 minting", () => {
  it("mints the three levels for invariant and derived rows, section-based overview", () => {
    const payloads = buildReflectionItemPayloads({
      items: [
        { itemKind: "invariant", section: "Invariants", ordinal: 0, groupSize: 2, text: "Always verify ids before deleting" },
        { itemKind: "derived", section: "Derived", ordinal: 1, groupSize: 2, text: "User mixes real facts into roleplay asides" },
      ],
      eventId: "refl-test-1",
      agentId: "agent-one",
      sessionKey: "agent:agent-one:main",
      sessionId: "session-1",
      runAt: 1000,
      usedFallback: false,
      toolErrorSignals: [],
    });
    assert.equal(payloads.length, 2);
    const [inv, der] = payloads;
    assert.equal(inv.metadata.l0_abstract, "Always verify ids before deleting");
    assert.equal(inv.metadata.l1_overview, "## Invariants\n- Always verify ids before deleting");
    assert.equal(inv.metadata.l2_content, "Always verify ids before deleting");
    assert.equal(der.metadata.l1_overview, "## Derived\n- User mixes real facts into roleplay asides");
    assert.notEqual(der.metadata.l1_overview, der.metadata.l0_abstract, "the overview must carry section context, not echo the line");
  });
});
