import { join } from "node:path";
import type { LlmClient } from "./llm-client.js";
import type { CandidateMemory, MemoryCategory } from "./memory-categories.js";
import type { MemorySearchResult, MemoryStore } from "./store.js";
import { parseSmartMetadata } from "./smart-metadata.js";

export interface AdmissionWeights {
  utility: number;
  confidence: number;
  novelty: number;
  recency: number;
  typePrior: number;
}

export interface AdmissionTypePriors {
  profile: number;
  preferences: number;
  entities: number;
  events: number;
  cases: number;
  patterns: number;
}

export interface AdmissionRecencyConfig {
  halfLifeDays: number;
}

export type AdmissionControlPreset =
  | "balanced"
  | "conservative"
  | "high-recall";

export interface AdmissionControlConfig {
  preset: AdmissionControlPreset;
  enabled: boolean;
  utilityMode: "standalone" | "off";
  weights: AdmissionWeights;
  rejectThreshold: number;
  admitThreshold: number;
  noveltyCandidatePoolSize: number;
  recency: AdmissionRecencyConfig;
  typePriors: AdmissionTypePriors;
  auditMetadata: boolean;
  persistRejectedAudits: boolean;
  rejectedAuditFilePath?: string;
}

export interface AdmissionFeatureScores {
  utility: number;
  confidence: number;
  novelty: number;
  recency: number;
  typePrior: number;
}

export interface AdmissionAuditRecord {
  version: "amac-v1";
  decision: "reject" | "pass_to_dedup";
  hint?: "add" | "update_or_merge";
  score: number;
  reason: string;
  utility_reason?: string;
  thresholds: {
    reject: number;
    admit: number;
  };
  weights: AdmissionWeights;
  feature_scores: AdmissionFeatureScores;
  matched_existing_memory_ids: string[];
  compared_existing_memory_ids: string[];
  max_similarity: number;
  evaluated_at: number;
}

export interface AdmissionEvaluation {
  decision: "reject" | "pass_to_dedup";
  hint?: "add" | "update_or_merge";
  audit: AdmissionAuditRecord;
}

export interface AdmissionRejectionAuditEntry {
  version: "amac-v1";
  rejected_at: number;
  session_key: string;
  target_scope: string;
  scope_filter: string[];
  candidate: CandidateMemory;
  audit: AdmissionAuditRecord & { decision: "reject" };
  conversation_excerpt: string;
}

export interface ConfidenceSupportBreakdown {
  score: number;
  bestSupport: number;
  coverage: number;
  unsupportedRatio: number;
}

export interface NoveltyBreakdown {
  score: number;
  maxSimilarity: number;
  matchedIds: string[];
  comparedIds: string[];
}

const DEFAULT_WEIGHTS: AdmissionWeights = {
  utility: 0.1,
  confidence: 0.1,
  novelty: 0.1,
  recency: 0.1,
  typePrior: 0.6,
};

const DEFAULT_TYPE_PRIORS: AdmissionTypePriors = {
  profile: 0.95,
  preferences: 0.9,
  entities: 0.75,
  events: 0.45,
  cases: 0.8,
  patterns: 0.85,
};

function cloneAdmissionControlConfig(config: AdmissionControlConfig): AdmissionControlConfig {
  return {
    ...config,
    recency: { ...config.recency },
    weights: { ...config.weights },
    typePriors: { ...config.typePriors },
  };
}

