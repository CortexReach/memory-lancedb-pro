import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, describe, it } from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { createLlmClient } = jiti("../src/llm-client.ts");

const DEFAULT_SYSTEM_PROMPT =
  "You are a memory extraction assistant. Always respond with valid JSON only.";

describe("LLM host transport", () => {
  let server;

  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
  });

  it("defaults to the direct transport when llm.transport is not configured", async () => {
    let requestBody;
    server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      requestBody = JSON.parse(body);
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

    const result = await llm.completeJson("hello", "default-transport-probe");
    assert.deepEqual(result, { memories: [] });
    assert.equal(requestBody.model, "gpt-4o-mini");
  });

  it("routes extract-candidates through the host runtime transport, capturing model and messages", async () => {
    const calls = [];
    const runtimeLlmComplete = async (params) => {
      calls.push(params);
      return { text: "{\"memories\":[]}", provider: "openrouter", model: params.model };
    };

    const llm = createLlmClient({
      transport: "host",
      model: "openrouter/anthropic/claude-opus-4-8",
      runtimeLlmComplete,
    });

    const result = await llm.completeJson("conversation text to extract from", "extract-candidates");

    assert.deepEqual(result, { memories: [] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, "openrouter/anthropic/claude-opus-4-8");
    assert.deepEqual(calls[0].messages, [
      { role: "system", content: DEFAULT_SYSTEM_PROMPT },
      { role: "user", content: "conversation text to extract from" },
    ]);
    assert.equal(calls[0].purpose, "memory-lancedb-pro:extract-candidates");
  });

  it("routes admission-utility through the host runtime transport, capturing model and messages", async () => {
    const calls = [];
    const runtimeLlmComplete = async (params) => {
      calls.push(params);
      return { text: "{\"utility\":0.7,\"reason\":\"relevant\"}" };
    };

    const llm = createLlmClient({
      transport: "host",
      model: "openrouter/anthropic/claude-opus-4-8",
      runtimeLlmComplete,
    });

    const result = await llm.completeJson("score this candidate", "admission-utility");

    assert.deepEqual(result, { utility: 0.7, reason: "relevant" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, "openrouter/anthropic/claude-opus-4-8");
    assert.equal(calls[0].purpose, "memory-lancedb-pro:admission-utility");
  });

  it("forwards a default reasoning effort to the host runtime call when llm.reasoningEffort is not configured", async () => {
    const calls = [];
    const runtimeLlmComplete = async (params) => {
      calls.push(params);
      return { text: "{\"memories\":[]}" };
    };

    const llm = createLlmClient({
      transport: "host",
      model: "openrouter/openai/gpt-oss-120b",
      runtimeLlmComplete,
    });

    await llm.completeJson("conversation text to extract from", "extract-candidates");

    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].reasoning,
      "medium",
      "an unconfigured host-transport call must still send an explicit reasoning effort -- core has been observed to fall through to a disabled/no-reasoning default when the field is omitted",
    );
  });

  it("forwards an explicit llm.reasoningEffort override to the host runtime call", async () => {
    const calls = [];
    const runtimeLlmComplete = async (params) => {
      calls.push(params);
      return { text: "{\"memories\":[]}" };
    };

    const llm = createLlmClient({
      transport: "host",
      model: "openrouter/openai/gpt-oss-120b",
      reasoningEffort: "high",
      runtimeLlmComplete,
    });

    await llm.completeJson("conversation text to extract from", "extract-candidates");

    assert.equal(calls.length, 1);
    assert.equal(calls[0].reasoning, "high");
  });

  it("falls back to the default reasoning effort when llm.reasoningEffort is configured as an empty/blank string", async () => {
    const calls = [];
    const runtimeLlmComplete = async (params) => {
      calls.push(params);
      return { text: "{\"memories\":[]}" };
    };

    const llm = createLlmClient({
      transport: "host",
      model: "openrouter/openai/gpt-oss-120b",
      reasoningEffort: "   ",
      runtimeLlmComplete,
    });

    await llm.completeJson("conversation text to extract from", "extract-candidates");

    assert.equal(calls.length, 1);
    assert.equal(calls[0].reasoning, "medium");
  });

  it("falls back to the direct transport with a warning when the host runtime surface is unavailable", async () => {
    let requestBody;
    server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      requestBody = JSON.parse(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "{\"memories\":[]}" } }] }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    const warnLogs = [];
    const llm = createLlmClient({
      transport: "host",
      auth: "api-key",
      apiKey: "test-api-key",
      model: "gpt-4o-mini",
      baseURL: `http://127.0.0.1:${port}/v1`,
      warnLog: (msg) => warnLogs.push(msg),
    });

    const result = await llm.completeJson("hello", "fallback-probe");

    assert.deepEqual(result, { memories: [] });
    assert.equal(requestBody.model, "gpt-4o-mini");
    assert.ok(
      warnLogs.some((msg) => msg.includes("runtime.llm.complete") || msg.includes("falling back")),
      `expected a fallback warning, got: ${JSON.stringify(warnLogs)}`,
    );
  });

  it("normalizes a core-style catalog model to the bare id when falling back from host to direct", async () => {
    let requestBody;
    server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      requestBody = JSON.parse(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "{\"memories\":[]}" } }] }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    const llm = createLlmClient({
      transport: "host",
      auth: "api-key",
      apiKey: "test-api-key",
      model: "openrouter/openai/gpt-oss-120b",
      baseURL: `http://127.0.0.1:${port}/v1`,
      warnLog: () => {},
    });

    const result = await llm.completeJson("hello", "fallback-model-probe");

    assert.deepEqual(result, { memories: [] });
    assert.equal(
      requestBody.model,
      "openai/gpt-oss-120b",
      "the direct client sent by the host->direct fallback must receive the bare provider-stripped id",
    );
  });

  it("keeps an explicit direct transport's catalog-style model string unchanged (byte-identical regression)", async () => {
    let requestBody;
    server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      requestBody = JSON.parse(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "{\"memories\":[]}" } }] }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    const llm = createLlmClient({
      auth: "api-key",
      apiKey: "test-api-key",
      model: "openrouter/openai/gpt-oss-120b",
      baseURL: `http://127.0.0.1:${port}/v1`,
    });

    const result = await llm.completeJson("hello", "explicit-direct-probe");

    assert.deepEqual(result, { memories: [] });
    assert.equal(
      requestBody.model,
      "openrouter/openai/gpt-oss-120b",
      "an explicitly-configured direct transport must send the model unchanged, exactly as before this change",
    );
  });

  it("returns null and records lastError on a malformed host transport response", async () => {
    const runtimeLlmComplete = async () => ({ text: "this is not json at all" });

    const llm = createLlmClient({
      transport: "host",
      model: "some-model",
      runtimeLlmComplete,
    });

    const result = await llm.completeJson("prompt", "malformed-probe");

    assert.equal(result, null);
    assert.ok(llm.getLastError()?.includes("no JSON object found"));
  });

  it("returns null and records lastError when the host transport call throws", async () => {
    const warnLogs = [];
    const runtimeLlmComplete = async () => {
      throw new Error("simulated host outage");
    };

    const llm = createLlmClient({
      transport: "host",
      model: "some-model",
      runtimeLlmComplete,
      warnLog: (msg) => warnLogs.push(msg),
    });

    const result = await llm.completeJson("prompt", "throw-probe");

    assert.equal(result, null);
    assert.ok(llm.getLastError()?.includes("simulated host outage"));
    assert.ok(warnLogs.some((msg) => msg.includes("simulated host outage")));
  });

  it("bounds a hanging host transport call with timeoutMs and returns null", async () => {
    const runtimeLlmComplete = () => new Promise(() => {});

    const llm = createLlmClient({
      transport: "host",
      model: "some-model",
      timeoutMs: 50,
      runtimeLlmComplete,
    });

    const start = Date.now();
    const result = await llm.completeJson("prompt", "timeout-probe");
    const elapsed = Date.now() - start;

    assert.equal(result, null);
    assert.ok(elapsed < 2000, `expected the timeout guard to bound the call, took ${elapsed}ms`);
    assert.ok(llm.getLastError()?.includes("timed out"));
  });
});
