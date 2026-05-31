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

describe("plugin config error hints", () => {
  it("explains undefined config as a preflight/activation mismatch", () => {
    assert.throws(
      () => parsePluginConfig(undefined),
      /no plugin config supplied.*top-level config\.embedding.*preflight/i,
    );
  });

  it("explains non-object config shape clearly", () => {
    assert.throws(
      () => parsePluginConfig("not-json"),
      /plugin config must be an object.*plugins\.entries\.memory-lancedb-pro\.config\.embedding/i,
    );
  });

  it("explains missing embedding as a top-level config shape issue", () => {
    assert.throws(
      () => parsePluginConfig({ enabled: true }),
      /missing top-level config\.embedding.*do not nest it as config\.embedding\.embedding/i,
    );
  });
});

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
});
