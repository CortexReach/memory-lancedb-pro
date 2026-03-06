/**
 * LanceDB Schema V2 - 新版記憶 Schema 定義
 * 支援 agentId/tags/redactStatus 欄位過濾
 */

import { Memory } from './types';

// ============================================================================
// Schema 定義
// ============================================================================

/**
 * LanceDB V2 表結構
 * 對應 Memory 介面，適配 LanceDB 的儲存格式
 */
export interface LanceDBMemoryV2 {
  // 主鍵
  id: string;

  // 核心內容
  text: string;
  vector: number[];  // embedding 向量

  // V2 新增：頂層過濾欄位（支援高效查詢）
  agentId: string;
  category: MemoryCategory;  // 從 meta.type 映射
  redactStatus: number;      // 0=未編輯, 1=已編輯, 2=待審核

  // 元數據（JSON 序列化）
  importance: number;        // 0-1 正規化（原本 0-5）
  tags: string;              // JSON 陣列字串
  source: string;            // 來源標識

  // 時間戳
  createdAt: number;         // Unix timestamp (ms)
  updatedAt: number;         // Unix timestamp (ms)
}

/**
 * 記憶分類（用於 Obsidian 資料夾映射）
 */
export type MemoryCategory = 'fact' | 'decision' | 'entity' | 'other';

/**
 * 舊版 meta.type 到新版 category 的映射
 */
export const TYPE_TO_CATEGORY: Record<string, MemoryCategory> = {
  'short-term': 'fact',
  'long-term': 'fact',
  'person': 'entity',
  'project': 'other',
  'summary': 'decision',
};

// ============================================================================
// 轉換函數
// ============================================================================

/**
 * 將 Memory 轉換為 LanceDBMemoryV2 格式
 */
export function memoryToLanceDBV2(memory: Memory, embedding: number[]): LanceDBMemoryV2 {
  const category = TYPE_TO_CATEGORY[memory.meta.type] || 'other';
  const now = Date.now();

  return {
    id: memory.id,
    text: memory.text,
    vector: embedding,

    // 頂層過濾欄位
    agentId: memory.agentId || memory.meta.agentId || 'unknown',
    category,
    redactStatus: memory.redactStatus ?? (memory.meta.redacted ? 1 : 0),

    // 元數據
    importance: normalizeImportance(memory.meta.importance),
    tags: JSON.stringify(memory.meta.tags || []),
    source: memory.meta.source || '',

    // 時間戳
    createdAt: memory.meta.createdAt instanceof Date
      ? memory.meta.createdAt.getTime()
      : now,
    updatedAt: now,
  };
}

/**
 * 將 LanceDBMemoryV2 轉換回 Memory 格式
 */
export function lanceDBV2ToMemory(record: LanceDBMemoryV2): Memory {
  const tags = parseTags(record.tags);
  const createdAt = new Date(record.createdAt);

  return {
    id: record.id,
    text: record.text,
    embedding: record.vector,

    meta: {
      type: categoryToType(record.category),
      importance: denormalizeImportance(record.importance),
      agentId: record.agentId,
      createdAt,
      tags,
      redacted: record.redactStatus > 0,
      source: record.source || undefined,
    },

    timestamp: createdAt,
    agentId: record.agentId,
    redactStatus: record.redactStatus,
  };
}

// ============================================================================
// 輔助函數
// ============================================================================

/**
 * 正規化重要性分數 (0-5 → 0-1)
 */
export function normalizeImportance(importance: number): number {
  if (importance <= 1) return importance; // 已經是 0-1 範圍
  return Math.min(1, Math.max(0, importance / 5));
}

/**
 * 反正規化重要性分數 (0-1 → 0-5)
 */
export function denormalizeImportance(importance: number): number {
  return Math.round(importance * 5);
}

/**
 * 解析 tags JSON 字串
 */
export function parseTags(tagsJson: string): string[] {
  if (!tagsJson) return [];
  try {
    const parsed = JSON.parse(tagsJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * category 轉回 meta.type
 */
function categoryToType(category: MemoryCategory): Memory['meta']['type'] {
  switch (category) {
    case 'fact': return 'long-term';
    case 'decision': return 'summary';
    case 'entity': return 'person';
    case 'other': return 'project';
    default: return 'long-term';
  }
}

// ============================================================================
// Schema 驗證
// ============================================================================

/**
 * 驗證 LanceDBMemoryV2 記錄是否完整
 */
export function validateLanceDBV2Record(record: Partial<LanceDBMemoryV2>): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!record.id) errors.push('id is required');
  if (!record.text) errors.push('text is required');
  if (!record.vector || !Array.isArray(record.vector)) {
    errors.push('vector is required and must be an array');
  }
  if (!record.agentId) errors.push('agentId is required');
  if (!record.category) errors.push('category is required');
  if (typeof record.redactStatus !== 'number') {
    errors.push('redactStatus must be a number');
  }
  if (typeof record.importance !== 'number') {
    errors.push('importance must be a number');
  }
  if (typeof record.createdAt !== 'number') {
    errors.push('createdAt must be a Unix timestamp');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * LanceDB 表的 Schema 定義（用於建表）
 */
export const LANCEDB_V2_SCHEMA = {
  tableName: 'memories_v2',
  columns: {
    id: 'string',
    text: 'string',
    vector: 'vector[1024]',  // bge-m3 維度
    agentId: 'string',
    category: 'string',
    redactStatus: 'int32',
    importance: 'float32',
    tags: 'string',
    source: 'string',
    createdAt: 'int64',
    updatedAt: 'int64',
  },
  indices: ['agentId', 'category', 'redactStatus', 'createdAt'],
};
