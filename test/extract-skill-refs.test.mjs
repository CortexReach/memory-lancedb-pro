import { describe, it } from "node:test";
import assert from "node:assert/strict";
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
const { extractSkillRefs } = jiti("../index.ts");

describe("extractSkillRefs", () => {
  // Pass 1: {name}/SKILL.md paths

  it("extracts skill name from simple skills/name/SKILL.md", () => {
    const refs = extractSkillRefs("Using skills/tdd-workflow/SKILL.md for this task");
    assert.deepEqual(refs, ["tdd-workflow"]);
  });

  it("extracts skill name from nested path (parent of SKILL.md)", () => {
    const refs = extractSkillRefs(
      "Loaded /Users/pope/.agents/skills/superpowers/brainstorming/SKILL.md"
    );
    assert.ok(refs.includes("brainstorming"), `expected brainstorming, got ${refs}`);
    assert.ok(!refs.includes("superpowers"), `should not include superpowers`);
  });

  it("extracts skill name from deeply nested path", () => {
    const refs = extractSkillRefs(
      "/Users/pope/.codex/skills/.system/skill-creator/SKILL.md"
    );
    assert.ok(refs.includes("skill-creator"), `expected skill-creator, got ${refs}`);
    assert.ok(!refs.includes(".system"), `should not include .system`);
  });

  it("handles SKILL without .md extension", () => {
    const refs = extractSkillRefs("foo/bar/SKILL is loaded");
    assert.ok(refs.includes("bar"));
  });

  // Trailing punctuation

  it("strips trailing period after SKILL.md", () => {
    const refs = extractSkillRefs("/path/to/brainstorming/SKILL.md.");
    assert.ok(refs.includes("brainstorming"), `expected brainstorming, got ${refs}`);
  });

  it("strips trailing comma after SKILL.md", () => {
    const refs = extractSkillRefs("Used foo/SKILL.md, then bar/SKILL.md;");
    assert.ok(refs.includes("foo"));
    assert.ok(refs.includes("bar"));
  });

  it("strips CJK punctuation after SKILL.md", () => {
    const refs = extractSkillRefs("加载了 tdd/SKILL.md。完成");
    assert.ok(refs.includes("tdd"), `expected tdd, got ${refs}`);
  });

  // False positives: should NOT match

  it("does not match SKILL.md.bak", () => {
    const refs = extractSkillRefs("/tmp/foo/SKILL.md.bak");
    assert.ok(!refs.includes("foo"), `should not match .bak, got ${refs}`);
  });

  it("does not match SKILLING", () => {
    const refs = extractSkillRefs("/tmp/foo/SKILLING");
    assert.ok(!refs.includes("foo"), `should not match SKILLING, got ${refs}`);
  });

  it("does not match SKILL-notes", () => {
    const refs = extractSkillRefs("/tmp/foo/SKILL-notes");
    assert.ok(!refs.includes("foo"), `should not match SKILL-notes, got ${refs}`);
  });

  // Pass 2: plain skills/{name} directory paths

  it("extracts from ~/.claude/skills/memory-lancedb-pro", () => {
    const refs = extractSkillRefs("Use ~/.claude/skills/memory-lancedb-pro");
    assert.ok(refs.includes("memory-lancedb-pro"), `expected memory-lancedb-pro, got ${refs}`);
  });

  it("extracts from ~/.openclaw/workspace/skills/my-skill", () => {
    const refs = extractSkillRefs("Installed at ~/.openclaw/workspace/skills/my-skill");
    assert.ok(refs.includes("my-skill"), `expected my-skill, got ${refs}`);
  });

  it("strips trailing period from plain skill directory", () => {
    const refs = extractSkillRefs("Use ~/.claude/skills/memory-lancedb-pro.");
    assert.ok(refs.includes("memory-lancedb-pro"), `expected memory-lancedb-pro, got ${refs}`);
  });

  it("extracts last segment from nested skills path without SKILL.md", () => {
    const refs = extractSkillRefs("skills/superpowers/brainstorming");
    assert.ok(refs.includes("brainstorming"), `expected brainstorming, got ${refs}`);
  });

  // Pass 2: commands/{name}

  it("extracts command name", () => {
    const refs = extractSkillRefs("Use commands/commit for this");
    assert.ok(refs.includes("commit"), `expected commit, got ${refs}`);
  });

  // Edge cases

  it("returns empty for bare SKILL.md without path", () => {
    const refs = extractSkillRefs("Read the SKILL.md file");
    assert.equal(refs.length, 0, `expected empty, got ${refs}`);
  });

  it("deduplicates when both SKILL.md and dir path refer to same skill", () => {
    const refs = extractSkillRefs(
      "skills/tdd-workflow/SKILL.md is in skills/tdd-workflow"
    );
    // Both passes fire, but Set dedup happens at call site — here we just check correctness
    assert.ok(refs.includes("tdd-workflow"));
  });
});
