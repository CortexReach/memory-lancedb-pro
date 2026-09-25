/**
 * Grounding rejudge — scoped second pass reconciling the batch register with
 * per-item grounding tags.
 *
 * Motivating failures: (a) register says "mixed"/"fiction" but no item is
 * tagged "constructed" — the model asserted fiction exists in the window,
 * then declined to point at any of it, so mislabeled durables sail through;
 * (b) the mirror shape, register "real" with every item "constructed",
 * silently over-drops real facts; (c) the old batch-wide contradiction wipe
 * demoted EVERY real-tagged durable next to a constructed sibling, losing
 * independently-supported real facts (the upstream review asked for per-item
 * handling instead).
 *
 * The rejudge fires at most once per extraction, only on those incoherent
 * shapes; its per-item verdict is final. On judge failure the pipeline fails
 * closed: suspect durables are demoted exactly like the old wipe.
 *
 * Fixtures are entirely synthetic; no real fleet data.
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
const { buildGroundingRejudgePrompt } = jiti("../src/extraction-prompts.ts");

// Structural pin, shape-agnostic: on the split shape the doctrine lives in the
// system half and the three data sections ride the user half; on the
// single-string shape the same texts are concatenated in that order.
{
    const built = buildGroundingRejudgePrompt("conv text", "mixed", [
        { index: 1, category: "preferences", abstract: "a", content: "c", grounding: "real" },
    ]);
    const system = typeof built === "string" ? built : built.system;
    const user = typeof built === "string" ? built : built.user;
    assert.ok(
        system.startsWith("You are a grounding reviewer for a memory system."),
        "the system half must open with the focused identity",
    );
    assert.ok(system.includes("Your verdict is final."), "the one-liner task must sit in the opening paragraph");
    assert.ok(system.includes("## How to judge") && system.includes("## Output"), "doctrine and contract live in the system half");
    for (const header of ["## Conversation", "## First-pass register", "## Candidate memories"]) {
        assert.ok(user.includes(header), `user half must carry ${header}`);
    }
    if (typeof built !== "string") {
        assert.ok(!built.system.includes("## Conversation"), "no data section may leak into the system half");
        assert.ok(!built.user.includes("## How to judge"), "no doctrine may leak into the user half");
    }
    const order = ["## Conversation", "## First-pass register", "## Candidate memories"].map((h) => user.indexOf(h));
    assert.ok(order[0] < order[1] && order[1] < order[2], "user sections keep the prescribed order");
}
// The reviewer must never see the extractor's context concept: context tags in
// the incoming transcript are normalized to the plain speaker tags.
{
    const tagged = [
        "<context_only_user_turn>\nolder user turn\n</context_only_user_turn>",
        "<context_only_assistant_turn>\nassistant reply\n</context_only_assistant_turn>",
        "<user_message>\nnewest turn\n</user_message>",
    ].join("\n");
    const built = buildGroundingRejudgePrompt(tagged, "mixed", [
        { index: 1, category: "events", abstract: "a", content: "c", grounding: "real" },
    ]);
    const user = typeof built === "string" ? built : built.user;
    assert.ok(!user.includes("context_only_"), "no context tag may reach the reviewer");
    assert.ok(user.includes("<user_message>\nolder user turn\n</user_message>"), "context user turns become plain user_message blocks");
    assert.ok(user.includes("<assistant_message>\nassistant reply\n</assistant_message>"), "context assistant turns become plain assistant_message blocks");
    assert.ok(user.includes("<user_message>\nnewest turn\n</user_message>"), "the newest turn is untouched");
}



const EMBEDDING_DIMENSIONS = 2560;

function createEmbeddingServer() {
    return http.createServer(async (req, res) => {
        if (req.method !== "POST" || req.url !== "/v1/embeddings") {
            res.writeHead(404); res.end(); return;
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const inputs = Array.isArray(payload.input) ? payload.input : [payload.input];
        // Deterministic content-dependent vectors: hash-seeded PRNG output is
        // near-orthogonal across distinct texts, so unrelated candidates never
        // collide in the vector-similarity dedup paths.
        const embed = (text) => {
            let seed = 2166136261;
            for (const ch of String(text)) {
                seed = Math.imul(seed ^ ch.codePointAt(0), 16777619) >>> 0;
            }
            const vec = Array.from({ length: EMBEDDING_DIMENSIONS }, () => {
                seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
                return (seed / 4294967296) - 0.5;
            });
            const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
            return vec.map((v) => v / norm);
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
            object: "list",
            data: inputs.map((input, index) => ({
                object: "embedding", index,
                embedding: embed(input),
            })),
            model: "mock", usage: { prompt_tokens: 0, total_tokens: 0 },
        }));
    });
}

async function runTest() {
    const workDir = mkdtempSync(path.join(tmpdir(), "grounding-rejudge-"));
    const dbPath = path.join(workDir, "db");
    const logs = [];

    // Per-scenario controls
    let extractionResponse = { conversation_register: "real", memories: [] };
    let rejudgeResponse = null;      // object, or "malformed" to break the judge
    let extractionCalls = 0;
    let rejudgeCalls = 0;

    const embeddingServer = createEmbeddingServer();
    const llmServer = http.createServer(async (req, res) => {
        if (req.method !== "POST" || req.url !== "/chat/completions") {
            res.writeHead(404); res.end(); return;
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const prompt = (payload.messages || []).map((m) => m.content).join("\n");
        let content;

        if (prompt.includes("You are a grounding reviewer")) {
            rejudgeCalls++;
            content = rejudgeResponse === "malformed"
                ? "this is not json at all {{{"
                : JSON.stringify(rejudgeResponse);
        } else if (prompt.includes("extract memories worth long-term preservation")) {
            extractionCalls++;
            content = JSON.stringify(extractionResponse);
        } else if (prompt.includes("Determine how to handle this candidate memory")) {
            content = JSON.stringify({ decision: "create", reason: "test create" });
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
        const extractor = new SmartExtractor(store, embedder, llm, {
            user: "User", extractMinMessages: 1, extractMaxChars: 8000,
            defaultScope: "test",
            log: (msg) => logs.push(msg),
            debugLog: (msg) => logs.push(msg),
        });

        const listTexts = async (scope) =>
            (await store.list([scope], undefined, 50, 0)).map((e) => e.text);
        const reset = () => { logs.length = 0; extractionCalls = 0; rejudgeCalls = 0; };

        // ----------------------------------------------------------------
        // 1. Cell 2: register "mixed" + zero constructed tags -> judge
        //    fires once; its per-item verdict is applied as final.
        // ----------------------------------------------------------------
        console.log("Test 1: mixed register with zero constructed fires the rejudge...");
        reset();
        extractionResponse = {
            conversation_register: "mixed",
            memories: [
                {
                    category: "preferences",
                    abstract: "Keeps a copper kettle on the desk",
                    overview: "## Preference\n- Copper kettle on desk",
                    content: "The user keeps a copper kettle on the desk.",
                    grounding: "real",
                },
                {
                    category: "events",
                    abstract: "User explored an imagined lighthouse scenario",
                    overview: "## Event\n- Imagined scenario explored",
                    content: "The user explored an imagined lighthouse-keeper scenario this session.",
                    grounding: "real",
                },
            ],
        };
        rejudgeResponse = {
            conversation_register: "mixed",
            results: [
                { index: 1, grounding: "constructed", reason: "prop inside the imagined scenario" },
                { index: 2, grounding: "real", reason: "true note about the real session" },
            ],
        };
        await extractor.extractAndPersist("scenario one text", "s1", { scope: "s1", scopeFilter: ["s1"] });
        assert.equal(rejudgeCalls, 1, "rejudge must fire exactly once");
        const rows1 = await listTexts("s1");
        assert.equal(rows1.length, 1, "only the judge-confirmed real item may be stored");
        assert.ok(rows1[0].includes("lighthouse"), "the events note survives");
        assert.ok(
            logs.some((l) => l.includes("grounding-rejudge") && l.includes("fired")),
            "a distinct rejudge log line must be emitted",
        );

        // ----------------------------------------------------------------
        // 2. Cell 3: register "fiction" + zero constructed -> judge fires;
        //    confirmed-constructed durable is dropped, events note survives.
        // ----------------------------------------------------------------
        console.log("Test 2: fiction register with zero constructed fires the rejudge...");
        reset();
        extractionResponse = {
            conversation_register: "fiction",
            memories: [
                {
                    category: "preferences",
                    abstract: "Drinks juniper tonic at midnight",
                    overview: "## Preference\n- Juniper tonic",
                    content: "The user drinks juniper tonic at midnight.",
                    grounding: "real",
                },
                {
                    category: "events",
                    abstract: "User ran a station-keeper story exercise",
                    overview: "## Event\n- Story exercise",
                    content: "The user ran a station-keeper story exercise this session.",
                    grounding: "real",
                },
            ],
        };
        rejudgeResponse = {
            conversation_register: "fiction",
            results: [
                { index: 1, grounding: "constructed", reason: "in-story prop" },
                { index: 2, grounding: "real", reason: "note about the real session" },
            ],
        };
        await extractor.extractAndPersist("scenario two text", "s2", { scope: "s2", scopeFilter: ["s2"] });
        assert.equal(rejudgeCalls, 1, "rejudge must fire exactly once");
        const rows2 = await listTexts("s2");
        assert.equal(rows2.length, 1, "only the events note may survive a fiction batch");
        assert.ok(rows2[0].includes("story exercise"));

        // ----------------------------------------------------------------
        // 3. Cell 1 (mirror): register "real" + zero real tags -> judge
        //    fires and can rescue over-dropped real facts.
        // ----------------------------------------------------------------
        console.log("Test 3: real register with all-constructed tags fires the rejudge (over-drop guard)...");
        reset();
        extractionResponse = {
            conversation_register: "real",
            memories: [
                {
                    category: "preferences",
                    abstract: "Prefers rye bread for breakfast",
                    overview: "## Preference\n- Rye bread",
                    content: "The user prefers rye bread for breakfast.",
                    grounding: "constructed",
                },
                {
                    category: "profile",
                    abstract: "Works as a marine surveyor",
                    overview: "## Profile\n- Marine surveyor",
                    content: "The user works as a marine surveyor.",
                    grounding: "constructed",
                },
            ],
        };
        rejudgeResponse = {
            conversation_register: "real",
            results: [
                { index: 1, grounding: "real", reason: "stated plainly about the real user" },
                { index: 2, grounding: "real", reason: "stated plainly about the real user" },
            ],
        };
        await extractor.extractAndPersist("scenario three text", "s3", { scope: "s3", scopeFilter: ["s3"] });
        assert.equal(rejudgeCalls, 1, "rejudge must fire exactly once");
        const rows3 = await listTexts("s3");
        assert.equal(rows3.length, 2, "judge-rescued real facts must be stored");

        // ----------------------------------------------------------------
        // 4. Constructed-sibling durables (the per-item wipe): register
        //    "mixed", one real durable is genuine, one is a frame prop.
        //    Old behavior demoted BOTH; the judge must keep the genuine one.
        // ----------------------------------------------------------------
        console.log("Test 4: per-item verdict preserves the independently-supported real durable...");
        reset();
        extractionResponse = {
            conversation_register: "mixed",
            memories: [
                {
                    category: "preferences",
                    abstract: "Swims on Wednesday mornings",
                    overview: "## Preference\n- Wednesday swim",
                    content: "The user swims on Wednesday mornings.",
                    grounding: "real",
                },
                {
                    category: "preferences",
                    abstract: "Keeps a brass spyglass by the window",
                    overview: "## Preference\n- Brass spyglass",
                    content: "The user keeps a brass spyglass by the window.",
                    grounding: "real",
                },
                {
                    category: "entities",
                    abstract: "Imagined schooner: the Petrel",
                    overview: "## Entity\n- The Petrel",
                    content: "The Petrel is the schooner in the imagined scenario.",
                    grounding: "constructed",
                },
            ],
        };
        rejudgeResponse = {
            conversation_register: "mixed",
            results: [
                { index: 1, grounding: "real", reason: "real-life aside stated as themselves" },
                { index: 2, grounding: "constructed", reason: "prop inside the imagined scenario" },
                { index: 3, grounding: "constructed", reason: "entity of the imagined scenario" },
            ],
        };
        await extractor.extractAndPersist("scenario four text", "s4", { scope: "s4", scopeFilter: ["s4"] });
        assert.equal(rejudgeCalls, 1, "rejudge must fire exactly once");
        const rows4 = await listTexts("s4");
        assert.equal(rows4.length, 1, "exactly the judge-confirmed real durable survives");
        assert.ok(rows4[0].includes("Wednesday"), "the genuine aside is preserved");
        assert.ok(
            !rows4.some((t) => t.includes("spyglass") || t.includes("Petrel")),
            "frame props must not be stored",
        );

        // ----------------------------------------------------------------
        // 5. Coherent batch -> the judge must NOT fire.
        // ----------------------------------------------------------------
        console.log("Test 5: coherent batches never fire the rejudge...");
        reset();
        extractionResponse = {
            conversation_register: "mixed",
            memories: [
                {
                    category: "events",
                    abstract: "User explored a harbor-master scenario",
                    overview: "## Event\n- Scenario explored",
                    content: "The user explored a harbor-master scenario this session.",
                    grounding: "real",
                },
                {
                    category: "preferences",
                    abstract: "Imagined fondness for signal flags",
                    overview: "## Preference\n- Signal flags",
                    content: "Inside the scenario the user professes a fondness for signal flags.",
                    grounding: "constructed",
                },
            ],
        };
        rejudgeResponse = null;
        await extractor.extractAndPersist("scenario five text", "s5", { scope: "s5", scopeFilter: ["s5"] });
        assert.equal(rejudgeCalls, 0, "coherent mixed batch must not fire the rejudge");
        const rows5 = await listTexts("s5");
        assert.equal(rows5.length, 1, "the real events note stores, the constructed pref drops");

        console.log("Test 5b: clean real register never fires the rejudge...");
        reset();
        extractionResponse = {
            conversation_register: "real",
            memories: [
                {
                    category: "preferences",
                    abstract: "Takes the 07:10 ferry to work",
                    overview: "## Preference\n- 07:10 ferry",
                    content: "The user takes the 07:10 ferry to work.",
                    grounding: "real",
                },
            ],
        };
        await extractor.extractAndPersist("scenario five-b text", "s5b", { scope: "s5b", scopeFilter: ["s5b"] });
        assert.equal(rejudgeCalls, 0, "clean real batch must not fire the rejudge");
        assert.equal((await listTexts("s5b")).length, 1);

        // ----------------------------------------------------------------
        // 6. Judge failure fails CLOSED: suspect durables are demoted like
        //    the old batch wipe, never stored on a broken verdict.
        // ----------------------------------------------------------------
        console.log("Test 6: judge failure fails closed (suspect durables demoted)...");
        reset();
        extractionResponse = {
            conversation_register: "mixed",
            memories: [
                {
                    category: "preferences",
                    abstract: "Collects tide charts",
                    overview: "## Preference\n- Tide charts",
                    content: "The user collects tide charts.",
                    grounding: "real",
                },
                {
                    category: "entities",
                    abstract: "Imagined cutter: the Gannet",
                    overview: "## Entity\n- The Gannet",
                    content: "The Gannet is the cutter in the imagined scenario.",
                    grounding: "constructed",
                },
            ],
        };
        rejudgeResponse = "malformed";
        await extractor.extractAndPersist("scenario six text", "s6", { scope: "s6", scopeFilter: ["s6"] });
        assert.ok(rejudgeCalls >= 1, "rejudge must have been attempted");
        const rows6 = await listTexts("s6");
        assert.equal(rows6.length, 0, "on judge failure the suspect durable must be demoted, not stored");
        assert.ok(
            logs.some((l) => l.includes("grounding-rejudge") && l.toLowerCase().includes("fail")),
            "the fail-closed path must announce itself in the log",
        );

        // ----------------------------------------------------------------
        // 7. Empty verdict is NOT a clean bill: a well-formed
        //    {"results": []} must quarantine the suspect durables, exactly
        //    like a failed judge (per-item coverage check).
        // ----------------------------------------------------------------
        console.log("Test 7: an empty verdict quarantines unadjudicated durables...");
        reset();
        extractionResponse = {
            conversation_register: "mixed",
            memories: [
                {
                    category: "profile",
                    abstract: "Lives at the harbor lightkeeper cottage",
                    overview: "## Profile\n- Lightkeeper cottage",
                    content: "The user lives at the harbor lightkeeper cottage.",
                    grounding: "real",
                },
                {
                    category: "events",
                    abstract: "User explored a lightkeeper scenario",
                    overview: "## Event\n- Scenario explored",
                    content: "The user explored a lightkeeper scenario this session.",
                    grounding: "real",
                },
            ],
        };
        rejudgeResponse = { conversation_register: "mixed", results: [] };
        await extractor.extractAndPersist("scenario seven text", "s7", { scope: "s7", scopeFilter: ["s7"] });
        assert.equal(rejudgeCalls, 1, "rejudge must fire exactly once");
        const rows7 = await listTexts("s7");
        assert.equal(rows7.length, 1, "the unadjudicated durable must be quarantined, only the events note survives");
        assert.ok(rows7[0].includes("explored a lightkeeper scenario"), "the events note survives");
        assert.ok(
            logs.some((l) => l.includes("grounding-rejudge verdict incomplete")),
            "the coverage-check quarantine must announce itself in the log",
        );

        // ----------------------------------------------------------------
        // 8. Partial verdict: applied in NO part. A response that does not
        //    adjudicate every candidate exactly once cannot be trusted for
        //    the rows it does carry either, so none of it is committed and
        //    every real-tagged durable is quarantined (reviewer ask,
        //    2026-07-26: validate the whole response, then commit atomically).
        // ----------------------------------------------------------------
        console.log("Test 8: a partial verdict is applied in no part...");
        reset();
        extractionResponse = {
            conversation_register: "mixed",
            memories: [
                {
                    category: "preferences",
                    abstract: "Runs along the pier on Fridays",
                    overview: "## Preference\n- Friday pier run",
                    content: "The user runs along the pier on Fridays.",
                    grounding: "real",
                },
                {
                    category: "preferences",
                    abstract: "Keeps a walnut barometer in the hall",
                    overview: "## Preference\n- Walnut barometer",
                    content: "The user keeps a walnut barometer in the hall.",
                    grounding: "real",
                },
            ],
        };
        rejudgeResponse = {
            conversation_register: "mixed",
            results: [
                { index: 1, grounding: "real", reason: "stated as themselves about real life" },
                // index 2 omitted entirely — the judge never adjudicated it
            ],
        };
        await extractor.extractAndPersist("scenario eight text", "s8", { scope: "s8", scopeFilter: ["s8"] });
        assert.equal(rejudgeCalls, 1, "rejudge must fire exactly once");
        const rows8 = await listTexts("s8");
        assert.equal(rows8.length, 0, "a partial verdict commits nothing: both durables are quarantined");
        assert.ok(!rows8.some((t) => t.includes("pier")), "even the row the judge did answer is not committed from an incomplete response");
        assert.ok(!rows8.some((t) => t.includes("barometer")), "the omitted durable must be quarantined");
        assert.ok(
            logs.some((l) => l.includes("grounding-rejudge verdict malformed")),
            "the whole-response rejection must announce itself in the log",
        );

        // ----------------------------------------------------------------
        // 9. Noise-bank guard: a batch emptied by grounding drops must NOT
        //    train the noise bank; a genuine zero-extraction still does.
        // ----------------------------------------------------------------
        console.log("Test 9: grounding-emptied batches do not train the noise bank...");
        let noiseLearnCalls = 0;
        const fakeNoiseBank = {
            initialized: true,
            learn() { noiseLearnCalls++; },
            isNoise() { return false; },
        };
        const noiseExtractor = new SmartExtractor(store, embedder, llm, {
            user: "User", extractMinMessages: 1, extractMaxChars: 8000,
            defaultScope: "test",
            log: (msg) => logs.push(msg),
            debugLog: (msg) => logs.push(msg),
            noiseBank: fakeNoiseBank,
        });
        reset();
        noiseLearnCalls = 0;
        extractionResponse = {
            conversation_register: "fiction",
            memories: [
                {
                    category: "preferences",
                    abstract: "Keeps a tin whistle in the signal room",
                    overview: "## Preference\n- Tin whistle",
                    content: "The user keeps a tin whistle in the signal room.",
                    grounding: "constructed",
                },
            ],
        };
        rejudgeResponse = null;
        await noiseExtractor.extractAndPersist("scenario nine text", "s9", { scope: "s9", scopeFilter: ["s9"] });
        // learnAsNoise is fire-and-forget; give its embed round-trip time to
        // land before asserting either way.
        await new Promise((r) => setTimeout(r, 250));
        assert.equal(noiseLearnCalls, 0, "a grounding-emptied batch must not be learned as noise");
        assert.ok(
            logs.some((l) => l.includes("skipping noise-bank learning")),
            "the skip must announce its reason",
        );

        console.log("Test 9b: a genuine zero-extraction still trains the noise bank...");
        reset();
        noiseLearnCalls = 0;
        extractionResponse = { conversation_register: "real", memories: [] };
        await noiseExtractor.extractAndPersist("scenario nine-b text", "s9b", { scope: "s9b", scopeFilter: ["s9b"] });
        await new Promise((r) => setTimeout(r, 250));
        assert.equal(noiseLearnCalls, 1, "a genuinely empty extraction must still feed the noise bank");

        // ----------------------------------------------------------------
        // 10. Fiction register + judge failure: an event tagged "real" is a
        //     persistence bypass, because events are not durable and so are
        //     never dropped by the fiction-register rule. Without a positive
        //     verdict the item is an in-fiction plot beat as far as we know,
        //     so it must fail closed. (Upstream review, exact-head probe:
        //     an in-story boarding event persisted as a real event.)
        // ----------------------------------------------------------------
        console.log("Test 10: fiction register + failed judge drops an unconfirmed event...");
        reset();
        extractionResponse = {
            conversation_register: "fiction",
            memories: [
                {
                    category: "events",
                    abstract: "Boarded the night train to the capital",
                    overview: "## Event\n- Boarded the night train",
                    content: "Boarded the night train to the capital before the storm closed the pass.",
                    grounding: "real",
                },
                {
                    category: "preferences",
                    abstract: "Prefers the window seat in the dining car",
                    overview: "## Preference\n- Window seat",
                    content: "Prefers the window seat in the dining car.",
                    grounding: "constructed",
                },
            ],
        };
        rejudgeResponse = "malformed";
        await extractor.extractAndPersist("scenario ten text", "s10", { scope: "s10", scopeFilter: ["s10"] });
        const rows10 = await listTexts("s10");
        assert.equal(rows10.length, 0, "an unconfirmed in-fiction event must not be persisted");
        assert.ok(
            logs.some((l) => l.includes("unconfirmed judge-gated candidate")),
            "the judge-gated drop must announce itself",
        );

        console.log("Test 10b: fiction register + judge confirmation keeps an about-fiction event...");
        reset();
        rejudgeResponse = {
            conversation_register: "fiction",
            results: [
                { index: 1, grounding: "real", reason: "a true note about the session itself" },
                { index: 2, grounding: "constructed", reason: "a prop inside the story" },
            ],
        };
        extractionResponse = {
            conversation_register: "fiction",
            memories: [
                {
                    category: "events",
                    abstract: "Ran a three-hour tabletop session on Sunday",
                    overview: "## Event\n- Three-hour tabletop session",
                    content: "Ran a three-hour tabletop session on Thursday morning.",
                    grounding: "real",
                },
                {
                    category: "preferences",
                    abstract: "Prefers the window seat in the dining car",
                    overview: "## Preference\n- Window seat",
                    content: "Prefers the window seat in the dining car.",
                    grounding: "constructed",
                },
            ],
        };
        await extractor.extractAndPersist("scenario ten-b text", "s10b", { scope: "s10b", scopeFilter: ["s10b"] });
        const rows10b = await listTexts("s10b");
        assert.equal(rows10b.length, 1, "a judge-confirmed about-fiction event survives");
        assert.ok(rows10b[0].includes("tabletop"), "the surviving row is the session note");

        // ----------------------------------------------------------------
        // 11. Coverage precedes the register. A partial verdict that claims
        //     "real" must not disable the quarantine for the indices it never
        //     answered. (Upstream review, exact-head probe: an unadjudicated
        //     hypothetical preference persisted.)
        // ----------------------------------------------------------------
        console.log("Test 11: a partial verdict claiming 'real' cannot disable quarantine...");
        reset();
        extractionResponse = {
            conversation_register: "mixed",
            memories: [
                {
                    category: "preferences",
                    abstract: "Would take the mountain route if money were no object",
                    overview: "## Preference\n- Hypothetical mountain route",
                    content: "Says they would take the mountain route if money were no object.",
                    grounding: "real",
                },
                {
                    category: "cases",
                    abstract: "Resolved a stuck freight booking last spring",
                    overview: "## Case\n- Freight booking resolved",
                    content: "Resolved a stuck freight booking last spring.",
                    grounding: "constructed",
                },
            ],
        };
        rejudgeResponse = {
            conversation_register: "real",
            results: [
                { index: 2, grounding: "constructed", reason: "only this one answered" },
            ],
        };
        await extractor.extractAndPersist("scenario eleven text", "s11", { scope: "s11", scopeFilter: ["s11"] });
        const rows11 = await listTexts("s11");
        assert.equal(rows11.length, 0, "the unadjudicated real-tagged durable must stay quarantined");
        assert.ok(
            logs.some((l) => l.includes("refusing register relax")),
            "the refusal to relax the register on partial coverage must be logged",
        );

        console.log("Test 11b: duplicate indices do not fake complete coverage...");
        reset();
        rejudgeResponse = {
            conversation_register: "real",
            results: [
                { index: 2, grounding: "constructed", reason: "answered" },
                { index: 2, grounding: "constructed", reason: "answered again" },
            ],
        };
        await extractor.extractAndPersist("scenario eleven-b text", "s11b", { scope: "s11b", scopeFilter: ["s11b"] });
        const rows11b = await listTexts("s11b");
        assert.equal(rows11b.length, 0, "duplicates collapse, so coverage stays incomplete and quarantine holds");

        console.log("Test 11c: complete coverage may still relax the register...");
        reset();
        rejudgeResponse = {
            conversation_register: "real",
            results: [
                { index: 1, grounding: "real", reason: "a genuine stated preference" },
                { index: 2, grounding: "real", reason: "a real past case" },
            ],
        };
        await extractor.extractAndPersist("scenario eleven-c text", "s11c", { scope: "s11c", scopeFilter: ["s11c"] });
        const rows11c = await listTexts("s11c");
        assert.equal(rows11c.length, 2, "a complete verdict is trusted and both real items persist");

        console.log("\nAll grounding-rejudge tests passed.");
    } finally {
        await new Promise(r => llmServer.close(r));
        await new Promise(r => embeddingServer.close(r));
        rmSync(workDir, { recursive: true, force: true });
    }
}

runTest().then(
    () => process.exit(0),
    (err) => { console.error(err); process.exit(1); },
);
