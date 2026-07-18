import { join } from "node:path";
import { ADMISSION_JUDGE_IDENTITY, CATEGORY_TAXONOMY, SCORE_TIER_RUBRIC } from "./prompt-blocks.js";
import { formatCandidateBlock, jsonShape } from "./prompt-blocks.js";
import { parseSmartMetadata } from "./smart-metadata.js";
const DEFAULT_WEIGHTS = {
    utility: 0.1,
    confidence: 0.1,
    novelty: 0.1,
    recency: 0.1,
    typePrior: 0.6,
};
const DEFAULT_TYPE_PRIORS = {
    profile: 0.95,
    preferences: 0.9,
    entities: 0.75,
    events: 0.45,
    cases: 0.8,
    patterns: 0.85,
};
function cloneAdmissionControlConfig(config) {
    return {
        ...config,
        recency: { ...config.recency },
        weights: { ...config.weights },
        typePriors: { ...config.typePriors },
    };
}
export const ADMISSION_CONTROL_PRESETS = {
    balanced: {
        preset: "balanced",
        enabled: false,
        utilityMode: "standalone",
        modelAffinity: "global",
        weights: DEFAULT_WEIGHTS,
        rejectThreshold: 0.45,
        admitThreshold: 0.6,
        utilityVetoThreshold: 0.25,
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
        modelAffinity: "global",
        weights: {
            utility: 0.16,
            confidence: 0.16,
            novelty: 0.18,
            recency: 0.08,
            typePrior: 0.42,
        },
        rejectThreshold: 0.52,
        admitThreshold: 0.68,
        utilityVetoThreshold: 0.25,
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
        modelAffinity: "global",
        weights: {
            utility: 0.08,
            confidence: 0.1,
            novelty: 0.08,
            recency: 0.14,
            typePrior: 0.6,
        },
        rejectThreshold: 0.34,
        admitThreshold: 0.52,
        utilityVetoThreshold: 0.25,
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
export const DEFAULT_ADMISSION_CONTROL_CONFIG = ADMISSION_CONTROL_PRESETS.balanced;
function parseAdmissionControlPreset(raw) {
    switch (raw) {
        case "conservative":
        case "high-recall":
        case "balanced":
            return raw;
        default:
            return "balanced";
    }
}
function clamp01(value, fallback) {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n))
        return fallback;
    return Math.min(1, Math.max(0, n));
}
function clampPositiveInt(value, fallback, max) {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n) || n <= 0)
        return fallback;
    return Math.min(max, Math.max(1, Math.floor(n)));
}
function normalizeWeights(raw, defaults) {
    if (!raw || typeof raw !== "object") {
        return { ...defaults };
    }
    const obj = raw;
    const candidate = {
        utility: clamp01(obj.utility, defaults.utility),
        confidence: clamp01(obj.confidence, defaults.confidence),
        novelty: clamp01(obj.novelty, defaults.novelty),
        recency: clamp01(obj.recency, defaults.recency),
        typePrior: clamp01(obj.typePrior, defaults.typePrior),
    };
    const total = candidate.utility +
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
function normalizeTypePriors(raw, defaults) {
    if (!raw || typeof raw !== "object") {
        return { ...defaults };
    }
    const obj = raw;
    return {
        profile: clamp01(obj.profile, defaults.profile),
        preferences: clamp01(obj.preferences, defaults.preferences),
        entities: clamp01(obj.entities, defaults.entities),
        events: clamp01(obj.events, defaults.events),
        cases: clamp01(obj.cases, defaults.cases),
        patterns: clamp01(obj.patterns, defaults.patterns),
    };
}
export function normalizeAdmissionControlConfig(raw) {
    if (!raw || typeof raw !== "object") {
        return cloneAdmissionControlConfig(DEFAULT_ADMISSION_CONTROL_CONFIG);
    }
    const obj = raw;
    const preset = parseAdmissionControlPreset(obj.preset);
    const base = cloneAdmissionControlConfig(ADMISSION_CONTROL_PRESETS[preset]);
    const rejectThreshold = clamp01(obj.rejectThreshold, base.rejectThreshold);
    const admitThreshold = clamp01(obj.admitThreshold, base.admitThreshold);
    const normalizedAdmit = Math.max(admitThreshold, rejectThreshold);
    const utilityVetoThreshold = clamp01(obj.utilityVetoThreshold, base.utilityVetoThreshold);
    const recencyRaw = typeof obj.recency === "object" && obj.recency !== null
        ? obj.recency
        : {};
    return {
        preset,
        enabled: obj.enabled === true,
        utilityMode: obj.utilityMode === "off"
            ? "off"
            : obj.utilityMode === "standalone"
                ? "standalone"
                : obj.utilityMode === "batch"
                    ? "batch"
                    : base.utilityMode,
        weights: normalizeWeights(obj.weights, base.weights),
        rejectThreshold,
        admitThreshold: normalizedAdmit,
        utilityVetoThreshold,
        noveltyCandidatePoolSize: clampPositiveInt(obj.noveltyCandidatePoolSize, base.noveltyCandidatePoolSize, 20),
        recency: {
            halfLifeDays: clampPositiveInt(recencyRaw.halfLifeDays, base.recency.halfLifeDays, 365),
        },
        typePriors: normalizeTypePriors(obj.typePriors, base.typePriors),
        auditMetadata: typeof obj.auditMetadata === "boolean"
            ? obj.auditMetadata
            : base.auditMetadata,
        persistRejectedAudits: typeof obj.persistRejectedAudits === "boolean"
            ? obj.persistRejectedAudits
            : base.persistRejectedAudits,
        rejectedAuditFilePath: typeof obj.rejectedAuditFilePath === "string" &&
            obj.rejectedAuditFilePath.trim().length > 0
            ? obj.rejectedAuditFilePath.trim()
            : undefined,
        model: typeof obj.model === "string" && obj.model.trim().length > 0
            ? obj.model.trim()
            : undefined,
        modelAffinity: obj.modelAffinity === "lane" ? "lane" : "global",
    };
}
export function resolveRejectedAuditFilePath(dbPath, config) {
    const explicitPath = config?.rejectedAuditFilePath;
    if (typeof explicitPath === "string" && explicitPath.trim().length > 0) {
        return explicitPath.trim();
    }
    return join(dbPath, "..", "admission-audit", "rejections.jsonl");
}
function isHanChar(char) {
    return /\p{Script=Han}/u.test(char);
}
function isWordChar(char) {
    return /[\p{Letter}\p{Number}]/u.test(char);
}
function tokenizeText(value) {
    const normalized = value.toLowerCase().trim();
    const tokens = [];
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
function lcsLength(left, right) {
    if (left.length === 0 || right.length === 0)
        return 0;
    const dp = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
    for (let i = 1; i <= left.length; i++) {
        for (let j = 1; j <= right.length; j++) {
            if (left[i - 1] === right[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            }
            else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }
    return dp[left.length][right.length];
}
function rougeLikeF1(left, right) {
    if (left.length === 0 || right.length === 0)
        return 0;
    const lcs = lcsLength(left, right);
    if (lcs === 0)
        return 0;
    const precision = lcs / left.length;
    const recall = lcs / right.length;
    if (precision + recall === 0)
        return 0;
    return (2 * precision * recall) / (precision + recall);
}
function splitSupportSpans(conversationText) {
    const spans = new Set();
    for (const line of conversationText.split(/\n+/)) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
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
function cosineSimilarity(left, right) {
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
    if (leftNorm === 0 || rightNorm === 0)
        return 0;
    return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}
function buildUtilityPrompt(candidate) {
    const system = `${ADMISSION_JUDGE_IDENTITY} Evaluate whether this candidate memory is worth keeping for future cross-session interactions.

${CATEGORY_TAXONOMY}

Score future usefulness on a 0.0-1.0 scale.

${SCORE_TIER_RUBRIC}

Grounding rule: this candidate's own grounding tag already passed the deterministic pre-admission check (a "constructed" tag is rejected before this scoring ever runs), but a mistagged or legacy candidate can still describe a claim that is true only WITHIN a fiction — a persona's invented trait from roleplay, a game's rules or score, drafted fiction, a hypothetical, or sample data. If the candidate's own content shows such a constructed frame and its claim lives inside it rather than being a claim ABOUT the fiction (e.g. that a session/game happened), score it near zero for the durable categories (profile, preferences, entities, cases, patterns) regardless of how well-formed it looks. A session-scoped events note that the participants did the activity is a claim ABOUT the fiction and may still score moderately.

Return JSON only (the raw object, no markdown code fences):
${jsonShape(`{
  "utility": 0.0,
  "reason": "short explanation"
}`)}`;
    const user = `## Candidate

${formatCandidateBlock(1, candidate)}`;
    return { system, user };
}
/** Max candidates scored in a single batch-utility LLM call; larger batches are chunked. */
const BATCH_UTILITY_MAX_SIZE = 10;
/**
 * Few-shot example candidates for the batch-utility prompt. Rendered through
 * formatCandidateBlock (the same function that formats the live batch) so
 * the example's shape can never drift from the live candidates' shape.
 * Entirely synthetic content.
 */
const BATCH_UTILITY_EXAMPLE_CANDIDATES = [
    {
        category: "preferences",
        abstract: "User's preferred name is Alex",
        overview: "## Preference\nThe user asked to be addressed as Alex.",
        content: "The user said their preferred name is Alex and asked to be called that in future sessions.",
    },
    {
        category: "events",
        abstract: "User said hello",
        overview: "## Event\nA one-off greeting at the start of a session.",
        content: "The user opened the conversation with a short greeting.",
    },
    {
        category: "entities",
        abstract: "The project uses PostgreSQL as its primary datastore",
        overview: "## Entity\nPostgreSQL is the project's primary datastore.",
        content: "The user confirmed the project stores its data in PostgreSQL.",
    },
];
/**
 * Builds the batch-utility prompt as {system, user}: the static judge block
 * (identity, taxonomy, rubric, few-shot example, output contract) is the
 * system slot and the numbered candidate blocks are the user slot, which is
 * how scoreUtilityBatch submits them.
 *
 * Like buildUtilityPrompt, this intentionally carries no conversation
 * excerpt or other source-context blob — the admission judge scores solely
 * on what extraction provided for each candidate (category/abstract/
 * overview/content) plus, elsewhere in AdmissionController, the store's
 * existing rows via the non-LLM novelty feature.
 *
 * Formatting: every logical block (intro, taxonomy, scoring guidance, the
 * few-shot example, the return-format spec) is blank-line separated,
 * candidates within the example and within the live batch are blank-line
 * separated from each other, and both the example and the live batch render
 * each candidate through formatCandidateBlock — a `### N. category` markdown
 * heading with plain `Label: value` field lines under it, content-carried
 * list markers stripped — so the few-shot example and the live batch always
 * share one shape.
 *
 * Exported for the slot-conformance tests (system = static blocks, user =
 * per-call candidate data); production callers stay inside this module.
 */
export function buildBatchUtilityPrompt(candidates) {
    const exampleCandidateBlocks = BATCH_UTILITY_EXAMPLE_CANDIDATES.map((candidate, i) => formatCandidateBlock(i + 1, candidate)).join("\n\n");
    const system = `${ADMISSION_JUDGE_IDENTITY} Evaluate whether each candidate memory in this batch is worth keeping for future cross-session interactions.

${CATEGORY_TAXONOMY}

Score each candidate's future usefulness independently on a 0.0-1.0 scale. Score every item on its own absolute merit — do not rank or curve candidates relative to each other within this batch; a batch of entirely weak candidates should all score low, and a batch of entirely strong candidates should all score high.

${SCORE_TIER_RUBRIC}

--- EXAMPLE (not your current batch) ---
Example of absolute scoring across a mixed-quality batch:

## Candidates

${exampleCandidateBlocks}

Example response:
${jsonShape(`{"results":[{"index":1,"utility":0.9,"reason":"durable identity fact"},{"index":2,"utility":0.05,"reason":"one-off greeting, no lasting value"},{"index":3,"utility":0.85,"reason":"durable project/entity fact"}]}`)}

Candidate 2 scores low even though candidates 1 and 3 score high in the same batch: each item is judged on its own merit, never curved against its neighbors.
--- END EXAMPLE ---

Grounding rule: every candidate in this batch already passed the deterministic pre-admission check (a "constructed" tag is rejected before this scoring ever runs), but a mistagged or legacy candidate can still describe a claim that is true only WITHIN a fiction — a persona's invented trait from roleplay, a game's rules or score, drafted fiction, a hypothetical, or sample data. If a candidate's own content shows such a constructed frame and its claim lives inside it rather than being a claim ABOUT the fiction (e.g. that a session/game happened), score it near zero for the durable categories (profile, preferences, entities, cases, patterns) regardless of how well-formed it looks. A session-scoped events note that the participants did the activity is a claim ABOUT the fiction and may still score moderately.

Return JSON only (the raw object, no markdown code fences), with exactly one entry per candidate, in this shape:
${jsonShape(`{
  "results": [
    { "index": 1, "utility": 0.0, "reason": "short explanation" }
  ]
}`)}`;
    const candidateBlocks = candidates
        .map((candidate, i) => formatCandidateBlock(i + 1, candidate))
        .join("\n\n");
    const user = `## Candidates

${candidateBlocks}`;
    return { system, user };
}
/** Reason used for a batch row whose response entry is missing or malformed. */
const MALFORMED_BATCH_ENTRY_REASON = "Malformed batch entry: no usable response for this candidate";
/**
 * Maps a batch-utility response back to per-candidate scores in input order,
 * always returning exactly `expectedCount` entries — one per candidate,
 * never null. A response that is missing entirely, isn't shaped as
 * `{results: [...]}`, or omits/duplicates/misindexes a given candidate's
 * entry degrades that ROW ONLY, defaulting it to a neutral 0.5 utility
 * (mirroring scoreUtility's own failure default); every other row still
 * uses its real parsed score. This keeps the batch call count exactly
 * ceil(N/BATCH_UTILITY_MAX_SIZE) even when part of a response comes back
 * malformed — a single bad entry must never fan back out into one
 * standalone LLM call per candidate in the chunk.
 */
function parseBatchUtilityResponse(response, expectedCount) {
    const results = response && Array.isArray(response.results) ? response.results : [];
    const byIndex = new Map();
    for (const entry of results) {
        if (!entry || typeof entry.index !== "number")
            continue;
        byIndex.set(entry.index, entry);
    }
    const out = [];
    for (let i = 1; i <= expectedCount; i++) {
        const entry = byIndex.get(i);
        if (!entry) {
            out.push({ score: 0.5, reason: MALFORMED_BATCH_ENTRY_REASON });
            continue;
        }
        out.push({
            score: clamp01(entry.utility, 0.5),
            reason: typeof entry.reason === "string" ? entry.reason.trim() : undefined,
        });
    }
    return out;
}
/**
 * The admission-control LLM client talks directly to OpenRouter, so it needs
 * the bare "<vendor>/<model>" id OpenRouter's chat-completions API expects.
 * Model refs sourced from memoryReflection.model (or an explicit override)
 * may instead be in the core-style "openrouter/<vendor>/<model>" form the
 * reflection distiller's own embedded runner accepts — that runner picks a
 * backend from the leading segment, then forwards the rest as the model id.
 * Strip that literal "openrouter/" prefix so both forms reach this plugin's
 * direct client correctly; a bare "<vendor>/<model>" or an "@preset/<name>"
 * alias already work against OpenRouter unchanged, so they pass through.
 */
export function normalizeAdmissionModelRef(modelRef) {
    const trimmed = modelRef.trim();
    const idx = trimmed.indexOf("/");
    if (idx <= 0)
        return trimmed;
    const provider = trimmed.slice(0, idx).trim().toLowerCase();
    if (provider !== "openrouter")
        return trimmed;
    const rest = trimmed.slice(idx + 1).trim();
    return rest || trimmed;
}
/**
 * Resolves which LLM model an admission call should use, in order:
 * 1. An explicit admissionControl.model override always wins, on every lane.
 * 2. When modelAffinity is "lane", the reflection lane resolves the
 *    memoryReflection model (falling back to the global model if none is
 *    configured) — the judge is never dumber than the author whose rows it
 *    audits. Every other lane stays on the global model.
 * 3. Default ("global", or the knob absent): every lane uses the global
 *    model — today's behavior, unchanged.
 * Every returned model passes through normalizeAdmissionModelRef so a
 * core-style provider-prefixed string reaches this plugin's OpenRouter-direct
 * client in the form it requires, regardless of which of the three paths
 * above produced it.
 */
export function resolveAdmissionModel(params) {
    const explicit = params.admissionControl.model?.trim();
    if (explicit) {
        return normalizeAdmissionModelRef(explicit);
    }
    if (params.admissionControl.modelAffinity === "lane" && params.lane === "reflection") {
        const reflectionModel = params.reflectionModel?.trim();
        return normalizeAdmissionModelRef(reflectionModel || params.globalModel);
    }
    return normalizeAdmissionModelRef(params.globalModel);
}
function buildReason(details) {
    const scoreText = details.score.toFixed(3);
    const similarityText = details.maxSimilarity.toFixed(3);
    const utilityText = details.utilityReason ? ` Utility: ${details.utilityReason}` : "";
    if (details.decision === "reject") {
        return `Admission rejected (${scoreText} < ${details.rejectThreshold.toFixed(3)}). maxSimilarity=${similarityText}.${utilityText}`.trim();
    }
    const hintText = details.hint ? ` hint=${details.hint};` : "";
    return `Admission passed (${scoreText});${hintText} maxSimilarity=${similarityText}.${utilityText}`.trim();
}
export function scoreTypePrior(category, typePriors) {
    return clamp01(typePriors[category], DEFAULT_TYPE_PRIORS[category]);
}
export function scoreConfidenceSupport(candidate, conversationText) {
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
export function scoreNoveltyFromMatches(candidateVector, matches) {
    if (!Array.isArray(candidateVector) || candidateVector.length === 0 || matches.length === 0) {
        return { score: 1, maxSimilarity: 0, matchedIds: [], comparedIds: [] };
    }
    let maxSimilarity = 0;
    const comparedIds = [];
    const matchedIds = [];
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
export function scoreRecencyGap(now, matches, halfLifeDays) {
    if (matches.length === 0 || halfLifeDays <= 0) {
        return 1;
    }
    const latestTimestamp = Math.max(...matches.map((match) => (Number.isFinite(match.entry.timestamp) ? match.entry.timestamp : 0)));
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
async function scoreUtility(llm, mode, candidate) {
    if (mode === "off") {
        return { score: 0.5, reason: "Utility scoring disabled" };
    }
    let response = null;
    try {
        const { system, user } = buildUtilityPrompt(candidate);
        response = await llm.completeJson(user, "admission-utility", system);
    }
    catch {
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
/**
 * Construct an AdmissionController independently of any extraction engine.
 * Availability depends only on the admission config's `enabled` flag, so
 * callers that never build a SmartExtractor (e.g. smartExtraction: false)
 * can still obtain a working controller to gate other write paths.
 */
export function createAdmissionController(store, llm, config, debugLog = () => { }) {
    return config?.enabled === true
        ? new AdmissionController(store, llm, config, debugLog)
        : null;
}
export class AdmissionController {
    store;
    llm;
    config;
    debugLog;
    constructor(store, llm, config, debugLog = () => { }) {
        this.store = store;
        this.llm = llm;
        this.config = config;
        this.debugLog = debugLog;
    }
    async loadRelevantMatches(candidate, candidateVector, scopeFilter) {
        if (!Array.isArray(candidateVector) || candidateVector.length === 0) {
            return [];
        }
        const rawMatches = await this.store.vectorSearch(candidateVector, this.config.noveltyCandidatePoolSize, 0, scopeFilter);
        if (rawMatches.length === 0) {
            return [];
        }
        const sameCategoryMatches = rawMatches.filter((match) => {
            const metadata = parseSmartMetadata(match.entry.metadata, match.entry);
            return metadata.memory_category === candidate.category;
        });
        return sameCategoryMatches.length > 0 ? sameCategoryMatches : rawMatches;
    }
    async evaluate(params) {
        const utility = await scoreUtility(this.llm, this.config.utilityMode, params.candidate);
        return this.evaluateWithUtility(params, utility);
    }
    /**
     * Evaluate a single candidate given an already-scored utility feature.
     * Shared by evaluate() (per-candidate utility scoring) and evaluateBatch()
     * (utility scored once for the whole batch) — every other feature
     * (confidence/novelty/recency/typePrior) and the decision/audit logic stay
     * identical between the two paths.
     */
    async evaluateWithUtility(params, utility) {
        const now = params.now ?? Date.now();
        const relevantMatches = await this.loadRelevantMatches(params.candidate, params.candidateVector, params.scopeFilter);
        const confidence = scoreConfidenceSupport(params.candidate, params.conversationText);
        const novelty = scoreNoveltyFromMatches(params.candidateVector, relevantMatches);
        const recency = scoreRecencyGap(now, relevantMatches, this.config.recency.halfLifeDays);
        const typePrior = scoreTypePrior(params.candidate.category, this.config.typePriors);
        const featureScores = {
            utility: utility.score,
            confidence: confidence.score,
            novelty: novelty.score,
            recency,
            typePrior,
        };
        const score = (featureScores.utility * this.config.weights.utility) +
            (featureScores.confidence * this.config.weights.confidence) +
            (featureScores.novelty * this.config.weights.novelty) +
            (featureScores.recency * this.config.weights.recency) +
            (featureScores.typePrior * this.config.weights.typePrior);
        const utilityVetoed = this.config.utilityVetoThreshold > 0 &&
            featureScores.utility <= this.config.utilityVetoThreshold;
        const decision = utilityVetoed || score < this.config.rejectThreshold ? "reject" : "pass_to_dedup";
        const hint = decision === "reject"
            ? undefined
            : score >= this.config.admitThreshold && novelty.maxSimilarity < 0.55
                ? "add"
                : "update_or_merge";
        const reason = utilityVetoed
            ? `Admission rejected by utility veto (utility ${featureScores.utility.toFixed(2)} <= ${this.config.utilityVetoThreshold.toFixed(2)}; composite ${score.toFixed(3)}).${utility.reason ? ` Utility: ${utility.reason}` : ""}`
            : buildReason({
                decision,
                hint,
                score,
                rejectThreshold: this.config.rejectThreshold,
                maxSimilarity: novelty.maxSimilarity,
                utilityReason: utility.reason,
            });
        const audit = {
            version: "amac-v1",
            decision,
            hint,
            score,
            reason,
            utility_reason: utility.reason,
            thresholds: {
                reject: this.config.rejectThreshold,
                admit: this.config.admitThreshold,
                utilityVeto: this.config.utilityVetoThreshold,
            },
            weights: this.config.weights,
            feature_scores: featureScores,
            matched_existing_memory_ids: novelty.matchedIds,
            compared_existing_memory_ids: novelty.comparedIds,
            max_similarity: novelty.maxSimilarity,
            evaluated_at: now,
        };
        this.debugLog(`memory-lancedb-pro: admission-control: decision=${audit.decision} hint=${audit.hint ?? "n/a"} score=${audit.score.toFixed(3)} candidate=${JSON.stringify(params.candidate.abstract.slice(0, 80))}`);
        return { decision, hint, audit };
    }
    /**
     * Evaluate a batch of candidates that share one conversation/source
     * excerpt, scoring utility with exactly one LLM call per chunk of up to
     * BATCH_UTILITY_MAX_SIZE candidates (chunking larger batches) — this call
     * count holds regardless of caller (extraction lane today; any other lane,
     * e.g. reflection-mapped rows, that constructs its own AdmissionController
     * and calls evaluateBatch composes into the same guarantee with no further
     * changes here). Every other feature (confidence/novelty/recency/
     * typePrior) and the decision/audit logic remain fully per-candidate,
     * unchanged from evaluate().
     *
     * When utilityMode isn't "batch", falls back to one standalone evaluate()
     * call per candidate in that chunk. When utilityMode is "batch" but the
     * completeJson call itself throws, the same per-candidate standalone
     * fallback applies for that chunk. A response that comes back but is
     * partially malformed (missing/misindexed entries for specific
     * candidates) never fans out into extra calls: parseBatchUtilityResponse
     * degrades only the affected rows to a neutral default, so a malformed
     * entry drops only that row's utility score, not the whole chunk's call
     * budget.
     */
    async evaluateBatch(items) {
        if (items.length === 0)
            return [];
        const chunks = [];
        for (let i = 0; i < items.length; i += BATCH_UTILITY_MAX_SIZE) {
            chunks.push(items.slice(i, i + BATCH_UTILITY_MAX_SIZE));
        }
        const results = [];
        for (const chunk of chunks) {
            results.push(...(await this.evaluateChunk(chunk)));
        }
        return results;
    }
    async evaluateChunk(chunk) {
        if (this.config.utilityMode !== "batch") {
            const out = [];
            for (const item of chunk) {
                out.push(await this.evaluate(item));
            }
            return out;
        }
        const utilities = await this.scoreUtilityBatch(chunk.map((item) => item.candidate));
        const out = [];
        for (let i = 0; i < chunk.length; i++) {
            out.push(await this.evaluateWithUtility(chunk[i], utilities[i]));
        }
        return out;
    }
    /**
     * Scores utility for one chunk with a single LLM call. Only a call-level
     * failure (the completeJson call itself throwing, e.g. a network error)
     * falls back to one standalone evaluate() per candidate — a genuinely
     * empty response for the whole chunk. A response that comes back but is
     * partially malformed (missing/misindexed entries) never triggers that
     * fallback: parseBatchUtilityResponse degrades only the affected rows, so
     * the call count for this chunk is always exactly one either way.
     */
    async scoreUtilityBatch(candidates) {
        const { system, user } = buildBatchUtilityPrompt(candidates);
        let response = null;
        try {
            response = await this.llm.completeJson(user, "admission-utility-batch", system);
        }
        catch {
            // Candidate count is included on both this line and the success line
            // below so a flow-accounting audit reading logs can tally batch-call
            // volume the same way regardless of outcome, and so a second
            // evaluateBatch call-site (e.g. a future reflection-lane controller,
            // composed at assembly per item 3) attributes cleanly through
            // whatever debugLog prefix that lane's own construction site injects.
            this.debugLog(`memory-lancedb-pro: admission-control: batch utility call failed for ${candidates.length} candidates, falling back to standalone`);
            const out = [];
            for (const candidate of candidates) {
                out.push(await scoreUtility(this.llm, "standalone", candidate));
            }
            return out;
        }
        this.debugLog(`memory-lancedb-pro: admission-control: batch utility call scored ${candidates.length} candidates in one call`);
        return parseBatchUtilityResponse(response, candidates.length);
    }
}