export const ADMISSION_CONTROL_PRESETS: Record<AdmissionControlPreset, AdmissionControlConfig> = {
  balanced: {
    preset: "balanced",
    enabled: false,
    utilityMode: "standalone",
    weights: DEFAULT_WEIGHTS,
    rejectThreshold: 0.45,
    admitThreshold: 0.6,
    noveltyCandidatePoolSize: 8,
    recency: {
      halfLifeDays: 14,
    },
    typePriors: DEFAULT_TYPE_PRIORS,
    auditMetadata: true,
    persistRejectedAudits: true,
    rejectedAuditFilePath: undefined,
  },
  conservative: {
    preset: "conservative",
    enabled: false,
    utilityMode: "standalone",
    weights: {
      utility: 0.16,
      confidence: 0.16,
      novelty: 0.18,
      recency: 0.08,
      typePrior: 0.42,
    },
    rejectThreshold: 0.52,
    admitThreshold: 0.68,
    noveltyCandidatePoolSize: 10,
    recency: {
      halfLifeDays: 10,
    },
    typePriors: {
      profile: 0.98,
      preferences: 0.94,
      entities: 0.78,
      events: 0.28,
      cases: 0.78,
      patterns: 0.8,
    },
    auditMetadata: true,
    persistRejectedAudits: true,
    rejectedAuditFilePath: undefined,
  },
  "high-recall": {
    preset: "high-recall",
    enabled: false,
    utilityMode: "standalone",
    weights: {
      utility: 0.08,
      confidence: 0.1,
      novelty: 0.08,
      recency: 0.14,
      typePrior: 0.6,
    },
    rejectThreshold: 0.34,
    admitThreshold: 0.52,
    noveltyCandidatePoolSize: 6,
    recency: {
      halfLifeDays: 21,
    },
    typePriors: {
      profile: 0.96,
      preferences: 0.92,
      entities: 0.8,
      events: 0.58,
      cases: 0.84,
      patterns: 0.88,
    },
    auditMetadata: true,
    persistRejectedAudits: true,
    rejectedAuditFilePath: undefined,
  },
};

export const DEFAULT_ADMISSION_CONTROL_CONFIG =
  ADMISSION_CONTROL_PRESETS.balanced;

function parseAdmissionControlPreset(raw: unknown): AdmissionControlPreset {
  switch (raw) {
    case "conservative":
    case "high-recall":
    case "balanced":
      return raw;
    default:
      return "balanced";
  }
}

function clamp01(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

function clampPositiveInt(value: unknown, fallback: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(1, Math.floor(n)));
}

function normalizeWeights(raw: unknown, defaults: AdmissionWeights): AdmissionWeights {
  if (!raw || typeof raw !== "object") {
    return { ...defaults };
  }

  const obj = raw as Record<string, unknown>;
  const candidate: AdmissionWeights = {
    utility: clamp01(obj.utility, defaults.utility),
    confidence: clamp01(obj.confidence, defaults.confidence),
    novelty: clamp01(obj.novelty, defaults.novelty),
    recency: clamp01(obj.recency, defaults.recency),
    typePrior: clamp01(obj.typePrior, defaults.typePrior),
  };

  const total =
    candidate.utility +
    candidate.confidence +
    candidate.novelty +
    candidate.recency +
    candidate.typePrior;

  if (total <= 0) {
    return { ...defaults };
  }

  return {
    utility: candidate.utility / total,
    confidence: candidate.confidence / total,
    novelty: candidate.novelty / total,
    recency: candidate.recency / total,
    typePrior: candidate.typePrior / total,
  };
}

function normalizeTypePriors(raw: unknown, defaults: AdmissionTypePriors): AdmissionTypePriors {
  if (!raw || typeof raw !== "object") {
    return { ...defaults };
  }

  const obj = raw as Record<string, unknown>;
  return {
    profile: clamp01(obj.profile, defaults.profile),
    preferences: clamp01(obj.preferences, defaults.preferences),
    entities: clamp01(obj.entities, defaults.entities),
    events: clamp01(obj.events, defaults.events),
    cases: clamp01(obj.cases, defaults.cases),
    patterns: clamp01(obj.patterns, defaults.patterns),
  };
}

