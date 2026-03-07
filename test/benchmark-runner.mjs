#!/usr/bin/env node
/**
 * Standalone Retrieval Benchmark Runner
 *
 * Uses shared benchmark core from src/benchmark.ts.
 * Designed for CI / script usage with stable JSON output.
 *
 * Usage:
 *   node test/benchmark-runner.mjs                  # human-readable
 *   node test/benchmark-runner.mjs --json           # full JSON report
 *   node test/benchmark-runner.mjs --jsonl          # one JSON line per query
 *   node test/benchmark-runner.mjs --strict         # exit 2 on gate failures
 */

import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// jiti loader for TypeScript modules
const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url, { interopDefault: true });

const pluginDir = resolve(__dirname, "..");

// Load shared modules via jiti
const { loadFixtures, runBenchmark, formatBenchmarkText } = jiti(resolve(pluginDir, "src/benchmark.ts"));
const { MemoryStore } = jiti(resolve(pluginDir, "src/store.ts"));
const { MemoryRetriever } = jiti(resolve(pluginDir, "src/retriever.ts"));
const { createEmbedder } = jiti(resolve(pluginDir, "src/embedder.ts"));

// Parse args
const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const jsonlMode = args.includes("--jsonl");
const strictMode = args.includes("--strict");
const fixturesArg = args.find((a, i) => args[i - 1] === "--fixtures");

async function main() {
  // Resolve fixture path
  const fixturesPath = fixturesArg
    ? resolve(fixturesArg)
    : resolve(__dirname, "benchmark-fixtures.json");

  // Load & validate fixtures
  const fixtures = loadFixtures(fixturesPath);
  console.error(`Fixtures loaded: ${fixtures.length} from ${fixturesPath}`);

  // Initialize store + retriever
  const store = new MemoryStore({
    dbPath: resolve(process.env.OPENCLAW_MEMORY_DIR || `${process.env.HOME}/.openclaw/memory/lancedb-pro`),
    tableName: "memories",
  });

  const embedder = createEmbedder({
    provider: process.env.EMBEDDING_PROVIDER || "local",
    model: process.env.EMBEDDING_MODEL || "Qwen3-VL-Embedding-2B",
  });

  const retriever = new MemoryRetriever(store, embedder);

  // Run benchmark
  const report = await runBenchmark(retriever, fixtures, fixturesPath);

  // Output
  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else if (jsonlMode) {
    for (const entry of report.results) {
      console.log(JSON.stringify(entry));
    }
  } else {
    console.log(formatBenchmarkText(report));
  }

  // Exit code
  if (strictMode && report.summary.gateFail > 0) {
    console.error(`\n✘ ${report.summary.gateFail} gate fixture(s) failed.`);
    process.exit(2);
  }

  // Cleanup
  await store.close?.();
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
