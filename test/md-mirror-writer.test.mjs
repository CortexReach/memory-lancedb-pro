import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Module from "node:module";
import jitiFactory from "jiti";

process.env.NODE_PATH = [
  process.env.NODE_PATH,
  "/opt/homebrew/lib/node_modules/openclaw/node_modules",
  "/opt/homebrew/lib/node_modules",
].filter(Boolean).join(":");
Module._initPaths();

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const {
  createCompatibilityMdMirrorWriter,
  getWorkspaceCompatibilityMirrorDir,
} = jiti("../src/md-mirror.ts");

async function withTempDir(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "memory-md-mirror-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("getWorkspaceCompatibilityMirrorDir", () => {
  it("returns a path parallel to the primary daily-log path", () => {
    const workspaceDir = "/tmp/example-workspace";
    assert.equal(
      getWorkspaceCompatibilityMirrorDir(workspaceDir),
      "/tmp/example-workspace/memory/plugins/memory-lancedb-pro",
    );
  });
});

describe("createCompatibilityMdMirrorWriter", () => {
  it("writes compatibility files under memory/plugins/memory-lancedb-pro for known agent workspaces", async () => {
    await withTempDir(async (root) => {
      const workspaceDir = path.join(root, "workspace-main");
      mkdirSync(path.join(workspaceDir, "memory"), { recursive: true });
      writeFileSync(path.join(workspaceDir, "memory", "2026-03-22.md"), "# Human daily log\n", "utf8");

      const writer = createCompatibilityMdMirrorWriter({
        fallbackDir: path.join(root, "fallback-root"),
        workspaceMap: { main: workspaceDir },
      });

      await writer(
        {
          text: "用户喜欢乌龙茶。",
          category: "preferences",
          scope: "agent:main",
          timestamp: Date.parse("2026-03-22T01:02:03.000Z"),
        },
        { agentId: "main", source: "memory_store" },
      );

      const mirrorDir = path.join(workspaceDir, "memory", "plugins", "memory-lancedb-pro");
      const readme = await readFile(path.join(mirrorDir, "README.md"), "utf8");
      const daily = await readFile(path.join(mirrorDir, "2026-03-22.md"), "utf8");
      const humanDaily = await readFile(path.join(workspaceDir, "memory", "2026-03-22.md"), "utf8");

      assert.match(readme, /memory-lancedb-pro compatibility subtree/);
      assert.match(daily, /preferences:agent:main/);
      assert.match(daily, /agent=main/);
      assert.match(daily, /source=memory_store/);
      assert.match(daily, /用户喜欢乌龙茶/);
      assert.equal(humanDaily, "# Human daily log\n");
    });
  });

  it("uses the exact fallback directory when agent workspace mapping is unavailable", async () => {
    await withTempDir(async (root) => {
      const fallbackDir = path.join(root, "custom-fallback");
      const writer = createCompatibilityMdMirrorWriter({
        fallbackDir,
        workspaceMap: {},
      });

      await writer(
        {
          text: "fallback memory",
          category: "projects",
          scope: "global",
          timestamp: Date.parse("2026-03-22T05:00:00.000Z"),
        },
        { agentId: "unknown-agent", source: "auto-capture" },
      );

      const daily = readFileSync(path.join(fallbackDir, "2026-03-22.md"), "utf8");
      assert.match(daily, /fallback memory/);
      assert.ok(readFileSync(path.join(fallbackDir, "README.md"), "utf8").includes("compatibility subtree"));
    });
  });

  it("does not overwrite an existing README.md", async () => {
    await withTempDir(async (root) => {
      const workspaceDir = path.join(root, "workspace-main");
      const mirrorDir = path.join(workspaceDir, "memory", "plugins", "memory-lancedb-pro");
      mkdirSync(mirrorDir, { recursive: true });
      writeFileSync(path.join(mirrorDir, "README.md"), "custom readme\n", "utf8");

      const writer = createCompatibilityMdMirrorWriter({
        fallbackDir: path.join(root, "fallback-root"),
        workspaceMap: { main: workspaceDir },
      });

      await writer(
        {
          text: "another memory",
          category: "entities",
          scope: "agent:main",
          timestamp: Date.parse("2026-03-22T09:00:00.000Z"),
        },
        { agentId: "main" },
      );

      const readme = readFileSync(path.join(mirrorDir, "README.md"), "utf8");
      assert.equal(readme, "custom readme\n");
    });
  });
});
