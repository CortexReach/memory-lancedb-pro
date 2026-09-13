// test/invalidated-rows-visibility.test.mjs
//
// Item 6 (PR #946 fix round): caller-level coverage for the store-layer
// excludeInactive default (test/store-excludeinactive-default.test.mjs
// covers the store.ts choke point itself). This file covers the CLI and
// tools.ts consumers that need explicit opt-in/opt-out wiring on top of
// the new default: CLI export/list/obsidian, and the memory_list/
// memory_debug/memory_compact tools.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";
import { Command } from "commander";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

function makeStore(prefix, vectorDim = 4) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const { MemoryStore } = jiti("../src/store.ts");
  return { store: new MemoryStore({ dbPath: dir, vectorDim }), dir };
}

async function storeLiveAndInvalidatedPair(store) {
  const live = await store.store({
    text: "Live fact: user likes cola",
    vector: [1, 0, 0, 0],
    category: "preference",
    scope: "test",
    importance: 0.7,
    metadata: JSON.stringify({
      l0_abstract: "Live fact: user likes cola",
      memory_category: "preferences",
      valid_from: Date.now() - 10_000,
    }),
  });

  const dead = await store.store({
    text: "Dead fact: user liked tea (superseded)",
    vector: [1, 0, 0, 0],
    category: "preference",
    scope: "test",
    importance: 0.7,
    metadata: JSON.stringify({
      l0_abstract: "Dead fact: user liked tea (superseded)",
      memory_category: "preferences",
      valid_from: Date.now() - 20_000,
    }),
  });

  await store.update(dead.id, {
    metadata: JSON.stringify({
      l0_abstract: "Dead fact: user liked tea (superseded)",
      memory_category: "preferences",
      valid_from: Date.now() - 20_000,
      invalidated_at: Date.now() - 5_000,
      superseded_by: live.id,
    }),
  });

  return { live, dead };
}

