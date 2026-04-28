/**
 * test/redis-url-parsing.test.mjs
 *
 * PR-1：URL parsing 單元測試
 * 驗證 parseRedisUrl() 正確處理 legacy / auth / TLS / query string 格式
 *
 * 使用 jiti（與專案其他測試一致）來 import TypeScript 原始碼。
 */

import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { parseRedisUrl } = jiti('../src/redis-lock.ts');

// ============================================================================
// parseRedisUrl 測試
// ============================================================================

const URL_TESTS = [
  {
    input: 'localhost:6379',
    expected: 'redis://localhost:6379',
    description: 'Legacy 格式（無 scheme）：補上 redis://',
  },
  {
    input: 'host:6379',
    expected: 'redis://host:6379',
    description: 'Legacy 格式：基本 host:port',
  },
  {
    input: 'redis://localhost:6379',
    expected: 'redis://localhost:6379',
    description: '標準格式（redis://）：完整保留',
  },
  {
    input: 'redis://user:password@localhost:6379',
    expected: 'redis://user:password@localhost:6379',
    description: '含密碼 URL：完整保留（不破壞 auth）',
  },
  {
    input: 'redis://user:pass@host:6379',
    expected: 'redis://user:pass@host:6379',
    description: '含特殊字元密碼：不破壞',
  },
  {
    input: 'rediss://localhost:6379',
    expected: 'rediss://localhost:6379',
    description: 'TLS 格式（rediss://）：完整保留',
  },
  {
    input: 'rediss://user:pass@host:6379',
    expected: 'rediss://user:pass@host:6379',
    description: 'TLS + Auth：完整保留',
  },
  {
    input: 'redis://localhost:6379?tls=true',
    expected: 'redis://localhost:6379?tls=true',
    description: 'Query string：完整保留',
  },
  {
    input: 'redis://host:6379?tls=true&maxRetriesPerRequest=3',
    expected: 'redis://host:6379?tls=true&maxRetriesPerRequest=3',
    description: '多個 query params：完整保留',
  },
  {
    input: 'redis://localhost:6379/2',
    expected: 'redis://localhost:6379/2',
    description: 'DB index（/2）：完整保留',
  },
  {
    input: 'redis://:password@localhost:6379',
    expected: 'redis://:password@localhost:6379',
    description: '只有密碼（無 username）：完整保留',
  },
];

let passed = 0;
let failed = 0;

for (const { input, expected, description } of URL_TESTS) {
  const result = parseRedisUrl(input);
  const pass = result === expected;
  if (pass) {
    console.log(`✅ ${description}`);
    passed++;
  } else {
    console.log(`❌ ${description}`);
    console.log(`   Input:    ${input}`);
    console.log(`   Expected: ${expected}`);
    console.log(`   Got:      ${result}`);
    failed++;
  }
}

// ============================================================================
// 邊界條件測試
// ============================================================================

const EDGE_CASES = [
  {
    input: '127.0.0.1:6379',
    expected: 'redis://127.0.0.1:6379',
    description: 'IP:port：補上 scheme',
  },
  {
    input: '[::1]:6379',
    expected: 'redis://[::1]:6379',
    description: 'IPv6:port：補上 scheme',
  },
];

for (const { input, expected, description } of EDGE_CASES) {
  const result = parseRedisUrl(input);
  const pass = result === expected;
  if (pass) {
    console.log(`✅ ${description}`);
    passed++;
  } else {
    console.log(`❌ ${description}`);
    console.log(`   Input:    ${input}`);
    console.log(`   Expected: ${expected}`);
    console.log(`   Got:      ${result}`);
    failed++;
  }
}

console.log(`\n結果：${passed} 通過，${failed} 失敗（共 ${URL_TESTS.length + EDGE_CASES.length} 個測試）`);

if (failed > 0) {
  process.exit(1);
}
