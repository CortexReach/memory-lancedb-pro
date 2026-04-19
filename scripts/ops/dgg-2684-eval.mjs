import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const { MemoryStore } = jiti(path.join(repoRoot, "src/store.ts"));
const { createEmbedder } = jiti(path.join(repoRoot, "src/embedder.ts"));
const { createRetriever, DEFAULT_RETRIEVAL_CONFIG } = jiti(
  path.join(repoRoot, "src/retriever.ts"),
);
const { createDecayEngine, DEFAULT_DECAY_CONFIG } = jiti(
  path.join(repoRoot, "src/decay-engine.ts"),
);

function getArg(flag, fallback) {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const defaultConfigPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
const configPath = path.resolve(
  getArg("--config", process.env.OPENCLAW_CONFIG_PATH || defaultConfigPath),
);
const outDir = path.resolve(getArg("--out", path.join(repoRoot, "docs", "ops")));
const targetAgentId = getArg("--agent", process.env.OPENCLAW_AGENT_ID || "badtz-dev");
const policyPath = path.resolve(
  getArg("--scope-policy", path.join(__dirname, "dgg-2684-scope-policy.json")),
);

const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
const plugin = raw?.plugins?.entries?.["memory-lancedb-pro"]?.config;
if (!plugin) {
  throw new Error(`memory-lancedb-pro config not found in ${configPath}`);
}

const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
const policyAgentAccess = Array.isArray(policy?.agentAccess?.[targetAgentId])
  ? policy.agentAccess[targetAgentId].filter((scope) => typeof scope === "string" && scope.length > 0)
  : [];
const policyRetrieval =
  policy?.retrieval && typeof policy.retrieval === "object"
    ? policy.retrieval
    : {};

const dbPath = plugin.dbPath;
if (!dbPath) {
  throw new Error(`dbPath missing in memory-lancedb-pro config (${configPath})`);
}

const vectorDim = plugin.embedding?.dimensions ?? 1024;
const isRemote = /^s3:\/\//.test(dbPath);
const storageOptions = isRemote
  ? {
      region: process.env.MINIO_DEFAULT_REGION || "us-east-1",
      endpoint: process.env.MINIO_ENDPOINT || "http://192.168.50.46:9000",
      access_key_id: process.env.MINIO_ACCESS_KEY_ID || "minioadmin",
      secret_access_key: process.env.MINIO_SECRET_ACCESS_KEY || "minioadmin",
      allow_http: "true",
    }
  : undefined;

const store = new MemoryStore({ dbPath, vectorDim, storageOptions });
const embedder = createEmbedder({
  provider: "openai-compatible",
  apiKey: plugin.embedding?.apiKey,
  model: plugin.embedding?.model || "text-embedding-3-small",
  baseURL: plugin.embedding?.baseURL,
  dimensions: plugin.embedding?.dimensions,
  omitDimensions: plugin.embedding?.omitDimensions,
  taskQuery: plugin.embedding?.taskQuery,
  taskPassage: plugin.embedding?.taskPassage,
  normalized: plugin.embedding?.normalized,
  chunking: plugin.embedding?.chunking,
});

const decayEngine = createDecayEngine({
  ...DEFAULT_DECAY_CONFIG,
  ...(plugin.decay || {}),
});

const baseRetrieval = {
  ...DEFAULT_RETRIEVAL_CONFIG,
  ...(plugin.retrieval || {}),
};

const agentAccess = Array.from(
  new Set([
    ...((plugin.scopes?.agentAccess?.[targetAgentId] || [])),
    `agent:${targetAgentId}`,
    `reflection:${targetAgentId}`,
  ]),
);

const focusedAccess = Array.from(
  new Set([
    ...policyAgentAccess,
    `agent:${targetAgentId}`,
    `reflection:${targetAgentId}`,
  ]),
);

const variants = [
  {
    name: "baseline",
    retrieval: {
      ...baseRetrieval,
    },
    scopeFilter: agentAccess,
  },
  {
    name: "exp_recent",
    retrieval: {
      ...baseRetrieval,
      recencyWeight: 0.2,
      recencyHalfLifeDays: 7,
      timeDecayHalfLifeDays: 30,
      hardMinScore: Math.max(0.3, baseRetrieval.hardMinScore ?? 0.28),
    },
    scopeFilter: agentAccess,
  },
  {
    name: "exp_scope_hybrid",
    retrieval: {
      ...baseRetrieval,
      vectorWeight: Number(policyRetrieval.vectorWeight ?? 0.55),
      bm25Weight: Number(policyRetrieval.bm25Weight ?? 0.45),
      recencyWeight: Number(policyRetrieval.recencyWeight ?? 0.18),
      recencyHalfLifeDays: Number(policyRetrieval.recencyHalfLifeDays ?? 10),
      hardMinScore: Number(policyRetrieval.hardMinScore ?? 0.32),
    },
    scopeFilter: focusedAccess.length > 0 ? focusedAccess : agentAccess,
  },
];

const queries = [
  { query: "최근 작업", expectedScopes: ["dggd:ops", "role:dev", `agent:${targetAgentId}`] },
  { query: "오늘 작업", expectedScopes: ["dggd:ops", "role:dev", `agent:${targetAgentId}`] },
  { query: "DGG-2678 explanation card", expectedScopes: ["dggd:ops", "dggd:projects", `agent:${targetAgentId}`] },
  { query: "DGG-2679 packet bundle", expectedScopes: ["dggd:ops", "dggd:projects", `agent:${targetAgentId}`] },
  { query: "Agent run id required", expectedScopes: ["dggd:ops", `agent:${targetAgentId}`] },
  { query: "CI billing 차단", expectedScopes: ["dggd:ops", "dggd:projects"] },
  { query: "쿠로미 carryover", expectedScopes: ["dggd:ops", "dggd:projects"] },
  { query: "CTO 지시", expectedScopes: ["dggd:ops", "dggd:projects"] },
  { query: "scope:dggd:ops 최근 작업", expectedScopes: ["dggd:ops"] },
  { query: "scope:role:dev 최근 작업", expectedScopes: ["role:dev"] },
];

function normalizeText(s) {
  return String(s || "").toLowerCase();
}

function stripScopeTags(query) {
  return query
    .replace(/\bscope:[\w:-]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenized(query) {
  const q = stripScopeTags(query)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => token.length >= 2)
    .filter((token) => !["최근", "작업", "오늘"].includes(token));
  return Array.from(new Set(q));
}

function extractScopeTags(query) {
  return Array.from(query.matchAll(/\bscope:([\w:-]+)/gi)).map((m) => m[1]);
}

function labelResult(query, expectedScopes, result) {
  const text = normalizeText(result.entry?.text || "");
  const scope = result.entry?.scope || "";
  const tags = extractScopeTags(query);
  const tokens = tokenized(query);
  const tokenHit = tokens.some((token) => text.includes(token.toLowerCase()));
  const expectedScope = expectedScopes.includes(scope);

  if (tags.length > 0) {
    const tagMatch = tags.includes(scope);
    if (tagMatch && tokenHit)
      return { label: "relevant", reason: "scope-tag match + token hit" };
    if (tagMatch) return { label: "partial", reason: "scope-tag match" };
    return { label: "irrelevant", reason: "scope-tag mismatch" };
  }

  if (expectedScope && tokenHit)
    return { label: "relevant", reason: "scope+token" };
  if (expectedScope || tokenHit)
    return {
      label: "partial",
      reason: expectedScope ? "scope only" : "token only",
    };
  return { label: "irrelevant", reason: "no scope/token match" };
}

function escapeCsv(value) {
  const s = String(value ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function main() {
  const rows = [];
  const summary = [];

  for (const variant of variants) {
    const retriever = createRetriever(store, embedder, variant.retrieval, {
      decayEngine,
    });

    const started = Date.now();
    let rel = 0;
    let part = 0;
    let irr = 0;
    let total = 0;
    let leakage = 0;

    for (const q of queries) {
      const qStart = Date.now();
      const results = await retriever.retrieve({
        query: q.query,
        limit: 5,
        scopeFilter: variant.scopeFilter,
        source: "cli",
      });

      const top = results.slice(0, 5);
      for (let i = 0; i < top.length; i++) {
        const r = top[i];
        const { label, reason } = labelResult(q.query, q.expectedScopes, r);
        if (label === "relevant") rel += 1;
        else if (label === "partial") part += 1;
        else irr += 1;
        total += 1;
        if (!q.expectedScopes.includes(r.entry.scope)) leakage += 1;

        rows.push({
          variant: variant.name,
          query: q.query,
          rank: i + 1,
          score: Number(r.score?.toFixed?.(4) ?? r.score ?? 0),
          id: r.entry.id,
          scope: r.entry.scope,
          category: r.entry.category,
          label,
          reason,
          text: (r.entry.text || "").replace(/\s+/g, " ").slice(0, 180),
          elapsedMs: Date.now() - qStart,
        });
      }

      if (top.length === 0) {
        for (let m = 0; m < 5; m++) {
          rows.push({
            variant: variant.name,
            query: q.query,
            rank: m + 1,
            score: 0,
            id: "",
            scope: "",
            category: "",
            label: "irrelevant",
            reason: "no result",
            text: "",
            elapsedMs: Date.now() - qStart,
          });
        }
        total += 5;
        irr += 5;
        leakage += 5;
      } else if (top.length < 5) {
        const missing = 5 - top.length;
        for (let m = 0; m < missing; m++) {
          rows.push({
            variant: variant.name,
            query: q.query,
            rank: top.length + m + 1,
            score: 0,
            id: "",
            scope: "",
            category: "",
            label: "irrelevant",
            reason: "missing",
            text: "",
            elapsedMs: Date.now() - qStart,
          });
        }
        total += missing;
        irr += missing;
        leakage += missing;
      }
    }

    summary.push({
      variant: variant.name,
      weightedPrecisionAt5: Number(((rel + part * 0.5) / total).toFixed(4)),
      relevantRate: Number((rel / total).toFixed(4)),
      partialRate: Number((part / total).toFixed(4)),
      irrelevantRate: Number((irr / total).toFixed(4)),
      scopeLeakageRate: Number((leakage / total).toFixed(4)),
      totalRows: total,
      elapsedSec: Number(((Date.now() - started) / 1000).toFixed(1)),
      appliedRetrieval: {
        vectorWeight: variant.retrieval.vectorWeight,
        bm25Weight: variant.retrieval.bm25Weight,
        recencyHalfLifeDays: variant.retrieval.recencyHalfLifeDays,
        recencyWeight: variant.retrieval.recencyWeight,
        hardMinScore: variant.retrieval.hardMinScore,
      },
      scopeFilterUsed: variant.scopeFilter,
      scopePolicyPath: policyPath,
      scopePolicyVersion: policy?.version || null,
    });
  }

  fs.mkdirSync(outDir, { recursive: true });

  const csvHeaders = [
    "variant",
    "query",
    "rank",
    "score",
    "id",
    "scope",
    "category",
    "label",
    "reason",
    "text",
    "elapsedMs",
  ];

  const csv = [csvHeaders.join(",")]
    .concat(rows.map((row) => csvHeaders.map((h) => escapeCsv(row[h])).join(",")))
    .join("\n");

  const csvPath = path.join(outDir, "memory-tuning-2026-04-baseline.csv");
  const summaryPath = path.join(outDir, "memory-tuning-2026-04-summary.json");
  fs.writeFileSync(csvPath, csv, "utf8");
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  console.log(
    JSON.stringify(
      {
        configPath,
        outDir,
        csvPath,
        summaryPath,
        agent: targetAgentId,
        scopePolicyPath: policyPath,
        summary,
        csvRows: rows.length,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
