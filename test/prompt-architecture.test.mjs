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
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { buildExtractionPrompt, buildDedupPrompt, buildMergePrompt } = jiti(
  "../src/extraction-prompts.ts",
);
const { createLlmClient } = jiti("../src/llm-client.ts");

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
    abstractMarker,
    "overview text",
    "content text",
    existingMarker,
  );

  it("system carries the dedup decider identity and decision vocabulary", () => {
    assert.match(system, /dedup decider/i);
    assert.match(system, /\bSKIP\b/);
    assert.match(system, /\bCREATE\b/);
    assert.match(system, /\bMERGE\b/);
    assert.match(system, /\bSUPERSEDE\b/);
    assert.match(system, /context_label/);
  });

  it("user carries only the candidate and existing-memory data", () => {
    assert.match(user, new RegExp(abstractMarker));
    assert.match(user, new RegExp(existingMarker));
    assert.doesNotMatch(system, new RegExp(abstractMarker));
    assert.doesNotMatch(system, new RegExp(existingMarker));
  });
});

// ============================================================================
// buildMergePrompt — system/user split, merge writer identity, clean formatting
// ============================================================================

describe("buildMergePrompt system/user split and formatting", () => {
  const existingAbstractMarker = "UNIQUE-EXISTING-ABSTRACT-3301";
  const newAbstractMarker = "UNIQUE-NEW-ABSTRACT-4402";
  const { system, user } = buildMergePrompt(
    existingAbstractMarker,
    "existing overview",
    "existing content",
    newAbstractMarker,
    "new overview",
    "new content",
    "preferences",
  );

  it("system carries the merge writer identity and output format", () => {
    assert.match(system, /merge writer/i);
    assert.match(system, /"abstract"/);
    assert.match(system, /"overview"/);
    assert.match(system, /"content"/);
  });

  it("user carries only the category and existing/new memory data", () => {
    assert.match(user, /preferences/);
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

describe("AdmissionController buildUtilityPrompt (source-kind framing)", () => {
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

  it("system carries the admission judge identity; user defaults to a Conversation excerpt framing", async () => {
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
    assert.match(userPrompt, /Conversation excerpt:/);
    assert.doesNotMatch(userPrompt, /Source document/i);
  });

  it("frames a reflection-sourced excerpt as a source document, not a conversation", async () => {
    const llm = makeAdmissionLlm();
    const controller = new AdmissionController(admissionStore, llm, balanced);

    await controller.evaluate({
      candidate: {
        category: "cases",
        abstract: "Lesson learned about retries",
        overview: "",
        content: "Always add jitter to retry backoff.",
      },
      candidateVector: [1, 0, 0],
      conversationText: "## Lessons & pitfalls\n- Always add jitter to retry backoff",
      scopeFilter: ["global"],
      sourceKind: "reflection",
    });

    assert.equal(llm.prompts.length, 1);
    const { userPrompt } = llm.prompts[0];
    assert.match(userPrompt, /Source document \(agent reflection\)/i);
    assert.doesNotMatch(userPrompt, /Conversation excerpt:/);
  });
});
