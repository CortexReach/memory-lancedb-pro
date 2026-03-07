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

  const geminiAuth = formatEmbeddingProviderError(
    Object.assign(new Error("403 API key invalid"), {
      status: 403,
      code: "invalid_api_key",
    }),
    {
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
      model: "gemini-embedding-001",
    },
  );
  assert.match(geminiAuth, /Gemini/i, geminiAuth);
  assert.match(geminiAuth, /gemini-embedding-001/i, geminiAuth);
  assert.match(geminiAuth, /3072/i, geminiAuth);

  const geminiNotFound = formatEmbeddingProviderError(
    Object.assign(new Error("404 model not found"), { status: 404 }),
    {
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
      model: "bad-model",
    },
  );
  assert.match(geminiNotFound, /v1beta\/openai\//i, geminiNotFound);
  assert.match(geminiNotFound, /gemini-embedding-001/i, geminiNotFound);

  console.log("OK: embedder auth/network error hints verified");
}

run().catch((err) => {
  console.error("FAIL: embedder error hint test failed");
  console.error(err);
  process.exit(1);
});
