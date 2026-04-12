/**
 * Dreaming Engine — Periodic memory consolidation
 *
 * Three-phase process that runs on a schedule:
 * 1. Light Sleep: Decay scoring + tier re-evaluation for recent memories
 * 2. Deep Sleep: Promote frequently-recalled Working memories to Core
 * 3. REM: Detect patterns and create reflection memories
 */

import type { MemoryStore, MemoryEntry } from "./store.js";

/** Config for the dreaming engine — mirrors the plugin's dreaming config section */
export interface DreamingConfig {
  enabled: boolean;
  cron: string;
  timezone: string;
  storageMode: "inline" | "separate" | "both";
  separateReports: boolean;
  verboseLogging: boolean;
  phases: {
    light: { lookbackDays: number; limit: number };
    deep: { limit: number; minScore: number; minRecallCount: number; recencyHalfLifeDays: number };
    rem: { lookbackDays: number; limit: number; minPatternStrength: number };
  };
}
import type { TierTransition, TierableMemory } from "./tier-manager.js";
import type { DecayScore, DecayableMemory } from "./decay-engine.js";
import type { MemoryTier } from "./memory-categories.js";

import { parseSmartMetadata } from "./smart-metadata.js";

// ── Report types ──────────────────────────────────────────────────

export interface DreamingReport {
  timestamp: number;
  phases: {
    light: { scanned: number; transitions: TierTransition[] };
    deep: { candidates: number; promoted: number };
    rem: { patterns: string[]; reflectionsCreated: number };
  };
}

export interface DreamingEngine {
  run(): Promise<DreamingReport>;
}

// ── Factory ───────────────────────────────────────────────────────

interface DreamingEngineParams {
  store: MemoryStore;
  decayEngine: { scoreAll(memories: DecayableMemory[], now: number): DecayScore[] };
  tierManager: { evaluateAll(memories: TierableMemory[], decayScores: DecayScore[], now: number): TierTransition[] };
  config: DreamingConfig;
  log: (msg: string) => void;
  debugLog: (msg: string) => void;
  workspaceDir?: string;
}

