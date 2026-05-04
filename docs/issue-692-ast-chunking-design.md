# Issue #692 — AST-based Semantic Chunking for Code Blocks

**Status:** Designed
**Repo:** `memory-lancedb-pro`
**Created:** 2026-05-04
**Source:** https://github.com/CortexReach/memory-lancedb-pro/issues/692

---

## Problem Summary

`chunker.ts` 的 `smartChunk()` 使用純 character-based split，split 邏輯在 `findSplitEnd()`：
- 先找 sentence ending（`.!！？`）
- 找不到 → 找 `\n`
- 找不到 → 找 whitespace

這對自然語言有效，但對程式碼是災難。JS/TS 函式結尾是 `;` 和 `}`，兩者都不在 target set，導致 function declaration 在 `{` / `}` 之間被隨機切斷。

**真實破壞案例：**
```
Chunk A（~3800字）：
"async function handleUserLogin(userId: string, credentials: LoginCredentials): Promise<AuthResult> {\n"
"    const user = await this.userRepository.findById(userId);\n"
"    if (!user) {\n"
"        return { success: false, error: 'USER_NOT_FOUND' };"

Chunk B（~900字）：
"    }\n"
"    const passwordValid = await this.verifyPassword(...);"  // verifyPassword 跨 Chunk A 和 B
```

**問題：**
- Chunk A 結尾在 `return { success: false, error: 'USER_NOT_FOUND' };` — 不完整的 if-block
- Chunk B 開頭是 `}` — 脫離語境的 closing brace
- `verifyPassword` 函式定義被切成兩段

---

## Verified Facts (gitnexus + source reading)

### Call Graph (gitnexus verified)
```
smartChunk (chunker.ts:263-281)
  ├─ calls: getCjkRatio (174-183), chunkDocument (194-255)
  │
  └─ called by:
       ├─ embedSingle (embedder.ts)
       ├─ embedMany (embedder.ts)
       ├─ testCjkAwareChunkSizing (test/cjk-recursion-regression.test.mjs)
       └─ testSmallContextChunking (test/cjk-recursion-regression.test.mjs)

chunkDocument (chunker.ts:194-255)
  ├─ calls: findSplitEnd (97-143), sliceTrimWithIndices (146-163)
  └─ called by: smartChunk

findSplitEnd (chunker.ts:97-143)  ← 問題根因所在
```

### Existing Coverage
- **測試：** 只有 `test/cjk-recursion-regression.test.mjs` 呼叫 `smartChunk`，**沒有任何專門測試 chunker 破壞案例的測試檔案**
- **依賴：** 無 tree-sitter
- **Config:** `maxChunkSize`, `overlapSize`, `minChunkSize`, `semanticSplit`, `maxLinesPerChunk`

---

## Solution: astChunk()

### Architecture

```
smartChunk(text)
  ├─ detectCodeLanguage(text) === null  → chunkDocument()  [現有 character split]
  └─ detectCodeLanguage(text) === 'js'/'ts' → astChunk(text, lang, config)
                               === 'py'   → astChunk(text, 'python', config)
                               === 其他   → chunkDocument()  [fallback]
```

### 1. `detectCodeLanguage(text) → CodeLanguage | null`

取前 200 字做偵測：

| 語言 | Pattern |
|------|---------|
| JS/TS | `/\b(function\|const\s\|let\s\|var\s\|=>\|import\s\|export\s\|interface\s\|type\s\|class\s)/` |
| Python | `/\bdef\s\|class\s\|import\s\|from\s\|print\(/` |
| Go | `/\bfunc\s\|package\s\|import\s"/` |
| Rust | `/\bfn\s\|impl\s\|pub\s\|let\s+mut\s/` |

### 2. `astChunk(code, language, config) → ChunkResult`

```typescript
import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';

export function astChunk(
  code: string,
  language: CodeLanguage,
  config: ChunkerConfig
): ChunkResult {
  const parser = new Parser();
  switch (language) {
    case 'javascript':
    case 'typescript':
      parser.setLanguage(JavaScript);
      break;
    case 'python':
      parser.setLanguage(Python);
      break;
    default:
      return chunkDocument(code, config);
  }

  const tree = parser.parse(code);
  const chunks: string[] = [];
  const metadatas: ChunkMetadata[] = [];

  // Walk top-level nodes
  const root = tree.rootNode;
  for (const child of root.children) {
    if (!isDeclarationNode(child)) continue;
    const text = code.slice(child.startIndex, child.endIndex);
    if (text.length <= config.maxChunkSize) {
      chunks.push(text);
      metadatas.push({ startIndex: child.startIndex, endIndex: child.endIndex, length: text.length });
    } else {
      // Sub-split within this declaration at statement level
      const subResult = subChunk(text, config);
      chunks.push(...subResult.chunks);
      metadatas.push(...subResult.metadatas);
    }
  }

  return { chunks, metadatas, totalOriginalLength: code.length, chunkCount: chunks.length };
}
```

