/**
 * Frozen Snapshot Pattern for Memory Store
 * 
 * Captures a frozen snapshot of memory entries at session start.
 * Mid-session writes update disk but do NOT change the snapshot.
 * Snapshot refreshes on next session start.
 * 
 * Benefits:
 * - Stable system prompt injection (no mid-session changes)
 * - Prefix cache stability (better performance)
 * - Consistent context throughout session
 */

import type { MemoryEntry } from "./store.js";

// ============================================================================
// Types
// ============================================================================

export interface MemorySnapshot {
  /** Frozen snapshot of memory entries */
  memory: string;
  /** Frozen snapshot of user profile entries */
  user: string;
  /** Timestamp when snapshot was captured */
  capturedAt: number;
  /** Number of memory entries in snapshot */
  memoryCount: number;
  /** Number of user entries in snapshot */
  userCount: number;
}

export interface SnapshotConfig {
  /** Enable frozen snapshot pattern (default: true) */
  enabled: boolean;
  /** Auto-capture on session start (default: true) */
  autoCaptureOnSessionStart: boolean;
  /** Include usage statistics in snapshot header (default: true) */
  includeStats: boolean;
  /** Character limits for rendering */
  memoryCharLimit: number;
  userCharLimit: number;
}

export const DEFAULT_SNAPSHOT_CONFIG: SnapshotConfig = {
  enabled: true,
  autoCaptureOnSessionStart: true,
  includeStats: true,
  memoryCharLimit: 2200,
  userCharLimit: 1375,
};

// ============================================================================
// Frozen Snapshot Manager
// ============================================================================

export class FrozenSnapshotManager {
  private snapshot: MemorySnapshot | null = null;
  private config: SnapshotConfig;

  constructor(config: SnapshotConfig = DEFAULT_SNAPSHOT_CONFIG) {
    this.config = config;
  }

  /**
   * Capture a frozen snapshot from memory entries
   * Called at session start
   */
  capture(
    memoryEntries: MemoryEntry[],
    userEntries: MemoryEntry[]
  ): MemorySnapshot {
    if (!this.config.enabled) {
      // Return empty snapshot if disabled
      return {
        memory: "",
        user: "",
        capturedAt: Date.now(),
        memoryCount: 0,
        userCount: 0,
      };
    }

    const memoryBlock = this.renderBlock("memory", memoryEntries, this.config.memoryCharLimit);
    const userBlock = this.renderBlock("user", userEntries, this.config.userCharLimit);

    this.snapshot = {
      memory: memoryBlock,
      user: userBlock,
      capturedAt: Date.now(),
      memoryCount: memoryEntries.length,
      userCount: userEntries.length,
    };

    console.log(
      `[FrozenSnapshot] Captured snapshot: ${memoryEntries.length} memory entries, ${userEntries.length} user entries`
    );

    return this.snapshot;
  }

  /**
   * Get the frozen snapshot for system prompt injection
   * Returns null if no snapshot captured yet
   */
  getSnapshot(): MemorySnapshot | null {
    return this.snapshot;
  }

  /**
   * Get the memory block from snapshot
   * Used for system prompt injection
   */
  getMemoryBlock(): string {
    return this.snapshot?.memory || "";
  }

  /**
   * Get the user block from snapshot
   * Used for system prompt injection
   */
  getUserBlock(): string {
    return this.snapshot?.user || "";
  }

  /**
   * Check if snapshot has been captured
   */
  hasSnapshot(): boolean {
    return this.snapshot !== null;
  }

  /**
   * Clear the snapshot (for testing or session reset)
   */
  clear(): void {
    this.snapshot = null;
  }

  /**
   * Render a memory block for system prompt injection
   */
  private renderBlock(
    target: "memory" | "user",
    entries: MemoryEntry[],
    charLimit: number
  ): string {
    if (entries.length === 0) {
      return "";
    }

    const content = this.joinEntries(entries);
    const currentLength = content.length;
    const pct = charLimit > 0 ? Math.min(100, Math.round((currentLength / charLimit) * 100)) : 0;

    const header = this.buildHeader(target, pct, currentLength, charLimit);
    const separator = "═".repeat(46);

    return `${separator}\n${header}\n${separator}\n${content}`;
  }

  /**
   * Build header line with usage statistics
   */
  private buildHeader(
    target: "memory" | "user",
    pct: number,
    current: number,
    limit: number
  ): string {
    if (!this.config.includeStats) {
      return target === "user" ? "USER PROFILE" : "MEMORY";
    }

    const label = target === "user"
      ? "USER PROFILE (who the user is)"
      : "MEMORY (your personal notes)";

    return `${label} [${pct}% — ${current.toLocaleString()}/${limit.toLocaleString()} chars]`;
  }

  /**
   * Join entries with delimiter
   */
  private joinEntries(entries: MemoryEntry[]): string {
    return entries.map(entry => entry.text).join("\n§\n");
  }

  /**
   * Get snapshot statistics
   */
  getStats(): {
    hasSnapshot: boolean;
    capturedAt?: number;
    memoryCount?: number;
    userCount?: number;
    age?: number;
  } {
    if (!this.snapshot) {
      return { hasSnapshot: false };
    }

    return {
      hasSnapshot: true,
      capturedAt: this.snapshot.capturedAt,
      memoryCount: this.snapshot.memoryCount,
      userCount: this.snapshot.userCount,
      age: Date.now() - this.snapshot.capturedAt,
    };
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let globalSnapshotManager: FrozenSnapshotManager | null = null;

/**
 * Get or create the global snapshot manager
 */
export function getSnapshotManager(): FrozenSnapshotManager {
  if (!globalSnapshotManager) {
    globalSnapshotManager = new FrozenSnapshotManager(DEFAULT_SNAPSHOT_CONFIG);
  }
  return globalSnapshotManager;
}

/**
 * Reset global snapshot manager (for testing)
 */
export function resetSnapshotManager(): void {
  if (globalSnapshotManager) {
    globalSnapshotManager.clear();
    globalSnapshotManager = null;
  }
}

// ============================================================================
// Usage Examples
// ============================================================================

/**
 * Example: Session lifecycle with frozen snapshot
 */
export async function exampleSessionLifecycle() {
  const snapshotManager = getSnapshotManager();
  
  // Session start: capture snapshot
  const memoryEntries: MemoryEntry[] = [
    {
      id: 'mem1',
      text: 'User prefers tabs over spaces',
      vector: [0.1, 0.2, 0.3],
      category: 'preference',
      scope: 'user',
      importance: 0.8,
      timestamp: Date.now(),
    },
  ];
  
  const userEntries: MemoryEntry[] = [
    {
      id: 'user1',
      text: 'User is a software engineer',
      vector: [0.4, 0.5, 0.6],
      category: 'fact',
      scope: 'user',
      importance: 0.9,
      timestamp: Date.now(),
    },
  ];
  
  // Capture frozen snapshot
  snapshotManager.capture(memoryEntries, userEntries);
  
  // Throughout session: use frozen snapshot for system prompt
  const systemPromptMemory = snapshotManager.getMemoryBlock();
  const systemPromptUser = snapshotManager.getUserBlock();
  
  console.log('System Prompt Memory:', systemPromptMemory);
  console.log('System Prompt User:', systemPromptUser);
  
  // Mid-session: add new memory (updates disk, but NOT snapshot)
  // memoryEntries.push(newEntry);  // This won't affect system prompt
  
  // Next session: snapshot will be refreshed
}
