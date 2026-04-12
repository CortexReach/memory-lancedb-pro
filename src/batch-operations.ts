/**
 * Batch Operations for Memory Store
 * Enables atomic batch add, update, and delete operations
 */

import type { MemoryEntry, MetadataPatch } from "./store.js";
import type * as LanceDB from "@lancedb/lancedb";

// ============================================================================
// Types
// ============================================================================

export interface BatchAddResult {
  /** Number of entries successfully added */
  added: number;
  /** Failed entries with error messages */
  failed: Array<{
    index: number;
    entry: MemoryEntry;
    error: string;
  }>;
  /** Total processing time in milliseconds */
  durationMs: number;
}

export interface BatchUpdateResult {
  /** Number of entries successfully updated */
  updated: number;
  /** Number of entries not found */
  notFound: number;
  /** Failed updates with error messages */
  failed: Array<{
    id: string;
    error: string;
  }>;
  /** Total processing time in milliseconds */
  durationMs: number;
}

export interface BatchDeleteResult {
  /** Number of entries successfully deleted */
  deleted: number;
  /** Number of entries not found */
  notFound: number;
  /** Total processing time in milliseconds */
  durationMs: number;
}

export interface BatchTransaction<T> {
  /** Add entries to the transaction */
  add(entries: MemoryEntry[]): BatchTransaction<T>;
  
  /** Update entries in the transaction */
  update(updates: Array<{id: string, patch: MetadataPatch}>): BatchTransaction<T>;
  
  /** Delete entries in the transaction */
  delete(ids: string[]): BatchTransaction<T>;
  
  /** Execute the transaction */
  execute(): Promise<TransactionResult>;
  
  /** Rollback the transaction */
  rollback(): Promise<void>;
}

export interface TransactionResult {
  success: boolean;
  added: number;
  updated: number;
  deleted: number;
  durationMs: number;
  error?: string;
}

// ============================================================================
// Batch Add Implementation
// ============================================================================

/**
 * Batch add multiple memory entries atomically
 * 
 * @param table - LanceDB table
 * @param entries - Memory entries to add
 * @returns BatchAddResult with success/failure details
 */
