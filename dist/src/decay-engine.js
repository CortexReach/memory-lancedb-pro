/**
 * Decay Engine — Weibull stretched-exponential decay model
 *
 * Composite score = recencyWeight * recency + frequencyWeight * frequency + intrinsicWeight * intrinsic
 *
 * - Recency: Weibull decay with importance-modulated half-life and tier-specific beta
 * - Frequency: Logarithmic saturation with time-weighted access pattern bonus
 * - Intrinsic: importance × confidence
 */
// ============================================================================
// Types
// ============================================================================
const MS_PER_DAY = 86_400_000;
export const DEFAULT_DECAY_CONFIG = {
    recencyHalfLifeDays: 30,
    recencyWeight: 0.4,
    frequencyWeight: 0.3,
    intrinsicWeight: 0.3,
    staleThreshold: 0.3,
    searchBoostMin: 0.3,
    importanceModulation: 1.5,
    betaCore: 0.8,
    betaWorking: 1.0,
    betaPeripheral: 1.3,
    coreDecayFloor: 0.9,
    workingDecayFloor: 0.7,
    peripheralDecayFloor: 0.5,
};
// ============================================================================
// Factory
// ============================================================================
export function createDecayEngine(config = DEFAULT_DECAY_CONFIG) {
    const { recencyHalfLifeDays: halfLife, recencyWeight: rw, frequencyWeight: fw, intrinsicWeight: iw, staleThreshold, searchBoostMin: boostMin, importanceModulation: mu, betaCore, betaWorking, betaPeripheral, coreDecayFloor, workingDecayFloor, peripheralDecayFloor, } = config;
    function getTierBeta(tier) {
        switch (tier) {
            case "core":
                return betaCore;
            case "working":
                return betaWorking;
            case "peripheral":
                return betaPeripheral;
        }
    }
    function getTierFloor(tier) {
        switch (tier) {
            case "core":
                return coreDecayFloor;
            case "working":
                return workingDecayFloor;
            case "peripheral":
                return peripheralDecayFloor;
        }
    }
    /**
     * Recency: Weibull stretched-exponential decay with importance-modulated half-life.
     * effectiveHL = halfLife * exp(mu * importance)
     * lambda = ln(2) / effectiveHL
     * recency = exp(-lambda * daysSince^beta)
     */
    function recency(memory, now) {
        const lastActive = memory.accessCount > 0 ? memory.lastAccessedAt : memory.createdAt;
        const daysSince = Math.max(0, (now - lastActive) / MS_PER_DAY);
        // Dynamic memories decay 3x faster (1/3 half-life)
        const baseHL = memory.temporalType === "dynamic" ? halfLife / 3 : halfLife;
        const effectiveHL = baseHL * Math.exp(mu * memory.importance);
        const lambda = Math.LN2 / effectiveHL;
        const beta = getTierBeta(memory.tier);
        return Math.exp(-lambda * Math.pow(daysSince, beta));
    }
    /**
     * Frequency: logarithmic saturation curve with time-weighted access pattern bonus.
     * base = 1 - exp(-accessCount / 5)
     * For memories with >1 access, a recentness bonus is applied.
     */
    function frequency(memory) {
        const base = 1 - Math.exp(-memory.accessCount / 5);
        if (memory.accessCount <= 1)
            return base;
        const lastActive = memory.accessCount > 0 ? memory.lastAccessedAt : memory.createdAt;
        const accessSpanDays = Math.max(1, (lastActive - memory.createdAt) / MS_PER_DAY);
        const avgGapDays = accessSpanDays / Math.max(memory.accessCount - 1, 1);
        const recentnessBonus = Math.exp(-avgGapDays / 30);
        return base * (0.5 + 0.5 * recentnessBonus);
    }
    /**
     * Intrinsic value: importance × confidence.
     */
    function intrinsic(memory) {
        return memory.importance * memory.confidence;
    }
    function scoreOne(memory, now) {
        const r = recency(memory, now);
        const f = frequency(memory);
        const i = intrinsic(memory);
        const composite = rw * r + fw * f + iw * i;
        return {
            memoryId: memory.id,
            recency: r,
            frequency: f,
            intrinsic: i,
            composite,
        };
    }
    return {
        score(memory, now = Date.now()) {
            return scoreOne(memory, now);
        },
        scoreAll(memories, now = Date.now()) {
            return memories.map((m) => scoreOne(m, now));
        },
        applySearchBoost(results, now = Date.now()) {
            for (const r of results) {
                const ds = scoreOne(r.memory, now);
                const tierFloor = Math.max(getTierFloor(r.memory.tier), ds.composite);
                const multiplier = boostMin + ((1 - boostMin) * tierFloor);
                r.score *= Math.min(1, Math.max(boostMin, multiplier));
            }
        },
        getStaleMemories(memories, now = Date.now()) {
            const scores = memories.map((m) => scoreOne(m, now));
            return scores
                .filter((s) => s.composite < staleThreshold)
                .sort((a, b) => a.composite - b.composite);
        },
    };
}
