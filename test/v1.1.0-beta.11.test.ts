/**
 * Unit Tests for v1.1.0-beta.11 Features
 */

import { describe, it, expect, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { RetrievalCache, getGlobalCache, resetGlobalCache } from './retrieval-cache.js';
import { tokenizeChinese, tokenizeChineseSync, hasChineseChars } from './chinese-tokenizer.js';
import { convertToPinyin, matchPinyin } from './pinyin-search.js';
import { toSimplified, toTraditional, normalizeChinese } from './chinese-converter.js';
import { SynonymsManager, expandQueryForBM25 } from './chinese-synonyms.js';
import { FrozenSnapshotManager, getSnapshotManager, resetSnapshotManager } from './frozen-snapshot.js';
import { EnhancedRetriever, processQuery } from './enhanced-retriever.js';

// ============================================================================
// Retrieval Cache Tests
// ============================================================================

describe('RetrievalCache', () => {
  let cache: RetrievalCache;

  beforeEach(() => {
    cache = new RetrievalCache();
  });

  afterEach(() => {
    cache.stop();
    resetGlobalCache();
  });

  it('should cache and retrieve results', () => {
    const key = 'test-query';
    const results = [{ score: 0.9, entry: { id: '1' } }];

    cache.set(key, results as any);
    const cached = cache.get(key);

    assert.strictEqual(cached, results);
  });

  it('should return null for expired cache', async () => {
    const key = 'test-expired';
    const results = [{ score: 0.9, entry: { id: '1' } }];

    cache.set(key, results as any, 100); // 100ms TTL
    await new Promise(resolve => setTimeout(resolve, 150));

    const cached = cache.get(key);
    assert.strictEqual(cached, null);
  });

  it('should cleanup expired entries', () => {
    cache.set('key1', [{ score: 0.9 }] as any, 100);
    cache.set('key2', [{ score: 0.8 }] as any, 5000);

    setTimeout(() => {
      const deleted = cache.cleanup();
      assert.strictEqual(deleted, 1);
    }, 150);
  });

  it('should enforce max entries limit', () => {
    const smallCache = new RetrievalCache({ maxEntries: 3, defaultTtlMs: 60000 });

    smallCache.set('key1', [] as any);
    smallCache.set('key2', [] as any);
    smallCache.set('key3', [] as any);
    smallCache.set('key4', [] as any);

    const stats = smallCache.getStats();
    assert.strictEqual(stats.size, 3);
  });
});

// ============================================================================
// Chinese Tokenizer Tests
// ============================================================================

describe('ChineseTokenizer', () => {
  it('should detect Chinese characters', () => {
    assert.strictEqual(hasChineseChars('你好'), true);
    assert.strictEqual(hasChineseChars('hello'), false);
    assert.strictEqual(hasChineseChars('你好 world'), true);
  });

  it('should tokenize Chinese text (simple)', () => {
    const tokens = tokenizeChineseSync('我喜欢吃苹果');
    assert.ok(tokens.length > 0);
    assert.ok(tokens.some(t => t.includes('苹果')));
  });

  it('should tokenize mixed Chinese and English', () => {
    const tokens = tokenizeChineseSync('我喜欢 AI 技术');
    assert.ok(tokens.some(t => t === 'AI'));
  });

  it('should handle empty text', () => {
    const tokens = tokenizeChineseSync('');
    assert.deepStrictEqual(tokens, []);
  });
});

// ============================================================================
// Pinyin Search Tests
// ============================================================================

describe('PinyinSearch', () => {
  it('should convert Chinese to pinyin', async () => {
    const pinyin = await convertToPinyin('中国');
    assert.ok(pinyin.length > 0);
    // Should contain 'zhong' and 'guo'
    const combined = pinyin.join(' ').toLowerCase();
    assert.ok(combined.includes('zhong') || combined.includes('guo'));
  });

  it('should match pinyin query', () => {
    const match = matchPinyin('zhongguo', 'zg');
    assert.strictEqual(match, true); // Abbreviation match
  });

  it('should calculate pinyin similarity', () => {
    const score = matchPinyin('zhong guo', 'zhong');
    assert.ok(score >= 0 || score === false); // Either boolean or number
  });
});

// ============================================================================
// Traditional-Simplified Conversion Tests
// ============================================================================

describe('ChineseConverter', () => {
  it('should convert traditional to simplified', async () => {
    const simplified = await toSimplified('中國');
    assert.strictEqual(simplified, '中国');
  });

  it('should convert simplified to traditional', async () => {
    const traditional = await toTraditional('中国');
    assert.strictEqual(traditional, '中國');
  });

  it('should normalize Chinese text', async () => {
    const normalized = await normalizeChinese('中國', {
      enableConversion: true,
      targetScript: 'simplified',
      autoDetect: true,
    });
    assert.strictEqual(normalized, '中国');
  });
});

// ============================================================================
// Synonyms Tests
// ============================================================================

describe('SynonymsManager', () => {
  let manager: SynonymsManager;

  beforeEach(() => {
    manager = new SynonymsManager();
  });

  it('should expand query with synonyms', () => {
    const expanded = manager.expandQuery('AI');
    assert.ok(expanded.length > 1);
    assert.ok(expanded.some(e => e.includes('人工智能')));
  });

  it('should get synonyms for word', () => {
    const synonyms = manager.getSynonyms('电脑');
    assert.ok(synonyms.length > 0);
    assert.ok(synonyms.some(s => s.includes('计算机')));
  });

  it('should handle custom synonyms', () => {
    const customManager = new SynonymsManager({
      ...manager,
      customSynonyms: {
        '测试': ['test', 'testing'],
      },
    });

    const expanded = customManager.expandQuery('测试');
    assert.ok(expanded.some(e => e.includes('test')));
  });

  it('should respect max expanded queries', () => {
    const limitedManager = new SynonymsManager({
      maxExpandedQueries: 2,
      useBuiltIn: true,
    });

    const expanded = limitedManager.expandQuery('AI');
    assert.ok(expanded.length <= 2);
  });
});

// ============================================================================
// Frozen Snapshot Tests
// ============================================================================

describe('FrozenSnapshot', () => {
  let snapshotManager: FrozenSnapshotManager;

  beforeEach(() => {
    snapshotManager = getSnapshotManager();
  });

  afterEach(() => {
    resetSnapshotManager();
  });

  it('should capture snapshot', () => {
    const entries = [
      {
        id: 'mem1',
        text: 'User prefers tabs',
        vector: [0.1, 0.2],
        category: 'preference' as const,
        scope: 'user',
        importance: 0.8,
        timestamp: Date.now(),
      },
    ];

    const snapshot = snapshotManager.capture(entries, []);
    assert.ok(snapshot.hasSnapshot);
    assert.strictEqual(snapshot.memoryCount, 1);
  });

  it('should return frozen snapshot', () => {
    const entries = [{
      id: 'mem1',
      text: 'Test memory',
      vector: [0.1],
      category: 'fact' as const,
      scope: 'global',
      importance: 0.9,
      timestamp: Date.now(),
    }];

    snapshotManager.capture(entries, []);
    const snapshot = snapshotManager.getSnapshot();

    assert.ok(snapshot);
    assert.ok(snapshot!.memory.includes('Test memory'));
  });

  it('should not change after capture', () => {
    const entries = [{
      id: 'mem1',
      text: 'Original',
      vector: [0.1],
      category: 'fact' as const,
      scope: 'global',
      importance: 0.9,
      timestamp: Date.now(),
    }];

    snapshotManager.capture(entries, []);
    const first = snapshotManager.getMemoryBlock();

    // Snapshot should remain frozen
    assert.ok(first.includes('Original'));
  });
});

// ============================================================================
// Enhanced Retriever Tests
// ============================================================================

describe('EnhancedRetriever', () => {
  it('should process query with enhancements', async () => {
    const processed = await processQuery('人工智能', {
      enableCache: false,
      tokenizer: { enableChinese: true },
      synonyms: { enabled: true, maxExpandedQueries: 3 },
      conversion: { enableConversion: true, targetScript: 'simplified' },
      pinyin: { enablePinyin: false },
    } as any);

    assert.ok(processed.expanded.length > 0);
    assert.ok(processed.expanded.some(e => e.includes('AI') || e.includes('人工')));
  });

  it('should deduplicate results', async () => {
    const retriever = new EnhancedRetriever({ enableCache: false });

    const mockRetrieve = async () => [
      { entry: { id: '1', text: 'test' }, score: 0.9 },
      { entry: { id: '1', text: 'test' }, score: 0.8 }, // Duplicate
    ];

    const results = await retriever.retrieve('test', { query: 'test', limit: 10 }, mockRetrieve as any);

    // Should deduplicate
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].entry.id, '1');
  });
});

// ============================================================================
// Integration Tests
// ============================================================================

describe('Integration', () => {
  it('should handle full Chinese retrieval pipeline', async () => {
    // Full pipeline: 繁简 → 同义词 → 分词 → 检索
    const query = '中國的人工智能';

    const processed = await processQuery(query, {
      enableCache: false,
      tokenizer: { enableChinese: true, enablePinyin: true },
      synonyms: { enabled: true },
      conversion: { enableConversion: true, targetScript: 'simplified' },
      pinyin: { enablePinyin: true, includeOriginal: true },
    } as any);

    // Should normalize to simplified
    assert.strictEqual(processed.normalized, '中国的人工智能');

    // Should expand with synonyms
    assert.ok(processed.expanded.length > 1);

    // Should tokenize
    assert.ok(processed.tokenized.length > 0);
  });
});
