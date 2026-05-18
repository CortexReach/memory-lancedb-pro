/**
 * Tier Manager — Three-tier memory promotion/demotion system
 *
 * Tiers:
 * - Core (decay floor 0.9): Identity-level facts, almost never forgotten
 * - Working (decay floor 0.7): Active context, ages out without reinforcement
 * - Peripheral (decay floor 0.5): Low-priority or aging memories
 *
 * Promotion: Peripheral → Working → Core (based on access, composite score, importance)
 * Demotion: Core → Working → Peripheral (based on decay, age)
 */
export const DEFAULT_TIER_CONFIG = {
    coreAccessThreshold: 10,
    coreCompositeThreshold: 0.7,
    coreImportanceThreshold: 0.8,
    peripheralCompositeThreshold: 0.15,
    peripheralAgeDays: 60,
    workingAccessThreshold: 3,
    workingCompositeThreshold: 0.4,
};
// ============================================================================
// Factory
// ============================================================================
const MS_PER_DAY = 86_400_000;
export function createTierManager(config = DEFAULT_TIER_CONFIG) {
    function evaluate(memory, decayScore, now = Date.now()) {
        const ageDays = (now - memory.createdAt) / MS_PER_DAY;
        switch (memory.tier) {
            case "peripheral": {
                // Promote to Working?
                if (memory.accessCount >= config.workingAccessThreshold &&
                    decayScore.composite >= config.workingCompositeThreshold) {
                    return {
                        memoryId: memory.id,
                        fromTier: "peripheral",
                        toTier: "working",
                        reason: `Access count (${memory.accessCount}) >= ${config.workingAccessThreshold} and composite (${decayScore.composite.toFixed(2)}) >= ${config.workingCompositeThreshold}`,
                    };
                }
                break;
            }
            case "working": {
                // Promote to Core?
                if (memory.accessCount >= config.coreAccessThreshold &&
                    decayScore.composite >= config.coreCompositeThreshold &&
                    memory.importance >= config.coreImportanceThreshold) {
                    return {
                        memoryId: memory.id,
                        fromTier: "working",
                        toTier: "core",
                        reason: `High access (${memory.accessCount}), composite (${decayScore.composite.toFixed(2)}), importance (${memory.importance})`,
                    };
                }
                // Demote to Peripheral?
                if (decayScore.composite < config.peripheralCompositeThreshold ||
                    (ageDays > config.peripheralAgeDays &&
                        memory.accessCount < config.workingAccessThreshold)) {
                    return {
                        memoryId: memory.id,
                        fromTier: "working",
                        toTier: "peripheral",
                        reason: `Low composite (${decayScore.composite.toFixed(2)}) or aged ${ageDays.toFixed(0)} days with low access (${memory.accessCount})`,
                    };
                }
                break;
            }
            case "core": {
                // Demote to Working? (Core rarely demotes, but it can)
                if (decayScore.composite < config.peripheralCompositeThreshold &&
                    memory.accessCount < config.workingAccessThreshold) {
                    return {
                        memoryId: memory.id,
                        fromTier: "core",
                        toTier: "working",
                        reason: `Severely low composite (${decayScore.composite.toFixed(2)}) and access (${memory.accessCount})`,
                    };
                }
                break;
            }
        }
        return null;
    }
    return {
        evaluate,
        evaluateAll(memories, decayScores, now = Date.now()) {
            const scoreMap = new Map(decayScores.map((s) => [s.memoryId, s]));
            const transitions = [];
            for (const memory of memories) {
                const score = scoreMap.get(memory.id);
                if (!score)
                    continue;
                const transition = evaluate(memory, score, now);
                if (transition) {
                    transitions.push(transition);
                }
            }
            return transitions;
        },
    };
}
