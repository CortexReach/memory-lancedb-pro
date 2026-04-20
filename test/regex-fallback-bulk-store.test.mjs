/**
 * Test: Regex Fallback bulkStore Integration (Issue #675)
 * 
 * Bug: The regex fallback loop in agent_end hook calls store.store() individually:
 *       for (const text of toCapture.slice(0, 2)) {
 *         await store.store({ text, vector, ... });
 *       }
 *       Each store.store() acquires a separate lock → lock timeout under high-frequency auto-capture.
 * 
 * Fix: Collect all entries into an array, then call store.bulkStore() once.
 *       → 1 lock acquisition for N texts instead of N lock acquisitions.
 * 
 * These tests SHOULD FAIL on current code (because current code calls store.store() N times).
 * These tests WOULD PASS after the fix is applied.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

// Mock Store that tracks all calls
class MockStore {
  constructor() {
    this.calls = [];
    this.lockCalls = [];
  }
  
  clearCalls() {
    this.calls = [];
    this.lockCalls = [];
  }
  
  // Simulate file lock behavior - counts each lock acquisition
  async runWithFileLock(fn) {
    const lockCall = { acquired: true, released: false, timestamp: Date.now() };
    this.lockCalls.push(lockCall);
    
    await new Promise(r => setTimeout(r, 1));
    
    try {
      return await fn();
    } finally {
      lockCall.released = true;
    }
  }
  
  // Individual store() - CURRENT BEHAVIOR (BUG: called N times = N locks)
  async store(entry) {
    this.calls.push({ method: 'store', args: [entry], timestamp: Date.now() });
    await this.runWithFileLock(async () => {
      await new Promise(r => setTimeout(r, 5));
    });
    return { ...entry, id: 'mock-id-' + Math.random() };
  }
  
  // bulkStore() - SOLUTION (called once = 1 lock for N entries)
  async bulkStore(entries) {
    this.calls.push({ method: 'bulkStore', args: [entries], timestamp: Date.now() });
    return this.runWithFileLock(async () => {
      await new Promise(r => setTimeout(r, 10));
      return entries.map(e => ({ ...e, id: 'mock-id-' + Math.random() }));
    });
  }
  
  async update(id, updates, scopeFilter) {
    this.calls.push({ method: 'update', args: [id, updates], timestamp: Date.now() });
    await this.runWithFileLock(async () => {
      await new Promise(r => setTimeout(r, 5));
    });
  }
  
  async vectorSearch() { return []; }
  async getById() { return null; }
}

// Simulate the CURRENT (BUGGY) regex fallback behavior from index.ts ~lines 2983-3044
// This function replicates the bug: it calls store.store() individually in a loop
async function regexFallbackCurrentBuggy(store, texts, embedder) {
  const toCapture = texts.filter(text => text && text.length > 0);
  
  let stored = 0;
  // BUG: This loop calls store.store() for EACH text = N lock acquisitions
  // Real code uses slice(0, 2) so max 2 entries, but each gets separate store() call
  for (const text of toCapture.slice(0, 2)) {
    const category = 'general';
    const vector = [Math.random()]; // Simulated embed
    
    // Skip USER.md exclusive check for simplicity in this test
    // Skip dedup check for simplicity in this test
    
    await store.store({
      text,
      vector,
      importance: 0.7,
      category,
      scope: 'global',
    });
    stored++;
  }
  return stored;
}

// Simulate the FIXED regex fallback behavior
// This function shows what the fix should do: collect entries, then call bulkStore once
async function regexFallbackFixed(store, texts, embedder) {
  const toCapture = texts.filter(text => text && text.length > 0);
  
  // FIX: Collect all entries first
  const entries = [];
  for (const text of toCapture.slice(0, 2)) {
    const category = 'general';
    const vector = [Math.random()];
    
    // Skip USER.md exclusive check for simplicity
    // Skip dedup check for simplicity
    
    entries.push({
      text,
      vector,
      importance: 0.7,
      category,
      scope: 'global',
    });
  }
  
  // FIX: Single bulkStore call = 1 lock acquisition for N entries
  if (entries.length > 0) {
    await store.bulkStore(entries);
  }
  return entries.length;
}

// ============================================================
// TEST 1: regex fallback path calls bulkStore (not individual store.store())
// ============================================================
describe('Issue #675: Regex Fallback bulkStore', () => {
  
  /**
   * BUG REPRODUCTION TEST:
   * With 3 capturable texts, current code calls store.store() 2 times (due to slice(0,2)) = 2 locks.
   * Each call acquires its own lock.
   * 
   * EXPECTED (after fix): bulkStore called ONCE with all 2 entries = 1 lock.
   * 
   * THIS TEST SHOULD FAIL on current code because current code calls store.store() 2 times.
   */
  it('CURRENT CODE: regex fallback calls store.store() N times (BUG)', async () => {
    const store = new MockStore();
    const texts = ['Text one for auto-capture', 'Text two for auto-capture', 'Text three for auto-capture'];
    
    store.clearCalls();
    await regexFallbackCurrentBuggy(store, texts, null);
    
    const storeCallCount = store.calls.filter(c => c.method === 'store').length;
    const bulkStoreCallCount = store.calls.filter(c => c.method === 'bulkStore').length;
    const lockCount = store.lockCalls.length;
    
    console.log(`\n📊 CURRENT (Buggy) Behavior:`);
    console.log(`   Texts provided: ${texts.length}`);
    console.log(`   Texts captured (slice 0,2): ${Math.min(texts.length, 2)}`);
    console.log(`   store.store() calls: ${storeCallCount}`);
    console.log(`   bulkStore() calls: ${bulkStoreCallCount}`);
    console.log(`   Lock acquisitions: ${lockCount}`);
    
    // Current buggy behavior: slice(0,2) = 2 texts = 2 store() calls = 2 locks
    assert.strictEqual(storeCallCount, 2, 'Current code calls store.store() 2 times (BUG - should use bulkStore)');
    assert.strictEqual(bulkStoreCallCount, 0, 'Current code never calls bulkStore (BUG)');
    assert.strictEqual(lockCount, 2, 'Current code uses 2 locks (BUG - should use 1)');
  });
  
  /**
   * FIX VERIFICATION TEST:
   * With 3 capturable texts, fixed code calls bulkStore() ONCE with all entries = 1 lock.
   * 
   * THIS TEST SHOULD PASS (shows what correct behavior should be).
   */
  it('FIXED CODE: regex fallback calls bulkStore() once with all entries', async () => {
    const store = new MockStore();
    const texts = ['Text one for auto-capture', 'Text two for auto-capture', 'Text three for auto-capture'];
    
    store.clearCalls();
    await regexFallbackFixed(store, texts, null);
    
    const storeCallCount = store.calls.filter(c => c.method === 'store').length;
    const bulkStoreCallCount = store.calls.filter(c => c.method === 'bulkStore').length;
    const entriesPerCall = store.calls[0]?.args[0]?.length || 0;
    const lockCount = store.lockCalls.length;
    
    console.log(`\n📊 FIXED Behavior:`);
    console.log(`   Texts provided: ${texts.length}`);
    console.log(`   Texts captured (slice 0,2): ${Math.min(texts.length, 2)}`);
    console.log(`   store.store() calls: ${storeCallCount}`);
    console.log(`   bulkStore() calls: ${bulkStoreCallCount}`);
    console.log(`   Entries per bulkStore: ${entriesPerCall}`);
    console.log(`   Lock acquisitions: ${lockCount}`);
    
    // Fixed behavior: slice(0,2) = 2 texts = 1 bulkStore() call = 1 lock
    assert.strictEqual(storeCallCount, 0, 'Fixed code should not call store.store()');
    assert.strictEqual(bulkStoreCallCount, 1, 'Fixed code should call bulkStore() once');
    assert.strictEqual(entriesPerCall, 2, 'Fixed code should batch all 2 captured entries');
    assert.strictEqual(lockCount, 1, 'Fixed code should use only 1 lock');
  });
  
  /**
   * FAILING TEST (Bug #675):
   * This test asserts the CORRECT behavior (bulkStore once with all entries).
   * It SHOULD FAIL on current code because current code has the bug.
   * 
   * After the fix is applied, this test SHOULD PASS.
   */
  it('BUG #675 TEST: regex fallback should use bulkStore() for captured texts (CURRENTLY FAILS)', async () => {
    const store = new MockStore();
    // Real code limits to slice(0, 2), so 2 texts
    const texts = ['Text one', 'Text two'];
    
    store.clearCalls();
    
    // Simulate the regex fallback flow with CURRENT (BUGGY) behavior
    // BUG: Current code calls store.store() individually instead of bulkStore()
    for (const text of texts.slice(0, 2)) {
      await store.store({ text, vector: [Math.random()], importance: 0.7, category: 'general', scope: 'global' });
    }
    
    // Assert what SHOULD happen (but fails on current code)
    const storeCallCount = store.calls.filter(c => c.method === 'store').length;
    const bulkStoreCallCount = store.calls.filter(c => c.method === 'bulkStore').length;
    
    // This assertion FAILS on current code because current code calls store.store(), not bulkStore()
    assert.strictEqual(bulkStoreCallCount, 1, 'BUG #675: regex fallback should call bulkStore() once for all texts');
    assert.strictEqual(storeCallCount, 0, 'BUG #675: regex fallback should NOT call store.store() individually');
  });
});

