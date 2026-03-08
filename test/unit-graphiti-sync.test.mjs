import assert from "node:assert/strict";
import test from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { createGraphitiSyncService } = jiti("../src/graphiti/sync.ts");

test("graphiti sync service mirrors memory and updates metadata", async () => {
  const updates = [];
  const service = createGraphitiSyncService({
    bridge: {
      addEpisode: async () => ({
        status: "stored",
        groupId: "global",
        episodeRef: "ep-123",
      }),
    },
    config: {
      enabled: true,
      baseUrl: "http://localhost:8000",
      transport: "mcp",
      groupIdMode: "scope",
      timeoutMs: 1000,
      failOpen: true,
      write: {
        memoryStore: true,
        autoCapture: false,
        sessionSummary: false,
      },
      read: {
        enableGraphRecallTool: true,
        augmentMemoryRecall: false,
        topKNodes: 6,
        topKFacts: 10,
      },
    },
    store: {
      update: async (id, patch, scopes) => {
        updates.push({ id, patch, scopes });
        return null;
      },
    },
    logger: {},
  });

  const result = await service.syncMemory(
    {
      id: "m-1",
      text: "Alice likes tea",
      scope: "global",
      category: "fact",
      metadata: "{}",
    },
    {
      mode: "memoryStore",
      source: "memory_store",
      mutation: "memory_store",
    },
  );

  assert.equal(result?.status, "stored");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, "m-1");
  assert.deepEqual(updates[0].scopes, ["global"]);
  assert.match(updates[0].patch.metadata, /"groupId":"global"/);
  assert.match(updates[0].patch.metadata, /"lastMutation":"memory_store"/);
});

test("graphiti sync service respects disabled write mode", async () => {
  let called = false;
  const service = createGraphitiSyncService({
    bridge: {
      addEpisode: async () => {
        called = true;
        return { status: "stored", groupId: "global" };
      },
    },
    config: {
      enabled: true,
      baseUrl: "http://localhost:8000",
      transport: "mcp",
      groupIdMode: "scope",
      timeoutMs: 1000,
      failOpen: true,
      write: {
        memoryStore: true,
        autoCapture: false,
        sessionSummary: false,
      },
      read: {
        enableGraphRecallTool: true,
        augmentMemoryRecall: false,
        topKNodes: 6,
        topKFacts: 10,
      },
    },
    store: {
      update: async () => null,
    },
  });

  const result = await service.syncMemory(
    {
      id: "m-2",
      text: "capture text",
      scope: "global",
    },
    {
      mode: "autoCapture",
      source: "agent_end",
    },
  );

  assert.equal(result, undefined);
  assert.equal(called, false);
});