describe("item 6: CLI export/list/obsidian invalidated-row visibility", () => {
  it("export includes invalidated rows by default (backup/export exception)", async () => {
    const { store, dir } = makeStore("item6-export-");
    try {
      const { live, dead } = await storeLiveAndInvalidatedPair(store);
      const { createMemoryCLI } = jiti("../cli.ts");

      const outFile = join(dir, "export.json");
      const context = { store, retriever: {}, scopeManager: {}, migrator: {} };
      const program = new Command();
      program.exitOverride();
      createMemoryCLI(context)({ program });

      await program.parseAsync([
        "node", "openclaw", "memory-pro", "export", "--scope", "test", "--output", outFile,
      ]);

      const exported = JSON.parse(readFileSync(outFile, "utf8"));
      const ids = exported.memories.map((m) => m.id);
      assert.ok(ids.includes(live.id), "export must include the live row");
      assert.ok(ids.includes(dead.id), "export must include the invalidated row (backup semantics)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("list excludes invalidated rows by default", async () => {
    const { store, dir } = makeStore("item6-list-");
    try {
      const { live, dead } = await storeLiveAndInvalidatedPair(store);
      const { createMemoryCLI } = jiti("../cli.ts");

      const context = { store, retriever: {}, scopeManager: {}, migrator: {} };
      const program = new Command();
      program.exitOverride();
      createMemoryCLI(context)({ program });

      // list --json writes via process.stdout.write (writeJson/writeStdout),
      // not console.log, and pretty-prints (JSON.stringify(obj, null, 2)) --
      // capture the raw stdout chunks instead of console.log lines.
      const chunks = [];
      const originalWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk) => {
        chunks.push(String(chunk));
        return true;
      };

      try {
        await program.parseAsync(["node", "openclaw", "memory-pro", "list", "--scope", "test", "--json"]);
      } finally {
        process.stdout.write = originalWrite;
      }

      const listed = JSON.parse(chunks.join(""));
      const ids = listed.map((m) => m.id);
      assert.ok(ids.includes(live.id), "list must include the live row");
      assert.ok(!ids.includes(dead.id), "list must exclude the invalidated row by default");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("list --include-invalidated surfaces both rows", async () => {
    const { store, dir } = makeStore("item6-list-optin-");
    try {
      const { live, dead } = await storeLiveAndInvalidatedPair(store);
      const { createMemoryCLI } = jiti("../cli.ts");

      const context = { store, retriever: {}, scopeManager: {}, migrator: {} };
      const program = new Command();
      program.exitOverride();
      createMemoryCLI(context)({ program });

      const chunks = [];
      const originalWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk) => {
        chunks.push(String(chunk));
        return true;
      };

      try {
        await program.parseAsync([
          "node", "openclaw", "memory-pro", "list", "--scope", "test", "--json", "--include-invalidated",
        ]);
      } finally {
        process.stdout.write = originalWrite;
      }

      const listed = JSON.parse(chunks.join(""));
      const ids = listed.map((m) => m.id);
      assert.ok(ids.includes(live.id));
      assert.ok(ids.includes(dead.id), "--include-invalidated must surface the invalidated row");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("obsidian excludes invalidated rows by default and surfaces them with --include-invalidated", async () => {
    const { store, dir } = makeStore("item6-obsidian-");
    try {
      const { live, dead } = await storeLiveAndInvalidatedPair(store);
      const { createMemoryCLI } = jiti("../cli.ts");
      const vaultDefault = join(dir, "vault-default");
      const vaultOptIn = join(dir, "vault-optin");

      const context = { store, retriever: {}, scopeManager: {}, migrator: {} };

      const programDefault = new Command();
      programDefault.exitOverride();
      createMemoryCLI(context)({ program: programDefault });
      await programDefault.parseAsync([
        "node", "openclaw", "memory-pro", "sync", "obsidian", "--vault", vaultDefault, "--scope", "test",
      ]);

      const programOptIn = new Command();
      programOptIn.exitOverride();
      createMemoryCLI(context)({ program: programOptIn });
      await programOptIn.parseAsync([
        "node", "openclaw", "memory-pro", "sync", "obsidian", "--vault", vaultOptIn, "--scope", "test", "--include-invalidated",
      ]);

      const fs = await import("node:fs");
      function listNoteBasenames(vaultPath) {
        const root = join(vaultPath, "00-AI-Memory");
        const files = [];
        for (const catDir of fs.readdirSync(root)) {
          const catPath = join(root, catDir);
          if (!fs.statSync(catPath).isDirectory()) continue;
          for (const f of fs.readdirSync(catPath)) files.push(f);
        }
        return files;
      }

      const defaultNotes = listNoteBasenames(vaultDefault);
      const optInNotes = listNoteBasenames(vaultOptIn);

      const liveShortId = live.id.slice(0, 12);
      const deadShortId = dead.id.slice(0, 12);

      assert.ok(defaultNotes.some((f) => f.includes(liveShortId)), "default vault must contain the live note");
      assert.ok(!defaultNotes.some((f) => f.includes(deadShortId)), "default vault must NOT contain the invalidated note");

      assert.ok(optInNotes.some((f) => f.includes(liveShortId)));
      assert.ok(optInNotes.some((f) => f.includes(deadShortId)), "--include-invalidated vault must contain the invalidated note");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // NOTE: CLI search already excludes invalidated rows by default (it
  // routes through retriever.ts, which hardcodes { excludeInactive: true }
  // on every vectorSearch/bm25Search call) -- covered below. A --include-
  // invalidated opt-in for search specifically (mirroring list/obsidian) is
  // PUNTED for this round: it would require threading a new option through
  // retriever.ts's private vectorOnlyRetrieval/hybridRetrieval/
  // bm25OnlyRetrieval helper chain, which is materially higher-risk (the
  // primary recall/prompt-injection path) for a forensic-only nice-to-have
  // that isn't in item 6's required acceptance list.
  it("CLI search excludes invalidated rows by default (already correct; no code change needed)", async () => {
    const { store, dir } = makeStore("item6-search-");
    try {
      const { live, dead } = await storeLiveAndInvalidatedPair(store);
      const { createRetriever } = jiti("../src/retriever.ts");
      const { createMemoryCLI } = jiti("../cli.ts");

      const fakeEmbedder = {
        embedQuery: async () => [1, 0, 0, 0],
        embedPassage: async () => [1, 0, 0, 0],
      };
      const retriever = createRetriever(store, fakeEmbedder, { minScore: 0 });

      const context = { store, retriever, scopeManager: {}, migrator: {}, embedder: fakeEmbedder };

      const chunks = [];
      const originalWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk) => {
        chunks.push(String(chunk));
        return true;
      };

      const program = new Command();
      program.exitOverride();
      createMemoryCLI(context)({ program });
      try {
        await program.parseAsync([
          "node", "openclaw", "memory-pro", "search", "cola", "--scope", "test", "--json",
        ]);
      } finally {
        process.stdout.write = originalWrite;
      }
      const results = JSON.parse(chunks.join(""));
      const ids = results.map((r) => r.entry?.id ?? r.id);
      assert.ok(ids.includes(live.id), "search must include the live row by default");
      assert.ok(!ids.includes(dead.id), "search must exclude the invalidated row by default");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("item 6: memory_list / memory_compact tool visibility", () => {
  function scopeManagerFor(scope) {
    return {
      getAccessibleScopes: () => [scope],
      getScopeFilter: () => [scope],
      isAccessible: (s) => s === scope,
      getDefaultScope: () => scope,
    };
  }

  function toolFactory(store, scope) {
    const { registerAllMemoryTools } = jiti("../src/tools.ts");
    const creators = new Map();
    const api = {
      registerTool(factory, meta) {
        creators.set(meta.name, factory);
      },
      logger: { info() {}, warn() {}, debug() {} },
    };
    const context = {
      agentId: "main",
      store,
      scopeManager: scopeManagerFor(scope),
      retriever: {},
      embedder: { async embedPassage() { return [1, 0, 0, 0]; } },
    };
    registerAllMemoryTools(api, context, { enableManagementTools: true });
    return {
      get(name) {
        const factory = creators.get(name);
        assert.ok(factory, `tool ${name} should be registered`);
        return factory({});
      },
    };
  }

  it("memory_list excludes invalidated rows by default and surfaces them with includeInvalidated", async () => {
    const { store, dir } = makeStore("item6-tool-list-");
    try {
      const { live, dead } = await storeLiveAndInvalidatedPair(store);
      const tools = toolFactory(store, "test");
      const memoryList = tools.get("memory_list");

      const defaultResult = await memoryList.execute("call-1", { scope: "test", limit: 50 }, undefined, undefined, {});
      const defaultIds = defaultResult.details.memories.map((m) => m.id);
      assert.ok(defaultIds.includes(live.id), "memory_list must include the live row by default");
      assert.ok(!defaultIds.includes(dead.id), "memory_list must exclude the invalidated row by default");

      const optInResult = await memoryList.execute(
        "call-2",
        { scope: "test", limit: 50, includeInvalidated: true },
        undefined,
        undefined,
        {},
      );
      const optInIds = optInResult.details.memories.map((m) => m.id);
      assert.ok(optInIds.includes(live.id));
      assert.ok(optInIds.includes(dead.id), "includeInvalidated:true must surface the invalidated row");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("memory_compact scans only live rows by default and includes invalidated rows with includeInvalidated", async () => {
    const { store, dir } = makeStore("item6-tool-compact-");
    try {
      const { live, dead } = await storeLiveAndInvalidatedPair(store);
      const tools = toolFactory(store, "test");
      const memoryCompact = tools.get("memory_compact");

      const defaultResult = await memoryCompact.execute(
        "call-1",
        { scope: "test", dryRun: true, limit: 200 },
        undefined,
        undefined,
        {},
      );
      assert.equal(defaultResult.details.scanned, 1, "memory_compact must scan only the live row by default");

      const optInResult = await memoryCompact.execute(
        "call-2",
        { scope: "test", dryRun: true, limit: 200, includeInvalidated: true },
        undefined,
        undefined,
        {},
      );
      assert.equal(optInResult.details.scanned, 2, "includeInvalidated:true must scan both rows");
      void live;
      void dead;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("item 6: admission-control novelty gate scores against live rows only", () => {
  it("loadRelevantMatches (via evaluate()) never compares the candidate against an invalidated row", async () => {
    const { store, dir } = makeStore("item6-admission-");
    try {
      const { live, dead } = await storeLiveAndInvalidatedPair(store);
      const { AdmissionController, DEFAULT_ADMISSION_CONTROL_CONFIG } = jiti("../src/admission-control.ts");

      const fakeLlm = {
        async completeJson() {
          return { utility: 0.5, reason: "test stub" };
        },
        getLastError() {
          return null;
        },
      };

      const controller = new AdmissionController(store, fakeLlm, DEFAULT_ADMISSION_CONTROL_CONFIG);

      const evaluation = await controller.evaluate({
        candidate: {
          category: "preferences",
          abstract: "User likes cola",
          overview: "",
          content: "User likes cola",
        },
        candidateVector: [1, 0, 0, 0],
        conversationText: "User: I like cola.",
        scopeFilter: ["test"],
      });

      const comparedIds = evaluation.audit.compared_existing_memory_ids || [];
      assert.ok(comparedIds.includes(live.id), "novelty scoring must compare against the live row");
      assert.ok(
        !comparedIds.includes(dead.id),
        "novelty scoring must NOT compare against the invalidated row (item 6)",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
