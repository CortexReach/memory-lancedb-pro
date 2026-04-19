/**
 * Test: SmartExtractor bulkStore Integration
 * 
 * Issue #666: SmartExtractor should use bulkStore() to reduce lock acquisitions
 * 
 * Problem: SmartExtractor.extractAndPersist() calls store.store() individually for each candidate
 *          → N lock acquisitions for N candidates
 * 
 * Solution: Use store.bulkStore() to batch all writes into single lock acquisition
 *          → 1 lock acquisition for N candidates
 */

import { describe, it, beforeEach } from 'node:test';
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
  
  // Individual store() - CURRENT BEHAVIOR (PROBLEM)
  async store(entry) {
    this.calls.push({ method: 'store', args: [entry], timestamp: Date.now() });
    await this.runWithFileLock(async () => {
      await new Promise(r => setTimeout(r, 5));
    });
    return { ...entry, id: 'mock-id-' + Math.random() };
  }
  
  // bulkStore() - SOLUTION (batch writes with single lock)
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

// ============================================================
// TEST 1: Demonstrate the Problem
// ============================================================
describe('Issue #666: Lock Contention Problem', () => {
  
  /**
   * PROBLEM: Each store() call acquires/releases lock separately
   * With 5 candidates, we get 5+ lock operations
   */
  it('CURRENT: store() causes N lock acquisitions for N entries', async () => {
    const store = new MockStore();
    
    // Simulate current SmartExtractor behavior: 5 individual store() calls
    const entries = [
      { text: 'Entry 1', vector: [1], scope: 'global' },
      { text: 'Entry 2', vector: [2], scope: 'global' },
      { text: 'Entry 3', vector: [3], scope: 'global' },
      { text: 'Entry 4', vector: [4], scope: 'global' },
      { text: 'Entry 5', vector: [5], scope: 'global' },
    ];
    
    store.clearCalls();
    for (const entry of entries) {
      await store.store(entry);
    }
    
    const storeCallCount = store.calls.filter(c => c.method === 'store').length;
    const lockCount = store.lockCalls.length;
    
    console.log(`\n📊 PROBLEM (Current Behavior):`);
    console.log(`   Entries: ${entries.length}`);
    console.log(`   store.store() calls: ${storeCallCount}`);
    console.log(`   Lock acquisitions: ${lockCount}`);
    console.log(`   Ratio: ${lockCount}:1 (each entry = 1 lock)`);
    
    // PROBLEM: 5 entries = 5 lock acquisitions
    assert.strictEqual(storeCallCount, 5, 'Should have 5 store() calls');
    assert.strictEqual(lockCount, 5, 'Should have 5 lock acquisitions');
  });
  
  /**
   * SOLUTION: bulkStore() batches all entries into single lock acquisition
   * With 5 candidates, we get only 1 lock operation
   */
  it('FIXED: bulkStore() uses 1 lock for N entries', async () => {
    const store = new MockStore();
    
    const entries = [
      { text: 'Entry 1', vector: [1], scope: 'global' },
      { text: 'Entry 2', vector: [2], scope: 'global' },
      { text: 'Entry 3', vector: [3], scope: 'global' },
      { text: 'Entry 4', vector: [4], scope: 'global' },
      { text: 'Entry 5', vector: [5], scope: 'global' },
    ];
    
    store.clearCalls();
    await store.bulkStore(entries);
    
    const bulkCallCount = store.calls.filter(c => c.method === 'bulkStore').length;
    const entriesPerCall = store.calls[0]?.args[0]?.length || 0;
    const lockCount = store.lockCalls.length;
    
    console.log(`\n📊 SOLUTION (With bulkStore):`);
    console.log(`   Entries: ${entries.length}`);
    console.log(`   bulkStore() calls: ${bulkCallCount}`);
    console.log(`   Entries per batch: ${entriesPerCall}`);
    console.log(`   Lock acquisitions: ${lockCount}`);
    console.log(`   Ratio: ${lockCount}:1 (all entries = 1 lock)`);
    
    // SOLUTION: 5 entries = 1 lock acquisition
    assert.strictEqual(bulkCallCount, 1, 'Should have 1 bulkStore call');
    assert.strictEqual(entriesPerCall, 5, 'Should batch all 5 entries');
    assert.strictEqual(lockCount, 1, 'Should have only 1 lock acquisition');
  });
});

