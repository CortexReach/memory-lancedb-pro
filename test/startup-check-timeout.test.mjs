import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginSdkStubPath = path.resolve(testDir, "helpers", "openclaw-plugin-sdk-stub.mjs");
const jiti = jitiFactory(import.meta.url, {
  interopDefault: true,
  alias: { "openclaw/plugin-sdk": pluginSdkStubPath },
});

const { parsePluginConfig } = jiti("../index.ts");

describe("startupCheckTimeoutMs config knob", () => {
  it("defaults to the historical 8s budget", () => {
    const cfg = parsePluginConfig({ embedding: { apiKey: "test-api-key" } });
    assert.equal(cfg.startupCheckTimeoutMs, 8000);
  });

  it("honors an explicit override", () => {
    const cfg = parsePluginConfig({ embedding: { apiKey: "test-api-key" }, startupCheckTimeoutMs: 15000 });
    assert.equal(cfg.startupCheckTimeoutMs, 15000);
  });

  it("rejects non-positive values back to the default", () => {
    for (const bad of [0, -5, "nope", Number.NaN]) {
      const cfg = parsePluginConfig({ embedding: { apiKey: "test-api-key" }, startupCheckTimeoutMs: bad });
      assert.equal(cfg.startupCheckTimeoutMs, 8000, `expected default for ${String(bad)}`);
    }
  });
});
