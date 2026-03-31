import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const { ProHybridRunner } = jiti("../benchmark/runners/pro-hybrid.ts");
const { ProVectorOnlyRunner } = jiti("../benchmark/runners/pro-vector-only.ts");

describe("benchmark runner", () => {
  it("ProHybridRunner should implement BenchmarkRunner interface", () => {
    const runner = new ProHybridRunner({
      embeddingConfig: {
        provider: "openai-compatible",
        apiKey: "test-key",
        model: "text-embedding-3-small",
        baseURL: "http://localhost:11434/v1",
      },
    });
    assert.strictEqual(runner.name, "pro-hybrid");
    assert.strictEqual(typeof runner.seed, "function");
    assert.strictEqual(typeof runner.query, "function");
    assert.strictEqual(typeof runner.teardown, "function");
    assert.ok(Array.isArray(runner.fallbackEvents));
    assert.ok(Array.isArray(runner.timings.seedMs));
    assert.ok(Array.isArray(runner.timings.queryMs));
  });

  it("ProVectorOnlyRunner should implement BenchmarkRunner interface", () => {
    const runner = new ProVectorOnlyRunner({
      embeddingConfig: {
        provider: "openai-compatible",
        apiKey: "test-key",
        model: "text-embedding-3-small",
      },
    });
    assert.strictEqual(runner.name, "pro-vector-only");
    assert.strictEqual(typeof runner.seed, "function");
    assert.strictEqual(typeof runner.query, "function");
    assert.strictEqual(typeof runner.teardown, "function");
    assert.ok(Array.isArray(runner.fallbackEvents));
    assert.ok(Array.isArray(runner.timings.seedMs));
    assert.ok(Array.isArray(runner.timings.queryMs));
  });
});
