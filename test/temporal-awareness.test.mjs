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
const { createRetriever } = jiti("../src/retriever.ts");
const {
  buildSmartMetadata,
  isMemoryExpired,
  parseSmartMetadata,
  stringifySmartMetadata,
} = jiti("../src/smart-metadata.ts");
const {
  classifyTemporal,
  inferExpiry,
} = jiti("../src/temporal-classifier.ts");

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
  // ===========================================================================
  // Test 1: classifyTemporal
  // ===========================================================================
  console.log("Test 1: classifyTemporal classifies static vs dynamic...");

  assert.equal(classifyTemporal("I like coffee"), "static");
  assert.equal(classifyTemporal("Today I had a meeting with Bob"), "dynamic");
  assert.equal(classifyTemporal("我喜欢喝咖啡"), "static");
  assert.equal(classifyTemporal("今天开会讨论了项目"), "dynamic");
  assert.equal(classifyTemporal("My name is Alice"), "static");
  assert.equal(classifyTemporal("Recently started learning Rust"), "dynamic");

  // Edge: both static and dynamic keywords → dynamic wins
  assert.equal(classifyTemporal("Today I changed my favorite color"), "dynamic");
  // Edge: neither → static (safe default)
  assert.equal(classifyTemporal("The sky is blue"), "static");

  // Substring false-positive guard: "later" must NOT match "collateral"
  assert.equal(classifyTemporal("collateral damage report"), "static");
  assert.equal(classifyTemporal("bilateral trade agreement"), "static");
  // But standalone "later" should still match
  assert.equal(classifyTemporal("I will handle this later"), "dynamic");

  console.log("  ✅ temporal classification works for EN and ZH");

  // ===========================================================================
  // Test 2: inferExpiry
  // ===========================================================================
  console.log("\nTest 2: inferExpiry infers expiry from temporal expressions...");

  const now = Date.now();
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  const tomorrowExpiry = inferExpiry("Meeting tomorrow at 3pm", now);
  assert.ok(tomorrowExpiry != null, "tomorrow should have expiry");
  assert.ok(
    Math.abs(tomorrowExpiry - (now + 24 * HOUR)) < 1000,
    `tomorrow expiry should be ~now+24h, got delta=${tomorrowExpiry - now}ms`,
  );

  const nextWeekExpiry = inferExpiry("下周要交报告", now);
  assert.ok(nextWeekExpiry != null, "next week should have expiry");
  assert.ok(
    Math.abs(nextWeekExpiry - (now + 7 * DAY)) < 1000,
    `next week expiry should be ~now+7d`,
  );

  const noExpiry = inferExpiry("I always prefer dark mode", now);
  assert.equal(noExpiry, undefined, "static text should have no expiry");

  const todayExpiry = inferExpiry("今天要完成报告", now);
  assert.ok(todayExpiry != null);
  assert.ok(Math.abs(todayExpiry - (now + 18 * HOUR)) < 1000);

  const tonightExpiry = inferExpiry("今晚有聚会", now);
  assert.ok(tonightExpiry != null);
  assert.ok(Math.abs(tonightExpiry - (now + 12 * HOUR)) < 1000);

  const dayAfterExpiry = inferExpiry("后天出差", now);
  assert.ok(dayAfterExpiry != null);
  assert.ok(Math.abs(dayAfterExpiry - (now + 48 * HOUR)) < 1000);

  console.log("  ✅ expiry inference works for temporal expressions");

  // ===========================================================================
  // Test 3: isMemoryExpired
  // ===========================================================================
  console.log("\nTest 3: isMemoryExpired checks expiry correctly...");

  assert.equal(isMemoryExpired({ valid_until: now - 1000 }, now), true, "past expiry = expired");
  assert.equal(isMemoryExpired({ valid_until: now + 1000 }, now), false, "future expiry = not expired");
  assert.equal(isMemoryExpired({ valid_until: undefined }, now), false, "no expiry = never expires");
  assert.equal(isMemoryExpired({}, now), false, "missing field = never expires");

  console.log("  ✅ isMemoryExpired handles all cases");

  // ===========================================================================
  // Test 4: parseSmartMetadata preserves temporal fields
  // ===========================================================================
  console.log("\nTest 4: parseSmartMetadata/buildSmartMetadata handle temporal fields...");

  const meta = buildSmartMetadata(
    { text: "today meeting", category: "fact", importance: 0.7 },
    { memory_temporal_type: "dynamic", valid_until: now + DAY },
  );
  assert.equal(meta.memory_temporal_type, "dynamic");
  assert.equal(meta.valid_until, now + DAY);

  const serialized = stringifySmartMetadata(meta);
  const parsed = parseSmartMetadata(serialized, { text: "today meeting" });
  assert.equal(parsed.memory_temporal_type, "dynamic");
  assert.equal(parsed.valid_until, now + DAY);

  // Legacy: missing fields → undefined
  const legacyParsed = parseSmartMetadata("{}", { text: "old entry" });
  assert.equal(legacyParsed.memory_temporal_type, undefined);
  assert.equal(legacyParsed.valid_until, undefined);

  console.log("  ✅ temporal fields round-trip through metadata");

  // ===========================================================================
  // Test 5: Retriever filters expired memories
  // ===========================================================================
  console.log("\nTest 5: retriever filters expired memories during search...");

  const workDir = mkdtempSync(path.join(tmpdir(), "temporal-awareness-"));
  const dbPath = path.join(workDir, "db");

  const embeddingServer = createEmbeddingServer();
  await new Promise((resolve) => embeddingServer.listen(0, "127.0.0.1", resolve));

  try {
    const embPort = embeddingServer.address().port;
    const store = new MemoryStore({ dbPath, vectorDim: EMBEDDING_DIMENSIONS });
    const embedder = createEmbedder({
      provider: "openai-compatible",
      apiKey: "dummy",
      model: "mock",
      baseURL: `http://127.0.0.1:${embPort}/v1`,
      dimensions: EMBEDDING_DIMENSIONS,
    });

    // Store memory with past expiry (should be filtered out)
    const expiredText = "Meeting was scheduled for yesterday";
    await store.store({
      text: expiredText,
      vector: await embedder.embedPassage(expiredText),
      category: "fact",
      scope: "test",
      importance: 0.8,
      metadata: stringifySmartMetadata(
        buildSmartMetadata(
          { text: expiredText, category: "fact", importance: 0.8 },
          {
            l0_abstract: expiredText,
            memory_temporal_type: "dynamic",
            valid_until: Date.now() - 86400000, // expired 1 day ago
          },
        ),
      ),
    });

    // Store memory with future expiry (should be returned)
    const futureText = "Meeting scheduled for tomorrow";
    const futureEntry = await store.store({
      text: futureText,
      vector: await embedder.embedPassage(futureText),
      category: "fact",
      scope: "test",
      importance: 0.8,
      metadata: stringifySmartMetadata(
        buildSmartMetadata(
          { text: futureText, category: "fact", importance: 0.8 },
          {
            l0_abstract: futureText,
            memory_temporal_type: "dynamic",
            valid_until: Date.now() + 86400000, // expires in 1 day
          },
        ),
      ),
    });

    // Store memory with no expiry (permanent, should be returned)
    const permanentText = "I prefer dark mode";
    const permanentEntry = await store.store({
      text: permanentText,
      vector: await embedder.embedPassage(permanentText),
      category: "preference",
      scope: "test",
      importance: 0.8,
      metadata: stringifySmartMetadata(
        buildSmartMetadata(
          { text: permanentText, category: "preference", importance: 0.8 },
          {
            l0_abstract: permanentText,
            memory_temporal_type: "static",
            // No valid_until → permanent
          },
        ),
      ),
    });

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
      query: "meeting schedule preference",
      limit: 10,
      scopeFilter: ["test"],
      source: "cli",
    });

    // Verify expired memory is filtered out
    const expiredInResults = results.some(r => r.entry.text === expiredText);
    assert.equal(expiredInResults, false, "expired memory should NOT appear in results");

    // Verify future-expiry memory is present
    const futureInResults = results.some(r => r.entry.id === futureEntry.id);
    assert.equal(futureInResults, true, "future-expiry memory should appear in results");

    // Verify permanent memory is present
    const permanentInResults = results.some(r => r.entry.id === permanentEntry.id);
    assert.equal(permanentInResults, true, "permanent memory should appear in results");

    // Sanity: we should have exactly 2 results (future + permanent)
    assert.equal(results.length, 2, "should have 2 results (expired one filtered)");

    console.log("  ✅ expired memories are filtered, unexpired and permanent memories survive");

    console.log("\n=== Temporal awareness tests passed! ===");
  } finally {
    await new Promise((resolve) => embeddingServer.close(resolve));
    rmSync(workDir, { recursive: true, force: true });
  }
}

await runTest();
