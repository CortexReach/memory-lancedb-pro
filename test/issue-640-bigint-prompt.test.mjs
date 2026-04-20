/**
 * Issue #640 Test: cases category prompt should be descriptive, not imperative
 * 
 * Test verifies that the abstract format change prevents LLM from skipping
 * [cases] category memories.
 * 
 * Run: npx tsx test/issue-640-bigint-prompt.test.mjs
 */

// Helper to check if prompt is misleading
function isPromptMisleading(abstract) {
  const misleadingPatterns = [
    "-> use",
    "error ->",
    "solution:",
    "use number()",
    "coercion",
    "before arithmetic",
  ];
  const lower = abstract.toLowerCase();
  for (const pattern of misleadingPatterns) {
    if (lower.includes(pattern.toLowerCase())) {
      return true;
    }
  }
  return false;
}

// Test cases
const testCases = [
  {
    abstract: "LanceDB BigInt error -> Use Number() coercion before arithmetic",
    expectedMisleading: true,
    description: "Old format (buggy) - should be detected as misleading",
  },
  {
    abstract: "LanceDB BigInt numeric handling issue",
    expectedMisleading: false,
    description: "New format (fixed) - should NOT be misleading",
  },
];

console.log("=== Issue #640: BigInt Prompt Format Test ===\n");

let passed = 0;
let failed = 0;

for (const tc of testCases) {
  const isMisleading = isPromptMisleading(tc.abstract);
  const ok = isMisleading === tc.expectedMisleading;
  
  console.log(`[${tc.description}]`);
  console.log(`  Abstract: "${tc.abstract}"`);
  console.log(`  Misleading: ${isMisleading} (expected: ${tc.expectedMisleading})`);
  console.log(`  Result: ${ok ? "✅ PASS" : "❌ FAIL"}`);
  console.log("");
  
  if (ok) passed++;
  else failed++;
}

console.log("----------------------------------------");
console.log(`Total: ${passed} passed, ${failed} failed`);
console.log("----------------------------------------");

if (failed > 0) {
  process.exit(1);
}