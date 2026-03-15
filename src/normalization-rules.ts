import type { AtomicMemoryUnitType } from "./atomic-memory.js";
import type { NormalizationCandidate, NormalizedMemoryDraft } from "./normalization-types.js";
import type { MemoryEntry } from "./store.js";

const RUNTIME_CHATTER_PATTERNS = [
  /^\[\[reply_to_current\]\]/i,
  /\bheartbeat\b/i,
  /\bpoll(?:ing)?\b/i,
  /\bstatus\b/i,
  /\bchecking\b/i,
  /\bfound key information\b/i,
  /找到关键信息了/,
  /我去看一下/,
  /我先看一下/,
  /我先按/,
  /我重点看/,
  /等它跑完/,
  /我继续帮你验/,
  /我继续帮你看/,
  /任务本身有没有/,
  /看它有没有/,
  /再决定要不要/,
  /\bdo you want me to\b/i,
  /要不要我/,
  /\bi can (?:continue|fix|handle)\b/i,
] as const;

const KEEP_RUNTIME_INCIDENT_PATTERNS = [
  /\bstall\b/i,
  /\btimeout\b/i,
  /\bfailed\b/i,
  /\berror\b/i,
  /\brestart\b/i,
  /\bgetupdates\b/i,
  /\bHTTP\s*[45]\d{2}\b/i,
  /\ballowlist miss\b/i,
  /\btoken pool is empty\b/i,
] as const;

const TECHNICAL_MARKERS = [
  /\b[A-Z_]{3,}\b/,
  /\b\d{3,5}\b/,
  /[A-Za-z0-9_.-]+\.(?:json|jsonl|md|ts|js|py|plist)\b/,
  /(?:\/|~\/)[^\s]+/,
  /\b(?:error|timeout|gateway|proxy|session|telegram|embedding|rerank|allowlist|lock|threadbindings|captureassistant|rerankprovider|baseurl)\b/i,
] as const;

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function stripMetadataHeaders(text: string): string {
  return text.replace(/^(Conversation info|Sender) \(untrusted metadata\):[\s\S]*?\n\s*\n/gim, "").trim();
}