export function normalizeAdmissionControlConfig(raw: unknown): AdmissionControlConfig {
  if (!raw || typeof raw !== "object") {
    return cloneAdmissionControlConfig(DEFAULT_ADMISSION_CONTROL_CONFIG);
  }

  const obj = raw as Record<string, unknown>;
  const preset = parseAdmissionControlPreset(obj.preset);
  const base = cloneAdmissionControlConfig(ADMISSION_CONTROL_PRESETS[preset]);
  const rejectThreshold = clamp01(obj.rejectThreshold, base.rejectThreshold);
  const admitThreshold = clamp01(obj.admitThreshold, base.admitThreshold);
  const normalizedAdmit = Math.max(admitThreshold, rejectThreshold);
  const recencyRaw =
    typeof obj.recency === "object" && obj.recency !== null
      ? (obj.recency as Record<string, unknown>)
      : {};

  return {
    preset,
    enabled: obj.enabled === true,
    utilityMode:
      obj.utilityMode === "off"
        ? "off"
        : obj.utilityMode === "standalone"
          ? "standalone"
          : base.utilityMode,
    weights: normalizeWeights(obj.weights, base.weights),
    rejectThreshold,
    admitThreshold: normalizedAdmit,
    noveltyCandidatePoolSize: clampPositiveInt(
      obj.noveltyCandidatePoolSize,
      base.noveltyCandidatePoolSize,
      20,
    ),
    recency: {
      halfLifeDays: clampPositiveInt(
        recencyRaw.halfLifeDays,
        base.recency.halfLifeDays,
        365,
      ),
    },
    typePriors: normalizeTypePriors(obj.typePriors, base.typePriors),
    auditMetadata:
      typeof obj.auditMetadata === "boolean"
        ? obj.auditMetadata
        : base.auditMetadata,
    persistRejectedAudits:
      typeof obj.persistRejectedAudits === "boolean"
        ? obj.persistRejectedAudits
        : base.persistRejectedAudits,
    rejectedAuditFilePath:
      typeof obj.rejectedAuditFilePath === "string" &&
      obj.rejectedAuditFilePath.trim().length > 0
        ? obj.rejectedAuditFilePath.trim()
        : undefined,
  };
}

export function resolveRejectedAuditFilePath(
  dbPath: string,
  config?: Pick<AdmissionControlConfig, "rejectedAuditFilePath"> | null,
): string {
  const explicitPath = config?.rejectedAuditFilePath;
  if (typeof explicitPath === "string" && explicitPath.trim().length > 0) {
    return explicitPath.trim();
  }
  return join(dbPath, "..", "admission-audit", "rejections.jsonl");
}

function isHanChar(char: string): boolean {
  return /\p{Script=Han}/u.test(char);
}

function isWordChar(char: string): boolean {
  return /[\p{Letter}\p{Number}]/u.test(char);
}

