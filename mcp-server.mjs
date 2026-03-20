#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import {
  invokeRegisteredTool,
  getRuntimePromise,
  OPENCLAW_CONFIG_PATH,
} from "./host-runtime.mjs";

const server = new McpServer({
  name: "memory-lancedb-pro",
  version: "1.1.0-beta.9",
});

const agentIdField = {
  agent_id: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Optional agent identity used for scoped memory access. Defaults to 'main'."),
};

server.registerTool(
  "memory_recall",
  {
    description:
      "Search the shared LanceDB long-term memory used by OpenClaw. Use this before answering when past preferences, facts, or decisions may matter.",
    inputSchema: {
      query: z.string().min(1).describe("Search query"),
      limit: z.number().int().min(1).max(20).optional(),
      scope: z.string().trim().min(1).optional(),
      category: z
        .enum(["preference", "fact", "decision", "entity", "reflection", "other"])
        .optional(),
      ...agentIdField,
    },
  },
  async ({ agent_id, ...args }) => invokeRegisteredTool("memory_recall", args, agent_id),
);

server.registerTool(
  "memory_store",
  {
    description:
      "Store stable information into the shared LanceDB long-term memory used by OpenClaw, Claude, and Codex.",
    inputSchema: {
      text: z.string().min(1).describe("Information to remember"),
      importance: z.number().min(0).max(1).optional(),
      category: z
        .enum(["preference", "fact", "decision", "entity", "other"])
        .optional(),
      scope: z.string().trim().min(1).optional(),
      ...agentIdField,
    },
  },
  async ({ agent_id, ...args }) => invokeRegisteredTool("memory_store", args, agent_id),
);

server.registerTool(
  "memory_update",
  {
    description: "Update an existing memory by ID or an ID prefix.",
    inputSchema: {
      memoryId: z.string().min(1).describe("Memory ID or ID prefix"),
      text: z.string().min(1).optional(),
      importance: z.number().min(0).max(1).optional(),
      category: z
        .enum(["preference", "fact", "decision", "entity", "reflection", "other"])
        .optional(),
      ...agentIdField,
    },
  },
  async ({ agent_id, ...args }) => invokeRegisteredTool("memory_update", args, agent_id),
);

server.registerTool(
  "memory_forget",
  {
    description: "Delete a memory by ID, ID prefix, or search query.",
    inputSchema: {
      query: z.string().min(1).optional(),
      memoryId: z.string().min(1).optional(),
      scope: z.string().trim().min(1).optional(),
      ...agentIdField,
    },
  },
  async ({ agent_id, ...args }) => invokeRegisteredTool("memory_forget", args, agent_id),
);

server.registerTool(
  "memory_list",
  {
    description: "List recent memories with optional filters.",
    inputSchema: {
      limit: z.number().int().min(1).max(50).optional(),
      offset: z.number().int().min(0).max(1000).optional(),
      scope: z.string().trim().min(1).optional(),
      category: z
        .enum(["preference", "fact", "decision", "entity", "reflection", "other"])
        .optional(),
      ...agentIdField,
    },
  },
  async ({ agent_id, ...args }) => invokeRegisteredTool("memory_list", args, agent_id),
);

server.registerTool(
  "memory_stats",
  {
    description: "Show shared memory database statistics.",
    inputSchema: {
      ...agentIdField,
    },
  },
  async ({ agent_id, ..._args }) => invokeRegisteredTool("memory_stats", {}, agent_id),
);

async function main() {
  await getRuntimePromise();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `memory-lancedb-pro MCP server ready (config=${OPENCLAW_CONFIG_PATH})`,
  );
}

main().catch((error) => {
  console.error("memory-lancedb-pro MCP server failed:", error);
  process.exit(1);
});
