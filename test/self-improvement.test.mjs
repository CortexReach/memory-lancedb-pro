import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  registerSelfImprovementLogTool,
  registerSelfImprovementExtractSkillTool,
} = jiti("../src/tools.ts");
const { appendSelfImprovementEntry } = jiti("../src/self-improvement-files.ts");
const {
  extractReflectionLearningGovernanceCandidates,
  extractReflectionLessons,
  extractReflectionMappedMemories,
} = jiti("../src/reflection-slices.ts");

function createToolHarness(workspaceDir) {
  const factories = new Map();
  const api = {
    registerTool(factory, meta) {
      factories.set(meta?.name || "", factory);
    },
  };

  const context = {
    workspaceDir,
    retriever: {},
    store: {},
    scopeManager: {},
    embedder: {},
    mdMirror: null,
  };

  registerSelfImprovementLogTool(api, context);
  registerSelfImprovementExtractSkillTool(api, context);

  return {
    tool(name, toolCtx = {}) {
      const factory = factories.get(name);
      assert.ok(factory, `tool not registered: ${name}`);
      return factory(toolCtx);
    },
  };
}

describe("self-improvement", () => {
  describe("tool file-write flow", () => {
    let workspaceDir;

    beforeEach(() => {
      workspaceDir = mkdtempSync(path.join(tmpdir(), "self-improvement-test-"));
    });

    afterEach(() => {
      rmSync(workspaceDir, { recursive: true, force: true });
    });

    it("extracts mapped reflection sections into preference/fact/decision memories", async () => {
      const reflectionText = [
        "## Context (session background)",
        "- (none captured)",
        "",
        "## Decisions (durable)",
        "- Always verify file evidence before reporting completion.",
        "",
        "## User model deltas (about the human)",
        "- Prefers concise direct answers without confirmation loops.",
        "",
        "## Agent model deltas (about the assistant/system)",
        "- Should label empty-state status as triage before calling it a failure.",
        "",
        "## Lessons & pitfalls (symptom / cause / fix / prevention)",
        "- Symptom: empty-state status looked like a failure. Cause: no explicit triage label. Fix: classify empty-state as triage first. Prevention: avoid calling it breakage without reproduction.",
        "",
        "## Learning governance candidates (.learnings / promotion / skill extraction)",
        "- LRN candidate: require file evidence before saying a skill was updated.",
      ].join("\n");
      const mapped = extractReflectionMappedMemories(reflectionText);
      assert.deepEqual(mapped, [
        {
          text: "Prefers concise direct answers without confirmation loops.",
          category: "preference",
          heading: "User model deltas (about the human)",
        },
        {
          text: "Should label empty-state status as triage before calling it a failure.",
          category: "preference",
          heading: "Agent model deltas (about the assistant/system)",
        },
        {
          text: "Symptom: empty-state status looked like a failure. Cause: no explicit triage label. Fix: classify empty-state as triage first. Prevention: avoid calling it breakage without reproduction.",
          category: "fact",
          heading: "Lessons & pitfalls (symptom / cause / fix / prevention)",
        },
        {
          text: "Always verify file evidence before reporting completion.",
          category: "decision",
          heading: "Decisions (durable)",
        },
      ]);
    });

    it("parses structured learning governance candidates and appends them as separate entries", async () => {
      const reflectionText = [
        "## Context (session background)",
        "- (none captured)",
        "",
        "## Lessons & pitfalls (symptom / cause / fix / prevention)",
        "- Symptom: empty-state status looked like a failure. Cause: no explicit triage label. Fix: classify empty-state as triage first. Prevention: avoid calling it breakage without reproduction.",
        "- Symptom: reported done without file proof. Cause: conversation claim outran file verification. Fix: attach file evidence before declaring completion. Prevention: always verify real paths before reporting.",
        "",
        "## Learning governance candidates (.learnings / promotion / skill extraction)",
        "### Entry 1",
        "**Priority**: high",
        "**Status**: triage",
        "**Area**: docs",
        "### Summary",
        "Require file evidence before saying a skill was updated.",
        "### Details",
        "Conversation claims about implementation state outran file verification.",
        "### Suggested Action",
        "Attach concrete file paths and line references in the first completion report.",
        "",
        "### Entry 2",
        "**Priority**: medium",
        "**Status**: pending",
        "**Area**: config",
        "### Summary",
        "Document the triage-first rule after it repeats.",
        "### Details",
        "Promote the rule into AGENTS.md once it is stable.",
        "### Suggested Action",
        "Add the concise rule to AGENTS.md when the pattern repeats again.",
      ].join("\n");
      const lessons = extractReflectionLessons(reflectionText);
      assert.deepEqual(lessons, [
        "Symptom: empty-state status looked like a failure. Cause: no explicit triage label. Fix: classify empty-state as triage first. Prevention: avoid calling it breakage without reproduction.",
        "Symptom: reported done without file proof. Cause: conversation claim outran file verification. Fix: attach file evidence before declaring completion. Prevention: always verify real paths before reporting.",
      ]);
      const governanceCandidates = extractReflectionLearningGovernanceCandidates(reflectionText);
      assert.deepEqual(governanceCandidates, [
        {
          priority: "high",
          status: "triage",
          area: "docs",
          summary: "Require file evidence before saying a skill was updated.",
          details: "Conversation claims about implementation state outran file verification.",
          suggestedAction: "Attach concrete file paths and line references in the first completion report.",
        },
        {
          priority: "medium",
          status: "pending",
          area: "config",
          summary: "Document the triage-first rule after it repeats.",
          details: "Promote the rule into AGENTS.md once it is stable.",
          suggestedAction: "Add the concise rule to AGENTS.md when the pattern repeats again.",
        },
      ]);

      const appendedOne = await appendSelfImprovementEntry({
        baseDir: workspaceDir,
        type: "learning",
        summary: governanceCandidates[0].summary,
        details: governanceCandidates[0].details,
        suggestedAction: governanceCandidates[0].suggestedAction,
        area: governanceCandidates[0].area,
        priority: governanceCandidates[0].priority,
        status: governanceCandidates[0].status,
        source: "memory-lancedb-pro/reflection:test",
      });
      const appendedTwo = await appendSelfImprovementEntry({
        baseDir: workspaceDir,
        type: "learning",
        summary: governanceCandidates[1].summary,
        details: governanceCandidates[1].details,
        suggestedAction: governanceCandidates[1].suggestedAction,
        area: governanceCandidates[1].area,
        priority: governanceCandidates[1].priority,
        status: governanceCandidates[1].status,
        source: "memory-lancedb-pro/reflection:test",
      });

      assert.match(appendedOne.id, /^LRN-\d{8}-001$/);
      assert.match(appendedTwo.id, /^LRN-\d{8}-002$/);
      const learningsPath = path.join(workspaceDir, ".learnings", "LEARNINGS.md");
      const learningsBody = readFileSync(learningsPath, "utf-8");
      assert.match(learningsBody, /Require file evidence before saying a skill was updated/);
      assert.match(learningsBody, /\*\*Priority\*\*: high/);
      assert.match(learningsBody, /\*\*Status\*\*: triage/);
      assert.match(learningsBody, /Document the triage-first rule after it repeats/);
      assert.match(learningsBody, /\*\*Status\*\*: pending/);
      assert.match(learningsBody, /Source: memory-lancedb-pro\/reflection:test/);
    });

    it("handles learning id validation and writes promoted skill scaffold with sanitized outputDir", async () => {
      const harness = createToolHarness(workspaceDir);
      const logTool = harness.tool("self_improvement_log");
      const extractTool = harness.tool("self_improvement_extract_skill");

      const logged = await logTool.execute("tc-1", {
        type: "learning",
        summary: "Use deterministic temp fixtures in tests.",
        details: "Nondeterministic fixture paths caused flaky assertions.",
        suggestedAction: "Always bind fixtures to test-local temp dirs.",
        category: "best_practice",
        area: "tests",
        priority: "high",
      });

      const learningId = logged?.details?.id;
      assert.match(learningId, /^LRN-\d{8}-001$/);

      const invalid = await extractTool.execute("tc-2", {
        learningId: "LRN-INVALID",
        skillName: "deterministic-fixtures",
      });
      assert.equal(invalid?.details?.error, "invalid_learning_id");

      const extracted = await extractTool.execute("tc-3", {
        learningId,
        skillName: "deterministic-fixtures",
        outputDir: "../../outside//skills",
      });

      assert.equal(extracted?.details?.action, "skill_extracted");
      const skillPath = extracted?.details?.skillPath;
      assert.ok(typeof skillPath === "string" && skillPath.length > 0);
      assert.ok(!skillPath.includes(".."), `skillPath must be sanitized: ${skillPath}`);
      assert.ok(!skillPath.startsWith("/"), `skillPath must stay relative: ${skillPath}`);

      const absSkillPath = path.resolve(workspaceDir, skillPath);
      assert.ok(
        absSkillPath.startsWith(path.resolve(workspaceDir) + path.sep),
        `skill file escaped workspace: ${absSkillPath}`
      );

      const skillContent = readFileSync(absSkillPath, "utf-8");
      assert.match(skillContent, /# Deterministic Fixtures/);
      assert.match(skillContent, new RegExp(`Learning ID: ${learningId}`));

      const learningsPath = path.join(workspaceDir, ".learnings", "LEARNINGS.md");
      const learningsBody = readFileSync(learningsPath, "utf-8");
      assert.match(learningsBody, /\*\*Status\*\*:\s*promoted_to_skill/);
      assert.match(learningsBody, /Skill-Path:\s*outside\/skills\/deterministic-fixtures/);
    });
  });
});
