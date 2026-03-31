import type { ScoreRow } from "./cli.js";

export interface ReportEnvironment {
  embeddingModel: string;
  rerankModel?: string;
  llmModel?: string;
  nodeVersion?: string;
  platform?: string;
}

export function generateJson(
  scores: ScoreRow[],
  env: ReportEnvironment,
): string {
  const report = {
    timestamp: new Date().toISOString(),
    environment: {
      ...env,
      nodeVersion: env.nodeVersion ?? process.version,
      platform: env.platform ?? process.platform,
    },
    scores,
  };

  return JSON.stringify(report, null, 2);
}
