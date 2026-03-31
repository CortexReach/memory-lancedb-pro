#!/usr/bin/env node
import { createWriteStream, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");
const { buildSmartMetadata, stringifySmartMetadata } = jiti("../src/smart-metadata.ts");

function parseArgs(argv) {
  const args = {
    dbPath: process.env.MEMORY_DB_PATH || "",
    vectorDim: Number(process.env.MEMORY_VECTOR_DIM || "1536"),
    scope: undefined,
    apply: false,
    limit: 1000,
    rollbackFile: "",
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db-path") args.dbPath = argv[++i] || "";
    else if (a === "--vector-dim") args.vectorDim = Number(argv[++i] || "1536");
    else if (a === "--scope") args.scope = argv[++i] || undefined;
    else if (a === "--apply") args.apply = true;
    else if (a === "--limit") args.limit = Number(argv[++i] || "1000");
    else if (a === "--rollback") args.rollbackFile = argv[++i] || "";
  }

  return args;
}

async function loadAllEntries(store, scopeFilter, limit) {
  const out = [];
  let offset = 0;
  const pageSize = 200;
  while (out.length < limit) {
    const page = await store.list(scopeFilter, undefined, Math.min(pageSize, limit - out.length), offset);
    if (!page.length) break;
    out.push(...page);
    offset += page.length;
    if (page.length < pageSize) break;
  }
  return out;
}

async function run() {
  const args = parseArgs(process.argv);
  if (!args.dbPath) {
    throw new Error("Missing --db-path (or MEMORY_DB_PATH)");
  }

  const store = new MemoryStore({
    dbPath: resolve(args.dbPath),
    vectorDim: Number.isFinite(args.vectorDim) ? args.vectorDim : 1536,
  });

  const scopeFilter = args.scope ? [args.scope] : undefined;

  if (args.rollbackFile) {
    const raw = readFileSync(resolve(args.rollbackFile), "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    let restored = 0;
    for (const line of lines) {
      const row = JSON.parse(line);
      await store.update(row.id, { metadata: row.metadata }, scopeFilter);
      restored++;
    }
    console.log(`Rollback complete. Restored ${restored} metadata entries.`);
    return;
  }

  const entries = await loadAllEntries(store, scopeFilter, args.limit);
  const changed = [];

  for (const entry of entries) {
    const normalized = buildSmartMetadata(entry, {});
    const next = stringifySmartMetadata(normalized);
    const prev = typeof entry.metadata === "string" ? entry.metadata : "{}";
    if (next !== prev) {
      changed.push({ id: entry.id, prev, next });
    }
  }

  if (!args.apply) {
    console.log(`Dry run complete. scanned=${entries.length} pending_updates=${changed.length}`);
    return;
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = resolve(`governance-migration-backup-${ts}.jsonl`);
  const backup = createWriteStream(backupPath, { flags: "wx" });

  let applied = 0;
  for (const row of changed) {
    backup.write(`${JSON.stringify({ id: row.id, metadata: row.prev })}\n`);
    await store.update(row.id, { metadata: row.next }, scopeFilter);
    applied++;
  }
  backup.end();

  console.log(`Migration complete. scanned=${entries.length} updated=${applied}`);
  console.log(`Rollback file: ${backupPath}`);
}

run().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
