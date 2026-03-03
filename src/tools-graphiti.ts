import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { MemoryScopeManager } from "./scopes.js";
import type { GraphitiBridge } from "./graphiti/bridge.js";

interface LoggerLike {
  warn?: (message: string) => void;
}

interface GraphRecallToolContext {
  scopeManager: MemoryScopeManager;
  graphitiBridge?: GraphitiBridge;
  logger?: LoggerLike;
  agentId?: string;
}

interface RuntimeToolContext {
  agentId?: string;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function resolveToolContext(
  baseContext: GraphRecallToolContext,
  runtimeContext: RuntimeToolContext,
): GraphRecallToolContext {
  return {
    ...baseContext,
    agentId: runtimeContext.agentId,
  };
}

export function registerMemoryGraphRecallTool(
  api: OpenClawPluginApi,
  baseContext: GraphRecallToolContext,
): void {
  api.registerTool(
    (runtimeContext) => {
      const context = resolveToolContext(baseContext, runtimeContext);
      return {
        name: "memory_graph_recall",
        label: "Memory Graph Recall",
        description: "Query graph-based facts/entities mirrored into Graphiti by memory scope.",
        parameters: Type.Object({
          query: Type.String({ description: "Natural language query for graph recall" }),
          scope: Type.Optional(Type.String({ description: "Optional scope override (defaults to agent scope)" })),
          limitNodes: Type.Optional(Type.Number({ description: "Max graph nodes to return (default 6, max 30)" })),
          limitFacts: Type.Optional(Type.Number({ description: "Max graph facts to return (default 10, max 30)" })),
        }),
        async execute(_toolCallId, params) {
          const { query, scope, limitNodes = 6, limitFacts = 10 } = params as {
            query: string;
            scope?: string;
            limitNodes?: number;
            limitFacts?: number;
          };

          if (!context.graphitiBridge) {
            return {
              content: [{ type: "text", text: "Graphiti recall is disabled." }],
              details: { error: "graphiti_disabled" },
            };
          }

          try {
            const targetScope = scope || context.scopeManager.getDefaultScope(context.agentId);
            if (!context.scopeManager.isAccessible(targetScope, context.agentId)) {
              return {
                content: [{ type: "text", text: `Access denied to scope: ${targetScope}` }],
                details: { error: "scope_access_denied", requestedScope: targetScope },
              };
            }

            const result = await context.graphitiBridge.recall({
              query,
              scope: targetScope,
              limitNodes: clampInt(limitNodes, 1, 30),
              limitFacts: clampInt(limitFacts, 1, 30),
            });

            const nodeLines = result.nodes.length
              ? result.nodes.map((node, index) => `${index + 1}. ${node.label}`).join("\n")
              : "none";
            const factLines = result.facts.length
              ? result.facts.map((fact, index) => `${index + 1}. ${fact.text}`).join("\n")
              : "none";

            return {
              content: [
                {
                  type: "text",
                  text:
                    `Graph recall for scope "${targetScope}" (group_id="${result.groupId}")\n\n` +
                    `Nodes:\n${nodeLines}\n\n` +
                    `Facts:\n${factLines}`,
                },
              ],
              details: {
                groupId: result.groupId,
                scope: targetScope,
                query,
                nodes: result.nodes,
                facts: result.facts,
              },
            };
          } catch (err) {
            context.logger?.warn?.(`memory-lancedb-pro: memory_graph_recall failed: ${String(err)}`);
            return {
              content: [{ type: "text", text: `Graph recall failed: ${String(err)}` }],
              details: { error: "graph_recall_failed", message: String(err) },
            };
          }
        },
      };
    },
    { name: "memory_graph_recall" },
  );
}
