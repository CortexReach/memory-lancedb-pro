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

// ============================================================
// Phase 2 Feedback Signal — isRecallUsed（v9 spec）
// ============================================================

/**
 * 判斷回應（response）是否使用了召回的記憶內容（recall）。
 * 用於 Phase 2 Feedback Signal，記錄記憶是否在回應中被引用。
 *
 * v9 設計規格：
 * - 短文本（recall.length ≤ 90）：全段作為 snippet 比對
 * - 長文本（recall.length > 90）：取 slice(20, 70) 避開前綴
 * - snippet.length < 5 → 回傳 false（snippet 太短無意義）
 * - 回應長度必須 > 24 字（response.length > 24）
 *
 * @param recall - 召回的記憶文本（來自 memory/lancedb）
 * @param response - 使用者的回應文本
 * @returns true 表示回應使用了記憶內容，否則 false
 */
export function isRecallUsed(recall: string, response: string): boolean {
  // 參數驗證：recall 和 response 都必須是有效非空字串
  if (!recall || typeof recall !== "string") return false;
  if (!response || typeof response !== "string") return false;

  const text = recall.trim();

  // 第一關：recall 長度不足
  if (text.length < 5) return false;

  // 決定 snippet 取法（v9 threshold = 90）
  // - recall.length ≤ 90 → 全段作為 snippet
  // - recall.length > 90 → 取 slice(20, 70) 避開前綴
  const snippet = text.length > 90
    ? text.slice(20, 70)
    : text;

  // 第二關：snippet 長度不足 5 → false
  if (snippet.length < 5) return false;

  // 第三關：回應長度必須 > 24
  if (response.length <= 24) return false;

  // 第四關：snippet 全是空白或純標點（無實際內容）
  if (/^[\s\p{P}]+$/u.test(snippet)) return false;

  // 正式比對：大寫不敏感（case-insensitive includes）
  return response.toLowerCase().includes(snippet.toLowerCase());
}

/**
 * 從對話歷史中找出第一個 timestamp > afterTimestamp 的 user 訊息內容。
 * 用於 Phase 2 Feedback Signal，從對話歷史抓取 user 回應，判斷 recall 是否被確認使用。
 *
 * @param messages - 對話訊息陣列，每個訊息包含 role、content、timestamp
 * @param afterTimestamp - 時間戳門檻（只找 > 此值的訊息）
 * @returns 第一個符合條件的 user 訊息 content，若無則回傳 null
 */
export function extractUserResponseAfter(
  messages: Array<{ role: string; content: string; timestamp?: number }>,
  afterTimestamp: number,
): string | null {
  if (!Array.isArray(messages) || messages.length === 0) {
    return null;
  }
  const userMsg = messages.find(
    (m) => m.role === "user" && (m.timestamp ?? 0) > afterTimestamp,
  );
  return userMsg?.content ?? null;
}
