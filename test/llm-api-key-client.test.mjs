import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, describe, it } from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { createLlmClient, shouldDisableReasoningForJson, stripReasoningTrace } = jiti("../src/llm-client.ts");

describe("LLM api-key client", () => {
  let server;

  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
  });

  it("uses chat.completions.create semantics with the provided api-key configuration", async () => {
    let requestHeaders;
    let requestBody;

    server = http.createServer(async (req, res) => {
      requestHeaders = req.headers;

      let body = "";
      for await (const chunk of req) body += chunk;
      requestBody = JSON.parse(body);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [
          {
            message: {
              content: "{\"memories\":[]}",
            },
          },
        ],
      }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    const llm = createLlmClient({
      auth: "api-key",
      apiKey: "test-api-key",
      model: "gpt-4o-mini",
      baseURL: `http://127.0.0.1:${port}/v1`,
      timeoutMs: 4321,
    });

    const result = await llm.completeJson("hello", "api-key-probe");
    assert.deepEqual(result, { memories: [] });
    assert.equal(requestHeaders.authorization, "Bearer test-api-key");
    assert.equal(
      requestHeaders["x-memory-call-label"],
      "api-key-probe",
      "the internal call label must reach the gateway as a request header",
    );
    assert.equal(requestBody.model, "gpt-4o-mini");
    assert.deepEqual(requestBody.messages, [
      {
        role: "system",
        content: "You are a memory extraction assistant. Always respond with valid JSON only.",
      },
      {
        role: "user",
        content: "hello",
      },
    ]);
    assert.equal(requestBody.temperature, 0.1);
    assert.equal(requestBody.chat_template_kwargs, undefined);
  });

  it("sanitizes control/invalid characters out of the call label header", async () => {
    let requestHeaders;

    server = http.createServer(async (req, res) => {
      requestHeaders = req.headers;
      for await (const _chunk of req) { /* drain */ }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "{\"memories\":[]}" } }] }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    const llm = createLlmClient({
      auth: "api-key",
      apiKey: "test-api-key",
      model: "gpt-4o-mini",
      baseURL: `http://127.0.0.1:${port}/v1`,
    });

    await llm.completeJson("hello", "weird label!!\r\ninjected: true");
    assert.equal(
      requestHeaders["x-memory-call-label"],
      "weird-label----injected--true",
      "non [A-Za-z0-9._-] characters (including CR/LF, which could otherwise inject a header) must be replaced with -",
    );
  });

  it("truncates a call label header at 64 characters", async () => {
    let requestHeaders;

    server = http.createServer(async (req, res) => {
      requestHeaders = req.headers;
      for await (const _chunk of req) { /* drain */ }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "{\"memories\":[]}" } }] }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    const llm = createLlmClient({
      auth: "api-key",
      apiKey: "test-api-key",
      model: "gpt-4o-mini",
      baseURL: `http://127.0.0.1:${port}/v1`,
    });

    const longLabel = "a".repeat(100);
    await llm.completeJson("hello", longLabel);
    assert.equal(requestHeaders["x-memory-call-label"], "a".repeat(64));
  });

  it("falls back to \"generic\" for a label that sanitizes to empty", async () => {
    let requestHeaders;

    server = http.createServer(async (req, res) => {
      requestHeaders = req.headers;
      for await (const _chunk of req) { /* drain */ }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "{\"memories\":[]}" } }] }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    const llm = createLlmClient({
      auth: "api-key",
      apiKey: "test-api-key",
      model: "gpt-4o-mini",
      baseURL: `http://127.0.0.1:${port}/v1`,
    });

    // Every character the sanitizer regex rejects gets replaced with "-" (itself a
    // valid, non-empty character), so a label full of invalid characters (e.g.
    // "!!!###") sanitizes to "------", not "". The only input that actually reaches
    // the sanitizer's `cleaned || "generic"` fallback is a genuinely empty label —
    // and completeJson's own `label = "generic"` default only applies to `undefined`,
    // not "", so an explicit empty string is the one way to exercise this branch.
    await llm.completeJson("hello", "");
    assert.equal(requestHeaders["x-memory-call-label"], "generic");
  });

  it("disables thinking for reasoning models and strips reasoning traces before JSON parse", async () => {
    let requestBody;

    server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      requestBody = JSON.parse(body);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [
          {
            message: {
              content: "<think>plan first</think>{\"memories\":[{\"text\":\"clean json\"}]}",
            },
          },
        ],
      }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    const llm = createLlmClient({
      auth: "api-key",
      apiKey: "test-api-key",
      model: "Qwen3.5-27B-FP8",
      baseURL: `http://127.0.0.1:${port}/v1`,
    });

    const result = await llm.completeJson("extract", "reasoning-probe");
    assert.deepEqual(result, { memories: [{ text: "clean json" }] });
    assert.deepEqual(requestBody.chat_template_kwargs, { enable_thinking: false });
  });

  it("detects known reasoning model names", () => {
    assert.equal(shouldDisableReasoningForJson("qwen3.5-27b-fp8"), true);
    assert.equal(shouldDisableReasoningForJson("DeepSeek-R1-Distill-Qwen-32B"), true);
    assert.equal(shouldDisableReasoningForJson("QwQ-32B"), true);
    assert.equal(shouldDisableReasoningForJson("gpt-4o-mini"), false);
    assert.equal(stripReasoningTrace("<think>{\"bad\":true}</think>{\"ok\":true}"), "{\"ok\":true}");
  });

  it("recovers JSON from reasoning_content when message content is empty", async () => {
    const logs = [];
    server = http.createServer(async (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [
          {
            message: {
              content: "",
              reasoning_content: "thinking it through... {\"memories\":[]}",
            },
          },
        ],
      }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    const llm = createLlmClient({
      auth: "api-key",
      apiKey: "test-api-key",
      model: "gpt-4o-mini",
      baseURL: `http://127.0.0.1:${port}/v1`,
      log: (message) => logs.push(message),
    });

    const result = await llm.completeJson("extract", "reasoning-content-probe");
    assert.deepEqual(result, { memories: [] });
    assert.ok(logs.some((message) => message.includes("recovered JSON from reasoning field")));
  });

  it("recovers JSON from the vLLM-style reasoning field when message content is empty", async () => {
    server = http.createServer(async (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [
          {
            message: {
              content: "",
              reasoning: "thinking...\n{\"memories\":[{\"text\":\"recovered\"}]}",
            },
          },
        ],
      }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    const llm = createLlmClient({
      auth: "api-key",
      apiKey: "test-api-key",
      model: "Qwen3-235B-A22B",
      baseURL: `http://127.0.0.1:${port}/v1`,
    });

    const result = await llm.completeJson("extract", "reasoning-probe");
    assert.deepEqual(result, { memories: [{ text: "recovered" }] });
  });

  it("falls through to null when neither content nor reasoning fields yield JSON", async () => {
    const logs = [];
    server = http.createServer(async (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [
          {
            message: {
              content: "",
              reasoning: "just thinking out loud, nothing structured here",
            },
          },
        ],
      }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    const llm = createLlmClient({
      auth: "api-key",
      apiKey: "test-api-key",
      model: "gpt-4o-mini",
      baseURL: `http://127.0.0.1:${port}/v1`,
      log: (message) => logs.push(message),
    });

    const result = await llm.completeJson("extract", "reasoning-fallthrough");
    assert.equal(result, null);
    assert.ok(logs.some((message) => message.includes("empty response content")));
  });
});
