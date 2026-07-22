import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import Module from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import jitiFactory from "jiti";

process.env.NODE_PATH = [
  process.env.NODE_PATH,
  "/opt/homebrew/lib/node_modules/openclaw/node_modules",
  "/opt/homebrew/lib/node_modules",
].filter(Boolean).join(":");
Module._initPaths();

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");
const { createEmbedder } = jiti("../src/embedder.ts");
const { SmartExtractor } = jiti("../src/smart-extractor.ts");
const { createLlmClient } = jiti("../src/llm-client.ts");
const { createRetriever } = jiti("../src/retriever.ts");
const {
  buildSmartMetadata,
  deriveFactKey,
  isMemoryActiveAt,
  parseSmartMetadata,
  stringifySmartMetadata,
} = jiti("../src/smart-metadata.ts");

const EMBEDDING_DIMENSIONS = 2560;

function createEmbeddingServer() {
  return http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/embeddings") {
      res.writeHead(404);
      res.end();
      return;
    }

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const inputs = Array.isArray(payload.input) ? payload.input : [payload.input];
    const value = 1 / Math.sqrt(EMBEDDING_DIMENSIONS);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: inputs.map((_, index) => ({
        object: "embedding",
        index,
        embedding: new Array(EMBEDDING_DIMENSIONS).fill(value),
      })),
      model: "mock",
      usage: { prompt_tokens: 0, total_tokens: 0 },
    }));
  });
}

