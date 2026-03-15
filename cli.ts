/**
 * CLI Commands for Memory Management
 */

import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { describeKnowledgeUnit, extractAtomicMemory } from "./src/atomic-memory.js";
import { buildGovernanceReport, classifyArchiveNoiseCandidate, governanceEntryLabel, type GovernanceReport, type GovernanceReportEntry } from "./src/governance-report.js";
import type { NormalizationAuditRecord } from "./src/normalization-types.js";
import { loadLanceDB, type MemoryEntry, type MemoryStore } from "./src/store.js";
import { createRetriever, type MemoryRetriever } from "./src/retriever.js";
import type { MemoryScopeManager } from "./src/scopes.js";
import type { MemoryMigrator } from "./src/migrate.js";

// ============================================================================
// Types
// ============================================================================

interface CLIContext {
  store: MemoryStore;
  retriever: MemoryRetriever;
  scopeManager: MemoryScopeManager;
  migrator: MemoryMigrator;
  embedder?: import("./src/embedder.js").Embedder;
}

interface SearchObservationExpectation {
  category?: string;
  unitType?: string;
  sourceKind?: string;
  topAtomic?: boolean;
  textIncludes?: string[];
  maxArchiveNoiseInTopK?: number;
  minTopScore?: number;
}

interface SearchObservationCase {
  id?: string;
  description?: string;
  query: string;
  expected?: SearchObservationExpectation;
}

interface SearchObservationTopHit {
  id: string;
  text: string;
  category: string;
  scope: string;
  score: number;
  atomic?: NonNullable<ReturnType<typeof extractAtomicMemory>>;
  archiveNoiseReasons: string[];
}

interface SearchObservationCaseResult {
  id: string;
  description?: string;
  query: string;
  pass: boolean | null;
  failures: string[];
  noiseInTopK: number;
  topHit: SearchObservationTopHit | null;
  topResults: Array<{
    id: string;
    category: string;
    score: number;
    archiveNoise: boolean;
    atomic: boolean;
  }>;
}

interface SearchObservationReport {
  summary: {
    totalCases: number;
    expectationCases: number;
    passedCases: number;
    failedCases: number;
    noResultCases: number;
    topAtomicCount: number;
    topArchiveNoiseCount: number;
    casesWithArchiveNoiseInTopK: number;
  };
  cases: SearchObservationCaseResult[];
}

interface GovernanceReviewPacketItem {
  queue: "verify" | "archive";
  proposedAction: "metadata-verify" | "archive-review";
  riskLevel: "low" | "medium";
  id: string;
  category: string;
  scope: string;
  importance: number;
  text: string;
  reasons: string[];
  atomic?: NonNullable<ReturnType<typeof extractAtomicMemory>>;
}

interface GovernanceReviewPacket {
  summary: {
    mode: "all" | "verify" | "archive";
    verifyCount: number;
    archiveCount: number;
    totalReviewItems: number;
  };
  queues: {
    verify: GovernanceReviewPacketItem[];
    archive: GovernanceReviewPacketItem[];
  };
}

interface ReviewPacketQueueComparison {
  beforeCount: number;
  afterCount: number;
  overlapCount: number;
  addedCount: number;
  removedCount: number;
  overlapRatio: number;
  retainedIds: string[];
  addedIds: string[];
  removedIds: string[];
}

interface GovernanceReviewPacketComparison {
  summary: {
    beforeFile: string;
    afterFile: string;
  };
  queues: {
    verify: ReviewPacketQueueComparison;
    archive: ReviewPacketQueueComparison;
  };
}

interface NormalizationAuditSummary {
  logPath: string;
  totalRecords: number;
  sourceCounts: Record<string, number>;
  fallbackCounts: Record<string, number>;
  candidateRoleCounts: Record<string, number>;
  candidateCategoryCounts: Record<string, number>;
  candidateUnitTypeCounts: Record<string, number>;
  entryModeCounts: Record<string, number>;
  entryCategoryCounts: Record<string, number>;
  entryUnitTypeCounts: Record<string, number>;
  reasonCounts: Record<string, number>;
  errorCounts: Record<string, number>;
  samples: Array<{
    timestamp: number;
    source: string;
    fallback?: string;
    errors?: string[];
    candidateText: string;
    entryTexts: string[];
  }>;
}

// ============================================================================
// Utility Functions
// ============================================================================

