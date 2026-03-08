import type { MemoryStore } from "../store.js";
import type { GraphitiBridge } from "./bridge.js";
import type {
  GraphitiEpisodeResult,
  GraphitiPluginConfig,
  GraphitiWriteConfig,
} from "./types.js";

type GraphitiWriteMode = keyof GraphitiWriteConfig;

interface LoggerLike {
  warn?: (message: string) => void;
}

export interface GraphitiSyncMemoryInput {
  id: string;
  text: string;
  scope: string;
  category?: string;
  metadata?: string;
}

export interface GraphitiSyncMemoryOptions {
  mode: GraphitiWriteMode;
  source: string;
  agentId?: string;
  updateMetadata?: boolean;
  mutation?: string;
  extraMetadata?: Record<string, unknown>;
}

interface GraphitiSyncServiceOptions {
  bridge?: GraphitiBridge;
  config?: GraphitiPluginConfig;
  store: MemoryStore;
  logger?: LoggerLike;
}

export class GraphitiSyncService {
  constructor(private readonly options: GraphitiSyncServiceOptions) {}

  isEnabled(mode: GraphitiWriteMode): boolean {
    const cfg = this.options.config;
    return !!(this.options.bridge && cfg?.enabled && cfg.write[mode] === true);
  }

  async syncMemory(
    memory: GraphitiSyncMemoryInput,
    options: GraphitiSyncMemoryOptions,
  ): Promise<GraphitiEpisodeResult | undefined> {
    if (!this.isEnabled(options.mode)) {
      return undefined;
    }

    const result = await this.options.bridge!.addEpisode({
      text: memory.text,
      scope: memory.scope,
      metadata: {
        source: options.source,
        agentId: options.agentId,
        memoryId: memory.id,
        category: memory.category,
        scope: memory.scope,
        ...options.extraMetadata,
      },
    });

    const updateMetadata = options.updateMetadata !== false;
    if (!updateMetadata || result.status === "skipped") {
      return result;
    }

    try {
      const currentMetadata = safeParseJson(memory.metadata);
      const nextMetadata = {
        ...currentMetadata,
        graphiti: {
          groupId: result.groupId,
          episodeRef: result.episodeRef,
          status: result.status,
          error: result.error,
          lastMutation: options.mutation,
          source: options.source,
          updatedAt: new Date().toISOString(),
        },
      };
      await this.options.store.update(
        memory.id,
        { metadata: JSON.stringify(nextMetadata) },
        [memory.scope],
      );
    } catch (err) {
      this.options.logger?.warn?.(
        `memory-lancedb-pro: graphiti sync metadata update failed: ${String(err)}`,
      );
    }

    return result;
  }

  async recordEvent(input: {
    mode: GraphitiWriteMode;
    source: string;
    scope: string;
    text: string;
    metadata?: Record<string, unknown>;
  }): Promise<GraphitiEpisodeResult | undefined> {
    if (!this.isEnabled(input.mode)) {
      return undefined;
    }
    return await this.options.bridge!.addEpisode({
      text: input.text,
      scope: input.scope,
      metadata: {
        source: input.source,
        scope: input.scope,
        ...(input.metadata || {}),
      },
    });
  }
}

export function createGraphitiSyncService(options: GraphitiSyncServiceOptions): GraphitiSyncService {
  return new GraphitiSyncService(options);
}

function safeParseJson(value: string | undefined): Record<string, unknown> {
  if (!value || !value.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}
