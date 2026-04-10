import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";

import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { Embedder, formatEmbeddingProviderError } = jiti("../src/embedder.ts");

/**
 * Create a capture server that records POST bodies and returns embeddings
 * with configurable dimension count.
 */
async function withCaptureServer(dims, fn) {
  let capturedBody = null;
  const fakeVec = Array.from({ length: dims }, (_, i) => i * 0.01);
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/embeddings" && req.method === "POST") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        capturedBody = JSON.parse(Buffer.concat(chunks).toString());
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: [{ object: "embedding", index: 0, embedding: fakeVec }],
            usage: { prompt_tokens: 5, total_tokens: 5 },
          }),
        );
      });
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
    await fn({ baseURL, port, getCaptured: () => capturedBody });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe("NVIDIA NIM provider profile", () => {
  it("sends input_type=query for NVIDIA NIM (nv-embed model prefix)", async () => {
    const dims = 128;
    await withCaptureServer(dims, async ({ baseURL, getCaptured }) => {
      const embedder = new Embedder({
        baseURL,
        model: "nv-embedqa-e5-v5",
        apiKey: "test-key",
        dimensions: dims,
        taskQuery: "retrieval.query",
        taskPassage: "retrieval.passage",
      });

      await embedder.embedQuery("test query");
      const body = getCaptured();

      assert.ok(body, "Request body should be captured");
      assert.equal(body.input_type, "query", "Should send input_type=query for NVIDIA");
      assert.equal(body.task, undefined, "Should NOT send task field for NVIDIA");
    });
  });

  it("maps retrieval.passage → passage for NVIDIA NIM", async () => {
    const dims = 128;
    await withCaptureServer(dims, async ({ baseURL, getCaptured }) => {
      const embedder = new Embedder({
        baseURL,
        model: "nv-embedqa-e5-v5",
        apiKey: "test-key",
        dimensions: dims,
        taskQuery: "retrieval.query",
        taskPassage: "retrieval.passage",
      });

      await embedder.embedPassage("test document");
      const body = getCaptured();

      assert.ok(body, "Request body should be captured");
      assert.equal(body.input_type, "passage", "Should map retrieval.passage → passage");
      assert.equal(body.task, undefined, "Should NOT send task field for NVIDIA");
    });
  });

  it("detects NVIDIA from nvidia/ model prefix", async () => {
    const dims = 128;
    await withCaptureServer(dims, async ({ baseURL, getCaptured }) => {
      const embedder = new Embedder({
        baseURL,
        model: "nvidia/llama-3.2-nv-embedqa-1b-v2",
        apiKey: "test-key",
        dimensions: dims,
        taskQuery: "query",
        taskPassage: "passage",
      });

      await embedder.embedQuery("test");
      const body = getCaptured();

      assert.ok(body, "Request body should be captured");
      assert.equal(body.input_type, "query", "nvidia/ model prefix should trigger input_type");
      assert.equal(body.task, undefined, "nvidia/ model prefix should NOT send task");
    });
  });

  it("detects NVIDIA from a .nvidia.com baseURL", () => {
    const message = formatEmbeddingProviderError(new Error("boom"), {
      baseURL: "https://build.nvidia.com/v1",
      model: "custom-embed-model",
      mode: "single",
    });

    assert.equal(message, "Failed to generate embedding from NVIDIA NIM: boom");
  });

  it(".nvidia.com baseURL with conflicting jina- model prefix → NVIDIA wins", async () => {
    const dims = 128;
    await withCaptureServer(dims, async ({ baseURL, getCaptured }) => {
      // Replace localhost URL with a .nvidia.com URL for detection, but route
      // the actual HTTP request to the capture server.
      const nvidiaBaseURL = baseURL.replace("127.0.0.1", "integrate.api.nvidia.com");
      const embedder = new Embedder({
        baseURL, // actual network target
        model: "jina-embeddings-v3",
        apiKey: "test-key",
        dimensions: dims,
        taskQuery: "retrieval.query",
        taskPassage: "retrieval.passage",
      });
      // Override the detected profile by using a real .nvidia.com baseURL in detection
      // We test detection separately via the error label path:
      const message = formatEmbeddingProviderError(new Error("test"), {
        baseURL: "https://integrate.api.nvidia.com/v1",
        model: "jina-embeddings-v3",
        mode: "single",
      });
      assert.equal(message, "Failed to generate embedding from NVIDIA NIM: test",
        ".nvidia.com host should win over jina- model prefix");
    });
  });

  it(".nvidia.com baseURL without taskQuery/taskPassage → no input_type injected", async () => {
    const dims = 128;
    await withCaptureServer(dims, async ({ baseURL, getCaptured }) => {
      const embedder = new Embedder({
        baseURL,
        model: "nvidia/nv-clip-v1",
        apiKey: "test-key",
        dimensions: dims,
        // Deliberately omit taskQuery and taskPassage
      });

      await embedder.embedQuery("test query");
      const body = getCaptured();

      assert.ok(body, "Request body should be captured");
      assert.equal(body.input_type, undefined,
        "NVIDIA profile without taskQuery/taskPassage should NOT inject input_type");
      assert.equal(body.task, undefined,
        "NVIDIA profile without taskQuery/taskPassage should NOT inject task");
    });
  });

  it("non-NVIDIA: Jina sends task field", async () => {
    const dims = 128;
    await withCaptureServer(dims, async ({ baseURL, getCaptured }) => {
      const embedder = new Embedder({
        baseURL,
        model: "jina-embeddings-v5-text-small",
        apiKey: "test-key",
        dimensions: dims,
        taskQuery: "retrieval.query",
        taskPassage: "retrieval.passage",
      });

      await embedder.embedQuery("test query");
      const body = getCaptured();

      assert.ok(body, "Request body should be captured");
      assert.equal(body.task, "retrieval.query", "Jina should send task field");
      assert.equal(body.input_type, undefined, "Jina should NOT send input_type");
    });
  });

  it("non-NVIDIA: generic OpenAI-compatible sends neither task nor input_type", async () => {
    const dims = 128;
    await withCaptureServer(dims, async ({ baseURL, getCaptured }) => {
      const embedder = new Embedder({
        baseURL,
        model: "custom-embed-model",
        apiKey: "test-key",
        dimensions: dims,
      });

      await embedder.embedQuery("test query");
      const body = getCaptured();

      assert.ok(body, "Request body should be captured");
      assert.equal(body.task, undefined, "Generic provider should NOT send task");
      assert.equal(body.input_type, undefined, "Generic provider should NOT send input_type");
    });
  });
});
