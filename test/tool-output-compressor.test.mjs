import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import jitiFactory from "jiti";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginSdkStubPath = path.resolve(testDir, "helpers", "openclaw-plugin-sdk-stub.mjs");
const jiti = jitiFactory(import.meta.url, {
  interopDefault: true,
  alias: {
    "openclaw/plugin-sdk": pluginSdkStubPath,
  },
});

const { compressToolOutput } = jiti("../src/tool-output-compressor.ts");

describe("compressToolOutput", () => {
  // ========================================================================
  // Base64 replacement
  // ========================================================================

  it("replaces large base64 blocks with size placeholder", () => {
    const base64 = "A".repeat(2000);
    const text = `Here is a screenshot:\n${base64}\nEnd of screenshot.`;
    const result = compressToolOutput(text);
    assert.ok(result.includes("[image:"), "should contain [image: placeholder");
    assert.ok(result.includes("base64"), "should mention base64");
    assert.ok(!result.includes("AAAA"), "should not contain raw base64");
  });

  it("preserves short base64-like strings", () => {
    const text = "The hash is abc123==";
    assert.equal(compressToolOutput(text), text);
  });

  // ========================================================================
  // Git output compression
  // ========================================================================

  it("compresses git push boilerplate", () => {
    const text = `$ git push origin main
Enumerating objects: 5, done.
Counting objects: 100% (5/5), done.
Delta compression using up to 8 threads
Compressing objects: 100% (3/3), done.
Writing objects: 100% (3/3), 450 bytes | 450.00 KiB/s, done.
Total 3 (delta 2), reused 0 (delta 0)
remote: Resolving deltas: 100% (2/2), completed with 2 local objects.
To github.com:user/repo.git
   abc1234..def5678  main -> main

Next I'll check the status.`;

    const result = compressToolOutput(text);
    assert.ok(result.includes("[git: ok"), "should compress to [git: ok]");
    assert.ok(result.includes("main"), "should keep branch name");
    assert.ok(!result.includes("Enumerating objects"), "should strip boilerplate");
    assert.ok(result.includes("Next I'll check the status"), "should preserve AI text after block");
  });

  it("preserves git push failures", () => {
    const text = `$ git push
Enumerating objects: 5, done.
error: failed to push some refs to 'origin'
hint: Updates were rejected because the tip of your branch is behind -> main`;

    const result = compressToolOutput(text);
    assert.ok(result.includes("error"), "should keep error message");
    assert.ok(result.includes("rejected"), "should keep rejection reason");
  });

  // ========================================================================
  // Test output compression
  // ========================================================================

  it("compresses passing test summary", () => {
    const text = `$ cargo test
running 15 tests
test a ... ok
test b ... ok
test c ... ok
test result: ok. 15 passed; 0 failed; 0 ignored

All tests passed.`;

    const result = compressToolOutput(text);
    // Compression should reduce size (either via block matching or base truncation)
    assert.ok(result.length <= text.length, "should not expand output");
    assert.ok(result.includes("All tests passed"), "should preserve text after block");
  });

  it("preserves failing test output", () => {
    const text = `$ npm test
Tests: 2 failed, 8 passed
FAIL src/main.test.ts
  ✕ should handle edge case`;

    const result = compressToolOutput(text);
    assert.ok(result.includes("failed"), "should keep failure info");
    assert.ok(result.includes("FAIL"), "should keep FAIL marker");
  });

  // ========================================================================
  // Safety: user/AI content untouched
  // ========================================================================

  it("never modifies plain conversation text", () => {
    const text = "User: How do I fix this git push error?\n\nAssistant: You need to pull first.";
    assert.equal(compressToolOutput(text), text);
  });

  it("preserves AI reasoning about tool results", () => {
    const text = "The test result shows 15 passed, which means our fix works.";
    assert.equal(compressToolOutput(text), text);
  });

  // ========================================================================
  // Edge cases
  // ========================================================================

  it("handles empty input", () => {
    assert.equal(compressToolOutput(""), "");
  });

  it("handles short input", () => {
    assert.equal(compressToolOutput("hi"), "hi");
  });

  it("handles text without tool outputs", () => {
    const text = "This is a normal conversation.\nNo tool outputs here.";
    assert.equal(compressToolOutput(text), text);
  });
});
