// memory-pro consolidate: settlement is durable state, so the CLI writes the
// settled ledger only for a run that COMMITTED (--apply or an interactive
// YES). A dry-run that judges a cluster "skip" must not hide that cluster
// from every later preview and apply for the ledger's retention window.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import jitiFactory from "jiti";
import { Command } from "commander";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { createMemoryCLI } = jiti(path.join(testDir, "..", "cli.ts"));

const AGENT = "lamp-tester";
const SCOPE = `agent:${AGENT}`;

function pairRows() {
  const ts = 1_700_000_000_000;
  const row = (id, abstract, offset) => ({
    id,
    text: abstract,
    vector: [1, 0],
    category: "preference",
    scope: SCOPE,
    importance: 0.7,
    timestamp: ts + offset,
    metadata: JSON.stringify({
      l0_abstract: abstract,
      l1_overview: "",
      l2_content: abstract,
      memory_category: "preferences",
      fact_key: "preferences:desk lamp",
      source: "manual",
      valid_from: ts + offset,
    }),
  });
  return [
    row("row-000001", "Desk lamp: warm white bulb", 0),
    row("row-000002", "Desk lamp: warm white bulb, dimmable", 1000),
  ];
}

function buildProgram(dbPath, rows, llmCalls) {
  const program = new Command();
  const context = {
    store: {
      dbPath,
      fetchForCompaction: async () => rows.map((r) => ({ ...r })),
      update: async (id, patch) => {
        const row = rows.find((r) => r.id === id);
        if (!row) return null;
        Object.assign(row, patch);
        return { ...row };
      },
      getById: async (id) => {
        const row = rows.find((r) => r.id === id);
        return row ? { ...row } : null;
      },
    },
    retriever: {},
    scopeManager: {},
    migrator: {},
    llmClient: {
      completeJson: async (_prompt, label) => {
        llmCalls.push(label);
        if (label === "consolidate-decide") {
          return { verdicts: [{ cluster_index: 1, verdict: "skip", reason: "both rows already agree" }] };
        }
        return { results: [] };
      },
    },
    embedder: { embedPassage: async () => [1, 0] },
  };
  createMemoryCLI(context)({ program });
  return program;
}

async function runConsolidate(program, extraArgs) {
  const logs = [];
  const errors = [];
  const exitCalls = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;
  console.log = (...parts) => logs.push(parts.join(" "));
  console.error = (...parts) => errors.push(parts.join(" "));
  process.exit = (code) => {
    exitCalls.push(code);
  };
  try {
    await program.parseAsync(["node", "cli", "memory-pro", "consolidate", "--agent", AGENT, "--yes", ...extraArgs]);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
  }
  return { logs: logs.join("\n"), errors: errors.join("\n"), exitCalls };
}

describe("memory-pro consolidate: the settled ledger is written only by a committed run", () => {
  it("dry-run judges skip verdicts but persists nothing; --apply commits them; the next run then skips the cluster without an LLM call", async () => {
    const dbPath = mkdtempSync(path.join(tmpdir(), "consolidate-settled-"));
    const ledgerPath = path.join(dbPath, "consolidate-settled.json");
    try {
      const llmCalls = [];

      const dryRun = await runConsolidate(buildProgram(dbPath, pairRows(), llmCalls), []);
      assert.deepEqual(dryRun.exitCalls, [], `dry-run must not exit non-zero: ${dryRun.errors}`);
      assert.match(dryRun.logs, /\[skip\] 2 rows/, "the cluster is judged in the preview");
      assert.match(dryRun.logs, /No changes applied\./);
      assert.match(dryRun.logs, /1 skip verdict not recorded as settled: a dry-run never writes the settled ledger/);
      assert.equal(existsSync(ledgerPath), false, "a dry-run must not create or mutate the settled ledger");
      const callsAfterDryRun = llmCalls.filter((l) => l === "consolidate-decide").length;
      assert.equal(callsAfterDryRun, 1, "the preview paid exactly one decide call");

      const secondDryRun = await runConsolidate(buildProgram(dbPath, pairRows(), llmCalls), []);
      assert.deepEqual(secondDryRun.exitCalls, []);
      assert.equal(
        llmCalls.filter((l) => l === "consolidate-decide").length,
        2,
        "with nothing committed, the second preview re-decides the same cluster",
      );
      assert.equal(existsSync(ledgerPath), false);

      const applied = await runConsolidate(buildProgram(dbPath, pairRows(), llmCalls), ["--apply"]);
      assert.deepEqual(applied.exitCalls, [], `--apply must not exit non-zero: ${applied.errors}`);
      assert.doesNotMatch(applied.logs, /not recorded as settled/);
      assert.equal(existsSync(ledgerPath), true, "--apply commits the settlement");
      const ledger = JSON.parse(readFileSync(ledgerPath, "utf-8"));
      assert.equal(ledger[SCOPE]?.length, 1, "exactly the one skip cluster is settled under the agent scope");

      const afterCommit = await runConsolidate(buildProgram(dbPath, pairRows(), llmCalls), []);
      assert.deepEqual(afterCommit.exitCalls, []);
      assert.match(afterCommit.logs, /1 settled in previous runs/, "the committed settlement now suppresses the cluster");
      assert.equal(
        llmCalls.filter((l) => l === "consolidate-decide").length,
        3,
        "a settled cluster costs no decide call",
      );
    } finally {
      rmSync(dbPath, { recursive: true, force: true });
    }
  });
});
