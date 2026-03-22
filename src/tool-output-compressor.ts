/**
 * Tool Output Compressor
 *
 * Pre-processes conversation text before LLM extraction to compress
 * tool output noise (git boilerplate, passing test logs, etc.).
 * Reduces LLM token costs and improves extraction quality.
 *
 * Design principles:
 * - Zero LLM overhead: pure regex/pattern matching
 * - Never modifies user dialog or AI reasoning
 * - Sits alongside stripEnvelopeMetadata() as a pre-extraction filter
 * - Inspired by RTK (github.com/rtk-ai/rtk) compression strategies
 */

// ============================================================================
// Tool output patterns
// ============================================================================

interface CompressionRule {
  /** Human-readable name for logging */
  name: string;
  /**
   * Match the tool output block. The regex is tested against the full block
   * including any command prefix (e.g., "$ git push\n...output...").
   */
  match: RegExp;
  /** Return compressed replacement. Receives the full matched block. */
  compress: (block: string) => string;
}

const RULES: CompressionRule[] = [
  // Git push/pull/fetch boilerplate → one-liner
  {
    name: "git-push-pull",
    match: /Enumerating objects:.*?(?:-> |Branch ')[^\n]*/s,
    compress: (block) => {
      const branch = block.match(/-> (\S+)/)?.[1]
        || block.match(/Branch '([^']+)'/)?.[1]
        || "";
      const failed = /error|rejected|fatal/i.test(block);
      return failed ? block : `[git: ok${branch ? " " + branch : ""}]`;
    },
  },

  // Test results: all-pass → one-liner, failures preserved
  {
    name: "test-summary",
    match: /(?:running \d+ tests?|test result:|Tests?:.*(?:pass|fail)|PASS|FAIL|✓|✕)/,
    compress: (block) => {
      if (/fail|error|FAIL|✕/i.test(block)) return block; // Keep failures
      const summary = block.match(
        /test result:.*|Tests?:\s*\d+.*|(\d+)\s*(?:pass(?:ed)?|✓)/im
      )?.[0];
      return summary ? `[test: ${summary.trim()}]` : block;
    },
  },
];

// Patterns that identify tool output blocks in conversation text.
// Claude Code / OpenClaw format: command on one line, output follows.
const TOOL_OUTPUT_BLOCK = /^(?:\$\s+|❯\s+|>\s+)(.+)\n([\s\S]*?)(?=\n(?:\$\s+|❯\s+|>\s+)|\n\n[A-Z]|\n##|\z)/gm;

// Base64 image data (screenshots, etc.)
const BASE64_BLOCK = /(?:data:image\/[^;]+;base64,)?[A-Za-z0-9+/]{500,}={0,2}/g;

// ============================================================================
// Main compressor
// ============================================================================

/**
 * Compress tool output noise in conversation text.
 * Call before sending text to the extraction LLM.
 *
 * @param text - Raw conversation text
 * @returns Compressed text with tool output noise reduced
 */
export function compressToolOutput(text: string): string {
  if (!text || text.length < 100) return text;

  let result = text;

  // 1. Replace base64 image data with placeholder
  result = result.replace(BASE64_BLOCK, (match) => {
    if (match.length < 500) return match; // Short strings might be legit
    return `[image: ~${Math.round(match.length / 1024)}KB base64]`;
  });

  // 2. Apply compression rules to tool output blocks
  result = result.replace(TOOL_OUTPUT_BLOCK, (fullMatch, command, output) => {
    const cmd = command.trim();
    for (const rule of RULES) {
      if (rule.match.test(output) || rule.match.test(cmd)) {
        const compressed = rule.compress(output);
        if (compressed !== output) {
          return `$ ${cmd}\n${compressed}`;
        }
      }
    }

    // 3. Truncate large unmatched outputs (>2000 chars)
    if (output.length > 2000) {
      const head = output.slice(0, 1000);
      const tail = output.slice(-300);
      return `$ ${cmd}\n${head}\n[...${output.length - 1300} chars truncated...]\n${tail}`;
    }

    return fullMatch;
  });

  // 4. Collapse multiple blank lines left by removals
  result = result.replace(/\n{4,}/g, "\n\n\n");

  return result;
}
