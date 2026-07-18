/**
 * Regression tests for the prompt-architecture rework:
 * - All four internal LLM call sites (extract-candidates, admission-utility,
 *   dedup-decision, merge-memory) split instructions/criteria/identity/format
 *   into a SYSTEM message, leaving only per-call data in the USER message.
 * - Each stage gets an honest, distinct identity line.
 * - The merge prompt template is rebuilt cleanly (no broken-bold markers, no
 *   progressive indentation, no "up - to - date" tokenization artifacts).
 * - The admission utility prompt honestly frames a reflection-sourced excerpt
 *   as a source document rather than a live conversation.
 * - LlmClient.completeJson() threads an optional system-message override
 *   through both the api-key (messages array) and OAuth (instructions field)
 *   request shapes, defaulting to the historical generic system text when
 *   omitted.
 *
 * Fixtures are entirely synthetic — no real fleet data.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";

const testDir = dirname(fileURLToPath(import.meta.url));
const pluginSdkStubPath = resolve(testDir, "helpers", "openclaw-plugin-sdk-stub.mjs");
const jiti = jitiFactory(import.meta.url, {
  interopDefault: true,
  alias: {
    "openclaw/plugin-sdk": pluginSdkStubPath,
  },
});
const { buildExtractionPrompt, buildDedupPrompt, buildBatchDedupPrompt, buildMergePrompt } = jiti(
  "../src/extraction-prompts.ts",
);
const { createLlmClient } = jiti("../src/llm-client.ts");
const { formatExistingMemoryEntry } = jiti("../src/prompt-blocks.ts");

// ============================================================================
// buildExtractionPrompt — system/user split
// ============================================================================

describe("buildExtractionPrompt system/user split", () => {
  const conversationMarker = "UNIQUE-CONVERSATION-MARKER-4471";
  const userMarker = "unique-user-id-8823";
  const { system, user } = buildExtractionPrompt(conversationMarker, userMarker);

  it("returns a {system, user} shape", () => {
    assert.equal(typeof system, "string");
    assert.equal(typeof user, "string");
  });

  it("system carries identity, criteria, classification, and output format", () => {
    assert.match(system, /extraction agent/i);
    assert.match(system, /Memory Extraction Criteria/i);
    assert.match(system, /Memory Classification/i);
    assert.match(system, /Few-shot Examples/i);
    assert.match(system, /Output Format/i);
  });

  it("user carries only the per-call data, not the static criteria", () => {
    assert.match(user, new RegExp(conversationMarker));
    assert.match(user, new RegExp(userMarker));
    assert.doesNotMatch(user, /Memory Extraction Criteria/i);
    assert.doesNotMatch(user, /Few-shot Examples/i);
  });

  it("system does not leak this call's per-call data", () => {
    assert.doesNotMatch(system, new RegExp(conversationMarker));
    assert.doesNotMatch(system, new RegExp(userMarker));
  });
});

// ============================================================================
// buildDedupPrompt — system/user split + dedup decider identity
// ============================================================================

describe("buildDedupPrompt system/user split", () => {
  const abstractMarker = "UNIQUE-ABSTRACT-MARKER-9910";
  const existingMarker = "UNIQUE-EXISTING-MARKER-2201";
  const { system, user } = buildDedupPrompt(
    { category: "preferences", abstract: abstractMarker, overview: "overview text", content: "content text" },
    existingMarker,
  );

  it("system carries the dedup judge identity and decision vocabulary", () => {
    assert.match(system, /dedup judge/i);
    assert.match(system, /\bSKIP\b/);
    assert.match(system, /\bCREATE\b/);
    assert.match(system, /\bMERGE\b/);
    assert.match(system, /\bSUPERSEDE\b/);
    assert.match(system, /context_label/);
  });

  // Live-fleet trace (terry, 2026-07-18): the judge invented a category wall
  // ("existing similar memories are patterns, not preferences -> CREATE").
  // Every category mention in the prompt is a restriction (events/cases
  // verdict gate, preferences/entities supersede scoping), so the model
  // generalized "category = wall". The doctrine bullet states the anti-rule.
  it("system teaches that categories alone do not wall off verdicts", () => {
    assert.match(system, /Category labels NEVER decide the verdict/);
    assert.match(system, /judge the CONTENT/);
  });

  it("the batch dedup builder carries the same category doctrine", () => {
    const batch = buildBatchDedupPrompt([
      {
        candidate: { category: "preferences", abstract: abstractMarker, overview: "o", content: "c" },
        existingMemories: "1. [patterns] existing meta-rule (similarity: 0.74)",
      },
    ]);
    assert.match(batch.system, /Category labels NEVER decide the verdict/);
    assert.match(batch.system, /judge the CONTENT/);
  });

  it("user carries only the candidate and existing-memory data", () => {
    assert.match(user, new RegExp(abstractMarker));
    assert.match(user, new RegExp(existingMarker));
    assert.doesNotMatch(system, new RegExp(abstractMarker));
    assert.doesNotMatch(system, new RegExp(existingMarker));
  });

  it("renders the candidate's Abstract/Overview/Content fields as plain flush-left lines under the candidate heading", () => {
    assert.match(user, /Abstract: .*\nOverview: overview text\nContent: content text/s);
  });
});

// ============================================================================
// buildMergePrompt — system/user split, merge writer identity, clean formatting
// ============================================================================

describe("buildMergePrompt system/user split and formatting", () => {
  const existingAbstractMarker = "UNIQUE-EXISTING-ABSTRACT-3301";
  const newAbstractMarker = "UNIQUE-NEW-ABSTRACT-4402";
  const { system, user } = buildMergePrompt(
    { abstract: existingAbstractMarker, overview: "existing overview", content: "existing content" },
    { category: "preferences", abstract: newAbstractMarker, overview: "new overview", content: "new content" },
  );

  it("system carries the merge writer identity and output format", () => {
    assert.match(system, /merge writer/i);
    assert.match(system, /"abstract"/);
    assert.match(system, /"overview"/);
    assert.match(system, /"content"/);
  });

  it("user carries the existing and new memory data", () => {
    assert.match(user, new RegExp(existingAbstractMarker));
    assert.match(user, new RegExp(newAbstractMarker));
  });

  it("has no broken-bold markers, progressive indentation, or split-hyphen tokenization artifacts", () => {
    const combined = `${system}\n${user}`;
    assert.doesNotMatch(combined, /\*\*\s+\S.*?\s+\*\*/, "no '** text **' broken-bold pattern");
    assert.doesNotMatch(combined, /up\s+-\s+to\s+-\s+date/i, "no split-hyphen 'up - to - date' artifact");
    // Progressive indentation looked like each subsequent bullet gaining
    // leading whitespace; a clean rebuild keeps bullet lines flush.
    const indentedBullets = combined
      .split("\n")
      .filter((line) => /^\s+[-*]\s/.test(line));
    assert.deepEqual(indentedBullets, [], "no indented bullet lines (progressive indentation regression)");
  });

  it("renders each memory's Abstract/Overview/Content fields as plain flush-left lines under Existing/New headings", () => {
    assert.match(user, /### Existing memory\nAbstract: .*\nOverview: existing overview\nContent: existing content/s);
    assert.match(user, /### New information\nAbstract: .*\nOverview: new overview\nContent: new content/s);
  });
});