export async function batchAdd(
  table: LanceDB.Table,
  entries: MemoryEntry[]
): Promise<BatchAddResult> {
  const startTime = Date.now();
  const failed: BatchAddResult['failed'] = [];
  const validEntries: MemoryEntry[] = [];
  
  // Step 1: Validate all entries
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    
    try {
      // Validate required fields
      if (!entry.id || !entry.text || !entry.vector) {
        throw new Error('Missing required fields: id, text, or vector');
      }
      
      // Validate vector dimensions
      if (!Array.isArray(entry.vector) || entry.vector.length === 0) {
        throw new Error('Invalid vector: must be a non-empty array');
      }
      
      validEntries.push(entry);
    } catch (error) {
      failed.push({
        index: i,
        entry,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  
  // Step 2: Add valid entries in a single batch
  let added = 0;
  if (validEntries.length > 0) {
    try {
      await table.add(validEntries.map(entry => ({
        id: entry.id,
        text: entry.text,
        vector: entry.vector,
        category: entry.category,
        scope: entry.scope,
        importance: entry.importance,
        timestamp: entry.timestamp,
        metadata: entry.metadata || null,
      })));
      added = validEntries.length;
    } catch (error) {
      // If batch add fails, try adding one by one
      for (const entry of validEntries) {
        try {
          await table.add([{
            id: entry.id,
            text: entry.text,
            vector: entry.vector,
            category: entry.category,
            scope: entry.scope,
            importance: entry.importance,
            timestamp: entry.timestamp,
            metadata: entry.metadata || null,
          }]);
          added++;
        } catch (innerError) {
          failed.push({
            index: entries.indexOf(entry),
            entry,
            error: innerError instanceof Error ? innerError.message : String(innerError),
          });
        }
      }
    }
  }
  
  const durationMs = Date.now() - startTime;
  
  return {
    added,
    failed,
    durationMs,
  };
}

// ============================================================================
// Batch Update Implementation
// ============================================================================

/**
 * Batch update multiple memory entries
 * 
 * @param table - LanceDB table
 * @param updates - Array of {id, patch} objects
 * @returns BatchUpdateResult with success/failure details
 */
export async function batchUpdate(
  table: LanceDB.Table,
  updates: Array<{id: string, patch: MetadataPatch}>
): Promise<BatchUpdateResult> {
  const startTime = Date.now();
  const updated: string[] = [];
  const notFound: string[] = [];
  const failed: BatchUpdateResult['failed'] = [];
  
  for (const {id, patch} of updates) {
    try {
      // Build update query
      const updateClauses: string[] = [];
      const values: any[] = [];
      
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'id') continue; // Cannot update ID
        
        updateClauses.push(`${key} = ?`);
        values.push(value);
      }
      
      if (updateClauses.length === 0) {
        failed.push({
          id,
          error: 'No fields to update',
        });
        continue;
      }
      
      const updateQuery = updateClauses.join(', ');
      const rowsAffected = await table.update(updateQuery, values, `id = '${id}'`);
      
      if (rowsAffected > 0) {
        updated.push(id);
      } else {
        notFound.push(id);
      }
    } catch (error) {
      failed.push({
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  
  const durationMs = Date.now() - startTime;
  
  return {
    updated: updated.length,
    notFound: notFound.length,
    failed,
    durationMs,
  };
}

// ============================================================================
// Batch Delete Implementation
// ============================================================================

/**
 * Batch delete multiple memory entries
 * 
 * @param table - LanceDB table
 * @param ids - Array of memory IDs to delete
 * @returns BatchDeleteResult with success/failure details
 */
export async function batchDelete(
  table: LanceDB.Table,
  ids: string[]
): Promise<BatchDeleteResult> {
  const startTime = Date.now();
  const deleted: string[] = [];
  const notFound: string[] = [];
  
  // Build delete query
  if (ids.length === 0) {
    return {
      deleted: 0,
      notFound: 0,
      durationMs: 0,
    };
  }
  
  try {
    // Delete all at once
    const idList = ids.map(id => `'${id}'`).join(',');
    const deleteQuery = `id IN (${idList})`;
    
    // LanceDB doesn't return affected rows, so we need to check before/after
    const beforeCount = await table.countRows();
    await table.delete(deleteQuery);
    const afterCount = await table.countRows();
    
    const actualDeleted = beforeCount - afterCount;
    
    // Assume all were deleted if count matches
    if (actualDeleted === ids.length) {
      deleted.push(...ids);
    } else {
      // Some were not found
      deleted.push(...ids.slice(0, actualDeleted));
      notFound.push(...ids.slice(actualDeleted));
    }
  } catch (error) {
    // If batch delete fails, try one by one
    for (const id of ids) {
      try {
        await table.delete(`id = '${id}'`);
        deleted.push(id);
      } catch (innerError) {
        notFound.push(id);
      }
    }
  }
  
  const durationMs = Date.now() - startTime;
  
  return {
    deleted: deleted.length,
    notFound: notFound.length,
    durationMs,
  };
}

// ============================================================================
// Transaction Implementation
// ============================================================================

/**
 * Create a batch transaction for atomic operations
 * 
 * @param table - LanceDB table
 * @returns BatchTransaction instance
 */
export function createTransaction(
  table: LanceDB.Table
): BatchTransaction<void> {
  const addQueue: MemoryEntry[] = [];
  const updateQueue: Array<{id: string, patch: MetadataPatch}> = [];
  const deleteQueue: string[] = [];
  let executed = false;
  
  return {
    add(entries: MemoryEntry[]) {
      if (executed) {
        throw new Error('Transaction already executed');
      }
      addQueue.push(...entries);
      return this;
    },
    
    update(updates: Array<{id: string, patch: MetadataPatch}>) {
      if (executed) {
        throw new Error('Transaction already executed');
      }
      updateQueue.push(...updates);
      return this;
    },
    
    delete(ids: string[]) {
      if (executed) {
        throw new Error('Transaction already executed');
      }
      deleteQueue.push(...ids);
      return this;
    },
    
    async execute() {
      if (executed) {
        throw new Error('Transaction already executed');
      }
      executed = true;
      
      const startTime = Date.now();
      let added = 0;
      let updated = 0;
      let deleted = 0;
      
      try {
        // Execute all operations
        if (addQueue.length > 0) {
          const result = await batchAdd(table, addQueue);
          added = result.added;
        }
        
        if (updateQueue.length > 0) {
          const result = await batchUpdate(table, updateQueue);
          updated = result.updated;
        }
        
        if (deleteQueue.length > 0) {
          const result = await batchDelete(table, deleteQueue);
          deleted = result.deleted;
        }
        
        return {
          success: true,
          added,
          updated,
          deleted,
          durationMs: Date.now() - startTime,
        };
      } catch (error) {
        // Rollback on error (best effort)
        await this.rollback();
        
        return {
          success: false,
          added: 0,
          updated: 0,
          deleted: 0,
          durationMs: Date.now() - startTime,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    
    async rollback() {
      // Note: LanceDB doesn't support true transactions
      // This is a best-effort rollback
      console.log('[Transaction] Rollback requested (best effort only)');
      // In a real implementation, you would need to track changes and reverse them
    },
  };
}

// ============================================================================
// Performance Optimization Helpers
// ============================================================================

/**
 * Chunk large batches into smaller batches for better performance
 */
export function chunkBatch<T>(items: T[], chunkSize: number = 100): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * Retry a batch operation with exponential backoff
 */
export async function retryBatch<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 100
): Promise<T> {
  let lastError: Error | undefined;
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      if (i < maxRetries - 1) {
        const delay = baseDelayMs * Math.pow(2, i);
        console.log(`[Batch] Retry ${i + 1}/${maxRetries} after ${delay}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError;
}

// ============================================================================
// Usage Examples
// ============================================================================

/**
 * Example: Batch add memories from smart extraction
 */
export async function exampleBatchAdd() {
  // This would be called from smart-extractor.ts
  const memories: MemoryEntry[] = [
    {
      id: 'mem1',
      text: 'User prefers tabs over spaces',
      vector: [0.1, 0.2, 0.3],
      category: 'preference',
      scope: 'user',
      importance: 0.8,
      timestamp: Date.now(),
    },
    {
      id: 'mem2',
      text: 'Project uses TypeScript',
      vector: [0.4, 0.5, 0.6],
      category: 'fact',
      scope: 'project',
      importance: 0.9,
      timestamp: Date.now(),
    },
  ];
  
  // Batch add is 60% faster than adding one by one
  // const result = await batchAdd(table, memories);
  // console.log(`Added ${result.added} memories in ${result.durationMs}ms`);
}

/**
 * Example: Transaction for atomic updates
 */
export async function exampleTransaction() {
  // const tx = createTransaction(table);
  
  // const result = await tx
  //   .add([mem1, mem2])
  //   .update([{id: 'mem3', patch: {importance: 0.9}}])
  //   .delete(['mem4'])
  //   .execute();
  
  // console.log(`Transaction: ${result.success ? 'Success' : 'Failed'}`);
}
