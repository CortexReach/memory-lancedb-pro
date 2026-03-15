import type { MemoryEntry } from "./store.js";
import type { AtomicMemorySourceKind, AtomicMemoryUnitType } from "./atomic-memory.js";

export type MessageRole = "user" | "assistant";

export interface NormalizationCandidate {
  text: string;
  role: MessageRole;
  sourceKind: "user" | "agent";
  category: MemoryEntry["category"];
  unitType: AtomicMemoryUnitType;
}

export interface NormalizedMemoryDraft {
  canonicalText: string;
  category: MemoryEntry["category"];
  atomic: {
    unitType: AtomicMemoryUnitType;
    sourceKind: AtomicMemorySourceKind;
    confidence: number;
    sourceRef?: string;
    tags?: string[];
  };
  normalizationMode: "llm" | "rules" | "raw_fallback";
  reason?: string;
  sourceText: string;
}

export interface NormalizationAuditRecord {
  timestamp: number;
  agentId?: string;
  scope: string;
  source: string;
  candidate: Pick<NormalizationCandidate, "text" | "role" | "sourceKind" | "category" | "unitType">;
  entries: Array<{
    canonicalText: string;
    category: MemoryEntry["category"];
    atomic: NormalizedMemoryDraft["atomic"];
    normalizationMode: NormalizedMemoryDraft["normalizationMode"];
    reason?: string;
  }>;
  fallback?: string;
  errors?: string[];
}
