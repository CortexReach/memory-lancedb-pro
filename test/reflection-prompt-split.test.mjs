/**
 * Distiller prompt slot-placement tests.
 *
 * The reflection distiller's prompt is built as two parts: system = identity
 * + every static block (task, headings contract, hard rules,
 * section/governance rules, notes, output template); user = ONLY the
 * dynamically generated content (tool error signals + the INPUT transcript
 * fence). Both runners deliver the combined single-slot form today (the
 * embedded raw run does not honor a separate system slot, and the CLI
 * fallback carries a single user message); the parts keep the seam explicit
 * and tested so a host whose runner honors a system slot can deliver them
 * split without changing one byte of prompt text.
 *
 * Fixtures are entirely synthetic; no real fleet data.
 *
 * Run: node --test test/reflection-prompt-split.test.mjs
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginSdkStubPath = path.resolve(testDir, "helpers", "openclaw-plugin-sdk-stub.mjs");
const jiti = jitiFactory(import.meta.url, {
  interopDefault: true,
  alias: {
    "openclaw/plugin-sdk": pluginSdkStubPath,
  },
});

const {
  generateReflectionText,
  buildReflectionPromptParts,
} = jiti("../index.ts");

// Every static block of the distiller prompt, by its opening sentinel. These
// must ALL live in the system part and NONE may leak into the user part.
const STATIC_SENTINELS = [
  "You are generating a durable MEMORY REFLECTION entry for an AI assistant system.",
  "Use these headings exactly once, in this exact order, with exact spelling:",
  "Hard rules:",
  "Section rules:",
  "Governance section rules:",
  "Notes:",
  "OUTPUT TEMPLATE (copy this structure exactly):",
  "- This run showed ...",
];

const CONVERSATION = "user: hello there\nassistant: hi, noted";

// loadEmbeddedPiRunner caches the first Layer-1 runner it resolves
// module-wide, so every test in this file shares ONE fake api and swaps
// behavior via this dispatcher (same pattern as raw-run-distiller-hooks).
let currentRunnerImpl = async () => ({ payloads: [{ text: "noop" }] });
const fakeApi = {
  runtime: {
    agent: {
      runEmbeddedPiAgent: (params) => currentRunnerImpl(params),
    },
  },
};

const baseParams = {
  conversation: CONVERSATION,
  maxInputChars: 1000,
  cfg: {},
  agentId: "agent-one",
  workspaceDir: "/tmp",
  timeoutMs: 2000,
  thinkLevel: "off",
  api: fakeApi,
};

describe("buildReflectionPromptParts slot placement", () => {
  it("puts the identity opener and every static block in system, none of them in user", () => {
    const parts = buildReflectionPromptParts(CONVERSATION, 1000, []);
    assert.ok(
      parts.system.startsWith("You are generating a durable MEMORY REFLECTION entry"),
      "system must open with the distiller identity line",
    );
    for (const sentinel of STATIC_SENTINELS) {
      assert.ok(parts.system.includes(sentinel), `system must contain static block sentinel: ${sentinel}`);
      assert.ok(!parts.user.includes(sentinel), `user must NOT contain static block sentinel: ${sentinel}`);
    }
  });

  it("user carries ONLY the dynamic content: tool error signals then the INPUT fence", () => {
    const parts = buildReflectionPromptParts(CONVERSATION, 1000, []);
    assert.ok(parts.user.startsWith("Recent tool error signals:"), "user must open with the tool-error block");
    assert.ok(parts.user.includes("- (none)"), "empty signals render the placeholder");
    assert.ok(parts.user.includes(`INPUT:\n\`\`\`\n${CONVERSATION}\n\`\`\``), "user must carry the fenced transcript");
    assert.ok(!parts.user.includes("## Context (session background)"), "the headings contract must not leak into user");
    assert.ok(!parts.system.includes(CONVERSATION), "the transcript must not leak into system");
  });

  it("renders tool error signals dynamically in user, leaving system untouched", () => {
    const signals = [{ toolName: "exec", summary: "exit 1 on build", signatureHash: "abcdef1234567890" }];
    const withSignals = buildReflectionPromptParts(CONVERSATION, 1000, signals);
    const without = buildReflectionPromptParts(CONVERSATION, 1000, []);
    assert.ok(withSignals.user.includes("1. [exec] exit 1 on build (sig:abcdef12)"));
    assert.equal(withSignals.system, without.system, "signals are dynamic content; system must be static");
  });

  it("keeps the prompt text verbatim: system + blank line + user reproduces the single-slot form", () => {
    const parts = buildReflectionPromptParts(CONVERSATION, 1000, []);
    const combined = `${parts.system}\n\n${parts.user}`;
    assert.ok(
      combined.includes("- This run showed ...\n\nRecent tool error signals:"),
      "the static tail must flow into the dynamic block exactly as the legacy single-slot prompt did",
    );
    assert.ok(combined.endsWith("```"), "the combined form still ends with the INPUT fence close");
  });

  it("clips the conversation to maxInputChars from the tail, in user only", () => {
    const long = "x".repeat(50) + "TAIL-MARKER";
    const parts = buildReflectionPromptParts(long, 20, []);
    assert.ok(parts.user.includes("TAIL-MARKER"));
    assert.ok(!parts.user.includes("x".repeat(30)), "only the last maxInputChars survive");
  });
});

describe("embedded distiller run sends the combined single-slot form", () => {
  it("passes system + user as one prompt and no system-slot param", async () => {
    let seenParams = null;
    currentRunnerImpl = async (params) => {
      seenParams = params;
      return { payloads: [{ text: "reflection text" }] };
    };

    const result = await generateReflectionText(baseParams);
    assert.equal(result.runner, "embedded");
    assert.ok(seenParams, "the embedded runner must have been invoked");

    const parts = buildReflectionPromptParts(CONVERSATION, baseParams.maxInputChars, []);
    assert.equal(
      seenParams.prompt,
      `${parts.system}\n\n${parts.user}`,
      "the embedded raw run has no honored system slot, so the prompt must be the combined single-slot form",
    );
    assert.equal(
      seenParams.systemPromptOverride,
      undefined,
      "no system-slot param may be passed; a host whose runner honors one can deliver the parts split",
    );
    assert.equal(seenParams.modelRun, true, "raw-run semantics must survive the parts refactor");
    assert.equal(seenParams.promptMode, "minimal");
  });
});

describe("CLI fallback keeps the single-slot combined form (cannot set a system prompt)", () => {
  const stubDir = mkdtempSync(path.join(tmpdir(), "reflection-cli-stub-"));
  const dumpPath = path.join(stubDir, "argv.dump");
  const stubPath = path.join(stubDir, "fake-openclaw.sh");
  writeFileSync(
    stubPath,
    `#!/bin/sh\nprintf '%s\\0' "$@" > "${dumpPath}"\necho '{"payloads":[{"text":"cli reflection text"}]}'\n`,
    "utf-8",
  );
  chmodSync(stubPath, 0o755);

  after(() => rmSync(stubDir, { recursive: true, force: true }));

  it("sends system + user as one --message payload", async () => {
    currentRunnerImpl = async () => {
      throw new Error("forced embedded failure");
    };
    const originalCliBin = process.env.OPENCLAW_CLI_BIN;
    process.env.OPENCLAW_CLI_BIN = stubPath;
    try {
      const result = await generateReflectionText(baseParams);
      assert.equal(result.runner, "cli");
      assert.equal(result.text, "cli reflection text");
    } finally {
      if (originalCliBin === undefined) delete process.env.OPENCLAW_CLI_BIN;
      else process.env.OPENCLAW_CLI_BIN = originalCliBin;
    }

    assert.ok(existsSync(dumpPath), "the CLI stub must have captured argv");
    const argv = readFileSync(dumpPath, "utf-8").split("\0");
    const messageIdx = argv.indexOf("--message");
    assert.ok(messageIdx > 0, "--message flag expected in CLI argv");
    const message = argv[messageIdx + 1];
    const parts = buildReflectionPromptParts(CONVERSATION, baseParams.maxInputChars, []);
    assert.equal(
      message,
      `${parts.system}\n\n${parts.user}`,
      "the CLI fallback has no system slot, so it must carry the combined single-slot prompt",
    );
  });
});
