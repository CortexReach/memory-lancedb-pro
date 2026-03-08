import type { MemoryEntry } from "./store.js";

export type PromotionTarget = "USER" | "AGENTS" | "IDENTITY" | "SOUL";
export type PromotionQueueReason =
  | "contradiction_detected"
  | "low_confidence_inferred"
  | "missing_confidence_score"
  | "insufficient_repeat_evidence"
  | "awaiting_manual_review"
  | "not_promotable";

export interface PromotionQueueItem {
  entry: MemoryEntry;
  target: PromotionTarget;
  reason: PromotionQueueReason;
  assertionKind: string;
  confidence: number;
  repeatCount: number;
}

export interface PromotionContradiction {
  topicKey: string;
  positive: string;
  negative: string;
}

export interface PromotionPolicyResult {
  promotedByTarget: Record<PromotionTarget, MemoryEntry[]>;
  queue: PromotionQueueItem[];
  contradictions: PromotionContradiction[];
  inferredCandidates: MemoryEntry[];
  reasonStats: Record<string, number>;
}

interface AnalyzedEntry {
  entry: MemoryEntry;
  metadata: Record<string, unknown>;
  normalized: string;
  topicKey: string;
  polarity: "positive" | "negative" | "neutral";
}

export function applyPromotionPolicy(entries: MemoryEntry[]): PromotionPolicyResult {
  const promotedByTarget: Record<PromotionTarget, MemoryEntry[]> = {
    USER: [],
    AGENTS: [],
    IDENTITY: [],
    SOUL: [],
  };
  const queue: PromotionQueueItem[] = [];
  const reasonStats: Record<string, number> = {};

  const analyzed = entries.map((entry) => {
    const metadata = safeParseJson(entry.metadata);
    const normalized = normalizedKey(entry.text);
    return {
      entry,
      metadata,
      normalized,
      topicKey: buildTopicKey(normalized),
      polarity: detectPolarity(normalized),
    } satisfies AnalyzedEntry;
  });

  const repeatCounts = new Map<string, number>();
  for (const row of analyzed) {
    if (!row.normalized) continue;
    repeatCounts.set(row.normalized, (repeatCounts.get(row.normalized) || 0) + 1);
  }

  const contradictionMap = new Map<string, { positive?: string; negative?: string }>();
  for (const row of analyzed) {
    if (!row.topicKey || row.polarity === "neutral") continue;
    const current = contradictionMap.get(row.topicKey) || {};
    if (row.polarity === "positive" && !current.positive) current.positive = row.entry.text;
    if (row.polarity === "negative" && !current.negative) current.negative = row.entry.text;
    contradictionMap.set(row.topicKey, current);
  }

  const contradictions: PromotionContradiction[] = [];
  const contradictedTopicKeys = new Set<string>();
  for (const [topicKey, pair] of contradictionMap.entries()) {
    if (pair.positive && pair.negative) {
      contradictedTopicKeys.add(topicKey);
      contradictions.push({
        topicKey,
        positive: pair.positive,
        negative: pair.negative,
      });
    }
  }

  const inferredCandidates = analyzed
    .filter((row) => row.metadata.assertionKind === "inferred")
    .map((row) => row.entry)
    .slice(0, 24);

  for (const row of analyzed) {
    const inferredTarget = inferPromotionTarget(row.entry);
    const promotionState = readPromotionState(row.metadata);
    const target = promotionState.target || inferredTarget;
    if (!target) {
      pushReason(reasonStats, "not_promotable");
      continue;
    }

    if (promotionState.status === "rejected") {
      pushReason(reasonStats, "awaiting_manual_review");
      continue;
    }

    if (promotionState.status === "approved") {
      promotedByTarget[target].push(row.entry);
      continue;
    }

    const assertionKind = typeof row.metadata.assertionKind === "string"
      ? row.metadata.assertionKind
      : "asserted";
    const confidenceRaw = row.metadata.confidence;
    const confidence = typeof confidenceRaw === "number"
      ? row.metadata.confidence
      : assertionKind === "asserted"
        ? 1
        : 0;
    const missingConfidence = assertionKind === "inferred" && typeof confidenceRaw !== "number";
    const repeatCount = repeatCounts.get(row.normalized) || 1;

    const trustPassed = assertionKind === "asserted" ||
      (assertionKind === "inferred" && confidence >= 0.8 && repeatCount >= 2);
    const contradicted = row.topicKey ? contradictedTopicKeys.has(row.topicKey) : false;

    if (trustPassed && !contradicted) {
      promotedByTarget[target].push(row.entry);
      continue;
    }

    let reason: PromotionQueueReason = "awaiting_manual_review";
    if (contradicted) reason = "contradiction_detected";
    else if (missingConfidence) reason = "missing_confidence_score";
    else if (assertionKind === "inferred" && confidence < 0.8) reason = "low_confidence_inferred";
    else if (assertionKind === "inferred" && repeatCount < 2) reason = "insufficient_repeat_evidence";

    pushReason(reasonStats, reason);

    queue.push({
      entry: row.entry,
      target,
      reason,
      assertionKind,
      confidence,
      repeatCount,
    });
  }

  return {
    promotedByTarget: {
      USER: promotedByTarget.USER.slice(0, 20),
      AGENTS: promotedByTarget.AGENTS.slice(0, 20),
      IDENTITY: promotedByTarget.IDENTITY.slice(0, 20),
      SOUL: promotedByTarget.SOUL.slice(0, 20),
    },
    queue: queue.slice(0, 40),
    contradictions: contradictions.slice(0, 20),
    inferredCandidates,
    reasonStats,
  };
}

