/**
 * Regression tests for the llm.thinkLevel rename (D1): llm.thinkLevel is the
 * canonical config key (consistency with memoryReflection.thinkLevel), and
 * the old llm.reasoningEffort key keeps working as a deprecated alias so the
 * operator's live config (which still sets reasoningEffort) does not break.
 *
 * Fixtures are entirely synthetic -- no real fleet data.
 */

import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, beforeEach, describe, it } from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { createLlmClient, resolveThinkLevel, resetThinkLevelDeprecationWarnForTests } =
  jiti("../src/llm-client.ts");

describe("llm.thinkLevel canonical key with deprecated llm.reasoningEffort alias", () => {
  beforeEach(() => {
    resetThinkLevelDeprecationWarnForTests();
  });

  describe("resolveThinkLevel precedence", () => {
    it("returns thinkLevel when only thinkLevel is configured", () => {
      const warns = [];
      const result = resolveThinkLevel({ thinkLevel: "high" }, (msg) => warns.push(msg));
      assert.equal(result, "high");
      assert.deepEqual(warns, []);
    });

    it("returns the deprecated reasoningEffort value when only reasoningEffort is configured", () => {
      const warns = [];
      const result = resolveThinkLevel({ reasoningEffort: "low" }, (msg) => warns.push(msg));
      assert.equal(result, "low");
      assert.equal(warns.length, 1);
      assert.match(warns[0], /llm\.reasoningEffort/);
      assert.match(warns[0], /llm\.thinkLevel/);
      assert.match(warns[0], /deprecat/i);
    });

    it("prefers thinkLevel when both are configured", () => {
      const warns = [];
      const result = resolveThinkLevel(
        { thinkLevel: "high", reasoningEffort: "low" },
        (msg) => warns.push(msg),
      );
      assert.equal(result, "high");
    });

    it("returns undefined when neither key is configured", () => {
      const warns = [];
      const result = resolveThinkLevel({}, (msg) => warns.push(msg));
      assert.equal(result, undefined);
      assert.deepEqual(warns, []);
    });

    it("treats a blank/whitespace-only thinkLevel as unset, falling back to the deprecated reasoningEffort", () => {
      const warns = [];
      const result = resolveThinkLevel(
        { thinkLevel: "   ", reasoningEffort: "low" },
        (msg) => warns.push(msg),
      );
      assert.equal(result, "low");
    });

    it("does not warn when reasoningEffort is blank/whitespace-only, even though thinkLevel is set", () => {
      const warns = [];
      const result = resolveThinkLevel(
        { thinkLevel: "high", reasoningEffort: "   " },
        (msg) => warns.push(msg),
      );
      assert.equal(result, "high");
      assert.deepEqual(warns, []);
    });
  });

  describe("both-keys-configured warning", () => {
    it("logs exactly one warning naming both keys when both are configured", () => {
      const warns = [];
      resolveThinkLevel({ thinkLevel: "high", reasoningEffort: "low" }, (msg) => warns.push(msg));
      assert.equal(warns.length, 1);
      assert.match(warns[0], /llm\.thinkLevel/);
      assert.match(warns[0], /llm\.reasoningEffort/);
      assert.match(warns[0], /wins/i);
    });

    it("dedupes the both-keys warning to once per process across multiple resolutions", () => {
      const warns = [];
      resolveThinkLevel({ thinkLevel: "high", reasoningEffort: "low" }, (msg) => warns.push(msg));
      resolveThinkLevel({ thinkLevel: "high", reasoningEffort: "low" }, (msg) => warns.push(msg));
      resolveThinkLevel({ thinkLevel: "medium", reasoningEffort: "minimal" }, (msg) => warns.push(msg));
      assert.equal(warns.length, 1);
    });
  });

  describe("deprecated-alias-only warning", () => {
    it("dedupes the deprecation warning to once per process across multiple resolutions", () => {
      const warns = [];
      resolveThinkLevel({ reasoningEffort: "low" }, (msg) => warns.push(msg));
      resolveThinkLevel({ reasoningEffort: "low" }, (msg) => warns.push(msg));
      resolveThinkLevel({ reasoningEffort: "high" }, (msg) => warns.push(msg));
      assert.equal(warns.length, 1);
    });

    it("the deprecated-alias-only warning and the both-keys warning are deduped independently of each other", () => {
      const warns = [];
      resolveThinkLevel({ reasoningEffort: "low" }, (msg) => warns.push(msg));
      resolveThinkLevel({ thinkLevel: "high", reasoningEffort: "low" }, (msg) => warns.push(msg));
      assert.equal(warns.length, 2);
    });
  });

  describe("createLlmClient wiring (direct transport, wire-level)", () => {
    let server;

    afterEach(async () => {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
        server = null;
      }
    });

    it("sends the canonical llm.thinkLevel value as the reasoning effort on a direct-transport request", async () => {
      let requestBody;
      server = http.createServer(async (req, res) => {
        let body = "";
        for await (const chunk of req) body += chunk;
        requestBody = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "{\"memories\":[]}" } }] }));
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = server.address().port;

      const llm = createLlmClient({
        auth: "api-key",
        apiKey: "test-api-key",
        model: "anthropic/claude-opus-4-8",
        baseURL: `http://127.0.0.1:${port}/v1`,
        thinkLevel: "high",
      });

      await llm.completeJson("hello", "thinklevel-probe");

      assert.deepEqual(requestBody.reasoning, { effort: "high" });
    });

    it("still sends the deprecated llm.reasoningEffort value as the reasoning effort (backward compat)", async () => {
      let requestBody;
      server = http.createServer(async (req, res) => {
        let body = "";
        for await (const chunk of req) body += chunk;
        requestBody = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "{\"memories\":[]}" } }] }));
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = server.address().port;

      const llm = createLlmClient({
        auth: "api-key",
        apiKey: "test-api-key",
        model: "anthropic/claude-opus-4-8",
        baseURL: `http://127.0.0.1:${port}/v1`,
        reasoningEffort: "low",
        warnLog: () => {},
      });

      await llm.completeJson("hello", "reasoningeffort-alias-probe");

      assert.deepEqual(requestBody.reasoning, { effort: "low" });
    });

    it("prefers llm.thinkLevel over llm.reasoningEffort end-to-end when both are configured", async () => {
      let requestBody;
      server = http.createServer(async (req, res) => {
        let body = "";
        for await (const chunk of req) body += chunk;
        requestBody = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "{\"memories\":[]}" } }] }));
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = server.address().port;

      const warns = [];
      const llm = createLlmClient({
        auth: "api-key",
        apiKey: "test-api-key",
        model: "anthropic/claude-opus-4-8",
        baseURL: `http://127.0.0.1:${port}/v1`,
        thinkLevel: "high",
        reasoningEffort: "low",
        warnLog: (msg) => warns.push(msg),
      });

      await llm.completeJson("hello", "both-keys-probe");

      assert.deepEqual(requestBody.reasoning, { effort: "high" });
      assert.equal(
        warns.filter((m) => m.includes("llm.thinkLevel") && m.includes("llm.reasoningEffort")).length,
        1,
      );
    });
  });
});
