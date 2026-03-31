import type { RetrievalConfig } from "../../src/retriever.js";

export const MAX_RECALL_PROFILE: Partial<RetrievalConfig> = {
  mode: "hybrid",
  rerank: "cross-encoder",
  vectorWeight: 0.7,
  bm25Weight: 0.3,
  hardMinScore: 0.15,
  minScore: 0.15,
  timeDecayHalfLifeDays: 0,
  recencyHalfLifeDays: 0,
  recencyWeight: 0,
  lengthNormAnchor: 0,
  candidatePoolSize: 40,
  filterNoise: false,
};
