// Regression: an incomplete `memory-pro consolidate --apply` (a cluster that failed
// to apply, or applied only partially) must exit non-zero so cron jobs, CI and
// scripts can tell it from a clean apply. A clean apply keeps status 0.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import jitiFactory from "jiti";
import { Command } from "commander";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { createMemoryCLI } = jiti(path.join(testDir, "..", "cli.ts"));

const AGENT = "exit-status-tester";
const SCOPE = `agent:${AGENT}`;

function rows(count) {
  const ts = 1_700_000_000_000;
  const out = [];
  for (let i = 1; i <= count; i++) {
    const abstract = `Coffee order: oat milk latte, variant ${i}`;
    out.push({
      id: `row-${String(i).padStart(6, "0")}`,
      text: abstract,
      vector: [1, 0],
      category: "preference",
      scope: SCOPE,
      importance: 0.7,
      timestamp: ts + i * 1000,
      metadata: JSON.stringify({
        l0_abstract: abstract,
        l1_overview: "",
        l2_content: abstract,
        memory_category: "preferences",
        fact_key: "preferences:coffee order",
        source: "manual",
        valid_from: ts + i * 1000,
      }),
    });
  }
  return out;
}

function supersedeVerdict(memberCount) {
  const absorbed = [];
  for (let i = 1; i < memberCount; i++) absorbed.push(i);
  return { cluster_index: 1, verdict: "supersede", survivor_index: memberCount, absorbed_indices: absorbed, reason: "newest wins" };
}

function buildProgram(dbPath, storeRows, failOn) {
  const program = new Command();
  const context = {
    store: {
      dbPath,
      fetchForCompaction: async () => storeRows.map((r) => ({ ...r })),
      update: async (id, patch) => {
        if (failOn(id)) throw new Error(`injected write failure for ${id}`);
        const row = storeRows.find((r) => r.id === id);
        if (!row) return null;
        Object.assign(row, patch);
        return { ...row };
      },
      getById: async (id) => {
        const row = storeRows.find((r) => r.id === id);
        return row ? { ...row } : null;
      },
    },
    retriever: {},
    scopeManager: {},
    migrator: {},
    llmClient: {
      completeJson: async (_prompt, label) => {
        if (label === "consolidate-decide") return { verdicts: [supersedeVerdict(storeRows.length)] };
        return { results: [] };
      },
    },
    embedder: { embedPassage: async () => [1, 0] },
  };
  createMemoryCLI(context)({ program });
  return program;
}

async function runApply(program) {
  const logs = [];
  const errors = [];
  const exitCalls = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const originalExit = process.exit;
  const originalExitCode = process.exitCode;
  console.log = (...parts) => logs.push(parts.join(" "));
  console.error = (...parts) => errors.push(parts.join(" "));
  console.warn = () => {};
  process.exit = (code) => {
    exitCalls.push(code);
  };
  process.exitCode = undefined;
  let exitCode;
  try {
    await program.parseAsync(["node", "cli", "memory-pro", "consolidate", "--agent", AGENT, "--yes", "--apply"]);
    exitCode = process.exitCode;
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
    process.exit = originalExit;
    process.exitCode = originalExitCode;
  }
  return { logs: logs.join("\n"), errors: errors.join("\n"), exitCalls, exitCode };
}

describe("memory-pro consolidate --apply: exit status reflects incomplete work", () => {
  it("a cluster whose apply wrote nothing (every absorbed invalidation failed) exits with status 1", async () => {
    const dbPath = mkdtempSync(path.join(tmpdir(), "consolidate-exit-"));
    try {
      const storeRows = rows(2);
      const run = await runApply(buildProgram(dbPath, storeRows, (id) => id === storeRows[0].id));
      assert.deepEqual(run.exitCalls, [], `the report must be printed before the status is set: ${run.errors}`);
      assert.match(run.logs, /1 cluster FAILED to apply/);
      assert.match(run.errors, /consolidate: apply incomplete .*1 cluster failed.*exiting with status 1/);
      assert.equal(run.exitCode, 1, "applyFailed must surface as a non-zero exit status");
    } finally {
      rmSync(dbPath, { recursive: true, force: true });
    }
  });

  it("a cluster that applied only partially (one absorbed invalidation failed) exits with status 1", async () => {
    const dbPath = mkdtempSync(path.join(tmpdir(), "consolidate-exit-"));
    try {
      const storeRows = rows(3);
      const run = await runApply(buildProgram(dbPath, storeRows, (id) => id === storeRows[0].id));
      assert.deepEqual(run.exitCalls, []);
      assert.match(run.logs, /1 cluster PARTIALLY applied/);
      assert.match(run.logs, /partial: invalidate-absorbed row-0000 .*injected write failure/);
      assert.match(run.errors, /consolidate: apply incomplete .*1 cluster partially applied/);
      assert.equal(run.exitCode, 1, "partialFailures must surface as a non-zero exit status");
    } finally {
      rmSync(dbPath, { recursive: true, force: true });
    }
  });

  it("a clean apply keeps status 0", async () => {
    const dbPath = mkdtempSync(path.join(tmpdir(), "consolidate-exit-"));
    try {
      const storeRows = rows(2);
      const run = await runApply(buildProgram(dbPath, storeRows, () => false));
      assert.deepEqual(run.exitCalls, []);
      assert.match(run.logs, /Applied 1 action\./);
      assert.doesNotMatch(run.errors, /apply incomplete/);
      assert.ok(run.exitCode === undefined || run.exitCode === 0, `clean apply must not set a failure status, got ${run.exitCode}`);
    } finally {
      rmSync(dbPath, { recursive: true, force: true });
    }
  });
});
