/**
 * Memory Confidence Scoring
 * Tracks per-memory confidence based on recall/useful signals.
 * Stores data in memory metadata — no separate table needed.
 */

// ============================================================================
// Types
// ============================================================================

export interface ConfidenceTrackerConfig {
  enabled: boolean;
  decayFactor: number;
}

interface MemoryConfidenceState {
  recallCount: number;
  usefulCount: number;
  decayBoost: number;
  lastRecallAt: number;
}

// ============================================================================
// Implementation
// ============================================================================

export interface ConfidenceTracker {
  recordRecall(memoryId: string): void;
  recordUseful(memoryId: string): void;
  getConfidence(memoryId: string): number;
  getTopConfident(limit: number): string[];
  getState(memoryId: string): MemoryConfidenceState | undefined;
  reset(): void;
}

export function createConfidenceTracker(config: ConfidenceTrackerConfig = { enabled: true, decayFactor: 0.95 }): ConfidenceTracker {
  if (!config.enabled) {
    return createNoopTracker();
  }

  const state = new Map<string, MemoryConfidenceState>();

  return {
    recordRecall(memoryId: string): void {
      const existing = state.get(memoryId);
      const now = Date.now();
      if (existing) {
        existing.recallCount++;
        existing.lastRecallAt = now;
        // If recalled but not marked useful recently, decay slightly
        existing.decayBoost = Math.max(0.5, existing.decayBoost * config.decayFactor);
      } else {
        state.set(memoryId, {
          recallCount: 1,
          usefulCount: 0,
          decayBoost: 1.0,
          lastRecallAt: now,
        });
      }
    },

    recordUseful(memoryId: string): void {
      const existing = state.get(memoryId);
      if (existing) {
        existing.usefulCount++;
        // Restore decay boost on useful signal
        existing.decayBoost = Math.min(1.0, existing.decayBoost + 0.1);
      } else {
        state.set(memoryId, {
          recallCount: 0,
          usefulCount: 1,
          decayBoost: 1.0,
          lastRecallAt: Date.now(),
        });
      }
    },

    getConfidence(memoryId: string): number {
      const s = state.get(memoryId);
      if (!s) return 0;
      return (s.usefulCount / Math.max(s.recallCount, 1)) * s.decayBoost;
    },

    getTopConfident(limit: number): string[] {
      return Array.from(state.entries())
        .map(([id, s]) => ({ id, score: s.usefulCount / Math.max(s.recallCount, 1) * s.decayBoost }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(e => e.id);
    },

    getState(memoryId: string): MemoryConfidenceState | undefined {
      return state.get(memoryId);
    },

    reset(): void {
      state.clear();
    },
  };
}

function createNoopTracker(): ConfidenceTracker {
  return {
    recordRecall: () => {},
    recordUseful: () => {},
    getConfidence: () => 0,
    getTopConfident: () => [],
    getState: () => undefined,
    reset: () => {},
  };
}
