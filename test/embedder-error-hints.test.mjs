import assert from "node:assert/strict";
import http from "node:http";

import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { Embedder, formatEmbeddingProviderError } = jiti("../src/embedder.ts");

async function withJsonServer(status, body, fn) {
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/embeddings" && req.method === "POST") {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseURL = `http://127.0.0.1:${port}/v1`;

  try {
    await fn({ baseURL, port });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function createEmbeddingResponse(dimensions, value = 0.1) {
  return {
    data: [
      {
        object: "embedding",
        index: 0,
        embedding: new Array(dimensions).fill(value),
      },
    ],
  };
}

async function withEmbeddingCaptureServer(handler, fn) {
  const server = http.createServer(async (req, res) => {
    if (req.url !== "/v1/embeddings" || req.method !== "POST") {
      res.writeHead(404);
      res.end("not found");
      return;
    }

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    const payload = JSON.parse(body);
    const response = await handler(payload, req);
    res.writeHead(response.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(response.body));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseURL = `http://127.0.0.1:${port}/v1`;

  try {
    await fn({ baseURL, port });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function installMockEmbeddingClient(embedder, onCreate) {
  embedder.clients = [
    {
      embeddings: {
        create: async (payload) => onCreate(payload),
      },
    },
  ];
}

async function expectReject(promiseFactory, pattern) {
  try {
    await promiseFactory();
    assert.fail("Expected promise to reject");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    assert.match(msg, pattern, msg);
    return msg;
  }
}

async function run() {
  const voyageEmbedder = new Embedder({
    provider: "openai-compatible",
    apiKey: "test-key",
    model: "voyage-3-lite",
    baseURL: "https://api.voyageai.com/v1",
    dimensions: 1024,
  });
  installMockEmbeddingClient(voyageEmbedder, async (payload) => {
    assert.notEqual(payload.encoding_format, "float");
    assert.equal(payload.dimensions, undefined);
    return createEmbeddingResponse(1024);
  });
  await voyageEmbedder.embedPassage("hello");

  const jinaEmbedder = new Embedder({
    provider: "openai-compatible",
    apiKey: "test-key",
    model: "jina-embeddings-v5-text-small",
    baseURL: "https://api.jina.ai/v1",
    dimensions: 1024,
    taskPassage: "retrieval.passage",
    normalized: true,
  });
  installMockEmbeddingClient(jinaEmbedder, async (payload) => {
    assert.equal(payload.task, "retrieval.passage");
    assert.equal(payload.normalized, true);
    assert.equal(payload.dimensions, 1024);
    return createEmbeddingResponse(1024);
  });
  await jinaEmbedder.embedPassage("hello");

  const genericEmbedder = new Embedder({
    provider: "openai-compatible",
    apiKey: "test-key",
    model: "custom-embed-model",
    baseURL: "https://embeddings.example.invalid/v1",
    dimensions: 384,
  });
  installMockEmbeddingClient(genericEmbedder, async (payload) => {
    assert.equal(payload.encoding_format, "float");
    assert.equal(payload.dimensions, 384);
    return createEmbeddingResponse(384);
  });
  await genericEmbedder.embedPassage("hello");

  // voyage-code-3 should be detected as voyage-compatible via model name prefix,
  // even when baseURL is NOT api.voyageai.com (e.g. behind a proxy).
  const voyageCodeEmbedder = new Embedder({
    provider: "openai-compatible",
    apiKey: "test-key",
    model: "voyage-code-3",
    baseURL: "https://proxy.example.invalid/v1",
    dimensions: 1024,
  });
  installMockEmbeddingClient(voyageCodeEmbedder, async (payload) => {
    assert.notEqual(payload.encoding_format, "float", "voyage-code-3 should not send encoding_format");
    assert.equal(payload.dimensions, undefined, "voyage-code-3 should not send dimensions");
    return createEmbeddingResponse(1024);
  });
  await voyageCodeEmbedder.embedPassage("hello");

  // End-to-end HTTP payload verification for generic-openai-compatible profile.
  // Unlike the mock tests above, this spins up a real HTTP server and verifies
  // the actual request body sent by the OpenAI SDK.
  await withEmbeddingCaptureServer(
    (payload) => {
      assert.equal(payload.encoding_format, "float", "generic profile should send encoding_format");
      assert.equal(payload.dimensions, 384, "generic profile should send dimensions");
      assert.equal(payload.task, undefined, "generic profile should not send task");
      assert.equal(payload.normalized, undefined, "generic profile should not send normalized");
      return { body: createEmbeddingResponse(384) };
    },
    async ({ baseURL }) => {
      const embedder = new Embedder({
        provider: "openai-compatible",
        apiKey: "test-key",
        model: "custom-embed-model",
        baseURL,
        dimensions: 384,
      });
      await embedder.embedPassage("hello world");
    },
  );

  await withJsonServer(
    403,
    { error: { message: "Invalid API key", code: "invalid_api_key" } },
    async ({ baseURL, port }) => {
      const embedder = new Embedder({
        provider: "openai-compatible",
        apiKey: "bad-key",
        model: "jina-embeddings-v5-text-small",
        baseURL,
        dimensions: 1024,
      });

      const msg = await expectReject(
        () => embedder.embedPassage("hello"),
        /authentication failed/i,
      );
      assert.match(msg, /Invalid API key/i, msg);
      assert.match(msg, new RegExp(`127\\.0\\.0\\.1:${port}`), msg);
      assert.doesNotMatch(msg, /Check .* for Jina\./i, msg);
    },
  );

  const jinaAuth = formatEmbeddingProviderError(
    Object.assign(new Error("403 Invalid API key"), {
      status: 403,
      code: "invalid_api_key",
    }),
    {
      baseURL: "https://api.jina.ai/v1",
      model: "jina-embeddings-v5-text-small",
    },
  );
  assert.match(jinaAuth, /authentication failed/i, jinaAuth);
  assert.match(jinaAuth, /Jina/i, jinaAuth);
  assert.match(jinaAuth, /Ollama/i, jinaAuth);

  const formattedNetwork = formatEmbeddingProviderError(
    Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), {
      code: "ECONNREFUSED",
    }),
    {
      baseURL: "http://127.0.0.1:11434/v1",
      model: "bge-m3",
    },
  );
  assert.match(formattedNetwork, /provider unreachable/i, formattedNetwork);
  assert.match(formattedNetwork, /127\.0\.0\.1:11434\/v1/i, formattedNetwork);
  assert.match(formattedNetwork, /bge-m3/i, formattedNetwork);

  const formattedBatch = formatEmbeddingProviderError(
    new Error("provider returned malformed payload"),
    {
      baseURL: "https://example.invalid/v1",
      model: "custom-model",
      mode: "batch",
    },
  );
  assert.match(formattedBatch, /^Failed to generate batch embeddings from /, formattedBatch);

  const formattedVoyage = formatEmbeddingProviderError(
    new Error("unsupported request field"),
    {
      baseURL: "https://api.voyageai.com/v1",
      model: "voyage-3-lite",
    },
  );
  assert.match(formattedVoyage, /^Failed to generate embedding from Voyage:/, formattedVoyage);

  console.log("OK: embedder auth/network error hints verified");
}

run().catch((err) => {
  console.error("FAIL: embedder error hint test failed");
  console.error(err);
  process.exit(1);
});
