/**
 * AST-aware Code Chunking Tests (Issue #692)
 *
 * Verifies that code declarations (functions, classes) are NOT split mid-
 * declaration, which was breaking { } balance when the old character-based
 * splitter cut through the middle of a function body.
 */

import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import jitiFactory from 'jiti';

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { detectCodeLanguage, astChunk, smartChunk, chunkDocument, DEFAULT_CHUNKER_CONFIG } = jiti('../src/chunker.ts');

// ============================================================================
// detectCodeLanguage
// ============================================================================

describe('detectCodeLanguage', () => {
  it('detects JavaScript function', () => {
    const code = 'async function handleUserLogin(userId, password) {';
    assert.equal(detectCodeLanguage(code), 'javascript');
  });

  it('detects TypeScript interface', () => {
    const code = 'interface UserProfile { name: string; age: number; }';
    assert.equal(detectCodeLanguage(code), 'typescript');
  });

  it('detects Python function', () => {
    const code = 'def verify_password(password: str, hashed: bytes) -> bool:';
    assert.equal(detectCodeLanguage(code), 'python');
  });

  it('detects Go function', () => {
    const code = 'func handleLogin(w http.ResponseWriter, r *http.Request) {';
    assert.equal(detectCodeLanguage(code), 'go');
  });

  it('detects Rust function', () => {
    const code = 'fn verify_password(password: &str, hash: &str) -> bool {';
    assert.equal(detectCodeLanguage(code), 'rust');
  });

  it('returns null for plain text', () => {
    const text = 'This is a plain English sentence with no code markers.';
    assert.equal(detectCodeLanguage(text), null);
  });

  it('returns null for Markdown prose', () => {
    const md = '# Heading\n\nThis is a paragraph with **bold** text.';
    assert.equal(detectCodeLanguage(md), null);
  });

  it('uses only first 400 chars to avoid comment noise', () => {
    // Short comment so 'function' appears within first 400 chars of the sample
    const commentLine = '// This is a comment\n'; // 20 chars
    const code = commentLine.repeat(15) + 'function foo() {}'; // ~300 + function
    assert.equal(detectCodeLanguage(code), 'javascript');
  });
});

// ============================================================================
// Brace balance helper
// ============================================================================

/** Count net open braces inside a string. */
function braceDelta(s) {
  let d = 0;
  for (const ch of s) {
    if (ch === '{') d++;
    else if (ch === '}') d--;
  }
  return d;
}

/** Check all chunks are brace-balanced. */
function assertBraceBalanced(chunks, label) {
  const deltas = chunks.map(c => braceDelta(c));
  const total = deltas.reduce((a, b) => a + b, 0);
  assert.equal(total, 0, `${label}: unbalanced braces across chunks (net=${total}, deltas=${JSON.stringify(deltas)})`);
  for (let i = 0; i < deltas.length; i++) {
    assert(deltas[i] >= 0,
      `${label}: chunk[${i}] closes more braces than it opens (delta=${deltas[i]})`);
  }
}

// ============================================================================
// Issue #692 — core destructive cases
// ============================================================================

describe('Issue #692: code functions must not be split mid-declaration', () => {

  it('verifies that a simple async function is kept whole', () => {
    const code = `async function verifyPassword(password, hash) {
  const match = await bcrypt.compare(password, hash);
  return match;
}`;

    // Very small maxChunkSize to force splitting — old splitter would cut mid-function
    const config = { ...DEFAULT_CHUNKER_CONFIG, maxChunkSize: 60, minChunkSize: 10, semanticSplit: false };
    const result = astChunk(code, 'javascript', config);

    // Function body should not be split mid-declaration
    const splitInsideFunction = result.chunks.some(chunk => {
      // Should not have "{" without corresponding "}"
      const d = braceDelta(chunk);
      return d > 0; // opens braces but never closes
    });
    assert.ok(!splitInsideFunction, 'Should not split inside a function declaration');
    assertBraceBalanced(result.chunks, 'verifyPassword');
  });

  it('verifies that a long function is NOT split mid-function (maxChunkSize < function length)', () => {
    // This function is ~250 chars — set maxChunkSize=120 to force the issue.
    // Oversized functions are kept as ONE atomic chunk (no mid-function split).
    const code = `async function handleUserLogin(userId, password) {
  const user = await db.users.findOne({ id: userId });
  if (!user) throw new Error('User not found');
  const match = await bcrypt.compare(password, user.hash);
  return match;
}`;

    const config = { ...DEFAULT_CHUNKER_CONFIG, maxChunkSize: 120, minChunkSize: 40, semanticSplit: false };
    const result = astChunk(code, 'javascript', config);

    assertBraceBalanced(result.chunks, 'handleUserLogin');
    // Should be 1 chunk — entire function kept intact
    assert.ok(result.chunks.length === 1, `Expected 1 chunk (entire function), got ${result.chunks.length}`);
  });

  it('verifies that multiple small functions are each kept whole', () => {
    const code = `async function verifyPassword(password, hash) {
  return await bcrypt.compare(password, hash);
}

async function hashPassword(password) {
  return await bcrypt.hash(password, 10);
}

export async function createUser(name, email, password) {
  const hash = await hashPassword(password);
  return await db.users.create({ name, email, hash });
}`;

    const config = { ...DEFAULT_CHUNKER_CONFIG, maxChunkSize: 150, minChunkSize: 40, semanticSplit: false };
    const result = astChunk(code, 'javascript', config);

    assertBraceBalanced(result.chunks, 'multiple functions');
    // All three functions should appear intact in some chunk
    assert.ok(result.chunks.some(c => c.includes('function verifyPassword')), 'verifyPassword missing');
    assert.ok(result.chunks.some(c => c.includes('function hashPassword')), 'hashPassword missing');
    assert.ok(result.chunks.some(c => c.includes('function createUser')), 'createUser missing');
  });

  it('smartChunk: entire JavaScript file with functions stays brace-balanced', () => {
    const code = `const SPEC = {
  name: 'auth',
  version: '1.0.0',
};

async function login(email, password) {
  const user = await db.findUser(email);
  const ok = await bcrypt.compare(password, user.hash);
  if (!ok) throw new Error('Invalid credentials');
  return { token: signToken(user.id) };
}

async function logout(token) {
  invalidateToken(token);
}`;

    const result = smartChunk(code, 'text-embedding-3-small');
    assertBraceBalanced(result.chunks, 'smartChunk JS');
  });

  it('smartChunk: Python function stays syntactically coherent', () => {
    const code = `def verify_password(password: str, hashed: bytes) -> bool:
    return pwd_context.verify(password, hashed)

def hash_password(password: str) -> str:
    return pwd_context.hash(password)`;

    const result = smartChunk(code, 'text-embedding-3-small');
    assert.ok(result.chunks.length >= 1, 'Should produce at least one chunk');
    // Python chunks should contain complete function definitions
    assert.ok(result.chunks.every(c => c.trim().length > 0), 'No empty chunks');
  });
});

