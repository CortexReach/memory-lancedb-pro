import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const {
  CanonicalCorpusIndexer,
  parseCanonicalCorpusConfig,
  parseCanonicalCorpusMetadata,
} = jiti("../src/corpus-indexer.ts");

const tempRoot = mkdtempSync(path.join(tmpdir(), "memory-corpus-indexer-"));
const homeDir = path.join(tempRoot, "home");
const workspaceDir = path.join(tempRoot, "workspace");
const memoryDir = path.join(workspaceDir, "memory");
const dreamingDir = path.join(memoryDir, "dreaming");
const sessionsDir = path.join(homeDir, ".openclaw", "agents", "main", "sessions");

mkdirSync(dreamingDir, { recursive: true });
mkdirSync(sessionsDir, { recursive: true });

writeFileSync(path.join(workspaceDir, "MEMORY.md"), "# Memory\n\nThe user prefers grounded citations.\n", "utf8");
writeFileSync(path.join(workspaceDir, "SECRET.md"), "secret outside memory dir\n", "utf8");
writeFileSync(path.join(memoryDir, "2026-05-23.md"), "## Daily\n\nOpenClaw memory slot is LanceDB-owned.\n", "utf8");
writeFileSync(path.join(dreamingDir, "nightly.md"), "## Dream\n\nPromote repeated TypeScript lessons.\n", "utf8");
writeFileSync(
  path.join(sessionsDir, "session-a.jsonl"),
  [
    JSON.stringify({ message: { role: "user", content: "Remember the public artifact contract." } }),
    JSON.stringify({ message: { role: "assistant", content: [{ text: "I will ground results with paths and lines." }] } }),
    "",
  ].join("\n"),
  "utf8",
);

function createCaptureStore() {
  const entries = [];
  const byId = new Map();
  return {
    entries,
    byId,
    store: {
      async upsert(entry) {
        entries.push(entry);
        byId.set(entry.id, entry);
        return entry;
      },
      async deleteExactId(id) {
        return byId.delete(id);
      },
      async listCorpusEntryRefs() {
        return [...byId.values()].map((entry) => ({
          id: entry.id,
          scope: entry.scope,
          metadata: entry.metadata,
        }));
      },
    },
  };
}

const captured = createCaptureStore();
const indexer = new CanonicalCorpusIndexer({
  store: captured.store,
  embedder: {
    async embedPassage(text) {
      return [text.length, 1, 0, 0];
    },
  },
  getConfig: () => parseCanonicalCorpusConfig({
    syncIntervalMs: 60_000,
    maxSessionFilesPerAgent: 5,
  }),
  getOpenClawConfig: () => ({
    agents: {
      defaults: {
        workspace: workspaceDir,
      },
    },
  }),
  homeDir,
});

const discovered = await indexer.discover();
assert.equal(discovered.length, 4, "indexer should discover memory files, dream artifacts, and session transcripts");
assert.ok(discovered.some((doc) => doc.kind === "dream-report"), "dream reports should be classified explicitly");
assert.ok(discovered.some((doc) => doc.source === "sessions"), "session transcripts should be indexed as session source");

const stats = await indexer.sync({ reason: "test", force: true });
assert.deepEqual(
  {
    documents: stats.documents,
    chunks: stats.chunks,
    indexed: stats.indexed,
    skipped: stats.skipped,
    staleDeleted: stats.staleDeleted,
  },
  { documents: 4, chunks: 4, indexed: 4, skipped: 0, staleDeleted: 0 },
);
assert.equal(captured.byId.size, 4, "sync should upsert one LanceDB entry per canonical chunk");
assert.ok(captured.entries.every((entry) => entry.id.startsWith("corpus:")), "canonical entries should use deterministic corpus IDs");

const dreamEntry = captured.entries.find((entry) => entry.text.includes("Promote repeated TypeScript lessons"));
assert.equal(dreamEntry.category, "reflection", "dream report entries should use reflection category");
assert.equal(dreamEntry.scope, "global", "main-agent canonical entries should be globally visible");
assert.equal(parseCanonicalCorpusMetadata(dreamEntry.metadata).kind, "dream-report");

const sessionEntry = captured.entries.find((entry) => parseCanonicalCorpusMetadata(entry.metadata)?.source === "sessions");
const sessionMetadata = parseCanonicalCorpusMetadata(sessionEntry.metadata);
assert.equal(sessionMetadata.path, "sessions/main/session-a.jsonl");
assert.ok(sessionEntry.text.includes("## user"), "session JSONL should render role headings");
assert.ok(sessionEntry.text.includes("public artifact contract"), "session JSONL should preserve message text");

const dreamRead = await indexer.readFile("memory/dreaming/nightly.md", 2, 1);
assert.deepEqual(dreamRead, {
  text: "",
  path: "memory/dreaming/nightly.md",
  from: 2,
  lines: 1,
  truncated: true,
  nextFrom: 3,
});

const sessionRead = await indexer.readFile("sessions/main/session-a.jsonl", 1, 2);
assert.equal(sessionRead.path, "sessions/main/session-a.jsonl");
assert.ok(sessionRead.text.includes("## user"));
assert.equal(sessionRead.truncated, true);

