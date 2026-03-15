import { describeKnowledgeUnit, extractAtomicMemory } from "./atomic-memory.js";
import { isNoise } from "./noise-filter.js";
import type { MemoryEntry } from "./store.js";

export interface GovernanceReportEntry {
  id: string;
  text: string;
  category: string;
  scope: string;
  importance: number;
  timestamp: number;
  knowledgeUnit: ReturnType<typeof describeKnowledgeUnit>;
  reasons: string[];
}

export interface GovernancePairCandidate {
  recommendedAction: "merge" | "supersede";
  overlap: number;
  primary: GovernanceReportEntry;
  secondary: GovernanceReportEntry;
  reasons: string[];
}

export interface GovernanceReport {
  summary: {
    totalCount: number;
    atomicCount: number;
    plainCount: number;
    highValueAtomicCount: number;
    verifyCandidateCount: number;
    mergeCandidateCount: number;
    archiveNoiseCandidateCount: number;
    plainRiskCounts: { ready: number; cautious: number; hold: number; noise: number };
  };
  buckets: {
    highValueAtomic: GovernanceReportEntry[];
    verifyCandidates: GovernanceReportEntry[];
    mergeCandidates: GovernancePairCandidate[];
    archiveNoiseCandidates: GovernanceReportEntry[];
    plainRisk: {
      ready: GovernanceReportEntry[];
      cautious: GovernanceReportEntry[];
      hold: GovernanceReportEntry[];
      noise: GovernanceReportEntry[];
    };
  };
}

const NOISE_MARKERS = [/conversation info/i, /system metadata/i, /scope_test/i, /^system\s*\+/i];
const PENDING_MARKERS = [/\bpending\b/i, /待确认/, /计划态/, /\btodo\b/i, /\bplan\b/i, /计划/];
const HOLD_MARKERS = [/pitfall/i, /principle/i, /prevention/i, /\bfix\b/i, /反思/, /督促/, /自我要求/, /核心概念/];

function tokenize(text: string): string[] {
  return String(text).toLowerCase().match(/[a-z0-9\u4e00-\u9fff]+/g) || [];
}

function textFingerprint(text: string): string {
  return tokenize(text)
    .filter((token) => token.length >= 2)
    .slice(0, 16)
    .join(" ");
}

function clauseCount(text: string): number {
  const matches = String(text).match(/[\n;；。!?：:]/g);
  return matches ? matches.length + 1 : 1;
}

function hasNoiseMarkers(text: string): boolean {
  return NOISE_MARKERS.some((pattern) => pattern.test(text));
}

function toReportEntry(entry: MemoryEntry, reasons: string[]): GovernanceReportEntry {
  return {
    id: entry.id,
    text: entry.text,
    category: entry.category,
    scope: entry.scope,
    importance: entry.importance,
    timestamp: entry.timestamp,
    knowledgeUnit: describeKnowledgeUnit(entry),
    reasons,
  };
}

export function classifyPlainRisk(entry: MemoryEntry): { bucket: "ready" | "cautious" | "hold" | "noise"; reasons: string[] } {
  const text = entry.text || "";
  const reasons: string[] = [];
  if (isNoise(text) || hasNoiseMarkers(text)) {
    reasons.push("命中噪声/会话元信息规则");
    return { bucket: "noise", reasons };
  }
  if (PENDING_MARKERS.some((pattern) => pattern.test(text))) {
    reasons.push("包含 pending/计划态信号");
    return { bucket: "hold", reasons };
  }
  if (HOLD_MARKERS.some((pattern) => pattern.test(text))) {
    reasons.push("包含 pitfall/principle/fix/反思 类混合信号");
    return { bucket: "hold", reasons };
  }
  const clauses = clauseCount(text);
  if (text.length <= 140 && clauses <= 2 && entry.importance >= 0.7 && entry.category !== "other") {
    reasons.push("文本较短、主题较单一、接近直接 atomic repair");
    return { bucket: "ready", reasons };
  }
  reasons.push(text.length > 180 ? "文本较长" : "存在多子句/摘要式结构");
  return { bucket: "cautious", reasons };
}

export function classifyArchiveNoiseCandidate(entry: MemoryEntry): string[] | null {
  const text = entry.text || "";
  const reasons: string[] = [];
  if (isNoise(text) || hasNoiseMarkers(text)) reasons.push("命中噪声/会话元信息规则");
  if (!extractAtomicMemory(entry.metadata) && entry.importance <= 0.55 && text.length > 180) {
    reasons.push("plain 且重要性偏低，更像归档材料而非长期高权重记忆");
  }
  return reasons.length > 0 ? reasons : null;
}

