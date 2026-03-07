/**
 * Benchmark Core Module
 *
 * Shared logic for retrieval benchmarking. Used by both CLI and runner.
 * All fixture loading, validation, execution, and evaluation lives here.
 *
 * Architecture note: The upstream retrieval pipeline uses Jina AI as the
 * unified embedding + reranking provider (jina-embeddings-v3 / jina-reranker-v3).
 * Rerank 422 errors in benchmark results typically indicate Jina API format
 * constraints. When reranker is unavailable, the pipeline falls back to local
 * cosine similarity reranking.
 */

import { readFileSync } from "node:fs";
import type { MemoryRetriever, RetrievalExecution, RetrievalResult } from "./retriever.js";

// ============================================================================
// Types
// ============================================================================

export type FixtureLevel = "smoke" | "baseline" | "gate";

export interface BenchmarkFixture {
  id: string;
  category: string;
  query: string;
  level?: FixtureLevel;
  strict?: boolean;
  datasetAssumption?: string;
  expectedBehavior?: string;
  expect?: {
    minResults?: number;
    maxResults?: number;
    top1Contains?: string;
    top1MustNotContain?: string;
    top1MinScore?: number;
    top1MaxScore?: number;
    note?: string;
  };
}

export interface BenchmarkTopHit {
  rank: number;
  id: string;
  text: string;
  score: number;
  category: string;
  source: string;
}

export interface BenchmarkScoreTrail {
  id: string;
  trail: Array<{ stage: string; score: number; delta: number }>;
}

export interface BenchmarkEntry {
  id: string;
  category: string;
  level: FixtureLevel;
  query: string;
  latencyMs: number;
  resultCount: number;
  topHits: BenchmarkTopHit[];
  scoreTrails: BenchmarkScoreTrail[];
  traceSummary: {
    mode: string;
    stages: Array<{ name: string; in: number; out: number }>;
  };
  expectation: BenchmarkFixture["expect"];
  passed: boolean;
  zeroResult: boolean;
  failureReasons: string[];
  error?: string;
}

export interface BenchmarkSummary {
  totalQueries: number;
  zeroResultQueries: number;
  passedExpectations: number;
  failedExpectations: number;
  totalLatencyMs: number;
  avgLatencyMs: number;
  gatePass: number;
  gateFail: number;
  baselinePass: number;
  baselineFail: number;
  informationalOnly: number;
}

export interface BenchmarkReport {
  timestamp: string;
  fixtureSource: string;
  fixtureCount: number;
  results: BenchmarkEntry[];
  summary: BenchmarkSummary;
}

// ============================================================================
// Fixture Loading & Validation
// ============================================================================

