// Debug script to trace Phase 1c behavior
// Uses jiti's require pattern (same as test file)
const { tmpdir } = require('os');
const { join } = require('path');
const { writeFile, mkdir } = require('fs/promises');

const jiti = require('jiti')(require.main.filename);

const { runImportMarkdown } = jiti(require('./cli.ts'));

let storedRecords = [];

const mockStore = {
  get storedRecords() { return storedRecords; },
  async store(entry) { storedRecords.push({ ...entry }); },
  async bulkStore(entries) { for (const e of entries) storedRecords.push({ ...e }); },
  async bm25Search(query, limit = 1, scopeFilter = []) {
    const q = query.toLowerCase();
    return storedRecords
      .filter(r => r.text.toLowerCase() === q)
      .slice(0, limit)
      .map(r => ({ entry: r }));
  },
  reset() { storedRecords.length = 0; }
};

const mockEmbedder = {
  embedQuery: async (text) => { const v = []; for (let i = 0; i < 384; i++) v.push(0); return v; },
  embedPassage: async (text) => { const v = []; for (let i = 0; i < 384; i++) v.push(0); return v; },
  embedBatchPassage: async (texts) => texts.map(t => { const v = []; for (let i = 0; i < 384; i++) v.push(0); return v; })
};

const mockRetriever = {
  async retrieve({ query, limit = 20 } = {}) {
    const q = query.toLowerCase();
    return storedRecords
      .filter(r => r.text.toLowerCase() === q)
      .slice(0, limit)
      .map(r => ({ entry: r, score: 1.0 }));
  }
};

async function main() {
  const testDir = join(tmpdir(), 'debug-phase1c-' + Date.now());
  await mkdir(testDir, { recursive: true });
  await writeFile(join(testDir, 'file1.md'), '- 買牛奶\n');
  await writeFile(join(testDir, 'file2.md'), '- 買牛奶\n');
  await writeFile(join(testDir, 'file3.md'), '- 買牛奶\n');
  await writeFile(join(testDir, 'file4.md'), '- 繳房租\n');

  console.log('\n=== Test: dedup=true ===');
  storedRecords = [];
  const result1 = await runImportMarkdown(
    { embedder: mockEmbedder, store: mockStore, retriever: mockRetriever },
    testDir,
    { dedup: true }
  );
  console.log('Result:', JSON.stringify(result1, null, 2));
  console.log('storedRecords:', storedRecords.length, storedRecords.map(r => r.text));

  console.log('\n=== Test: dedup=false ===');
  storedRecords = [];
  const result2 = await runImportMarkdown(
    { embedder: mockEmbedder, store: mockStore, retriever: mockRetriever },
    testDir,
    { dedup: false }
  );
  console.log('Result:', JSON.stringify(result2, null, 2));
  console.log('storedRecords:', storedRecords.length, storedRecords.map(r => r.text));
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
