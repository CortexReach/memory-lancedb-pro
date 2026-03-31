export function recallAtK(retrievedIds: string[], relevantIds: string[], k: number): number {
  if (relevantIds.length === 0) return 0;
  const topK = retrievedIds.slice(0, k);
  const hits = topK.filter((id) => relevantIds.includes(id)).length;
  return hits / relevantIds.length;
}

export function mrr(retrievedIds: string[], relevantIds: string[]): number {
  const relevantSet = new Set(relevantIds);
  for (let i = 0; i < retrievedIds.length; i++) {
    if (relevantSet.has(retrievedIds[i])) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

export function ndcgAtK(retrievedIds: string[], relevantIds: string[], k: number): number {
  const topK = retrievedIds.slice(0, k);
  let dcg = 0;
  for (let i = 0; i < topK.length; i++) {
    const relIdx = relevantIds.indexOf(topK[i]);
    if (relIdx >= 0) {
      const relevance = relevantIds.length - relIdx;
      dcg += relevance / Math.log2(i + 2);
    }
  }
  let idcg = 0;
  const idealK = Math.min(k, relevantIds.length);
  for (let i = 0; i < idealK; i++) {
    const relevance = relevantIds.length - i;
    idcg += relevance / Math.log2(i + 2);
  }
  return idcg === 0 ? 0 : dcg / idcg;
}

export interface RetrievalMetricResult {
  recallAt5: number;
  mrr: number;
  ndcgAt5: number;
}

export function computeRetrievalMetrics(
  retrievedIds: string[],
  relevantIds: string[],
): RetrievalMetricResult {
  return {
    recallAt5: recallAtK(retrievedIds, relevantIds, 5),
    mrr: mrr(retrievedIds, relevantIds),
    ndcgAt5: ndcgAtK(retrievedIds, relevantIds, 5),
  };
}
