import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { readdir, stat } from "node:fs/promises";
import { parseCanonicalCorpusMetadata, } from "./corpus-indexer.js";
const DEFAULT_FLUSH_SOFT_THRESHOLD_TOKENS = 4000;
const DEFAULT_FLUSH_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
const DEFAULT_FLUSH_RESERVE_TOKENS_FLOOR = 20000;
const MEMORY_FLUSH_TARGET_HINT = "Store durable memories through memory_store and, when file-backed notes are available, append only to memory/YYYY-MM-DD.md.";
const MEMORY_FLUSH_READ_ONLY_HINT = "Treat MEMORY.md, DREAMS.md, SOUL.md, TOOLS.md, and AGENTS.md as read-only reference files during this flush.";
const MEMORY_FLUSH_APPEND_ONLY_HINT = "Do not overwrite or replace existing memory files; append new facts, decisions, preferences, and open loops only.";
const MEMORY_HOST_EVENT_LOG_RELATIVE_PATH = "memory/.dreams/events.jsonl";
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function asString(value) {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
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
function parseByteSize(value) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0)
        return Math.floor(value);
    if (typeof value !== "string")
        return undefined;
    const match = /^(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib|gb|gib)?$/i.exec(value.trim());
    if (!match)
        return undefined;
    const amount = Number(match[1]);
    const unit = (match[2] ?? "b").toLowerCase();
    const multiplier = unit === "gb" || unit === "gib" ? 1024 * 1024 * 1024 :
        unit === "mb" || unit === "mib" ? 1024 * 1024 :
            unit === "kb" || unit === "kib" ? 1024 :
                1;
    return Math.floor(amount * multiplier);
}
function formatDateStamp(nowMs, timezone) {
    if (timezone) {
        try {
            const parts = new Intl.DateTimeFormat("en-US", {
                timeZone: timezone,
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
            }).formatToParts(new Date(nowMs));
            const year = parts.find((part) => part.type === "year")?.value;
            const month = parts.find((part) => part.type === "month")?.value;
            const day = parts.find((part) => part.type === "day")?.value;
            if (year && month && day)
                return `${year}-${month}-${day}`;
        }
        catch {
            // Fall back to UTC below.
        }
    }
    return new Date(nowMs).toISOString().slice(0, 10);
}
function resolveTimezone(cfg) {
    const agents = isRecord(cfg?.agents) ? cfg.agents : undefined;
    const defaults = isRecord(agents?.defaults) ? agents.defaults : undefined;
    return asString(defaults?.userTimezone);
}
function resolveMemoryFlushConfig(cfg) {
    const agents = isRecord(cfg?.agents) ? cfg.agents : undefined;
    const defaults = isRecord(agents?.defaults) ? agents.defaults : undefined;
    const compaction = isRecord(defaults?.compaction) ? defaults.compaction : undefined;
    return isRecord(compaction?.memoryFlush) ? compaction.memoryFlush : undefined;
}
function ensureFlushHint(text, hint) {
    return text.includes(hint) ? text : `${text.trim()}\n\n${hint}`.trim();
}
function buildMemoryFlushText(raw, fallback) {
    let text = asString(raw) ?? fallback;
    text = ensureFlushHint(text, MEMORY_FLUSH_TARGET_HINT);
    text = ensureFlushHint(text, MEMORY_FLUSH_READ_ONLY_HINT);
    text = ensureFlushHint(text, MEMORY_FLUSH_APPEND_ONLY_HINT);
    return text;
}
function expandUserPath(value) {
    if (value === "~")
        return homedir();
    if (value.startsWith("~/"))
        return join(homedir(), value.slice(2));
    return value;
}
function resolveWorkspacePath(value) {
    return resolve(expandUserPath(value));
}
function defaultWorkspaceDir() {
    return join(homedir(), ".openclaw", "workspace");
}
function collectConfiguredWorkspaces(cfg) {
    const byWorkspace = new Map();
    const add = (workspaceValue, agentValue) => {
        const workspace = asString(workspaceValue);
        if (!workspace)
            return;
        const agentId = asString(agentValue) ?? "main";
        const workspaceDir = resolveWorkspacePath(workspace);
        const agents = byWorkspace.get(workspaceDir) ?? new Set();
        agents.add(agentId);
        byWorkspace.set(workspaceDir, agents);
    };
    const agents = isRecord(cfg?.agents) ? cfg.agents : undefined;
    const list = Array.isArray(agents?.list) ? agents.list : [];
    for (const entry of list) {
        if (!isRecord(entry))
            continue;
        add(entry.workspace ?? entry.workspaceDir ?? entry.cwd, entry.id);
    }
    const defaults = isRecord(agents?.defaults) ? agents.defaults : undefined;
    add(defaults?.workspace ?? defaults?.workspaceDir ?? defaults?.cwd, "main");
    if (byWorkspace.size === 0)
        byWorkspace.set(defaultWorkspaceDir(), new Set(["main"]));
    return [...byWorkspace.entries()].map(([workspaceDir, agentIds]) => ({
        workspaceDir,
        agentIds: [...agentIds].sort((left, right) => left.localeCompare(right)),
    }));
}
async function listMarkdownFilesRecursive(rootDir) {
    const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
    const files = [];
    for (const entry of entries) {
        const absolutePath = join(rootDir, entry.name);
        if (entry.isDirectory()) {
            files.push(...await listMarkdownFilesRecursive(absolutePath));
        }
        else if (entry.isFile() && entry.name.endsWith(".md")) {
            files.push(absolutePath);
        }
    }
    return files.sort((left, right) => left.localeCompare(right));
}
function classifyArtifactKind(relativePath) {
    if (relativePath === "MEMORY.md")
        return "memory-root";
    if (relativePath.startsWith("memory/dreaming/"))
        return "dream-report";
    if (relativePath.startsWith("memory/short-term-promotion/"))
        return "short-term-promotion";
    if (relativePath.startsWith("memory/"))
        return "daily-note";
    return "memory-artifact";
}
async function collectPublicArtifactsForWorkspace(params) {
    const artifacts = [];
    const rootEntries = new Set((await readdir(params.workspaceDir, { withFileTypes: true }).catch(() => []))
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name));
    if (rootEntries.has("MEMORY.md")) {
        artifacts.push({
            kind: "memory-root",
            workspaceDir: params.workspaceDir,
            relativePath: "MEMORY.md",
            absolutePath: join(params.workspaceDir, "MEMORY.md"),
            agentIds: [...params.agentIds],
            contentType: "markdown",
        });
    }
    for (const absolutePath of await listMarkdownFilesRecursive(join(params.workspaceDir, "memory"))) {
        const relativePath = relative(params.workspaceDir, absolutePath).replace(/\\/g, "/");
        artifacts.push({
            kind: classifyArtifactKind(relativePath),
            workspaceDir: params.workspaceDir,
            relativePath,
            absolutePath,
            agentIds: [...params.agentIds],
            contentType: "markdown",
        });
    }
    const eventLogPath = join(params.workspaceDir, MEMORY_HOST_EVENT_LOG_RELATIVE_PATH);
    const eventLogInfo = await stat(eventLogPath).catch(() => null);
    if (eventLogInfo?.isFile()) {
        artifacts.push({
            kind: "event-log",
            workspaceDir: params.workspaceDir,
            relativePath: MEMORY_HOST_EVENT_LOG_RELATIVE_PATH,
            absolutePath: eventLogPath,
            agentIds: [...params.agentIds],
            contentType: "json",
        });
    }
    return artifacts;
}
const VIRTUAL_MEMORY_PATH_PREFIX = "memory-lancedb-pro/";
function toVirtualMemoryPath(id) {
    return `${VIRTUAL_MEMORY_PATH_PREFIX}${id}.md`;
}
function fromVirtualMemoryPath(input) {
    const trimmed = input.trim();
    if (trimmed.startsWith(VIRTUAL_MEMORY_PATH_PREFIX) && trimmed.endsWith(".md")) {
        return trimmed.slice(VIRTUAL_MEMORY_PATH_PREFIX.length, -3);
    }
    return trimmed;
}
function splitLines(text) {
    return text.split(/\r?\n/);
}
function countLines(text) {
    return Math.max(1, splitLines(text).length);
}
function clampResultLimit(value) {
    return Math.max(1, Math.min(20, asPositiveInt(value) ?? 6));
}
function buildCitation(path, startLine, endLine) {
    return startLine === endLine ? `${path}#L${startLine}` : `${path}#L${startLine}-L${endLine}`;
}
function toGroundedResult(result) {
    const corpus = parseCanonicalCorpusMetadata(result.entry.metadata);
    if (corpus) {
        return {
            path: corpus.path,
            ...(corpus.workspaceDir ? { workspaceDir: corpus.workspaceDir } : {}),
            ...(corpus.agentId ? { agentId: corpus.agentId } : {}),
            startLine: corpus.startLine,
            endLine: corpus.endLine,
            score: result.score,
            vectorScore: result.sources?.vector?.score,
            textScore: result.sources?.bm25?.score,
            snippet: result.entry.text,
            source: corpus.source,
            citation: buildCitation(corpus.path, corpus.startLine, corpus.endLine),
        };
    }
    const path = toVirtualMemoryPath(result.entry.id);
    const endLine = countLines(result.entry.text);
    return {
        path,
        startLine: 1,
        endLine,
        score: result.score,
        vectorScore: result.sources?.vector?.score,
        textScore: result.sources?.bm25?.score,
        snippet: result.entry.text,
        source: "memory",
        citation: buildCitation(path, 1, endLine),
    };
}
function buildReadResult(entry, relPath, from, lines) {
    if (!entry)
        return { text: "", path: relPath };
    const fileLines = splitLines(entry.text);
    const start = Math.max(1, Math.floor(from ?? 1));
    const lineCount = Math.max(1, Math.floor(lines ?? fileLines.length));
    const selected = fileLines.slice(start - 1, start - 1 + lineCount);
    const moreRemain = start - 1 + lineCount < fileLines.length;
    return {
        text: selected.join("\n"),
        path: relPath,
        from: start,
        lines: selected.length,
        ...(moreRemain ? { truncated: true, nextFrom: start + selected.length } : {}),
    };
}
async function createMemoryLanceSearchManager(params, agentId) {
    const scopeFilter = params.resolveScopeFilterForAgent?.(agentId);
    let files;
    let chunks;
    let vectorAvailable;
    let vectorError;
    let embeddingProbe = null;
    const refreshStats = async () => {
        if (!params.store)
            return;
        const stats = await params.store.stats(scopeFilter);
        files = stats.totalCount;
        chunks = stats.totalCount;
    };
    await refreshStats().catch(() => undefined);
    return {
        async search(query, opts) {
            if (!params.retriever)
                return [];
            const trimmed = query.trim();
            if (!trimmed)
                return [];
            const requestedSources = opts?.sources?.length ? new Set(opts.sources) : null;
            if (params.canonicalCorpus?.enabled && params.canonicalCorpus.syncOnSearch) {
                await params.canonicalCorpusIndexer?.sync({ reason: "search" }).catch(() => undefined);
            }
            const results = await params.retriever.retrieve({
                query: trimmed,
                limit: requestedSources ? clampResultLimit(opts?.maxResults) * 3 : clampResultLimit(opts?.maxResults),
                scopeFilter,
                source: "manual",
            });
            const minScore = typeof opts?.minScore === "number" ? opts.minScore : undefined;
            await refreshStats().catch(() => undefined);
            return results
                .filter((result) => minScore === undefined || result.score >= minScore)
                .map(toGroundedResult)
                .filter((result) => !requestedSources || requestedSources.has(result.source))
                .slice(0, clampResultLimit(opts?.maxResults));
        },
        async readFile(readParams) {
            if (params.canonicalCorpus?.enabled) {
                const corpusRead = await params.canonicalCorpusIndexer?.readFile(readParams.relPath, readParams.from, readParams.lines, readParams.workspaceDir);
                if (corpusRead)
                    return corpusRead;
            }
            if (!params.store)
                return { text: "", path: readParams.relPath };
            const id = fromVirtualMemoryPath(readParams.relPath);
            const virtualPath = toVirtualMemoryPath(id);
            const entry = await params.store.getById(id, scopeFilter);
            return buildReadResult(entry, virtualPath, readParams.from, readParams.lines);
        },
        status() {
            const status = params.getRuntimeStatus();
            return {
                backend: "builtin",
                provider: "memory-lancedb-pro",
                requestedProvider: params.embeddingProvider,
                model: params.embeddingModel,
                files: files ?? status.files,
                chunks: chunks ?? status.chunks,
                dirty: false,
                workspaceDir: params.workspaceDir,
                dbPath: params.dbPath,
                sources: params.canonicalCorpus?.includeSessionTranscripts ? ["memory", "sessions"] : ["memory"],
                sourceCounts: [
                    {
                        source: "memory",
                        files: files ?? status.files ?? 0,
                        chunks: chunks ?? status.chunks ?? 0,
                    },
                ],
                fts: {
                    enabled: true,
                    available: status.retrievalAvailable,
                    ...(status.retrievalError ? { error: status.retrievalError } : {}),
                },
                vector: {
                    enabled: true,
                    available: vectorAvailable ?? status.retrievalAvailable,
                    storeAvailable: vectorAvailable ?? status.retrievalAvailable,
                    semanticAvailable: status.embeddingAvailable,
                    dims: params.vectorDim,
                    ...(vectorError ?? status.retrievalError ? { loadError: vectorError ?? status.retrievalError } : {}),
                },
                custom: {
                    plugin: "memory-lancedb-pro",
                    embeddingError: status.embeddingError,
                    retrievalError: status.retrievalError,
                    startupHealth: {
                        embedding: {
                            available: status.embeddingAvailable,
                            ...(status.embeddingError ? { error: status.embeddingError } : {}),
                        },
                        retrieval: {
                            available: status.retrievalAvailable,
                            ...(status.retrievalError ? { error: status.retrievalError } : {}),
                        },
                    },
                    virtualPathPrefix: VIRTUAL_MEMORY_PATH_PREFIX,
                    canonicalCorpus: {
                        enabled: params.canonicalCorpus?.enabled === true,
                        syncOnSearch: params.canonicalCorpus?.syncOnSearch === true,
                        includeSessionTranscripts: params.canonicalCorpus?.includeSessionTranscripts === true,
                        includeDreamingArtifacts: params.canonicalCorpus?.includeDreamingArtifacts === true,
                    },
                },
            };
        },
        getCachedEmbeddingAvailability() {
            if (embeddingProbe)
                return { ...embeddingProbe, cached: true };
            const status = params.getRuntimeStatus();
            return { ok: status.embeddingAvailable, ...(status.embeddingError ? { error: status.embeddingError } : {}), cached: true };
        },
        async probeEmbeddingAvailability() {
            embeddingProbe = await params.probeEmbeddingAvailability();
            return embeddingProbe;
        },
        async probeVectorStoreAvailability() {
            return await params.probeVectorAvailability();
        },
        async probeVectorAvailability() {
            try {
                vectorAvailable = await params.probeVectorAvailability();
                vectorError = undefined;
                await refreshStats().catch(() => undefined);
                return vectorAvailable;
            }
            catch (err) {
                vectorAvailable = false;
                vectorError = err instanceof Error ? err.message : String(err);
                return false;
            }
        },
        async sync(syncParams) {
            if (params.canonicalCorpus?.enabled) {
                await params.canonicalCorpusIndexer?.sync({
                    reason: syncParams?.reason ?? "runtime",
                    force: syncParams?.force,
                });
            }
            await refreshStats();
        },
        async close() { },
    };
}
export function buildMemoryLancePromptSection(params) {
    const hasRecall = params.availableTools.has("memory_recall") || params.availableTools.has("memory_search");
    const hasStore = params.availableTools.has("memory_store");
    if (!hasRecall && !hasStore)
        return [];
    const lines = ["## Memory Recall"];
    if (hasRecall) {
        lines.push("Before answering questions about prior work, decisions, dates, people, preferences, or todos, query memory-lancedb-pro and ground the answer in retrieved memories when confidence is high.");
    }
    if (hasStore) {
        lines.push("When the user gives durable preferences, decisions, facts, corrections, or reusable project context, store them with memory_store.");
    }
    if (params.citationsMode === "off") {
        lines.push("Citations are disabled: do not mention memory paths or line numbers unless the user explicitly asks.");
    }
    else {
        lines.push("When grounded file-backed memory results are available, include concise source references when they help verification.");
    }
    lines.push("");
    return lines;
}
export function buildMemoryLanceFlushPlan(params = {}) {
    const flushConfig = resolveMemoryFlushConfig(params.cfg);
    if (flushConfig?.enabled === false)
        return null;
    const nowMs = Number.isFinite(params.nowMs) ? params.nowMs : Date.now();
    const dateStamp = formatDateStamp(nowMs, resolveTimezone(params.cfg));
    const relativePath = `memory/${dateStamp}.md`;
    const prompt = buildMemoryFlushText(flushConfig?.prompt, [
        "Pre-compaction memory flush.",
        MEMORY_FLUSH_TARGET_HINT,
        MEMORY_FLUSH_READ_ONLY_HINT,
        MEMORY_FLUSH_APPEND_ONLY_HINT,
        "If there is nothing durable to store, reply with NO_REPLY.",
    ].join(" ")).replaceAll("YYYY-MM-DD", dateStamp);
    const systemPrompt = buildMemoryFlushText(flushConfig?.systemPrompt, [
        "Pre-compaction memory flush turn.",
        "Capture only durable memories before the session compacts.",
        MEMORY_FLUSH_TARGET_HINT,
        MEMORY_FLUSH_READ_ONLY_HINT,
        MEMORY_FLUSH_APPEND_ONLY_HINT,
        "Usually NO_REPLY is correct when no new durable memory exists.",
    ].join(" ")).replaceAll("YYYY-MM-DD", dateStamp);
    return {
        softThresholdTokens: asPositiveInt(flushConfig?.softThresholdTokens) ?? DEFAULT_FLUSH_SOFT_THRESHOLD_TOKENS,
        forceFlushTranscriptBytes: parseByteSize(flushConfig?.forceFlushTranscriptBytes) ?? DEFAULT_FLUSH_TRANSCRIPT_BYTES,
        reserveTokensFloor: asPositiveInt(isRecord(params.cfg?.agents) && isRecord(params.cfg.agents.defaults) && isRecord(params.cfg.agents.defaults.compaction)
            ? params.cfg.agents.defaults.compaction.reserveTokensFloor
            : undefined) ?? DEFAULT_FLUSH_RESERVE_TOKENS_FLOOR,
        model: asString(flushConfig?.model),
        prompt,
        systemPrompt,
        relativePath,
    };
}
export function createMemoryLancePublicArtifactsProvider() {
    return {
        async listArtifacts(params) {
            const artifacts = [];
            for (const workspace of collectConfiguredWorkspaces(params.cfg)) {
                artifacts.push(...await collectPublicArtifactsForWorkspace(workspace));
            }
            const seen = new Set();
            return artifacts
                .filter((artifact) => {
                const key = `${artifact.workspaceDir}\0${artifact.relativePath}\0${artifact.kind}`;
                if (seen.has(key))
                    return false;
                seen.add(key);
                return true;
            })
                .sort((left, right) => left.workspaceDir.localeCompare(right.workspaceDir) ||
                left.relativePath.localeCompare(right.relativePath) ||
                left.kind.localeCompare(right.kind));
        },
    };
}
export function createOpenClawMemoryCapability(params) {
    const managers = new Set();
    return {
        promptBuilder: buildMemoryLancePromptSection,
        flushPlanResolver: buildMemoryLanceFlushPlan,
        runtime: {
            async getMemorySearchManager(runtimeParams) {
                const manager = await createMemoryLanceSearchManager(params, runtimeParams.agentId ?? "main");
                managers.add(manager);
                return { manager };
            },
            resolveMemoryBackendConfig() {
                return { backend: "builtin" };
            },
            async closeAllMemorySearchManagers() {
                await Promise.all([...managers].map(async (manager) => {
                    await manager.close?.();
                }));
                managers.clear();
            },
        },
        publicArtifacts: createMemoryLancePublicArtifactsProvider(),
    };
}
