import { LEGACY_MEMORY_CATEGORIES, MEMORY_CATEGORIES, } from "./memory-categories.js";
import { buildSmartMetadata, parseSmartMetadata, stringifySmartMetadata, toLifecycleMemory, } from "./smart-metadata.js";
const MS_PER_DAY = 86_400_000;
const DEFAULT_FREQUENCY = "0 3 * * *";
const DEFAULT_PAGE_SIZE = 100;
const STORED_MEMORY_SOURCES = [
    "manual",
    "auto-capture",
    "reflection",
    "dreaming-engine",
    "session-summary",
    "legacy",
];
const DREAMING_SOURCE_ALIASES = {
    daily: { sources: ["manual", "auto-capture", "legacy"] },
    sessions: { sources: ["session-summary"] },
    recall: { sources: ["manual", "auto-capture", "legacy"] },
    logs: { sources: ["auto-capture"] },
    memory: { sources: ["manual", "auto-capture", "legacy"] },
    deep: { phases: ["deep"] },
};
const VALID_DREAMING_SOURCE_FILTERS = new Set([
    ...Object.keys(DREAMING_SOURCE_ALIASES),
    ...STORED_MEMORY_SOURCES,
    ...MEMORY_CATEGORIES,
    ...LEGACY_MEMORY_CATEGORIES,
]);
const STOP_WORDS = new Set([
    "about",
    "after",
    "again",
    "also",
    "because",
    "before",
    "between",
    "could",
    "memory",
    "should",
    "their",
    "there",
    "these",
    "those",
    "through",
    "using",
    "where",
    "which",
    "while",
    "would",
]);
export const DEFAULT_DREAMING_CONFIG = {
    enabled: false,
    frequency: DEFAULT_FREQUENCY,
    verboseLogging: false,
    phases: {
        light: {
            enabled: true,
            lookbackDays: 2,
            limit: 100,
            dedupeSimilarity: 0.92,
        },
        rem: {
            enabled: true,
            lookbackDays: 7,
            limit: 10,
            minPatternStrength: 0.6,
        },
        deep: {
            enabled: true,
            limit: 10,
            minScore: 0.6,
            minRecallCount: 3,
            minUniqueQueries: 0,
            recencyHalfLifeDays: 14,
            maxAgeDays: 90,
        },
    },
};
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function asPositiveInt(value) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0)
        return Math.floor(value);
    if (typeof value === "string" && value.trim()) {
        const parsed = Number(value.trim());
        if (Number.isFinite(parsed) && parsed > 0)
            return Math.floor(parsed);
    }
    return undefined;
}
function asNonNegativeInt(value) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0)
        return Math.floor(value);
    if (typeof value === "string" && value.trim()) {
        const parsed = Number(value.trim());
        if (Number.isFinite(parsed) && parsed >= 0)
            return Math.floor(parsed);
    }
    return undefined;
}
function asNumberInRange(value, min, max) {
    const parsed = typeof value === "number"
        ? value
        : typeof value === "string" && value.trim()
            ? Number(value.trim())
            : Number.NaN;
    if (!Number.isFinite(parsed))
        return undefined;
    return Math.min(max, Math.max(min, parsed));
}
function normalizeDreamingSources(value) {
    if (!Array.isArray(value))
        return undefined;
    const values = [];
    for (const item of value) {
        if (typeof item !== "string" || item.trim().length === 0)
            continue;
        const normalized = item.trim().toLowerCase();
        if (!VALID_DREAMING_SOURCE_FILTERS.has(normalized)) {
            throw new Error(`Unsupported dreaming source filter "${item}". ` +
                `Supported filters: ${[...VALID_DREAMING_SOURCE_FILTERS].sort().join(", ")}`);
        }
        if (!values.includes(normalized))
            values.push(normalized);
    }
    return values.length > 0 ? values : undefined;
}
function normalizeLight(raw) {
    const cfg = isRecord(raw) ? raw : {};
    return {
        enabled: cfg.enabled !== false,
        lookbackDays: asNonNegativeInt(cfg.lookbackDays) ?? DEFAULT_DREAMING_CONFIG.phases.light.lookbackDays,
        limit: asNonNegativeInt(cfg.limit) ?? DEFAULT_DREAMING_CONFIG.phases.light.limit,
        dedupeSimilarity: asNumberInRange(cfg.dedupeSimilarity, 0, 1) ??
            DEFAULT_DREAMING_CONFIG.phases.light.dedupeSimilarity,
        sources: normalizeDreamingSources(cfg.sources),
    };
}
function normalizeDeep(raw) {
    const cfg = isRecord(raw) ? raw : {};
    return {
        enabled: cfg.enabled !== false,
        limit: asNonNegativeInt(cfg.limit) ?? DEFAULT_DREAMING_CONFIG.phases.deep.limit,
        minScore: asNumberInRange(cfg.minScore, 0, 1) ?? DEFAULT_DREAMING_CONFIG.phases.deep.minScore,
        minRecallCount: asNonNegativeInt(cfg.minRecallCount) ??
            DEFAULT_DREAMING_CONFIG.phases.deep.minRecallCount,
        minUniqueQueries: asNonNegativeInt(cfg.minUniqueQueries) ??
            DEFAULT_DREAMING_CONFIG.phases.deep.minUniqueQueries,
        recencyHalfLifeDays: asPositiveInt(cfg.recencyHalfLifeDays) ??
            DEFAULT_DREAMING_CONFIG.phases.deep.recencyHalfLifeDays,
        maxAgeDays: asPositiveInt(cfg.maxAgeDays) ?? DEFAULT_DREAMING_CONFIG.phases.deep.maxAgeDays,
        sources: normalizeDreamingSources(cfg.sources),
    };
}
function normalizeRem(raw) {
    const cfg = isRecord(raw) ? raw : {};
    return {
        enabled: cfg.enabled !== false,
        lookbackDays: asNonNegativeInt(cfg.lookbackDays) ?? DEFAULT_DREAMING_CONFIG.phases.rem.lookbackDays,
        limit: asNonNegativeInt(cfg.limit) ?? DEFAULT_DREAMING_CONFIG.phases.rem.limit,
        minPatternStrength: asNumberInRange(cfg.minPatternStrength, 0, 1) ??
            DEFAULT_DREAMING_CONFIG.phases.rem.minPatternStrength,
        sources: normalizeDreamingSources(cfg.sources),
    };
}
export function normalizeDreamingConfig(value) {
    const raw = isRecord(value) ? value : {};
    const phases = isRecord(raw.phases) ? raw.phases : {};
    const frequency = typeof raw.frequency === "string" && raw.frequency.trim()
        ? raw.frequency.trim()
        : DEFAULT_DREAMING_CONFIG.frequency;
    if (raw.enabled === true && !parseDailyCron(frequency)) {
        throw new Error(`Unsupported dreaming.frequency "${frequency}". Use "@daily" or a daily cron expression like "0 3 * * *".`);
    }
    return {
        enabled: raw.enabled === true,
        frequency,
        timezone: typeof raw.timezone === "string" && raw.timezone.trim() ? raw.timezone.trim() : undefined,
        verboseLogging: raw.verboseLogging === true,
        model: typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : undefined,
        storage: isRecord(raw.storage) ? raw.storage : undefined,
        execution: isRecord(raw.execution) ? raw.execution : undefined,
        phases: {
            light: normalizeLight(phases.light),
            deep: normalizeDeep(phases.deep),
            rem: normalizeRem(phases.rem),
        },
    };
}
export function parseDailyCron(value) {
    const raw = (value || DEFAULT_FREQUENCY).trim();
    if (raw === "@daily")
        return { minute: 0, hour: 0 };
    const match = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/.exec(raw);
    if (!match)
        return null;
    const minute = Number(match[1]);
    const hour = Number(match[2]);
    if (!Number.isInteger(minute) || !Number.isInteger(hour))
        return null;
    if (minute < 0 || minute > 59 || hour < 0 || hour > 23)
        return null;
    return { minute, hour };
}
function getZonedParts(ms, timezone) {
    if (!timezone) {
        const date = new Date(ms);
        return {
            year: date.getUTCFullYear(),
            month: date.getUTCMonth() + 1,
            day: date.getUTCDate(),
            hour: date.getUTCHours(),
            minute: date.getUTCMinutes(),
        };
    }
    try {
        const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: timezone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
        }).formatToParts(new Date(ms));
        const pick = (type) => Number(parts.find((part) => part.type === type)?.value);
        const year = pick("year");
        const month = pick("month");
        const day = pick("day");
        const hour = pick("hour");
        const minute = pick("minute");
        if ([year, month, day, hour, minute].every(Number.isFinite)) {
            return { year, month, day, hour, minute };
        }
    }
    catch {
        // Fall back to UTC below.
    }
    return getZonedParts(ms);
}
function getTimezoneOffsetMs(timezone, date) {
    if (!timezone)
        return 0;
    try {
        const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: timezone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hourCycle: "h23",
        }).formatToParts(date);
        const pick = (type) => Number(parts.find((part) => part.type === type)?.value);
        const asUtc = Date.UTC(pick("year"), pick("month") - 1, pick("day"), pick("hour"), pick("minute"), pick("second"));
        return asUtc - date.getTime();
    }
    catch {
        return 0;
    }
}
function zonedLocalToUtcMs(year, month, day, hour, minute, timezone) {
    let utc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
    if (!timezone)
        return utc;
    for (let i = 0; i < 2; i++) {
        const offset = getTimezoneOffsetMs(timezone, new Date(utc));
        utc = Date.UTC(year, month - 1, day, hour, minute, 0, 0) - offset;
    }
    return utc;
}
export function computeNextDreamingDelayMs(frequency, timezone, nowMs = Date.now()) {
    const cron = parseDailyCron(frequency);
    if (!cron)
        return MS_PER_DAY;
    const parts = getZonedParts(nowMs, timezone);
    let candidate = zonedLocalToUtcMs(parts.year, parts.month, parts.day, cron.hour, cron.minute, timezone);
    if (candidate <= nowMs + 500) {
        const tomorrowUtc = Date.UTC(parts.year, parts.month - 1, parts.day) + MS_PER_DAY;
        const tomorrow = new Date(tomorrowUtc);
        candidate = zonedLocalToUtcMs(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), cron.hour, cron.minute, timezone);
    }
    return Math.max(1_000, candidate - nowMs);
}
function emptyPhaseResult() {
    return { scanned: 0, changed: 0 };
}
function clamp01(value) {
    if (!Number.isFinite(value))
        return 0;
    return Math.min(1, Math.max(0, value));
}
function cosineSimilarity(a, b) {
    if (a.length === 0 || b.length === 0 || a.length !== b.length)
        return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    if (normA <= 0 || normB <= 0)
        return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
function selectCanonical(a, b) {
    const score = (entry) => (Number(entry.importance) || 0) * 10 +
        Math.min(2, Math.max(0, entry.text.length / 400)) +
        ((entry.timestamp || 0) / 10_000_000_000_000);
    return score(a) >= score(b) ? a : b;
}
function parseUniqueQueryCount(metadata) {
    const direct = metadata.unique_query_count ?? metadata.uniqueQueries ?? metadata.recall_unique_queries;
    if (typeof direct === "number" && Number.isFinite(direct))
        return Math.max(0, Math.floor(direct));
    if (Array.isArray(direct))
        return direct.length;
    if (direct && typeof direct === "object")
        return Object.keys(direct).length;
    const queryIds = metadata.recall_query_ids ?? metadata.query_ids;
    if (Array.isArray(queryIds))
        return new Set(queryIds.filter((item) => typeof item === "string")).size;
    return 0;
}
function isDreamingGenerated(entry) {
    const metadata = parseSmartMetadata(entry.metadata, entry);
    return metadata.source === "dreaming-engine";
}
function isActiveUserMemory(entry, at) {
    const metadata = parseSmartMetadata(entry.metadata, entry);
    if (metadata.state === "archived")
        return false;
    if (metadata.memory_layer === "archive")
        return false;
    if (metadata.invalidated_at && metadata.invalidated_at <= at)
        return false;
    return !isDreamingGenerated(entry);
}
function entryMatchesSources(entry, sources) {
    if (!sources || sources.length === 0)
        return true;
    const metadata = parseSmartMetadata(entry.metadata, entry);
    const memoryCategory = typeof metadata.memory_category === "string" ? metadata.memory_category : "";
    const memoryLayer = typeof metadata.memory_layer === "string" ? metadata.memory_layer : "";
    const dreamingPhase = typeof metadata.dreaming_phase === "string" ? metadata.dreaming_phase : "";
    return sources.some((source) => {
        const alias = DREAMING_SOURCE_ALIASES[source];
        if (alias) {
            return Boolean(alias.sources?.includes(metadata.source) ||
                alias.phases?.includes(dreamingPhase));
        }
        return source === metadata.source ||
            source === entry.category ||
            source === memoryCategory ||
            source === memoryLayer ||
            source === dreamingPhase;
    });
}
function scoreDeepCandidate(entry, config, now) {
    const metadata = parseSmartMetadata(entry.metadata, entry);
    const ageDays = Math.max(0, (now - entry.timestamp) / MS_PER_DAY);
    const recency = Math.exp(-ageDays / Math.max(1, config.recencyHalfLifeDays));
    const access = Math.min(1, metadata.access_count / Math.max(1, config.minRecallCount * 2));
    const confidence = clamp01(metadata.confidence);
    const importance = clamp01(entry.importance);
    return clamp01((importance * 0.45) + (confidence * 0.2) + (access * 0.25) + (recency * 0.1));
}
function tokenize(text) {
    const matches = text.toLowerCase().match(/[\p{L}\p{N}_-]{4,}/gu) ?? [];
    return matches
        .map((item) => item.replace(/^[-_]+|[-_]+$/g, ""))
        .filter((item) => item.length >= 4 && !STOP_WORDS.has(item));
}
function addPatternCount(counts, key) {
    if (!key)
        return;
    counts.set(key, (counts.get(key) ?? 0) + 1);
}
function buildPatterns(entries, minPatternStrength) {
    const total = Math.max(1, entries.length);
    const categoryCounts = new Map();
    const memoryCategoryCounts = new Map();
    const termCounts = new Map();
    for (const entry of entries) {
        const metadata = parseSmartMetadata(entry.metadata, entry);
        addPatternCount(categoryCounts, entry.category);
        addPatternCount(memoryCategoryCounts, metadata.memory_category);
        const terms = new Set(tokenize(`${metadata.l0_abstract} ${entry.text}`));
        for (const term of terms) {
            addPatternCount(termCounts, term);
        }
    }
    const build = (type, counts) => [...counts.entries()]
        .map(([key, count]) => ({ type, key, count, strength: count / total }))
        .filter((pattern) => pattern.count >= 2 && pattern.strength >= minPatternStrength)
        .sort((a, b) => b.strength - a.strength || b.count - a.count || a.key.localeCompare(b.key));
    return [
        ...build("category", categoryCounts),
        ...build("memory_category", memoryCategoryCounts),
        ...build("term", termCounts),
    ].slice(0, 6);
}
function formatDateStamp(now, timezone) {
    const parts = getZonedParts(now, timezone);
    return `${parts.year.toString().padStart(4, "0")}-${parts.month.toString().padStart(2, "0")}-${parts.day.toString().padStart(2, "0")}`;
}
function phaseEnabled(config) {
    return config.enabled === true && (config.limit ?? 1) > 0;
}
export function createDreamingEngine(deps) {
    const config = normalizeDreamingConfig(deps.config);
    const now = deps.now ?? (() => Date.now());
    let stopped = false;
    const debug = (message) => {
        if (config.verboseLogging)
            deps.logger?.debug?.(message);
    };
    async function resolveScopes(explicit) {
        const fromExplicit = explicit?.filter((scope) => typeof scope === "string" && scope.trim().length > 0);
        if (fromExplicit && fromExplicit.length > 0)
            return [...new Set(fromExplicit.map((scope) => scope.trim()))];
        const fromHook = await deps.getScopes?.().catch(() => []);
        if (fromHook && fromHook.length > 0) {
            return [...new Set(fromHook.filter(Boolean).map((scope) => scope.trim()))];
        }
        const stats = await deps.store.stats().catch(() => ({ totalCount: 0, scopeCounts: {} }));
        const scopes = Object.keys(stats.scopeCounts).filter((scope) => scope.trim().length > 0);
        return scopes.length > 0 ? scopes.sort() : ["global"];
    }
    async function collectListEntries(scope, limit, lookbackDays, sources) {
        const cutoff = lookbackDays === undefined ? Number.NEGATIVE_INFINITY : now() - (lookbackDays * MS_PER_DAY);
        const entries = [];
        let offset = 0;
        const pageSize = Math.max(DEFAULT_PAGE_SIZE, Math.min(250, Math.max(1, limit)));
        while (entries.length < limit) {
            const page = await deps.store.list([scope], undefined, pageSize, offset);
            if (page.length === 0)
                break;
            for (const entry of page) {
                if (entry.timestamp < cutoff)
                    continue;
                if (!entryMatchesSources(entry, sources))
                    continue;
                if (!isActiveUserMemory(entry, now()))
                    continue;
                entries.push(entry);
                if (entries.length >= limit)
                    break;
            }
            if (page.length < pageSize)
                break;
            offset += pageSize;
        }
        return entries;
    }
    async function collectVectorEntries(config, scope) {
        if (!deps.store.fetchForCompaction)
            return [];
        const cutoff = now() - (config.lookbackDays * MS_PER_DAY);
        const fetchLimit = Math.max(DEFAULT_PAGE_SIZE, config.limit * 10, config.limit);
        const entries = await deps.store.fetchForCompaction(now() + 1, [scope], fetchLimit);
        return entries
            .filter((entry) => entry.timestamp >= cutoff)
            .filter((entry) => entryMatchesSources(entry, config.sources))
            .filter((entry) => isActiveUserMemory(entry, now()))
            .filter((entry) => Array.isArray(entry.vector) && entry.vector.length > 0)
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, config.limit);
    }
    async function runLight(scope) {
        const phase = config.phases.light;
        if (!phaseEnabled(phase))
            return emptyPhaseResult();
        const vectorEntries = await collectVectorEntries(phase, scope);
        const archivedIds = new Set();
        let archived = 0;
        for (let i = 0; i < vectorEntries.length; i++) {
            const a = vectorEntries[i];
            if (archivedIds.has(a.id))
                continue;
            for (let j = i + 1; j < vectorEntries.length; j++) {
                const b = vectorEntries[j];
                if (archivedIds.has(b.id))
                    continue;
                if (a.category !== b.category)
                    continue;
                const similarity = cosineSimilarity(a.vector, b.vector);
                if (similarity < phase.dedupeSimilarity)
                    continue;
                const canonical = selectCanonical(a, b);
                const duplicate = canonical.id === a.id ? b : a;
                const archivedAt = now();
                const patched = await deps.store.patchMetadata(duplicate.id, {
                    state: "archived",
                    memory_layer: "archive",
                    invalidated_at: archivedAt,
                    canonical_id: canonical.id,
                    dreaming_phase: "light",
                    dreaming_archived_at: archivedAt,
                    dreaming_archive_reason: `duplicate similarity ${similarity.toFixed(3)}`,
                }, [scope]);
                if (patched) {
                    archived += 1;
                    archivedIds.add(duplicate.id);
                    if (duplicate.id === a.id)
                        break;
                }
            }
        }
        const listEntries = await collectListEntries(scope, phase.limit, phase.lookbackDays, phase.sources);
        let tierTransitions = 0;
        for (const entry of listEntries) {
            if (archivedIds.has(entry.id))
                continue;
            const metadata = parseSmartMetadata(entry.metadata, entry);
            const lifecycle = toLifecycleMemory(entry.id, entry);
            const score = deps.decayEngine?.score(lifecycle, now());
            const transition = score
                ? deps.tierManager?.evaluate(lifecycle, score, now())
                : null;
            if (!transition || transition.toTier === metadata.tier)
                continue;
            const patched = await deps.store.patchMetadata(entry.id, {
                tier: transition.toTier,
                dreaming_phase: "light",
                dreaming_last_light_at: now(),
                dreaming_tier_reason: transition.reason,
            }, [scope]);
            if (patched)
                tierTransitions += 1;
        }
        return {
            scanned: Math.max(vectorEntries.length, listEntries.length),
            changed: archived + tierTransitions,
            archived,
            tierTransitions,
        };
    }
    async function runDeep(scope) {
        const phase = config.phases.deep;
        if (!phaseEnabled(phase))
            return emptyPhaseResult();
        const entries = await collectListEntries(scope, Math.max(phase.limit * 6, phase.limit), phase.maxAgeDays, phase.sources);
        let promoted = 0;
        for (const entry of entries) {
            if (promoted >= phase.limit)
                break;
            const metadata = parseSmartMetadata(entry.metadata, entry);
            if (metadata.tier === "core" || metadata.memory_layer === "durable")
                continue;
            if (metadata.access_count < phase.minRecallCount)
                continue;
            if (parseUniqueQueryCount(metadata) < phase.minUniqueQueries)
                continue;
            const score = scoreDeepCandidate(entry, phase, now());
            if (score < phase.minScore)
                continue;
            const promotedMetadata = buildSmartMetadata(entry, {
                tier: "core",
                memory_layer: "durable",
                dreaming_phase: "deep",
                dreaming_promoted_at: now(),
                dreaming_deep_score: Number(score.toFixed(4)),
            });
            const updated = await deps.store.update(entry.id, {
                importance: Math.max(entry.importance, Math.min(0.98, Math.max(entry.importance, score) + 0.05)),
                metadata: stringifySmartMetadata(promotedMetadata),
            }, [scope]);
            if (!updated)
                continue;
            promoted += 1;
        }
        return {
            scanned: entries.length,
            changed: promoted,
            promoted,
        };
    }
    async function runRem(scope) {
        const phase = config.phases.rem;
        if (!phaseEnabled(phase))
            return emptyPhaseResult();
        const entries = await collectListEntries(scope, phase.limit, phase.lookbackDays, phase.sources);
        const patterns = buildPatterns(entries, phase.minPatternStrength);
        if (patterns.length === 0) {
            return { scanned: entries.length, changed: 0, created: 0, patterns: [] };
        }
        const dateStamp = formatDateStamp(now(), config.timezone);
        const recentReflections = await deps.store.list([scope], "reflection", 25, 0).catch(() => []);
        const alreadyStored = recentReflections.some((entry) => {
            const metadata = parseSmartMetadata(entry.metadata, entry);
            return metadata.source === "dreaming-engine" &&
                metadata.dreaming_phase === "rem" &&
                metadata.dream_date === dateStamp;
        });
        if (alreadyStored) {
            return { scanned: entries.length, changed: 0, created: 0, patterns };
        }
        const lines = patterns.map((pattern) => `- ${pattern.type} "${pattern.key}" appears in ${pattern.count}/${entries.length} memories (strength ${pattern.strength.toFixed(2)}).`);
        const text = [
            `Dreaming REM reflection for scope "${scope}" on ${dateStamp}.`,
            "",
            "Observed recurring memory patterns:",
            ...lines,
        ].join("\n");
        const vector = await deps.embedder.embed(text);
        const metadata = buildSmartMetadata({
            text,
            category: "reflection",
            importance: 0.55,
            timestamp: now(),
        }, {
            source: "dreaming-engine",
            state: "confirmed",
            memory_layer: "reflection",
            tier: "working",
            memory_category: "patterns",
            dreaming_phase: "rem",
            dream_date: dateStamp,
            dream_timestamp: now(),
            patterns_count: patterns.length,
            memories_analyzed: entries.length,
        });
        await deps.store.store({
            text,
            vector,
            category: "reflection",
            scope,
            importance: 0.55,
            metadata: stringifySmartMetadata(metadata),
        });
        return { scanned: entries.length, changed: 1, created: 1, patterns };
    }
    async function runPhase(phase, scope) {
        if (phase === "light")
            return runLight(scope);
        if (phase === "deep")
            return runDeep(scope);
        return runRem(scope);
    }
    return {
        config,
        start() {
            stopped = false;
        },
        stop() {
            stopped = true;
        },
        async runSweep(explicitScopes) {
            const startedAt = now();
            const result = {
                enabled: config.enabled,
                startedAt,
                finishedAt: startedAt,
                scopes: [],
                phases: {
                    light: emptyPhaseResult(),
                    deep: emptyPhaseResult(),
                    rem: emptyPhaseResult(),
                },
                errors: [],
            };
            if (!config.enabled || stopped) {
                result.finishedAt = now();
                return result;
            }
            const scopes = await resolveScopes(explicitScopes);
            result.scopes = scopes;
            debug(`memory-lancedb-pro: dreaming sweep started for scopes: ${scopes.join(", ")}`);
            for (const scope of scopes) {
                if (stopped)
                    break;
                for (const phase of ["light", "deep", "rem"]) {
                    if (stopped)
                        break;
                    try {
                        const phaseResult = await runPhase(phase, scope);
                        result.phases[phase].scanned += phaseResult.scanned;
                        result.phases[phase].changed += phaseResult.changed;
                        result.phases[phase].created = (result.phases[phase].created ?? 0) + (phaseResult.created ?? 0);
                        result.phases[phase].archived = (result.phases[phase].archived ?? 0) + (phaseResult.archived ?? 0);
                        result.phases[phase].promoted = (result.phases[phase].promoted ?? 0) + (phaseResult.promoted ?? 0);
                        result.phases[phase].tierTransitions =
                            (result.phases[phase].tierTransitions ?? 0) + (phaseResult.tierTransitions ?? 0);
                        if (phaseResult.patterns?.length) {
                            result.phases[phase].patterns = [
                                ...(result.phases[phase].patterns ?? []),
                                ...phaseResult.patterns,
                            ];
                        }
                    }
                    catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        result.errors.push({ scope, phase, message });
                        deps.logger?.warn?.(`memory-lancedb-pro: dreaming ${phase} phase failed for scope ${scope}: ${message}`);
                    }
                }
            }
            result.finishedAt = now();
            debug(`memory-lancedb-pro: dreaming sweep finished ` +
                `(changed=${Object.values(result.phases).reduce((sum, phase) => sum + phase.changed, 0)}, errors=${result.errors.length})`);
            return result;
        },
    };
}
