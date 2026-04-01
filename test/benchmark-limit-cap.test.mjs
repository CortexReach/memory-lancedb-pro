import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("search limit cap", () => {
  it("store searches should use maxLimit option with default of 20", async () => {
    const { readFileSync } = await import("node:fs");
    const storeSource = readFileSync("src/store.ts", "utf-8");

    // After the fix: clampInt(limit, 1, options?.maxLimit ?? 20)
    // Default stays at 20 for production safety, but callers can pass maxLimit
    assert.ok(
      storeSource.includes("options?.maxLimit ?? 20"),
      "store should use maxLimit option with default 20",
    );
  });

  it("retriever candidate gathering should pass maxLimit: 50", async () => {
    const { readFileSync } = await import("node:fs");
    const retrieverSource = readFileSync("src/retriever.ts", "utf-8");

    // runVectorSearch and runBM25Search pass maxLimit: 50 for candidate pool
    const maxLimitCount = (retrieverSource.match(/maxLimit:\s*50/g) || []).length;
    assert.ok(
      maxLimitCount >= 2,
      `Expected at least 2 maxLimit: 50 in retriever, found ${maxLimitCount}`,
    );
  });
});
