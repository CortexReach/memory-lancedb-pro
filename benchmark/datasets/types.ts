export interface BenchmarkMemory {
  id: string;
  text: string;
  category: "preference" | "fact" | "decision" | "entity" | "other";
  scope: string;
  importance: number;
  /** Relative to "now", negative = past (e.g., -30 means 30 days ago) */
  ageDays: number;
  tags: string[];
}

export interface BenchmarkQuery {
  id: string;
  text: string;
  /** Ordered list of relevant memory IDs (most relevant first) */
  relevantMemoryIds: string[];
  /** Source conversation turn numbers (for extraction recall) */
  sourceConversationTurns?: number[];
  /** Gold answer text (for end-to-end LLM-Judge evaluation) */
  goldAnswer?: string;
  intent: "exact-recall" | "semantic" | "temporal" | "cross-lingual" | "noisy";
}

export interface BenchmarkDataset {
  name: string;
  lang: "en" | "zh" | "mixed";
  memories: BenchmarkMemory[];
  queries: BenchmarkQuery[];
}