export function createDreamingEngine(params: DreamingEngineParams): DreamingEngine {
  const { store, decayEngine, tierManager, config, log, debugLog } = params;

  const verbose = config.verboseLogging;
  const dbg = verbose ? debugLog : () => {};

  return {
    async run(): Promise<DreamingReport> {
      const now = Date.now();
      log("💤 Dreaming cycle started");

      const report: DreamingReport = {
        timestamp: now,
        phases: {
          light: { scanned: 0, transitions: [] },
          deep: { candidates: 0, promoted: 0 },
          rem: { patterns: [], reflectionsCreated: 0 },
        },
      };

      // Phase 1: Light Sleep
      try {
        report.phases.light = await runLightSleep(now);
      } catch (err) {
        log(`⚠️ Light sleep failed: ${err}`);
      }

      // Phase 2: Deep Sleep
      try {
        report.phases.deep = await runDeepSleep(now);
      } catch (err) {
        log(`⚠️ Deep sleep failed: ${err}`);
      }

      // Phase 3: REM
      try {
        report.phases.rem = await runREM(now);
      } catch (err) {
        log(`⚠️ REM failed: ${err}`);
      }

      log("☀️ Dreaming cycle complete");
      return report;
    },
  };

  // ── Phase 1: Light Sleep ────────────────────────────────────────

  async function runLightSleep(now: number): Promise<DreamingReport["phases"]["light"]> {
    const { lookbackDays, limit } = config.phases.light;
    const cutoff = now - lookbackDays * 86_400_000;

    dbg(`Light sleep: fetching memories newer than ${new Date(cutoff).toISOString()}`);

    // Fetch recent memories (may get more than we need, filter in-memory)
    const entries = await store.list(undefined, undefined, limit * 2, 0);
    const recent = entries.filter((e) => e.timestamp > cutoff).slice(0, limit);

    dbg(`Light sleep: ${recent.length} recent memories to evaluate`);

    if (recent.length === 0) {
      return { scanned: 0, transitions: [] };
    }

    // Convert to decay/tier inputs via smart metadata
    const decayable: DecayableMemory[] = [];
    const tierable: TierableMemory[] = [];

    for (const entry of recent) {
      const parsed = parseSmartMetadata(entry.metadata, entry);
      const decayMem: DecayableMemory = {
        id: entry.id,
        importance: entry.importance,
        confidence: parsed.confidence ?? 0.5,
        tier: (parsed.tier as MemoryTier) ?? "working",
        accessCount: parsed.access_count ?? 0,
        createdAt: entry.timestamp,
        lastAccessedAt: parsed.last_accessed_at ?? entry.timestamp,
        temporalType: parsed.type === "static" || parsed.type === "dynamic" ? parsed.type : undefined,
      };
      decayable.push(decayMem);

      tierable.push({
        id: entry.id,
        tier: decayMem.tier,
        importance: entry.importance,
        accessCount: decayMem.accessCount,
        createdAt: entry.timestamp,
      });
    }

    // Score decay, then evaluate tier transitions
    const decayScores = decayEngine.scoreAll(decayable, now);
    const transitions = tierManager.evaluateAll(tierable, decayScores, now);

    dbg(`Light sleep: ${transitions.length} tier transitions proposed`);

    // Apply transitions
    for (const t of transitions) {
      await store.patchMetadata(t.memoryId, {
        tier: t.toTier,
        tier_updated_at: now,
      });
      dbg(`  ↕ ${t.memoryId}: ${t.fromTier} → ${t.toTier} (${t.reason})`);
    }

    return { scanned: recent.length, transitions };
  }

  // ── Phase 2: Deep Sleep ─────────────────────────────────────────

  async function runDeepSleep(now: number): Promise<DreamingReport["phases"]["deep"]> {
    const { limit, minScore, minRecallCount } = config.phases.deep;

    dbg("Deep sleep: fetching Working-tier memories");

    // Fetch all memories and filter to working tier
    const entries = await store.list(undefined, undefined, limit * 5, 0);
    const working = entries.filter((e) => {
      const parsed = parseSmartMetadata(e.metadata, e);
      return parsed.tier === "working";
    }).slice(0, limit);

    if (working.length === 0) {
      return { candidates: 0, promoted: 0 };
    }

    // Convert and score for decay
    const decayable: DecayableMemory[] = working.map((e) => {
      const parsed = parseSmartMetadata(e.metadata, e);
      return {
        id: e.id,
        importance: e.importance,
        confidence: parsed.confidence ?? 0.5,
        tier: "working" as MemoryTier,
        accessCount: parsed.access_count ?? 0,
        createdAt: e.timestamp,
        lastAccessedAt: parsed.last_accessed_at ?? e.timestamp,
      };
    });

    const scores = decayEngine.scoreAll(decayable, now);
    const scoreMap = new Map(scores.map((s) => [s.memoryId, s]));

    // Promote memories that meet both thresholds
    let promoted = 0;
    for (const entry of working) {
      const parsed = parseSmartMetadata(entry.metadata, entry);
      const score = scoreMap.get(entry.id);
      const accessCount = parsed.access_count ?? 0;
      const composite = score?.composite ?? 0;

      if (composite >= minScore && accessCount >= minRecallCount) {
        // Boost importance by 20% (capped at 1.0)
        const newImportance = Math.min(1.0, entry.importance * 1.2);
        await store.patchMetadata(entry.id, {
          tier: "core",
          tier_updated_at: now,
          importance: newImportance,
        });
        dbg(`  ⬆ Deep sleep promoted: ${entry.id} (score=${composite.toFixed(3)}, accesses=${accessCount})`);
        promoted++;
      }
    }

    return { candidates: working.length, promoted };
  }

  // ── Phase 3: REM ────────────────────────────────────────────────

  async function runREM(now: number): Promise<DreamingReport["phases"]["rem"]> {
    const { lookbackDays, limit, minPatternStrength } = config.phases.rem;
    const cutoff = now - lookbackDays * 86_400_000;

    dbg("REM: analyzing memory patterns");

    const entries = await store.list(undefined, undefined, limit, 0);
    const recent = entries.filter((e) => e.timestamp > cutoff);

    if (recent.length < 5) {
      // Not enough data for pattern detection
      return { patterns: [], reflectionsCreated: 0 };
    }

    const patterns: string[] = [];

    // Analyze category frequency per tier
    const tierCategoryMap = new Map<string, Map<string, number>>();
    const categoryTotal = new Map<string, number>();

    for (const entry of recent) {
      const parsed = parseSmartMetadata(entry.metadata, entry);
      const tier = parsed.tier ?? "working";
      const cat = entry.category;

      if (!tierCategoryMap.has(tier)) tierCategoryMap.set(tier, new Map());
      const catMap = tierCategoryMap.get(tier)!;
      catMap.set(cat, (catMap.get(cat) ?? 0) + 1);
      categoryTotal.set(cat, (categoryTotal.get(cat) ?? 0) + 1);
    }

    // Detect categories that cluster disproportionately in high tiers
    const highTiers: MemoryTier[] = ["core", "working"];
    for (const tier of highTiers) {
      const catMap = tierCategoryMap.get(tier);
      if (!catMap) continue;

      for (const [cat, count] of catMap) {
        const total = categoryTotal.get(cat) ?? 0;
        if (total < 3) continue; // Skip sparse categories

        const ratio = count / total;
        if (ratio >= minPatternStrength) {
          const pattern = `"${cat}" memories cluster in ${tier} tier (${Math.round(ratio * 100)}%)`;
          patterns.push(pattern);
        }
      }
    }

    // Detect high-importance categories
    const importanceByCategory = new Map<string, number[]>();
    for (const entry of recent) {
      const arr = importanceByCategory.get(entry.category) ?? [];
      arr.push(entry.importance);
      importanceByCategory.set(entry.category, arr);
    }

    for (const [cat, scores] of importanceByCategory) {
      if (scores.length < 3) continue;
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      if (avg >= 0.8) {
        patterns.push(`Category "${cat}" has consistently high importance (avg ${avg.toFixed(2)})`);
      }
    }

    // Create reflection memories for discovered patterns
    let reflectionsCreated = 0;
    if (patterns.length > 0) {
      const reflectionText = `Dreaming reflection: ${patterns.join(". ")}. Generated from ${recent.length} memories analyzed.`;

      await store.store({
        text: reflectionText,
        vector: [], // Non-searchable reflection; could embed later
        category: "reflection",
        scope: "global",
        importance: 0.4,
        metadata: JSON.stringify({
          dream_timestamp: now,
          patterns_count: patterns.length,
          memories_analyzed: recent.length,
          source: "dreaming-engine",
        }),
      });
      reflectionsCreated = 1;

      dbg(`REM: created reflection memory with ${patterns.length} pattern(s)`);
    }

    return { patterns, reflectionsCreated };
  }
}
