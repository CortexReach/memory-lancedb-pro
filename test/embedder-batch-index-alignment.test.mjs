import assert from "node:assert/strict";

import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const { createEmbedder } = jiti("../src/embedder.ts");

const embedder = createEmbedder({
  provider: "openai-compatible",
  apiKey: "test-key",
  model: "text-embedding-3-small",
  baseURL: "http://127.0.0.1:9/v1",
});

embedder.embedWithRetry = async () => ({
  data: [
    { index: 1, embedding: new Array(1536).fill(2) },
    { index: 0, embedding: new Array(1536).fill(1) },
  ],
});

const results = await embedder.embedBatchPassage(["first", "second"]);

assert.equal(results.length, 2, "should preserve result count");
assert.equal(results[0][0], 1, "first input should receive index=0 embedding");
assert.equal(results[1][0], 2, "second input should receive index=1 embedding");

console.log("OK: embedder batch index alignment test passed");
