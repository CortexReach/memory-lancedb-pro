/**
 * Embedding-based Noise Prototype Bank
 *
 * Language-agnostic noise detection: maintains a bank of noise prototype
 * embeddings (recall queries, agent denials, greetings). Input texts are
 * compared via cosine similarity — no regex maintenance required.
 *
 * The bank starts with ~15 built-in multilingual prototypes and grows
 * automatically when the LLM extraction returns zero memories (feedback loop).
 */

import type { Embedder } from "./embedder.js";

// ============================================================================
// Built-in noise prototypes (multilingual)
// ============================================================================

const BUILTIN_NOISE_TEXTS: readonly string[] = [
    // Recall queries
    "Do you remember what I told you?",
    "Can you recall my preferences?",
    "What did I say about that?",
    "你还记得我喜欢什么吗",
    "你知道我之前说过什么吗",
    "記得我上次提到的嗎",
    "我之前跟你说过吗",
    // Agent denials
    "I don't have any information about that",
    "I don't recall any previous conversation",
    "我没有相关的记忆",
    // Greetings / boilerplate
    "Hello, how are you doing today?",
    "Hi there, what's up",
    "新的一天开始了",
];

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_THRESHOLD = 0.82;
const MAX_LEARNED_PROTOTYPES = 200;
const DEDUP_THRESHOLD = 0.95;

// ============================================================================
// NoisePrototypeBank
// ============================================================================

export class NoisePrototypeBank {
    private vectors: number[][] = [];
    private builtinCount = 0;
    private _initialized = false;
    private debugLog: (msg: string) => void;

    constructor(debugLog?: (msg: string) => void) {
        this.debugLog = debugLog ?? (() => { });
    }

    /** Whether the bank has been initialized with prototype embeddings. */
    get initialized(): boolean {
        return this._initialized;
    }

    /** Total number of prototypes (built-in + learned). */
    get size(): number {
        return this.vectors.length;
    }

    /**
     * Embed all built-in noise prototypes and cache their vectors.
     * Call once at plugin startup. Safe to call multiple times (no-op after first).
     */
    async init(embedder: Embedder): Promise<void> {
        if (this._initialized) return;

        for (const text of BUILTIN_NOISE_TEXTS) {
            try {
                const v = await embedder.embed(text);
                if (v && v.length > 0) this.vectors.push(v);
            } catch {
                // Skip failed embeddings — bank will work with whatever succeeds
            }
        }
        this.builtinCount = this.vectors.length;
        this._initialized = true;

        // Degeneracy check: if all prototype vectors are nearly identical, the
        // embedding model does not produce discriminative outputs (e.g. a
        // deterministic mock that ignores text).  In that case the noise bank
        // would flag every input as noise, so we disable ourselves.
        if (this.vectors.length >= 2) {
            const sim = cosine(this.vectors[0], this.vectors[1]);
            if (sim > 0.98) {
                this.debugLog(
                    `noise-prototype-bank: degenerate embeddings detected (pairwise cosine=${sim.toFixed(4)}), disabling noise filter`,
                );
                this._initialized = false;
                this.vectors = [];
                return;
            }
        }

        this.debugLog(
            `noise-prototype-bank: initialized with ${this.builtinCount} built-in prototypes`,
        );
    }

    /**
     * Check if a text vector matches any noise prototype.
     * Returns true if cosine similarity >= threshold with any prototype.
     */
    isNoise(textVector: number[], threshold = DEFAULT_THRESHOLD): boolean {
        if (!this._initialized || this.vectors.length === 0) return false;
        for (const proto of this.vectors) {
            if (cosine(proto, textVector) >= threshold) return true;
        }
        return false;
    }

    /**
     * LLM feedback: add a text vector to the learned noise bank.
     * Called when LLM extraction returns zero memories (strong noise signal).
     * Deduplicates against existing prototypes (>= 0.95 similarity = skip).
     * Evicts oldest learned prototype when bank exceeds MAX_LEARNED_PROTOTYPES.
     */
    learn(textVector: number[]): void {
        if (!this._initialized) return;

        // Deduplicate: too similar to an existing prototype → skip
        for (const proto of this.vectors) {
            if (cosine(proto, textVector) >= DEDUP_THRESHOLD) return;
        }

        this.vectors.push(textVector);

        // Evict oldest learned prototype if over limit (preserve built-in prototypes)
        if (this.vectors.length > this.builtinCount + MAX_LEARNED_PROTOTYPES) {
            this.vectors.splice(this.builtinCount, 1);
        }

        this.debugLog(
            `noise-prototype-bank: learned new noise prototype (total: ${this.vectors.length})`,
        );
    }
}

// ============================================================================
// Cosine Similarity
// ============================================================================

function cosine(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom === 0 ? 0 : dot / denom;
}
