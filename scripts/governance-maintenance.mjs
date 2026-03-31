#!/usr/bin/env node
import { resolve } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");
const { parseSmartMetadata, stringifySmartMetadata } = jiti("../src/smart-metadata.ts");

function parseArgs(argv) {
  const args = {
    dbPath: process.env.MEMORY_DB_PATH || "",
    vectorDim: Number(process.env.MEMORY_VECTOR_DIM || "1536"),
    scope: undefined,
    apply: false,
    pendingDays: 30,
    limit: 1000,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db-path") args.dbPath = argv[++i] || "";
    else if (a === "--vector-dim") args.vectorDim = Number(argv[++i] || "1536");
    else if (a === "--scope") args.scope = argv[++i] || undefined;
    else if (a === "--apply") args.apply = true;
    else if (a === "--pending-days") args.pendingDays = Number(argv[++i] || "30");
    else if (a === "--limit") args.limit = Number(argv[++i] || "1000");
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

function normalizeKey(text) {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

async function run() {
  const args = parseArgs(process.argv);
  if (!args.dbPath) throw new Error("Missing --db-path (or MEMORY_DB_PATH)");

  const store = new MemoryStore({
    dbPath: resolve(args.dbPath),
    vectorDim: Number.isFinite(args.vectorDim) ? args.vectorDim : 1536,
  });
  const scopeFilter = args.scope ? [args.scope] : undefined;
  const entries = await loadAllEntries(store, scopeFilter, args.limit);

  const now = Date.now();
  const pendingCutoff = now - Math.max(1, args.pendingDays) * 24 * 60 * 60 * 1000;

  const toArchivePending = [];
  const canonicalByKey = new Map();
  const duplicateCandidates = [];

  for (const entry of entries) {
    const meta = parseSmartMetadata(entry.metadata, entry);

    if (meta.state === "pending" && entry.timestamp < pendingCutoff) {
      toArchivePending.push(entry.id);
    }

    if (meta.state === "archived") continue;
    const key = `${meta.memory_category}:${normalizeKey(meta.l0_abstract || entry.text)}`;
    const existing = canonicalByKey.get(key);
    if (!existing) {
      canonicalByKey.set(key, entry);
      continue;
    }
    const keep = existing.timestamp >= entry.timestamp ? existing : entry;
    const drop = keep.id === existing.id ? entry : existing;
    canonicalByKey.set(key, keep);
    duplicateCandidates.push({ duplicateId: drop.id, canonicalId: keep.id });
  }

  if (!args.apply) {
    console.log(`Dry run summary:`);
    console.log(`- scanned: ${entries.length}`);
    console.log(`- stale pending -> archive: ${toArchivePending.length}`);
    console.log(`- duplicate compact candidates: ${duplicateCandidates.length}`);
    return;
  }

  let archivedPending = 0;
  for (const id of toArchivePending) {
    const existing = await store.getById(id, scopeFilter);
    if (!existing) continue;
    const meta = parseSmartMetadata(existing.metadata, existing);
    meta.state = "archived";
    meta.memory_layer = "archive";
    meta.archive_reason = "pending_timeout";
    meta.archived_at = now;
    await store.update(id, { metadata: stringifySmartMetadata(meta) }, scopeFilter);
    archivedPending++;
  }

  let compacted = 0;
  for (const row of duplicateCandidates) {
    const existing = await store.getById(row.duplicateId, scopeFilter);
    if (!existing) continue;
    const meta = parseSmartMetadata(existing.metadata, existing);
    meta.state = "archived";
    meta.memory_layer = "archive";
    meta.archive_reason = "compact_duplicate";
    meta.canonical_id = row.canonicalId;
    meta.archived_at = now;
    await store.update(row.duplicateId, { metadata: stringifySmartMetadata(meta) }, scopeFilter);
    compacted++;
  }

  console.log(`Maintenance complete:`);
  console.log(`- scanned: ${entries.length}`);
  console.log(`- archived pending: ${archivedPending}`);
  console.log(`- compacted duplicates: ${compacted}`);
}

run().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
