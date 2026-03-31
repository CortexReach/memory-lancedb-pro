import assert from "node:assert/strict";
import http from "node:http";

import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { Embedder } = jiti("../src/embedder.ts");
const { smartChunk } = jiti("../src/chunker.ts");

function generateCJKText(charCount) {
  const chars = "中文字符测试数据内容关键词信息处理系统计算机软件硬件网络数据库服务器客户端浏览器应用程序编程语言算法数据结构人工智能机器学习深度学习神经网络。".split("");
  let text = "";
  for (let i = 0; i < charCount; i++) text += chars[i % chars.length];
  return text;
}

function createJsonServer(handler) {
  const server = http.createServer(async (req, res) => {
    if (req.url !== "/v1/embeddings" || req.method !== "POST") {
      res.writeHead(404);
      res.end("not found");
      return;
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", async () => {
      try {
        await handler(JSON.parse(body || "{}"), req, res);
      } catch (error) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: String(error?.message || error), code: "test_handler_error" } }));
      }
    });
  });
  return server;
}

async function withServer(handler, fn) {
  const server = createJsonServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseURL = `http://127.0.0.1:${port}/v1`;
  try {
    await fn({ baseURL });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function testSingleChunkFallbackTerminates() {
  console.log("Test 1: single-chunk fallback terminates instead of looping");

  let callCount = 0;
  await withServer((payload, _req, res) => {
    callCount++;
    const input = Array.isArray(payload.input) ? payload.input[0] : payload.input;
    if (typeof input === "string" && input.length > 100) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Input length exceeds maximum tokens (max 8192)", code: "context_length_exceeded" } }));
      return;
    }

    const dims = 1024;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ embedding: Array.from({ length: dims }, () => 1), index: 0 }] }));
  }, async ({ baseURL }) => {
    const embedder = new Embedder({
      provider: "openai-compatible",
      apiKey: "test-key",
      model: "mxbai-embed-large",
      baseURL,
      dimensions: 1024,
    });

    await assert.rejects(
      () => embedder.embedPassage(generateCJKText(3000)),
      (error) => {
        assert.match(error.message, /Failed to embed: input too large for model context after 3 retries/i);
        assert(callCount < 20, `Expected bounded retries, got ${callCount}`);
        return true;
      }
    );
  });

  console.log(`  API calls before termination: ${callCount}`);
  console.log("  PASSED\n");
}

async function testDepthLimitTermination() {
  console.log("Test 2: depth limit terminates repeated forced reductions");

  await withServer((_payload, _req, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Input length exceeds maximum tokens (max 8192)", code: "context_length_exceeded" } }));
  }, async ({ baseURL }) => {
    const embedder = new Embedder({
      provider: "openai-compatible",
      apiKey: "test-key",
      model: "mxbai-embed-large",
      baseURL,
      dimensions: 1024,
    });

    await assert.rejects(
      () => embedder.embedPassage(generateCJKText(220)),
      (error) => {
        assert.match(error.message, /Failed to embed: input too large for model context after 3 retries|chunking couldn't reduce input size enough/i);
        return true;
      }
    );
  });

  console.log("  PASSED\n");
}

async function testCjkAwareChunkSizing() {
  console.log("Test 3: CJK-aware chunk sizing produces more chunks than Latin text for same model budget");
  const cjkText = generateCJKText(5000);
  const latinText = "english text sentence. ".repeat(220);
  const cjkResult = smartChunk(cjkText, "mxbai-embed-large");
  const latinResult = smartChunk(latinText, "mxbai-embed-large");

  assert(cjkResult.chunkCount > 1, "Expected multiple chunks for long CJK text");
  assert(cjkResult.chunks[0].length < latinResult.chunks[0].length, "Expected smaller CJK chunks than Latin chunks");
  console.log(`  CJK first chunk: ${cjkResult.chunks[0].length} chars`);
  console.log(`  Latin first chunk: ${latinResult.chunks[0].length} chars`);
  console.log("  PASSED\n");
}

async function testChunkErrorSurfaced() {
  console.log("Test 4: chunkError is surfaced instead of generic context_length_exceeded wrapper");

  await withServer((payload, _req, res) => {
    const input = Array.isArray(payload.input) ? payload.input[0] : payload.input;
    if (typeof input === "string" && input.length > 1500) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Input length exceeds maximum tokens (max 8192)", code: "context_length_exceeded" } }));
      return;
    }

    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "chunk child failed with synthetic downstream error", code: "synthetic_chunk_failure" } }));
  }, async ({ baseURL }) => {
    const embedder = new Embedder({
      provider: "openai-compatible",
      apiKey: "test-key",
      model: "mxbai-embed-large",
      baseURL,
      dimensions: 1024,
    });

    await assert.rejects(
      () => embedder.embedPassage(generateCJKText(5000)),
      (error) => {
        assert.match(error.message, /synthetic_chunk_failure|synthetic downstream error|chunk child failed/i);
        assert.doesNotMatch(error.message, /context_length_exceeded/i);
        return true;
      }
    );
  });

  console.log("  PASSED\n");
}

async function testSmallContextChunking() {
  console.log("Test 5: small-context model no longer keeps a 1000-char hard floor");
  const text = generateCJKText(2000);
  const result = smartChunk(text, "all-MiniLM-L6-v2");
  assert(result.chunkCount > 1, "Expected multiple chunks for small-context CJK text");
  const maxChunkLen = Math.max(...result.chunks.map((c) => c.length));
  assert(maxChunkLen <= 200, `Expected chunk size <= 200 chars after clamp, got ${maxChunkLen}`);
  console.log(`  Largest chunk: ${maxChunkLen} chars`);
  console.log("  PASSED\n");
}

