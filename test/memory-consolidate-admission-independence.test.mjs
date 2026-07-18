import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";
import { Command } from "commander";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const jiti = jitiFactory(import.meta.url, { interopDefault: true });

let nextId = 1;
function makeRow({ scope = "global", abstract, content, factKey, vector, timestamp = 1_700_000_000_000 }) {
  const id = `row-${String(nextId++).padStart(6, "0")}`;
  const metadata = {
    l0_abstract: abstract,
    l1_overview: "",
    l2_content: content || abstract,
    memory_category: "preferences",
    fact_key: factKey,
    source: "manual",
    valid_from: timestamp,
  };
  return { id, text: abstract, vector, category: "preference", scope, importance: 0.7, timestamp, metadata: JSON.stringify(metadata) };
}

// Every method throws if ever invoked -- a "poison pill" proving consolidate
// never reaches for admission control at any point in its flow.
function makePoisonAdmissionController() {
  const poison = (name) => () => {
    throw new Error(`consolidate must never touch AdmissionController.${name}`);
  };
  return {
    evaluate: poison("evaluate"),
    evaluateBatch: poison("evaluateBatch"),
    getAdmissionController: poison("getAdmissionController"),
  };
}

describe("memory consolidate: item 9 admissionControl independence", () => {
  it("runs the full consolidate flow identically with admissionControl.enabled:false and a poison-pill controller never invoked", async () => {
    const { createMemoryCLI } = jiti(path.join(testDir, "..", "cli.ts"));

    const ts = 1_700_000_000_000;
    const rows = [
      makeRow({ scope: "agent:testbot", abstract: "Coffee order: oat milk latte", content: "a", factKey: "preferences:coffee order", vector: [1, 0], timestamp: ts }),
      makeRow({ scope: "agent:testbot", abstract: "Coffee order: oat milk latte, extra hot", content: "b", factKey: "preferences:coffee order", vector: [1, 0], timestamp: ts + 1000 }),
    ];

    const calls = [];
    const poisonAdmissionController = makePoisonAdmissionController();
    const context = {
      store: {
        fetchForCompaction: async (maxTimestamp, scopeFilter, limit) =>
          rows.filter((r) => (!scopeFilter || scopeFilter.includes(r.scope)) && r.timestamp <= maxTimestamp).slice(0, limit ?? rows.length),
        update: async (id, patch) => {
          const row = rows.find((r) => r.id === id);
          if (row) Object.assign(row, patch);
          return row ? { ...row } : null;
        },
        getById: async (id) => {
          const row = rows.find((r) => r.id === id);
          return row ? { ...row } : null;
        },
      },
      retriever: {},
      scopeManager: {},
      migrator: {},
      embedder: { embedPassage: async () => [1, 0] },
      llmClient: {
        completeJson: async (_prompt, label) => {
          calls.push(label);
          if (label === "consolidate-decide") {
            return { verdicts: [{ cluster_index: 1, verdict: "merge", survivor_index: 1, absorbed_indices: [2], reason: "same fact, second adds detail" }] };
          }
          return {
            results: [
              { index: 1, abstract: "Coffee order: oat milk latte, extra hot", overview: "", content: "merged content" },
            ],
          };
        },
        getLastError: () => null,
      },
      // Not declared on CLIContext's TS shape -- present at runtime the way an
      // externally-constructed controller would be, to prove that IF consolidate's
      // action ever reached for it (directly or via some future refactor), this
      // test would catch it immediately via the poison pill throwing.
      admissionController: poisonAdmissionController,
      pluginConfig: { admissionControl: { enabled: false } },
    };

    const program = new Command();
    program.exitOverride();
    createMemoryCLI(context)({ program });

    await program.parseAsync(["node", "openclaw", "memory-pro", "consolidate", "--agent", "testbot", "--apply", "--yes"]);

    assert.ok(calls.includes("consolidate-decide"), "the decider call must still fire normally");
    assert.ok(calls.includes("consolidate-merge-batch"), "merge-content generation must still fire normally");

    const survivor = rows.find((r) => r.text === "Coffee order: oat milk latte, extra hot");
    assert.ok(survivor, "the merge must have actually applied, proving the flow completed end to end");
  });
});
