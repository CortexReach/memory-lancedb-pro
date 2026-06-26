import assert from "node:assert/strict";
import http from "node:http";
import Module from "node:module";
import { test } from "node:test";

import jitiFactory from "jiti";

process.env.NODE_PATH = [
  process.env.NODE_PATH,
  "/opt/homebrew/lib/node_modules/openclaw/node_modules",
  "/opt/homebrew/lib/node_modules",
].filter(Boolean).join(":");
Module._initPaths();

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { Embedder } = jiti("../src/embedder.ts");
const { parsePluginConfig } = jiti("../index.ts");

const DIMS = 768;

function dims() {
  return Array.from({ length: DIMS }, () => 0.01);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => resolve(JSON.parse(body)));
    req.on("error", reject);
  });
}

function makeEmbeddingServer(requests) {
  return http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/embeddings") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("unexpected endpoint");
      return;
    }

    const body = await readJson(req);
    requests.push(body);
    const count = Array.isArray(body.input) ? body.input.length : 1;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      data: Array.from({ length: count }, () => ({ embedding: dims() })),
    }));
  });
}

function makeAggregateLimitEmbeddingServer(requests) {
  return http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/embeddings") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("unexpected endpoint");
      return;
    }

    const body = await readJson(req);
    requests.push(body);
    if (Array.isArray(body.input) && body.input.length > 1) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "batch context length exceeded" } }));
      return;
    }

    const count = Array.isArray(body.input) ? body.input.length : 1;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      data: Array.from({ length: count }, () => ({ embedding: dims() })),
    }));
  });
}

async function withEmbeddingServer(fn) {
  const requests = [];
  const server = makeEmbeddingServer(requests);
  const port = await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("server did not expose a port"));
    });
    server.on("error", reject);
  });

  try {
    await fn(`http://127.0.0.1:${port}/v1`, requests);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withAggregateLimitEmbeddingServer(fn) {
  const requests = [];
  const server = makeAggregateLimitEmbeddingServer(requests);
  const port = await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("server did not expose a port"));
    });
    server.on("error", reject);
  });

  try {
    await fn(`http://127.0.0.1:${port}/v1`, requests);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function flattenRequestInputs(requests) {
  return requests.flatMap((request) => Array.isArray(request.input) ? request.input : [request.input]);
}

test("nomic-embed-text chunks long input before applying the provider request cap", async () => {
  await withEmbeddingServer(async (baseURL, requests) => {
    const embedder = new Embedder({
      provider: "openai-compatible",
      apiKey: "test-key",
      model: "nomic-embed-text",
      baseURL,
    });

    const longInput = `${"x".repeat(1500)}TAIL_FACT:${"y".repeat(500)}`;
    await embedder.embedPassage(longInput);

    const inputs = flattenRequestInputs(requests);
    assert.ok(inputs.length > 1, "long input should be split into multiple provider requests");
    assert.equal(inputs.every((input) => input.length <= 1400), true);
    assert.match(inputs.join(""), /TAIL_FACT/);
  });
});

test("embedding.maxInputChars truncates and drives the cache key when chunking is disabled", async () => {
  await withEmbeddingServer(async (baseURL, requests) => {
    const embedder = new Embedder({
      provider: "openai-compatible",
      apiKey: "test-key",
      model: "nomic-embed-text",
      baseURL,
      maxInputChars: 120,
      chunking: false,
    });

    const longInput = " ".repeat(4) + "y".repeat(300);
    await embedder.embedPassage(longInput);
    await embedder.embedPassage(longInput);

    assert.equal(requests.length, 1, "second equivalent input should hit cache");
    assert.equal(requests[0].input.length, 120);
    assert.equal(requests[0].input.endsWith("..."), true);
  });
});

test("batch embedding applies maxInputChars to each valid input when chunking is disabled", async () => {
  await withEmbeddingServer(async (baseURL, requests) => {
    const embedder = new Embedder({
      provider: "openai-compatible",
      apiKey: "test-key",
      model: "text-embedding-004",
      baseURL,
      maxInputChars: 64,
      chunking: false,
    });

    await embedder.embedBatchPassage(["a".repeat(120), "", "b".repeat(80)]);

    assert.equal(requests.length, 1);
    assert.deepEqual(
      requests[0].input.map((item) => item.length),
      [64, 64],
    );
    assert.equal(requests[0].input.every((item) => item.endsWith("...")), true);
  });
});

test("batch embedding chunks over maxInputChars before provider requests", async () => {
  await withEmbeddingServer(async (baseURL, requests) => {
    const embedder = new Embedder({
      provider: "openai-compatible",
      apiKey: "test-key",
      model: "text-embedding-004",
      baseURL,
      maxInputChars: 64,
    });

    const first = `${"a".repeat(80)}TAIL_ONE`;
    const second = `${"b".repeat(70)}TAIL_TWO`;
    const result = await embedder.embedBatchPassage([first, "", second]);

    assert.equal(result.length, 3);
    assert.deepEqual(result[1], []);

    const inputs = flattenRequestInputs(requests);
    assert.ok(inputs.length > 2, "long batch inputs should be split before provider requests");
    assert.equal(inputs.every((input) => input.length <= 64), true);
    assert.match(inputs.join(""), /TAIL_ONE/);
    assert.match(inputs.join(""), /TAIL_TWO/);
  });
});

test("batch context fallback retries individual items before chunking", async () => {
  await withAggregateLimitEmbeddingServer(async (baseURL, requests) => {
    const embedder = new Embedder({
      provider: "openai-compatible",
      apiKey: "test-key",
      model: "text-embedding-004",
      baseURL,
      maxInputChars: 128,
    });

    const first = "first memory with trailing fact";
    const second = "second memory with trailing fact";
    const result = await embedder.embedBatchPassage([first, "", second]);

    assert.equal(result.length, 3);
    assert.deepEqual(result[1], []);
    assert.equal(requests.length, 3);
    assert.deepEqual(requests.map((request) => request.input), [
      [first, second],
      first,
      second,
    ]);
  });
});

test("parsePluginConfig accepts embedding.maxInputChars and legacy top-level alias", () => {
  const nested = parsePluginConfig({
    embedding: {
      apiKey: "test-key",
      model: "nomic-embed-text",
      maxInputChars: "512",
    },
  });
  assert.equal(nested.embedding.maxInputChars, 512);

  const legacy = parsePluginConfig({
    maxInputChars: 384,
    embedding: {
      apiKey: "test-key",
      model: "nomic-embed-text",
    },
  });
  assert.equal(legacy.embedding.maxInputChars, 384);
});
