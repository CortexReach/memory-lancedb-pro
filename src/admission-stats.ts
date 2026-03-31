import { readFile } from "node:fs/promises";
import type { AdmissionControlConfig, AdmissionRejectionAuditEntry } from "./admission-control.js";
import { resolveRejectedAuditFilePath } from "./admission-control.js";
import { parseSmartMetadata } from "./smart-metadata.js";

const DEFAULT_TOP_REJECTION_REASONS = 5;
const ADMISSION_WINDOWS = [
  { key: "last24h", durationMs: 24 * 60 * 60 * 1000 },
  { key: "last7d", durationMs: 7 * 24 * 60 * 60 * 1000 },
] as const;

export interface AdmissionAuditedMemoryLike {
  metadata?: string;
  timestamp?: number;
  category?: string;
  text?: string;
  importance?: number;
}

export interface AdmissionStatsStoreLike {
  dbPath: string;
  list?: (
    scopeFilter?: string[],
    category?: string,
    limit?: number,
    offset?: number,
  ) => Promise<AdmissionAuditedMemoryLike[]>;
}

export interface AdmissionCategoryBreakdown {
  admittedCount: number | null;
  rejectedCount: number;
  totalObserved: number | null;
  rejectRate: number | null;
}

export interface AdmissionWindowBreakdown {
  admittedCount: number | null;
  rejectedCount: number;
  totalObserved: number | null;
  rejectRate: number | null;
}

export interface AdmissionRejectionReasonCount {
  label: string;
  count: number;
}

export interface AdmissionRejectionSummary {
  total: number;
  latestRejectedAt: number | null;
  byCategory: Record<string, number>;
  byScope: Record<string, number>;
  topReasons: AdmissionRejectionReasonCount[];
}

export interface AdmissionStatsSummary {
  enabled: boolean;
  auditMetadataEnabled: boolean;
  rejectedAuditFilePath: string;
  rejectedCount: number;
  admittedCount: number | null;
  totalObserved: number | null;
  rejectRate: number | null;
  latestRejectedAt: number | null;
  rejectedByCategory: Record<string, number>;
  rejectedByScope: Record<string, number>;
  categoryBreakdown: Record<string, AdmissionCategoryBreakdown>;
  topReasons: AdmissionRejectionReasonCount[];
  windows: Record<string, AdmissionWindowBreakdown>;
  observedAuditedMemories: number;
}

