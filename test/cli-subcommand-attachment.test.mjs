import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";
import { Command } from "commander";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const jiti = jitiFactory(import.meta.url, { interopDefault: true });

function buildRegisteredProgram(storeOverrides = {}) {
  const { createMemoryCLI } = jiti(path.join(testDir, "..", "cli.ts"));
  const program = new Command();
  const stubContext = {
    store: storeOverrides,
    retriever: {},
    scopeManager: {},
    migrator: {},
  };
  createMemoryCLI(stubContext)({ program });
  return program;
}

function summaryRow({ id, text, l0, l1, l2 }) {
  const metadata = {};
  if (l0 !== undefined) metadata.l0_abstract = l0;
  if (l1 !== undefined) metadata.l1_overview = l1;
  if (l2 !== undefined) metadata.l2_content = l2;
  return {
    id,
    text,
    category: "preference",
    scope: "agent:main",
    importance: 0.7,
    timestamp: Date.now(),
    metadata: JSON.stringify(metadata),
  };
}

async function captureRepairRun(program, extraArgs = []) {
  const logs = [];
  const errors = [];
  const exitCalls = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;
  const priorExitCode = process.exitCode;
  console.log = (...parts) => logs.push(parts.join(" "));
  console.error = (...parts) => errors.push(parts.join(" "));
  process.exit = (code) => {
    exitCalls.push(code);
  };
  let exitCode;
  try {
    await program.parseAsync(["node", "cli", "memory-pro", "repair-summaries", ...extraArgs]);
  } finally {
    exitCode = process.exitCode;
    process.exitCode = priorExitCode;
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
  }
  return { logs: logs.join("\n"), errors: errors.join("\n"), exitCode, exitCalls };
}

function parseObjectMetadata(raw) {
  try {
    const parsed = JSON.parse(raw || "{}");
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // fall through to empty
  }
  return {};
}

async function runRepairSummaries(rows, extraArgs = [], storeOverrides = {}) {
  const updateCalls = [];
  const { update: overrideUpdate, ...restOverrides } = storeOverrides;
  const program = buildRegisteredProgram({
    async list(scopeFilter, category, limit = 200, offset = 0) {
      return rows.slice(offset, offset + limit);
    },
    async update(id, patch, scopeFilter) {
      updateCalls.push({ id, patch, scopeFilter });
      if (overrideUpdate) return overrideUpdate(id, patch, scopeFilter);
      return null;
    },
    // Production-shaped double of MemoryStore.transformMetadata: re-reads the
    // CURRENT row, lets the transform decide from it (null = healthy, skip),
    // and merge-patches instead of replacing wholesale. The default write
    // outcome mirrors the legacy update stub (null = nothing persisted) so
    // failure-accounting cells keep their meaning; success is opted into via
    // the same storeOverrides.update hook.
    async transformMetadata(id, transform, scopeFilter) {
      const current = rows.find((row) => row.id === id);
      if (!current) return { outcome: "missing", entry: null };
      const patch = transform(current);
      if (!patch) return { outcome: "unchanged", entry: current };
      const metadata = JSON.stringify({ ...parseObjectMetadata(current.metadata), ...patch });
      updateCalls.push({ id, patch: { metadata }, scopeFilter });
      if (overrideUpdate) {
        const outcome = await overrideUpdate(id, { metadata }, scopeFilter);
        return outcome == null
          ? { outcome: "missing", entry: null }
          : { outcome: "updated", entry: outcome };
      }
      return { outcome: "missing", entry: null };
    },
    ...restOverrides,
  });
  const captured = await captureRepairRun(program, extraArgs);
  return { updateCalls, ...captured };
}

describe("cli subcommand attachment", () => {
  it("only registers memory-pro on the root program; every other command lives under the group", () => {
    const program = buildRegisteredProgram();

    const rootNames = program.commands.map((c) => c.name());
    assert.deepEqual(
      rootNames,
      ["memory-pro"],
      `the root commander program must expose exactly one command (memory-pro); got: ${rootNames.join(", ")}`
    );
  });

  it("makes reindex-fts reachable as memory-pro reindex-fts", () => {
    const program = buildRegisteredProgram();
    const memoryPro = program.commands.find((c) => c.name() === "memory-pro");
    assert.ok(memoryPro, "memory-pro group must be registered");

    const groupNames = memoryPro.commands.map((c) => c.name());
    assert.ok(
      groupNames.includes("reindex-fts"),
      `expected "reindex-fts" under the memory-pro group, got: ${groupNames.join(", ")}`
    );
  });

  it("makes repair-summaries reachable as memory-pro repair-summaries", () => {
    const program = buildRegisteredProgram();
    const memoryPro = program.commands.find((c) => c.name() === "memory-pro");
    assert.ok(memoryPro, "memory-pro group must be registered");

    const groupNames = memoryPro.commands.map((c) => c.name());
    assert.ok(
      groupNames.includes("repair-summaries"),
      `expected "repair-summaries" under the memory-pro group, got: ${groupNames.join(", ")}`
    );
  });
});

