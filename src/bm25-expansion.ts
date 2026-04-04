import type { MemoryStore } from "./store.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

export async function expandDerivedWithBm25(
  derived: string[],
  scopeFilter: string[] | undefined,
  store: MemoryStore,
  api: OpenClawPluginApi,
): Promise<string[]> {
  if (!derived.length) return derived;
  if (scopeFilter === undefined) return derived;

  const MAX_TOTAL = 16;
  const MAX_NEIGHBORS = MAX_TOTAL - derived.length;
  if (MAX_NEIGHBORS <= 0) return derived.slice(0, MAX_TOTAL);

  const seen = new Set<string>();
  const neighbors: string[] = [];

  for (const derivedLine of derived) {
    if (neighbors.length >= MAX_NEIGHBORS) break;

    try {
      const hits = await store.bm25Search(derivedLine, 2, scopeFilter, { excludeInactive: true });

      for (const hit of hits) {
        if (neighbors.length >= MAX_NEIGHBORS) break;
        if (hit.entry.category === "reflection") continue;

        const text = (hit.entry.text || "").split("\n")[0].slice(0, 120);
        if (seen.has(text)) continue;
        seen.add(text);
        neighbors.push(text);
      }
    } catch (err) {
      api.logger.debug?.(`expandDerivedWithBm25: bm25Search failed: ${String(err)}`);
    }
  }

  return [...neighbors, ...derived].slice(0, MAX_TOTAL);
}
