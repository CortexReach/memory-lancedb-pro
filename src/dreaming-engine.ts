/**
 * Dreaming Engine — Periodic memory consolidation
 *
 * Three-phase process that runs on a schedule:
 * 1. Light Sleep: Decay scoring + tier re-evaluation for recent memories
 * 2. Deep Sleep: Promote frequently-recalled Working memories to Core
 * 3. REM: Detect patterns and create reflection memories
 *
 * Scope isolation: Each phase operates within a single scope.
 * REM reflections are tagged with metadata to prevent re-processing.
 */

import type { MemoryStore, MemoryEntry } from "./store.js";
import type { TierTransition, TierableMemory } from "./tier-manager.js";
import type { DecayScore, DecayableMemory } from "./decay-engine.js";
import type { MemoryTier } from "./memory-categories.js";
import { parseSmartMetadata } from "./smart-metadata.js";

// ── Config ────────────────────────────────────────────────────────

export interface DreamingConfig {
  enabled: boolean;
  cron: string;
  verboseLogging: boolean;
  phases: {
    light: { lookbackDays: number; limit: number };
    deep: { limit: number; minScore: number; minRecallCount: number; recencyHalfLifeDays: number };
    rem: { lookbackDays: number; limit: number; minPatternStrength: number };
  };
}

export const DEFAULT_DREAMING_CONFIG: DreamingConfig = {
  enabled: false,
  cron: "0 3 * * *",
  verboseLogging: false,
  phases: {
    light: { lookbackDays: 3, limit: 100 },
    deep: { limit: 50, minScore: 0.6, minRecallCount: 2, recencyHalfLifeDays: 30 },
    rem: { lookbackDays: 7, limit: 80, minPatternStrength: 0.7 },
  },
};

/** Deep-merge partial user dreaming config over defaults (F3: null-safe) */
export function mergeDreamingConfig(user: Record<string, unknown> | undefined): DreamingConfig {
  const base: DreamingConfig = {
    ...DEFAULT_DREAMING_CONFIG,
    phases: {
      light: { ...DEFAULT_DREAMING_CONFIG.phases.light },
      deep: { ...DEFAULT_DREAMING_CONFIG.phases.deep },
      rem: { ...DEFAULT_DREAMING_CONFIG.phases.rem },
    },
  };
  if (!user) return base;

  if (typeof user.enabled === "boolean") base.enabled = user.enabled;
  if (typeof user.cron === "string") base.cron = user.cron;
  if (typeof user.verboseLogging === "boolean") base.verboseLogging = user.verboseLogging;

  if (user.phases && typeof user.phases === "object") {
    const phases = user.phases as Record<string, Record<string, unknown>>;
    if (phases.light) {
      if (typeof phases.light.lookbackDays === "number") base.phases.light.lookbackDays = phases.light.lookbackDays;
      if (typeof phases.light.limit === "number") base.phases.light.limit = phases.light.limit;
    }
    if (phases.deep) {
      if (typeof phases.deep.limit === "number") base.phases.deep.limit = phases.deep.limit;
      if (typeof phases.deep.minScore === "number") base.phases.deep.minScore = phases.deep.minScore;
      if (typeof phases.deep.minRecallCount === "number") base.phases.deep.minRecallCount = phases.deep.minRecallCount;
      if (typeof phases.deep.recencyHalfLifeDays === "number") base.phases.deep.recencyHalfLifeDays = phases.deep.recencyHalfLifeDays;
    }
    if (phases.rem) {
      if (typeof phases.rem.lookbackDays === "number") base.phases.rem.lookbackDays = phases.rem.lookbackDays;
      if (typeof phases.rem.limit === "number") base.phases.rem.limit = phases.rem.limit;
      if (typeof phases.rem.minPatternStrength === "number") base.phases.rem.minPatternStrength = phases.rem.minPatternStrength;
    }
  }
  return base;
}

// ── Report types ──────────────────────────────────────────────────

export interface DreamingReport {
  timestamp: number;
  scope: string;
  phases: {
    light: { scanned: number; transitions: TierTransition[] };
    deep: { candidates: number; promoted: number };
    rem: { patterns: string[]; reflectionsCreated: number };
  };
}

export interface DreamingEngine {
  run(scope: string): Promise<DreamingReport>;
}

// ── Constants ─────────────────────────────────────────────────────

/** Metadata tag to prevent REM reflections from being re-processed (MR2) */
const DREAMING_SOURCE_TAG = "dreaming-engine";

