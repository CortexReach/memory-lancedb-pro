export interface ScoreRow {
  runner: string;
  overall: {
    recallAt5: number;
    mrr: number;
    ndcgAt5: number;
    llmJudgeAccuracy: number;
    f1: number;
  };
  performance: {
    p50: number;
    p95: number;
    p99: number;
    mean: number;
    min: number;
    max: number;
  };
}

export function formatCliTable(scores: ScoreRow[]): string {
  const header = `| Runner          | LLM-Judge | F1    | Recall@5 | MRR   | p50 (ms) |`;
  const sep = `|-----------------|-----------|-------|----------|-------|----------|`;
  const rows = scores.map(
    (s) =>
      `| ${s.runner.padEnd(15)} | ${s.overall.llmJudgeAccuracy.toFixed(3).padStart(9)} | ${s.overall.f1.toFixed(3).padStart(5)} | ${s.overall.recallAt5.toFixed(3).padStart(8)} | ${s.overall.mrr.toFixed(3).padStart(5)} | ${String(s.performance.p50).padStart(8)} |`,
  );

  const lines = [header, sep, ...rows];

  // Stage gains
  if (scores.length >= 2) {
    const hybrid = scores.find((s) => s.runner.includes("hybrid"));
    const vector = scores.find((s) => s.runner.includes("vector"));
    if (hybrid && vector) {
      const deltaNum =
        (hybrid.overall.llmJudgeAccuracy - vector.overall.llmJudgeAccuracy) *
        100;
      const delta = (deltaNum >= 0 ? "+" : "") + deltaNum.toFixed(0);
      lines.push("");
      lines.push(
        `Pipeline Contribution: +BM25 + Rerank: LLM-Judge ${delta}pp (vector-only → hybrid)`,
      );
    }
  }

  return lines.join("\n");
}
