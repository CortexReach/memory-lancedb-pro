import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

const entries = [];
const indexer = new CanonicalCorpusIndexer({
  store: {
    async upsert(entry) {
      entries.push(entry);
      return entry;
    },
  },
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
  { documents: stats.documents, indexed: stats.indexed, skipped: stats.skipped },
  { documents: 4, indexed: 4, skipped: 0 },
);
assert.equal(entries.length, 4, "sync should upsert one LanceDB entry per canonical document");
assert.ok(entries.every((entry) => entry.id.startsWith("corpus:")), "canonical entries should use deterministic corpus IDs");

const dreamEntry = entries.find((entry) => entry.text.includes("Promote repeated TypeScript lessons"));
assert.equal(dreamEntry.category, "reflection", "dream report entries should use reflection category");
assert.equal(dreamEntry.scope, "global", "main-agent canonical entries should be globally visible");
assert.equal(parseCanonicalCorpusMetadata(dreamEntry.metadata).kind, "dream-report");

const sessionEntry = entries.find((entry) => parseCanonicalCorpusMetadata(entry.metadata)?.source === "sessions");
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
  store: { async upsert(entry) { return entry; } },
  embedder: { async embedPassage() { return [0, 0, 0, 0]; } },
  getConfig: () => parseCanonicalCorpusConfig({}),
  getOpenClawConfig: () => ({ agents: { defaults: { workspace: workspaceDir } } }),
  homeDir,
});
const coldSessionRead = await coldIndexer.readFile("sessions/main/session-a.jsonl", 1, 1);
assert.equal(coldSessionRead.path, "sessions/main/session-a.jsonl");
assert.ok(coldSessionRead.text.includes("## user"));

const secondSync = await indexer.sync({ reason: "interval-check" });
assert.deepEqual(
  secondSync,
  { documents: 0, indexed: 0, skipped: 0, errors: [] },
  "sync interval should avoid redundant indexing",
);

console.log("OK: canonical corpus indexer test passed");
