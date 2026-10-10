import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { classifyWorkspaceMemoryPath, createOpenClawMemoryCapability } = jiti(
  "../src/openclaw-memory-capability.ts",
);

const workspaceDir = mkdtempSync(path.join(tmpdir(), "memory-provenance-"));

function createRuntime() {
  return createOpenClawMemoryCapability({
    dbPath: path.join(workspaceDir, "db"),
    vectorDim: 8,
    embeddingProvider: "test",
    embeddingModel: "test-model",
    workspaceDir,
  }).runtime;
}

test("the runtime exposes classifyWorkspaceMemoryPaths and keeps the bootstrap candidates eligible", async () => {
  const runtime = createRuntime();
  assert.equal(typeof runtime.classifyWorkspaceMemoryPaths, "function");
  const classified = await runtime.classifyWorkspaceMemoryPaths({
    agentId: "main",
    workspaceDir,
    relativePaths: ["MEMORY.md", "USER.md"],
  });
  assert.deepEqual(classified, [
    { relativePath: "MEMORY.md", originClass: "agent" },
    { relativePath: "USER.md", originClass: "agent" },
  ]);
});

test("workspace memory journals and reflections classify as agent-origin", () => {
  for (const relativePath of [
    "memory.md",
    "memory/2026-09-16.md",
    "memory/reflections/2026-09-16/inherited-rules.md",
    "memory/../USER.md",
  ]) {
    assert.equal(classifyWorkspaceMemoryPath(workspaceDir, relativePath), "agent", relativePath);
  }
});

test("dream artifacts classify as system-origin", () => {
  for (const relativePath of ["DREAMS.md", "memory/dreaming/2026-09-16.md", "memory/.dreams/last.md"]) {
    assert.equal(classifyWorkspaceMemoryPath(workspaceDir, relativePath), "system", relativePath);
  }
});

test("anything outside the memory files, or outside the workspace, classifies as untrusted", () => {
  for (const relativePath of [
    "notes/other.md",
    "AGENTS.md",
    "memory/notes.txt",
    "memory",
    ".",
    "../escape.md",
    path.join(tmpdir(), "elsewhere", "MEMORY.md"),
  ]) {
    assert.equal(classifyWorkspaceMemoryPath(workspaceDir, relativePath), "untrusted", relativePath);
  }
});

test("classification preserves the requested order and paths verbatim", async () => {
  const runtime = createRuntime();
  const relativePaths = ["USER.md", "notes/other.md", "MEMORY.md"];
  const classified = await runtime.classifyWorkspaceMemoryPaths({ agentId: "agent-two", workspaceDir, relativePaths });
  assert.deepEqual(
    classified.map((entry) => entry.relativePath),
    relativePaths,
  );
  assert.deepEqual(
    classified.map((entry) => entry.originClass),
    ["agent", "untrusted", "agent"],
  );
});
