import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { Embedder } = jiti("../src/embedder.ts");

const DIMS = 1024;

/**
 * Test: Ollama embedWithNativeFetch routes single vs batch requests correctly.
 *
 * Issue #629: After PR #621 fixed single embedding, batch embedding failed
 * because /api/embeddings only accepts a single string prompt.
 *
 * Fix:
 * - Single requests: use /api/embeddings + prompt
 * - Batch requests: use /v1/embeddings + input array
 *
 * This test verifies the routing and validation:
 * 1. Single requests hit /api/embeddings
 * 2. Batch requests hit /v1/embeddings
 * 3. Batch responses with wrong count are rejected
 * 4. Batch responses with empty embeddings are rejected
 * 5. Single-element batch still routes to /v1/embeddings
 *
 * NOTE: Uses port 0 to let OS assign an available port, avoiding EADDRINUSE
 * when developers have Ollama running locally on port 11434.
 */

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => resolve(JSON.parse(body)));
    req.on("error", reject);
  });
}

function makeOllamaMock(handler) {
  return http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/embeddings") {
      handler(req, res, "api");
      return;
    }
    if (req.method === "POST" && req.url === "/v1/embeddings") {
      handler(req, res, "v1");
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("unexpected endpoint");
  });
}

function dims() {
  return Array.from({ length: DIMS }, () => Math.random() * 0.1);
}

/**
 * Helper to start a mock server and get its actual port.
 * Uses port 0 to let OS assign an available port.
 */
async function startMockServer(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        resolve(addr.port);
      } else {
        reject(new Error("Failed to get server port"));
      }
    });
    server.on("error", reject);
  });
}

test("single requests use /api/embeddings with prompt field", async () => {
  let capturedBody = null;

  const server = makeOllamaMock(async (req, res, route) => {
    capturedBody = await readJson(req);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ embedding: dims() }));
  });

  const port = await startMockServer(server);
  const baseURL = `http://127.0.0.1:${port}/v1`;

  try {
    const embedder = new Embedder({
      provider: "openai-compatible",
      apiKey: "test-key",
      model: "mxbai-embed-large",
      baseURL,
      dimensions: DIMS,
    });

    const result = await embedder.embedPassage("hello world");

    assert.equal(capturedBody?.model, "mxbai-embed-large");
    assert.equal(capturedBody?.prompt, "hello world");
    assert.equal(Array.isArray(capturedBody?.prompt), false, "prompt should be a string, not array");
    assert.equal(result.length, DIMS);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("batch requests use /v1/embeddings with input array", async () => {
  let capturedBody = null;

  const server = makeOllamaMock(async (req, res, route) => {
    capturedBody = await readJson(req);
    const embeddings = capturedBody.input.map((_, i) => ({
      embedding: dims(),
      index: i,
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: embeddings }));
  });

  const port = await startMockServer(server);
  const baseURL = `http://127.0.0.1:${port}/v1`;

  try {
    const embedder = new Embedder({
      provider: "openai-compatible",
      apiKey: "test-key",
      model: "mxbai-embed-large",
      baseURL,
      dimensions: DIMS,
    });

    const inputs = ["a", "b", "c"];
    const result = await embedder.embedBatchPassage(inputs);

    assert.equal(capturedBody?.model, "mxbai-embed-large");
    assert.deepEqual(capturedBody?.input, inputs);
    assert.equal(Array.isArray(capturedBody?.input), true, "input should be an array");
    assert.equal(result.length, 3);
    result.forEach((emb) => assert.equal(emb.length, DIMS));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("batch rejects response with wrong number of embeddings", async () => {
  const server = makeOllamaMock(async (req, res, route) => {
    if (route !== "v1") {
      res.writeHead(404);
      res.end("unexpected route");
      return;
    }
    const body = await readJson(req);
    // Intentionally return fewer embeddings than requested
    const embeddings = Array.from({ length: Math.max(1, body.input.length - 1) }, (_, i) => ({
      embedding: dims(),
      index: i,
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: embeddings }));
  });

  const port = await startMockServer(server);
  const baseURL = `http://127.0.0.1:${port}/v1`;

  try {
    const embedder = new Embedder({
      provider: "openai-compatible",
      apiKey: "test-key",
      model: "mxbai-embed-large",
      baseURL,
      dimensions: DIMS,
    });

    const inputs = ["a", "b", "c"];
    await assert.rejects(
      async () => embedder.embedBatchPassage(inputs),
      (err) => {
        assert.ok(
          /unexpected result count|invalid response/i.test(err.message),
          `Expected count validation error, got: ${err.message}`,
        );
        return true;
      },
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("batch rejects response with empty embedding array", async () => {
  const server = makeOllamaMock(async (req, res, route) => {
    if (route !== "v1") {
      res.writeHead(404);
      res.end("unexpected route");
      return;
    }
    const body = await readJson(req);
    // Return correct count but one embedding is empty
    const embeddings = body.input.map((_, i) => ({
      embedding: i === 1 ? [] : dims(), // second one is empty
      index: i,
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: embeddings }));
  });

  const port = await startMockServer(server);
  const baseURL = `http://127.0.0.1:${port}/v1`;

  try {
    const embedder = new Embedder({
      provider: "openai-compatible",
      apiKey: "test-key",
      model: "mxbai-embed-large",
      baseURL,
      dimensions: DIMS,
    });

    const inputs = ["a", "b", "c"];
    await assert.rejects(
      async () => embedder.embedBatchPassage(inputs),
      (err) => {
        assert.ok(
          /invalid response/i.test(err.message),
          `Expected invalid response error, got: ${err.message}`,
        );
        return true;
      },
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("single-element batch still routes to /v1/embeddings", async () => {
  let capturedRoute = null;

  const server = makeOllamaMock(async (req, res, route) => {
    capturedRoute = route;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ embedding: dims(), index: 0 }] }));
  });

  const port = await startMockServer(server);
  const baseURL = `http://127.0.0.1:${port}/v1`;

  try {
    const embedder = new Embedder({
      provider: "openai-compatible",
      apiKey: "test-key",
      model: "mxbai-embed-large",
      baseURL,
      dimensions: DIMS,
    });

    // Even with single element, batch route should be used
    const result = await embedder.embedBatchPassage(["only-one"]);

    assert.equal(capturedRoute, "v1", "single-element batch should use /v1/embeddings, not /api/embeddings");
    assert.equal(result.length, 1);
    assert.equal(result[0].length, DIMS);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});