function getPluginVersion(): string {
  try {
    const pkgUrl = new URL("./package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgUrl, "utf8")) as { version?: string };
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

function clampInt(value: number, min: number, max: number): number {
  const n = Number.isFinite(value) ? value : min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function formatMemory(memory: any, index?: number): string {
  const prefix = index !== undefined ? `${index + 1}. ` : "";
  const id = memory?.id ? String(memory.id) : "unknown";
  const date = new Date(memory.timestamp || memory.createdAt || Date.now()).toISOString().split('T')[0];
  const fullText = String(memory.text || "");
  const text = fullText.slice(0, 100) + (fullText.length > 100 ? "..." : "");
  const atomic = extractAtomicMemory(memory?.metadata);
  const atomicBadge = atomic
    ? `, unit=${atomic.unitType}, source=${atomic.sourceKind}, confidence=${Math.round(atomic.confidence * 100)}%`
    : "";
  return `${prefix}[${id}] [${memory.category}:${memory.scope}] ${text} (${date}${atomicBadge})`;
}

function serializeMemory(memory: MemoryEntry) {
  const atomic = extractAtomicMemory(memory.metadata);
  return {
    id: memory.id,
    text: memory.text,
    category: memory.category,
    scope: memory.scope,
    importance: memory.importance,
    timestamp: memory.timestamp,
    ...(atomic ? { atomic } : {}),
    knowledgeUnit: describeKnowledgeUnit(memory),
  };
}

function formatJson(obj: any): string {
  return JSON.stringify(obj, null, 2);
}

function formatGovernanceEntries(title: string, entries: GovernanceReportEntry[], limit = 5): string[] {
  const lines = [`${title}: ${entries.length}`];
  entries.slice(0, limit).forEach((entry, index) => {
    lines.push(`  ${index + 1}. ${governanceEntryLabel(entry)}`);
    lines.push(`     - ${entry.reasons.join("；")}`);
  });
  if (entries.length > limit) lines.push(`     ... 还有 ${entries.length - limit} 条`);
  return lines;
}

function formatGovernanceReport(report: GovernanceReport): string {
  const { summary, buckets } = report;
  const lines = [
    "Governance Report:",
    `• total: ${summary.totalCount}`,
    `• atomic/plain: ${summary.atomicCount}/${summary.plainCount}`,
    `• high-value atomic: ${summary.highValueAtomicCount}`,
    `• verify candidates: ${summary.verifyCandidateCount}`,
    `• merge/supersede candidates: ${summary.mergeCandidateCount}`,
    `• archive/noise candidates: ${summary.archiveNoiseCandidateCount}`,
    `• plain risk: ready=${summary.plainRiskCounts.ready}, cautious=${summary.plainRiskCounts.cautious}, hold=${summary.plainRiskCounts.hold}, noise=${summary.plainRiskCounts.noise}`,
    "",
    "Rules:",
    "• high-value atomic = 高 importance + 高 confidence + user/tool 来源",
    "• verify = sourceKind 偏 agent/imported，或 confidence/sourceRef 较弱",
    "• merge/supersede = 同 scope/category 下高文本重叠",
    "• archive/noise = 会话元信息/测试残留/明显低价值归档候选",
    "• plain risk = ready / cautious / hold / noise 四层",
    "",
    ...formatGovernanceEntries("High-value atomic", buckets.highValueAtomic),
    "",
    ...formatGovernanceEntries("Verify candidates", buckets.verifyCandidates),
    "",
    ...formatGovernanceEntries("Archive/noise candidates", buckets.archiveNoiseCandidates),
    "",
    ...formatGovernanceEntries("Plain-ready", buckets.plainRisk.ready),
    "",
    ...formatGovernanceEntries("Plain-cautious", buckets.plainRisk.cautious),
    "",
    ...formatGovernanceEntries("Plain-hold", buckets.plainRisk.hold),
    "",
    ...formatGovernanceEntries("Plain-noise", buckets.plainRisk.noise),
  ];

  if (buckets.mergeCandidates.length > 0) {
    lines.push("");
    lines.push(`Merge/supersede candidates: ${buckets.mergeCandidates.length}`);
    buckets.mergeCandidates.slice(0, 5).forEach((candidate, index) => {
      lines.push(`  ${index + 1}. ${candidate.recommendedAction.toUpperCase()} ${candidate.primary.id} <- ${candidate.secondary.id}`);
      lines.push(`     - ${candidate.reasons.join("；")}`);
    });
    if (buckets.mergeCandidates.length > 5) lines.push(`     ... 还有 ${buckets.mergeCandidates.length - 5} 对`);
  }

  return lines.join("\n");
}

function loadObservationCases(filePath: string): SearchObservationCase[] {
  const raw = JSON.parse(readFileSync(filePath, "utf8"));
  const items = Array.isArray(raw) ? raw : raw?.cases;
  if (!Array.isArray(items)) {
    throw new Error("Observation cases file must be an array or an object with a cases array");
  }
  return items.map((item, index) => {
    if (!item || typeof item.query !== "string" || item.query.trim().length === 0) {
      throw new Error(`Observation case #${index + 1} is missing a valid query`);
    }
    return {
      id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : `case-${index + 1}`,
      description: typeof item.description === "string" ? item.description : undefined,
      query: item.query,
      expected: item.expected && typeof item.expected === "object" ? item.expected : undefined,
    } satisfies SearchObservationCase;
  });
}

function buildObservationTopHit(result: Awaited<ReturnType<MemoryRetriever["retrieve"]>>[number]): SearchObservationTopHit {
  const archiveNoiseReasons = classifyArchiveNoiseCandidate(result.entry) || [];
  return {
    id: result.entry.id,
    text: result.entry.text,
    category: result.entry.category,
    scope: result.entry.scope,
    score: result.score,
    atomic: extractAtomicMemory(result.entry.metadata) || undefined,
    archiveNoiseReasons,
  };
}

function evaluateObservationCase(
  item: SearchObservationCase,
  results: Awaited<ReturnType<MemoryRetriever["retrieve"]>>,
): SearchObservationCaseResult {
  const topHit = results[0] ? buildObservationTopHit(results[0]) : null;
  const noiseInTopK = results.filter((result) => Boolean(classifyArchiveNoiseCandidate(result.entry))).length;
  const failures: string[] = [];
  const expected = item.expected;

  if (expected) {
    if (!topHit) {
      failures.push("无结果");
    } else {
      if (expected.topAtomic !== undefined && Boolean(topHit.atomic) !== expected.topAtomic) {
        failures.push(`topAtomic 期望=${expected.topAtomic} 实际=${Boolean(topHit.atomic)}`);
      }
      if (expected.category && topHit.category !== expected.category) {
        failures.push(`category 期望=${expected.category} 实际=${topHit.category}`);
      }
      if (expected.unitType && topHit.atomic?.unitType !== expected.unitType) {
        failures.push(`unitType 期望=${expected.unitType} 实际=${topHit.atomic?.unitType || "plain"}`);
      }
      if (expected.sourceKind && topHit.atomic?.sourceKind !== expected.sourceKind) {
        failures.push(`sourceKind 期望=${expected.sourceKind} 实际=${topHit.atomic?.sourceKind || "plain"}`);
      }
      if (expected.textIncludes?.length) {
        const lowered = topHit.text.toLowerCase();
        const missing = expected.textIncludes.filter((token) => !lowered.includes(String(token).toLowerCase()));
        if (missing.length > 0) {
          failures.push(`top text 缺少关键词: ${missing.join(", ")}`);
        }
      }
      if (expected.maxArchiveNoiseInTopK !== undefined && noiseInTopK > expected.maxArchiveNoiseInTopK) {
        failures.push(`top-k archive/noise 数量超限: ${noiseInTopK} > ${expected.maxArchiveNoiseInTopK}`);
      }
      if (expected.minTopScore !== undefined && topHit.score < expected.minTopScore) {
        failures.push(`top score 过低: ${topHit.score.toFixed(3)} < ${expected.minTopScore}`);
      }
    }
  }

  return {
    id: item.id || item.query,
    description: item.description,
    query: item.query,
    pass: expected ? failures.length === 0 : null,
    failures,
    noiseInTopK,
    topHit,
    topResults: results.map((result) => ({
      id: result.entry.id,
      category: result.entry.category,
      score: result.score,
      archiveNoise: Boolean(classifyArchiveNoiseCandidate(result.entry)),
      atomic: Boolean(extractAtomicMemory(result.entry.metadata)),
    })),
  };
}

function buildObservationReport(cases: SearchObservationCaseResult[]): SearchObservationReport {
  const expectationCases = cases.filter((item) => item.pass !== null);
  return {
    summary: {
      totalCases: cases.length,
      expectationCases: expectationCases.length,
      passedCases: expectationCases.filter((item) => item.pass === true).length,
      failedCases: expectationCases.filter((item) => item.pass === false).length,
      noResultCases: cases.filter((item) => !item.topHit).length,
      topAtomicCount: cases.filter((item) => Boolean(item.topHit?.atomic)).length,
      topArchiveNoiseCount: cases.filter((item) => Boolean(item.topHit?.archiveNoiseReasons.length)).length,
      casesWithArchiveNoiseInTopK: cases.filter((item) => item.noiseInTopK > 0).length,
    },
    cases,
  };
}

function formatObservationReport(report: SearchObservationReport): string {
  const lines = [
    "Search Observation Report:",
    `• cases: ${report.summary.totalCases}`,
    `• expectation cases: ${report.summary.expectationCases}`,
    `• passed/failed: ${report.summary.passedCases}/${report.summary.failedCases}`,
    `• no result: ${report.summary.noResultCases}`,
    `• top atomic: ${report.summary.topAtomicCount}`,
    `• top archive/noise: ${report.summary.topArchiveNoiseCount}`,
    `• cases with archive/noise in top-k: ${report.summary.casesWithArchiveNoiseInTopK}`,
  ];

  report.cases.forEach((item, index) => {
    const status = item.pass === null ? "INFO" : item.pass ? "PASS" : "FAIL";
    lines.push("");
    lines.push(`${index + 1}. [${status}] ${item.id}: ${item.query}`);
    if (item.description) lines.push(`   - ${item.description}`);
    if (item.topHit) {
      const atomic = item.topHit.atomic
        ? `, unit=${item.topHit.atomic.unitType}, source=${item.topHit.atomic.sourceKind}`
        : ", plain";
      const archive = item.topHit.archiveNoiseReasons.length > 0 ? `, archiveNoise=${item.topHit.archiveNoiseReasons.join("；")}` : "";
      lines.push(`   - top: [${item.topHit.category}:${item.topHit.scope}] score=${item.topHit.score.toFixed(3)}${atomic}${archive}`);
    } else {
      lines.push("   - top: 无结果");
    }
    lines.push(`   - top-k archive/noise count: ${item.noiseInTopK}`);
    if (item.failures.length > 0) {
      lines.push(`   - failures: ${item.failures.join("；")}`);
    }
  });

  return lines.join("\n");
}

function toReviewPacketItem(queue: "verify" | "archive", entry: GovernanceReportEntry): GovernanceReviewPacketItem {
  return {
    queue,
    proposedAction: queue === "verify" ? "metadata-verify" : "archive-review",
    riskLevel: queue === "verify" ? "low" : "medium",
    id: entry.id,
    category: entry.category,
    scope: entry.scope,
    importance: entry.importance,
    text: entry.text,
    reasons: entry.reasons,
    atomic: entry.knowledgeUnit.atomic,
  };
}

function buildReviewPacket(
  report: GovernanceReport,
  mode: "all" | "verify" | "archive",
  limit: number,
): GovernanceReviewPacket {
  const verify = (mode === "all" || mode === "verify")
    ? report.buckets.verifyCandidates.slice(0, limit).map((entry) => toReviewPacketItem("verify", entry))
    : [];
  const archive = (mode === "all" || mode === "archive")
    ? report.buckets.archiveNoiseCandidates.slice(0, limit).map((entry) => toReviewPacketItem("archive", entry))
    : [];

  return {
    summary: {
      mode,
      verifyCount: verify.length,
      archiveCount: archive.length,
      totalReviewItems: verify.length + archive.length,
    },
    queues: { verify, archive },
  };
}

function normalizeReviewPacketItem(
  queue: "verify" | "archive",
  item: Record<string, unknown>,
): GovernanceReviewPacketItem {
  const atomic = item.atomic && typeof item.atomic === "object"
    ? item.atomic as NonNullable<ReturnType<typeof extractAtomicMemory>>
    : undefined;
  return {
    queue,
    proposedAction: item.proposedAction === "archive-review" ? "archive-review" : "metadata-verify",
    riskLevel: item.riskLevel === "medium" ? "medium" : "low",
    id: String(item.id || "unknown"),
    category: String(item.category || "unknown"),
    scope: String(item.scope || "unknown"),
    importance: Number.isFinite(item.importance) ? Number(item.importance) : 0,
    text: String(item.text || item.textLead || ""),
    reasons: Array.isArray(item.reasons) ? item.reasons.map((reason) => String(reason)) : [],
    atomic,
  };
}

function loadReviewPacketFile(filePath: string): GovernanceReviewPacket {
  const raw = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
  if (raw.queues && typeof raw.queues === "object") {
    const queues = raw.queues as Record<string, unknown>;
    const verify = Array.isArray(queues.verify)
      ? queues.verify.map((item) => normalizeReviewPacketItem("verify", item as Record<string, unknown>))
      : [];
    const archive = Array.isArray(queues.archive)
      ? queues.archive.map((item) => normalizeReviewPacketItem("archive", item as Record<string, unknown>))
      : [];
    return {
      summary: {
        mode: raw.summary && typeof raw.summary === "object" && (raw.summary as Record<string, unknown>).mode === "verify"
          ? "verify"
          : raw.summary && typeof raw.summary === "object" && (raw.summary as Record<string, unknown>).mode === "archive"
            ? "archive"
            : "all",
        verifyCount: verify.length,
        archiveCount: archive.length,
        totalReviewItems: verify.length + archive.length,
      },
      queues: { verify, archive },
    };
  }

  const verify = Array.isArray(raw.verify)
    ? raw.verify.map((item) => normalizeReviewPacketItem("verify", item as Record<string, unknown>))
    : [];
  const archive = Array.isArray(raw.archive)
    ? raw.archive.map((item) => normalizeReviewPacketItem("archive", item as Record<string, unknown>))
    : [];

  return {
    summary: {
      mode: raw.summary && typeof raw.summary === "object" && (raw.summary as Record<string, unknown>).mode === "verify"
        ? "verify"
        : raw.summary && typeof raw.summary === "object" && (raw.summary as Record<string, unknown>).mode === "archive"
          ? "archive"
          : "all",
      verifyCount: verify.length,
      archiveCount: archive.length,
      totalReviewItems: verify.length + archive.length,
    },
    queues: { verify, archive },
  };
}

function compareReviewPacketQueue(
  beforeItems: GovernanceReviewPacketItem[],
  afterItems: GovernanceReviewPacketItem[],
): ReviewPacketQueueComparison {
  const beforeIds = beforeItems.map((item) => item.id);
  const afterIds = afterItems.map((item) => item.id);
  const beforeSet = new Set(beforeIds);
  const afterSet = new Set(afterIds);
  const retainedIds = afterIds.filter((id) => beforeSet.has(id));
  const addedIds = afterIds.filter((id) => !beforeSet.has(id));
  const removedIds = beforeIds.filter((id) => !afterSet.has(id));
  const unionCount = new Set([...beforeIds, ...afterIds]).size;
  const overlapRatio = unionCount === 0 ? 1 : Number((retainedIds.length / unionCount).toFixed(3));
  return {
    beforeCount: beforeIds.length,
    afterCount: afterIds.length,
    overlapCount: retainedIds.length,
    addedCount: addedIds.length,
    removedCount: removedIds.length,
    overlapRatio,
    retainedIds,
    addedIds,
    removedIds,
  };
}

function buildReviewPacketComparison(
  beforeFile: string,
  beforePacket: GovernanceReviewPacket,
  afterFile: string,
  afterPacket: GovernanceReviewPacket,
): GovernanceReviewPacketComparison {
  return {
    summary: {
      beforeFile,
      afterFile,
    },
    queues: {
      verify: compareReviewPacketQueue(beforePacket.queues.verify, afterPacket.queues.verify),
      archive: compareReviewPacketQueue(beforePacket.queues.archive, afterPacket.queues.archive),
    },
  };
}

function formatReviewPacket(packet: GovernanceReviewPacket): string {
  const lines = [
    "Governance Review Packet:",
    `• mode: ${packet.summary.mode}`,
    `• verify queue: ${packet.summary.verifyCount}`,
    `• archive queue: ${packet.summary.archiveCount}`,
    `• total items: ${packet.summary.totalReviewItems}`,
  ];

  const sections: Array<[string, GovernanceReviewPacketItem[]]> = [
    ["Verify queue", packet.queues.verify],
    ["Archive queue", packet.queues.archive],
  ];

  for (const [title, items] of sections) {
    lines.push("");
    lines.push(`${title}:`);
    if (items.length === 0) {
      lines.push("  (empty)");
      continue;
    }
    items.forEach((item, index) => {
      const atomic = item.atomic ? `unit=${item.atomic.unitType}, source=${item.atomic.sourceKind}` : "plain";
      lines.push(`  ${index + 1}. [${item.id}] ${item.proposedAction} / risk=${item.riskLevel}`);
      lines.push(`     - [${item.category}:${item.scope}] importance=${item.importance.toFixed(2)}, ${atomic}`);
      lines.push(`     - ${item.reasons.join("；")}`);
    });
  }

  return lines.join("\n");
}

function formatReviewPacketComparison(comparison: GovernanceReviewPacketComparison): string {
  const lines = [
    "Governance Review Packet Comparison:",
    `• before: ${comparison.summary.beforeFile}`,
    `• after: ${comparison.summary.afterFile}`,
  ];

  const sections: Array<[string, ReviewPacketQueueComparison]> = [
    ["Verify queue", comparison.queues.verify],
    ["Archive queue", comparison.queues.archive],
  ];

  for (const [title, queue] of sections) {
    lines.push("");
    lines.push(`${title}:`);
    lines.push(`  • before=${queue.beforeCount}, after=${queue.afterCount}, overlap=${queue.overlapCount}, ratio=${queue.overlapRatio}`);
    lines.push(`  • added=${queue.addedCount}, removed=${queue.removedCount}`);
    lines.push(`  • retained IDs: ${queue.retainedIds.join(", ") || "(none)"}`);
    lines.push(`  • added IDs: ${queue.addedIds.join(", ") || "(none)"}`);
    lines.push(`  • removed IDs: ${queue.removedIds.join(", ") || "(none)"}`);
  }

  return lines.join("\n");
}

function countBy<T extends string>(target: Record<string, number>, key: T | undefined) {
  if (!key) return;
  target[key] = (target[key] || 0) + 1;
}

function topEntries(map: Record<string, number>, limit = 8): Array<[string, number]> {
  return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function readNormalizationAudit(logPath: string): NormalizationAuditRecord[] {
  try {
    const raw = readFileSync(logPath, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as NormalizationAuditRecord);
  } catch {
    return [];
  }
}

function summarizeNormalizationAudit(logPath: string, limit = 10): NormalizationAuditSummary {
  const records = readNormalizationAudit(logPath);
  const sourceCounts: Record<string, number> = {};
  const fallbackCounts: Record<string, number> = {};
  const candidateRoleCounts: Record<string, number> = {};
  const candidateCategoryCounts: Record<string, number> = {};
  const candidateUnitTypeCounts: Record<string, number> = {};
  const entryModeCounts: Record<string, number> = {};
  const entryCategoryCounts: Record<string, number> = {};
  const entryUnitTypeCounts: Record<string, number> = {};
  const reasonCounts: Record<string, number> = {};
  const errorCounts: Record<string, number> = {};

  for (const record of records) {
    countBy(sourceCounts, record.source);
    countBy(fallbackCounts, record.fallback || "llm");
    countBy(candidateRoleCounts, record.candidate.role);
    countBy(candidateCategoryCounts, record.candidate.category);
    countBy(candidateUnitTypeCounts, record.candidate.unitType);
    for (const error of record.errors || []) countBy(errorCounts, error);
    for (const entry of record.entries || []) {
      countBy(entryModeCounts, entry.normalizationMode);
      countBy(entryCategoryCounts, entry.category);
      countBy(entryUnitTypeCounts, entry.atomic?.unitType);
      countBy(reasonCounts, entry.reason);
    }
  }

  const samples = records
    .filter((record) => record.fallback || (record.errors && record.errors.length > 0))
    .slice(-limit)
    .reverse()
    .map((record) => ({
      timestamp: record.timestamp,
      source: record.source,
      ...(record.fallback ? { fallback: record.fallback } : {}),
      ...(record.errors && record.errors.length > 0 ? { errors: record.errors } : {}),
      candidateText: record.candidate.text,
      entryTexts: (record.entries || []).map((entry) => entry.canonicalText),
    }));

  return {
    logPath,
    totalRecords: records.length,
    sourceCounts,
    fallbackCounts,
    candidateRoleCounts,
    candidateCategoryCounts,
    candidateUnitTypeCounts,
    entryModeCounts,
    entryCategoryCounts,
    entryUnitTypeCounts,
    reasonCounts,
    errorCounts,
    samples,
  };
}

function formatNormalizationAuditSummary(summary: NormalizationAuditSummary): string {
  const lines = [
    "Normalization Audit Summary:",
    `• logPath: ${summary.logPath}`,
    `• total records: ${summary.totalRecords}`,
    "",
    "By source:",
    ...topEntries(summary.sourceCounts).map(([key, value]) => `  • ${key}: ${value}`),
    "",
    "Fallback / path:",
    ...topEntries(summary.fallbackCounts).map(([key, value]) => `  • ${key}: ${value}`),
    "",
    "Candidate roles:",
    ...topEntries(summary.candidateRoleCounts).map(([key, value]) => `  • ${key}: ${value}`),
    "",
    "Candidate categories:",
    ...topEntries(summary.candidateCategoryCounts).map(([key, value]) => `  • ${key}: ${value}`),
    "",
    "Stored entry modes:",
    ...topEntries(summary.entryModeCounts).map(([key, value]) => `  • ${key}: ${value}`),
    "",
    "Stored entry categories:",
    ...topEntries(summary.entryCategoryCounts).map(([key, value]) => `  • ${key}: ${value}`),
    "",
    "Stored entry unit types:",
    ...topEntries(summary.entryUnitTypeCounts).map(([key, value]) => `  • ${key}: ${value}`),
  ];

  if (Object.keys(summary.reasonCounts).length > 0) {
    lines.push("", "Top reasons:");
    lines.push(...topEntries(summary.reasonCounts).map(([key, value]) => `  • ${key}: ${value}`));
  }

  if (Object.keys(summary.errorCounts).length > 0) {
    lines.push("", "Top errors:");
    lines.push(...topEntries(summary.errorCounts).map(([key, value]) => `  • ${key}: ${value}`));
  }

  if (summary.samples.length > 0) {
    lines.push("", "Recent fallback/error samples:");
    for (const sample of summary.samples) {
      lines.push(`  • ${new Date(sample.timestamp).toISOString()} [${sample.source}] ${sample.fallback || "error"}`);
      lines.push(`    candidate: ${sample.candidateText.slice(0, 140)}${sample.candidateText.length > 140 ? "..." : ""}`);
      if (sample.entryTexts.length > 0) {
        lines.push(`    stored: ${sample.entryTexts[0].slice(0, 140)}${sample.entryTexts[0].length > 140 ? "..." : ""}`);
      }
      if (sample.errors && sample.errors.length > 0) {
        lines.push(`    errors: ${sample.errors.join(" | ")}`);
      }
    }
  }

  return lines.join("\n");
}

// ============================================================================
// CLI Command Implementations
// ============================================================================

export function registerMemoryCLI(program: Command, context: CLIContext): void {
  const getSearchRetriever = (): MemoryRetriever => {
    if (!context.embedder) {
      return context.retriever;
    }
    return createRetriever(context.store, context.embedder, context.retriever.getConfig());
  };

  const runSearch = async (
    query: string,
    limit: number,
    scopeFilter?: string[],
    category?: string,
  ) => {
    let results = await getSearchRetriever().retrieve({
      query,
      limit,
      scopeFilter,
      category,
      source: "cli",
    });

    if (results.length === 0 && context.embedder) {
      await sleep(75);
      results = await getSearchRetriever().retrieve({
        query,
        limit,
        scopeFilter,
        category,
        source: "cli",
      });
    }

    return results;
  };

  const memory = program
    .command("memory-pro")
    .description("Enhanced memory management commands (LanceDB Pro)");

  // Version
  memory
    .command("version")
    .description("Print plugin version")
    .action(() => {
      console.log(getPluginVersion());
    });

  // List memories
  memory
    .command("list")
    .description("List memories with optional filtering")
    .option("--scope <scope>", "Filter by scope")
    .option("--category <category>", "Filter by category")
    .option("--limit <n>", "Maximum number of results", "20")
    .option("--offset <n>", "Number of results to skip", "0")
    .option("--json", "Output as JSON")
    .action(async (options) => {
      try {
        const limit = parseInt(options.limit) || 20;
        const offset = parseInt(options.offset) || 0;

        let scopeFilter: string[] | undefined;
        if (options.scope) {
          scopeFilter = [options.scope];
        }

        const memories = await context.store.list(
          scopeFilter,
          options.category,
          limit,
          offset
        );

        if (options.json) {
          console.log(formatJson(memories.map((memory) => serializeMemory(memory))));
        } else {
          if (memories.length === 0) {
            console.log("No memories found.");
          } else {
            console.log(`Found ${memories.length} memories:\n`);
            memories.forEach((memory, i) => {
              console.log(formatMemory(memory, offset + i));
            });
          }
        }
      } catch (error) {
        console.error("Failed to list memories:", error);
        process.exit(1);
      }
    });

  // Search memories
  memory
    .command("search <query>")
    .description("Search memories using hybrid retrieval")
    .option("--scope <scope>", "Search within specific scope")
    .option("--category <category>", "Filter by category")
    .option("--limit <n>", "Maximum number of results", "10")
    .option("--json", "Output as JSON")
    .action(async (query, options) => {
      try {
        const limit = parseInt(options.limit) || 10;

        let scopeFilter: string[] | undefined;
        if (options.scope) {
          scopeFilter = [options.scope];
        }

        const results = await runSearch(query, limit, scopeFilter, options.category);

        if (options.json) {
          console.log(formatJson(results));
        } else {
          if (results.length === 0) {
            console.log("No relevant memories found.");
          } else {
            console.log(`Found ${results.length} memories:\n`);
            results.forEach((result, i) => {
              const sources = [];
              if (result.sources.vector) sources.push("vector");
              if (result.sources.bm25) sources.push("BM25");
              if (result.sources.reranked) sources.push("reranked");

              console.log(
                `${i + 1}. [${result.entry.id}] [${result.entry.category}:${result.entry.scope}] ${result.entry.text} ` +
                `(${(result.score * 100).toFixed(0)}%, ${sources.join('+')})`
              );
            });
          }
        }
      } catch (error) {
        console.error("Search failed:", error);
        process.exit(1);
      }
    });

  // Memory statistics
  memory
    .command("stats")
    .description("Show memory statistics")
    .option("--scope <scope>", "Stats for specific scope")
    .option("--json", "Output as JSON")
    .action(async (options) => {
      try {
        let scopeFilter: string[] | undefined;
        if (options.scope) {
          scopeFilter = [options.scope];
        }

        const stats = await context.store.stats(scopeFilter);
        const scopeStats = context.scopeManager.getStats();
        const retrievalConfig = context.retriever.getConfig();

        const summary = {
          memory: stats,
          scopes: scopeStats,
          retrieval: {
            mode: retrievalConfig.mode,
            hasFtsSupport: context.store.hasFtsSupport,
          },
        };

        if (options.json) {
          console.log(formatJson(summary));
        } else {
          console.log(`Memory Statistics:`);
          console.log(`• Total memories: ${stats.totalCount}`);
          console.log(`• Atomic memories: ${stats.atomicCount}`);
          console.log(`• Available scopes: ${scopeStats.totalScopes}`);
          console.log(`• Retrieval mode: ${retrievalConfig.mode}`);
          console.log(`• FTS support: ${context.store.hasFtsSupport ? 'Yes' : 'No'}`);
          console.log();

          console.log("Memories by scope:");
          Object.entries(stats.scopeCounts).forEach(([scope, count]) => {
            console.log(`  • ${scope}: ${count}`);
          });
          console.log();

          console.log("Memories by category:");
          Object.entries(stats.categoryCounts).forEach(([category, count]) => {
            console.log(`  • ${category}: ${count}`);
          });

          console.log();
          console.log("Atomic memories by unit type:");
          if (Object.keys(stats.atomicUnitTypeCounts).length === 0) {
            console.log(`  • none`);
          } else {
            Object.entries(stats.atomicUnitTypeCounts).forEach(([unitType, count]) => {
              console.log(`  • ${unitType}: ${count}`);
            });
          }

          console.log();
          console.log("Atomic memories by source kind:");
          if (Object.keys(stats.atomicSourceKindCounts).length === 0) {
            console.log(`  • none`);
          } else {
            Object.entries(stats.atomicSourceKindCounts).forEach(([sourceKind, count]) => {
              console.log(`  • ${sourceKind}: ${count}`);
            });
          }
        }
      } catch (error) {
        console.error("Failed to get statistics:", error);
        process.exit(1);
      }
    });

  memory
    .command("normalization-audit [logFile]")
    .description("Summarize normalizer audit records to support self-maintenance")
    .option("--limit <n>", "Number of fallback/error samples to show", "10")
    .option("--json", "Output as JSON")
    .action(async (logFile, options) => {
      try {
        const resolvedLogPath = logFile
          ? String(logFile)
          : path.join(homedir(), ".openclaw", "memory", "normalizer-audit.jsonl");
        const limit = clampInt(parseInt(options.limit || "10", 10), 1, 50);
        const summary = summarizeNormalizationAudit(resolvedLogPath, limit);

        if (options.json) {
          console.log(formatJson(summary));
        } else {
          console.log(formatNormalizationAuditSummary(summary));
        }
      } catch (error) {
        console.error("Failed to summarize normalization audit:", error);
        process.exit(1);
      }
    });

  memory
    .command("governance-report")
    .description("Summarize memory governance candidates and plain-risk tiers")
    .option("--scope <scope>", "Filter by scope")
    .option("--limit <n>", "Maximum number of memories to scan (defaults to scope total)")
    .option("--json", "Output as JSON")
    .action(async (options) => {
      try {
        let scopeFilter: string[] | undefined;
        if (options.scope) {
          scopeFilter = [options.scope];
        }

        const stats = await context.store.stats(scopeFilter);
        const requestedLimit = options.limit ? clampInt(parseInt(options.limit), 1, 1000) : stats.totalCount;
        const scanLimit = clampInt(requestedLimit || stats.totalCount || 50, 1, 1000);
        const entries = await context.store.list(scopeFilter, undefined, scanLimit, 0);
        const report = buildGovernanceReport(entries);

        if (options.json) {
          console.log(formatJson(report));
        } else {
          console.log(formatGovernanceReport(report));
        }
      } catch (error) {
        console.error("Failed to build governance report:", error);
        process.exit(1);
      }
    });

  memory
    .command("observe-search <casesFile>")
    .description("Run a read-only query observation suite and summarize top-hit governance signals")
    .option("--scope <scope>", "Filter by scope")
    .option("--category <category>", "Filter all searches by category")
    .option("--limit <n>", "Maximum number of results per query", "3")
    .option("--json", "Output as JSON")
    .action(async (casesFile, options) => {
      try {
        const limit = clampInt(parseInt(options.limit), 1, 10);
        let scopeFilter: string[] | undefined;
        if (options.scope) {
          scopeFilter = [options.scope];
        }

        const cases = loadObservationCases(casesFile);
        const observations: SearchObservationCaseResult[] = [];

        for (const item of cases) {
          const results = await runSearch(item.query, limit, scopeFilter, options.category);
          observations.push(evaluateObservationCase(item, results));
        }

        const report = buildObservationReport(observations);
        if (options.json) {
          console.log(formatJson(report));
        } else {
          console.log(formatObservationReport(report));
        }
      } catch (error) {
        console.error("Search observation failed:", error);
        process.exit(1);
      }
    });

  memory
    .command("review-packet")
    .description("Build a read-only human-in-the-loop governance review packet from live memory")
    .option("--scope <scope>", "Filter by scope")
    .option("--mode <mode>", "Packet mode: all | verify | archive", "all")
    .option("--scan-limit <n>", "Maximum number of memories to scan (defaults to scope total)")
    .option("--limit <n>", "Maximum number of review items per queue", "10")
    .option("--json", "Output as JSON")
    .action(async (options) => {
      try {
        const mode = ["all", "verify", "archive"].includes(options.mode) ? options.mode : "all";
        const reviewLimit = clampInt(parseInt(options.limit), 1, 50);
        let scopeFilter: string[] | undefined;
        if (options.scope) {
          scopeFilter = [options.scope];
        }

        const stats = await context.store.stats(scopeFilter);
        const requestedLimit = options.scanLimit ? clampInt(parseInt(options.scanLimit), 1, 1000) : stats.totalCount;
        const scanLimit = clampInt(requestedLimit || stats.totalCount || 50, 1, 1000);
        const entries = await context.store.list(scopeFilter, undefined, scanLimit, 0);
        const report = buildGovernanceReport(entries);
        const packet = buildReviewPacket(report, mode as "all" | "verify" | "archive", reviewLimit);

        if (options.json) {
          console.log(formatJson(packet));
        } else {
          console.log(formatReviewPacket(packet));
        }
      } catch (error) {
        console.error("Failed to build governance review packet:", error);
        process.exit(1);
      }
    });

  memory
    .command("review-compare <beforeFile> <afterFile>")
    .description("Compare two review-packet JSON snapshots and report queue overlap/churn")
    .option("--json", "Output as JSON")
    .action(async (beforeFile, afterFile, options) => {
      try {
        const beforePacket = loadReviewPacketFile(beforeFile);
        const afterPacket = loadReviewPacketFile(afterFile);
        const comparison = buildReviewPacketComparison(beforeFile, beforePacket, afterFile, afterPacket);
        if (options.json) {
          console.log(formatJson(comparison));
        } else {
          console.log(formatReviewPacketComparison(comparison));
        }
      } catch (error) {
        console.error("Failed to compare governance review packets:", error);
        process.exit(1);
      }
    });

  // Delete memory
  memory
    .command("delete <id>")
    .description("Delete a specific memory by ID")
    .option("--scope <scope>", "Scope to delete from (for access control)")
    .action(async (id, options) => {
      try {
        let scopeFilter: string[] | undefined;
        if (options.scope) {
          scopeFilter = [options.scope];
        }

        const deleted = await context.store.delete(id, scopeFilter);

        if (deleted) {
          console.log(`Memory ${id} deleted successfully.`);
        } else {
          console.log(`Memory ${id} not found or access denied.`);
          process.exit(1);
        }
      } catch (error) {
        console.error("Failed to delete memory:", error);
        process.exit(1);
      }
    });

  // Bulk delete
  memory
    .command("delete-bulk")
    .description("Bulk delete memories with filters")
    .option("--scope <scopes...>", "Scopes to delete from (required)")
    .option("--before <date>", "Delete memories before this date (YYYY-MM-DD)")
    .option("--dry-run", "Show what would be deleted without actually deleting")
    .action(async (options) => {
      try {
        if (!options.scope || options.scope.length === 0) {
          console.error("At least one scope must be specified for safety.");
          process.exit(1);
        }

        let beforeTimestamp: number | undefined;
        if (options.before) {
          const date = new Date(options.before);
          if (isNaN(date.getTime())) {
            console.error("Invalid date format. Use YYYY-MM-DD.");
            process.exit(1);
          }
          beforeTimestamp = date.getTime();
        }

        if (options.dryRun) {
          console.log("DRY RUN - No memories will be deleted");
          console.log(`Filters: scopes=${options.scope.join(',')}, before=${options.before || 'none'}`);

          // Show what would be deleted
          const stats = await context.store.stats(options.scope);
          console.log(`Would delete from ${stats.totalCount} memories in matching scopes.`);
        } else {
          const deletedCount = await context.store.bulkDelete(options.scope, beforeTimestamp);
          console.log(`Deleted ${deletedCount} memories.`);
        }
      } catch (error) {
        console.error("Bulk delete failed:", error);
        process.exit(1);
      }
    });

  // Export memories
  memory
    .command("export")
    .description("Export memories to JSON")
    .option("--scope <scope>", "Export specific scope")
    .option("--category <category>", "Export specific category")
    .option("--output <file>", "Output file (default: stdout)")
    .action(async (options) => {
      try {
        let scopeFilter: string[] | undefined;
        if (options.scope) {
          scopeFilter = [options.scope];
        }

        const memories = await context.store.list(
          scopeFilter,
          options.category,
          1000 // Large limit for export
        );

        const exportData = {
          version: "1.0",
          exportedAt: new Date().toISOString(),
          count: memories.length,
          filters: {
            scope: options.scope,
            category: options.category,
          },
          memories: memories.map(m => ({
            ...m,
            vector: undefined, // Exclude vectors to reduce size
          })),
        };

        const output = formatJson(exportData);

        if (options.output) {
          const fs = await import("node:fs/promises");
          await fs.writeFile(options.output, output);
          console.log(`Exported ${memories.length} memories to ${options.output}`);
        } else {
          console.log(output);
        }
      } catch (error) {
        console.error("Export failed:", error);
        process.exit(1);
      }
    });

  // Import memories
  memory
    .command("import <file>")
    .description("Import memories from JSON file")
    .option("--scope <scope>", "Import into specific scope")
    .option("--dry-run", "Show what would be imported without actually importing")
    .action(async (file, options) => {
      try {
        const fs = await import("node:fs/promises");
        const content = await fs.readFile(file, "utf-8");
        const data = JSON.parse(content);

        if (!data.memories || !Array.isArray(data.memories)) {
          throw new Error("Invalid import file format");
        }

        if (options.dryRun) {
          console.log("DRY RUN - No memories will be imported");
          console.log(`Would import ${data.memories.length} memories`);
          if (options.scope) {
            console.log(`Target scope: ${options.scope}`);
          }
          return;
        }

        console.log(`Importing ${data.memories.length} memories...`);

        let imported = 0;
        let skipped = 0;

        if (!context.embedder) {
          console.error("Import requires an embedder (not available in basic CLI mode).");
          console.error("Use the plugin's memory_store tool or pass embedder to createMemoryCLI.");
          return;
        }

        const targetScope = options.scope || context.scopeManager.getDefaultScope();

        for (const memory of data.memories) {
          try {
            const text = memory.text;
            if (!text || typeof text !== "string" || text.length < 2) {
              skipped++;
              continue;
            }

            const categoryRaw = memory.category;
            const category: MemoryEntry["category"] =
              categoryRaw === "preference" ||
              categoryRaw === "fact" ||
              categoryRaw === "decision" ||
              categoryRaw === "entity" ||
              categoryRaw === "other"
                ? categoryRaw
                : "other";

            const importanceRaw = Number(memory.importance);
            const importance = Number.isFinite(importanceRaw)
              ? Math.max(0, Math.min(1, importanceRaw))
              : 0.7;

            const timestampRaw = Number(memory.timestamp);
            const timestamp = Number.isFinite(timestampRaw) ? timestampRaw : Date.now();

            const metadataRaw = memory.metadata;
            const metadata =
              typeof metadataRaw === "string"
                ? metadataRaw
                : metadataRaw != null
                  ? JSON.stringify(metadataRaw)
                  : "{}";

            const idRaw = memory.id;
            const id = typeof idRaw === "string" && idRaw.length > 0 ? idRaw : undefined;

            if (id && (await context.store.hasId(id))) {
              skipped++;
              continue;
            }

            if (!id) {
              const existing = await context.retriever.retrieve({
                query: text,
                limit: 1,
                scopeFilter: [targetScope],
              });
              if (existing.length > 0 && existing[0].score > 0.95) {
                skipped++;
                continue;
              }
            }

            const vector = await context.embedder.embedPassage(text);
            const effectiveScope = options.scope || memory.scope || targetScope;
            if (id) {
              await context.store.importEntry({
                id,
                text,
                vector,
                category,
                scope: effectiveScope,
                importance,
                timestamp,
                metadata,
              });
            } else {
              await context.store.store({
                text,
                vector,
                importance,
                category,
                scope: effectiveScope,
                metadata,
              });
            }
            imported++;
          } catch (error) {
            console.warn(`Failed to import memory: ${error}`);
            skipped++;
          }
        }

        console.log(`Import completed: ${imported} imported, ${skipped} skipped`);
      } catch (error) {
        console.error("Import failed:", error);
        process.exit(1);
      }
    });

  // Re-embed an existing LanceDB into the current target DB (A/B testing)
  memory
    .command("reembed")
    .description("Re-embed memories from a source LanceDB database into the current target database")
    .requiredOption("--source-db <path>", "Source LanceDB database directory")
    .option("--batch-size <n>", "Batch size for embedding calls", "32")
    .option("--limit <n>", "Limit number of rows to process (for testing)")
    .option("--dry-run", "Show what would be re-embedded without writing")
    .option("--skip-existing", "Skip entries whose id already exists in the target DB")
    .option("--force", "Allow using the same source-db as the target dbPath (DANGEROUS)")
    .action(async (options) => {
      try {
        if (!context.embedder) {
          console.error("Re-embed requires an embedder (not available in basic CLI mode).");
          return;
        }

        const fs = await import("node:fs/promises");

        const sourceDbPath = options.sourceDb as string;
        const batchSize = clampInt(parseInt(options.batchSize, 10) || 32, 1, 128);
        const limit = options.limit ? clampInt(parseInt(options.limit, 10) || 0, 1, 1000000) : undefined;
        const dryRun = options.dryRun === true;
        const skipExisting = options.skipExisting === true;
        const force = options.force === true;

        // Safety: prevent accidental in-place re-embedding
        let sourceReal = sourceDbPath;
        let targetReal = context.store.dbPath;
        try {
          sourceReal = await fs.realpath(sourceDbPath);
        } catch {}
        try {
          targetReal = await fs.realpath(context.store.dbPath);
        } catch {}

        if (!force && sourceReal === targetReal) {
          console.error("Refusing to re-embed in-place: source-db equals target dbPath. Use a new dbPath or pass --force.");
          process.exit(1);
        }

        const lancedb = await loadLanceDB();
        const db = await lancedb.connect(sourceDbPath);
        const table = await db.openTable("memories");

        let query = table
          .query()
          .select(["id", "text", "category", "scope", "importance", "timestamp", "metadata"]);

        if (limit) query = query.limit(limit);

        const rows = (await query.toArray())
          .filter((r: any) => r && typeof r.text === "string" && r.text.trim().length > 0)
          .filter((r: any) => r.id && r.id !== "__schema__");

        if (rows.length === 0) {
          console.log("No source memories found.");
          return;
        }

        console.log(
          `Re-embedding ${rows.length} memories from ${sourceDbPath} → ${context.store.dbPath} (batchSize=${batchSize})`
        );

        if (dryRun) {
          console.log("DRY RUN - No memories will be written");
          console.log(`First example: ${rows[0].id?.slice?.(0, 8)} ${String(rows[0].text).slice(0, 80)}`);
          return;
        }

        let processed = 0;
        let imported = 0;
        let skipped = 0;

        for (let i = 0; i < rows.length; i += batchSize) {
          const batch = rows.slice(i, i + batchSize);
          const texts = batch.map((r: any) => String(r.text));
          const vectors = await context.embedder.embedBatchPassage(texts);

          for (let j = 0; j < batch.length; j++) {
            processed++;
            const row = batch[j];
            const vector = vectors[j];

            if (!vector || vector.length === 0) {
              skipped++;
              continue;
            }

            const id = String(row.id);
            if (skipExisting) {
              const exists = await context.store.hasId(id);
              if (exists) {
                skipped++;
                continue;
              }
            }

            const entry: MemoryEntry = {
              id,
              text: String(row.text),
              vector,
              category: (row.category as any) || "other",
              scope: (row.scope as string | undefined) || "global",
              importance: (row.importance != null) ? Number(row.importance) : 0.7,
              timestamp: (row.timestamp != null) ? Number(row.timestamp) : Date.now(),
              metadata: typeof row.metadata === "string" ? row.metadata : "{}",
            };

            await context.store.importEntry(entry);
            imported++;
          }

          if (processed % 100 === 0 || processed === rows.length) {
            console.log(`Progress: ${processed}/${rows.length} processed, ${imported} imported, ${skipped} skipped`);
          }
        }

        console.log(`Re-embed completed: ${imported} imported, ${skipped} skipped (processed=${processed}).`);
      } catch (error) {
        console.error("Re-embed failed:", error);
        process.exit(1);
      }
    });

  // Migration commands
  const migrate = memory
    .command("migrate")
    .description("Migration utilities");

  migrate
    .command("check")
    .description("Check if migration is needed from legacy memory-lancedb")
    .option("--source <path>", "Specific source database path")
    .action(async (options) => {
      try {
        const check = await context.migrator.checkMigrationNeeded(options.source);

        console.log("Migration Check Results:");
        console.log(`• Legacy database found: ${check.sourceFound ? 'Yes' : 'No'}`);
        if (check.sourceDbPath) {
          console.log(`• Source path: ${check.sourceDbPath}`);
        }
        if (check.entryCount !== undefined) {
          console.log(`• Entries to migrate: ${check.entryCount}`);
        }
        console.log(`• Migration needed: ${check.needed ? 'Yes' : 'No'}`);
      } catch (error) {
        console.error("Migration check failed:", error);
        process.exit(1);
      }
    });

  migrate
    .command("run")
    .description("Run migration from legacy memory-lancedb")
    .option("--source <path>", "Specific source database path")
    .option("--default-scope <scope>", "Default scope for migrated data", "global")
    .option("--dry-run", "Show what would be migrated without actually migrating")
    .option("--skip-existing", "Skip entries that already exist")
    .action(async (options) => {
      try {
        const result = await context.migrator.migrate({
          sourceDbPath: options.source,
          defaultScope: options.defaultScope,
          dryRun: options.dryRun,
          skipExisting: options.skipExisting,
        });

        console.log("Migration Results:");
        console.log(`• Status: ${result.success ? 'Success' : 'Failed'}`);
        console.log(`• Migrated: ${result.migratedCount}`);
        console.log(`• Skipped: ${result.skippedCount}`);
        if (result.errors.length > 0) {
          console.log(`• Errors: ${result.errors.length}`);
          result.errors.forEach(error => console.log(`  - ${error}`));
        }
        console.log(`• Summary: ${result.summary}`);

        if (!result.success) {
          process.exit(1);
        }
      } catch (error) {
        console.error("Migration failed:", error);
        process.exit(1);
      }
    });

  migrate
    .command("verify")
    .description("Verify migration results")
    .option("--source <path>", "Specific source database path")
    .action(async (options) => {
      try {
        const result = await context.migrator.verifyMigration(options.source);

        console.log("Migration Verification:");
        console.log(`• Valid: ${result.valid ? 'Yes' : 'No'}`);
        console.log(`• Source count: ${result.sourceCount}`);
        console.log(`• Target count: ${result.targetCount}`);

        if (result.issues.length > 0) {
          console.log("• Issues:");
          result.issues.forEach(issue => console.log(`  - ${issue}`));
        }

        if (!result.valid) {
          process.exit(1);
        }
      } catch (error) {
        console.error("Verification failed:", error);
        process.exit(1);
      }
    });
}

// ============================================================================
// Factory Function
// ============================================================================

export function createMemoryCLI(context: CLIContext) {
  return ({ program }: { program: Command }) => registerMemoryCLI(program, context);
}
