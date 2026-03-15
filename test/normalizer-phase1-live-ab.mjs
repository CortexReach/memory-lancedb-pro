import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

function embedText(text, dim = 48) {
  const vector = Array(dim).fill(0);
  const tokens = String(text).toLowerCase().match(/[a-z0-9\u4e00-\u9fff._/-]+/g) || [];
  for (const token of tokens) {
    let hash = 0;
    for (const char of token) hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
    vector[hash % dim] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm > 0 ? vector.map((value) => value / norm) : vector;
}

function getEnv(name) {
  const value = process.env[name];
  return value || "";
}

function readAudit(logPath) {
  if (!existsSync(logPath)) return [];
  const lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
  return lines.map((line) => JSON.parse(line));
}

function noiseLike(text) {
  return /^(好的|明白了|收到|我确认了|好[的吧]?|okay|ok|understood|got it)/i.test(text)
    || /要不要我|do you want me to|我现在|顺手|继续处理/.test(text);
}

function topHitMatches(result, expected) {
  const text = result?.entry?.text || "";
  return expected.some((snippet) => text.includes(snippet));
}

function countNoiseInResults(results) {
  return results.filter((item) => noiseLike(item.entry.text)).length;
}

const CASES = [
  {
    id: "proxy-wrapper",
    role: "assistant",
    content: "决定：之后 Codex ACP 固定通过 acpx-with-proxy 走代理 7897，避免 websocket 超时。",
    queries: [
      { q: "Codex ACP 代理包装器", expected: ["acpx-with-proxy", "7897"] },
      { q: "acpx-with-proxy", expected: ["acpx-with-proxy"] },
    ],
    anchors: ["acpx-with-proxy", "7897", "websocket"],
  },
  {
    id: "reporting-preference",
    role: "user",
    content: "记住：我希望进度汇报里直接给结论，不要太散。",
    queries: [
      { q: "汇报偏好", expected: ["进度汇报里直接给结论"] },
    ],
    anchors: ["进度汇报", "结论"],
  },
  {
    id: "gateway-path",
    role: "user",
    content: "重要：Gateway PATH 少了 node bin 会导致 skill eligibility 偏差。",
    queries: [
      { q: "Gateway PATH node bin", expected: ["Gateway PATH 少了 node bin"] },
      { q: "skill eligibility 偏差", expected: ["skill eligibility 偏差"] },
    ],
    anchors: ["Gateway", "PATH", "node bin", "skill eligibility"],
  },
  {
    id: "polling-stall",
    role: "assistant",
    content: "重要：Polling stall detected (no getUpdates for 96.36s); forcing restart",
    queries: [
      { q: "Polling stall detected", expected: ["Polling stall detected"] },
      { q: "getUpdates forcing restart", expected: ["getUpdates", "forcing restart"] },
    ],
    anchors: ["Polling stall detected", "getUpdates", "forcing restart"],
  },
  {
    id: "metadata-decision",
    role: "assistant",
    content: "决定：P3 先用 metadata 承载原子记忆。",
    queries: [
      { q: "metadata 承载原子记忆", expected: ["metadata 承载原子记忆"] },
    ],
    anchors: ["P3", "metadata", "原子记忆"],
  },
  {
    id: "runtime-modelauth",
    role: "assistant",
    content: "决定：lossless-claw 在 OpenClaw 2026.3.8 缺 runtime.modelAuth，所以先走 legacy auth-profiles fallback。",
    queries: [
      { q: "runtime.modelAuth", expected: ["runtime.modelAuth"] },
      { q: "lossless-claw fallback", expected: ["legacy auth-profiles fallback"] },
    ],
    anchors: ["lossless-claw", "runtime.modelAuth", "legacy auth-profiles fallback"],
  },
  {
    id: "allowlist-miss",
    role: "assistant",
    content: "重要：exec denied: allowlist miss 的原因是 tools.exec.security 默认还是 allowlist，改成 full 即可。",
    queries: [
      { q: "allowlist miss", expected: ["allowlist miss"] },
      { q: "tools.exec.security full", expected: ["tools.exec.security", "full"] },
    ],
    anchors: ["allowlist miss", "tools.exec.security", "full"],
  },
  {
    id: "eisdir",
    role: "assistant",
    content: "重要：read failed: EISDIR 是因为把目录当文件读了，不是权限问题。",
    queries: [
      { q: "EISDIR 目录 read", expected: ["EISDIR"] },
    ],
    anchors: ["EISDIR", "目录", "文件"],
  },
  {
    id: "minimax-rpm",
    role: "assistant",
    content: "重要：MiniMax-M2.5 的 429 rate limit exceeded(RPM) (1002) 是频率限制，不是余额不足。",
    queries: [
      { q: "RPM 1002", expected: ["RPM", "1002"] },
      { q: "MiniMax 余额不足 频率限制", expected: ["频率限制", "余额不足"] },
    ],
    anchors: ["MiniMax-M2.5", "RPM", "1002", "余额不足"],
  },
  {
    id: "practice-principle",
    role: "assistant",
    content: "重要原则：实践优先，准备充分后大胆尝试，不要长期停留在保守观望。要不要我现在顺手把实验方案也落下来？",
    queries: [
      { q: "实践优先 原则", expected: ["实践优先"] },
    ],
    anchors: ["实践优先", "大胆尝试", "保守观望"],
  },
];

async function main() {
  const { MemoryStore } = jiti("../src/store.ts");
  const { createRetriever } = jiti("../src/retriever.ts");
  const { extractAutoCaptureCandidates, storeAutoCaptureCandidates, normalizeAndStoreAutoCaptureCandidates } = jiti("../src/auto-capture.ts");
  const { createMemoryNormalizer } = jiti("../src/normalizer.ts");

  const workDir = mkdtempSync(path.join(tmpdir(), "memory-lancedb-pro-phase1-ab-"));
  const rawDbPath = path.join(workDir, "raw-db");
  const normalizedDbPath = path.join(workDir, "normalized-db");
  const auditPath = path.join(workDir, "normalizer-audit.jsonl");

  try {
    const storeRaw = new MemoryStore({ dbPath: rawDbPath, vectorDim: 48 });
    const storeNormalized = new MemoryStore({ dbPath: normalizedDbPath, vectorDim: 48 });
    const embedder = {
      async embedPassage(text) { return embedText(text); },
      async embedQuery(text) { return embedText(text); },
    };
    const retrieverRaw = createRetriever(storeRaw, embedder, {
      mode: "vector",
      rerank: "none",
      minScore: 0.1,
      hardMinScore: 0.05,
      filterNoise: false,
    });
    const retrieverNormalized = createRetriever(storeNormalized, embedder, {
      mode: "vector",
      rerank: "none",
      minScore: 0.1,
      hardMinScore: 0.05,
      filterNoise: false,
    });

    const apiKey = getEnv("MEMORY_NORMALIZER_API_KEY");
    if (!apiKey) {
      console.log("SKIP: normalizer phase1 live A/B requires MEMORY_NORMALIZER_API_KEY");
      return;
    }

    const normalizer = createMemoryNormalizer({
      enabled: true,
      apiKey,
      model: process.env.MEMORY_NORMALIZER_MODEL || "Qwen/Qwen3-8B",
      baseURL: process.env.MEMORY_NORMALIZER_BASE_URL || "https://api.siliconflow.cn/v1/chat/completions",
      temperature: 0.1,
      maxTokens: 1200,
      enableThinking: false,
      timeoutMs: 12000,
      maxEntriesPerCandidate: 3,
      fallbackMode: "rules-then-raw",
      audit: {
        enabled: true,
        logPath: auditPath,
      },
    }, console);

    const rawStored = [];
    const normalizedStored = [];
    const perCase = [];

    for (const item of CASES) {
      const messages = [{ role: item.role, content: item.content }];
      const candidates = extractAutoCaptureCandidates(messages, { captureAssistant: true });
      assert(candidates.length >= 1, `Expected candidate for case ${item.id}`);

      const rawEntries = await storeAutoCaptureCandidates({
        candidates,
        store: storeRaw,
        embedder,
        scope: "global",
        importance: 0.7,
        limit: 3,
      });

      const normalizedEntries = await normalizeAndStoreAutoCaptureCandidates({
        candidates,
        store: storeNormalized,
        embedder,
        scope: "global",
        importance: 0.7,
        limit: 3,
        normalizer,
        agentId: "main",
      });

      rawStored.push(...rawEntries.map((entry) => ({ caseId: item.id, text: entry.text })));
      normalizedStored.push(...normalizedEntries.map((entry) => ({ caseId: item.id, text: entry.text })));
      perCase.push({
        id: item.id,
        source: item.content,
        raw: rawEntries.map((entry) => entry.text),
        normalized: normalizedEntries.map((entry) => entry.text),
      });
    }

    const audits = readAudit(auditPath);
    const fallbackCounts = audits.reduce((acc, record) => {
      const key = record.fallback || "llm";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});

    let rawTop1Hits = 0;
    let rawTop3Hits = 0;
    let normalizedTop1Hits = 0;
    let normalizedTop3Hits = 0;
    let rawNoiseAt3 = 0;
    let normalizedNoiseAt3 = 0;

    const queryResults = [];

    for (const item of CASES) {
      for (const query of item.queries) {
        const rawResults = await retrieverRaw.retrieve({ query: query.q, limit: 3, scopeFilter: ["global"] });
        const normalizedResults = await retrieverNormalized.retrieve({ query: query.q, limit: 3, scopeFilter: ["global"] });

        if (topHitMatches(rawResults[0], query.expected)) rawTop1Hits += 1;
        if (rawResults.some((result) => topHitMatches(result, query.expected))) rawTop3Hits += 1;
        if (topHitMatches(normalizedResults[0], query.expected)) normalizedTop1Hits += 1;
        if (normalizedResults.some((result) => topHitMatches(result, query.expected))) normalizedTop3Hits += 1;

        rawNoiseAt3 += countNoiseInResults(rawResults);
        normalizedNoiseAt3 += countNoiseInResults(normalizedResults);

        queryResults.push({
          caseId: item.id,
          query: query.q,
          expected: query.expected,
          rawTop: rawResults.map((result) => result.entry.text),
          normalizedTop: normalizedResults.map((result) => result.entry.text),
        });
      }
    }

    const normalizedTopEntryByCase = new Map(
      perCase.map((item) => [item.id, item.normalized[0] || ""])
    );
    const rawTopEntryByCase = new Map(
      perCase.map((item) => [item.id, item.raw[0] || ""])
    );

    const rewriteCount = CASES.filter((item) => {
      const raw = rawTopEntryByCase.get(item.id) || "";
      const normalized = normalizedTopEntryByCase.get(item.id) || "";
      return raw && normalized && raw !== normalized;
    }).length;

    const ackReducedCount = CASES.filter((item) => {
      const raw = rawTopEntryByCase.get(item.id) || "";
      const normalized = normalizedTopEntryByCase.get(item.id) || "";
      return noiseLike(raw) && !noiseLike(normalized);
    }).length;

    const anchorPreservedCount = CASES.filter((item) => {
      const normalized = normalizedTopEntryByCase.get(item.id) || "";
      const lower = normalized.toLowerCase();
      return item.anchors.every((anchor) => lower.includes(anchor.toLowerCase()));
    }).length;

    const totalQueries = CASES.reduce((sum, item) => sum + item.queries.length, 0);

    const summary = {
      cases: CASES.length,
      totalQueries,
      rawStoredCount: rawStored.length,
      normalizedStoredCount: normalizedStored.length,
      rewriteCount,
      ackReducedCount,
      anchorPreservedCount,
      fallbackCounts,
      rawTop1HitRate: Number((rawTop1Hits / totalQueries).toFixed(3)),
      rawTop3HitRate: Number((rawTop3Hits / totalQueries).toFixed(3)),
      normalizedTop1HitRate: Number((normalizedTop1Hits / totalQueries).toFixed(3)),
      normalizedTop3HitRate: Number((normalizedTop3Hits / totalQueries).toFixed(3)),
      rawNoiseAt3,
      normalizedNoiseAt3,
    };

    const outputDir = process.env.NORMALIZER_AB_OUTPUT_DIR || "/Users/victor/.openclaw/backups/memory-experiments";
    await mkdir(outputDir, { recursive: true });

    const jsonPath = path.join(outputDir, "normalizer-phase1-live-ab-20260315.json");
    const mdPath = path.join(outputDir, "normalizer-phase1-live-ab-20260315.md");
    await writeFile(jsonPath, JSON.stringify({ summary, perCase, queryResults, audits }, null, 2), "utf8");

    const md = [
      "# Memory Normalizer Phase 1 Live A/B",
      "",
      `- Cases: ${summary.cases}`,
      `- Queries: ${summary.totalQueries}`,
      `- Raw stored count: ${summary.rawStoredCount}`,
      `- Normalized stored count: ${summary.normalizedStoredCount}`,
      `- Rewrite count: ${summary.rewriteCount}`,
      `- Ack reduced count: ${summary.ackReducedCount}`,
      `- Anchor preserved count: ${summary.anchorPreservedCount}/${summary.cases}`,
      `- Fallback counts: ${JSON.stringify(summary.fallbackCounts)}`,
      `- Raw Top1 hit rate: ${summary.rawTop1HitRate}`,
      `- Raw Top3 hit rate: ${summary.rawTop3HitRate}`,
      `- Normalized Top1 hit rate: ${summary.normalizedTop1HitRate}`,
      `- Normalized Top3 hit rate: ${summary.normalizedTop3HitRate}`,
      `- Raw Noise@3: ${summary.rawNoiseAt3}`,
      `- Normalized Noise@3: ${summary.normalizedNoiseAt3}`,
      "",
      "## Per-case examples",
      ...perCase.flatMap((item) => [
        `### ${item.id}`,
        `- Source: ${item.source}`,
        `- Raw: ${item.raw.join(" | ") || "(none)"}`,
        `- Normalized: ${item.normalized.join(" | ") || "(none)"}`,
        "",
      ]),
    ].join("\n");
    await writeFile(mdPath, md, "utf8");

    console.log(jsonPath);
    console.log(mdPath);
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("FAIL: normalizer phase1 live A/B failed");
  console.error(error);
  process.exit(1);
});
