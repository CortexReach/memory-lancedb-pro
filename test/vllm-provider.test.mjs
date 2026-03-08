import assert from "node:assert/strict";

import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { getVectorDimensions } = jiti("../src/embedder.ts");

// Import private functions via re-export trick (they're not exported)
// We'll test them indirectly through the retriever module
const retrieverModule = jiti("../src/retriever.ts");

// Extract buildRerankRequest and parseRerankResponse from module internals
// They're not exported, so we need to access them differently
// Let's create a test helper that exercises the logic

async function run() {
  console.log("Testing vLLM provider support...\n");

  // =========================================================================
  // Test 1: getVectorDimensions() returns 1024 for Qwen3 variants
  // =========================================================================
  console.log("1. Testing getVectorDimensions() for Qwen3 models...");

  const qwen3Models = [
    "ai/qwen3-embedding",
    "ai/qwen3-embedding:0.6B-F16",
    "ai/qwen3-embedding:4B",
    "ai/qwen3-embedding:4B-Q4_K_M",
    "ai/qwen3-embedding:8B-Q4_K_M",
  ];

  for (const model of qwen3Models) {
    const dims = getVectorDimensions(model);
    assert.strictEqual(
      dims,
      1024,
      `Expected 1024 for ${model}, got ${dims}`,
    );
    console.log(`   ✓ ${model} → ${dims}d`);
  }

  // Verify other known models still work (Jina v5 is in the default list)
  assert.strictEqual(getVectorDimensions("jina-embeddings-v5-text-small"), 1024);
  assert.strictEqual(getVectorDimensions("jina-embeddings-v5-text-nano"), 768);
  console.log("   ✓ Other models return correct dimensions\n");

  // =========================================================================
  // Test 2: buildRerankRequest("vllm", ...) produces no auth headers
  // =========================================================================
  console.log("2. Testing buildRerankRequest for vLLM...");

  // Since buildRerankRequest is not exported, we verify the behavior
  // by checking the module source contains the expected logic
  const retrieverSource = await import("fs").then(fs => 
    fs.promises.readFile(new URL("../src/retriever.ts", import.meta.url), "utf-8")
  );

  // Verify vLLM case exists in buildRerankRequest
  assert.match(
    retrieverSource,
    /case\s+["']vllm["']\s*:/,
    "buildRerankRequest should have vllm case",
  );

  // Verify vLLM doesn't include Authorization header
  const vllmSection = retrieverSource.match(
    /case\s+["']vllm["']\s*:[\s\S]*?default\s*:/,
  );
  assert.ok(vllmSection, "Should find vllm case section");
  
  // vllm section should NOT have Authorization header
  assert.doesNotMatch(
    vllmSection[0],
    /Authorization/,
    "vLLM should not have Authorization header",
  );

  // vllm section should have Content-Type
  assert.match(
    vllmSection[0],
    /Content-Type/,
    "vLLM should have Content-Type header",
  );

  // vllm section should use top_n (not top_k)
  assert.match(
    vllmSection[0],
    /top_n/,
    "vLLM should use top_n parameter",
  );
  assert.doesNotMatch(
    vllmSection[0],
    /top_k/,
    "vLLM should NOT use top_k parameter",
  );

  console.log("   ✓ vLLM case exists in buildRerankRequest");
  console.log("   ✓ No Authorization header for vLLM");
  console.log("   ✓ Uses top_n (not top_k)");
  console.log("   ✓ Uses Content-Type header\n");

  // =========================================================================
  // Test 3: parseRerankResponse("vllm", ...) parses results[].relevance_score
  // =========================================================================
  console.log("3. Testing parseRerankResponse for vLLM...");

  // Verify vLLM case exists in parseRerankResponse
  assert.match(
    retrieverSource,
    /case\s+["']vllm["']\s*:[\s\S]*?case\s+["']siliconflow["']/,
    "parseRerankResponse should have vllm case before siliconflow",
  );

  // Verify vLLM falls through to jina/siliconflow handler
  // (same response format: results[].relevance_score)
  const parseVllmSection = retrieverSource.match(
    /case\s+["']vllm["']\s*:[\s\S]*?parseItems\(data\.results/,
  );
  assert.ok(
    parseVllmSection,
    "vLLM should parse results[] with relevance_score",
  );

  console.log("   ✓ vLLM case exists in parseRerankResponse");
  console.log("   ✓ Parses results[].relevance_score (same as Jina)\n");

  // =========================================================================
  // Test 4: Verify vLLM type is in RerankProvider union
  // =========================================================================
  console.log("4. Testing RerankProvider type union...");

  assert.match(
    retrieverSource,
    /type RerankProvider\s*=\s*["']jina["']\s*\|\s*["']siliconflow["']\s*\|\s*["']voyage["']\s*\|\s*["']pinecone["']\s*\|\s*["']vllm["']/,
    "RerankProvider type should include vllm",
  );

  console.log("   ✓ RerankProvider type includes 'vllm'\n");

  // =========================================================================
  // Test 5: Verify vLLM skips API key validation
  // =========================================================================
  console.log("5. Testing vLLM API key validation skip...");

  // The retriever should check if provider is vllm to skip API key requirement
  assert.match(
    retrieverSource,
    /needsApiKey\s*=\s*provider\s*!==\s*["']vllm["']/,
    "Should have needsApiKey check for vllm",
  );

  console.log("   ✓ vLLM skips API key validation\n");

  console.log("=".repeat(50));
  console.log("All vLLM provider tests passed!");
  console.log("=".repeat(50));
}

run().catch((err) => {
  console.error("FAIL: vLLM provider test failed");
  console.error(err);
  process.exit(1);
});