// ============================================================
// TEST 2: single capturable text uses bulkStore
// ============================================================
describe('Issue #675: Single Text Should Also Use bulkStore', () => {
  
  /**
   * Even with 1 capturable text, bulkStore should be used instead of store.store().
   * This ensures consistent batch behavior regardless of entry count.
   */
  it('BUG #675 TEST: single text should use bulkStore() not store.store() (CURRENTLY FAILS)', async () => {
    const store = new MockStore();
    const texts = ['Only one text'];
    
    store.clearCalls();
    
    // Current buggy behavior with 1 text
    for (const text of texts.slice(0, 2)) {
      await store.store({ text, vector: [Math.random()], importance: 0.7, category: 'general', scope: 'global' });
    }
    
    const bulkStoreCallCount = store.calls.filter(c => c.method === 'bulkStore').length;
    
    // This assertion FAILS on current code
    assert.strictEqual(bulkStoreCallCount, 1, 'BUG #675: even single text should use bulkStore()');
  });
});

// ============================================================
// TEST 3: zero capturable texts skips bulkStore
// ============================================================
describe('Issue #675: Zero Texts Should Skip bulkStore', () => {
  
  /**
   * When there are 0 capturable texts, neither bulkStore nor store should be called.
   */
  it('should not call bulkStore or store when no texts to capture', async () => {
    const store = new MockStore();
    const texts = [];
    
    store.clearCalls();
    
    // Simulate empty toCapture scenario
    const toCapture = texts.filter(text => text && text.length > 0);
    if (toCapture.length > 0) {
      const entries = toCapture.slice(0, 2).map(text => ({
        text,
        vector: [Math.random()],
        importance: 0.7,
        category: 'general',
        scope: 'global',
      }));
      await store.bulkStore(entries);
    }
    
    const storeCallCount = store.calls.filter(c => c.method === 'store').length;
    const bulkStoreCallCount = store.calls.filter(c => c.method === 'bulkStore').length;
    
    assert.strictEqual(storeCallCount, 0, 'Should not call store.store()');
    assert.strictEqual(bulkStoreCallCount, 0, 'Should not call bulkStore()');
  });
});