export function loadFixtures(path: string): BenchmarkFixture[] {
  const raw = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in fixture file: ${path}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Fixture file must contain a JSON array: ${path}`);
  }

  return validateFixtures(parsed, path);
}

export function validateFixtures(
  fixtures: unknown[],
  sourcePath: string,
): BenchmarkFixture[] {
  const validated: BenchmarkFixture[] = [];

  for (let i = 0; i < fixtures.length; i++) {
    const f = fixtures[i] as Record<string, unknown>;
    const errors: string[] = [];

    if (!f || typeof f !== "object") {
      errors.push("must be an object");
    } else {
      if (typeof f.id !== "string" || !f.id) errors.push("missing or invalid 'id'");
      if (typeof f.query !== "string" || !f.query) errors.push("missing or invalid 'query'");
      if (typeof f.category !== "string") errors.push("missing or invalid 'category'");
      if (f.level !== undefined && !["smoke", "baseline", "gate"].includes(f.level as string)) {
        errors.push(`invalid 'level': ${f.level} (must be smoke|baseline|gate)`);
      }
    }

    if (errors.length > 0) {
      throw new Error(
        `Fixture validation failed at index ${i} in ${sourcePath}: ${errors.join(", ")}`,
      );
    }

    validated.push({
      id: f.id as string,
      category: f.category as string,
      query: f.query as string,
      level: (f.level as FixtureLevel) || "baseline",
      strict: typeof f.strict === "boolean" ? f.strict : undefined,
      datasetAssumption: f.datasetAssumption as string | undefined,
      expectedBehavior: f.expectedBehavior as string | undefined,
      expect: f.expect as BenchmarkFixture["expect"],
    });
  }

  return validated;
}

// ============================================================================
// Evaluation
// ============================================================================

export function evaluateFixture(
  fixture: BenchmarkFixture,
  results: RetrievalResult[],
): { passed: boolean; reasons: string[] } {
  const expect = fixture.expect;
  if (!expect) return { passed: true, reasons: [] };

  const reasons: string[] = [];

  if (expect.minResults !== undefined && results.length < expect.minResults) {
    reasons.push(`resultCount ${results.length} < minResults ${expect.minResults}`);
  }
  if (expect.maxResults !== undefined && results.length > expect.maxResults) {
    reasons.push(`resultCount ${results.length} > maxResults ${expect.maxResults}`);
  }
  if (expect.top1Contains && results.length > 0) {
    if (!results[0].entry.text.includes(expect.top1Contains)) {
      reasons.push(`top1 does not contain "${expect.top1Contains}"`);
    }
  }
  if (expect.top1MustNotContain && results.length > 0) {
    if (results[0].entry.text.includes(expect.top1MustNotContain)) {
      reasons.push(`top1 must not contain "${expect.top1MustNotContain}"`);
    }
  }
  if (expect.top1MinScore !== undefined && results.length > 0) {
    if (results[0].score < expect.top1MinScore) {
      reasons.push(`top1 score ${results[0].score.toFixed(4)} < minScore ${expect.top1MinScore}`);
    }
  }
  if (expect.top1MaxScore !== undefined && results.length > 0) {
    if (results[0].score > expect.top1MaxScore) {
      reasons.push(`top1 score ${results[0].score.toFixed(4)} > maxScore ${expect.top1MaxScore}`);
    }
  }

  return { passed: reasons.length === 0, reasons };
}

// ============================================================================
// Benchmark Runner
// ============================================================================

export async function runBenchmark(
  retriever: MemoryRetriever,
  fixtures: BenchmarkFixture[],
  fixtureSource: string,
): Promise<BenchmarkReport> {
  const report: BenchmarkReport = {
    timestamp: new Date().toISOString(),
    fixtureSource,
    fixtureCount: fixtures.length,
    results: [],
    summary: {
      totalQueries: 0,
      zeroResultQueries: 0,
      passedExpectations: 0,
      failedExpectations: 0,
      totalLatencyMs: 0,
      avgLatencyMs: 0,
      gatePass: 0,
      gateFail: 0,
      baselinePass: 0,
      baselineFail: 0,
      informationalOnly: 0,
    },
  };

  for (const fixture of fixtures) {
    const level = fixture.level || "baseline";
    const startMs = Date.now();

    let execution: RetrievalExecution;
    try {
      execution = await retriever.retrieveWithTrace({
        query: fixture.query,
        limit: 10,
        source: "cli",
      });
    } catch (err) {
      const entry: BenchmarkEntry = {
        id: fixture.id,
        category: fixture.category,
        level,
        query: fixture.query,
        error: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - startMs,
        resultCount: 0,
        topHits: [],
        scoreTrails: [],
        traceSummary: { mode: "error", stages: [] },
        expectation: fixture.expect,
        passed: false,
        zeroResult: true,
        failureReasons: ["execution error"],
      };
      report.results.push(entry);
      report.summary.totalQueries++;
      report.summary.zeroResultQueries++;
      report.summary.failedExpectations++;
      if (level === "gate") report.summary.gateFail++;
      else if (level === "baseline") report.summary.baselineFail++;
      else report.summary.informationalOnly++;
      continue;
    }

    const latencyMs = Date.now() - startMs;
    const { results, trace } = execution;

    const topHits: BenchmarkTopHit[] = results.slice(0, 3).map((r, i) => ({
      rank: i + 1,
      id: r.entry.id,
      text: r.entry.text.slice(0, 100),
      score: Number(r.score.toFixed(4)),
      category: r.entry.category,
      source: r.sources.reranked ? "reranked" :
              r.sources.bm25 && r.sources.vector ? "hybrid" :
              r.sources.bm25 ? "bm25" : "vector",
    }));

    const scoreTrails: BenchmarkScoreTrail[] = results.slice(0, 3).map((r) => ({
      id: r.entry.id,
      trail: (r.scoreHistory || []).map((s) => ({
        stage: s.stage,
        score: Number(s.score.toFixed(4)),
        delta: Number(s.delta.toFixed(4)),
      })),
    }));

    const traceSummary = {
      mode: trace.mode,
      stages: trace.stages.map((s) => ({
        name: s.name,
        in: s.inputCount,
        out: s.outputCount,
      })),
    };

    const { passed, reasons } = evaluateFixture(fixture, results);
    const zeroResult = results.length === 0;

    const entry: BenchmarkEntry = {
      id: fixture.id,
      category: fixture.category,
      level,
      query: fixture.query,
      latencyMs,
      resultCount: results.length,
      topHits,
      scoreTrails,
      traceSummary,
      expectation: fixture.expect,
      passed,
      zeroResult,
      failureReasons: reasons,
    };

    report.results.push(entry);
    report.summary.totalQueries++;
    report.summary.totalLatencyMs += latencyMs;
    if (zeroResult) report.summary.zeroResultQueries++;

    if (level === "smoke") {
      report.summary.informationalOnly++;
    } else if (level === "gate") {
      if (passed) report.summary.gatePass++;
      else report.summary.gateFail++;
    } else {
      // baseline
      if (passed) report.summary.baselinePass++;
      else report.summary.baselineFail++;
    }

    if (passed) report.summary.passedExpectations++;
    else report.summary.failedExpectations++;
  }

  report.summary.avgLatencyMs = report.summary.totalQueries > 0
    ? Number((report.summary.totalLatencyMs / report.summary.totalQueries).toFixed(1))
    : 0;

  return report;
}

// ============================================================================
// Format Helpers
// ============================================================================

export function formatBenchmarkText(report: BenchmarkReport): string {
  const s = report.summary;
  const lines: string[] = [];

  lines.push(`\nRetrieval Benchmark Report`);
  lines.push(`${"=".repeat(70)}`);
  lines.push(`Fixture source: ${report.fixtureSource}`);
  lines.push(`Timestamp: ${report.timestamp}`);
  lines.push(`Total: ${s.totalQueries} queries\n`);

  for (const r of report.results) {
    const status = r.passed ? "✔" : "✘";
    const levelTag = r.level !== "baseline" ? ` [${r.level.toUpperCase()}]` : "";
    const zeroTag = r.zeroResult ? " [ZERO]" : "";
    lines.push(`${status} [${r.category}] ${r.id}${levelTag}${zeroTag}`);
    lines.push(`  query: "${r.query}"`);
    lines.push(`  results: ${r.resultCount}, latency: ${r.latencyMs}ms`);

    if (r.error) {
      lines.push(`  error: ${r.error}`);
    }

    if (r.topHits.length > 0) {
      for (const hit of r.topHits) {
        lines.push(`  #${hit.rank}: [${hit.source}] ${(hit.score * 100).toFixed(0)}% "${hit.text.slice(0, 60)}..."`);
      }
    }

    if (r.scoreTrails.length > 0) {
      for (const trail of r.scoreTrails) {
        if (trail.trail.length > 0) {
          const steps = trail.trail.map((st) => `${st.stage}=${(st.score * 100).toFixed(0)}%`).join(" → ");
          lines.push(`  trail: ${steps}`);
        }
      }
    }

    if (r.failureReasons.length > 0) {
      lines.push(`  failures: ${r.failureReasons.join("; ")}`);
    }
    lines.push("");
  }

  lines.push(`${"=".repeat(70)}`);
  lines.push(`Passed: ${s.passedExpectations}/${s.totalQueries}`);
  if (s.gatePass + s.gateFail > 0) {
    lines.push(`Gate: ${s.gatePass}/${s.gatePass + s.gateFail} passed`);
  }
  if (s.baselinePass + s.baselineFail > 0) {
    lines.push(`Baseline: ${s.baselinePass}/${s.baselinePass + s.baselineFail} passed`);
  }
  if (s.informationalOnly > 0) {
    lines.push(`Smoke/Info: ${s.informationalOnly}`);
  }
  lines.push(`Zero-hit: ${s.zeroResultQueries}`);
  lines.push(`Avg latency: ${s.avgLatencyMs}ms`);

  return lines.join("\n");
}
