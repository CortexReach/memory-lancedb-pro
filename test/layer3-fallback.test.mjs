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
const {
  analyzeLayer3FallbackNeed,
  resolveLayer3FallbackSettings,
  extractCandidateJson,
  safeParseJson,
} = jiti("../src/tools.ts");

function baseConfig() {
  return {
    embedding: {
      apiKey: "test-api-key",
    },
  };
}

describe("layer3 fallback config", () => {
  it("defaults to disabled for backward compatibility", () => {
    const parsed = parsePluginConfig(baseConfig());
    assert.equal(parsed.layer3Fallback, undefined);
    const resolved = resolveLayer3FallbackSettings(parsed.layer3Fallback);
    assert.equal(resolved.enabled, false);
    assert.equal(resolved.agent, "notebooklm");
    assert.equal(resolved.timeout, 45);
  });

  it("parses explicit layer3 fallback settings", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      layer3Fallback: {
        enabled: true,
        agent: "notebooklm",
        notebook: "memory-archive",
        notebookId: "94f8",
        timeout: 75,
        triggers: {
          minResults: 4,
          minScore: 0.6,
          minAvgScore: 0.45,
          timeKeywords: ["今天"],
        },
      },
    });
    assert.equal(parsed.layer3Fallback?.enabled, true);
    assert.equal(parsed.layer3Fallback?.timeout, 75);
    assert.equal(parsed.layer3Fallback?.triggers?.minResults, 4);
    assert.deepEqual(parsed.layer3Fallback?.triggers?.timeKeywords, ["今天"]);
  });
});

describe("layer3 fallback JSON parsing", () => {
  it("extracts the real JSON object after plugin banner lines", () => {
    const raw = [
      "[plugins] memory-lancedb-pro: smart extraction enabled",
      "[plugins] mdMirror: resolved 13 agent workspace(s)",
      JSON.stringify({
        runId: "abc",
        status: "ok",
        result: {
          payloads: [{ text: "Layer 3 answer" }],
        },
      }, null, 2),
    ].join("\n");

    const candidate = extractCandidateJson(raw);
    assert.ok(candidate);
    assert.equal(JSON.parse(candidate).result.payloads[0].text, "Layer 3 answer");
  });

  it("parses banner-prefixed openclaw --json output via extracted mode", () => {
    const raw = [
      "[plugins] memory-lancedb-pro: smart extraction enabled",
      JSON.stringify({
        runId: "abc",
        status: "ok",
        result: {
          payloads: [{ text: "Notebook result" }],
        },
      }),
    ].join("\n");

    const parsed = safeParseJson(raw);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.mode, "extracted");
    assert.equal(parsed.value.result.payloads[0].text, "Notebook result");
  });
});

describe("layer3 fallback trigger analysis", () => {
  const enabledConfig = { enabled: true };

  it("triggers for time-sensitive queries", () => {
    const analysis = analyzeLayer3FallbackNeed("2026-03-14 今天完成了哪些优化工作？", [{ score: 0.92 }], enabledConfig);
    assert.equal(analysis.shouldFallback, true);
    assert.ok(analysis.reasons.includes("time-sensitive-query"));
  });

  it("triggers for reasoning queries", () => {
    const analysis = analyzeLayer3FallbackNeed("为什么要用 NotebookLM 做深度查询？", [{ score: 0.91 }, { score: 0.88 }, { score: 0.81 }], enabledConfig);
    assert.equal(analysis.shouldFallback, true);
    assert.ok(analysis.reasons.includes("reasoning-query"));
  });

  it("triggers for insufficient results", () => {
    const analysis = analyzeLayer3FallbackNeed("xyz123abc", [], enabledConfig);
    assert.equal(analysis.shouldFallback, true);
    assert.ok(analysis.reasons.includes("insufficient-results"));
  });

  it("does not trigger for precise entity query with strong results", () => {
    const analysis = analyzeLayer3FallbackNeed(
      "晨星的核心偏好",
      [{ score: 0.96 }, { score: 0.9 }, { score: 0.88 }],
      enabledConfig,
    );
    assert.equal(analysis.shouldFallback, false);
    assert.deepEqual(analysis.reasons, []);
  });

  it("does not trigger for focused technical entity query with strong results", () => {
    const analysis = analyzeLayer3FallbackNeed(
      "Ollama batch embedding",
      [{ score: 0.94 }, { score: 0.89 }, { score: 0.84 }],
      enabledConfig,
    );
    assert.equal(analysis.shouldFallback, false);
    assert.deepEqual(analysis.reasons, []);
  });
});
