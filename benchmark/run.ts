import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";

import { ProHybridRunner } from "./runners/pro-hybrid.js";
import { ProVectorOnlyRunner } from "./runners/pro-vector-only.js";
import type { BenchmarkRunner } from "./runners/types.js";
import type { RunnerConfig } from "./runners/types.js";
import { computePercentiles } from "./metrics/performance.js";
import { tokenF1, llmJudge } from "./metrics/end-to-end.js";
import { formatCliTable, type ScoreRow } from "./report/cli.js";
import { generateJson } from "./report/json.js";
import { generateMarkdown } from "./report/markdown.js";
import {
  extractFacts,
  flattenTurns,
  factsToMemories,
  generateAnswer,
  type LoCoMoConversation,
} from "./adapters/locomo-adapter.js";

// ============================================================================
// CLI Argument Parsing
// ============================================================================

const { values: args } = parseArgs({
  options: {
    runner: { type: "string" },
    benchmark: { type: "string", default: "locomo" },
    profile: { type: "string", default: "max-recall" },
  },
});

// ============================================================================
// Environment Validation
// ============================================================================

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

const EMBEDDING_API_KEY = requireEnv("EMBEDDING_API_KEY");
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";
const EMBEDDING_BASE_URL = process.env.EMBEDDING_BASE_URL;
const EMBEDDING_DIMENSIONS = process.env.EMBEDDING_DIMENSIONS
  ? parseInt(process.env.EMBEDDING_DIMENSIONS)
  : undefined;
const LLM_API_KEY = requireEnv("LLM_API_KEY");
const LLM_MODEL = process.env.LLM_MODEL ?? "gpt-4o-mini";
const LLM_BASE_URL = process.env.LLM_BASE_URL;
const RERANK_API_KEY = process.env.RERANK_API_KEY;
const RERANK_MODEL = process.env.RERANK_MODEL;
const RERANK_ENDPOINT = process.env.RERANK_ENDPOINT;

// ============================================================================
// Resolve __dirname for ESM
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================================
// Runner Setup
// ============================================================================

const runnerConfig: RunnerConfig = {
  embeddingConfig: {
    provider: "openai-compatible",
    apiKey: EMBEDDING_API_KEY,
    model: EMBEDDING_MODEL,
    baseURL: EMBEDDING_BASE_URL,
    dimensions: EMBEDDING_DIMENSIONS,
  },
  rerankApiKey: RERANK_API_KEY,
  rerankModel: RERANK_MODEL,
  rerankEndpoint: RERANK_ENDPOINT,
};

function createRunners(): BenchmarkRunner[] {
  const all: BenchmarkRunner[] = [
    new ProHybridRunner(runnerConfig),
    new ProVectorOnlyRunner(runnerConfig),
  ];

  if (args.runner) {
    const filtered = all.filter((r) => r.name === args.runner);
    if (filtered.length === 0) {
      console.error(
        `Unknown runner: ${args.runner}. Available: ${all.map((r) => r.name).join(", ")}`,
      );
      process.exit(1);
    }
    return filtered;
  }

  return all;
}

// ============================================================================
// LoCoMo Benchmark
// ============================================================================

