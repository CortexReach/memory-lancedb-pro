import { describe, it } from "node:test";
import assert from "node:assert";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const { formatCliTable } = jiti("../benchmark/report/cli.ts");
const { generateJson } = jiti("../benchmark/report/json.ts");
const { generateMarkdown } = jiti("../benchmark/report/markdown.ts");

describe("report generators", () => {
  const mockScores = [
    {
      runner: "pro-hybrid",
      overall: { recallAt5: 0.82, mrr: 0.76, ndcgAt5: 0.79, llmJudgeAccuracy: 0.65, f1: 0.58 },
      performance: { p50: 120, p95: 250, p99: 400, mean: 140, min: 50, max: 500 },
    },
    {
      runner: "pro-vector-only",
      overall: { recallAt5: 0.65, mrr: 0.60, ndcgAt5: 0.63, llmJudgeAccuracy: 0.52, f1: 0.45 },
      performance: { p50: 85, p95: 180, p99: 300, mean: 95, min: 40, max: 350 },
    },
  ];

  it("formatCliTable should produce table with runner names", () => {
    const output = formatCliTable(mockScores);
    assert.ok(output.includes("pro-hybrid"));
    assert.ok(output.includes("pro-vector-only"));
    assert.ok(output.includes("LLM-Judge"));
  });

  it("formatCliTable should include pipeline contribution", () => {
    const output = formatCliTable(mockScores);
    assert.ok(output.includes("Pipeline Contribution"));
    assert.ok(output.includes("+13pp"));
  });

  it("generateJson should produce valid JSON with timestamp", () => {
    const json = generateJson(mockScores, { embeddingModel: "text-embedding-3-small" });
    const parsed = JSON.parse(json);
    assert.ok(parsed.timestamp);
    assert.strictEqual(parsed.scores.length, 2);
    assert.strictEqual(parsed.environment.embeddingModel, "text-embedding-3-small");
  });

  it("generateMarkdown should include header and methodology", () => {
    const md = generateMarkdown(mockScores, { embeddingModel: "test-model", llmModel: "gpt-4o-mini" });
    assert.ok(md.includes("# Benchmark Report"));
    assert.ok(md.includes("Methodology"));
    assert.ok(md.includes("test-model"));
  });
});