export async function readAdmissionRejectionAudits(
  filePath: string,
): Promise<AdmissionRejectionAuditEntry[]> {
  try {
    const raw = await readFile(filePath, "utf8");
    const entries: AdmissionRejectionAuditEntry[] = [];
    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        entries.push(JSON.parse(line) as AdmissionRejectionAuditEntry);
      } catch {
        // Skip corrupt JSONL lines (truncated writes, disk errors, etc.)
      }
    }
    return entries;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export function normalizeReasonKey(reason: string): string {
  return reason
    .toLowerCase()
    .replace(/\d+(?:\.\d+)?/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractAdmissionReasonLabel(entry: AdmissionRejectionAuditEntry): string {
  const utilityReason = entry.audit.utility_reason?.trim();
  if (utilityReason) {
    return utilityReason;
  }
  return entry.audit.reason.trim();
}

export function summarizeAdmissionRejections(
  entries: AdmissionRejectionAuditEntry[],
): AdmissionRejectionSummary {
  const byCategory: Record<string, number> = {};
  const byScope: Record<string, number> = {};
  const reasonCounts = new Map<string, AdmissionRejectionReasonCount>();

  for (const entry of entries) {
    byCategory[entry.candidate.category] = (byCategory[entry.candidate.category] ?? 0) + 1;
    byScope[entry.target_scope] = (byScope[entry.target_scope] ?? 0) + 1;
    const label = extractAdmissionReasonLabel(entry);
    const key = normalizeReasonKey(label);
    const current = reasonCounts.get(key);
    if (current) {
      current.count += 1;
    } else {
      reasonCounts.set(key, { label, count: 1 });
    }
  }

  const latestRejectedAt = entries.length > 0
    ? Math.max(...entries.map((entry) => entry.rejected_at))
    : null;
  const topReasons = Array.from(reasonCounts.values())
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
    .slice(0, DEFAULT_TOP_REJECTION_REASONS);

  return {
    total: entries.length,
    latestRejectedAt,
    byCategory,
    byScope,
    topReasons,
  };
}

export function getAdmissionAuditDecision(
  entry: { metadata?: string },
): "pass_to_dedup" | "reject" | null {
  try {
    const parsed = JSON.parse(entry.metadata || "{}") as Record<string, unknown>;
    const audit = parsed.admission_control as Record<string, unknown> | undefined;
    const decision = audit?.decision;
    return decision === "pass_to_dedup" || decision === "reject" ? decision : null;
  } catch {
    return null;
  }
}

export function getAdmittedDecisionTimestamp(
  entry: { metadata?: string; timestamp?: number },
): number | null {
  try {
    const parsed = JSON.parse(entry.metadata || "{}") as Record<string, unknown>;
    const audit = parsed.admission_control as Record<string, unknown> | undefined;
    const evaluatedAt = Number(audit?.evaluated_at);
    if (Number.isFinite(evaluatedAt) && evaluatedAt > 0) {
      return evaluatedAt;
    }
  } catch {
    // ignore
  }

  const timestamp = Number(entry.timestamp);
  if (Number.isFinite(timestamp) && timestamp > 0) {
    return timestamp;
  }
  return null;
}

export function getObservedAdmissionCategory(
  entry: AdmissionAuditedMemoryLike,
): string {
  return parseSmartMetadata(entry.metadata, entry).memory_category || entry.category || "patterns";
}

export function buildAdmissionCategoryBreakdown(
  admittedCategories: string[] | null,
  rejectedEntries: AdmissionRejectionAuditEntry[],
): Record<string, AdmissionCategoryBreakdown> {
  const admittedCounts: Record<string, number> | null = admittedCategories ? {} : null;
  const rejectedCounts: Record<string, number> = {};

  if (admittedCategories) {
    for (const category of admittedCategories) {
      admittedCounts[category] = (admittedCounts[category] ?? 0) + 1;
    }
  }

  for (const entry of rejectedEntries) {
    const category = entry.candidate.category;
    rejectedCounts[category] = (rejectedCounts[category] ?? 0) + 1;
  }

  const categories = Array.from(
    new Set([
      ...Object.keys(rejectedCounts),
      ...(admittedCounts ? Object.keys(admittedCounts) : []),
    ]),
  ).sort((left, right) => left.localeCompare(right));

  const breakdown: Record<string, AdmissionCategoryBreakdown> = {};
  for (const category of categories) {
    const admittedCount = admittedCounts ? (admittedCounts[category] ?? 0) : null;
    const rejectedCount = rejectedCounts[category] ?? 0;
    const totalObserved = admittedCount !== null ? admittedCount + rejectedCount : null;
    const rejectRate =
      totalObserved && totalObserved > 0 ? rejectedCount / totalObserved : null;

    breakdown[category] = {
      admittedCount,
      rejectedCount,
      totalObserved,
      rejectRate,
    };
  }

  return breakdown;
}

export function buildAdmissionWindowSummary(
  admittedTimestamps: number[] | null,
  rejectedEntries: AdmissionRejectionAuditEntry[],
  now = Date.now(),
): Record<string, AdmissionWindowBreakdown> {
  const windows: Record<string, AdmissionWindowBreakdown> = {};

  for (const windowDef of ADMISSION_WINDOWS) {
    const since = now - windowDef.durationMs;
    const rejectedCount = rejectedEntries.filter((entry) => entry.rejected_at >= since).length;
    const admittedCount = admittedTimestamps
      ? admittedTimestamps.filter((ts) => ts >= since).length
      : null;
    const totalObserved = admittedCount !== null ? admittedCount + rejectedCount : null;
    const rejectRate =
      totalObserved && totalObserved > 0 ? rejectedCount / totalObserved : null;

    windows[windowDef.key] = {
      admittedCount,
      rejectedCount,
      totalObserved,
      rejectRate,
    };
  }

  return windows;
}

export async function buildAdmissionStats(params: {
  store: AdmissionStatsStoreLike;
  admissionControl?: AdmissionControlConfig;
  scopeFilter?: string[];
  memoryTotalCount: number;
}): Promise<AdmissionStatsSummary> {
  const rejectionFilePath = resolveRejectedAuditFilePath(
    params.store.dbPath,
    params.admissionControl,
  );
  let rejectionEntries = await readAdmissionRejectionAudits(rejectionFilePath);
  if (params.scopeFilter && params.scopeFilter.length > 0) {
    const scopeSet = new Set(params.scopeFilter);
    rejectionEntries = rejectionEntries.filter((entry) => scopeSet.has(entry.target_scope));
  }

  const rejectionSummary = summarizeAdmissionRejections(rejectionEntries);
  const auditMetadataEnabled = params.admissionControl?.auditMetadata !== false;
  let admittedCount: number | null = null;
  let admittedTimestamps: number[] | null = null;
  let admittedCategories: string[] | null = null;
  let observedAuditedMemories = 0;

  if (auditMetadataEnabled && typeof params.store.list === "function") {
    const memories = await params.store.list(
      params.scopeFilter,
      undefined,
      Math.max(params.memoryTotalCount, 1),
      0,
    );
    admittedCount = 0;
    admittedTimestamps = [];
    admittedCategories = [];
    for (const memory of memories) {
      const decision = getAdmissionAuditDecision(memory);
      if (decision === "pass_to_dedup") {
        admittedCount += 1;
        observedAuditedMemories += 1;
        admittedCategories.push(getObservedAdmissionCategory(memory));
        const admittedAt = getAdmittedDecisionTimestamp(memory);
        if (admittedAt !== null) {
          admittedTimestamps.push(admittedAt);
        }
      } else if (decision === "reject") {
        observedAuditedMemories += 1;
      }
    }
  }

  const totalObserved = admittedCount !== null ? admittedCount + rejectionSummary.total : null;
  const rejectRate =
    totalObserved && totalObserved > 0 ? rejectionSummary.total / totalObserved : null;

  return {
    enabled: params.admissionControl?.enabled === true,
    auditMetadataEnabled,
    rejectedAuditFilePath: rejectionFilePath,
    rejectedCount: rejectionSummary.total,
    admittedCount,
    totalObserved,
    rejectRate,
    latestRejectedAt: rejectionSummary.latestRejectedAt,
    rejectedByCategory: rejectionSummary.byCategory,
    rejectedByScope: rejectionSummary.byScope,
    categoryBreakdown: buildAdmissionCategoryBreakdown(admittedCategories, rejectionEntries),
    topReasons: rejectionSummary.topReasons,
    windows: buildAdmissionWindowSummary(admittedTimestamps, rejectionEntries),
    observedAuditedMemories,
  };
}