async function runLoComoBenchmark(runners: BenchmarkRunner[]): Promise<ScoreRow[]> {
  const dataPath = join(__dirname, "data", "locomo10.json");
  if (!existsSync(dataPath)) {
    console.error(`LoCoMo data not found at ${dataPath}`);
    console.error("Download from: https://github.com/snap-research/locomo");
    process.exit(1);
  }

  const conversations: LoCoMoConversation[] = JSON.parse(readFileSync(dataPath, "utf-8"));
  const llmClient = new OpenAI({
    apiKey: LLM_API_KEY,
    ...(LLM_BASE_URL ? { baseURL: LLM_BASE_URL } : {}),
  });
  const scores: ScoreRow[] = [];

  for (const runner of runners) {
    console.log(`\n=== Runner: ${runner.name} ===`);

    let totalCorrect = 0;
    let totalF1 = 0;
    let totalQueries = 0;

    for (const conv of conversations) {
      console.log(`  Processing conversation ${conv.conversation_id}...`);

      // 1. Extract facts from conversation turns
      const turns = flattenTurns(conv);
      const allFacts: Array<{ text: string; turnIndex: number }> = [];
      for (const turn of turns) {
        const facts = await extractFacts(turn, llmClient, LLM_MODEL);
        allFacts.push(...facts);
      }
      console.log(`    Extracted ${allFacts.length} facts from ${turns.length} turns`);

      // 2. Convert to memories and seed runner
      const memories = factsToMemories(allFacts, conv.conversation_id);
      await runner.seed(memories);

      // 3. Run QA pairs (categories 1-4 only, skip 5 per industry convention)
      const qaPairs = conv.qa_pairs.filter((qa) => qa.category >= 1 && qa.category <= 4);

      for (const qa of qaPairs) {
        const results = await runner.query({
          id: `${conv.conversation_id}-q-${totalQueries}`,
          text: qa.question,
          relevantMemoryIds: [],
          intent: "semantic",
          goldAnswer: qa.answer,
        });

        // Generate answer from retrieved memories
        const memoryTexts = results.map((r) => {
          const mem = memories.find((m) => m.id === r.id);
          return { text: mem?.text ?? "", score: r.score };
        });

        const predicted = await generateAnswer(memoryTexts, qa.question, llmClient, LLM_MODEL);

        // Judge
        const judgment = await llmJudge(qa.question, predicted, qa.answer, llmClient, LLM_MODEL);
        const f1 = tokenF1(predicted, qa.answer);

        if (judgment.correct) totalCorrect++;
        totalF1 += f1;
        totalQueries++;

        if (totalQueries % 10 === 0) {
          console.log(`    Progress: ${totalQueries} queries processed`);
        }
      }

      // Teardown for this conversation (fresh DB for next)
      await runner.teardown();
    }

    const latency = computePercentiles(runner.timings.queryMs);

    scores.push({
      runner: runner.name,
      overall: {
        recallAt5: 0,
        mrr: 0,
        ndcgAt5: 0,
        llmJudgeAccuracy: totalQueries > 0 ? totalCorrect / totalQueries : 0,
        f1: totalQueries > 0 ? totalF1 / totalQueries : 0,
      },
      performance: latency,
    });

    console.log(
      `  Results: LLM-Judge=${(totalCorrect / Math.max(totalQueries, 1)).toFixed(3)}, ` +
        `F1=${(totalF1 / Math.max(totalQueries, 1)).toFixed(3)}, ` +
        `Queries=${totalQueries}`,
    );
  }

  return scores;
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log("memory-lancedb-pro benchmark framework v1");
  console.log(`Benchmark: ${args.benchmark} | Profile: ${args.profile}`);
  console.log(`Embedding: ${EMBEDDING_MODEL} | LLM: ${LLM_MODEL}`);
  if (RERANK_API_KEY) console.log(`Rerank: ${RERANK_MODEL ?? "default"}`);
  console.log("---");

  const runners = createRunners();
  let scores: ScoreRow[];

  if (args.benchmark === "locomo") {
    scores = await runLoComoBenchmark(runners);
  } else {
    console.error(`Unknown benchmark: ${args.benchmark}. Available: locomo`);
    process.exit(1);
  }

  // Output CLI report
  console.log("\n" + formatCliTable(scores));

  // Save reports
  const resultsDir = join(__dirname, "results");
  if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });

  const date = new Date().toISOString().split("T")[0];
  const env = {
    embeddingModel: EMBEDDING_MODEL,
    rerankModel: RERANK_MODEL,
    llmModel: LLM_MODEL,
  };

  const jsonPath = join(resultsDir, `${date}-results.json`);
  const mdPath = join(resultsDir, `${date}-report.md`);

  writeFileSync(jsonPath, generateJson(scores, env));
  writeFileSync(mdPath, generateMarkdown(scores, env));

  console.log(`\nReports saved:`);
  console.log(`  JSON: ${jsonPath}`);
  console.log(`  Markdown: ${mdPath}`);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