describe("repair-summaries action safety", () => {
  const healthyRow = summaryRow({
    id: "healthy-1",
    text: "User said the standup moves to Tuesdays at 9am and asked me to remind the team every Monday evening.",
    l0: "Standup schedule: Tuesdays 9am",
    l1: "## Schedule\n- Standup moves to Tuesdays 9am\n- Reminder every Monday evening",
    l2: "The user moved the standup to Tuesdays at 9am and wants a reminder every Monday evening.",
  });
  const missingRow = summaryRow({ id: "missing-1", text: "synthetic note about the walnut shelf" });
  const degenerateRow = summaryRow({
    id: "degenerate-1",
    text: "synthetic note about the copper kettle",
    l0: "synthetic note about the copper kettle",
    l1: "synthetic note about the copper kettle",
    l2: "synthetic note about the copper kettle",
  });

  it("never flags a healthy generated summary, even though L0 differs from the text prefix", async () => {
    const { updateCalls, logs } = await runRepairSummaries([healthyRow], ["--apply"]);
    assert.equal(updateCalls.length, 0, "a concise generated abstract is not staleness; nothing may be overwritten");
    assert.match(logs, /No repairable summaries found/);
  });

  it("is report-only by default: repairable rows are listed but nothing is written without --apply", async () => {
    const { updateCalls, logs } = await runRepairSummaries([missingRow, degenerateRow]);
    assert.equal(updateCalls.length, 0, "mutation must be opt-in");
    assert.match(logs, /Found 2 repairable entries/);
    assert.match(logs, /Report only/);
    assert.match(logs, /--apply/);
  });

  it("repairs missing and degenerate summaries only when --apply is passed", async () => {
    const { updateCalls } = await runRepairSummaries([healthyRow, missingRow, degenerateRow], ["--apply"]);
    assert.deepEqual(updateCalls.map((call) => call.id).sort(), ["degenerate-1", "missing-1"]);
    for (const call of updateCalls) {
      const meta = JSON.parse(call.patch.metadata);
      assert.ok(meta.l0_abstract && meta.l1_overview && meta.l2_content, "repair must fill all three levels");
    }
  });

  it("keeps --dry-run as a report-only alias even when combined with --apply", async () => {
    const { updateCalls } = await runRepairSummaries([missingRow], ["--apply", "--dry-run"]);
    assert.equal(updateCalls.length, 0, "dry-run must always win");
  });

  it("excludes current reflection rows from the scan (all three schemas and the reflection category)", async () => {
    const reflectionRow = (id, type) => ({
      id,
      text: `synthetic reflection payload for ${id}`,
      category: "fact",
      scope: "agent:main",
      importance: 0.7,
      timestamp: Date.now(),
      metadata: JSON.stringify({ type }),
    });
    const categoryReflectionRow = {
      id: "reflection-category-1",
      text: "synthetic reflection with the reflection category",
      category: "reflection",
      scope: "agent:main",
      importance: 0.7,
      timestamp: Date.now(),
      metadata: "{}",
    };

    const { updateCalls, logs } = await runRepairSummaries([
      reflectionRow("reflection-plain-1", "memory-reflection"),
      reflectionRow("reflection-event-1", "memory-reflection-event"),
      reflectionRow("reflection-item-1", "memory-reflection-item"),
      reflectionRow("reflection-mapped-1", "memory-reflection-mapped"),
      categoryReflectionRow,
      missingRow,
    ], ["--apply"], {
      async update(id) {
        return { id };
      },
    });
    const updateIds = updateCalls.map((call) => call.id);

    assert.match(logs, /Found 1 repairable entries/);
    assert.deepEqual(updateIds, ["missing-1"], "only the non-reflection row may be repaired");
  });

  it("fills only the missing levels, preserving valid generated ones", async () => {
    const partialRow = summaryRow({
      id: "partial-1",
      text: "User asked for the synthetic walnut shelf to be repainted in matte blue next month.",
      l0: "Walnut shelf: repaint matte blue",
      l1: "## Task\n- Repaint the walnut shelf matte blue next month",
    });

    const { updateCalls, exitCode } = await runRepairSummaries([partialRow], ["--apply"], {
      async update(id) {
        return { id };
      },
    });

    assert.equal(updateCalls.length, 1);
    const meta = JSON.parse(updateCalls[0].patch.metadata);
    assert.equal(meta.l0_abstract, "Walnut shelf: repaint matte blue", "a valid generated L0 must survive the repair");
    assert.equal(meta.l1_overview, "## Task\n- Repaint the walnut shelf matte blue next month", "a valid generated L1 must survive the repair");
    assert.equal(meta.l2_content, partialRow.text, "only the missing L2 may be filled from the source text");
    assert.notEqual(exitCode, 1, "a fully successful repair must not set a failing exit code");
  });

  it("counts a null update return as failure and exits nonzero", async () => {
    const { logs, errors, exitCode } = await runRepairSummaries([missingRow], ["--apply"]);

    assert.match(logs, /0 fixed, 1 failed/);
    assert.match(errors, /update returned no entry/);
    assert.equal(exitCode, 1, "a repair that persisted nothing must not exit successfully");
  });

  it("counts a thrown update error as failure and exits nonzero", async () => {
    const { logs, errors, exitCode } = await runRepairSummaries([missingRow], ["--apply"], {
      async update() {
        throw new Error("synthetic update failure");
      },
    });

    assert.match(logs, /0 fixed, 1 failed/);
    assert.match(errors, /synthetic update failure/);
    assert.equal(exitCode, 1, "a repair that threw must not exit successfully");
  });

  it("keeps scanning when a row's metadata parses to JSON null instead of aborting the run", async () => {
    const nullMetaRow = {
      ...summaryRow({ id: "null-meta-1", text: "synthetic note about the birch bench" }),
      metadata: "null",
    };

    const { logs, errors, exitCalls } = await runRepairSummaries([nullMetaRow, missingRow]);

    assert.deepEqual(exitCalls, [], "one damaged row must not abort the whole scan");
    assert.doesNotMatch(errors, /repair-summaries failed/);
    assert.match(logs, /Found 2 repairable entries/, "the damaged row and every row after it must both be reported");
    assert.match(logs, /null-met/);
    assert.match(logs, /missing-/);
  });

  it("normalizes null, primitive, and array metadata to missing levels and repairs them under --apply", async () => {
    const nullMetaRow = {
      ...summaryRow({ id: "null-meta-2", text: "synthetic note about the birch bench" }),
      metadata: "null",
    };
    const numberMetaRow = {
      ...summaryRow({ id: "number-meta-1", text: "synthetic note about the slate coaster" }),
      metadata: "42",
    };
    const arrayMetaRow = {
      ...summaryRow({ id: "array-meta-1", text: "synthetic note about the wicker basket" }),
      metadata: '["synthetic"]',
    };

    const { updateCalls, exitCalls, exitCode } = await runRepairSummaries(
      [nullMetaRow, healthyRow, numberMetaRow, arrayMetaRow],
      ["--apply"],
      {
        async update(id) {
          return { id };
        },
      }
    );

    assert.deepEqual(exitCalls, []);
    assert.deepEqual(
      updateCalls.map((call) => call.id).sort(),
      ["array-meta-1", "null-meta-2", "number-meta-1"],
      "every damaged-metadata row is repairable; the healthy row stays untouched"
    );
    for (const call of updateCalls) {
      const meta = JSON.parse(call.patch.metadata);
      assert.ok(meta.l0_abstract && meta.l1_overview && meta.l2_content, "repair must rebuild all three levels from the source text");
    }
    assert.notEqual(exitCode, 1, "a fully successful repair pass must not set a failing exit code");
  });
});

