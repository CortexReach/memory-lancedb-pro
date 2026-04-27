import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

function getArg(flag, fallback = null) {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function normalizeAgentAccessMap(mapLike) {
  if (!mapLike || typeof mapLike !== "object") return {};
  const out = {};
  for (const agentId of Object.keys(mapLike).sort()) {
    const scopes = Array.isArray(mapLike[agentId]) ? mapLike[agentId] : [];
    const normalizedScopes = Array.from(
      new Set(
        scopes.filter((scope) => typeof scope === "string" && scope.trim().length > 0),
      ),
    );
    out[agentId] = normalizedScopes;
  }
  return out;
}

function diffAgentAccess(before, after) {
  const allAgents = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changes = [];

  for (const agentId of Array.from(allAgents).sort()) {
    const beforeScopes = before[agentId] || [];
    const afterScopes = after[agentId] || [];

    const removed = beforeScopes.filter((scope) => !afterScopes.includes(scope));
    const added = afterScopes.filter((scope) => !beforeScopes.includes(scope));

    if (added.length > 0 || removed.length > 0) {
      changes.push({
        agentId,
        beforeCount: beforeScopes.length,
        afterCount: afterScopes.length,
        added,
        removed,
      });
    }
  }

  return changes;
}

function writeJson(filePath, payload) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

const RETRIEVAL_KEYS = [
  "vectorWeight",
  "bm25Weight",
  "recencyHalfLifeDays",
  "recencyWeight",
  "hardMinScore",
];

function normalizeRetrieval(raw) {
  const out = {};
  for (const key of RETRIEVAL_KEYS) {
    const value = raw?.[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = value;
    }
  }
  return out;
}

function diffRetrieval(before, after) {
  const changed = {};
  for (const key of RETRIEVAL_KEYS) {
    if (before[key] !== after[key]) {
      changed[key] = {
        before: before[key] ?? null,
        after: after[key] ?? null,
      };
    }
  }
  return changed;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const defaultConfigPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
const configPath = path.resolve(
  getArg("--config", process.env.OPENCLAW_CONFIG_PATH || defaultConfigPath),
);
const policyPath = path.resolve(
  getArg("--scope-policy", path.join(__dirname, "dgg-2684-scope-policy.json")),
);
const beforeOutPath = getArg("--before-out");
const afterOutPath = getArg("--after-out");
const reportOutPath = getArg("--report-out");
const writeMode = hasFlag("--write");

const configTextBefore = fs.readFileSync(configPath, "utf8");
const config = JSON.parse(configTextBefore);
const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));

const pluginConfig = config?.plugins?.entries?.["memory-lancedb-pro"]?.config;
if (!pluginConfig) {
  throw new Error(`memory-lancedb-pro config not found in ${configPath}`);
}
if (!pluginConfig.scopes || typeof pluginConfig.scopes !== "object") {
  pluginConfig.scopes = {};
}
if (!pluginConfig.retrieval || typeof pluginConfig.retrieval !== "object") {
  pluginConfig.retrieval = {};
}

const policyAgentAccess = normalizeAgentAccessMap(policy?.agentAccess || {});
if (Object.keys(policyAgentAccess).length === 0) {
  throw new Error(`scope policy has no agentAccess entries: ${policyPath}`);
}
const policyRetrieval = normalizeRetrieval(policy?.retrieval || {});
if (Object.keys(policyRetrieval).length === 0) {
  throw new Error(`scope policy has no retrieval entries: ${policyPath}`);
}

const beforeAgentAccess = normalizeAgentAccessMap(pluginConfig.scopes.agentAccess || {});
const beforeRetrieval = normalizeRetrieval(pluginConfig.retrieval || {});

pluginConfig.scopes.agentAccess = policyAgentAccess;
pluginConfig.retrieval = {
  ...pluginConfig.retrieval,
  ...policyRetrieval,
};

const afterAgentAccess = normalizeAgentAccessMap(pluginConfig.scopes.agentAccess || {});
const afterRetrieval = normalizeRetrieval(pluginConfig.retrieval || {});

const configTextAfter = `${JSON.stringify(config, null, 2)}\n`;
if (writeMode) {
  fs.writeFileSync(configPath, configTextAfter, "utf8");
}

const changes = diffAgentAccess(beforeAgentAccess, afterAgentAccess);
const retrievalChanges = diffRetrieval(beforeRetrieval, afterRetrieval);

const beforeSnapshot = {
  generatedAt: new Date().toISOString(),
  policyVersion: policy?.version || null,
  source: "before",
  agentAccess: beforeAgentAccess,
  retrieval: beforeRetrieval,
};

const afterSnapshot = {
  generatedAt: new Date().toISOString(),
  policyVersion: policy?.version || null,
  source: "after",
  agentAccess: afterAgentAccess,
  retrieval: afterRetrieval,
};

const report = {
  generatedAt: new Date().toISOString(),
  policyVersion: policy?.version || null,
  writeApplied: writeMode,
  configPath,
  policyPath,
  changedAgentCount: changes.length,
  changedAgents: changes,
  unchangedAgentCount:
    Object.keys(afterAgentAccess).length - changes.length,
  retrievalBefore: beforeRetrieval,
  retrievalAfter: afterRetrieval,
  retrievalChangedKeys: Object.keys(retrievalChanges),
  retrievalChanges,
  configSha256Before: sha256(configTextBefore),
  configSha256After: sha256(configTextAfter),
};

writeJson(beforeOutPath, beforeSnapshot);
writeJson(afterOutPath, afterSnapshot);
writeJson(reportOutPath, report);

console.log(JSON.stringify(report, null, 2));