const coldIndexer = new CanonicalCorpusIndexer({
  store: createCaptureStore().store,
  embedder: { async embedPassage() { return [0, 0, 0, 0]; } },
  getConfig: () => parseCanonicalCorpusConfig({}),
  getOpenClawConfig: () => ({ agents: { defaults: { workspace: workspaceDir } } }),
  homeDir,
});
const coldSessionRead = await coldIndexer.readFile("sessions/main/session-a.jsonl", 1, 1);
assert.equal(coldSessionRead.path, "sessions/main/session-a.jsonl");
assert.ok(coldSessionRead.text.includes("## user"));
assert.equal(
  await coldIndexer.readFile("memory/../SECRET.md", 1, 1),
  null,
  "readFile should reject memory path traversal above the memory directory",
);
assert.equal(
  await coldIndexer.readFile("memory/dreaming/../../SECRET.md", 1, 1),
  null,
  "readFile should reject deeper traversal that resolves outside the memory directory",
);
assert.equal(
  await coldIndexer.readFile(path.join(workspaceDir, "MEMORY.md"), 1, 1),
  null,
  "readFile should reject absolute filesystem paths",
);
assert.equal(
  await coldIndexer.readFile("sessions/main/../session-a.jsonl", 1, 1),
  null,
  "readFile should reject traversal in virtual session paths",
);

const secondSync = await indexer.sync({ reason: "interval-check" });
assert.deepEqual(
  secondSync,
  { documents: 0, chunks: 0, indexed: 0, skipped: 0, staleDeleted: 0, errors: [] },
  "sync interval should avoid redundant indexing",
);

const largeWorkspaceDir = path.join(tempRoot, "large-workspace");
const largeMemoryDir = path.join(largeWorkspaceDir, "memory");
mkdirSync(largeMemoryDir, { recursive: true });
const largeFilePath = path.join(largeMemoryDir, "large.md");
writeFileSync(
  largeFilePath,
  Array.from({ length: 220 }, (_, index) =>
    `Line ${String(index + 1).padStart(3, "0")} has grounded corpus chunk text for semantic recall.`,
  ).join("\n"),
  "utf8",
);

const largeCapture = createCaptureStore();
const largeIndexer = new CanonicalCorpusIndexer({
  store: largeCapture.store,
  embedder: {
    async embedPassage(text) {
      assert.ok(text.length <= 4_000, "corpus indexer should embed bounded chunks, not whole large files");
      return [text.length, 2, 0, 0];
    },
  },
  getConfig: () => parseCanonicalCorpusConfig({
    maxSessionFilesPerAgent: 0,
    syncIntervalMs: 0,
  }),
  getOpenClawConfig: () => ({ agents: { defaults: { workspace: largeWorkspaceDir } } }),
  homeDir,
});

const largeStats = await largeIndexer.sync({ reason: "large-file-test", force: true });
assert.equal(largeStats.documents, 1);
assert.ok(largeStats.chunks > 1, "large canonical files should be split into multiple indexed chunks");
assert.equal(largeStats.indexed, largeStats.chunks);
const largeEntries = [...largeCapture.byId.values()];
const largeMetadata = largeEntries.map((entry) => parseCanonicalCorpusMetadata(entry.metadata));
assert.deepEqual(
  largeMetadata.map((metadata) => metadata.chunkIndex),
  Array.from({ length: largeEntries.length }, (_, index) => index),
  "chunk metadata should preserve deterministic chunk ordering",
);
assert.ok(
  largeMetadata.every((metadata, index) =>
    metadata.path === "memory/large.md" &&
    metadata.startLine <= metadata.endLine &&
    metadata.snippet === largeEntries[index].text
  ),
  "chunk metadata should preserve grounded path, line range, and snippet text",
);
assert.ok(
  largeMetadata[0].endLine < largeMetadata.at(-1).endLine,
  "chunk line ranges should advance through the source file",
);

renameSync(largeFilePath, path.join(largeMemoryDir, "large.md.gone"));
const staleStats = await largeIndexer.sync({ reason: "stale-cleanup-test", force: true });
assert.equal(staleStats.documents, 0);
assert.equal(staleStats.staleDeleted, largeEntries.length, "stale cleanup should delete corpus rows for deleted source files");
assert.equal(largeCapture.byId.size, 0, "deleted source files should not remain recallable through old corpus rows");

const workspaceA = path.join(tempRoot, "workspace-a");
const workspaceB = path.join(tempRoot, "workspace-b");
mkdirSync(path.join(workspaceA, "memory"), { recursive: true });
mkdirSync(path.join(workspaceB, "memory"), { recursive: true });
writeFileSync(path.join(workspaceA, "memory", "shared.md"), "workspace A memory\n", "utf8");
writeFileSync(path.join(workspaceB, "memory", "shared.md"), "workspace B memory\n", "utf8");

const multiWorkspaceIndexer = new CanonicalCorpusIndexer({
  store: createCaptureStore().store,
  embedder: { async embedPassage(text) { return [text.length, 3, 0, 0]; } },
  getConfig: () => parseCanonicalCorpusConfig({
    maxSessionFilesPerAgent: 0,
    syncIntervalMs: 0,
  }),
  getOpenClawConfig: () => ({
    agents: {
      list: [
        { id: "agent-a", workspace: workspaceA },
        { id: "agent-b", workspace: workspaceB },
      ],
    },
  }),
  homeDir,
});

await multiWorkspaceIndexer.sync({ reason: "multi-workspace-cache-test", force: true });
const readB = await multiWorkspaceIndexer.readFile("memory/shared.md", 1, 1, workspaceB);
assert.equal(readB.text, "workspace B memory", "workspace-aware readFile should resolve the requested workspace path");
const readA = await multiWorkspaceIndexer.readFile("memory/shared.md", 1, 1, workspaceA);
assert.equal(readA.text, "workspace A memory", "workspace-aware path cache should not cross-wire same relPath in another workspace");
assert.equal(
  await multiWorkspaceIndexer.readFile("memory/shared.md", 1, 1),
  null,
  "ambiguous multi-workspace reads without workspaceDir should not pick a stale relPath cache entry",
);

console.log("OK: canonical corpus indexer test passed");