describe("rebuildFtsIndex drop-failure propagation", () => {
  function makeFtsHarness({ dropError, indices, dropErrorOnCall } = {}) {
    const { MemoryStore } = jiti(path.join(testDir, "..", "src", "store.ts"));
    const calls = { created: 0, dropped: 0, droppedNames: [] };
    const self = {
      async ensureInitialized() {},
      async runWithWriteLock(fn) {
        return fn();
      },
      table: {
        async listIndices() {
          return indices ?? [{ indexType: "FTS", columns: ["text"], name: "text_idx" }];
        },
        async dropIndex(name) {
          calls.dropped += 1;
          calls.droppedNames.push(name);
          if (dropError) throw new Error(dropError);
          if (dropErrorOnCall && calls.dropped === dropErrorOnCall.call) {
            throw new Error(dropErrorOnCall.error);
          }
        },
      },
      async createFtsIndex() {
        calls.created += 1;
      },
      ftsIndexCreated: false,
      _lastFtsError: null,
    };
    return { rebuild: () => MemoryStore.prototype.rebuildFtsIndex.call(self), calls, self };
  }

  it("reports failure and skips creation when dropIndex throws (a surviving index is not a rebuild)", async () => {
    const { rebuild, calls, self } = makeFtsHarness({ dropError: "storage layer refused the drop" });
    const result = await rebuild();
    assert.equal(result.success, false, "a failed drop must fail the rebuild instead of reporting success");
    assert.match(result.error, /dropIndex\(text_idx\)/);
    assert.match(result.error, /storage layer refused the drop/);
    assert.equal(calls.created, 0, "creation must not run against a surviving index");
    assert.equal(self.ftsIndexCreated, false);
    assert.equal(self._lastFtsError, result.error);
  });

  it("still succeeds on the happy path (drop works, index recreated)", async () => {
    const { rebuild, calls } = makeFtsHarness();
    const result = await rebuild();
    assert.equal(result.success, true);
    assert.equal(calls.dropped, 1);
    assert.equal(calls.created, 1);
  });

  it("compensates a partial drop: a later drop failure recreates the index before the error propagates (two matching indexes)", async () => {
    const { rebuild, calls, self } = makeFtsHarness({
      indices: [
        { indexType: "FTS", columns: ["text"], name: "text_idx_a" },
        { indexType: "FTS", columns: ["text"], name: "text_idx_b" },
      ],
      dropErrorOnCall: { call: 2, error: "storage layer refused the second drop" },
    });
    const result = await rebuild();
    assert.equal(result.success, false, "a partial drop is still a failed rebuild");
    assert.match(result.error, /dropIndex\(text_idx_b\)/);
    assert.match(result.error, /storage layer refused the second drop/);
    assert.match(result.error, /recreated the FTS index/);
    assert.equal(
      calls.created,
      1,
      "an already-dropped index must be compensated by recreating the FTS index before returning",
    );
    assert.equal(self._lastFtsError, result.error);
  });

  it("stops dropping at the first failure instead of widening the damage", async () => {
    const { rebuild, calls } = makeFtsHarness({
      indices: [
        { indexType: "FTS", columns: ["text"], name: "text_idx_a" },
        { indexType: "FTS", columns: ["text"], name: "text_idx_b" },
      ],
      dropErrorOnCall: { call: 1, error: "storage layer refused the first drop" },
    });
    const result = await rebuild();
    assert.equal(result.success, false);
    assert.equal(calls.dropped, 1, "dropping must stop at the first failure; the second index must not be touched");
    assert.equal(calls.created, 0, "nothing was dropped, so there is nothing to compensate");
    assert.match(result.error, /dropIndex\(text_idx_a\)/);
  });
});