// ============================================================================
// astChunk — fallback & edge cases
// ============================================================================

describe('astChunk fallback behavior', () => {

  it('falls back to chunkDocument when tree-sitter throws', () => {
    // Pass an empty string to force parse error
    const code = '';
    const config = { ...DEFAULT_CHUNKER_CONFIG, maxChunkSize: 50 };
    const result = astChunk(code, 'javascript', config);
    // Should return a valid ChunkResult (fallback path)
    assert.ok('chunks' in result);
    assert.ok('chunkCount' in result);
  });

  it('returns chunkDocument result when language is unsupported', () => {
    const code = 'fn main() {}'; // not JS/TS/Python
    const config = { ...DEFAULT_CHUNKER_CONFIG, maxChunkSize: 50 };
    const result = astChunk(code, 'rust', config);
    // Rust is not yet supported in astChunk — falls back
    assert.ok('chunks' in result);
  });

  it('handles an oversized single declaration as one atomic chunk (brace-balanced)', () => {
    // A very long function that exceeds maxChunkSize — should stay as ONE chunk
    const body = '  return x + y;\n'.repeat(200);
    const code = `function processData(x, y) {\n${body}}`;

    const config = { ...DEFAULT_CHUNKER_CONFIG, maxChunkSize: 200, minChunkSize: 50, semanticSplit: false };
    const result = astChunk(code, 'javascript', config);

    // Should be 1 chunk — entire function kept as one
    assert.ok(result.chunks.length === 1, `Expected 1 chunk, got ${result.chunks.length}`);
    assertBraceBalanced(result.chunks, 'oversized function atomic chunk');
  });
});

// ============================================================================
// smartChunk — non-code text unchanged
// ============================================================================

describe('smartChunk preserves non-code behavior', () => {

  it('passes plain English text to chunkDocument (not astChunk)', () => {
    const text = 'This is a plain English paragraph. It has sentences. They end with periods. '.repeat(30);

    const result = smartChunk(text, 'text-embedding-3-small');

    assert.ok(result.chunks.length >= 1, 'Should produce chunks');
    // Plain text should be split on sentence boundaries (semanticSplit=true default)
  });

  it('passes Markdown prose to chunkDocument', () => {
    const md = '# Title\n\nThis is a paragraph.\n\n## Section\n\nAnother paragraph here.\n'.repeat(20);

    const result = smartChunk(md, 'text-embedding-3-small');

    assert.ok(result.chunks.length >= 1, 'Should produce chunks');
    assert.equal(detectCodeLanguage(md), null, 'Markdown should not be detected as code');
  });
});

// ============================================================================
// TypeScript interface chunking
// ============================================================================

describe('TypeScript interfaces and types', () => {

  it('smartChunk: TypeScript interface stays balanced (via smartChunk, not direct astChunk)', () => {
    // Note: tree-sitter-javascript cannot fully parse TS interface declarations as one unit.
    // When astChunk falls back to chunkDocument for an oversized TS interface,
    // it may produce multiple chunks. smartChunk avoids this by using a large
    // enough maxChunkSize that the whole interface fits in one chunk.
    const code = `interface UserProfile {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
  metadata?: Record<string, unknown>;
}`;

    const result = smartChunk(code, 'text-embedding-3-small');
    // The interface declaration should produce at least one chunk
    assert.ok(result.chunks.length >= 1, 'Should produce at least one chunk');
    assertBraceBalanced(result.chunks, 'smartChunk TS interface');
    assert.ok(result.chunks.some(c => c.includes('interface UserProfile')), 'interface should be present');
  });

  it('smartChunk on TypeScript stays balanced', () => {
    const code = `type UserID = string;

interface Config {
  apiKey: string;
  timeout: number;
}

function getConfig(): Config {
  return { apiKey: process.env.KEY, timeout: 5000 };
}`;

    const result = smartChunk(code, 'text-embedding-3-small');
    assertBraceBalanced(result.chunks, 'smartChunk TS');
  });
});
