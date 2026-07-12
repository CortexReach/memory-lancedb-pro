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
