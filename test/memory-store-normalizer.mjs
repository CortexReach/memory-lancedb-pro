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
  const { createScopeManager } = jiti("../src/scopes.ts");
  const { createRetriever } = jiti("../src/retriever.ts");
  const { createMemoryNormalizer } = jiti("../src/normalizer.ts");
  const { registerMemoryStoreTool } = jiti("../src/tools.ts");
  const { extractAtomicMemory } = jiti("../src/atomic-memory.ts");

  const workDir = mkdtempSync(path.join(tmpdir(), "memory-lancedb-pro-store-normalizer-"));

  try {
    const store = new MemoryStore({ dbPath: path.join(workDir, "db"), vectorDim: 24 });
    const embedder = {
      async embedPassage(text) { return embedText(text); },
      async embedQuery(text) { return embedText(text); },
    };
    const retriever = createRetriever(store, embedder, {
      mode: "vector",
      rerank: "none",
      minScore: 0.1,
      hardMinScore: 0.05,
      filterNoise: false,
    });
    const scopeManager = createScopeManager({
      default: "agent:main",
      definitions: {
        global: { description: "global" },
        "agent:main": { description: "main" },
      },
      agentAccess: {
        main: ["global", "agent:main"],
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
        enabled: false,
      },
    }, undefined, {
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return {
            choices: [{
              message: {
                content: JSON.stringify({
                  entries: [{
                    canonicalText: "重要原则：实践优先，准备充分后大胆尝试，不要长期停留在保守观望。",
                    category: "decision",
                    atomic: {
                      unitType: "decision",
                      sourceKind: "user",
                      confidence: 0.82,
                      tags: ["principle"],
                    },
                    reason: "principle_rewrite",
                  }],
                }),
              },
            }],
          };
        },
      }),
    });

    let registeredTool;
    const api = {
      registerTool(definition) {
        registeredTool = definition;
      },
    };

    registerMemoryStoreTool(api, {
      retriever,
      store,
      scopeManager,
      embedder,
      normalizer,
      agentId: "main",
    });

    assert(registeredTool, "memory_store tool should register");

    const resolvedTool = typeof registeredTool === "function"
      ? registeredTool({ agentId: "main", sessionKey: "agent:main:test" })
      : registeredTool;

    const result = await resolvedTool.execute("tool-call-1", {
      text: "重要原则：实践优先，准备充分后大胆尝试，不要长期停留在保守观望。要不要我现在顺手把实验方案也落下来？",
      category: "decision",
      importance: 0.7,
    });

    assert.equal(result.details.action, "created");
    assert.equal(result.details.memories[0].text, "重要原则：实践优先，准备充分后大胆尝试，不要长期停留在保守观望。");
    assert.equal(result.details.memories[0].atomic.unitType, "decision");
    assert.equal(result.details.memories[0].atomic.sourceKind, "user");
    assert(result.details.memories[0].atomic.tags.includes("principle"));

    const list = await store.list(["agent:main"], undefined, 10, 0);
    assert.equal(list.length, 1);
    assert.equal(list[0].text, "重要原则：实践优先，准备充分后大胆尝试，不要长期停留在保守观望。");
    assert.equal(extractAtomicMemory(list[0].metadata)?.unitType, "decision");

    console.log("OK: memory_store normalizer rewrite passed");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("FAIL: memory_store normalizer rewrite failed");
  console.error(error);
  process.exit(1);
});
