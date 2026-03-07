/**
 * Dedup Detection Tests
 * Issue: https://github.com/win4r/memory-lancedb-pro/issues/30
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";

const jitiFactory = (await import("jiti")).default;
const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore, DEFAULT_DEDUP_CONFIG } = jiti("../src/store.ts");

// ============================================================================
// Mock Embedding Generator
// ============================================================================

const VECTOR_DIM = 1024;

/**
 * Simple mock embedding that creates deterministic vectors based on text content.
 * Similar text produces similar vectors.
 */
function mockEmbedding(text) {
  // Create a deterministic vector based on text content
  const vector = new Array(VECTOR_DIM).fill(0);

  // Hash the text to get reproducible values
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash = hash & hash; // Convert to 32-bit integer
  }

  // Fill vector with values based on hash
  for (let i = 0; i < VECTOR_DIM; i++) {
    // Use hash + position to create reproducible values
    const val = Math.sin(hash * (i + 1) * 0.001);
    vector[i] = val;
  }

  // Normalize the vector
  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  return vector.map(v => v / magnitude);
}

/**
 * Create a similar embedding to the original with controlled similarity.
 * Higher similarity = more similar vectors.
 */
function similarEmbedding(original, similarity) {
  // Add noise inversely proportional to similarity
  const noiseScale = 1 - similarity;
  const noisy = original.map(v => {
    const noise = (Math.random() - 0.5) * 2 * noiseScale;
    return v + noise;
  });

  // Normalize
  const magnitude = Math.sqrt(noisy.reduce((sum, v) => sum + v * v, 0));
  return noisy.map(v => v / magnitude);
}

// ============================================================================
// Test Helpers
// ============================================================================

function createTestStore(dedupConfig = {}) {
  const testDir = join(tmpdir(), `dedup-test-${randomUUID()}`);
  mkdirSync(testDir, { recursive: true });

  return new MemoryStore({
    dbPath: testDir,
    vectorDim: VECTOR_DIM,
    dedup: { ...DEFAULT_DEDUP_CONFIG, ...dedupConfig },
  });
}

async function cleanup(store) {
  // Cleanup handled by store if available
}

// ============================================================================
// Tests
// ============================================================================

async function test_identical_text_detected_as_duplicate() {
  console.log("TEST: identical text detected as duplicate");
  const store = await createTestStore();

  const text = "OpenClaw supports Discord and Telegram channels";
  const vector = mockEmbedding(text);

  // Store first memory
  const r1 = await store.store({
    text,
    vector,
    scope: "test",
  });
  assert.strictEqual(r1.status, "stored", "First store should succeed");
  assert.ok(r1.id, "First store should return id");

  // Attempt to store identical text with identical vector
  const r2 = await store.store({
    text,
    vector,
    scope: "test",
  });
  assert.strictEqual(r2.status, "skipped", "Second store should be skipped");
  assert.strictEqual(r2.reason, "duplicate", "Reason should be duplicate");
  assert.ok(r2.similarity >= 0.99, `Similarity should be >= 0.99, got ${r2.similarity}`);
  assert.ok(r2.similarTo, "Should have similarTo info");
  assert.strictEqual(r2.similarTo.scope, "test", "Should show matching scope");

  console.log("  ✅ PASS");
  await cleanup(store);
}

async function test_similar_text_detected() {
  console.log("TEST: similar text (>92%) detected");
  const store = await createTestStore();

  const text1 = "Redis is used for session caching in production";
  const vector1 = mockEmbedding(text1);

  await store.store({
    text: text1,
    vector: vector1,
    scope: "test",
  });

  // For similar text, use the same base vector with small perturbation
  // Real embeddings for similar text are very close, so simulate that
  const vector2 = vector1.map(v => v + (Math.random() - 0.5) * 0.01);
  // Re-normalize
  const mag = Math.sqrt(vector2.reduce((sum, v) => sum + v * v, 0));
  const normalizedV2 = vector2.map(v => v / mag);

  const r = await store.store({
    text: "Redis is used for caching sessions in production",
    vector: normalizedV2,
    scope: "test",
  });

  assert.strictEqual(r.status, "skipped", "Similar text should be skipped");
  assert.ok(r.similarity >= 0.92, `Similarity should be >= 0.92, got ${r.similarity}`);

  console.log("  ✅ PASS");
  await cleanup(store);
}

