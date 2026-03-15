import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

function embedText(text, dim = 24) {
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

async function main() {
  const { MemoryStore } = jiti("../src/store.ts");
  const { extractAtomicMemory } = jiti("../src/atomic-memory.ts");
  const { extractAutoCaptureCandidates, normalizeAndStoreAutoCaptureCandidates } = jiti("../src/auto-capture.ts");
  const { createMemoryNormalizer } = jiti("../src/normalizer.ts");

  const workDir = mkdtempSync(path.join(tmpdir(), "memory-lancedb-pro-normalizer-"));

  try {
    const store = new MemoryStore({ dbPath: path.join(workDir, "db"), vectorDim: 24 });
    const embedder = {
      async embedPassage(text) { return embedText(text); },
      async embedQuery(text) { return embedText(text); },
    };

    const fetchImpl = async () => ({
      ok: true,
      async json() {
        return {
          choices: [{
            message: {
              content: JSON.stringify({
                entries: [{
                  canonicalText: "Decision: Codex ACP should use `acpx-with-proxy` so the ACP runtime always inherits Clash mixed-port 7897 when needed.",
                  category: "decision",
                  atomic: {
                    unitType: "decision",
                    sourceKind: "agent",
                    confidence: 0.86,
                    tags: ["Codex", "acpx-with-proxy", "proxy", "7897"],
                  },
                  reason: "technical_decision",
                }],
              }),
            },
          }],
        };
      },
    });

    const normalizer = createMemoryNormalizer({
      enabled: true,
      apiKey: "sk-test",
      model: "Qwen/Qwen3-8B",
      baseURL: "https://api.siliconflow.cn/v1/chat/completions",
      temperature: 0.1,
      maxTokens: 1200,
      enableThinking: false,
      timeoutMs: 3000,
      maxEntriesPerCandidate: 3,
      fallbackMode: "rules-then-raw",
      audit: {
        enabled: true,
        logPath: path.join(workDir, "normalizer-audit.jsonl"),
      },
    }, undefined, { fetchImpl });

    const messages = [
      { role: "assistant", content: "决定：之后 Codex ACP 固定通过 acpx-with-proxy 走代理 7897，避免 websocket 超时。" },
    ];

    const candidates = extractAutoCaptureCandidates(messages, { captureAssistant: true });
    assert.equal(candidates.length, 1);

    const chatterCandidates = extractAutoCaptureCandidates([
      { role: "assistant", content: "[[reply_to_current]] 我去看一下刚才那次运行的实际产出，等它跑完我继续帮你验。" },
    ], { captureAssistant: true });
    assert.equal(chatterCandidates.length, 0);

    const stored = await normalizeAndStoreAutoCaptureCandidates({
      candidates,
      store,
      embedder,
      scope: "agent:main",
      importance: 0.7,
      limit: 3,
      normalizer,
      agentId: "main",
    });

    assert.equal(stored.length, 1);
    assert.equal(
      stored[0].text,
      "Decision: Codex ACP should use acpx-with-proxy so the ACP runtime always inherits Clash mixed-port 7897 when needed.",
    );
    assert.notEqual(stored[0].text, messages[0].content);
    assert.equal(extractAtomicMemory(stored[0].metadata)?.sourceKind, "agent");
    assert.equal(extractAtomicMemory(stored[0].metadata)?.unitType, "decision");
    const tags = extractAtomicMemory(stored[0].metadata)?.tags || [];
    assert(tags.includes("acpx-with-proxy"));
    assert(tags.includes("proxy"));
    assert(tags.includes("7897"));

    console.log("OK: normalizer auto-capture rewrite passed");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("FAIL: normalizer auto-capture rewrite failed");
  console.error(error);
  process.exit(1);
});
