const DEFAULT_DASHSCOPE_EMBEDDING_ENDPOINT =
  "https://dashscope.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding";

export interface DashScopeEmbeddingRequestOptions {
  model: string;
  input: string | string[];
  dimensions?: number;
  enableFusion?: boolean;
}

export interface DashScopeEmbeddingFetchOptions {
  apiKey: string;
  baseURL?: string;
  payload: Record<string, unknown>;
  signal?: AbortSignal;
}

interface DashScopeEmbeddingItem {
  embedding?: number[];
  index?: number;
}

interface DashScopeEmbeddingResponse {
  output?: {
    embeddings?: DashScopeEmbeddingItem[];
  };
  code?: string;
  message?: string;
}

export function resolveDashScopeEmbeddingEndpoint(baseURL?: string): string {
  const raw = baseURL?.trim();
  if (!raw) return DEFAULT_DASHSCOPE_EMBEDDING_ENDPOINT;

  if (raw.includes("/services/embeddings/")) {
    return raw;
  }

  if (/dashscope\.aliyuncs\.com/i.test(raw)) {
    return DEFAULT_DASHSCOPE_EMBEDDING_ENDPOINT;
  }

  return raw;
}

export function buildDashScopeEmbeddingPayload(
  options: DashScopeEmbeddingRequestOptions,
): Record<string, unknown> {
  const texts = Array.isArray(options.input) ? options.input : [options.input];

  return {
    model: options.model,
    input: {
      contents: texts.map((text) => ({ text })),
    },
    parameters: {
      ...(options.dimensions && options.dimensions > 0
        ? { dimension: options.dimensions }
        : {}),
      enable_fusion: options.enableFusion !== false,
    },
  };
}

export function normalizeDashScopeEmbeddingResponse(
  data: DashScopeEmbeddingResponse,
): { data: Array<{ embedding: number[]; index: number }> } {
  const embeddings = Array.isArray(data?.output?.embeddings)
    ? data.output.embeddings
    : [];

  return {
    data: embeddings
      .map((item, index) => ({
        embedding: Array.isArray(item?.embedding) ? item.embedding : [],
        index: typeof item?.index === "number" ? item.index : index,
      }))
      .filter((item) => item.embedding.length > 0),
  };
}

export async function fetchDashScopeEmbeddings(
  options: DashScopeEmbeddingFetchOptions,
): Promise<{ data: Array<{ embedding: number[]; index: number }> }> {
  const endpoint = resolveDashScopeEmbeddingEndpoint(options.baseURL);
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
  let data: DashScopeEmbeddingResponse = {};
  try {
    data = text ? (JSON.parse(text) as DashScopeEmbeddingResponse) : {};
  } catch {
    // ignore parse failure, handled below
  }

  if (!response.ok) {
    const detail = data?.message || text.slice(0, 500) || response.statusText;
    throw new Error(`DashScope embedding failed: ${response.status} ${detail}`);
  }

  const normalized = normalizeDashScopeEmbeddingResponse(data);
  if (!Array.isArray(normalized.data) || normalized.data.length === 0) {
    throw new Error("DashScope embedding returned no embeddings");
  }

  return normalized;
}