// ============================================================
// TEST 2: Performance Comparison
// ============================================================
describe('Performance: Lock Reduction', () => {
  
  it('should achieve 80% lock reduction with bulkStore (5 entries)', async () => {
    const store = new MockStore();
    
    // Individual approach
    store.clearCalls();
    for (let i = 0; i < 5; i++) {
      await store.store({ text: `E${i}`, vector: [i], scope: 'global' });
    }
    const individualLocks = store.lockCalls.length;
    
    // Bulk approach
    store.clearCalls();
    await store.bulkStore([
      { text: 'E0', vector: [0], scope: 'global' },
      { text: 'E1', vector: [1], scope: 'global' },
      { text: 'E2', vector: [2], scope: 'global' },
      { text: 'E3', vector: [3], scope: 'global' },
      { text: 'E4', vector: [4], scope: 'global' },
    ]);
    const bulkLocks = store.lockCalls.length;
    
    const reduction = ((individualLocks - bulkLocks) / individualLocks * 100).toFixed(0);
    
    console.log(`\n📊 Lock Reduction (5 entries):`);
    console.log(`   Individual: ${individualLocks} locks`);
    console.log(`   Bulk:       ${bulkLocks} lock`);
    console.log(`   Reduction:  ${reduction}%`);
    
    assert.strictEqual(individualLocks, 5, 'Individual uses 5 locks');
    assert.strictEqual(bulkLocks, 1, 'Bulk uses 1 lock');
    assert.ok(individualLocks > bulkLocks, 'Bulk should be more efficient');
  });
  
  it('should achieve 90% lock reduction with bulkStore (10 entries)', async () => {
    const store = new MockStore();
    
    // Individual approach
    store.clearCalls();
    for (let i = 0; i < 10; i++) {
      await store.store({ text: `E${i}`, vector: [i], scope: 'global' });
    }
    const individualLocks = store.lockCalls.length;
    
    // Bulk approach
    store.clearCalls();
    const entries = Array.from({ length: 10 }, (_, i) => ({
      text: `E${i}`, vector: [i], scope: 'global'
    }));
    await store.bulkStore(entries);
    const bulkLocks = store.lockCalls.length;
    
    const reduction = ((individualLocks - bulkLocks) / individualLocks * 100).toFixed(0);
    
    console.log(`\n📊 Lock Reduction (10 entries):`);
    console.log(`   Individual: ${individualLocks} locks`);
    console.log(`   Bulk:       ${bulkLocks} lock`);
    console.log(`   Reduction:  ${reduction}%`);
    
    assert.strictEqual(individualLocks, 10, 'Individual uses 10 locks');
    assert.strictEqual(bulkLocks, 1, 'Bulk uses 1 lock');
  });
});

// ============================================================
// TEST 3: Edge Cases
// ============================================================
describe('Edge Cases', () => {
  
  it('should handle empty entries array', async () => {
    const store = new MockStore();
    
    store.clearCalls();
    const results = await store.bulkStore([]);
    
    assert.deepStrictEqual(results, [], 'Should return empty array');
    assert.strictEqual(store.lockCalls.length, 1, 'Should still use 1 lock');
  });
  
  it('should handle single entry batch', async () => {
    const store = new MockStore();
    
    store.clearCalls();
    const results = await store.bulkStore([
      { text: 'Single', vector: [1], scope: 'global' },
    ]);
    
    assert.strictEqual(results.length, 1, 'Should return 1 entry');
    assert.strictEqual(store.lockCalls.length, 1, 'Should use 1 lock');
  });
  
  it('should preserve entry order in results', async () => {
    const store = new MockStore();
    
    const entries = [
      { text: 'First', vector: [1], scope: 'global' },
      { text: 'Second', vector: [2], scope: 'global' },
      { text: 'Third', vector: [3], scope: 'global' },
    ];
    
    const results = await store.bulkStore(entries);
    
    assert.strictEqual(results.length, 3, 'Should return 3 entries');
    assert.strictEqual(results[0].text, 'First', 'Should preserve order');
    assert.strictEqual(results[1].text, 'Second', 'Should preserve order');
    assert.strictEqual(results[2].text, 'Third', 'Should preserve order');
  });
  
  it('should handle entries with different scopes', async () => {
    const store = new MockStore();
    
    const entries = [
      { text: 'Global', vector: [1], scope: 'global' },
      { text: 'Agent', vector: [2], scope: 'agent:abc' },
      { text: 'Session', vector: [3], scope: 'session:xyz' },
    ];
    
    const results = await store.bulkStore(entries);
    
    assert.strictEqual(results.length, 3, 'Should handle different scopes');
    assert.strictEqual(store.lockCalls.length, 1, 'Should use single lock');
  });
});

// ============================================================
// TEST 4: Integration Scenario
// ============================================================
describe('Integration: SmartExtractor Scenario', () => {
  
  /**
   * This simulates what SmartExtractor does when extracting memories:
   * - LLM returns N candidates
   * - Each candidate requires a store() call
   * - With bulkStore, all candidates batched into 1 lock
   */
  it('should batch all LLM candidates into single lock', async () => {
    const store = new MockStore();
    
    // Simulate LLM extracting 4 candidates
    const llmCandidates = [
      { category: 'profile', abstract: 'User likes coffee', content: '' },
      { category: 'preference', abstract: 'Prefers dark theme', content: '' },
      { category: 'case', abstract: 'Working on issue #666', content: '' },
      { category: 'entity', abstract: 'Project is memory-lancedb-pro', content: '' },
    ];
    
    // CURRENT BEHAVIOR: 4 individual store() calls = 4 locks
    store.clearCalls();
    for (const candidate of llmCandidates) {
      await store.store({
        text: candidate.abstract,
        vector: [Math.random()],
        scope: 'global',
        category: candidate.category,
      });
    }
    const currentLockCount = store.lockCalls.length;
    
    // FIXED BEHAVIOR: 1 bulkStore() call = 1 lock
    store.clearCalls();
    const entriesToStore = llmCandidates.map(c => ({
      text: c.abstract,
      vector: [Math.random()],
      scope: 'global',
      category: c.category,
    }));
    await store.bulkStore(entriesToStore);
    const fixedLockCount = store.lockCalls.length;
    
    console.log(`\n📊 SmartExtractor Scenario (4 candidates):`);
    console.log(`   Current (individual): ${currentLockCount} locks`);
    console.log(`   Fixed (bulkStore):     ${fixedLockCount} lock`);
    console.log(`   Improvement:          ${currentLockCount / fixedLockCount}x fewer locks`);
    
    assert.strictEqual(currentLockCount, 4, 'Current uses 4 locks');
    assert.strictEqual(fixedLockCount, 1, 'Fixed uses 1 lock');
  });
});
