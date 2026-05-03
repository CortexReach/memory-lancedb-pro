// Debug script with trace
const jiti = require('jiti')(__filename);
const { runImportMarkdown } = jiti('../../cli.ts');

const { tmpdir } = require('os');
const { join } = require('path');
const { writeFile, mkdir } = require('fs/promises');

let storedRecords = [];

const mockStore = {
  get storedRecords() { return storedRecords; },
  async store(entry) { storedRecords.push({ ...entry }); },
  async bulkStore(entries) { 
    console.log('[bulkStore] called with', entries.length, 'entries');
    for (const e of entries) storedRecords.push({ ...e }); 
  },
  async bm25Search(query, limit = 1, scopeFilter = []) {
    const q = query.toLowerCase();
    return storedRecords.filter(r => r.text.toLowerCase() === q).slice(0, limit).map(r => ({ entry: r }));
  },
  reset() { storedRecords.length = 0; }
};

const mockEmbedder = {
  embedQuery: async (text) => Array(384).fill(0),
  embedPassage: async (text) => Array(384).fill(0),
  embedBatchPassage: async (texts) => texts.map(() => Array(384).fill(0))
};

const mockRetriever = {
  async retrieve({ query, limit = 20 } = {}) {
    const q = query.toLowerCase();
    const hits = storedRecords.filter(r => r.text.toLowerCase() === q).slice(0, limit).map(r => ({ entry: r, score: 1.0 }));
    console.log('[retriever] query=', q, 'storedRecords=', storedRecords.length, storedRecords.map(r=>r.text), 'hits=', hits.length);
    return hits;
  }
};

async function main() {
  const testWsDir = join(tmpdir(), 'import-markdown-debug-' + Date.now());
  await mkdir(testWsDir, { recursive: true });
  
  const wsName = 'p1-test';
  const wsDir = join(testWsDir, 'workspace', wsName);
  await mkdir(wsDir, { recursive: true });
  
  const content = '- Buy milk\n- Buy milk\n- Buy milk\n- Pay rent\n';
  await writeFile(join(wsDir, 'MEMORY.md'), content, 'utf-8');
  
  const ctx = { embedder: mockEmbedder, store: mockStore, retriever: mockRetriever };
  
  console.log('\n=== Test: dedup=true ===');
  storedRecords = [];
  const result1 = await runImportMarkdown(ctx, wsName, { dedup: true, openclawHome: testWsDir, minTextLength: 2 });
  console.log('Result:', JSON.stringify(result1));
}

main().catch(e => { console.error(e); process.exit(1); });