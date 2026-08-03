/**
 * Regression tests for llm.thinkLevel, the sole reasoning-effort config key.
 * The formerly-deprecated llm.reasoningEffort alias has been removed
 * entirely (it never shipped upstream, so there is no deprecation
 * constituency to preserve) -- resolveThinkLevel is now a plain presence
 * check on llm.thinkLevel with no alias resolution or warn path.
 *
 * Fixtures are entirely synthetic -- no real fleet data.
 */

import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, describe, it } from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { createLlmClient, resolveThinkLevel } = jiti("../src/llm-client.ts");

describe("llm.thinkLevel", () => {
  describe("resolveThinkLevel", () => {
    it("returns thinkLevel when configured", () => {
      const result = resolveThinkLevel({ thinkLevel: "high" });
      assert.equal(result, "high");
    });

    it("returns undefined when unconfigured", () => {
      const result = resolveThinkLevel({});
      assert.equal(result, undefined);
    });

    it("treats a blank/whitespace-only thinkLevel as unset", () => {
      const result = resolveThinkLevel({ thinkLevel: "   " });
      assert.equal(result, undefined);
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

    it("sends the configured llm.thinkLevel value as the reasoning effort on a direct-transport request", async () => {
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

    it("omits the reasoning field on a direct-transport request when llm.thinkLevel is not configured", async () => {
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
      });

      await llm.completeJson("hello", "thinklevel-unconfigured-probe");

      assert.equal(requestBody.reasoning, undefined);
    });
  });
});