function pushReason(stats: Record<string, number>, reason: PromotionQueueReason): void {
  stats[reason] = (stats[reason] || 0) + 1;
}

function readPromotionState(metadata: Record<string, unknown>): { status?: string; target?: PromotionTarget } {
  const promotion = metadata.promotion;
  if (!promotion || typeof promotion !== "object") return {};
  const obj = promotion as Record<string, unknown>;
  const status = typeof obj.status === "string" ? obj.status : undefined;
  const targetRaw = typeof obj.target === "string" ? obj.target : undefined;
  const target = targetRaw === "USER" || targetRaw === "AGENTS" || targetRaw === "IDENTITY" || targetRaw === "SOUL"
    ? targetRaw
    : undefined;
  return { status, target };
}

function inferPromotionTarget(entry: MemoryEntry): PromotionTarget | undefined {
  if (entry.category === "preference" || entry.category === "entity") return "USER";
  if (entry.category === "decision") return "AGENTS";
  const normalized = normalizedKey(entry.text);
  if (!normalized) return undefined;
  if (/\b(identity|role|mission|i am|我是|身份|邊界|边界)\b/i.test(normalized)) return "IDENTITY";
  if (/\b(principle|value|always|never|準則|准则|原則|原则|底線|底线)\b/i.test(normalized)) return "SOUL";
  return undefined;
}

function detectPolarity(normalized: string): "positive" | "negative" | "neutral" {
  if (!normalized) return "neutral";
  if (/(\bnot\b|\bnever\b|\bdon't\b|\bdoes not\b|\bdo not\b|\bdislike\b|\bhate\b|\bavoid\b|不喜歡|不喜欢|不要|不該|不该|討厭|讨厌)/i.test(normalized)) {
    return "negative";
  }
  if (/(\blike\b|\blikes\b|\bprefer\b|\bprefers\b|\blove\b|\bloves\b|\buse\b|\buses\b|\bwant\b|\bwants\b|\bneed\b|\bneeds\b|喜歡|喜欢|偏好|愛用|爱用|需要)/i.test(normalized)) {
    return "positive";
  }
  return "neutral";
}

function buildTopicKey(normalized: string): string {
  if (!normalized) return "";
  return normalized
    .replace(/\b(does not|do not|don't|does|do|not|never|dislike|hate|avoid|like|likes|prefer|prefers|love|loves|use|uses|want|wants|need|needs)\b/gi, "")
    .replace(/不喜歡|不喜欢|不要|不該|不该|討厭|讨厌|喜歡|喜欢|偏好|愛用|爱用|需要/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function safeParseJson(value: string | undefined): Record<string, unknown> {
  if (!value || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

function normalizedKey(text: string): string {
  return text
    .replace(/^\[graph-inferred\]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
