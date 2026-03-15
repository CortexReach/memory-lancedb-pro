import { ATOMIC_MEMORY_SOURCE_KINDS, ATOMIC_MEMORY_UNIT_TYPES } from "./atomic-memory.js";
import { cleanupCandidateText, detectNormalizationKind, deriveTagsFromText, inferTaxonomyFromText, isRuntimeChatter } from "./normalization-rules.js";
import type { NormalizationCandidate, NormalizedMemoryDraft } from "./normalization-types.js";

function clamp01(value: unknown, fallback = 0.7): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

function normalizeTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tags = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 8);
  return tags.length > 0 ? tags : undefined;
}

function mergeTags(...groups: Array<string[] | undefined>): string[] | undefined {
  const tags = new Set<string>();
  for (const group of groups) {
    if (!group) continue;
    for (const tag of group) {
      const cleaned = tag.trim();
      if (cleaned) tags.add(cleaned);
    }
  }
  return tags.size > 0 ? Array.from(tags).slice(0, 8) : undefined;
}

function resolveConfidence(value: unknown, fallback = 0.7): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return clamp01(n, fallback);
}

export function validateNormalizedDrafts(
  candidate: NormalizationCandidate,
  drafts: unknown,
  options: {
    maxEntries?: number;
    confidence?: number;
    sourceRef?: string;
  } = {},
): { entries: NormalizedMemoryDraft[]; errors: string[] } {
  const maxEntries = Math.max(1, Math.min(5, options.maxEntries ?? 3));
  const errors: string[] = [];

  if (!Array.isArray(drafts)) {
    return { entries: [], errors: ["entries_not_array"] };
  }

  const entries: NormalizedMemoryDraft[] = [];

  for (const draft of drafts.slice(0, maxEntries)) {
    if (!draft || typeof draft !== "object") {
      errors.push("entry_not_object");
      continue;
    }

    const node = draft as Record<string, unknown>;
    const rawText = typeof node.canonicalText === "string" ? cleanupCandidateText(node.canonicalText) : "";
    if (!rawText || rawText.length < 4) {
      errors.push("empty_canonical_text");
      continue;
    }
    if (rawText.length > 500) {
      errors.push("canonical_text_too_long");
      continue;
    }
    if (isRuntimeChatter(rawText)) {
      errors.push("runtime_chatter");
      continue;
    }

    const categoryCandidate = ["preference", "fact", "decision", "entity", "other"].includes(String(node.category))
      ? (node.category as NormalizedMemoryDraft["category"])
      : candidate.category;

    const atomicRaw = node.atomic && typeof node.atomic === "object" ? node.atomic as Record<string, unknown> : {};
    const unitTypeCandidate = ATOMIC_MEMORY_UNIT_TYPES.includes(String(atomicRaw.unitType) as any)
      ? (atomicRaw.unitType as NormalizedMemoryDraft["atomic"]["unitType"])
      : candidate.unitType;
    const sourceKind = ATOMIC_MEMORY_SOURCE_KINDS.includes(String(atomicRaw.sourceKind) as any)
      ? (atomicRaw.sourceKind as NormalizedMemoryDraft["atomic"]["sourceKind"])
      : candidate.sourceKind;

    const inferred = inferTaxonomyFromText(rawText, {
      category: categoryCandidate,
      unitType: unitTypeCandidate,
      sourceKind,
    });

    const reason = typeof node.reason === "string" ? node.reason.trim() : undefined;
    const normalizationMode = node.normalizationMode === "llm" || node.normalizationMode === "rules" || node.normalizationMode === "raw_fallback"
      ? node.normalizationMode
      : "llm";

    const normalized: NormalizedMemoryDraft = {
      canonicalText: rawText,
      category: inferred.category,
      atomic: {
        unitType: inferred.unitType,
        sourceKind,
        confidence: resolveConfidence(atomicRaw.confidence, options.confidence ?? 0.7),
        ...(typeof atomicRaw.sourceRef === "string" && atomicRaw.sourceRef.trim()
          ? { sourceRef: atomicRaw.sourceRef.trim() }
          : options.sourceRef ? { sourceRef: options.sourceRef } : {}),
        ...(mergeTags(normalizeTags(atomicRaw.tags), deriveTagsFromText(rawText, {
          category: inferred.category,
          unitType: inferred.unitType,
          sourceKind,
        })) ? { tags: mergeTags(normalizeTags(atomicRaw.tags), deriveTagsFromText(rawText, {
          category: inferred.category,
          unitType: inferred.unitType,
          sourceKind,
        })) } : {}),
      },
      normalizationMode,
      ...(reason ? { reason } : {}),
      sourceText: candidate.text,
    };

    const kind = detectNormalizationKind(candidate);
    if (kind === "technical") {
      const lowerSource = candidate.text.toLowerCase();
      const lowerCanon = normalized.canonicalText.toLowerCase();
      const anchors = [
        "allowlist miss",
        "runtime.modelauth",
        "threadbindings",
        "captureassistant",
        "rerankprovider",
        "baseurl",
        "eisdir",
        "telegram",
        "proxy",
        "gateway",
        "session",
        "embedding",
      ].filter((anchor) => lowerSource.includes(anchor));
      if (anchors.length > 0 && !anchors.some((anchor) => lowerCanon.includes(anchor))) {
        errors.push("technical_anchor_missing");
        continue;
      }
    }

    entries.push(normalized);
  }

  return { entries, errors };
}