function tokenizeText(value: string): string[] {
  const normalized = value.toLowerCase().trim();
  const tokens: string[] = [];
  let current = "";

  for (const char of normalized) {
    if (isHanChar(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      tokens.push(char);
      continue;
    }

    if (isWordChar(char)) {
      current += char;
      continue;
    }

    if (current) {
      tokens.push(current);
      current = "";
    }
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function lcsLength(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const dp = Array.from({ length: left.length + 1 }, () =>
    Array<number>(right.length + 1).fill(0),
  );

  for (let i = 1; i <= left.length; i++) {
    for (let j = 1; j <= right.length; j++) {
      if (left[i - 1] === right[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  return dp[left.length][right.length];
}

function rougeLikeF1(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const lcs = lcsLength(left, right);
  if (lcs === 0) return 0;
  const precision = lcs / left.length;
  const recall = lcs / right.length;
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

function splitSupportSpans(conversationText: string): string[] {
  const spans = new Set<string>();
  for (const line of conversationText.split(/\n+/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    spans.add(trimmed);
    for (const sentence of trimmed.split(/[。！？!?]+/)) {
      const candidate = sentence.trim();
      if (candidate.length >= 4) {
        spans.add(candidate);
      }
    }
  }
  return Array.from(spans);
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length === 0 || right.length === 0) {
    return 0;
  }

  const size = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let i = 0; i < size; i++) {
    const l = Number(left[i]) || 0;
    const r = Number(right[i]) || 0;
    dot += l * r;
    leftNorm += l * l;
    rightNorm += r * r;
  }

  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function buildUtilityPrompt(candidate: CandidateMemory, conversationText: string): string {
  const excerpt =
    conversationText.length > 3000
      ? conversationText.slice(-3000)
      : conversationText;

  return `Evaluate whether this candidate memory is worth keeping for future cross-session interactions.

Conversation excerpt:
${excerpt}

Candidate memory:
- Category: ${candidate.category}
- Abstract: ${candidate.abstract}
- Overview: ${candidate.overview}
- Content: ${candidate.content}

Score future usefulness on a 0.0-1.0 scale.

Use higher scores for durable preferences, profile facts, reusable procedures, and long-lived project/entity state.
Use lower scores for one-off chatter, low-signal situational remarks, thin restatements, and low-value transient details.

Return JSON only:
{
  "utility": 0.0,
  "reason": "short explanation"
}`;
}

function buildReason(details: {
  decision: "reject" | "pass_to_dedup";
  hint?: "add" | "update_or_merge";
  score: number;
  rejectThreshold: number;
  maxSimilarity: number;
  utilityReason?: string;
}): string {
  const scoreText = details.score.toFixed(3);
  const similarityText = details.maxSimilarity.toFixed(3);
  const utilityText = details.utilityReason ? ` Utility: ${details.utilityReason}` : "";
  if (details.decision === "reject") {
    return `Admission rejected (${scoreText} < ${details.rejectThreshold.toFixed(3)}). maxSimilarity=${similarityText}.${utilityText}`.trim();
  }
  const hintText = details.hint ? ` hint=${details.hint};` : "";
  return `Admission passed (${scoreText});${hintText} maxSimilarity=${similarityText}.${utilityText}`.trim();
}

export function scoreTypePrior(
  category: MemoryCategory,
  typePriors: AdmissionTypePriors,
): number {
  return clamp01(typePriors[category], DEFAULT_TYPE_PRIORS[category]);
}

export function scoreConfidenceSupport(
  candidate: CandidateMemory,
  conversationText: string,
): ConfidenceSupportBreakdown {
  const candidateText = `${candidate.abstract}\n${candidate.content}`.trim();
  const candidateTokens = tokenizeText(candidateText);
  if (candidateTokens.length === 0) {
    return { score: 0, bestSupport: 0, coverage: 0, unsupportedRatio: 1 };
  }

  const spans = splitSupportSpans(conversationText);
  const conversationTokens = new Set(tokenizeText(conversationText));
  let bestSupport = 0;

  for (const span of spans) {
    const spanTokens = tokenizeText(span);
    bestSupport = Math.max(bestSupport, rougeLikeF1(candidateTokens, spanTokens));
  }

  const uniqueCandidateTokens = Array.from(new Set(candidateTokens));
  const supportedTokenCount = uniqueCandidateTokens.filter((token) => conversationTokens.has(token)).length;
  const coverage = uniqueCandidateTokens.length > 0 ? supportedTokenCount / uniqueCandidateTokens.length : 0;
  const unsupportedRatio = uniqueCandidateTokens.length > 0 ? 1 - coverage : 1;
  const score = clamp01((bestSupport * 0.7) + (coverage * 0.3) - (unsupportedRatio * 0.25), 0);

  return { score, bestSupport, coverage, unsupportedRatio };
}

export function scoreNoveltyFromMatches(
  candidateVector: number[],
  matches: MemorySearchResult[],
): NoveltyBreakdown {
  if (!Array.isArray(candidateVector) || candidateVector.length === 0 || matches.length === 0) {
    return { score: 1, maxSimilarity: 0, matchedIds: [], comparedIds: [] };
  }

  let maxSimilarity = 0;
  const comparedIds: string[] = [];
  const matchedIds: string[] = [];

  for (const match of matches) {
    comparedIds.push(match.entry.id);
    const similarity = Math.max(0, cosineSimilarity(candidateVector, match.entry.vector));
    if (similarity > maxSimilarity) {
      maxSimilarity = similarity;
    }
    if (similarity >= 0.55) {
      matchedIds.push(match.entry.id);
    }
  }

  return {
    score: clamp01(1 - maxSimilarity, 1),
    maxSimilarity,
    matchedIds,
    comparedIds,
  };
}

export function scoreRecencyGap(
  now: number,
  matches: MemorySearchResult[],
  halfLifeDays: number,
): number {
  if (matches.length === 0 || halfLifeDays <= 0) {
    return 1;
  }

  const latestTimestamp = Math.max(
    ...matches.map((match) => (Number.isFinite(match.entry.timestamp) ? match.entry.timestamp : 0)),
  );
  if (!Number.isFinite(latestTimestamp) || latestTimestamp <= 0) {
    return 1;
  }

  const gapMs = Math.max(0, now - latestTimestamp);
  const gapDays = gapMs / 86_400_000;
  if (gapDays === 0) {
    return 0;
  }

  const lambda = Math.LN2 / halfLifeDays;
  return clamp01(1 - Math.exp(-lambda * gapDays), 1);
}

async function scoreUtility(
  llm: LlmClient,
  mode: AdmissionControlConfig["utilityMode"],
  candidate: CandidateMemory,
  conversationText: string,
): Promise<{ score: number; reason?: string }> {
  if (mode === "off") {
    return { score: 0.5, reason: "Utility scoring disabled" };
  }

  let response: { utility?: number; reason?: string } | null = null;
  try {
    response = await llm.completeJson<{ utility?: number; reason?: string }>(
      buildUtilityPrompt(candidate, conversationText),
      "admission-utility",
    );
  } catch {
    return { score: 0.5, reason: "Utility scoring failed" };
  }

  if (!response) {
    return { score: 0.5, reason: "Utility scoring unavailable" };
  }

  return {
    score: clamp01(response.utility, 0.5),
    reason: typeof response.reason === "string" ? response.reason.trim() : undefined,
  };
}

export class AdmissionController {
  constructor(
    private readonly store: MemoryStore,
    private readonly llm: LlmClient,
    private readonly config: AdmissionControlConfig,
    private readonly debugLog: (msg: string) => void = () => {},
  ) {}

  private async loadRelevantMatches(
    candidate: CandidateMemory,
    candidateVector: number[],
    scopeFilter: string[],
  ): Promise<MemorySearchResult[]> {
    if (!Array.isArray(candidateVector) || candidateVector.length === 0) {
      return [];
    }

    const rawMatches = await this.store.vectorSearch(
      candidateVector,
      this.config.noveltyCandidatePoolSize,
      0,
      scopeFilter,
    );

    if (rawMatches.length === 0) {
      return [];
    }

    const sameCategoryMatches = rawMatches.filter((match) => {
      const metadata = parseSmartMetadata(match.entry.metadata, match.entry);
      return metadata.memory_category === candidate.category;
    });

    return sameCategoryMatches.length > 0 ? sameCategoryMatches : rawMatches;
  }

  async evaluate(params: {
    candidate: CandidateMemory;
    candidateVector: number[];
    conversationText: string;
    scopeFilter: string[];
    now?: number;
  }): Promise<AdmissionEvaluation> {
    const now = params.now ?? Date.now();
    const relevantMatches = await this.loadRelevantMatches(
      params.candidate,
      params.candidateVector,
      params.scopeFilter,
    );

    const utility = await scoreUtility(
      this.llm,
      this.config.utilityMode,
      params.candidate,
      params.conversationText,
    );
    const confidence = scoreConfidenceSupport(params.candidate, params.conversationText);
    const novelty = scoreNoveltyFromMatches(params.candidateVector, relevantMatches);
    const recency = scoreRecencyGap(now, relevantMatches, this.config.recency.halfLifeDays);
    const typePrior = scoreTypePrior(params.candidate.category, this.config.typePriors);

    const featureScores: AdmissionFeatureScores = {
      utility: utility.score,
      confidence: confidence.score,
      novelty: novelty.score,
      recency,
      typePrior,
    };

    const score =
      (featureScores.utility * this.config.weights.utility) +
      (featureScores.confidence * this.config.weights.confidence) +
      (featureScores.novelty * this.config.weights.novelty) +
      (featureScores.recency * this.config.weights.recency) +
      (featureScores.typePrior * this.config.weights.typePrior);

    const decision = score < this.config.rejectThreshold ? "reject" : "pass_to_dedup";
    const hint =
      decision === "reject"
        ? undefined
        : score >= this.config.admitThreshold && novelty.maxSimilarity < 0.55
          ? "add"
          : "update_or_merge";

    const reason = buildReason({
      decision,
      hint,
      score,
      rejectThreshold: this.config.rejectThreshold,
      maxSimilarity: novelty.maxSimilarity,
      utilityReason: utility.reason,
    });

    const audit: AdmissionAuditRecord = {
      version: "amac-v1",
      decision,
      hint,
      score,
      reason,
      utility_reason: utility.reason,
      thresholds: {
        reject: this.config.rejectThreshold,
        admit: this.config.admitThreshold,
      },
      weights: this.config.weights,
      feature_scores: featureScores,
      matched_existing_memory_ids: novelty.matchedIds,
      compared_existing_memory_ids: novelty.comparedIds,
      max_similarity: novelty.maxSimilarity,
      evaluated_at: now,
    };

    this.debugLog(
      `memory-lancedb-pro: admission-control: decision=${audit.decision} hint=${audit.hint ?? "n/a"} score=${audit.score.toFixed(3)} candidate=${JSON.stringify(params.candidate.abstract.slice(0, 80))}`,
    );

    return { decision, hint, audit };
  }
}
