import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { parseCanonicalCorpusMetadata } from "./corpus-indexer.js";
// Recover the original prefix represented by display text. Never turn an
// abstract or a neighbor into evidence for the canonical primary source.
function surfacedPrefix(raw, shown, format) {
    if (format === "auto" && /[<>]/.test(raw))
        return undefined;
    let rendered = "";
    const ends = [];
    const append = (text, end) => {
        rendered += text;
        for (let i = 0; i < text.length; i++)
            ends.push(end);
    };
    const parts = /\S+|\s+/g;
    for (const match of raw.matchAll(parts)) {
        const value = match[0];
        const offset = match.index;
        if (/^\s/.test(value)) {
            if (format === "auto" && /[\r\n]/.test(value)) {
                // Auto context escapes line breaks before collapsing other whitespace.
                const escaped = value.replace(/[\r\n]+/g, "\\n").replace(/\s+/g, " ");
                append(escaped, offset + value.length);
            }
            else if (rendered) {
                append(" ", offset + value.length);
            }
        }
        else {
            for (let i = 0; i < value.length; i++)
                append(value[i], offset + i + 1);
        }
    }
    const display = shown.trimEnd();
    if (!display || !rendered.startsWith(display))
        return undefined;
    // Do not count half of an escaped newline as a surfaced source character.
    if (display.endsWith("\\") && rendered[display.length] === "n")
        return undefined;
    return raw.slice(0, ends[display.length - 1]).trimEnd();
}
export function toNativeRecallResults(workspaceDir, surfaced) {
    return surfaced.flatMap(({ result, sourceText, text, format }) => {
        try {
            const entry = result.entry;
            const raw = JSON.parse(entry.metadata || "{}");
            const corpus = parseCanonicalCorpusMetadata(entry.metadata);
            if (!corpus || corpus.source !== "memory" || !corpus.workspaceDir ||
                resolve(corpus.workspaceDir) !== resolve(workspaceDir) ||
                !corpus.path || isAbsolute(corpus.path) || corpus.path.split(/[\\/]/).includes("..") ||
                !Number.isInteger(raw.corpus_start_line) || raw.corpus_start_line < 1 ||
                !Number.isInteger(raw.corpus_end_line) || raw.corpus_end_line < raw.corpus_start_line ||
                sourceText !== entry.text || raw.corpus_snippet !== entry.text ||
                !corpus.contentSha256 || createHash("sha256").update(entry.text).digest("hex") !== corpus.contentSha256 ||
                !Number.isFinite(result.score))
                return [];
            if (corpus.absolutePath && resolve(corpus.absolutePath) !== resolve(workspaceDir, corpus.path))
                return [];
            const snippet = surfacedPrefix(entry.text, text, format);
            if (!snippet)
                return [];
            const endLine = corpus.startLine + snippet.split("\n").length - 1;
            if (endLine > corpus.endLine)
                return [];
            return [{
                    path: corpus.path,
                    startLine: corpus.startLine,
                    endLine,
                    score: result.score,
                    snippet,
                    source: "memory",
                }];
        }
        catch {
            return [];
        }
    });
}
/** Optional public host API; older hosts retain normal recall behavior. */
export async function recordSurfacedRecall(api, invocation, query, surfaced, timeoutMs) {
    const { workspaceDir, sessionKey, runId, assertActive } = invocation;
    if (!api.config || !workspaceDir || !sessionKey || !runId || !assertActive || !query.trim())
        return;
    const results = toNativeRecallResults(workspaceDir, surfaced);
    if (!results.length || (timeoutMs !== undefined && timeoutMs <= 0))
        return;
    let active = true;
    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    const assertRecordingActive = () => {
        if (!active || (deadline !== undefined && Date.now() >= deadline))
            throw new Error("Recall recording expired");
        assertActive();
    };
    const record = async () => {
        try {
            assertRecordingActive();
            const sdk = await import("openclaw/plugin-sdk/memory-recall");
            if (typeof sdk.recordMemoryRecall !== "function")
                return;
            assertRecordingActive();
            await sdk.recordMemoryRecall({ config: api.config, workspaceDir, sessionKey, runId, assertActive: assertRecordingActive, query, results });
        }
        catch {
            // Missing API, expired invocation or unavailable native store must never
            // fail retrieval. Native eligibility, grounding and dedup belong to core.
            api.logger.debug?.("memory-lancedb-pro: native recall recording unavailable; recall unchanged");
        }
    };
    let timer;
    try {
        if (timeoutMs === undefined)
            await record();
        else
            await Promise.race([record(), new Promise((resolve) => {
                    timer = setTimeout(resolve, timeoutMs);
                })]);
    }
    finally {
        // A timed-out optional write must not delay or discard an already selected
        // injection. Retained callbacks cannot admit new writes after we return.
        active = false;
        clearTimeout(timer);
    }
}
