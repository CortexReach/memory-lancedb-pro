/**
 * Tool Outcome Summarizer — Agent Experience Enrichment
 *
 * Scans conversation texts for tool call patterns and extracts structured
 * summaries of tool invocations with their outcomes (success/failure).
 * This enriched context improves cases/patterns extraction quality.
 */

// ============================================================================
// Types
// ============================================================================

interface ToolOutcome {
  name: string;
  input: string;   // truncated
  success: boolean;
  result: string;   // truncated
}

// ============================================================================
// Pattern matchers
// ============================================================================

// Patterns indicating failure
const FAILURE_PATTERNS = [
  /\bfail(?:ed|ure)?\b/i,
  /\berror\b/i,
  /\bexception\b/i,
  /\btimeout\b/i,
  /\bcrash(?:ed)?\b/i,
  /\bdenied\b/i,
  /\brejected\b/i,
];

// ============================================================================
// Core Logic
// ============================================================================

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "...";
}

function detectToolOutcomes(text: string): ToolOutcome[] {
  const outcomes: ToolOutcome[] = [];
  const seen = new Set<string>();

  // Pattern 1: "Tool: <name>" with Result/Error lines
  const toolPattern = /(?:^|\n)\s*Tool:\s*(\S+)([\s\S]*?)(?=(?:\n\s*Tool:|\n\n|$))/gi;
  let match: RegExpExecArray | null;

  while ((match = toolPattern.exec(text)) !== null) {
    const name = match[1].replace(/[:\s]+$/, "");
    const block = match[2] || "";
    const key = `${name}:${block.slice(0, 50)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const errorMatch = block.match(/Error:\s*(.*?)(?:\n|$)/i);
    const resultMatch = block.match(/Result:\s*(.*?)(?:\n|$)/i);
    const inputMatch = block.match(/(?:Input|Args|Arguments):\s*(.*?)(?:\n|$)/i);

    const success = !errorMatch;
    const result = errorMatch
      ? errorMatch[1].trim()
      : (resultMatch ? resultMatch[1].trim() : "");

    outcomes.push({
      name,
      input: truncate(inputMatch?.[1]?.trim() || "", 80),
      success,
      result: truncate(result, 100),
    });
  }

  // Pattern 2: "tool_call" JSON blocks
  const toolCallPattern = /tool_call[^{]*\{[^}]*"name"\s*:\s*"([^"]+)"[^}]*\}/gi;
  while ((match = toolCallPattern.exec(text)) !== null) {
    const name = match[1];
    if (seen.has(name)) continue;
    seen.add(name);

    // Look for nearby result/error
    const afterBlock = text.slice(match.index + match[0].length, match.index + match[0].length + 200);
    const hasError = FAILURE_PATTERNS.some(p => p.test(afterBlock));

    outcomes.push({
      name,
      input: "",
      success: !hasError,
      result: truncate(afterBlock.split("\n")[0]?.trim() || "", 100),
    });
  }

  return outcomes;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Scan texts for tool call patterns and produce a structured summary.
 * Returns empty string if no tool calls are detected.
 */
export function summarizeToolOutcomes(texts: string[]): string {
  const allOutcomes: ToolOutcome[] = [];

  for (const text of texts) {
    const outcomes = detectToolOutcomes(text);
    allOutcomes.push(...outcomes);
  }

  if (allOutcomes.length === 0) return "";

  // Deduplicate by tool name (keep first occurrence)
  const uniqueOutcomes: ToolOutcome[] = [];
  const namesSeen = new Set<string>();
  for (const outcome of allOutcomes) {
    if (!namesSeen.has(outcome.name)) {
      namesSeen.add(outcome.name);
      uniqueOutcomes.push(outcome);
    }
  }

  const lines = uniqueOutcomes.map((o) => {
    const status = o.success ? "SUCCESS" : "FAILED";
    const detail = o.result || "(no detail)";
    return `- [${o.name}]: ${status} — ${detail}`;
  });

  return `## Tool Outcomes\n${lines.join("\n")}`;
}
