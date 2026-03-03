import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { registerMemoryGraphRecallTool } = jiti("../src/tools-graphiti.ts");
const { createGraphitiBridge } = jiti("../src/graphiti/bridge.ts");

async function testGraphRecallToolDisabled() {
  const registrations = [];
  const api = {
    registerTool(factory, meta) {
      registrations.push({ factory, meta });
    },
  };

  registerMemoryGraphRecallTool(api, {
    scopeManager: {
      getDefaultScope: () => "global",
      isAccessible: () => true,
    },
    graphitiBridge: undefined,
  });

  assert.equal(registrations.length, 1);
  const tool = registrations[0].factory({ agentId: "main" });
  const result = await tool.execute("id-1", { query: "hello" });
  assert.equal(result.details.error, "graphiti_disabled");
}

async function testGraphRecallToolScopeAccess() {
  const registrations = [];
  const api = {
    registerTool(factory, meta) {
      registrations.push({ factory, meta });
    },
  };

  registerMemoryGraphRecallTool(api, {
    scopeManager: {
      getDefaultScope: () => "global",
      isAccessible: (scope) => scope === "global",
    },
    graphitiBridge: {
      recall: async () => ({
        groupId: "global",
        nodes: [],
        facts: [],
      }),
    },
  });

  const tool = registrations[0].factory({ agentId: "main" });
  const denied = await tool.execute("id-2", {
    query: "anything",
    scope: "project:secret",
  });
  assert.equal(denied.details.error, "scope_access_denied");
}

async function testGraphRecallToolSuccess() {
  const registrations = [];
  const api = {
    registerTool(factory, meta) {
      registrations.push({ factory, meta });
    },
  };

  registerMemoryGraphRecallTool(api, {
    scopeManager: {
      getDefaultScope: () => "global",
      isAccessible: () => true,
    },
    graphitiBridge: {
      recall: async () => ({
        groupId: "global",
        nodes: [{ label: "Alice", score: 0.9 }],
        facts: [{ text: "Alice likes tea", score: 0.8 }],
      }),
    },
  });

  const tool = registrations[0].factory({ agentId: "main" });
  const ok = await tool.execute("id-3", { query: "Alice preference" });
  assert.match(ok.content[0].text, /Nodes:/);
  assert.equal(ok.details.nodes.length, 1);
  assert.equal(ok.details.facts.length, 1);
}

async function testGraphitiBridgeFailOpen() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network down");
  };

  try {
    const bridge = createGraphitiBridge({
      config: {
        enabled: true,
        baseUrl: "http://127.0.0.1:18000",
        transport: "mcp",
        groupIdMode: "scope",
        timeoutMs: 100,
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
    });

    const result = await bridge.addEpisode({
      text: "hello graphiti",
      scope: "global",
    });

    assert.equal(result.status, "failed");
    assert.equal(result.groupId, "global");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testGraphitiBridgeDisabled() {
  const bridge = createGraphitiBridge({
    config: {
      enabled: false,
      baseUrl: "http://127.0.0.1:18000",
      transport: "mcp",
      groupIdMode: "scope",
      timeoutMs: 100,
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
  });

  const result = await bridge.addEpisode({
    text: "not sent",
    scope: "global",
  });
  assert.equal(result.status, "skipped");
  assert.equal(result.groupId, "global");
}

async function run() {
  await testGraphRecallToolDisabled();
  await testGraphRecallToolScopeAccess();
  await testGraphRecallToolSuccess();
  await testGraphitiBridgeFailOpen();
  await testGraphitiBridgeDisabled();
  console.log("OK: Graphiti smoke tests passed");
}

run().catch((err) => {
  console.error("FAIL: Graphiti smoke tests failed");
  console.error(err);
  process.exit(1);
});
