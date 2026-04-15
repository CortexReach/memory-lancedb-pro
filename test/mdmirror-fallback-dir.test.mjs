import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { homedir } from "node:os";
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
const { getDefaultMdMirrorDir, parsePluginConfig } = jiti("../index.ts");

describe("mdMirror fallback directory", () => {
  it("returns an absolute path", () => {
    const dir = getDefaultMdMirrorDir();
    assert.ok(path.isAbsolute(dir), `expected absolute path, got: ${dir}`);
  });

  it("resolves inside ~/.openclaw/memory/md-mirror", () => {
    const dir = getDefaultMdMirrorDir();
    const expected = path.join(homedir(), ".openclaw", "memory", "md-mirror");
    assert.equal(dir, expected);
  });

  it("does not use the old relative 'memory-md' default", () => {
    const dir = getDefaultMdMirrorDir();
    assert.ok(
      !dir.endsWith("/memory-md") && !dir.endsWith("\\memory-md"),
      `should not fall back to relative 'memory-md', got: ${dir}`,
    );
  });

  it("parsePluginConfig preserves explicit mdMirror.dir", () => {
    const parsed = parsePluginConfig({
      embedding: { apiKey: "test-key" },
      mdMirror: { enabled: true, dir: "/custom/mirror/path" },
    });
    assert.equal(parsed.mdMirror.dir, "/custom/mirror/path");
  });

  it("parsePluginConfig leaves mdMirror.dir undefined when not set", () => {
    const parsed = parsePluginConfig({
      embedding: { apiKey: "test-key" },
      mdMirror: { enabled: true },
    });
    assert.equal(parsed.mdMirror.dir, undefined);
  });
});