async function testTimeoutAbortPropagation() {
  console.log("Test 6: timeout abort propagates to underlying request path");

  await withServer(async (_payload, req, res) => {
    await new Promise((resolve) => setTimeout(resolve, 11_000));
    if (req.aborted || req.destroyed) {
      return;
    }
    const dims = 1024;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ embedding: Array.from({ length: dims }, () => 0), index: 0 }] }));
  }, async ({ baseURL }) => {
    const embedder = new Embedder({
      provider: "openai-compatible",
      apiKey: "test-key",
      model: "mxbai-embed-large",
      baseURL,
      dimensions: 1024,
    });

    await assert.rejects(
      () => embedder.embedPassage("short timeout probe"),
      (error) => {
        assert.match(error.message, /aborted|abort|timed out|fetch failed/i);
        return true;
      }
    );
  });

  console.log("  PASSED\n");
}

async function testBatchEmbeddingStillWorks() {
  console.log("Test 7: batch embedding still works without withTimeout wrapper");

  await withServer((_payload, _req, res) => {
    const dims = 1024;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      data: [0, 1, 2].map((index) => ({ embedding: Array.from({ length: dims }, () => index), index })),
    }));
  }, async ({ baseURL }) => {
    const embedder = new Embedder({
      provider: "openai-compatible",
      apiKey: "test-key",
      model: "mxbai-embed-large",
      baseURL,
      dimensions: 1024,
    });

    const embeddings = await embedder.embedBatchPassage(["a", "b", "c"]);
    assert.equal(embeddings.length, 3);
    assert.equal(embeddings[0].length, 1024);
    assert.equal(embeddings[2][0], 2);
  });

  console.log("  PASSED\n");
}

async function testOllamaAbortWithNativeFetch() {
  console.log("Test 8: Ollama native fetch respects external AbortSignal (PR354 fix regression)");

  // Author's analysis: the previous test used withServer() on a random port but hardcoded
  // http://127.0.0.1:11434/v1 for the Embedder — so the request always hit "connection refused"
  // immediately and never touched the slow handler. This test fixes that by:
  // 1. Binding the mock server directly to 127.0.0.1:11434 (so isOllamaProvider() is true)
  // 2. Delaying the response by 5 seconds
  // 3. Passing an external AbortSignal that fires after 2 seconds
  // 4. Asserting total time ≈ 2s (proving abort interrupted the slow request)

  const SLOW_DELAY_MS = 5_000;
  const ABORT_AFTER_MS = 2_000;
  const DIMS = 1024;

  const server = http.createServer((req, res) => {
    if (req.url === "/v1/embeddings" && req.method === "POST") {
      const timer = setTimeout(() => {
        if (res.writableEnded) return; // already aborted
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          data: [{ embedding: Array.from({ length: DIMS }, () => 0.1), index: 0 }]
        }));
      }, SLOW_DELAY_MS);
      req.on("aborted", () => clearTimeout(timer));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  // Bind directly to 127.0.0.1:11434 so isOllamaProvider() returns true
  await new Promise((resolve) => server.listen(11434, "127.0.0.1", resolve));

  try {
    const embedder = new Embedder({
      provider: "openai-compatible",
      apiKey: "test-key",
      model: "mxbai-embed-large",
      baseURL: "http://127.0.0.1:11434/v1",
      dimensions: DIMS,
    });

    assert.equal(
      embedder.isOllamaProvider ? embedder.isOllamaProvider() : false,
      true,
      "isOllamaProvider should return true for 127.0.0.1:11434"
    );

    const start = Date.now();
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), ABORT_AFTER_MS);

    let errorCaught;
    try {
      // Pass external AbortSignal — should interrupt the 5-second slow response at ~2s
      await embedder.embedPassage("abort test probe", controller.signal);
    } catch (e) {
      errorCaught = e;
    }

    clearTimeout(abortTimer);
    const elapsed = Date.now() - start;

    assert.ok(errorCaught, "embedPassage should throw (abort or timeout)");
    const msg = errorCaught instanceof Error ? errorCaught.message : String(errorCaught);
    assert.ok(
      /timed out|abort|ollama|ECONNREFUSED/i.test(msg),
      `Expected abort/timeout error, got: ${msg}`
    );

    // If abort works: elapsed ≈ 2000ms. If abort fails: elapsed ≈ 5000ms.
    assert.ok(
      elapsed < SLOW_DELAY_MS * 0.75,
      `Expected abort ~${ABORT_AFTER_MS}ms, got ${elapsed}ms — abort did NOT interrupt slow request`
    );

    console.log(`  PASSED (aborted in ${elapsed}ms < ${SLOW_DELAY_MS}ms threshold)\n`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function run() {
  console.log("Running regression tests for PR #238...\n");
  await testSingleChunkFallbackTerminates();
  await testDepthLimitTermination();
  await testCjkAwareChunkSizing();
  await testChunkErrorSurfaced();
  await testSmallContextChunking();
  await testTimeoutAbortPropagation();
  await testBatchEmbeddingStillWorks();
  await testOllamaAbortWithNativeFetch();
  console.log("All regression tests passed!");
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
