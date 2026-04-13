/**
 * Smoke test for: skip before_prompt_build hooks for subagent sessions
 * Bug: sub-agent sessions cause gateway blocking — hooks without subagent skip
 *       run LanceDB I/O sequentially, blocking all other user sessions.
 *
 * Run: node test/issue598_smoke.mjs
 * Expected: all 3 hooks PASS
 */

import { readFileSync } from "fs";

const FILE = "C:\\Users\\admin\\.openclaw\\extensions\\memory-lancedb-pro\\index.ts";
const content = readFileSync(FILE, "utf-8");
const lines = content.split("\n");

// [hook_opens_line, guard_line, name]
const checks = [
  [2223, 2226, "auto-recall before_prompt_build"],
  [3084, 3087, "reflection-injector inheritance"],
  [3113, 3116, "reflection-injector derived"],
];

let pass = 0, fail = 0;
for (const [hookLine, guardLine, name] of checks) {
  const hookContent = (lines[hookLine - 1] || "").trim();
  const guardContent = (lines[guardLine - 1] || "").trim();
  if (hookContent.includes("before_prompt_build") && guardContent.includes(":subagent:")) {
    console.log(`PASS  ${name.padEnd(40)} hook@${hookLine}  guard@${guardLine}`);
    pass++;
  } else {
    console.log(`FAIL  ${name}`);
    console.log(`      hook@${hookLine}:  ${hookContent}`);
    console.log(`      guard@${guardLine}: ${guardContent}`);
    fail++;
  }
}

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail > 0) process.exit(1);
else console.log("ALL PASSED — subagent sessions skipped before async work");