describe("repair-summaries applies atomically against concurrent writers (real store)", () => {
  it("preserves unrelated metadata written between scan and apply, and still repairs the levels", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { MemoryStore } = jiti(path.join(testDir, "..", "src", "store.ts"));
    const dir = mkdtempSync(path.join(tmpdir(), "repair-atomic-"));
    const store = new MemoryStore({ dbPath: dir, vectorDim: 3 });
    try {
      const seeded = await store.store({
        text: "synthetic note about the copper kettle",
        vector: [1, 0, 0],
        category: "preference",
        scope: "agent:main",
        importance: 0.7,
        metadata: JSON.stringify({
          l0_abstract: "synthetic note about the copper kettle",
          l1_overview: "synthetic note about the copper kettle",
          l2_content: "synthetic note about the copper kettle",
        }),
      });

      // The "running gateway": lands an unrelated metadata update AFTER the
      // scan snapshot is taken but BEFORE the apply loop reaches the row.
      const realList = store.list.bind(store);
      let injected = false;
      store.list = async (...args) => {
        const page = await realList(...args);
        if (!injected && page.length > 0) {
          injected = true;
          await store.patchMetadata(seeded.id, { bad_recall_count: 7 });
        }
        return page;
      };

      const program = buildRegisteredProgram(store);
      const { logs } = await captureRepairRun(program, ["--apply"]);
      store.list = realList;

      assert.ok(injected, "the concurrent write must have landed between scan and apply");
      assert.match(logs, /1 fixed/);

      const after = await store.getById(seeded.id);
      const meta = JSON.parse(after.metadata);
      assert.equal(
        meta.bad_recall_count,
        7,
        "an unrelated concurrent metadata update must survive the repair, not be reverted from the scan snapshot",
      );
      assert.notEqual(meta.l1_overview, meta.l0_abstract, "the degenerate levels must still be repaired");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips a row the gateway healed between scan and apply instead of rewriting it", async () => {
    const healed = summaryRow({
      id: "healed-1",
      text: "synthetic note about the walnut shelf",
    });
    const rows = [healed];
    const { updateCalls, logs } = await runRepairSummaries(rows, ["--apply"], {
      async list(scopeFilter, category, limit = 200, offset = 0) {
        // The scan gets a SNAPSHOT (copies, like a real paginated read);
        // the live row is then healed, so it is healthy by apply time.
        const page = rows.slice(offset, offset + limit).map((row) => ({ ...row }));
        if (page.length > 0) {
          healed.metadata = JSON.stringify({
            l0_abstract: "Walnut shelf note",
            l1_overview: "## Note\n- walnut shelf",
            l2_content: "A synthetic note about the walnut shelf.",
          });
        }
        return page;
      },
    });

    assert.equal(updateCalls.length, 0, "a row that is healthy at apply time must not be rewritten");
    assert.match(logs, /1 skipped/);
    assert.match(logs, /0 fixed, 0 failed/);
  });
});