### 3. Supported Node Types (Phase 1)

| 語言 | P0 節點 |
|------|---------|
| JS/TS | `function_declaration`, `arrow_function`, `class_declaration`, `method_definition`, `export_statement`, `interface_declaration`, `type_alias_declaration`, `lexical_declaration` |
| Python | `function_definition`, `class_definition`, `decorated_definition` |
| Go | `function_declaration`, `method_declaration` (P2) |
| Rust | `function_item`, `impl_item` (P2) |

### 4. Config Extension

```typescript
interface ChunkerConfig {
  // ... 現有五個欄位 ...
  astAwareCodeSplit?: boolean;  // NEW: default true
}
```

### 5. Dependency Changes

```json
{
  "dependencies": {
    "tree-sitter": "^0.21.1",
    "tree-sitter-javascript": "^0.21.0",
    "tree-sitter-python": "^0.21.0"
  }
}
```

---

## Files to Change

| 檔案 | 變更 |
|------|------|
| `src/chunker.ts` | + `detectCodeLanguage()`, + `astChunk()`, + `subChunk()`, 修改 `smartChunk()` 路由, + `astAwareCodeSplit` config |
| `src/chunker.test.ts` | **全新建立**（從破壞案例反轉）|
| `package.json` | + tree-sitter, tree-sitter-javascript, tree-sitter-python |

---

## Tests (New File)

```typescript
describe('AST-aware code chunking', () => {
  it('should keep { and } balanced in every chunk', () => {
    const code = `async function handleUserLogin(userId: string) {
    const user = await this.userRepository.findById(userId);
    if (!user) { return { success: false }; }
    const session = await this.createSession(user);
    return { success: true, session };
}
async function verifyPassword(input: string): Promise<boolean> {
    return bcrypt.compare(input, this.hash);
}`;
    const result = smartChunk(code, 'jina-embeddings-v5');
    for (const chunk of result.chunks) {
      const opens = (chunk.match(/{/g) || []).length;
      const closes = (chunk.match(/}/g) || []).length;
      expect(opens).toBe(closes);
    }
  });

  it('should not split function mid-body', () => {
    const result = smartChunk(code, 'jina-embeddings-v5');
    const hasMiddleOfFunction = result.chunks.some(c =>
      c.startsWith('}') || c.endsWith('{')
    );
    expect(hasMiddleOfFunction).toBe(false);
  });

  it('should keep complete function as one chunk', () => {
    const result = smartChunk(code, 'jina-embeddings-v5');
    const verifyFn = result.chunks.find(c => c.includes('verifyPassword'));
    expect(verifyFn).toBeDefined();
    expect(verifyFn).toContain('bcrypt.compare');
    expect(verifyFn).not.toContain('handleUserLogin');
  });
});
```

---

## Phase Plan

```
Phase 1（P0 — MVP）：
  ├─ detectCodeLanguage()（JS/TS/Python）
  ├─ astChunk() — JS/TS only
  ├─ astChunk() — Python
  ├─ Unit tests（破壞案例 → 通過案例）
  └─ Config: astAwareCodeSplit default = true

Phase 2（P1）：
  ├─ Sub-split within oversized declarations（statement level）
  ├─ Go、Rust support
  └─ Benchmark: 向量品質 vs. character split

Phase 3（P2）：
  └─ Embedding quality evaluation（問答對比）
```

---

## Q&A

| Q | A |
|---|---|
| tree-sitter 值得嗎？ | **值得**。~1MB runtime，sub-ms parse，能處理巢狀結構/decorator/subclass，比 regex 精準一個數量級。 |
| 預設開？ | **預設開**。破壞案例太明確，等使用者手動開等於功能永遠不被用。`astAwareCodeSplit: false` 保留給需要復現舊行為的測試。 |
| 非主流語言？ | **Phase 1 fallback**。現有 sentence-ending split 對自然語言有效；非主流語言佔比低，Phase 1 fallback 合理。 |

---

## Reference

- Issue: https://github.com/CortexReach/memory-lancedb-pro/issues/692
- Reference impl: `zilliztech/claude-context` ast-splitter.ts
- Existing chunker: `src/chunker.ts` (284 lines)
