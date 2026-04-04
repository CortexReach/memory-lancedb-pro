# B-1 v3 Implementation Task

## Repository
- Path: `C:\Users\admin\Desktop\b1-v3-fix`
- Branch: `feat/proposal-b1-v3-fix` (created from current master)
- DO NOT push, DO NOT create PR. Just implement and commit locally.

## Feature Goal
Implement "Proposal B Phase 1: Scope-aware BM25 neighbor expansion for reflection derived slices" in `index.ts`, inside the `loadAgentReflectionSlices` function.

## Current State (main branch)
The `loadAgentReflectionSlices` function is at approximately index.ts line 1954-1990. It currently:
1. Checks cache (15s TTL)
2. Lists `reflection` category entries from store
3. Falls back to uncategorized entries if both invariants and derived are empty
4. Returns `{ updatedAt, invariants, derived }`
5. The `derived` array contains base derived lines (strings)

The prompt builder at ~line 3207-3215 uses `derivedLines.slice(0, 6)` — only first 6 items.

## The 3 Issues to Fix (from review)

### Issue 1: Neighbors clipped before reaching prompt [CRITICAL]
**Problem**: B-1 appends neighbors to the end of the derived array: `[...derived, ...expandedDerived].slice(0, 16)`. But the prompt builder only reads `derivedLines.slice(0, 6)`. When base derived already has 6+ items, zero neighbors reach the prompt — the feature is a silent no-op.

**Fix**: Insert neighbors BEFORE the base derived items in the returned array, so `.slice(0, 6)` captures neighbors first. OR: change the returned structure to distinguish base vs expanded. The key is: when prompt does `.slice(0, 6)`, neighbors must be included.

### Issue 2: BM25 can self-match reflection rows [MAJOR]
**Problem**: `store.bm25Search(derivedLine, 2, scopeFilter, { excludeInactive: true })` searches the general table without category filter. It can return the originating reflection entries themselves, consuming slots with duplicate text.

**Fix**: After getting bm25Hits, filter out entries whose `entry.metadata?.type` is "reflection" (or equivalent). The originating entries have the same agentId and similar text — they should be excluded from neighbors.

### Issue 3: Tests validate local reimplementation [MAJOR]
**Problem**: `test/b1-bm25-expansion.test.mjs` defines a standalone `applyBm25Expansion()` function that replicates the logic — but it's NOT the actual production code path. Tests pass while production fails silently.

**Fix**: Either:
- (A) Test the actual `loadAgentReflectionSlices` function (requires full async/store mocking), OR
- (B) Keep the isolated test but rename/refactor so the test function IS the actual exported production function (e.g., extract B-1 logic into a named exportable async function that both the production code and tests use)

Option B is cleaner: extract the BM25 expansion logic into a separate async function `expandDerivedWithBm25(derived, scopeFilter, store, api, logger)` that is exported and used in both production and tests.

## Required Defenses (keep from v2)
| Defense | Content |
|---------|---------|
| D1 | `seen = new Set()` empty init (not preloaded) |
| D2 | `scopeFilter !== undefined` guard |
| D3 | Cap at 16 total |
| D4 | Truncate to first line, 120 chars |
| D6 | Merge (expand, not replace) — but neighbors before base |
| Fail-safe | bm25Search errors caught, don't crash |

## Implementation Steps

1. **Extract B-1 logic** into an exported async function `expandDerivedWithBm25(derived, scopeFilter, store, api)` in `index.ts` (or a nearby module)
2. **Call it** inside `loadAgentReflectionSlices` after getting base `derived`
3. **Fix neighbor ordering**: return `[...expandedNeighbors, ...derived].slice(0, 16)` so `.slice(0, 6)` in prompt builder captures neighbors
4. **Fix self-match**: filter out `category: "reflection"` entries from bm25Hits
5. **Update or create** `test/b1-bm25-expansion.test.mjs` to import and test the actual production function
6. **Register test in `package.json`** `npm test` script
7. **Run `npm test`** locally to verify — all tests must pass
8. **Commit** with message: `feat(B-1): Scope-aware BM25 neighbor expansion for reflection slices (v3)`

## Verification Checklist (MUST complete before reporting done)
- [ ] `npm test` passes locally (no CI needed)
- [ ] Issue 1 verified: neighbors appear BEFORE base derived in returned array
- [ ] Issue 2 verified: bm25Search results filtered to exclude `category: "reflection"`
- [ ] Issue 3 verified: test file imports the actual production function, not a local copy
- [ ] All 6 Defenses (D1/D2/D3/D4/D6/Fail-safe) still pass
- [ ] `package-lock.json` has no unrelated changes

## Notes
- Use繁體中文 commit messages
- Keep the rest of `loadAgentReflectionSlices` unchanged (cache logic, fallback logic, etc.)
- The `scopeFilter` check (`scopeFilter !== undefined`) must remain
- The 15s cache TTL must remain
- Do NOT modify package.json version — that's handled by CI
