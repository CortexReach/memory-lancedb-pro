import { GraphitiMcpClient } from "./mcp.js";
import type {
  GraphitiEpisodeInput,
  GraphitiEpisodeResult,
  GraphitiFactResult,
  GraphitiNodeResult,
  GraphitiPluginConfig,
  GraphitiRecallInput,
  GraphitiRecallResult,
} from "./types.js";

interface LoggerLike {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  debug?: (message: string) => void;
}

interface GraphitiBridgeOptions {
  config: GraphitiPluginConfig;
  logger?: LoggerLike;
}

const ADD_EPISODE_TOOL_CANDIDATES = ["add_episode", "graphiti_add_episode"];
const SEARCH_NODES_TOOL_CANDIDATES = ["search_nodes", "graphiti_search_nodes"];
const SEARCH_FACTS_TOOL_CANDIDATES = ["search_facts", "graphiti_search_facts"];

export class GraphitiBridge {
  private readonly client: GraphitiMcpClient;
  private knownTools = new Set<string>();

  constructor(
    private readonly config: GraphitiPluginConfig,
    private readonly logger?: LoggerLike,
  ) {
    this.client = new GraphitiMcpClient(config, logger);
  }

  async warmup(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }
    try {
      const tools = await this.client.discoverTools(true);
      this.knownTools = new Set(
        tools
          .map((item) => (typeof item?.name === "string" ? item.name : ""))
          .filter((name) => name.length > 0),
      );
      this.logger?.info?.(
        `memory-lancedb-pro: graphiti tools discovered (${[...this.knownTools].join(", ") || "none"})`,
      );
    } catch (err) {
      this.logger?.warn?.(`memory-lancedb-pro: graphiti warmup failed: ${String(err)}`);
    }
  }

  async addEpisode(input: GraphitiEpisodeInput): Promise<GraphitiEpisodeResult> {
    const groupId = this.resolveGroupId(input.scope);
    if (!this.config.enabled) {
      return { status: "skipped", groupId };
    }

    try {
      const tool = await this.pickFirstTool(ADD_EPISODE_TOOL_CANDIDATES);
      const argsCandidates = [
        { group_id: groupId, text: input.text, metadata: input.metadata ?? {} },
        { groupId, text: input.text, metadata: input.metadata ?? {} },
        {
          group_id: groupId,
          messages: [{ role: "user", content: input.text }],
          metadata: input.metadata ?? {},
        },
        {
          group_id: groupId,
          episode_body: { text: input.text, metadata: input.metadata ?? {} },
        },
      ];

      let lastError: unknown = null;
      for (const args of argsCandidates) {
        try {
          const result = await this.client.callTool(tool, args);
          const episodeRef = extractEpisodeRef(result);
          return {
            status: "stored",
            groupId,
            episodeRef,
          };
        } catch (err) {
          lastError = err;
        }
      }

      throw new Error(`all add_episode payload variants failed: ${String(lastError)}`);
    } catch (err) {
      if (this.config.failOpen) {
        this.logger?.warn?.(`memory-lancedb-pro: graphiti addEpisode fail-open: ${String(err)}`);
        return {
          status: "failed",
          groupId,
          error: String(err),
        };
      }
      throw err;
    }
  }

  async recall(input: GraphitiRecallInput): Promise<GraphitiRecallResult> {
    const groupId = this.resolveGroupId(input.scope);
    if (!this.config.enabled) {
      return { groupId, nodes: [], facts: [] };
    }

    const [nodes, facts] = await Promise.all([
      this.searchNodes(groupId, input.query, input.limitNodes),
      this.searchFacts(groupId, input.query, input.limitFacts),
    ]);

    return {
      groupId,
      nodes,
      facts,
    };
  }

  private async searchNodes(groupId: string, query: string, limit: number): Promise<GraphitiNodeResult[]> {
    try {
      const tool = await this.pickFirstTool(SEARCH_NODES_TOOL_CANDIDATES);
      const payloads = [
        { group_id: groupId, query, limit },
        { groupId, query, limit },
        { group_id: groupId, q: query, top_k: limit },
      ];
      for (const args of payloads) {
        try {
          const result = await this.client.callTool(tool, args);
          return normalizeNodeResults(result);
        } catch {
          continue;
        }
      }
      return [];
    } catch (err) {
      this.logger?.warn?.(`memory-lancedb-pro: graphiti search_nodes failed: ${String(err)}`);
      return [];
    }
  }

  private async searchFacts(groupId: string, query: string, limit: number): Promise<GraphitiFactResult[]> {
    try {
      const tool = await this.pickFirstTool(SEARCH_FACTS_TOOL_CANDIDATES);
      const payloads = [
        { group_id: groupId, query, limit },
        { groupId, query, limit },
        { group_id: groupId, q: query, top_k: limit },
      ];
      for (const args of payloads) {
        try {
          const result = await this.client.callTool(tool, args);
          return normalizeFactResults(result);
        } catch {
          continue;
        }
      }
      return [];
    } catch (err) {
      this.logger?.warn?.(`memory-lancedb-pro: graphiti search_facts failed: ${String(err)}`);
      return [];
    }
  }

  private resolveGroupId(scope: string): string {
    if (this.config.groupIdMode === "fixed") {
      return this.config.fixedGroupId || "main";
    }
    return scope;
  }

  private async pickFirstTool(candidates: string[]): Promise<string> {
    if (this.knownTools.size === 0) {
      const tools = await this.client.discoverTools();
      this.knownTools = new Set(
        tools
          .map((item) => (typeof item?.name === "string" ? item.name : ""))
          .filter((name) => name.length > 0),
      );
    }

    for (const candidate of candidates) {
      if (this.knownTools.has(candidate)) {
        return candidate;
      }
    }

    throw new Error(`required Graphiti tool not found: ${candidates.join(" | ")}`);
  }
}