function stripMarkdownNoise(text: string): string {
  return text
    .replace(/^[-*]\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/`{1,3}/g, "");
}

function stripAckPreamble(text: string): string {
  return text
    .replace(/^(好的[，, ]*|明白了?[，, ]*|收到[，, ]*|我明白了?[，, ]*|我知道了?[，, ]*|好[的吧]?[，, ]*)/i, "")
    .replace(/^(okay[,. ]*|ok[,. ]*|understood[,. ]*|got it[,. ]*)/i, "")
    .trim();
}

function removeTrailingPrompt(text: string): string {
  return text
    .replace(/(。|！|!|\.)?\s*(要不要我现在[\s\S]*)$/u, "")
    .replace(/(。|！|!|\.)?\s*(do you want me to[\s\S]*)$/iu, "")
    .trim();
}

export function cleanupCandidateText(text: string): string {
  return collapseWhitespace(removeTrailingPrompt(stripAckPreamble(stripMarkdownNoise(stripMetadataHeaders(text)))));
}

export function isRuntimeChatter(text: string): boolean {
  const cleaned = cleanupCandidateText(text);
  if (KEEP_RUNTIME_INCIDENT_PATTERNS.some((pattern) => pattern.test(cleaned))) {
    return false;
  }
  return cleaned.length < 12 || RUNTIME_CHATTER_PATTERNS.some((pattern) => pattern.test(cleaned));
}

export function detectNormalizationKind(candidate: NormalizationCandidate): "technical" | "decision" | "preference" | "generic" {
  if (candidate.category === "decision") return "decision";
  if (candidate.category === "preference") return "preference";
  if (TECHNICAL_MARKERS.some((pattern) => pattern.test(candidate.text))) return "technical";
  return "generic";
}

function detectKindFromText(text: string, fallback: "technical" | "decision" | "preference" | "generic" = "generic") {
  const lower = cleanupCandidateText(text).toLowerCase();
  if (/(?:偏好|喜欢|喜歡|希望|prefer|preference)/i.test(lower)) return "preference";
  if (/(?:决定|決定|原则|原則|规则|規則|decision|rule|principle)/i.test(lower)) return "decision";
  if (TECHNICAL_MARKERS.some((pattern) => pattern.test(lower))) return "technical";
  return fallback;
}

function inferRuleCategory(candidate: NormalizationCandidate): MemoryEntry["category"] {
  const kind = detectNormalizationKind(candidate);
  if (kind === "technical") return "fact";
  return candidate.category;
}

function inferRuleUnitType(candidate: NormalizationCandidate): AtomicMemoryUnitType {
  const kind = detectNormalizationKind(candidate);
  if (kind === "technical") return candidate.unitType === "lesson" ? "lesson" : "fact";
  return candidate.unitType;
}

export function deriveTagsFromText(text: string, candidate?: Pick<NormalizationCandidate, "category" | "unitType">): string[] | undefined {
  const tags = new Set<string>();
  const cleaned = cleanupCandidateText(text);

  const pathMatches = cleaned.match(/[A-Za-z0-9_.-]+\.(?:json|jsonl|md|ts|js|py|plist)\b/g) || [];
  for (const match of pathMatches.slice(0, 3)) tags.add(match.toLowerCase());

  const errorMatches = cleaned.match(/\b(?:EISDIR|HTTP 4\d{2}|HTTP 5\d{2}|RPM 1002|allowlist miss|threadBindings|runtime\.modelAuth|captureAssistant|rerankProvider|baseURL)\b/gi) || [];
  for (const match of errorMatches.slice(0, 4)) tags.add(match);

  const keywords = [
    "telegram", "proxy", "gateway", "session", "embedding", "rerank", "openclaw", "codex", "lossless-claw", "tushare",
    "metadata", "principle", "allowlist", "security", "execution", "configuration", "websocket", "path"
  ];
  for (const keyword of keywords) {
    if (cleaned.toLowerCase().includes(keyword.toLowerCase())) tags.add(keyword);
  }

  if (/acpx-with-proxy/i.test(cleaned)) tags.add("acpx-with-proxy");
  if (/\b7897\b/.test(cleaned)) tags.add("7897");
  if (/tools\.exec\.security/i.test(cleaned)) tags.add("tools.exec.security");
  if (/allowlist miss/i.test(cleaned)) tags.add("allowlist miss");
  if (/practice|实践优先|原则/i.test(cleaned)) tags.add("principle");
  if (/metadata/i.test(cleaned)) tags.add("metadata");
  if (/原子记忆|atomic memory/i.test(cleaned)) tags.add("atomic memory");
  if (/node bin/i.test(cleaned)) tags.add("node bin");
  if (/skill eligibility/i.test(cleaned)) tags.add("skill eligibility");
  if (/polling stall|getupdates/i.test(cleaned)) tags.add("polling");

  if (candidate?.category === "decision") tags.add("decision");
  if (candidate?.unitType === "lesson") tags.add("lesson");

  return tags.size > 0 ? Array.from(tags).slice(0, 8) : undefined;
}

function deriveTags(candidate: NormalizationCandidate): string[] | undefined {
  return deriveTagsFromText(candidate.text, candidate);
}

export function inferTaxonomyFromText(
  text: string,
  candidate: Pick<NormalizationCandidate, "category" | "unitType" | "sourceKind">,
): { category: MemoryEntry["category"]; unitType: AtomicMemoryUnitType } {
  const cleaned = cleanupCandidateText(text);
  const kind = detectKindFromText(cleaned, detectNormalizationKind(candidate as NormalizationCandidate));

  if (kind === "preference") {
    return { category: "preference", unitType: "preference" };
  }

  if (kind === "decision") {
    return { category: "decision", unitType: "decision" };
  }

  if (kind === "technical") {
    const lessonish = /(pitfall|教训|lesson|避免|不要|别|別|prevention|fix|原因是|root cause|根因)/i.test(cleaned);
    return {
      category: "fact",
      unitType: lessonish ? "lesson" : "fact",
    };
  }

  if (/(entity|联系人|联系方式|联系人|called|叫我)/i.test(cleaned)) {
    return { category: "entity", unitType: "entity" };
  }

  return {
    category: candidate.category,
    unitType: candidate.unitType,
  };
}

function buildCanonicalText(candidate: NormalizationCandidate): string {
  const cleaned = cleanupCandidateText(candidate.text);
  const kind = detectNormalizationKind(candidate);

  switch (kind) {
    case "technical":
      return cleaned.startsWith("Pitfall(") || cleaned.startsWith("Fact(") || cleaned.startsWith("Constraint(")
        ? cleaned
        : `Technical memory: ${cleaned}`;
    case "decision":
      return cleaned.startsWith("Decision(") || cleaned.startsWith("Rule(") || cleaned.startsWith("Principle(")
        ? cleaned
        : `Decision: ${cleaned}`;
    case "preference":
      return cleaned.startsWith("Preference(") ? cleaned : `Preference: ${cleaned}`;
    default:
      return cleaned;
  }
}

export function buildRuleDrafts(
  candidate: NormalizationCandidate,
  options: { confidence?: number; sourceRef?: string } = {},
): NormalizedMemoryDraft[] {
  const canonicalText = buildCanonicalText(candidate);
  if (!canonicalText) return [];

  return [{
    canonicalText,
    category: inferRuleCategory(candidate),
    atomic: {
      unitType: inferRuleUnitType(candidate),
      sourceKind: candidate.sourceKind,
      confidence: typeof options.confidence === "number" ? options.confidence : 0.7,
      ...(options.sourceRef ? { sourceRef: options.sourceRef } : {}),
      ...(deriveTags(candidate) ? { tags: deriveTags(candidate) } : {}),
    },
    normalizationMode: "rules",
    reason: detectNormalizationKind(candidate),
    sourceText: candidate.text,
  }];
}

export function buildRawFallbackDraft(
  candidate: NormalizationCandidate,
  options: { confidence?: number; sourceRef?: string } = {},
): NormalizedMemoryDraft[] {
  const cleaned = cleanupCandidateText(candidate.text) || collapseWhitespace(candidate.text);
  if (!cleaned) return [];

  return [{
    canonicalText: cleaned,
    category: candidate.category,
    atomic: {
      unitType: candidate.unitType,
      sourceKind: candidate.sourceKind,
      confidence: typeof options.confidence === "number" ? options.confidence : 0.55,
      ...(options.sourceRef ? { sourceRef: options.sourceRef } : {}),
      ...(deriveTags(candidate) ? { tags: deriveTags(candidate) } : {}),
    },
    normalizationMode: "raw_fallback",
    reason: "fallback_raw",
    sourceText: candidate.text,
  }];
}
