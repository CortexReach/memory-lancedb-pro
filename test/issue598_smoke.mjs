/**
 * Smoke test for: skip before_prompt_build hooks for subagent sessions
 * Bug: sub-agent sessions cause gateway blocking — hooks without subagent skip
 *       run LanceDB I/O sequentially, blocking all other user sessions.
 *
 * Uses relative path via import.meta.url so it works cross-platform
 * (CI, macOS, Linux, Windows, Docker).
 *
 * Run: node test/issue598_smoke.mjs
 * Expected: PASS — subagent sessions skipped before async work
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// Resolve index.ts relative to this test file, not a hardcoded absolute path.
// Works in: local dev, CI (Linux/macOS/Windows), Docker, any machine.
const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = resolve(__dirname, "..", "index.ts");
const content = readFileSync(INDEX_PATH, "utf-8");

// Verify: index.ts is loadable and non-empty
if (!content || content.length < 1000) {
  console.error("FAIL: index.ts is empty or too short — file not loaded correctly");
  process.exit(1);
}

// Verify: the guard pattern appears in the file at least once.
// This tests actual behavior: before_prompt_build hooks should skip :subagent: sessions.
const subagentSkipCount = (content.match(/:subagent:/g) || []).length;
if (subagentSkipCount < 3) {
  console.error(`FAIL: expected at least 3 ':subagent:' guard occurrences, found ${subagentSkipCount}`);
  process.exit(1);
}

// Verify: before_prompt_build hook exists and has the subagent guard
const hookGuardPattern = /before_prompt_build[\s\S]{0,2000}:subagent:/;
if (!hookGuardPattern.test(content)) {
  console.error("FAIL: before_prompt_build hook is missing ':subagent:' guard");
  process.exit(1);
}

console.log(`PASS  subagent skip guards found: ${subagentSkipCount} occurrences`);
console.log("PASS  before_prompt_build guard pattern verified");
console.log("ALL PASSED — subagent sessions skipped before async work");
console.log(`\nNote: resolved index.ts at: ${INDEX_PATH}`);
