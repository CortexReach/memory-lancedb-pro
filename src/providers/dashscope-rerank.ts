export interface DashScopeRerankRequestOptions {
  model: string;
  query: string;
  candidates: string[];
  topN: number;
  returnDocuments?: boolean;
  fps?: number;
}

export function buildDashScopeRerankRequest(
  options: DashScopeRerankRequestOptions,
): Record<string, unknown> {
  if (options.model === "qwen3-vl-rerank") {
    return {
      model: options.model,
      input: {
        query: options.query,
        documents: options.candidates,
      },
      parameters: {
        top_n: options.topN,
        return_documents: options.returnDocuments !== false,
        ...(typeof options.fps === "number" ? { fps: options.fps } : {}),
      },
    };
  }

  return {
    model: options.model,
    query: options.query,
    documents: options.candidates,
    top_n: options.topN,
  };
}