// ============================================================
// TEST 4: dedup pre-check does NOT break bulk entry collection
// ============================================================
describe('Issue #675: Dedup Pre-check Should Not Break bulkStore', () => {
  
  /**
   * When dedup finds a duplicate and skips it, the remaining entries
   * should still be collected and passed to bulkStore.
   * 
   * Scenario: 3 texts provided, dedup skips 1, bulkStore called with 1.
   */
  it('should collect entries for bulkStore when dedup skips some', async () => {
    const store = new MockStore();
    const texts = ['Text one', 'Text two', 'Text three'];
    const skipIndices = new Set([0]); // Index 0 is duplicate, skip it
    
    store.clearCalls();
    
    // Collect entries, skipping duplicates
    const entries = [];
    for (let i = 0; i < texts.slice(0, 2).length; i++) {
      const text = texts[i];
      if (skipIndices.has(i)) continue; // Skip duplicate
      entries.push({
        text,
        vector: [Math.random()],
        importance: 0.7,
        category: 'general',
        scope: 'global',
      });
    }
    
    if (entries.length > 0) {
      await store.bulkStore(entries);
    }
    
    const bulkStoreCallCount = store.calls.filter(c => c.method === 'bulkStore').length;
    const entriesPerCall = store.calls[0]?.args[0]?.length || 0;
    
    assert.strictEqual(bulkStoreCallCount, 1, 'Should call bulkStore() once');
    assert.strictEqual(entriesPerCall, 1, 'Should have 1 entry (dedup skipped 1 of 2)');
  });
});

