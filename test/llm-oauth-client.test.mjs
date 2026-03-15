import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { createLlmClient } = jiti("../src/llm-client.ts");

const ACCOUNT_ID_CLAIM = "https://api.openai.com/auth";
const originalFetch = globalThis.fetch;

function encodeSegment(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function makeJwt(payload) {
  return [
    encodeSegment({ alg: "none", typ: "JWT" }),
    encodeSegment(payload),
    "signature",
  ].join(".");
}

describe("LLM OAuth client", () => {
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "memory-llm-oauth-"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("uses the project OAuth file and sends a streaming Responses payload to the Codex backend", async () => {
    const accessToken = makeJwt({
      exp: Math.floor((Date.now() + 3_600_000) / 1000),
      [ACCOUNT_ID_CLAIM]: {
        chatgpt_account_id: "acct_test_123",
      },
    });

    const authPath = path.join(tempDir, "auth.json");
    writeFileSync(
      authPath,
      JSON.stringify({
        tokens: {
          access_token: accessToken,
          refresh_token: "refresh-token",
        },
      }),
      "utf8",
    );

    let requestUrl = "";
    let requestHeaders;
    let requestBody;

    globalThis.fetch = async (url, init) => {
      requestUrl = String(url);
      requestHeaders = new Headers(init?.headers);
      requestBody = JSON.parse(init?.body);
      const eventPayload = JSON.stringify({
        type: "response.output_text.done",
        text: "{\"memories\":[]}",
      });
      return new Response(
        [
          "event: response.output_text.done",
          `data: ${eventPayload}`,
          "",
        ].join("\n"),
        {
          status: 200,
        },
      );
    };

    const llm = createLlmClient({
      auth: "oauth",
      model: "openai/gpt-5.4",
      oauthPath: authPath,
      timeoutMs: 5_000,
    });

    const result = await llm.completeJson("hello");
    assert.deepEqual(result, { memories: [] });
    assert.equal(requestUrl, "https://chatgpt.com/backend-api/codex/responses");
    assert.equal(requestHeaders.get("authorization"), `Bearer ${accessToken}`);
    assert.equal(requestHeaders.get("chatgpt-account-id"), "acct_test_123");
    assert.equal(requestHeaders.get("openai-beta"), "responses=experimental");
    assert.equal(requestBody.model, "gpt-5.4");
    assert.equal(requestBody.stream, true);
    assert.deepEqual(requestBody.input, [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "hello",
          },
        ],
      },
    ]);
    assert.equal(requestBody.store, false);
  });
});