async function runTest() {
  console.log("Test 1: deriveFactKey extracts stable topic keys...");
  assert.equal(
    deriveFactKey("preferences", "饮品偏好：乌龙茶"),
    "preferences:饮品偏好",
  );
  assert.equal(
    deriveFactKey("entities", "Project status: paused"),
    "entities:project status",
  );
  console.log("  ✅ fact keys derive from mutable fact topics");

  const workDir = mkdtempSync(path.join(tmpdir(), "temporal-facts-"));
  const dbPath = path.join(workDir, "db");
  let dedupDecision = "supersede";

  const embeddingServer = createEmbeddingServer();
  const llmServer = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/chat/completions") {
      res.writeHead(404);
      res.end();
      return;
    }

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const prompt = payload.messages?.[1]?.content || "";
    let content = JSON.stringify({ memories: [] });

    if (prompt.includes("## Recent Conversation")) {
      content = JSON.stringify({
        memories: [{
          category: "preferences",
          abstract: "饮品偏好：咖啡",
          overview: "## Preference\n- 现在偏好咖啡",
          content: "用户现在改喝咖啡。",
        }],
      });
    } else if (prompt.includes("Determine how to handle this candidate memory")) {
      content = JSON.stringify({
        decision: dedupDecision,
        match_index: 1,
        reason: "same preference topic, new truth replaces old truth",
      });
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "test",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "mock",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    }));
  });

  await new Promise((resolve) => embeddingServer.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => llmServer.listen(0, "127.0.0.1", resolve));

  try {
    const embPort = embeddingServer.address().port;
    const llmPort = llmServer.address().port;
    const store = new MemoryStore({ dbPath, vectorDim: EMBEDDING_DIMENSIONS });
    const embedder = createEmbedder({
      provider: "openai-compatible",
      apiKey: "dummy",
      model: "mock",
      baseURL: `http://127.0.0.1:${embPort}/v1`,
      dimensions: EMBEDDING_DIMENSIONS,
    });
    const llm = createLlmClient({
      apiKey: "dummy",
      model: "mock",
      baseURL: `http://127.0.0.1:${llmPort}`,
      timeoutMs: 10000,
    });

    const oldText = "饮品偏好：乌龙茶";
    const oldEntry = await store.store({
      text: oldText,
      vector: await embedder.embedPassage(oldText),
      category: "preference",
      scope: "test",
      importance: 0.8,
      metadata: stringifySmartMetadata(
        buildSmartMetadata(
          { text: oldText, category: "preference", importance: 0.8 },
          {
            l0_abstract: oldText,
            l1_overview: "## Preference\n- 喜欢乌龙茶",
            l2_content: "用户喜欢乌龙茶。",
            memory_category: "preferences",
            tier: "working",
            confidence: 0.8,
          },
        ),
      ),
    });

    const extractor = new SmartExtractor(store, embedder, llm, {
      user: "User",
      extractMinMessages: 1,
      defaultScope: "test",
    });

    console.log("\nTest 2: supersede preserves history but invalidates the old fact...");
    const stats = await extractor.extractAndPersist(
      "用户现在改喝咖啡。",
      "temporal-session",
      { scope: "test", scopeFilter: ["test"] },
    );

    assert.equal(stats.created, 1);
    assert.equal(stats.superseded, 1);

    const entries = await store.list(["test"], undefined, 10, 0);
    assert.equal(entries.length, 2, "supersede should keep old + new entries");

    const currentEntry = entries.find((entry) => entry.text.includes("咖啡"));
    const historicalEntry = entries.find((entry) => entry.id === oldEntry.id);

    assert.ok(currentEntry, "new current entry should exist");
    assert.ok(historicalEntry, "historical entry should still exist");

    const currentMeta = parseSmartMetadata(currentEntry.metadata, currentEntry);
    const historicalMeta = parseSmartMetadata(historicalEntry.metadata, historicalEntry);

    assert.equal(currentMeta.supersedes, historicalEntry.id);
    assert.equal(historicalMeta.superseded_by, currentEntry.id);
    assert.ok(historicalMeta.invalidated_at, "historical entry should have invalidated_at");
    assert.ok(currentMeta.valid_from >= historicalMeta.valid_from);
    assert.equal(currentMeta.fact_key, historicalMeta.fact_key);
    assert.equal(isMemoryActiveAt(currentMeta), true);
    assert.equal(isMemoryActiveAt(historicalMeta), false);
    console.log("  ✅ old fact is retained as history and marked inactive");

    console.log("\nTest 3: retriever returns only the current valid fact...");
    const retriever = createRetriever(store, embedder, {
      mode: "vector",
      rerank: "none",
      minScore: 0.1,
      hardMinScore: 0,
      filterNoise: false,
      recencyHalfLifeDays: 0,
      recencyWeight: 0,
      lengthNormAnchor: 0,
      timeDecayHalfLifeDays: 0,
      reinforcementFactor: 0,
      maxHalfLifeMultiplier: 1,
    });

    const results = await retriever.retrieve({
      query: "饮品偏好",
      limit: 5,
      scopeFilter: ["test"],
      source: "cli",
    });

    assert.equal(results.length, 1, "retrieval should hide invalidated facts");
    assert.equal(results[0].entry.id, currentEntry.id);
    console.log("  ✅ retrieval prefers current truth by filtering invalidated memories");

    console.log("\nTest 4: retrieval survives crowding by many superseded versions...");
    // Insert 8 inactive historical versions sharing the same vector space.
    // With limit=5, a naive top-N + post-filter would return [] because
    // all 5 raw neighbours are inactive. The store must over-fetch and
    // filter at query time so the single active fact is always returned.
    const activeVector = await embedder.embedPassage("饮品偏好：咖啡");
    for (let i = 0; i < 8; i++) {
      await store.store({
        text: `饮品偏好：历史版本${i}`,
        vector: activeVector, // same vector — crowds the active fact
        category: "preference",
        scope: "test",
        importance: 0.8,
        metadata: stringifySmartMetadata(
          buildSmartMetadata(
            { text: `饮品偏好：历史版本${i}`, category: "preference", importance: 0.8 },
            {
              l0_abstract: `饮品偏好：历史版本${i}`,
              l1_overview: `## Preference\n- 历史版本${i}`,
              l2_content: `历史版本${i}`,
              memory_category: "preferences",
              tier: "working",
              confidence: 0.8,
              fact_key: currentMeta.fact_key,
              valid_from: Date.now() - (10 - i) * 86400000,
              invalidated_at: Date.now() - (9 - i) * 86400000,
              superseded_by: currentEntry.id,
            },
          ),
        ),
      });
    }

    // Verify there are now 10 total entries (1 original + 1 current + 8 history)
    const allEntries = await store.list(["test"], undefined, 20, 0);
    assert.equal(allEntries.length, 10, "should have 10 entries total");

    const crowdedResults = await retriever.retrieve({
      query: "饮品偏好",
      limit: 5,
      scopeFilter: ["test"],
      source: "cli",
    });

    assert.ok(crowdedResults.length >= 1, "retrieval must not return empty when active fact exists");
    assert.equal(crowdedResults[0].entry.id, currentEntry.id,
      "active fact must be returned even when crowded by 8+ inactive versions");
    // Ensure no inactive entries leaked through
    for (const r of crowdedResults) {
      const meta = parseSmartMetadata(r.entry.metadata, r.entry);
      assert.equal(isMemoryActiveAt(meta), true, `entry ${r.entry.id} should be active`);
    }
    console.log("  ✅ active fact survives crowding by 8 inactive versions (limit=5)");

    console.log("\n=== Temporal facts tests passed! ===");
  } finally {
    await new Promise((resolve) => embeddingServer.close(resolve));
    await new Promise((resolve) => llmServer.close(resolve));
    rmSync(workDir, { recursive: true, force: true });
  }
}

await runTest();
