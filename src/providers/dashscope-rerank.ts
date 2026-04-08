export interface DashScopeRerankRequestOptions {
  model: string;
  query: string;
  candidates: string[];
  topN: number;
  returnDocuments?: boolean;
  fps?: number;
}

const DEFAULT_DASHSCOPE_RERANK_ENDPOINT =
  "https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank";

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

export function resolveDashScopeRerankEndpoint(baseURL?: string): string {
  const raw = baseURL?.trim();
  if (!raw) return DEFAULT_DASHSCOPE_RERANK_ENDPOINT;
  if (raw.includes("/services/rerank/") || raw.includes("/compatible-api/v1/reranks")) return raw;
  if (/dashscope\.aliyuncs\.com/i.test(raw)) return DEFAULT_DASHSCOPE_RERANK_ENDPOINT;
  return raw;
}

interface DashScopeRerankItem {
  index?: number;
  relevance_score?: number;
  score?: number;
}

interface DashScopeRerankResponse {
  output?: {
    results?: DashScopeRerankItem[];
  };
  code?: string;
  message?: string;
}

export interface DashScopeRerankResult {
  index: number;
  score: number;
}

/**
 * Fetch and normalize a DashScope rerank response.
 * Returns items sorted by returned index to guarantee stable alignment.
 */
export async function fetchDashScopeRerank(options: {
  apiKey: string;
  baseURL?: string;
  payload: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<{ results: DashScopeRerankResult[] }> {
  const endpoint = resolveDashScopeRerankEndpoint(options.baseURL);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify(options.payload),
    signal: options.signal,
  });

  const text = await response.text();
  let data: DashScopeRerankResponse = {};
  try {
    data = text ? (JSON.parse(text) as DashScopeRerankResponse) : {};
  } catch {
    // ignore parse failure
  }

  if (!response.ok) {
    const detail = data?.message || text.slice(0, 500) || response.statusText;
    throw new Error(`DashScope rerank failed: ${response.status} ${detail}`);
  }

  const results: DashScopeRerankResult[] = [];
  const rawItems = Array.isArray(data?.output?.results) ? data.output.results : [];
  for (const item of rawItems) {
    const index =
      typeof item?.index === "number" ? item.index : Number(item?.index);
    const scoreRaw =
      item?.relevance_score ?? item?.score ?? NaN;
    const score = Number(scoreRaw);
    if (Number.isFinite(index) && Number.isFinite(score)) {
      results.push({ index, score });
    }
  }

  // Sort by returned index for deterministic alignment with embedMany's validIndices mapping
  results.sort((a, b) => a.index - b.index);

  return { results };
}
