// Regression for #1014: completeJson() failure diagnostics (log callback and
// getLastError()) must not carry response text -- neither as an explicit
// preview nor through raw JSON.parse messages, which quote their input. The
// stage label, failure category and response length must still be reported.
//
// Every case drives the real createLlmClient() through a real transport:
// host (fake runtimeLlmComplete), direct API (loopback HTTP server) and OAuth
// (fake auth file + intercepted fetch returning SSE). No network is used.
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { createLlmClient } = jiti("../src/llm-client.ts");

const MARKER = "SYNTHETIC_PRIVATE_NOTE_6D82";

// Each failing response reaches a different completeJson() error branch.
const CASES = [
  {
    name: "non-JSON prose",
    text: `No JSON here, just a private note: ${MARKER}`,
    category: "non-json",
  },
  {
    // Bare identifier: JSON.parse fails, and the repair heuristic leaves the
    // string unchanged, so this is the plain parse-failure branch. V8 quotes
    // the offending input in the SyntaxError message.
    name: "invalid JSON",
    text: `{"note": ${MARKER}}`,
    category: "parse-failure",
  },
  {
    // The trailing comma makes the repair heuristic rewrite the string, but
    // the bare identifier keeps the repaired text invalid.
    name: "JSON whose repair still fails",
    text: `{"note": ${MARKER},}`,
    category: "repair-failure",
  },
];

const VALID_TEXT = `{"note":"${MARKER}","memories":[]}`;
const VALID_RESULT = { note: MARKER, memories: [] };

function assertRedacted(diagnostic, testCase, label) {
  assert.equal(typeof diagnostic, "string", "a diagnostic must still be recorded");
  assert.ok(!diagnostic.includes(MARKER), `response text leaked into diagnostic: ${diagnostic}`);
  assert.ok(!diagnostic.includes("private note"), `response text leaked into diagnostic: ${diagnostic}`);
  assert.ok(!/preview=/i.test(diagnostic), `diagnostic still carries a preview field: ${diagnostic}`);
  assert.ok(!/is not valid JSON|Unexpected token '/.test(diagnostic), `raw JSON.parse message leaked: ${diagnostic}`);
  assert.ok(diagnostic.includes(`[${label}]`), `stage label missing: ${diagnostic}`);
  assert.ok(diagnostic.includes(`category=${testCase.category}`), `category missing: ${diagnostic}`);
  assert.ok(diagnostic.includes(`chars=${testCase.text.length}`), `response length missing: ${diagnostic}`);
  if (testCase.category !== "non-json") {
    assert.match(diagnostic, /error=SyntaxError/, `parse error class missing: ${diagnostic}`);
  }
  if (testCase.category === "repair-failure") {
    assert.match(diagnostic, /repairError=SyntaxError/, `repair error class missing: ${diagnostic}`);
  }
}

async function assertFailureRedacted(makeClient, testCase) {
  const logs = [];
  const llm = await makeClient(testCase.text, (line) => logs.push(line));
  const label = `redaction-${testCase.category}`;
  const result = await llm.completeJson("synthetic input", label);
  assert.equal(result, null, `${testCase.name} must return null`);
  assert.ok(logs.length > 0, `${testCase.name} must emit a diagnostic`);
  for (const line of logs) assert.ok(!line.includes(MARKER), `response text leaked into log line: ${line}`);
  assertRedacted(logs.at(-1), testCase, label);
  assertRedacted(llm.getLastError(), testCase, label);
}

async function assertValidUnchanged(makeClient) {
  const logs = [];
  const llm = await makeClient(VALID_TEXT, (line) => logs.push(line));
  assert.deepEqual(await llm.completeJson("synthetic input", "redaction-valid"), VALID_RESULT);
  assert.deepEqual(logs, [], "a valid JSON response must not emit a diagnostic");
  assert.equal(llm.getLastError(), null);
}

function defineTransportCases(makeClient) {
  for (const testCase of CASES) {
    it(`${testCase.name}: no response text in log or getLastError(), category and length kept`, () =>
      assertFailureRedacted(makeClient, testCase));
  }
  it("valid JSON control parses as before with no diagnostic", () => assertValidUnchanged(makeClient));
}

describe("completeJson failure diagnostics redact response text (#1014)", () => {
  describe("host transport", () => {
    defineTransportCases((text, log) =>
      createLlmClient({
        transport: "host",
        model: "synthetic",
        runtimeLlmComplete: async () => ({ text }),
        log,
      }),
    );
  });

  describe("direct API transport", () => {
    let server;
    let responseText = "";
    let baseURL = "";

    before(async () => {
      server = http.createServer(async (req, res) => {
        for await (const _chunk of req) { /* drain */ }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: responseText } }] }));
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      baseURL = `http://127.0.0.1:${server.address().port}/v1`;
    });

    after(async () => {
      await new Promise((resolve) => server.close(resolve));
    });

    defineTransportCases((text, log) => {
      responseText = text;
      return createLlmClient({
        auth: "api-key",
        apiKey: "test-api-key",
        model: "gpt-4o-mini",
        baseURL,
        timeoutMs: 5000,
        log,
      });
    });
  });

  describe("OAuth transport", () => {
    const originalFetch = globalThis.fetch;
    let tempDir;
    let authPath;

    before(() => {
      tempDir = mkdtempSync(path.join(tmpdir(), "memory-llm-redaction-"));
      authPath = path.join(tempDir, "auth.json");
      const segment = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const accessToken = [
        segment({ alg: "none", typ: "JWT" }),
        segment({
          exp: Math.floor((Date.now() + 3_600_000) / 1000),
          "https://api.openai.com/auth": { chatgpt_account_id: "acct_test_redaction" },
        }),
        "signature",
      ].join(".");
      writeFileSync(
        authPath,
        JSON.stringify({ tokens: { access_token: accessToken, refresh_token: "refresh-token" } }),
        "utf8",
      );
    });

    after(() => {
      globalThis.fetch = originalFetch;
      rmSync(tempDir, { recursive: true, force: true });
    });

    defineTransportCases((text, log) => {
      globalThis.fetch = async () => {
        const eventPayload = JSON.stringify({ type: "response.output_text.done", text });
        return new Response(
          ["event: response.output_text.done", `data: ${eventPayload}`, ""].join("\n"),
          { status: 200 },
        );
      };
      return createLlmClient({
        auth: "oauth",
        oauthPath: authPath,
        model: "openai/gpt-5.4",
        timeoutMs: 5000,
        log,
      });
    });
  });
});
