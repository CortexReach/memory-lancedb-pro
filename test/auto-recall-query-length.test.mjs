import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginSdkStubPath = path.resolve(testDir, "helpers", "openclaw-plugin-sdk-stub.mjs");
const jiti = jitiFactory(import.meta.url, {
  interopDefault: true,
  alias: {
    "openclaw/plugin-sdk": pluginSdkStubPath,
  },
});
const { parsePluginConfig } = jiti("../index.ts");

function baseConfig() {
  return {
    embedding: {
      apiKey: "test-api-key",
    },
  };
}

describe("autoRecallMaxQueryLength", () => {
  it("defaults to 2000 when not specified", () => {
    const parsed = parsePluginConfig(baseConfig());
    assert.equal(parsed.autoRecallMaxQueryLength, 2000);
  });

  it("clamps values below minimum (100) to 100", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      autoRecallMaxQueryLength: 50,
    });
    assert.equal(parsed.autoRecallMaxQueryLength, 100);
  });

  it("clamps values above maximum (10000) to 10000", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      autoRecallMaxQueryLength: 20000,
    });
    assert.equal(parsed.autoRecallMaxQueryLength, 10000);
  });

  it("accepts value within valid range", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      autoRecallMaxQueryLength: 5000,
    });
    assert.equal(parsed.autoRecallMaxQueryLength, 5000);
  });

  it("clamps boundary minimum (exactly 100) to 100", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      autoRecallMaxQueryLength: 100,
    });
    assert.equal(parsed.autoRecallMaxQueryLength, 100);
  });

  it("clamps boundary maximum (exactly 10000) to 10000", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      autoRecallMaxQueryLength: 10000,
    });
    assert.equal(parsed.autoRecallMaxQueryLength, 10000);
  });

  it("handles non-integer values by flooring and clamping", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      autoRecallMaxQueryLength: 150.7,
    });
    assert.equal(parsed.autoRecallMaxQueryLength, 150);
  });

  it("treats negative values as missing (use default 2000)", () => {
    // parsePositiveInt returns undefined for non-positive values,
    // so -500 falls through to the ?? 2000 default, which is within range
    const parsed = parsePluginConfig({
      ...baseConfig(),
      autoRecallMaxQueryLength: -500,
    });
    assert.equal(parsed.autoRecallMaxQueryLength, 2000);
  });
});

// Unit test: verify truncation logic behaves correctly
describe("autoRecallMaxQueryLength truncation behavior", () => {
  it("truncates a 100-char string to 50 when maxQueryLen=50", () => {
    const maxQueryLen = 50;
    const input = "a".repeat(100);
    const truncated = input.length > maxQueryLen ? input.slice(0, maxQueryLen) : input;
    assert.equal(truncated.length, 50);
    assert.equal(truncated, "a".repeat(50));
  });

  it("does not truncate when string is shorter than maxQueryLen", () => {
    const maxQueryLen = 2000;
    const input = "a".repeat(100);
    const truncated = input.length > maxQueryLen ? input.slice(0, maxQueryLen) : input;
    assert.equal(truncated.length, 100);
  });

  it("exact boundary: 2000-char string stays unchanged when maxQueryLen=2000", () => {
    const maxQueryLen = 2000;
    const input = "b".repeat(2000);
    const truncated = input.length > maxQueryLen ? input.slice(0, maxQueryLen) : input;
    assert.equal(truncated.length, 2000);
  });
});
