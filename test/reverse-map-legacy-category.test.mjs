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
const { reverseMapLegacyCategory } = jiti("../src/smart-metadata.ts");

describe("reverseMapLegacyCategory decision handling", () => {
  it("maps a legacy decision row to cases, not events", () => {
    assert.equal(
      reverseMapLegacyCategory("decision", "Chose to use LanceDB over Qdrant for local dev"),
      "cases",
    );
  });

  it("maps a legacy decision row with personal-identity text to profile, same as fact", () => {
    const text = "My name is Alex and I decided to move to Berlin";
    assert.equal(
      reverseMapLegacyCategory("decision", text),
      reverseMapLegacyCategory("fact", text),
    );
    assert.equal(reverseMapLegacyCategory("decision", text), "profile");
  });

  it("keeps decision and fact on the identical branch for a case-shaped text", () => {
    const text = "Runbook: restart the ingest worker when the queue backs up";
    assert.equal(
      reverseMapLegacyCategory("decision", text),
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
