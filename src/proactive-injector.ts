/**
 * Proactive Memory Injection
 * Hooks into before_prompt_build alongside auto-recall to inject contextually
 * relevant memories based on staleness, entity mentions, and pattern triggers.
 */

import type { MemoryRetriever } from "./retriever.js";
import type { EntityGraph } from "./entity-graph.js";
import { resolveScopeFilter } from "./scopes.js";

// ============================================================================
// Types
// ============================================================================

export interface ProactiveConfig {
  enabled: boolean;
  staleMemoryDays: number;
  entityPrefetch: boolean;
  patternTriggers: Record<string, string>; // regex pattern → search query
}

interface ProactiveContext {
  retriever: MemoryRetriever;
  entityGraph: EntityGraph;
  scopeManager: { getScopeFilter?: (agentId?: string) => string[] | undefined; getAccessibleScopes: (agentId?: string) => string[] };
}

export interface ProactiveResult {
  injected: boolean;
  reason: string;
  memoryIds: string[];
  text: string;
}

// ============================================================================
// Implementation
// ============================================================================

export interface ProactiveInjector {
  /**
   * Attempt a proactive injection. Returns null if nothing to inject.
   * @param userMessage The user's latest message
   * @param agentId Current agent ID
   * @param existingRecallIds IDs already returned by auto-recall (for dedup)
   */
  tryInject(userMessage: string, agentId: string | undefined, existingRecallIds: string[]): Promise<ProactiveResult | null>;
}

export function createProactiveInjector(
  context: ProactiveContext,
  config: ProactiveConfig,
): ProactiveInjector {
  if (!config.enabled) {
    return { tryInject: async () => null };
  }

  const seenStale = new Set<string>();

  return {
    async tryInject(userMessage: string, agentId: string | undefined, existingRecallIds: string[]): Promise<ProactiveResult | null> {
      // Max 1 proactive injection per turn
      const scopeFilter = context.scopeManager.getScopeFilter
        ? context.scopeManager.getScopeFilter(agentId)
        : context.scopeManager.getAccessibleScopes(agentId);

      // 1. Entity-based prefetch
      if (config.entityPrefetch) {
        const entities = context.entityGraph.extractEntities(userMessage);
        for (const entity of entities.slice(0, 3)) {
          const profile = context.entityGraph.getEntityProfile(entity.name);
          // Only prefetch if entity has meaningful relationships
          if (profile.factCount > 0 && profile.relationships.length > 0) {
            // Build query from relationship objects
            const relatedNames = profile.relationships
              .map(r => r.subject === entity.name ? r.object : r.subject)
              .filter(n => n.toLowerCase() !== entity.normalized)
              .slice(0, 3);

            if (relatedNames.length === 0) continue;

            const query = `${entity.name} ${relatedNames.join(" ")}`;
            try {
              const results = await context.retriever.retrieve({
                query,
                limit: 2,
                scopeFilter,
              });

              const novel = results.filter(r => !existingRecallIds.includes(r.entry.id));
              if (novel.length > 0) {
                const text = novel.map(r => r.entry.text.slice(0, 200)).join("\n");
                return {
                  injected: true,
                  reason: `entity-prefetch:${entity.name}`,
                  memoryIds: novel.map(r => r.entry.id),
                  text: `[Proactive: related to "${entity.name}"]\n${text}`,
                };
              }
            } catch {
              // Silently skip on errors
            }
          }
        }
      }

      // 2. Pattern triggers
      for (const [pattern, searchQuery] of Object.entries(config.patternTriggers)) {
        try {
          if (new RegExp(pattern, "i").test(userMessage)) {
            const results = await context.retriever.retrieve({
              query: searchQuery,
              limit: 1,
              scopeFilter,
            });
            const novel = results.filter(r => !existingRecallIds.includes(r.entry.id));
            if (novel.length > 0) {
              return {
                injected: true,
                reason: `pattern-trigger:${pattern}`,
                memoryIds: novel.map(r => r.entry.id),
                text: novel[0].entry.text.slice(0, 300),
              };
            }
          }
        } catch {
          // Invalid regex or retrieval error — skip
        }
      }

      // 3. Stale memory check (only occasionally, not every turn)
      if (Math.random() < 0.05) { // ~5% chance per turn
        try {
          const staleResults = await context.retriever.retrieve({
            query: userMessage,
            limit: 1,
            scopeFilter,
          });
          for (const r of staleResults) {
            const ageDays = (Date.now() - r.entry.timestamp) / (1000 * 60 * 60 * 24);
            if (ageDays > config.staleMemoryDays && !seenStale.has(r.entry.id) && !existingRecallIds.includes(r.entry.id)) {
              seenStale.add(r.entry.id);
              return {
                injected: true,
                reason: `stale-memory:${Math.round(ageDays)}d`,
                memoryIds: [r.entry.id],
                text: `[Proactive: memory not revisited in ${Math.round(ageDays)} days]\n${r.entry.text.slice(0, 200)}`,
              };
            }
          }
        } catch {
          // Skip
        }
      }

      return null;
    },
  };
}