export function createGraphitiBridge(options: GraphitiBridgeOptions): GraphitiBridge {
  return new GraphitiBridge(options.config, options.logger);
}

function extractEpisodeRef(result: unknown): string | undefined {
  const payload = extractStructuredPayload(result);
  const candidates = ["episode_id", "episodeId", "ref", "id"];
  for (const key of candidates) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function normalizeNodeResults(result: unknown): GraphitiNodeResult[] {
  const payload = extractStructuredPayload(result);
  const list = pickArray(payload, ["nodes", "items", "results", "data"]);
  return list
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      const label =
        stringValue(row.label) ||
        stringValue(row.name) ||
        stringValue(row.summary) ||
        stringValue(row.text);
      if (!label) return null;
      return {
        id: stringValue(row.id),
        label,
        score: numberValue(row.score),
        raw: item,
      } satisfies GraphitiNodeResult;
    })
    .filter((item): item is GraphitiNodeResult => item !== null);
}

function normalizeFactResults(result: unknown): GraphitiFactResult[] {
  const payload = extractStructuredPayload(result);
  const list = pickArray(payload, ["facts", "items", "results", "data"]);
  return list
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      const text =
        stringValue(row.fact) ||
        stringValue(row.text) ||
        stringValue(row.summary) ||
        composeRelationText(row);
      if (!text) return null;
      return {
        id: stringValue(row.id),
        text,
        score: numberValue(row.score),
        raw: item,
      } satisfies GraphitiFactResult;
    })
    .filter((item): item is GraphitiFactResult => item !== null);
}

function extractStructuredPayload(result: unknown): Record<string, unknown> {
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    const structured = record.structuredContent;
    if (structured && typeof structured === "object") {
      return structured as Record<string, unknown>;
    }

    const content = record.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const obj = block as Record<string, unknown>;
        const text = obj.text;
        if (typeof text === "string") {
          try {
            const parsed = JSON.parse(text) as Record<string, unknown>;
            if (parsed && typeof parsed === "object") {
              return parsed;
            }
          } catch {
            // ignore parse errors and continue
          }
        }
      }
    }
    return record;
  }
  return {};
}

function pickArray(
  payload: Record<string, unknown>,
  keys: string[],
): Array<unknown> {
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function composeRelationText(row: Record<string, unknown>): string | undefined {
  const source = stringValue(row.source) || stringValue(row.subject);
  const relation = stringValue(row.relation) || stringValue(row.predicate);
  const target = stringValue(row.target) || stringValue(row.object);
  if (source && relation && target) {
    return `${source} ${relation} ${target}`;
  }
  return undefined;
}
