import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const { parsePluginConfig, shouldCapture } = jiti("../index.ts");

function baseConfig(overrides = {}) {
  return {
    embedding: {
      provider: "openai-compatible",
      apiKey: "test",
    },
    ...overrides,
  };
}

describe("autoRecallFormat config", () => {
  it("defaults to plain", () => {
    const cfg = parsePluginConfig(baseConfig());
    assert.equal(cfg.autoRecallFormat, "plain");
  });

  it("accepts xml", () => {
    const cfg = parsePluginConfig(baseConfig({ autoRecallFormat: "xml" }));
    assert.equal(cfg.autoRecallFormat, "xml");
  });
});

describe("autoRecall markers are excluded from capture", () => {
  it("skips xml marker", () => {
    const text = "<relevant-memories>\nfoo\n</relevant-memories>";
    assert.equal(shouldCapture(text), false);
  });

  it("skips plain marker", () => {
    const text = "[memory-context-start]\nfoo\n[memory-context-end]";
    assert.equal(shouldCapture(text), false);
  });
});