describe("transformMetadata storage semantics (real store)", () => {
  it("reads the latest table version under the write lock instead of a stale snapshot", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { MemoryStore } = jiti(path.join(testDir, "..", "src", "store.ts"));
    const dir = mkdtempSync(path.join(tmpdir(), "transform-stale-read-"));
    try {
      const writer = new MemoryStore({ dbPath: dir, vectorDim: 3 });
      const seeded = await writer.store({
        text: "synthetic row for the stale-read regression",
        vector: [1, 0, 0],
        category: "preference",
        scope: "agent:agent-one",
        importance: 0.7,
        metadata: JSON.stringify({ l0_abstract: "old", bad_recall_count: 0 }),
      });

      // The repair connection opens and pins its table view BEFORE the
      // counter write lands through the other connection (default read
      // consistency keeps serving that pinned snapshot).
      const repairer = new MemoryStore({ dbPath: dir, vectorDim: 3 });
      assert.ok(await repairer.getById(seeded.id), "repairer primed its pinned view");

      await writer.transformMetadata(seeded.id, () => ({ bad_recall_count: 7 }));

      const result = await repairer.transformMetadata(seeded.id, () => ({ l0_abstract: "repaired" }));
      assert.equal(result.outcome, "updated");

      const finalRow = await new MemoryStore({ dbPath: dir, vectorDim: 3 }).getById(seeded.id);
      const meta = JSON.parse(finalRow.metadata);
      assert.equal(meta.l0_abstract, "repaired", "the repair itself must land");
      assert.equal(
        meta.bad_recall_count,
        7,
        "a counter written by another connection between scan and apply must survive the repair",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("merges only the callback's explicit keys and keeps repaired legacy rows upgrader-eligible", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { MemoryStore } = jiti(path.join(testDir, "..", "src", "store.ts"));
    const dir = mkdtempSync(path.join(tmpdir(), "transform-legacy-shape-"));
    try {
      const store = new MemoryStore({ dbPath: dir, vectorDim: 3 });
      const seeded = await store.store({
        text: "legacy imported note without smart metadata",
        vector: [0, 1, 0],
        category: "fact",
        scope: "agent:agent-one",
        importance: 0.5,
        metadata: JSON.stringify({ origin: "import", note_kind: "legacy" }),
      });

      const result = await store.transformMetadata(seeded.id, () => ({
        l0_abstract: "legacy imported note without smart metadata",
        l1_overview: "- legacy imported note without smart metadata",
        l2_content: "legacy imported note without smart metadata",
      }));
      assert.equal(result.outcome, "updated");

      const meta = JSON.parse((await store.getById(seeded.id)).metadata);
      assert.deepEqual(
        Object.keys(meta).sort(),
        ["l0_abstract", "l1_overview", "l2_content", "note_kind", "origin"],
        "only the callback's explicit keys may be added; nothing else materializes",
      );
      assert.equal(meta.origin, "import", "unrelated fields survive verbatim");
      assert.ok(
        !("memory_category" in meta),
        "a repaired legacy row must not gain memory_category, or MemoryUpgrader stops treating it as legacy",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
