// Inline expandDerivedWithBm25 to trace execution
async function expandDerivedWithBm25(derived, scopeFilter, store, api) {
  if (!derived.length) return derived;
  if (scopeFilter === undefined) return derived;
  const MAX_TOTAL = 16;
  const MAX_NEIGHBORS = MAX_TOTAL - derived.length;
  console.log(`MAX_TOTAL=${MAX_TOTAL}, MAX_NEIGHBORS=${MAX_NEIGHBORS}, derived.length=${derived.length}`);
  if (MAX_NEIGHBORS <= 0) return derived.slice(0, MAX_TOTAL);
  const seen = new Set();
  const neighbors = [];
  for (const derivedLine of derived) {
    if (neighbors.length >= MAX_NEIGHBORS) {
      console.log(`  BREAK outer at derived="${derivedLine}" neighbors=${neighbors.length}`);
      break;
    }
    try {
      const hits = await store.bm25Search(derivedLine, 2, scopeFilter, { excludeInactive: true });
      console.log(`  bm25Search("${derivedLine}") → ${hits.length} hits, neighbors before=${neighbors.length}`);
      for (const hit of hits) {
        if (neighbors.length >= MAX_NEIGHBORS) {
          console.log(`  BREAK inner at neighbors=${neighbors.length}`);
          break;
        }
        if (hit.entry.category === "reflection") continue;
        const text = (hit.entry.text || "").split("\n")[0].slice(0, 120);
        console.log(`    hit text: "${text}"`);
        if (seen.has(text)) continue;
        seen.add(text);
        neighbors.push(text);
      }
      console.log(`  after inner loop, neighbors=${neighbors.length}`);
    } catch (err) {
      api.logger.debug?.(`expandDerivedWithBm25: bm25Search failed: ${String(err)}`);
    }
  }
  const result = [...neighbors, ...derived].slice(0, MAX_TOTAL);
  console.log(`  final: neighbors=${neighbors.length}, derived=${derived.length}, result.length=${result.length}`);
  return result;
}

const mockStore = {
  async bm25Search(derivedLine) {
    return [
      { entry: { id: 'id-a', text: `neighbor for ${derivedLine} - a`, category: 'fact', scope: 'global' } },
      { entry: { id: 'id-b', text: `neighbor for ${derivedLine} - b`, category: 'fact', scope: 'global' } },
    ];
  }
};
const mockApi = { logger: { debug: () => {} } };

console.log('\n=== TEST 5: derived=6, MAX_NEIGHBORS=10 ===');
await expandDerivedWithBm25(['d1','d2','d3','d4','d5','d6'], ['global'], mockStore, mockApi);

console.log('\n=== TEST 6: null/undefined text ===');
const store6 = {
  async bm25Search() {
    return [
      { entry: { id: 'n1', text: null, category: 'fact', scope: 'global' } },
      { entry: { id: 'n2', text: undefined, category: 'fact', scope: 'global' } },
      { entry: { id: 'n3', text: 'valid text', category: 'fact', scope: 'global' } },
    ];
  }
};
const r6 = await expandDerivedWithBm25(['derived1'], ['global'], store6, mockApi);
console.log('Result:', r6);
console.log('Empty count:', r6.filter(t => t === '').length);
