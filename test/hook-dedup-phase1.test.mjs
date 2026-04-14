/**
 * Phase 1 Hook Event Deduplication — Unit Tests
 * Tests _dedupHookEvent() and hook guard placement.
 * Mirrors index.ts ~1644 (newest-100 pruning).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

function createDedupState() {
  const _hookEventDedup = new Set();

  function _dedupHookEvent(handlerName, event) {
    const sk = typeof event?.sessionKey === 'string' ? event.sessionKey : '?';
    const ts = event?.timestamp instanceof Date
      ? event.timestamp.getTime()
      : (typeof event?.timestamp === 'number' ? event.timestamp : Date.now());
    const key = `${handlerName}:${sk}:${ts}`;
    if (_hookEventDedup.has(key)) return true;
    _hookEventDedup.add(key);
    if (_hookEventDedup.size > 200) {
      const arr = Array.from(_hookEventDedup);
      const newest100 = arr.slice(-100);
      _hookEventDedup.clear();
      for (const k of newest100) _hookEventDedup.add(k);
    }
    return false;
  }

  return { _hookEventDedup, _dedupHookEvent };
}

describe('Phase 1: _dedupHookEvent core logic', () => {
  it('returns false for first occurrence', () => {
    const { _dedupHookEvent } = createDedupState();
    assert.strictEqual(_dedupHookEvent('bootstrap', { sessionKey: 'agent:main:test', timestamp: 1000 }), false);
  });

  it('returns true for same key second time', () => {
    const { _dedupHookEvent } = createDedupState();
    const event = { sessionKey: 'agent:main:test', timestamp: 1000 };
    assert.strictEqual(_dedupHookEvent('bootstrap', event), false);
    assert.strictEqual(_dedupHookEvent('bootstrap', event), true);
  });

  it('different sessionKey — same timestamp — both proceed', () => {
    const { _dedupHookEvent } = createDedupState();
    const ts = 1000;
    assert.strictEqual(_dedupHookEvent('bootstrap', { sessionKey: 'agent:main:s1', timestamp: ts }), false);
    assert.strictEqual(_dedupHookEvent('bootstrap', { sessionKey: 'agent:main:s2', timestamp: ts }), false);
  });

  it('same sessionKey — different timestamp — both proceed', () => {
    const { _dedupHookEvent } = createDedupState();
    const sk = 'agent:main:test';
    assert.strictEqual(_dedupHookEvent('bootstrap', { sessionKey: sk, timestamp: 1000 }), false);
    assert.strictEqual(_dedupHookEvent('bootstrap', { sessionKey: sk, timestamp: 2000 }), false);
  });

  it('different handlerName — same sessionKey+timestamp — both proceed', () => {
    const { _dedupHookEvent } = createDedupState();
    const sk = 'agent:main:test';
    const ts = 1000;
    assert.strictEqual(_dedupHookEvent('bootstrap', { sessionKey: sk, timestamp: ts }), false);
    assert.strictEqual(_dedupHookEvent('selfImprovement', { sessionKey: sk, timestamp: ts }), false);
  });

  it('missing sessionKey uses "?" fallback', () => {
    const { _dedupHookEvent } = createDedupState();
    assert.strictEqual(_dedupHookEvent('bootstrap', { timestamp: 1000 }), false);
    assert.strictEqual(_dedupHookEvent('bootstrap', { timestamp: 1000 }), true);
  });

  it('non-string sessionKey uses "?" fallback', () => {
    const { _dedupHookEvent } = createDedupState();
    assert.strictEqual(_dedupHookEvent('bootstrap', { sessionKey: 123, timestamp: 1000 }), false);
    assert.strictEqual(_dedupHookEvent('bootstrap', { sessionKey: 123, timestamp: 1000 }), true);
  });

  it('Date object as timestamp works', () => {
    const { _dedupHookEvent } = createDedupState();
    const d = new Date('2026-01-01T00:00:00.000Z');
    assert.strictEqual(_dedupHookEvent('bootstrap', { sessionKey: 'agent:main:test', timestamp: d }), false);
    assert.strictEqual(_dedupHookEvent('bootstrap', { sessionKey: 'agent:main:test', timestamp: d }), true);
  });

  it('Set size bounded at 200 after pruning', () => {
    const { _hookEventDedup, _dedupHookEvent } = createDedupState();
    for (let i = 0; i < 500; i++) {
      _dedupHookEvent('bootstrap', { sessionKey: `agent:main:session${i}`, timestamp: i });
    }
    assert.ok(_hookEventDedup.size <= 200, `Size ${_hookEventDedup.size} exceeds 200`);
    assert.ok(_hookEventDedup.size >= 50, `Size ${_hookEventDedup.size} suspiciously small`);
  });

  it('eviction: newest entries survive, oldest evicted', () => {
    const { _hookEventDedup, _dedupHookEvent } = createDedupState();
    const h = 'bootstrap';
    for (let i = 0; i < 300; i++) {
      _dedupHookEvent(h, { sessionKey: `agent:main:session${i}`, timestamp: i });
    }
    // After 201st item, prune keeps newest 100 → Set has items [102..200]
    // Then add 201..299 → Set has items [102..299] = 198 items
    // session0 definitely evicted (oldest)
    assert.ok(!_hookEventDedup.has(`${h}:agent:main:session0:${0}`), 'session0 oldest should be evicted');
    // session200+ should all survive (well within newest 100 of final state)
    for (let i = 250; i < 300; i++) {
      assert.ok(_hookEventDedup.has(`${h}:agent:main:session${i}:${i}`), `session${i} should survive`);
    }
  });
});

describe('Phase 1: Handler guard placement', () => {
  // Validation BEFORE dedup — shared dedup state

  function mockBootstrap(event, config, dedupState) {
    const sk = typeof event.sessionKey === 'string' ? event.sessionKey : '';
    if (sk.includes('internal')) return 'SKIP_internal';
    if (config.skipSubagent !== false && sk.includes(':subagent:')) return 'SKIP_subagent';
    if (dedupState._dedupHookEvent('bootstrap', event)) return 'SKIP_dedup';
    return 'PROCEED';
  }

  function mockReflection(event, dedupState) {
    const sk = typeof event.sessionKey === 'string' ? event.sessionKey : '';
    if (!sk) return 'SKIP_no_sk';
    if (dedupState._dedupHookEvent('reflection', event)) return 'SKIP_dedup';
    return 'PROCEED';
  }

  it('bootstrap: internal session skipped — does NOT pollute dedup', () => {
    const dedupState = createDedupState();
    const r = mockBootstrap({ sessionKey: 'agent:main:internal', timestamp: 1000 }, {}, dedupState);
    assert.strictEqual(r, 'SKIP_internal');
    assert.strictEqual(dedupState._hookEventDedup.size, 0, 'Internal must not pollute');
  });

  it('bootstrap: subagent session skipped — does NOT pollute dedup', () => {
    const dedupState = createDedupState();
    const r = mockBootstrap({ sessionKey: 'agent:main:discord:dm:user:subagent:abc', timestamp: 1000 }, { skipSubagent: true }, dedupState);
    assert.strictEqual(r, 'SKIP_subagent');
    assert.strictEqual(dedupState._hookEventDedup.size, 0, 'Subagent must not pollute');
  });

  it('bootstrap: legitimate event proceeds and is recorded', () => {
    const dedupState = createDedupState();
    const event = { sessionKey: 'agent:main:real', timestamp: 1000 };
    const r = mockBootstrap(event, { skipSubagent: true }, dedupState);
    assert.strictEqual(r, 'PROCEED');
    assert.strictEqual(dedupState._hookEventDedup.size, 1, 'Should be recorded');
  });

  it('bootstrap: duplicate legitimate event is deduped', () => {
    const dedupState = createDedupState();
    const event = { sessionKey: 'agent:main:real', timestamp: 1000 };
    assert.strictEqual(mockBootstrap(event, {}, dedupState), 'PROCEED');
    assert.strictEqual(mockBootstrap(event, {}, dedupState), 'SKIP_dedup');
    assert.strictEqual(dedupState._hookEventDedup.size, 1);
  });

  it('bootstrap: internal(skipped) then legitimate same ts — legit proceeds', () => {
    const dedupState = createDedupState();
    mockBootstrap({ sessionKey: 'agent:main:internal', timestamp: 1000 }, {}, dedupState);
    const r = mockBootstrap({ sessionKey: 'agent:main:real', timestamp: 1000 }, {}, dedupState);
    assert.strictEqual(r, 'PROCEED', 'Internal was skipped before dedup, not added to Set');
    assert.strictEqual(dedupState._hookEventDedup.size, 1);
  });

  it('reflection: empty sessionKey skipped — does NOT pollute dedup', () => {
    const dedupState = createDedupState();
    const r = mockReflection({ sessionKey: '', timestamp: 1000 }, dedupState);
    assert.strictEqual(r, 'SKIP_no_sk');
    assert.strictEqual(dedupState._hookEventDedup.size, 0, 'Empty sessionKey must not pollute');
  });

  it('reflection: null sessionKey skipped — does NOT pollute dedup', () => {
    const dedupState = createDedupState();
    const r = mockReflection({ sessionKey: null, timestamp: 1000 }, dedupState);
    assert.strictEqual(r, 'SKIP_no_sk');
    assert.strictEqual(dedupState._hookEventDedup.size, 0);
  });

  it('reflection: valid sessionKey proceeds', () => {
    const dedupState = createDedupState();
    const event = { sessionKey: 'agent:main:test', timestamp: 1000 };
    const r = mockReflection(event, dedupState);
    assert.strictEqual(r, 'PROCEED');
    assert.ok(dedupState._hookEventDedup.has('reflection:agent:main:test:1000'));
  });

  // --- selfImprovement mock: messages array check before dedup ---
  function mockSelfImprovement(event, dedupState) {
    if (!Array.isArray(event?.messages)) return 'SKIP_no_messages';
    if (dedupState._dedupHookEvent('selfImprovement', event)) return 'SKIP_dedup';
    return 'PROCEED';
  }

  it('selfImprovement: missing messages skipped — does NOT pollute dedup', () => {
    const dedupState = createDedupState();
    // messages is undefined
    const r1 = mockSelfImprovement({ sessionKey: 'agent:main:test', timestamp: 1000 }, dedupState);
    assert.strictEqual(r1, 'SKIP_no_messages');
    assert.strictEqual(dedupState._hookEventDedup.size, 0, 'Missing messages must not pollute dedup');
  });

  it('selfImprovement: non-array messages skipped — does NOT pollute dedup', () => {
    const dedupState = createDedupState();
    // messages is a string (not an array)
    const r1 = mockSelfImprovement({ sessionKey: 'agent:main:test', timestamp: 1000, messages: 'not an array' }, dedupState);
    assert.strictEqual(r1, 'SKIP_no_messages');
    assert.strictEqual(dedupState._hookEventDedup.size, 0, 'Non-array messages must not pollute dedup');
  });

  it('selfImprovement: valid messages proceeds', () => {
    const dedupState = createDedupState();
    const event = { sessionKey: 'agent:main:test', timestamp: 1000, messages: ['hello'] };
    const r = mockSelfImprovement(event, dedupState);
    assert.strictEqual(r, 'PROCEED');
    assert.ok(dedupState._hookEventDedup.has('selfImprovement:agent:main:test:1000'));
  });

  it('selfImprovement: missing(skipped) then valid same ts — valid proceeds', () => {
    const dedupState = createDedupState();
    mockSelfImprovement({ sessionKey: 'agent:main:test', timestamp: 1000 }, dedupState);
    // Missing was skipped before dedup, valid key is not duplicate of missing
    const r = mockSelfImprovement({ sessionKey: 'agent:main:test', timestamp: 1000, messages: ['hi'] }, dedupState);
    assert.strictEqual(r, 'PROCEED', 'Missing was skipped, valid key is not duplicate');
  });

  it('reflection: empty(skipped) then valid same ts — valid proceeds', () => {
    const dedupState = createDedupState();
    mockReflection({ sessionKey: '', timestamp: 1000 }, dedupState);
    // Empty was skipped before dedup (treated as "?" but never added)
    // Valid uses "agent:main:test" — different key from "?"
    const r = mockReflection({ sessionKey: 'agent:main:test', timestamp: 1000 }, dedupState);
    assert.strictEqual(r, 'PROCEED', 'Empty was skipped, valid key is not duplicate');
  });
});

describe('Phase 1: Bounded memory', () => {
  it('dedup set never grows beyond 200 after 1000 events', () => {
    const { _hookEventDedup, _dedupHookEvent } = createDedupState();
    for (let i = 0; i < 1000; i++) {
      _dedupHookEvent('bootstrap', { sessionKey: `agent:main:session${i % 50}`, timestamp: i });
    }
    assert.ok(_hookEventDedup.size <= 200, `Bounded: ${_hookEventDedup.size} > 200`);
  });
});
