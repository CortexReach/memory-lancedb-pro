import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { createLlmClient, isHostRuntimeLifecycleError } = jiti("../src/llm-client.ts");
const { isReflectionNonRetryError } = jiti("../src/reflection-retry.ts");

describe("host runtime lifecycle errors on the host transport", () => {
  it("tags a closed async work scope so retry classifiers stop retrying", async () => {
    let calls = 0;
    const llm = createLlmClient({
      transport: "host",
      model: "openrouter/openai/gpt-oss-120b",
      modelExplicit: true,
      runtimeLlmComplete: async () => {
        calls += 1;
        throw new Error("Async work scope is closed");
      },
    });

    const result = await llm.completeJson("extract from this", "extract-candidates");
    const lastError = llm.getLastError();

    assert.equal(result, null);
    assert.equal(calls, 1);
    assert.match(lastError, /request failed for model/);
    assert.match(lastError, /\[host runtime lifecycle\]/);
    assert.ok(isHostRuntimeLifecycleError(lastError));
    assert.ok(isReflectionNonRetryError(lastError), "a closed scope is not a transient upstream failure");
  });

  it("leaves ordinary upstream failures untagged", async () => {
    const llm = createLlmClient({
      transport: "host",
      model: "openrouter/openai/gpt-oss-120b",
      modelExplicit: true,
      runtimeLlmComplete: async () => {
        throw new Error("502 upstream unavailable");
      },
    });

    assert.equal(await llm.completeText("say hi", "generic"), null);
    const lastError = llm.getLastError();
    assert.match(lastError, /request failed for model/);
    assert.doesNotMatch(lastError, /host runtime lifecycle/);
    assert.equal(isHostRuntimeLifecycleError(lastError), false);
  });
});
