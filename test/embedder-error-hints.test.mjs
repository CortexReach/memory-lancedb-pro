import assert from "node:assert/strict";
import http from "node:http";

import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { Embedder, formatEmbeddingProviderError, getVectorDimensions } = jiti("../src/embedder.ts");

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

/** Capture console.debug calls emitted synchronously during fn(). */
function captureDebug(fn) {
  const messages = [];
  const orig = console.debug;
  console.debug = (...args) => messages.push(args.join(" "));
  try { fn(); } finally { console.debug = orig; }
  return messages;
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

async function expectVoyagePayload(config, callEmbedder, assertPayload, dimensions = 1024) {
  await withEmbeddingCaptureServer(
    (payload) => {
      assertPayload(payload);
      const inputs = Array.isArray(payload.input) ? payload.input : [payload.input];
      return {
        body: {
          data: inputs.map((_, index) => ({
            object: "embedding",
            index,
            embedding: new Array(dimensions).fill(0.2),
          })),
        },
      };
    },
    async ({ baseURL }) => {
      const embedder = new Embedder({
        provider: "openai-compatible",
        apiKey: "test-key",
        ...config,
        baseURL,
      });
      await callEmbedder(embedder);
    },
  );
}

async function run() {
  assert.equal(getVectorDimensions("voyage-4-lite"), 1024);
  assert.equal(getVectorDimensions("voyage-3-large"), 1024);
  assert.equal(getVectorDimensions("bge-m3"), 1024);
  assert.equal(getVectorDimensions("BAAI/bge-m3"), 1024);

  await expectVoyagePayload(
    { model: "voyage-3-lite", dimensions: 1024 },
    (embedder) => embedder.embedPassage("hello"),
    (payload) => {
      assert.equal(payload.encoding_format, undefined, "voyage should not send encoding_format");
      assert.equal(payload.dimensions, undefined, "voyage should not send dimensions");
    },
  );

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
    assert.equal(payload.dimensions, undefined, "jina should not send dimensions unless requestDimensions is set");
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
    assert.equal(payload.dimensions, undefined, "generic profile should not send dimensions unless requestDimensions is set");
    return createEmbeddingResponse(384);
  });
  await genericEmbedder.embedPassage("hello");

  // voyage-4 should be detected as voyage-compatible via model name prefix,
  // even when baseURL is NOT api.voyageai.com (e.g. behind a proxy).
  await expectVoyagePayload(
    { model: "voyage-4", dimensions: 1024 },
    (embedder) => embedder.embedPassage("hello"),
    (payload) => {
      assert.equal(payload.encoding_format, undefined, "voyage-4 should not send encoding_format");
      assert.equal(payload.dimensions, undefined, "voyage-4 should not send dimensions");
    },
  );

  // Voyage: taskPassage "retrieval.passage" → input_type "document"
  //         taskQuery  "retrieval.query"   → input_type "query"
  await expectVoyagePayload(
    {
      model: "voyage-3-lite",
      dimensions: 1024,
      taskPassage: "retrieval.passage",
      taskQuery: "retrieval.query",
    },
    (embedder) => embedder.embedPassage("hello"),
    (payload) => {
      assert.equal(payload.input_type, "document", "voyage taskPassage should map to input_type=document");
      assert.equal(payload.task, undefined, "voyage should not send task field");
    },
  );

  await expectVoyagePayload(
    {
      model: "voyage-3-lite",
      dimensions: 1024,
      taskPassage: "retrieval.passage",
      taskQuery: "retrieval.query",
    },
    (embedder) => embedder.embedQuery("hello"),
    (payload) => {
      assert.equal(payload.input_type, "query", "voyage taskQuery should map to input_type=query");
    },
  );

  await expectVoyagePayload(
    { model: "voyage-4", dimensions: 1024, taskPassage: "passage" },
    (embedder) => embedder.embedPassage("hello"),
    (payload) => {
      assert.equal(payload.input_type, "document", "voyage taskPassage=passage should map to input_type=document");
    },
  );

  // Voyage: configured dimensions should be sent as output_dimension, not dimensions.
  // voyage-4-lite is a recommended Voyage model that supports output_dimension.
  await expectVoyagePayload(
    { model: "voyage-4-lite", requestDimensions: 512 },
    (embedder) => embedder.embedPassage("hello"),
    (payload) => {
      assert.equal(payload.output_dimension, 512, "voyage should send output_dimension");
      assert.equal(payload.dimensions, undefined, "voyage should not send dimensions");
    },
    512,
  );

  // End-to-end HTTP payload verification for Voyage-compatible models through
  // the native Voyage path. The local server uses a proxy-like baseURL, so this
  // exercises model-prefix detection while capturing the serialized body.
  await withEmbeddingCaptureServer(
    (payload) => {
      assert.equal(payload.model, "voyage-4-large");
      assert.deepEqual(payload.input, ["hello voyage"]);
      assert.equal(payload.input_type, "document", "voyage passage task should be sent as document");
      assert.equal(payload.output_dimension, 512, "voyage should send output_dimension");
      assert.equal(payload.encoding_format, undefined, "voyage should not send OpenAI encoding_format");
      assert.equal(payload.dimensions, undefined, "voyage should not send OpenAI dimensions");
      assert.equal(payload.task, undefined, "voyage should not send Jina task field");
      assert.equal(payload.normalized, undefined, "voyage should not send Jina normalized field");
      return {
        body: {
          data: payload.input.map((_, index) => ({
            object: "embedding",
            index,
            embedding: new Array(512).fill(0.2),
          })),
        },
      };
    },
    async ({ baseURL }) => {
      const embedder = new Embedder({
        provider: "openai-compatible",
        apiKey: "test-key",
        model: "voyage-4-large",
        baseURL,
        requestDimensions: 512,
        taskPassage: "retrieval.passage",
      });
      const embeddings = await embedder.embedBatchPassage(["hello voyage"]);
      assert.equal(embeddings.length, 1);
      assert.equal(embeddings[0].length, 512);
    },
  );

  // Voyage native fetch must preserve the configured client timeout for batch
  // calls, since batch embeddings are intentionally not wrapped by the global
  // per-text timeout.
  await withEmbeddingCaptureServer(
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return { body: createEmbeddingResponse(1024) };
    },
    async ({ baseURL }) => {
      const embedder = new Embedder({
        provider: "openai-compatible",
        apiKey: "test-key",
        model: "voyage-4",
        baseURL,
        clientTimeoutMs: 25,
      });

      await expectReject(
        () => embedder.embedBatchPassage(["timeout voyage"]),
        /aborted|abort/i,
      );
    },
  );

  // Voyage native fetch should use the same retry/key-rotation behavior as the
  // SDK path when providers respond with overload/rate-limit statuses.
  {
    const authorizations = [];
    await withEmbeddingCaptureServer(
      (payload, req) => {
        authorizations.push(req.headers.authorization);
        if (authorizations.length === 1) {
          return {
            status: 503,
            body: { error: { message: "provider overloaded" } },
          };
        }

        assert.deepEqual(payload.input, ["rotate voyage"]);
        return { body: createEmbeddingResponse(1024, 0.3) };
      },
      async ({ baseURL }) => {
        const embedder = new Embedder({
          provider: "openai-compatible",
          apiKey: ["voyage-key-a", "voyage-key-b"],
          model: "voyage-4",
          baseURL,
        });

        const embeddings = await embedder.embedBatchPassage(["rotate voyage"]);
        assert.equal(embeddings.length, 1);
        assert.equal(embeddings[0].length, 1024);
      },
    );

    assert.deepEqual(authorizations, ["Bearer voyage-key-a", "Bearer voyage-key-b"]);
  }

  // End-to-end HTTP payload verification for generic-openai-compatible profile.
  // Unlike the mock tests above, this spins up a real HTTP server and verifies
  // the actual request body sent by the OpenAI SDK.
  await withEmbeddingCaptureServer(
    (payload) => {
      assert.equal(payload.encoding_format, "float", "generic profile should send encoding_format");
      assert.equal(payload.dimensions, undefined, "generic profile should not send dimensions by default");
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

  await withEmbeddingCaptureServer(
    (payload) => {
      assert.equal(payload.encoding_format, "float", "generic profile should send encoding_format");
      assert.equal(payload.dimensions, 384, "generic profile should send dimensions when requestDimensions is set");
      return { body: createEmbeddingResponse(384) };
    },
    async ({ baseURL }) => {
      const embedder = new Embedder({
        provider: "openai-compatible",
        apiKey: "test-key",
        model: "text-embedding-3-small",
        baseURL,
        requestDimensions: 384,
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

  // Constructor warning: normalized set on OpenAI profile → debug warning fires
  {
    const msgs = captureDebug(() => new Embedder({
      provider: "openai-compatible", apiKey: "test-key",
      model: "text-embedding-3-small", dimensions: 1536, normalized: true,
    }));
    assert.ok(msgs.some((m) => /normalized/i.test(m)),
      `Expected warning about normalized, got: ${msgs.join(" | ")}`);
  }

  // Constructor warning: taskQuery set on generic profile → debug warning fires
  {
    const msgs = captureDebug(() => new Embedder({
      provider: "openai-compatible", apiKey: "test-key",
      model: "custom-embed-model", baseURL: "https://embeddings.example.invalid/v1",
      dimensions: 384, taskQuery: "retrieval.query",
    }));
    assert.ok(msgs.some((m) => /taskQuery/i.test(m)),
      `Expected warning about taskQuery, got: ${msgs.join(" | ")}`);
  }

  // Constructor no false positive: normalized on Jina profile is valid → no warning
  {
    const msgs = captureDebug(() => new Embedder({
      provider: "openai-compatible", apiKey: "test-key",
      model: "jina-embeddings-v5-text-small", baseURL: "https://api.jina.ai/v1",
      dimensions: 1024, normalized: true,
    }));
    assert.ok(!msgs.some((m) => /normalized/i.test(m)),
      `Unexpected warning for Jina profile: ${msgs.join(" | ")}`);
  }

  // Jina proxy: jina-* model at a proxy URL still gets the Jina-specific auth hint
  const jinaProxyAuth = formatEmbeddingProviderError(
    Object.assign(new Error("401 Unauthorized"), { status: 401 }),
    {
      baseURL: "https://proxy.example.invalid/v1",
      model: "jina-embeddings-v5-text-small",
    },
  );
  assert.match(jinaProxyAuth, /authentication failed/i, jinaProxyAuth);
  assert.match(jinaProxyAuth, /Jina key expired/i, jinaProxyAuth);
  assert.match(jinaProxyAuth, /Ollama/i, jinaProxyAuth);

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
