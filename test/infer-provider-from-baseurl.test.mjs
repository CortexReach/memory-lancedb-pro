/**
 * @vitest-environment node
 * Regression test for PR #713 - inferProviderFromBaseURL + model resolution fallback
 * Tests edge cases: subdomain spoofing protection, null, empty, invalid URL
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "path";
import jitiFactory from "jiti";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const jitiInstance = jitiFactory(import.meta.url, { interopDefault: true });

// Load the exported function from production code
const indexModule = jitiInstance(path.join(testDir, "..", "index.ts"));
const { inferProviderFromBaseURL } = indexModule;

describe("inferProviderFromBaseURL - PR #713 regression", () => {

  describe("URL hostname inference", () => {
    it("baseURL with minimax.io returns minimax", () => {
      const result = inferProviderFromBaseURL("https://api.minimax.io/v1");
      assert.strictEqual(result, "minimax");
    });

    it("baseURL with minimax.io anthropic endpoint returns minimax", () => {
      const result = inferProviderFromBaseURL("https://api.minimax.io/anthropic");
      assert.strictEqual(result, "minimax");
    });

    it("baseURL with minimaxi.com (regional endpoint) returns minimax", () => {
      const result = inferProviderFromBaseURL("https://api.minimaxi.com/v1");
      assert.strictEqual(result, "minimax");
    });

    it("baseURL with minimaxi.com anthropic endpoint returns minimax", () => {
      const result = inferProviderFromBaseURL("https://api.minimaxi.com/anthropic");
      assert.strictEqual(result, "minimax");
    });

    it("baseURL with openai.com returns openai", () => {
      const result = inferProviderFromBaseURL("https://api.openai.com/v1");
      assert.strictEqual(result, "openai");
    });

    it("baseURL with anthropic.com returns anthropic", () => {
      const result = inferProviderFromBaseURL("https://api.anthropic.com");
      assert.strictEqual(result, "anthropic");
    });
  });

  describe("edge cases", () => {
    it("fake-minimax.io should NOT match (subdomain spoofing protection)", () => {
      const result = inferProviderFromBaseURL("https://fake-minimax.io");
      assert.strictEqual(result, undefined);
    });

    it("fake-minimaxi.com should NOT match (subdomain spoofing protection)", () => {
      const result = inferProviderFromBaseURL("https://fake-minimaxi.com");
      assert.strictEqual(result, undefined);
    });

    it("null returns undefined", () => {
      assert.strictEqual(inferProviderFromBaseURL(null), undefined);
    });

    it("empty string returns undefined", () => {
      assert.strictEqual(inferProviderFromBaseURL(""), undefined);
    });

    it("invalid URL returns undefined", () => {
      assert.strictEqual(inferProviderFromBaseURL("not-a-url"), undefined);
    });
  });

  describe("URL path variations", () => {
    it("handles baseURL with deep path", () => {
      const result = inferProviderFromBaseURL("https://api.minimax.io/v1/chat/completions");
      assert.strictEqual(result, "minimax");
    });

    it("handles baseURL without path", () => {
      const result = inferProviderFromBaseURL("https://api.openai.com");
      assert.strictEqual(result, "openai");
    });
  });
});
