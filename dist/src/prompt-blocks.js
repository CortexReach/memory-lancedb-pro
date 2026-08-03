/**
 * Shared static prompt content, single-sourced here and composed into every
 * prompt builder that needs it: extraction, admission (standalone + batch),
 * dedup decider (standalone + batch), merge writer (standalone + batch),
 * consolidate decider, and consolidate merge writer. Copied prompt text
 * between builders is a defect -- converge it here instead. Topology-
 * specific wording (singular/plural framing, output contracts, batch-only
 * guidance) stays local to each builder by design.
 */
/** One-paragraph six-category definition, shared by every prompt that scores or classifies a candidate but doesn't already carry the full extraction classification. */
export const CATEGORY_TAXONOMY = "The memory system stores six categories: profile (user identity), preferences (user tendencies), entities (long-lived project/entity state), events (things that happened), cases (problem + solution pairs), and patterns (reusable procedures).";
/**
 * Higher/moderate/lower scoring guidance, one wording shared by both
 * admission prompt variants (standalone and batch).
 */
export const SCORE_TIER_RUBRIC = `Use higher scores for durable profile facts, preferences, entity state, patterns, and genuinely reusable cases.
Use moderate scores for events worth an episodic record.
Use lower scores for one-off chatter, low-signal situational remarks, thin restatements, and low-value transient details.`;
export const ADMISSION_JUDGE_IDENTITY = "You are a memory admission judge.";
export const EXTRACTION_AGENT_IDENTITY = "You are a memory extraction agent.";
export const DEDUP_JUDGE_IDENTITY = "You are a memory dedup judge. Decide how each candidate memory relates to the existing memories: new, duplicate, or an update.";
export const MERGE_WRITER_IDENTITY = "You are a memory merge writer. Combine each candidate with its existing memory into one improved record.";
export const CONSOLIDATE_DECIDER_IDENTITY = "You are a memory consolidation decider.";
export const CONSOLIDATE_MERGE_WRITER_IDENTITY = "You are a memory consolidation merge writer.";
/**
 * Renders a raw JSON example/contract exactly as the model must emit it:
 * bare, unfenced. Prompts that showed fenced examples got fenced completions
 * back from fence-mimicking models while the surrounding text demanded "no
 * markdown code fences" (live catch: the reflection lane's judge, 2026-07-18).
 */
export function jsonShape(json) {
    return json;
}
/**
 * Formats one labelled field as a plain markdown line: `Label: value`, with
 * any leading markdown list-marker run (`- ` / `* `, repeated) stripped from
 * every line while the line's own inner indentation is kept. Continuation
 * lines are flush-left (never indented) because fields now sit directly
 * under a `###`/`####` heading rather than inside a numbered list item --
 * 4+ leading spaces there would read as a markdown code block. Other
 * content markdown (e.g. `##` headings inside a stored overview) is
 * deliberately left as-is.
 */
function formatFieldLines(label, value) {
    const valueLines = String(value ?? "")
        .split("\n")
        .map((line) => line.replace(/^(\s*)(?:[-*] )+/, "$1"));
    return [`${label}: ${valueLines[0]}`, ...valueLines.slice(1)];
}
/** Formats a candidate/existing memory's abstract/overview/content as plain `Label: value` lines (no heading). */
export function formatMemoryFieldLines(memory) {
    return [
        ...formatFieldLines("Abstract", memory.abstract),
        ...formatFieldLines("Overview", memory.overview),
        ...formatFieldLines("Content", memory.content),
    ];
}
/**
 * Formats one candidate as a markdown subsection: `### N. category` heading
 * followed by its Abstract/Overview/Content fields as plain lines. Every
 * prompt path that renders candidate memories (admission standalone,
 * admission batch and its few-shot example, batched dedup) must emit
 * candidate blocks through this one function so the shapes can never drift
 * apart.
 */
export function formatCandidateBlock(n, candidate) {
    return [`### ${n}. ${candidate.category}`, ...formatMemoryFieldLines(candidate)].join("\n");
}
/** One line of the "Existing similar memories" nested list: `N. [category] abstract (score X.XXX)`. */
export function formatExistingMemoryEntry(n, category, abstract, score) {
    return `${n}. [${category}] ${abstract} (score ${score.toFixed(3)})`;
}
/** Renders the `#### Existing similar memories` nested subsection under a candidate block. Returns "" when there are no entries. */
export function formatExistingMemoriesSection(entries) {
    if (entries.length === 0)
        return "";
    return ["#### Existing similar memories", ...entries].join("\n");
}
