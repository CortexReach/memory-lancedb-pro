export interface ReflectionSlices {
  invariants: string[];
  derived: string[];
}

export interface ReflectionMappedMemory {
  text: string;
  category: "preference" | "fact" | "decision";
  heading: string;
}

export type ReflectionMappedKind = "user-model" | "agent-model" | "lesson" | "decision";

export interface ReflectionMappedMemoryItem extends ReflectionMappedMemory {
  mappedKind: ReflectionMappedKind;
  ordinal: number;
  groupSize: number;
}

export interface ReflectionSliceItem {
  text: string;
  itemKind: "invariant" | "derived";
  section: "Invariants" | "Derived";
  ordinal: number;
  groupSize: number;
}

export interface ReflectionGovernanceEntry {
  priority?: string;
  status?: string;
  area?: string;
  summary: string;
  details?: string;
  suggestedAction?: string;
}

export function extractSectionMarkdown(markdown: string, heading: string): string {
  const lines = markdown.split(/\r?\n/);
  const headingNeedle = `## ${heading}`.toLowerCase();
  let inSection = false;
  const collected: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    const lower = line.toLowerCase();
    if (lower.startsWith("## ")) {
      if (inSection && lower !== headingNeedle) break;
      inSection = lower === headingNeedle;
      continue;
    }
    if (!inSection) continue;
    collected.push(raw);
  }
  return collected.join("\n").trim();
}

export function parseSectionBullets(markdown: string, heading: string): string[] {
  const lines = extractSectionMarkdown(markdown, heading).split(/\r?\n/);
  const collected: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("- ") || line.startsWith("* ")) {
      const normalized = line.slice(2).trim();
      if (normalized) collected.push(normalized);
    }
  }
  return collected;
}

