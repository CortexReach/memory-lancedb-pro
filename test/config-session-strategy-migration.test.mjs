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

describe("sessionStrategy legacy compatibility mapping", () => {
  it("maps legacy sessionMemory.enabled=true to systemSessionMemory", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      sessionMemory: { enabled: true },
    });
    assert.equal(parsed.sessionStrategy, "systemSessionMemory");
  });

  it("maps legacy sessionMemory.enabled=false to none", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      sessionMemory: { enabled: false },
    });
    assert.equal(parsed.sessionStrategy, "none");
  });

  it("prefers explicit sessionStrategy over legacy sessionMemory.enabled", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      sessionStrategy: "memoryReflection",
      sessionMemory: { enabled: false },
    });
    assert.equal(parsed.sessionStrategy, "memoryReflection");
  });

  it("defaults to none when neither field is set", () => {
    const parsed = parsePluginConfig(baseConfig());
    assert.equal(parsed.sessionStrategy, "none");
  });

  it("preserves embedding.chunking when explicitly configured", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      embedding: {
        ...baseConfig().embedding,
        chunking: false,
      },
    });
    assert.equal(parsed.embedding.chunking, false);
  });

  it("defaults embedding.requestDimensions to true", () => {
    const parsed = parsePluginConfig(baseConfig());
    assert.equal(parsed.embedding.requestDimensions, true);
  });

  it("preserves explicit embedding.requestDimensions=false", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      embedding: {
        ...baseConfig().embedding,
        requestDimensions: false,
      },
    });
    assert.equal(parsed.embedding.requestDimensions, false);
  });

  it("defaults retrieval.timeoutMs to 5000", () => {
    const parsed = parsePluginConfig(baseConfig());
    assert.equal(parsed.retrieval?.timeoutMs, 5000);
  });

  it("preserves explicit retrieval.timeoutMs", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      retrieval: { timeoutMs: 15000 },
    });
    assert.equal(parsed.retrieval?.timeoutMs, 15000);
  });

  it("falls back to 5000 when retrieval.timeoutMs is invalid", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      retrieval: { timeoutMs: 0 },
    });
    assert.equal(parsed.retrieval?.timeoutMs, 5000);
  });
});
