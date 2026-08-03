/**
 * Context-Aware Support E2E Test
 *
 * Tests the full pipeline for support/contextualize/contradict decisions
 * using mock LLM and embedding servers against a real LanceDB store.
 */

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
const { buildSmartMetadata, stringifySmartMetadata, parseSupportInfo } = jiti("../src/smart-metadata.ts");

const EMBEDDING_DIMENSIONS = 2560;

// ============================================================================
// Mock Embedding Server (constant vectors — fine for unit-level E2E)
// ============================================================================

function createEmbeddingServer() {
    return http.createServer(async (req, res) => {
        if (req.method !== "POST" || req.url !== "/v1/embeddings") {
            res.writeHead(404); res.end(); return;
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
                object: "embedding", index,
                embedding: new Array(EMBEDDING_DIMENSIONS).fill(value),
            })),
            model: "mock", usage: { prompt_tokens: 0, total_tokens: 0 },
        }));
    });
}

// ============================================================================
// Test Runner
// ============================================================================

async function runTest() {
    const workDir = mkdtempSync(path.join(tmpdir(), "ctx-support-e2e-"));
    const dbPath = path.join(workDir, "db");
    const logs = [];
    let dedupDecision = "support"; // controlled per scenario
    let dedupContextLabel = "evening";

    const embeddingServer = createEmbeddingServer();

    // Mock LLM: extraction returns 1 memory, dedup returns controlled decision
    const llmServer = http.createServer(async (req, res) => {
        if (req.method !== "POST" || req.url !== "/chat/completions") {
            res.writeHead(404); res.end(); return;
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const prompt = `${payload.messages?.[0]?.content || ""}\n${payload.messages?.[1]?.content || ""}`;
        let content;

        if (prompt.includes("You are a memory extraction agent")) {
            content = JSON.stringify({
                memories: [{
                    category: "preferences",
                    abstract: "饮品偏好：乌龙茶",
                    overview: "## Preference\n- 喜欢乌龙茶",
                    content: "用户喜欢乌龙茶。",
                }],
            });
        } else if (
            prompt.includes("You are a memory dedup judge.") ||
            prompt.includes("Decide every candidate independently")
        ) {
            const verdict = {
                decision: dedupDecision,
                match_index: 1,
                reason: `test ${dedupDecision}`,
                context_label: dedupContextLabel,
            };
            content = prompt.includes("Decide every candidate independently")
                ? JSON.stringify({ results: [{ index: 1, ...verdict }] })
                : JSON.stringify(verdict);
        } else if (
            prompt.includes("You are a memory merge writer.") ||
            prompt.includes("For each job, merge every")
        ) {
            const merged = {
                abstract: "饮品偏好：乌龙茶",
                overview: "## Preference\n- 喜欢乌龙茶",
                content: "用户喜欢乌龙茶。",
            };
            content = prompt.includes("For each job, merge every")
                ? JSON.stringify({ results: [{ index: 1, ...merged }] })
                : JSON.stringify(merged);
        } else {
            content = JSON.stringify({ memories: [] });
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
            id: "test", object: "chat.completion",
            created: Math.floor(Date.now() / 1000), model: "mock",
            choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        }));
    });

    await new Promise(r => embeddingServer.listen(0, "127.0.0.1", r));
    await new Promise(r => llmServer.listen(0, "127.0.0.1", r));
    const embPort = embeddingServer.address().port;
    const llmPort = llmServer.address().port;
    process.env.TEST_EMBEDDING_BASE_URL = `http://127.0.0.1:${embPort}/v1`;

    try {
        const store = new MemoryStore({ dbPath, vectorDim: EMBEDDING_DIMENSIONS });
        const embedder = createEmbedder({
            provider: "openai-compatible", apiKey: "dummy", model: "mock",
            baseURL: `http://127.0.0.1:${embPort}/v1`, dimensions: EMBEDDING_DIMENSIONS,
        });
        const llm = createLlmClient({
            apiKey: "dummy", model: "mock",
            baseURL: `http://127.0.0.1:${llmPort}`,
            timeoutMs: 10000,
            log: (msg) => logs.push(msg),
        });

        // Seed a preference memory
        const seedText = "饮品偏好：乌龙茶";
        const seedVector = await embedder.embedPassage(seedText);
        await store.store({
            text: seedText, vector: seedVector, category: "preference",
            scope: "test", importance: 0.8,
            metadata: stringifySmartMetadata(
                buildSmartMetadata({ text: seedText, category: "preference", importance: 0.8 }, {
                    l0_abstract: seedText,
                    l1_overview: "## Preference\n- 喜欢乌龙茶",
                    l2_content: "用户喜欢乌龙茶。",
                    memory_category: "preferences", tier: "working", confidence: 0.8,
                }),
            ),
        });

        const extractor = new SmartExtractor(store, embedder, llm, {
            user: "User", extractMinMessages: 1, extractMaxChars: 8000,
            defaultScope: "test",
            log: (msg) => logs.push(msg),
        });

        // ----------------------------------------------------------------
        // Scenario 1: support — should update support_info, no new entry
        // ----------------------------------------------------------------
        console.log("Test 1: support decision updates support_info...");
        dedupDecision = "support";
        dedupContextLabel = "evening";
        logs.length = 0;

        const stats1 = await extractor.extractAndPersist(
            "用户再次确认喜欢乌龙茶，特别是晚上。",
            "test-session",
            { scope: "test", scopeFilter: ["test"] },
        );

        const entries1 = await store.list(["test"], undefined, 10, 0);
        assert.equal(entries1.length, 1, "support should NOT create new entry");
        assert.equal(stats1.supported, 1, "supported count should be 1");

        // Check support_info was updated
        const meta1 = JSON.parse(entries1[0].metadata || "{}");
        const si1 = parseSupportInfo(meta1.support_info);
        assert.ok(si1.total_observations >= 1, "total_observations should increase");
        const eveningSlice = si1.slices.find(s => s.context === "evening");
        assert.ok(eveningSlice, "evening slice should exist");
        assert.equal(eveningSlice.confirmations, 1, "evening confirmations should be 1");
        console.log("  ✅ support decision works correctly");

        // ----------------------------------------------------------------
        // Scenario 2: merge — should update support_info on merged memory
        // ----------------------------------------------------------------
        console.log("Test 2: merge decision updates support_info...");
        dedupDecision = "merge";
        dedupContextLabel = "late_night";
        logs.length = 0;

        const stats2 = await extractor.extractAndPersist(
            "用户再次确认深夜也会喝乌龙茶。",
            "test-session",
            { scope: "test", scopeFilter: ["test"] },
        );

        const entries2 = await store.list(["test"], undefined, 10, 0);
        assert.equal(entries2.length, 1, "merge should NOT create new entry");
        assert.equal(stats2.merged, 1, "merged count should be 1");

        const meta2 = JSON.parse(entries2[0].metadata || "{}");
        const si2 = parseSupportInfo(meta2.support_info);
        const lateNightSlice = si2.slices.find(s => s.context === "late_night");
        assert.ok(lateNightSlice, "late_night slice should exist after merge");
        assert.equal(lateNightSlice.confirmations, 1, "late_night confirmations should be 1");
        console.log("  ✅ merge decision works correctly");

        // ----------------------------------------------------------------
        // Scenario 3: contextualize — should create linked entry
        // ----------------------------------------------------------------
        console.log("Test 3: contextualize decision creates linked entry...");
        dedupDecision = "contextualize";
        dedupContextLabel = "night";
        logs.length = 0;

        const stats3 = await extractor.extractAndPersist(
            "用户说晚上改喝花茶。",
            "test-session",
            { scope: "test", scopeFilter: ["test"] },
        );

        const entries3 = await store.list(["test"], undefined, 10, 0);
        assert.equal(entries3.length, 2, "contextualize should create 1 new entry");
        assert.equal(stats3.created, 1, "created count should be 1");
        console.log("  ✅ contextualize decision works correctly");

        // ----------------------------------------------------------------
        // Scenario 4: contradict — should record contradiction + new entry
        // ----------------------------------------------------------------
        console.log("Test 4: contradict decision records contradiction...");
        dedupDecision = "contradict";
        dedupContextLabel = "weekend";
        logs.length = 0;

        const stats4 = await extractor.extractAndPersist(
            "用户说周末不喝茶了。",
            "test-session",
            { scope: "test", scopeFilter: ["test"] },
        );

        const entries4 = await store.list(["test"], undefined, 10, 0);
        assert.equal(entries4.length, 3, "contradict should create 1 new entry");
        assert.equal(stats4.created, 1, "created count should be 1");

        // Check contradictions recorded on some existing entry
        // (with constant vectors, dedup may match any existing entry)
        let foundWeekend = false;
        for (const entry of entries4) {
            const meta = JSON.parse(entry.metadata || "{}");
            const si = parseSupportInfo(meta.support_info);
            const weekendSlice = si.slices.find(s => s.context === "weekend");
            if (weekendSlice && weekendSlice.contradictions >= 1) {
                foundWeekend = true;
                break;
            }
        }
        assert.ok(foundWeekend, "at least one entry should have weekend contradiction");
        console.log("  ✅ contradict decision works correctly");

        console.log("\n=== All Context-Support E2E tests passed! ===");

    } finally {
        delete process.env.TEST_EMBEDDING_BASE_URL;
        await new Promise(r => embeddingServer.close(r));
        await new Promise(r => llmServer.close(r));
        rmSync(workDir, { recursive: true, force: true });
    }
}

await runTest();