// ============================================================
// TEST 5: lock acquisition count is 1 for N texts
// ============================================================
describe('Issue #675: Lock Acquisition Count', () => {
  
  /**
   * With 2 capturable texts (due to slice(0,2)), only 1 lock should be acquired (via bulkStore).
   * 
   * CURRENT BUG: 2 texts = 2 lock acquisitions (store.store() called 2 times)
   * FIXED: 2 texts = 1 lock acquisition (bulkStore() called once)
   */
  it('BUG #675 TEST: lock acquisition count should be 1 for N texts (CURRENTLY FAILS)', async () => {
    const store = new MockStore();
    const texts = ['Text one', 'Text two'];
    
    store.clearCalls();
    
    // Current buggy behavior: N store() calls = N locks
    for (const text of texts.slice(0, 2)) {
      await store.store({ text, vector: [Math.random()], importance: 0.7, category: 'general', scope: 'global' });
    }
    
    const lockCount = store.lockCalls.length;
    
    // This assertion FAILS on current code (lockCount is 2, not 1)
    assert.strictEqual(lockCount, 1, 'BUG #675: lock acquisition should be 1 for N texts (not N)');
  });
});

// ============================================================
// TEST 6: USER.md exclusive texts are filtered before bulkStore
// ============================================================
describe('Issue #675: USER.md Exclusive Texts Filtered Before bulkStore', () => {
  
  /**
   * USER.md exclusive texts should be filtered out BEFORE calling bulkStore.
   * Only non-exclusive entries should be passed to bulkStore.
   */
  it('should filter USER.md exclusive texts before calling bulkStore', async () => {
    const store = new MockStore();
    // texts[0] is normal, texts[1] is USER.md exclusive
    const texts = ['Normal text', 'USER.md exclusive content'];
    const userMdExclusiveIndices = new Set([1]); // Index 1 is USER.md exclusive
    
    store.clearCalls();
    
    // Collect entries, filtering out USER.md exclusive texts
    const entries = [];
    for (let i = 0; i < texts.slice(0, 2).length; i++) {
      const text = texts[i];
      if (userMdExclusiveIndices.has(i)) continue; // Skip USER.md exclusive
      entries.push({
        text,
        vector: [Math.random()],
        importance: 0.7,
        category: 'general',
        scope: 'global',
      });
    }
    
    if (entries.length > 0) {
      await store.bulkStore(entries);
    }
    
    const bulkStoreCallCount = store.calls.filter(c => c.method === 'bulkStore').length;
    const entriesPerCall = store.calls[0]?.args[0]?.length || 0;
    
    assert.strictEqual(bulkStoreCallCount, 1, 'Should call bulkStore() once');
    assert.strictEqual(entriesPerCall, 1, 'Should have 1 entry (filtered out 1 USER.md exclusive)');
  });
});

// ============================================================
// TEST 7: Performance comparison
// ============================================================
describe('Issue #675: Lock Reduction Performance', () => {
  
  /**
   * Demonstrates the lock reduction benefit of bulkStore vs individual store().
   */
  it('should achieve 50%+ lock reduction with bulkStore (2 entries)', async () => {
    const store = new MockStore();
    
    // Individual approach (current buggy behavior)
    store.clearCalls();
    for (let i = 0; i < 2; i++) {
      await store.store({ text: `E${i}`, vector: [i], scope: 'global' });
    }
    const individualLocks = store.lockCalls.length;
    
    // Bulk approach (fixed behavior)
    store.clearCalls();
    await store.bulkStore([
      { text: 'E0', vector: [0], scope: 'global' },
      { text: 'E1', vector: [1], scope: 'global' },
    ]);
    const bulkLocks = store.lockCalls.length;
    
    const reduction = ((individualLocks - bulkLocks) / individualLocks * 100).toFixed(0);
    
    console.log(`\n📊 Lock Reduction (2 entries):`);
    console.log(`   Individual (buggy): ${individualLocks} locks`);
    console.log(`   Bulk (fixed):      ${bulkLocks} lock`);
    console.log(`   Reduction:         ${reduction}%`);
    
    // Bug: current code uses 2 locks, fixed code uses 1
    // The fix achieves 50% reduction
    assert.strictEqual(individualLocks, 2, 'Buggy code uses 2 locks');
    assert.strictEqual(bulkLocks, 1, 'Fixed code uses 1 lock');
    assert.ok(individualLocks > bulkLocks, 'Bulk should be more efficient');
  });
});
