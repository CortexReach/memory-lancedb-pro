import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("search limit cap", () => {
  it("clampInt should allow values up to 50 for store searches", async () => {
    const { readFileSync } = await import("node:fs");
    const storeSource = readFileSync("src/store.ts", "utf-8");
    const matches = storeSource.match(/clampInt\(limit,\s*1,\s*(\d+)\)/g);
    assert.ok(matches, "should find clampInt calls in store.ts");
    for (const match of matches) {
      const cap = parseInt(match.match(/(\d+)\)$/)?.[1] ?? "0");
      assert.ok(cap >= 50, `Expected clamp cap >= 50, got ${cap} in: ${match}`);
    }
  });
});