// ── Factory ───────────────────────────────────────────────────────

interface DreamingEngineParams {
  store: MemoryStore;
  embedder: { embed(text: string): Promise<number[]> };
  /** Fallback vector dimension when embedding fails */
  fallbackDimensions: number;
  decayEngine: { scoreAll(memories: DecayableMemory[], now: number): DecayScore[] };
  tierManager: { evaluateAll(memories: TierableMemory[], decayScores: DecayScore[], now: number): TierTransition[] };
  config: DreamingConfig;
  log: (msg: string) => void;
  debugLog: (msg: string) => void;
  workspaceDir?: string;
}

export function createDreamingEngine(params: DreamingEngineParams): DreamingEngine {
  const { store, embedder, decayEngine, tierManager, config, log, debugLog } = params;
  const fallbackVector = () => new Array(params.fallbackDimensions).fill(0);

  const verbose = config.verboseLogging;
  const dbg = verbose ? debugLog : () => {};
  const runningScopes = new Set<string>(); // Prevent overlapping cycles per scope

  return {
    async run(scope: string): Promise<DreamingReport> {
      if (runningScopes.has(scope)) {
        log(`Skipping ${scope} — previous cycle still running`);
        return { timestamp: Date.now(), scope, phases: { light: { scanned: 0, transitions: [] }, deep: { candidates: 0, promoted: 0 }, rem: { patterns: [], reflectionsCreated: 0 } } };
      }
      runningScopes.add(scope);
      try {
      const now = Date.now();
      log(`💤 Dreaming cycle started (scope: ${scope})`);

      const report: DreamingReport = {
        timestamp: now,
        scope,
        phases: {
          light: { scanned: 0, transitions: [] },
          deep: { candidates: 0, promoted: 0 },
          rem: { patterns: [], reflectionsCreated: 0 },
        },
      };

      // MR1: All phases filter by scope
      // Phase 1: Light Sleep
      try {
        report.phases.light = await runLightSleep(now, scope);
      } catch (err) {
        log(`⚠️ Light sleep failed: ${String(err)}`);
      }

      // Phase 2: Deep Sleep
      try {
        report.phases.deep = await runDeepSleep(now, scope);
      } catch (err) {
        log(`⚠️ Deep sleep failed: ${String(err)}`);
      }

      // Phase 3: REM
      try {
        report.phases.rem = await runREM(now, scope);
      } catch (err) {
        log(`⚠️ REM failed: ${String(err)}`);
      }

      log("☀️ Dreaming cycle complete");
      return report;
      } finally {
        runningScopes.delete(scope);
      }
    },
  };

  // ── Phase 1: Light Sleep ────────────────────────────────────────

  async function runLightSleep(now: number, scope: string): Promise<DreamingReport["phases"]["light"]> {
    const { lookbackDays, limit } = config.phases.light;
    const cutoff = now - lookbackDays * 86_400_000;

    dbg(`Light sleep [${scope}]: fetching memories newer than ${new Date(cutoff).toISOString()}`);

    // MR1: Filter by scope — explicitly match only the target scope,
    // excluding null-scope memories that store.list() may include for backward compat
    const entries = (await store.list([scope], undefined, limit * 2, 0))
      .filter((e) => e.scope === scope);
    const recent = entries.filter((e) => e.timestamp > cutoff).slice(0, limit);

    dbg(`Light sleep [${scope}]: ${recent.length} recent memories to evaluate`);

    if (recent.length === 0) {
      return { scanned: 0, transitions: [] };
    }

    // MR2: Skip reflections generated by previous dreaming cycles
    const nonReflection = recent.filter((e) => !isDreamingReflection(e));

    // Convert to decay/tier inputs via smart metadata
    const decayable: DecayableMemory[] = [];
    const tierable: TierableMemory[] = [];

    for (const entry of nonReflection) {
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

    if (decayable.length === 0) {
      return { scanned: recent.length, transitions: [] };
    }

    // Score decay, then evaluate tier transitions
    const decayScores = decayEngine.scoreAll(decayable, now);
    const transitions = tierManager.evaluateAll(tierable, decayScores, now);

    dbg(`Light sleep [${scope}]: ${transitions.length} tier transitions proposed`);

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

  async function runDeepSleep(now: number, scope: string): Promise<DreamingReport["phases"]["deep"]> {
    const { limit, minScore, minRecallCount } = config.phases.deep;

    dbg(`Deep sleep [${scope}]: fetching Working-tier memories`);

    // MR1: Filter by scope — explicitly match only the target scope
    const entries = (await store.list([scope], undefined, limit * 5, 0))
      .filter((e) => e.scope === scope);
    const working = entries.filter((e) => {
      const parsed = parseSmartMetadata(e.metadata, e);
      return parsed.tier === "working";
    }).slice(0, limit);

    // MR2: Exclude dreaming reflections
    const nonReflection = working.filter((e) => !isDreamingReflection(e));

    if (nonReflection.length === 0) {
      return { candidates: working.length, promoted: 0 };
    }

    // Convert and score for decay
    const decayable: DecayableMemory[] = nonReflection.map((e) => {
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
    for (const entry of nonReflection) {
      const parsed = parseSmartMetadata(entry.metadata, entry);
      const score = scoreMap.get(entry.id);
      const accessCount = parsed.access_count ?? 0;
      const composite = score?.composite ?? 0;

      if (composite >= minScore && accessCount >= minRecallCount) {
        // Boost importance by 20% (capped at 1.0)
        const newImportance = Math.min(1.0, entry.importance * 1.2);
        // Update top-level importance column + metadata tier
        await store.update(entry.id, { importance: newImportance });
        await store.patchMetadata(entry.id, {
          tier: "core",
          tier_updated_at: now,
        });
        dbg(`  ⬆ Deep sleep promoted: ${entry.id} (score=${composite.toFixed(3)}, accesses=${accessCount})`);
        promoted++;
      }
    }

    return { candidates: working.length, promoted };
  }

  // ── Phase 3: REM ────────────────────────────────────────────────

  async function runREM(now: number, scope: string): Promise<DreamingReport["phases"]["rem"]> {
    const { lookbackDays, limit, minPatternStrength } = config.phases.rem;
    const cutoff = now - lookbackDays * 86_400_000;

    dbg(`REM [${scope}]: analyzing memory patterns`);

    // MR1: Filter by scope — explicitly match only the target scope
    const entries = (await store.list([scope], undefined, limit, 0))
      .filter((e) => e.scope === scope);
    const recent = entries.filter((e) => e.timestamp > cutoff);

    // MR2: Exclude dreaming reflections from analysis
    const sourceMemories = recent.filter((e) => !isDreamingReflection(e));

    if (sourceMemories.length < 5) {
      return { patterns: [], reflectionsCreated: 0 };
    }

    const patterns: string[] = [];

    // Analyze category frequency per tier
    const tierCategoryMap = new Map<string, Map<string, number>>();
    const categoryTotal = new Map<string, number>();

    for (const entry of sourceMemories) {
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
        if (total < 3) continue;

        const ratio = count / total;
        if (ratio >= minPatternStrength) {
          patterns.push(`"${cat}" memories cluster in ${tier} tier (${Math.round(ratio * 100)}%)`);
        }
      }
    }

    // Detect high-importance categories
    const importanceByCategory = new Map<string, number[]>();
    for (const entry of sourceMemories) {
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
      const reflectionText = `Dreaming reflection: ${patterns.join(". ")}. Generated from ${sourceMemories.length} memories analyzed.`;

      // F2: Embed the reflection so it's searchable and compatible with LanceDB schema
      let vector: number[];
      try {
        vector = await embedder.embed(reflectionText);
      } catch {
        dbg("REM: embedding failed, falling back to zero vector");
        vector = fallbackVector();
      }

      // MR1: Store reflection in the same scope as source memories
      // MR2: Tag with source metadata to prevent re-processing
      await store.store({
        text: reflectionText,
        vector,
        category: "reflection",
        scope,
        importance: 0.4,
        metadata: JSON.stringify({
          dream_timestamp: now,
          patterns_count: patterns.length,
          memories_analyzed: sourceMemories.length,
          source: DREAMING_SOURCE_TAG,
        }),
      });
      reflectionsCreated = 1;

      dbg(`REM [${scope}]: created reflection memory with ${patterns.length} pattern(s)`);
    }

    return { patterns, reflectionsCreated };
  }
}

// ── Helpers ───────────────────────────────────────────────────────

/** Check if a memory entry is a dreaming-generated reflection (MR2: prevent re-processing loop) */
function isDreamingReflection(entry: MemoryEntry): boolean {
  if (!entry.metadata) return false;
  try {
    const meta = JSON.parse(entry.metadata);
    return meta.source === DREAMING_SOURCE_TAG;
  } catch {
    return false;
  }
}