export function buildGovernanceReport(entries: MemoryEntry[]): GovernanceReport {
  const highValueAtomic: GovernanceReportEntry[] = [];
  const verifyCandidates: GovernanceReportEntry[] = [];
  const archiveNoiseCandidates: GovernanceReportEntry[] = [];
  const plainRisk = { ready: [] as GovernanceReportEntry[], cautious: [] as GovernanceReportEntry[], hold: [] as GovernanceReportEntry[], noise: [] as GovernanceReportEntry[] };

  for (const entry of entries) {
    const atomic = extractAtomicMemory(entry.metadata);
    const archiveReasons = classifyArchiveNoiseCandidate(entry);
    if (archiveReasons) archiveNoiseCandidates.push(toReportEntry(entry, archiveReasons));

    if (atomic) {
      const highValueReasons: string[] = [];
      if (entry.importance >= 0.85) highValueReasons.push("importance >= 0.85");
      if (atomic.confidence >= 0.8) highValueReasons.push("atomic.confidence >= 0.80");
      if (["user", "tool"].includes(atomic.sourceKind)) highValueReasons.push(`sourceKind=${atomic.sourceKind}`);
      if (highValueReasons.length >= 3 && !archiveReasons) {
        highValueAtomic.push(toReportEntry(entry, highValueReasons));
      }

      const verifyReasons: string[] = [];
      if (atomic.sourceKind === "agent" || atomic.sourceKind === "imported") verifyReasons.push(`sourceKind=${atomic.sourceKind} 需要回源确认`);
      if (atomic.confidence < 0.8) verifyReasons.push("confidence < 0.80");
      if (!atomic.sourceRef) verifyReasons.push("缺少 sourceRef，回溯性较弱");
      if (verifyReasons.length > 0 && !archiveReasons) {
        verifyCandidates.push(toReportEntry(entry, verifyReasons));
      }
      continue;
    }

    const plain = classifyPlainRisk(entry);
    plainRisk[plain.bucket].push(toReportEntry(entry, plain.reasons));
  }

  const mergeCandidates: GovernancePairCandidate[] = [];
  const seenPairs = new Set<string>();
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const left = entries[i];
      const right = entries[j];
      if (left.scope !== right.scope || left.category !== right.category) continue;
      if (hasNoiseMarkers(left.text) || hasNoiseMarkers(right.text)) continue;

      const leftTokens = new Set(tokenize(left.text));
      const rightTokens = new Set(tokenize(right.text));
      if (leftTokens.size === 0 || rightTokens.size === 0) continue;

      const shared = [...leftTokens].filter((token) => rightTokens.has(token));
      const overlap = shared.length / Math.max(leftTokens.size, rightTokens.size);
      if (shared.length < 3 || overlap < 0.68) continue;

      const pairKey = [left.id, right.id].sort().join(":");
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);

      const leftAtomic = extractAtomicMemory(left.metadata);
      const rightAtomic = extractAtomicMemory(right.metadata);
      const primary = leftAtomic && !rightAtomic
        ? left
        : rightAtomic && !leftAtomic
          ? right
          : (left.importance >= right.importance ? left : right);
      const secondary = primary.id === left.id ? right : left;
      const recommendedAction = extractAtomicMemory(primary.metadata) && !extractAtomicMemory(secondary.metadata)
        ? "supersede"
        : "merge";

      mergeCandidates.push({
        recommendedAction,
        overlap: Number(overlap.toFixed(2)),
        primary: toReportEntry(primary, [`与 ${secondary.id} 存在高文本重叠`]),
        secondary: toReportEntry(secondary, [`与 ${primary.id} 存在高文本重叠`]),
        reasons: [
          `共享 ${shared.length} 个 token，重叠度 ${overlap.toFixed(2)}`,
          recommendedAction === "supersede" ? "atomic/plain 阴影对，优先考虑 supersede 关系" : "相似内容双写，优先人工判断是否 merge",
        ],
      });
    }
  }

  const atomicCount = entries.filter((entry) => extractAtomicMemory(entry.metadata)).length;
  const plainCount = entries.length - atomicCount;

  return {
    summary: {
      totalCount: entries.length,
      atomicCount,
      plainCount,
      highValueAtomicCount: highValueAtomic.length,
      verifyCandidateCount: verifyCandidates.length,
      mergeCandidateCount: mergeCandidates.length,
      archiveNoiseCandidateCount: archiveNoiseCandidates.length,
      plainRiskCounts: {
        ready: plainRisk.ready.length,
        cautious: plainRisk.cautious.length,
        hold: plainRisk.hold.length,
        noise: plainRisk.noise.length,
      },
    },
    buckets: {
      highValueAtomic: highValueAtomic.sort((a, b) => b.importance - a.importance || b.timestamp - a.timestamp),
      verifyCandidates: verifyCandidates.sort((a, b) => b.timestamp - a.timestamp),
      mergeCandidates: mergeCandidates.sort((a, b) => b.overlap - a.overlap),
      archiveNoiseCandidates: archiveNoiseCandidates.sort((a, b) => b.timestamp - a.timestamp),
      plainRisk: {
        ready: plainRisk.ready.sort((a, b) => b.importance - a.importance),
        cautious: plainRisk.cautious.sort((a, b) => b.importance - a.importance),
        hold: plainRisk.hold.sort((a, b) => b.timestamp - a.timestamp),
        noise: plainRisk.noise.sort((a, b) => b.timestamp - a.timestamp),
      },
    },
  };
}

export function governanceEntryLabel(entry: GovernanceReportEntry): string {
  const fingerprint = textFingerprint(entry.text);
  return `[${entry.id}] [${entry.category}:${entry.scope}] ${fingerprint || entry.text.slice(0, 80)}`;
}