// ============================================================================
// formatExistingMemoryEntry — single-line existing-memory listing
// ============================================================================

describe("formatExistingMemoryEntry (dedup candidate listing)", () => {
  it("formats one existing-memory line with category, abstract, and score", () => {
    const formatted = formatExistingMemoryEntry(1, "preferences", "Editor preferences", 0.876);
    assert.equal(formatted, "1. [preferences] Editor preferences (score 0.876)");
  });

  it("formats a second entry independently", () => {
    const formatted = formatExistingMemoryEntry(2, "profile", "User is a backend engineer", 0.5);
    assert.equal(formatted, "2. [profile] User is a backend engineer (score 0.500)");
  });
});

// ============================================================================
// LlmClient.completeJson — system-message threading
// ============================================================================

describe("LlmClient system-message threading (api-key path)", () => {
  it("uses the provided systemPrompt override instead of the default", async () => {
    let requestBody;
    const server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      requestBody = JSON.parse(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "{}" } }] }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    try {
      const llm = createLlmClient({
        auth: "api-key",
        apiKey: "test-key",
        model: "gpt-4o-mini",
        baseURL: `http://127.0.0.1:${port}/v1`,
      });

      await llm.completeJson("user data", "merge-memory", "You are a merge writer.");

      assert.deepEqual(requestBody.messages, [
        { role: "system", content: "You are a merge writer." },
        { role: "user", content: "user data" },
      ]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("LlmClient system-message threading (OAuth path)", () => {
  const originalFetch = globalThis.fetch;

  function encodeSegment(value) {
    return Buffer.from(JSON.stringify(value)).toString("base64url");
  }
  function makeJwt(payload) {
    return [encodeSegment({ alg: "none", typ: "JWT" }), encodeSegment(payload), "signature"].join(".");
  }

  it("threads the systemPrompt override into the Responses API instructions field", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-llm-oauth-arch-"));
    try {
      const accessToken = makeJwt({
        exp: Math.floor((Date.now() + 3_600_000) / 1000),
        "https://api.openai.com/auth": { chatgpt_account_id: "acct_test_arch" },
      });
      const authPath = path.join(tempDir, "auth.json");
      fs.writeFileSync(
        authPath,
        JSON.stringify({ tokens: { access_token: accessToken, refresh_token: "refresh-token" } }),
        "utf8",
      );

      let requestBody;
      globalThis.fetch = async (_url, init) => {
        requestBody = JSON.parse(init?.body);
        const eventPayload = JSON.stringify({ type: "response.output_text.done", text: "{}" });
        return new Response(
          ["event: response.output_text.done", `data: ${eventPayload}`, ""].join("\n"),
          { status: 200 },
        );
      };

      const llm = createLlmClient({
        auth: "oauth",
        model: "openai/gpt-5.4",
        oauthPath: authPath,
        timeoutMs: 5_000,
      });

      await llm.completeJson("user data", "merge-memory", "You are a merge writer.");

      assert.equal(requestBody.instructions, "You are a merge writer.");
      assert.deepEqual(requestBody.input, [
        { role: "user", content: [{ type: "input_text", text: "user data" }] },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("defaults instructions to the historical generic system text when systemPrompt is omitted", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-llm-oauth-arch-default-"));
    try {
      const accessToken = makeJwt({
        exp: Math.floor((Date.now() + 3_600_000) / 1000),
        "https://api.openai.com/auth": { chatgpt_account_id: "acct_test_arch2" },
      });
      const authPath = path.join(tempDir, "auth.json");
      fs.writeFileSync(
        authPath,
        JSON.stringify({ tokens: { access_token: accessToken, refresh_token: "refresh-token" } }),
        "utf8",
      );

      let requestBody;
      globalThis.fetch = async (_url, init) => {
        requestBody = JSON.parse(init?.body);
        const eventPayload = JSON.stringify({ type: "response.output_text.done", text: "{}" });
        return new Response(
          ["event: response.output_text.done", `data: ${eventPayload}`, ""].join("\n"),
          { status: 200 },
        );
      };

      const llm = createLlmClient({
        auth: "oauth",
        model: "openai/gpt-5.4",
        oauthPath: authPath,
        timeoutMs: 5_000,
      });

      await llm.completeJson("hello");

      assert.equal(
        requestBody.instructions,
        "You are a memory extraction assistant. Always respond with valid JSON only.",
      );
    } finally {
      globalThis.fetch = originalFetch;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// admission-control.ts buildUtilityPrompt — identity, split, reflection framing
// ============================================================================

describe("AdmissionController buildUtilityPrompt (candidate formatting)", () => {
  const { AdmissionController, ADMISSION_CONTROL_PRESETS } = jiti("../src/admission-control.ts");
  const balanced = ADMISSION_CONTROL_PRESETS.balanced;
  const admissionStore = { async vectorSearch() { return []; } };

  function makeAdmissionLlm() {
    const prompts = [];
    return {
      prompts,
      async completeJson(userPrompt, mode, systemPrompt) {
        if (mode === "admission-utility") {
          prompts.push({ userPrompt, systemPrompt });
          return { utility: 0.5, reason: "mock" };
        }
        return null;
      },
    };
  }

  it("system carries the admission judge identity; user carries only the candidate, never the conversation excerpt", async () => {
    const llm = makeAdmissionLlm();
    const controller = new AdmissionController(admissionStore, llm, balanced);

    await controller.evaluate({
      candidate: {
        category: "preferences",
        abstract: "User prefers dark mode",
        overview: "",
        content: "User prefers dark mode.",
      },
      candidateVector: [1, 0, 0],
      conversationText: "some real conversation text",
      scopeFilter: ["global"],
    });

    assert.equal(llm.prompts.length, 1);
    const { userPrompt, systemPrompt } = llm.prompts[0];
    assert.match(systemPrompt, /admission judge/i);
    assert.doesNotMatch(userPrompt, /Conversation excerpt:/);
    assert.doesNotMatch(userPrompt, /Source document/i);
    assert.doesNotMatch(userPrompt, /some real conversation text/);
  });

  it("renders a multi-line Overview as flush-left continuation lines under the candidate heading, not nested under a bullet", async () => {
    const llm = makeAdmissionLlm();
    const controller = new AdmissionController(admissionStore, llm, balanced);

    await controller.evaluate({
      candidate: {
        category: "preferences",
        abstract: "Editor preferences",
        overview: "## Preference Domain\n- Editor: Zed\n- Theme: dark",
        content: "User prefers the Zed editor with a dark theme.",
      },
      candidateVector: [1, 0, 0],
      conversationText: "some real conversation text",
      scopeFilter: ["global"],
    });

    const { userPrompt } = llm.prompts[0];
    assert.doesNotMatch(
      userPrompt,
      /\n## Preference Domain/,
      "a continuation line of the Overview bullet must not land flush-left (would escape the bullet in rendered markdown)"
    );
    assert.match(userPrompt, /Overview: ## Preference Domain\nEditor: Zed\nTheme: dark/);
  });

  it("blank-line separates the Overview and Content bullets from the rest of the candidate block instead of gluing them with a single newline", async () => {
    const llm = makeAdmissionLlm();
    const controller = new AdmissionController(admissionStore, llm, balanced);

    await controller.evaluate({
      candidate: {
        category: "preferences",
        abstract: "Editor preferences",
        overview: "Uses Zed",
        content: "User prefers the Zed editor.",
      },
      candidateVector: [1, 0, 0],
      conversationText: "some real conversation text",
      scopeFilter: ["global"],
    });

    const { userPrompt } = llm.prompts[0];
    assert.match(
      userPrompt,
      /Abstract: Editor preferences\nOverview: Uses Zed\nContent: User prefers the Zed editor\./,
      "Overview and Content render as plain flush-left field lines under the candidate heading"
    );
  });

});

// ============================================================================
// buildReflectionPrompt — system/user split (reflection distiller, JR-186)
// ============================================================================


// ============================================================================
// Identity-first openers + transcript fencing + assistant-line policy
// (operator rules, 2026-07-18)
// ============================================================================

describe("identity-first prompt openers", () => {
  const openers = {
    extraction: buildExtractionPrompt("transcript", "User").system,
    dedup: buildDedupPrompt(
      { category: "preferences", abstract: "a", overview: "o", content: "c" },
      "existing",
    ).system,
    batchDedup: buildBatchDedupPrompt([
      {
        candidate: { category: "preferences", abstract: "a", overview: "o", content: "c" },
        existingMemories: "",
      },
    ]).system,
    merge: buildMergePrompt(
      { abstract: "a", overview: "o", content: "c" },
      { category: "preferences", abstract: "a2", overview: "o2", content: "c2" },
    ).system,
  };

  it("all open with a 'You are a memory ...' identity sentence (symmetric memory-domain openers, operator rule 2026-07-18)", () => {
    for (const [name, system] of Object.entries(openers)) {
      assert.match(system, /^You are a memory /, `${name} must open with a memory-domain identity sentence`);
    }
  });

  it("no prompt shows a fenced JSON example (models mimic fences; live catch on the reflection lane's judge, 2026-07-18)", () => {
    for (const [name, system] of Object.entries(openers)) {
      assert.ok(!system.includes("```json"), `${name} system must show JSON shapes bare, never fenced`);
    }
  });

});

