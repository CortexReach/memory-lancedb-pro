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
const { reverseMapLegacyCategory, parseSmartMetadata } = jiti("../src/smart-metadata.ts");

const MAPPED_ROW_TYPE = "memory-reflection-mapped";

describe("reverseMapLegacyCategory decision handling (gated on mapped-row identity)", () => {
  it("maps an identifiable mapped decision row to cases, not events", () => {
    assert.equal(
      reverseMapLegacyCategory(
        "decision",
        "Chose to use LanceDB over Qdrant for local dev",
        MAPPED_ROW_TYPE,
      ),
      "cases",
    );
  });

  it("keeps the canonical decision-to-events mapping for a bare legacy decision row", () => {
    assert.equal(
      reverseMapLegacyCategory("decision", "Chose to use LanceDB over Qdrant for local dev"),
      "events",
    );
    assert.equal(
      reverseMapLegacyCategory("decision", "Chose to use LanceDB over Qdrant", "some-other-type"),
      "events",
    );
  });

  it("maps a mapped decision row with personal-identity text to profile, same as fact", () => {
    const text = "My name is Alex and I decided to move to Berlin";
    assert.equal(
      reverseMapLegacyCategory("decision", text, MAPPED_ROW_TYPE),
      reverseMapLegacyCategory("fact", text),
    );
    assert.equal(reverseMapLegacyCategory("decision", text, MAPPED_ROW_TYPE), "profile");
  });

  it("keeps mapped decision and fact on the identical branch for a case-shaped text", () => {
    const text = "Runbook: restart the ingest worker when the queue backs up";
    assert.equal(
      reverseMapLegacyCategory("decision", text, MAPPED_ROW_TYPE),
      reverseMapLegacyCategory("fact", text),
    );
  });

  it("leaves unrelated legacy category mappings unchanged", () => {
    assert.equal(reverseMapLegacyCategory("preference", "likes dark roast"), "preferences");
    assert.equal(reverseMapLegacyCategory("entity", "Acme Corp"), "entities");
    assert.equal(reverseMapLegacyCategory("other", "misc note"), "patterns");
    assert.equal(reverseMapLegacyCategory("fact", "Runbook: restart worker"), "cases");
    assert.equal(reverseMapLegacyCategory(undefined, "no category"), "patterns");
  });
});

describe("reverseMapLegacyCategory six-category tolerance (pre-contract-fix columns)", () => {
  it("reads a six-category value stored in the column back as itself, not the patterns default", () => {
    assert.equal(reverseMapLegacyCategory("preferences", "any"), "preferences");
    assert.equal(reverseMapLegacyCategory("cases", "any"), "cases");
    assert.equal(reverseMapLegacyCategory("patterns", "any"), "patterns");
    assert.equal(reverseMapLegacyCategory("events", "any"), "events");
    assert.equal(reverseMapLegacyCategory("profile", "any"), "profile");
    assert.equal(reverseMapLegacyCategory("entities", "any"), "entities");
  });

  it("still defaults genuinely unknown strings to patterns", () => {
    assert.equal(reverseMapLegacyCategory("garbage-category", "any"), "patterns");
  });
});

describe("default-layer parity between newly written and legacy-backed rows", () => {
  function layerOf(entry) {
    return parseSmartMetadata(entry.metadata, entry).memory_layer;
  }

  it("derives the same durable layer for a stamped mapped preferences row and an equivalent legacy-backed row", () => {
    const text = "Prefers dark roast coffee in the morning";
    const legacyBacked = { text, category: "preference", metadata: "{}" };
    const stampedMapped = {
      text,
      // pre-contract-fix builds wrote the six-category vocabulary into the
      // legacy column; the stamped metadata must still win layer derivation
      category: "preferences",
      metadata: JSON.stringify({
        type: MAPPED_ROW_TYPE,
        source: "reflection",
        mappedKind: "user-model",
        memory_category: "preferences",
      }),
    };
    assert.equal(layerOf(legacyBacked), "durable");
    assert.equal(layerOf(stampedMapped), "durable");
  });

  it("derives durable for an unstamped six-category preferences column via the identity read", () => {
    const entry = {
      text: "Prefers dark roast coffee in the morning",
      category: "preferences",
      metadata: "{}",
    };
    assert.equal(layerOf(entry), "durable");
  });

  it("keeps a junk stamp from hijacking layer derivation", () => {
    const entry = {
      text: "Prefers dark roast coffee in the morning",
      category: "preference",
      metadata: JSON.stringify({ memory_category: "not-a-real-category" }),
    };
    assert.equal(layerOf(entry), "durable");
  });
});
