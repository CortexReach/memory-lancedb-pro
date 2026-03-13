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

const {
  registerMemoryRecallTool,
  registerMemoryStatsTool,
  registerMemoryListTool,
} = jiti("../src/tools.ts");

function createHarness(context) {
  const factories = new Map();
  const api = {
    registerTool(factory, meta) {
      factories.set(meta?.name || "", factory);
    },
  };

  registerMemoryRecallTool(api, context);
  registerMemoryStatsTool(api, context);
  registerMemoryListTool(api, context);

  return {
    tool(name, toolCtx = {}) {
      const factory = factories.get(name);
      assert.ok(factory, `tool not registered: ${name}`);
      return factory(toolCtx);
    },
  };
}

describe("tool scope fallback", () => {
  it("uses toolCtx agentId when runtimeCtx omits agent context", async () => {
    const scopeManager = {
      getAccessibleScopes(agentId) {
        return agentId ? ["global", `agent:${agentId}`] : ["global"];
      },
      isAccessible(scope, agentId) {
        return this.getAccessibleScopes(agentId).includes(scope);
      },
      getStats() {
        return {
          totalScopes: 1,
          agentsWithCustomAccess: 0,
          scopesByType: {
            global: 1,
            agent: 0,
            custom: 0,
            project: 0,
            user: 0,
            other: 0,
          },
        };
      },
    };

    const context = {
      retriever: {
        async retrieve(params) {
          assert.deepEqual(params.scopeFilter, ["global", "agent:main"]);
          return [
            {
              entry: {
                id: "fact-1",
                text: "Main agent fact memory",
                category: "fact",
                scope: "agent:main",
                importance: 0.7,
                timestamp: 101,
                metadata: "{}",
              },
              score: 0.91,
              sources: ["vector"],
            },
          ];
        },
        getConfig() {
          return { mode: "hybrid", rerankApiKey: undefined };
        },
      },
      store: {
        dbPath: "/tmp/memory-tool-scope-context",
        hasFtsSupport: true,
        async stats(scopeFilter) {
          assert.deepEqual(scopeFilter, ["global", "agent:main"]);
          return {
            totalCount: 2,
            scopeCounts: { global: 1, "agent:main": 1 },
            categoryCounts: { fact: 1, preference: 1 },
          };
        },
        async list(scopeFilter) {
          assert.deepEqual(scopeFilter, ["global", "agent:main"]);
          return [
            {
              id: "pref-1",
              text: "Main agent preference memory",
              category: "preference",
              scope: "agent:main",
              importance: 0.8,
              timestamp: 100,
              metadata: "{}",
            },
          ];
        },
        async patchMetadata() {
          return true;
        },
      },
      scopeManager,
      embedder: {},
      admissionControl: {
        enabled: false,
      },
    };

    const harness = createHarness(context);

    const statsTool = harness.tool("memory_stats", { agentId: "main" });
    const statsResult = await statsTool.execute("tc-1", {}, {}, {}, {});
    assert.equal(statsResult.details.resolvedAgentId, "main");
    assert.deepEqual(statsResult.details.scopeFilter, ["global", "agent:main"]);
    assert.match(statsResult.content[0].text, /Queried scopes: 2/);
    assert.match(statsResult.content[0].text, /Configured scope definitions: 1/);

    const recallTool = harness.tool("memory_recall", { agentId: "main" });
    const recallResult = await recallTool.execute("tc-0", { query: "main workflow" }, {}, {}, {});
    assert.equal(recallResult.details.resolvedAgentId, "main");
    assert.deepEqual(recallResult.details.scopes, ["global", "agent:main"]);
    assert.equal(recallResult.details.memories[0].scope, "agent:main");

    const listTool = harness.tool("memory_list", { agentId: "main" });
    const listResult = await listTool.execute("tc-2", { limit: 5 }, {}, {}, {});
    assert.equal(listResult.details.resolvedAgentId, "main");
    assert.deepEqual(listResult.details.scopeFilter, ["global", "agent:main"]);
    assert.equal(listResult.details.memories[0].scope, "agent:main");
  });
});
