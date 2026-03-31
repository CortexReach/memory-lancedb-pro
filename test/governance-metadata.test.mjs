import assert from "node:assert/strict";
import { describe, it } from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const {
  parseSmartMetadata,
  buildSmartMetadata,
} = jiti("../src/smart-metadata.ts");

describe("governance metadata compatibility", () => {
  it("fills governance defaults for legacy metadata", () => {
    const meta = parseSmartMetadata(undefined, {
      text: "legacy memory",
      category: "fact",
      importance: 0.7,
      timestamp: 1710000000000,
    });

    assert.equal(meta.state, "confirmed");
    assert.equal(meta.source, "legacy");
    assert.equal(meta.memory_layer, "working");
    assert.equal(meta.injected_count, 0);
    assert.equal(meta.bad_recall_count, 0);
    assert.equal(meta.suppressed_until_turn, 0);
  });

  it("maps session-summary records to archived/reflection defaults", () => {
    const meta = parseSmartMetadata(
      JSON.stringify({ type: "session-summary", l0_abstract: "summary" }),
      {
        text: "summary",
        category: "other",
      },
    );

    assert.equal(meta.source, "session-summary");
    assert.equal(meta.state, "archived");
    assert.equal(meta.memory_layer, "reflection");
  });

  it("buildSmartMetadata preserves and updates governance fields", () => {
    const original = {
      text: "captured note",
      category: "other",
      timestamp: 1710000000000,
      metadata: JSON.stringify({
        state: "pending",
        source: "auto-capture",
        memory_layer: "working",
        injected_count: 2,
        bad_recall_count: 1,
      }),
    };

    const patched = buildSmartMetadata(original, {
      state: "confirmed",
      source: "manual",
      memory_layer: "durable",
      injected_count: 3,
      bad_recall_count: 0,
      last_confirmed_use_at: 1710000001234,
    });

    assert.equal(patched.state, "confirmed");
    assert.equal(patched.source, "manual");
    assert.equal(patched.memory_layer, "durable");
    assert.equal(patched.injected_count, 3);
    assert.equal(patched.bad_recall_count, 0);
    assert.equal(patched.last_confirmed_use_at, 1710000001234);
  });
});