async function test_different_text_stored_normally() {
  console.log("TEST: different text stored normally");
  const store = await createTestStore();

  const text1 = "Python is a programming language";
  const text2 = "TypeScript adds static typing to JavaScript";
  const vector1 = mockEmbedding(text1);
  const vector2 = mockEmbedding(text2);

  await store.store({
    text: text1,
    vector: vector1,
    scope: "test",
  });

  const r = await store.store({
    text: text2,
    vector: vector2,
    scope: "test",
  });

  assert.strictEqual(r.status, "stored", "Different text should be stored");
  assert.strictEqual(r.reason, undefined, "Should not have reason");

  console.log("  ✅ PASS");
  await cleanup(store);
}

async function test_force_bypasses_dedup() {
  console.log("TEST: force:true bypasses dedup");
  const store = await createTestStore();

  const text = "Important config: API key is abc123";
  const vector = mockEmbedding(text);

  await store.store({
    text,
    vector,
    scope: "test",
  });

  const r = await store.store({
    text,
    vector,
    scope: "test",
    force: true,
  });

  assert.strictEqual(r.status, "stored", "Force should store duplicate");

  console.log("  ✅ PASS");
  await cleanup(store);
}

async function test_scope_isolation() {
  console.log("TEST: scope isolation - different scopes allow duplicates");
  const store = await createTestStore({ scopeMode: 'scope' });

  const text = "User prefers dark mode";
  const vector = mockEmbedding(text);

  await store.store({
    text,
    vector,
    scope: "user:alice",
  });

  const r = await store.store({
    text,
    vector,
    scope: "user:bob",
  });

  // Different scope = should be stored
  assert.strictEqual(r.status, "stored", "Different scope should allow duplicate");

  console.log("  ✅ PASS");
  await cleanup(store);
}

async function test_global_mode_cross_scope() {
  console.log("TEST: global mode - cross-scope dedup");
  const store = await createTestStore({ scopeMode: 'global' });

  const text = "Shared configuration value";
  const vector = mockEmbedding(text);

  await store.store({
    text,
    vector,
    scope: "project:x",
  });

  const r = await store.store({
    text,
    vector,
    scope: "project:y",
  });

  assert.strictEqual(r.status, "skipped", "Global mode should dedup across scopes");

  console.log("  ✅ PASS");
  await cleanup(store);
}

async function test_disabled_dedup() {
  console.log("TEST: dedup.enabled=false disables dedup");
  const store = await createTestStore({ enabled: false });

  const text = "Duplicate content test";
  const vector = mockEmbedding(text);

  await store.store({
    text,
    vector,
    scope: "test",
  });

  const r = await store.store({
    text,
    vector,
    scope: "test",
  });

  assert.strictEqual(r.status, "stored", "Disabled dedup should store all");

  console.log("  ✅ PASS");
  await cleanup(store);
}

// ============================================================================
// Runner
// ============================================================================

async function run() {
  console.log("\n=== Dedup Detection Tests ===\n");

  const tests = [
    test_identical_text_detected_as_duplicate,
    test_similar_text_detected,
    test_different_text_stored_normally,
    test_force_bypasses_dedup,
    test_scope_isolation,
    test_global_mode_cross_scope,
    test_disabled_dedup,
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      await test();
      passed++;
    } catch (err) {
      console.log(`  ❌ FAIL: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n=== Results: ${passed}/${tests.length} passed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

// Run tests
run().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