export function isPlaceholderReflectionSliceLine(line: string): boolean {
  const normalized = line.replace(/\*\*/g, "").trim();
  if (!normalized) return true;
  if (/^\(none( captured)?\)$/i.test(normalized)) return true;
  if (/^(invariants?|reflections?|derived)[:：]$/i.test(normalized)) return true;
  if (/apply this session'?s deltas next run/i.test(normalized)) return true;
  if (/apply this session'?s distilled changes next run/i.test(normalized)) return true;
  if (/investigate why embedded reflection generation failed/i.test(normalized)) return true;
  return false;
}

export function normalizeReflectionSliceLine(line: string): string {
  return line
    .replace(/\*\*/g, "")
    .replace(/^(invariants?|reflections?|derived)[:：]\s*/i, "")
    .trim();
}

export function sanitizeReflectionSliceLines(lines: string[]): string[] {
  return lines
    .map(normalizeReflectionSliceLine)
    .filter((line) => !isPlaceholderReflectionSliceLine(line));
}

const INJECTABLE_REFLECTION_BLOCK_PATTERNS: RegExp[] = [
  /^\s*(?:(?:next|this)\s+run\s+)?(?:ignore|disregard|forget|override|bypass)\b[\s\S]{0,80}\b(?:instructions?|guardrails?|policy|developer|system)\b/i,
  /\b(?:reveal|print|dump|show|output)\b[\s\S]{0,80}\b(?:system prompt|developer prompt|hidden prompt|hidden instructions?|full prompt|prompt verbatim|secrets?|keys?|tokens?)\b/i,
  /<\s*\/?\s*(?:system|assistant|user|tool|developer|inherited-rules|derived-focus)\b[^>]*>/i,
  /^(?:system|assistant|user|developer|tool)\s*:/i,
];

export function isUnsafeInjectableReflectionLine(line: string): boolean {
  const normalized = normalizeReflectionSliceLine(line);
  if (!normalized) return true;
  return INJECTABLE_REFLECTION_BLOCK_PATTERNS.some((pattern) =>
    pattern.test(normalized),
  );
}

export function sanitizeInjectableReflectionLines(lines: string[]): string[] {
  return sanitizeReflectionSliceLines(lines).filter(
    (line) => !isUnsafeInjectableReflectionLine(line),
  );
}

function isInvariantRuleLike(line: string): boolean {
  return /^(always|never|when\b|if\b|before\b|after\b|prefer\b|avoid\b|require\b|only\b|do not\b|must\b|should\b)/i.test(line) ||
    /\b(must|should|never|always|prefer|avoid|required?)\b/i.test(line);
}

function isDerivedDeltaLike(line: string): boolean {
  return /^(this run|next run|going forward|follow-up|re-check|retest|verify|confirm|avoid repeating|adjust|change|update|retry|keep|watch)\b/i.test(line) ||
    /\b(this run|next run|delta|change|adjust|retry|re-check|retest|verify|confirm|avoid repeating|follow-up)\b/i.test(line);
}

function isOpenLoopAction(line: string): boolean {
  return /^(investigate|verify|confirm|re-check|retest|update|add|remove|fix|avoid|keep|watch|document)\b/i.test(line);
}

export function extractReflectionLessons(reflectionText: string): string[] {
  return sanitizeReflectionSliceLines(parseSectionBullets(reflectionText, "Lessons & pitfalls (symptom / cause / fix / prevention)"));
}

export function extractReflectionLearningGovernanceCandidates(reflectionText: string): ReflectionGovernanceEntry[] {
  const section = extractSectionMarkdown(reflectionText, "Learning governance candidates (.learnings / promotion / skill extraction)");
  if (!section) return [];

  const entryBlocks = section
    .split(/(?=^###\s+Entry\b)/gim)
    .map((block) => block.trim())
    .filter(Boolean);

  const parsed = entryBlocks
    .map(parseReflectionGovernanceEntry)
    .filter((entry): entry is ReflectionGovernanceEntry => entry !== null);

  if (parsed.length > 0) return parsed;

  const fallbackBullets = sanitizeReflectionSliceLines(
    parseSectionBullets(reflectionText, "Learning governance candidates (.learnings / promotion / skill extraction)")
  );
  if (fallbackBullets.length === 0) return [];

  return [{
    priority: "medium",
    status: "pending",
    area: "config",
    summary: "Reflection learning governance candidates",
    details: fallbackBullets.map((line) => `- ${line}`).join("\n"),
    suggestedAction: "Review the governance candidates, promote durable rules to AGENTS.md / SOUL.md / TOOLS.md when stable, and extract a skill if the pattern becomes reusable.",
  }];
}

function parseReflectionGovernanceEntry(block: string): ReflectionGovernanceEntry | null {
  const body = block.replace(/^###\s+Entry\b[^\n]*\n?/i, "").trim();
  if (!body) return null;

  const readField = (label: string): string | undefined => {
    const match = body.match(new RegExp(`^\\*\\*${label}\\*\\*:\\s*(.+)$`, "im"));
    const value = match?.[1]?.trim();
    return value ? value : undefined;
  };

  const readSection = (label: string): string | undefined => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = body.match(new RegExp(`^###\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=^###\\s+|$)`, "im"));
    const value = match?.[1]?.trim();
    return value ? value : undefined;
  };

  const summary = readSection("Summary");
  if (!summary) return null;

  return {
    priority: readField("Priority"),
    status: readField("Status"),
    area: readField("Area"),
    summary,
    details: readSection("Details"),
    suggestedAction: readSection("Suggested Action"),
  };
}

export function extractReflectionMappedMemories(reflectionText: string): ReflectionMappedMemory[] {
  return extractReflectionMappedMemoryItems(reflectionText).map(({ text, category, heading }) => ({ text, category, heading }));
}

function extractReflectionMappedMemoryItemsWithSanitizer(
  reflectionText: string,
  sanitizeLines: (lines: string[]) => string[],
): ReflectionMappedMemoryItem[] {
  const mappedSections: Array<{
    heading: string;
    category: "preference" | "fact" | "decision";
    mappedKind: ReflectionMappedKind;
  }> = [
    {
      heading: "User model deltas (about the human)",
      category: "preference",
      mappedKind: "user-model",
    },
    {
      heading: "Agent model deltas (about the assistant/system)",
      category: "preference",
      mappedKind: "agent-model",
    },
    {
      heading: "Lessons & pitfalls (symptom / cause / fix / prevention)",
      category: "fact",
      mappedKind: "lesson",
    },
    {
      heading: "Decisions (durable)",
      category: "decision",
      mappedKind: "decision",
    },
  ];

  return mappedSections.flatMap(({ heading, category, mappedKind }) => {
    const lines = sanitizeLines(parseSectionBullets(reflectionText, heading));
    const groupSize = lines.length;
    return lines.map((text, ordinal) => ({ text, category, heading, mappedKind, ordinal, groupSize }));
  });
}

export function extractReflectionMappedMemoryItems(reflectionText: string): ReflectionMappedMemoryItem[] {
  return extractReflectionMappedMemoryItemsWithSanitizer(reflectionText, sanitizeReflectionSliceLines);
}

export function extractInjectableReflectionMappedMemoryItems(reflectionText: string): ReflectionMappedMemoryItem[] {
  return extractReflectionMappedMemoryItemsWithSanitizer(reflectionText, sanitizeInjectableReflectionLines);
}

export function extractInjectableReflectionMappedMemories(reflectionText: string): ReflectionMappedMemory[] {
  return extractInjectableReflectionMappedMemoryItems(reflectionText).map(({ text, category, heading }) => ({ text, category, heading }));
}

function extractReflectionSlicesWithSanitizer(
  reflectionText: string,
  sanitizeLines: (lines: string[]) => string[],
): ReflectionSlices {
  const invariantSection = parseSectionBullets(reflectionText, "Invariants");
  const derivedSection = parseSectionBullets(reflectionText, "Derived");
  const mergedSection = parseSectionBullets(reflectionText, "Invariants & Reflections");

  const invariantsPrimary = sanitizeLines(invariantSection).filter(isInvariantRuleLike);
  const derivedPrimary = sanitizeLines(derivedSection).filter(isDerivedDeltaLike);

  const invariantLinesLegacy = sanitizeLines(
    mergedSection.filter((line) => /invariant|stable|policy|rule/i.test(line))
  ).filter(isInvariantRuleLike);
  const reflectionLinesLegacy = sanitizeLines(
    mergedSection.filter((line) => /reflect|inherit|derive|change|apply/i.test(line))
  ).filter(isDerivedDeltaLike);
  const openLoopLines = sanitizeLines(parseSectionBullets(reflectionText, "Open loops / next actions"))
    .filter(isOpenLoopAction)
    .filter(isDerivedDeltaLike);
  const durableDecisionLines = sanitizeLines(parseSectionBullets(reflectionText, "Decisions (durable)"))
    .filter(isInvariantRuleLike);

  const invariants = invariantsPrimary.length > 0
    ? invariantsPrimary
    : (invariantLinesLegacy.length > 0 ? invariantLinesLegacy : durableDecisionLines);
  const derived = derivedPrimary.length > 0
    ? derivedPrimary
    : [...reflectionLinesLegacy, ...openLoopLines];

  return {
    invariants: invariants.slice(0, 8),
    derived: derived.slice(0, 10),
  };
}

export function extractReflectionSlices(reflectionText: string): ReflectionSlices {
  return extractReflectionSlicesWithSanitizer(reflectionText, sanitizeReflectionSliceLines);
}

export function extractInjectableReflectionSlices(reflectionText: string): ReflectionSlices {
  return extractReflectionSlicesWithSanitizer(reflectionText, sanitizeInjectableReflectionLines);
}

function buildReflectionSliceItemsFromSlices(slices: ReflectionSlices): ReflectionSliceItem[] {
  const invariantGroupSize = slices.invariants.length;
  const derivedGroupSize = slices.derived.length;

  const invariantItems = slices.invariants.map((text, ordinal) => ({
    text,
    itemKind: "invariant" as const,
    section: "Invariants" as const,
    ordinal,
    groupSize: invariantGroupSize,
  }));
  const derivedItems = slices.derived.map((text, ordinal) => ({
    text,
    itemKind: "derived" as const,
    section: "Derived" as const,
    ordinal,
    groupSize: derivedGroupSize,
  }));

  return [...invariantItems, ...derivedItems];
}

export function extractReflectionSliceItems(reflectionText: string): ReflectionSliceItem[] {
  return buildReflectionSliceItemsFromSlices(extractReflectionSlices(reflectionText));
}

export function extractInjectableReflectionSliceItems(reflectionText: string): ReflectionSliceItem[] {
  return buildReflectionSliceItemsFromSlices(extractInjectableReflectionSlices(reflectionText));
}

/**
 * 判斷回應是否實際使用了注入的記憶 ID 或摘要。
 * - 回應長度 <= 24：不視為使用（太短）
 * - injectedIds + injectedSummaries 都為空：不視為使用
 * - 有 usage marker（如「教練我記得」）+ 對應 ID：視為使用
 * - 有 usage marker + verbatim summary match（>=10 字元）：視為使用
 */
export function isRecallUsed(
  response: string,
  injectedIds: string[],
  injectedSummaries: string[]
): boolean {
  if (response.length <= 24) return false;
  if (injectedIds.length === 0 && injectedSummaries.length === 0) return false;

  const hasUsageMarker = /教練|教練我|教練我記得|記得|memory|id[-:]/i.test(response);

  if (injectedIds.length > 0) {
    const hasMatchingId = injectedIds.some(id => response.includes(id));
    if (hasMatchingId && hasUsageMarker) return true;
  }

  if (injectedSummaries.length > 0) {
    const hasMatchingSummary = injectedSummaries.some(
      s => s.length >= 10 && response.includes(s)
    );
    if (hasMatchingSummary) return true;
  }

  return false;
}
