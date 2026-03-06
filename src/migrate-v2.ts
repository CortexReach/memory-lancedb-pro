#!/usr/bin/env node
/**
 * LanceDB V1 → V2 遷移腳本
 *
 * 功能：
 * - 讀取現有 lanceDB 資料
 * - 補充新欄位（agentId、tags、redactStatus）
 * - 非破壞性遷移（失敗不影響原資料）
 *
 * 用法：
 *   npx tsx src/migrate.ts --db <lancedb-path> [--dry-run]
 */

import * as lancedb from '@lancedb/lancedb';
import * as path from 'path';
import * as fs from 'fs';
import {
  LanceDBMemoryV2,
  TYPE_TO_CATEGORY,
  normalizeImportance,
  validateLanceDBV2Record,
  LANCEDB_V2_SCHEMA,
  MemoryCategory,
} from './schema-v2';

// ============================================================================
// 配置
// ============================================================================

const DEFAULT_DB_PATH = 'C:\\Users\\User\\.openclaw\\memory\\lancedb-pro';
const V1_TABLE_NAME = 'memories';
const V2_TABLE_NAME = LANCEDB_V2_SCHEMA.tableName;
const BATCH_SIZE = 100;

// ============================================================================
// CLI 參數解析
// ============================================================================

interface MigrateOptions {
  dbPath: string;
  dryRun: boolean;
  verbose: boolean;
}

function parseArgs(): MigrateOptions {
  const args = process.argv.slice(2);
  const options: MigrateOptions = {
    dbPath: DEFAULT_DB_PATH,
    dryRun: false,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--db':
      case '-d':
        options.dbPath = args[++i];
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--verbose':
      case '-v':
        options.verbose = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
    }
  }

  return options;
}

function printHelp(): void {
  console.log(`
LanceDB V1 → V2 遷移工具

用法：
  npx tsx src/migrate.ts [選項]

選項：
  --db, -d <path>    LanceDB 資料庫路徑 (預設: ${DEFAULT_DB_PATH})
  --dry-run          僅模擬遷移，不實際寫入
  --verbose, -v      顯示詳細輸出
  --help, -h         顯示此說明

範例：
  npx tsx src/migrate.ts --dry-run
  npx tsx src/migrate.ts --db ./my-memories.lance
`);
}

// ============================================================================
// 遷移結果
// ============================================================================

interface MigrationResult {
  success: boolean;
  migrated: number;
  skipped: number;
  failed: number;
  errors: string[];
  duration: number;
}

// ============================================================================
// V1 記錄格式（可能的結構）
// ============================================================================

interface LanceDBMemoryV1 {
  id?: string;
  text?: string;
  vector?: number[];
  embedding?: number[];

  // 現有格式（較新）
  category?: string;
  scope?: string;
  importance?: number;
  timestamp?: number | string | Date;
  metadata?: string;

  // 舊格式
  type?: string;
  agentId?: string;
  tags?: string | string[];
  redacted?: boolean;
  source?: string;
  createdAt?: number | string | Date;

  // 可能的嵌套 meta
  meta?: {
    type?: string;
    importance?: number;
    agentId?: string;
    tags?: string[];
    redacted?: boolean;
    source?: string;
    createdAt?: Date | string | number;
  };
}

// ============================================================================
// 遷移邏輯
// ============================================================================

/**
 * 將 V1 記錄轉換為 V2 格式
 */
function convertV1ToV2(v1: LanceDBMemoryV1, index: number): LanceDBMemoryV2 | null {
  try {
    // 提取 ID
    const id = v1.id || `migrated_${Date.now()}_${index}`;

    // 提取文字
    const text = v1.text;
    if (!text) {
      throw new Error('Missing text field');
    }

    // 提取向量（可能是 Arrow Vector 或 Array）
    const rawVector = v1.vector || v1.embedding;
    if (!rawVector) {
      throw new Error('Missing vector/embedding field');
    }

    // 轉換 Arrow Vector 為普通陣列
    let vector: number[];
    if (Array.isArray(rawVector)) {
      vector = rawVector;
    } else if (rawVector.toArray) {
      // Arrow Vector 有 toArray 方法
      vector = Array.from(rawVector.toArray());
    } else if (rawVector.length !== undefined) {
      // 有 length 屬性，嘗試迭代
      vector = Array.from({ length: rawVector.length }, (_, i) =>
        typeof rawVector.get === 'function' ? rawVector.get(i) : rawVector[i]
      );
    } else {
      throw new Error('Invalid vector format');
    }

    // 提取 agentId（多種可能來源）
    // 現有格式可能沒有 agentId，從 scope 或 metadata 推斷
    let agentId = v1.agentId || v1.meta?.agentId;
    if (!agentId && v1.metadata) {
      try {
        const meta = JSON.parse(v1.metadata);
        agentId = meta.agentId || meta.agent;
      } catch {}
    }
    agentId = agentId || (v1.scope === 'global' ? 'shared' : 'legacy');

    // 提取 category
    // 現有格式已經有 category，直接使用
    let category: MemoryCategory;
    if (v1.category && ['fact', 'decision', 'entity', 'other'].includes(v1.category)) {
      category = v1.category as MemoryCategory;
    } else {
      const type = v1.type || v1.meta?.type || 'long-term';
      category = TYPE_TO_CATEGORY[type] || 'other';
    }

    // 提取 redactStatus
    let redactStatus = 0;
    if (typeof v1.redacted === 'boolean') {
      redactStatus = v1.redacted ? 1 : 0;
    } else if (v1.meta?.redacted) {
      redactStatus = 1;
    }

    // 提取 importance（現有格式已是 0-1）
    let importance = 0.5;
    if (typeof v1.importance === 'number') {
      // 如果 > 1，假設是 0-5 範圍
      importance = v1.importance > 1 ? normalizeImportance(v1.importance) : v1.importance;
    } else if (v1.meta?.importance !== undefined) {
      importance = normalizeImportance(v1.meta.importance);
    }

    // 提取 tags
    let tags: string[] = [];
    if (Array.isArray(v1.tags)) {
      tags = v1.tags;
    } else if (typeof v1.tags === 'string') {
      try {
        tags = JSON.parse(v1.tags);
      } catch {
        tags = v1.tags.split(',').map(t => t.trim()).filter(Boolean);
      }
    } else if (v1.meta?.tags) {
      tags = v1.meta.tags;
    } else if (v1.metadata) {
      try {
        const meta = JSON.parse(v1.metadata);
        if (Array.isArray(meta.tags)) {
          tags = meta.tags;
        }
      } catch {}
    }

    // 提取 source
    let source = v1.source || v1.meta?.source || '';
    if (!source && v1.metadata) {
      try {
        const meta = JSON.parse(v1.metadata);
        source = meta.source || '';
      } catch {}
    }

    // 提取時間戳
    let createdAt: number;
    const rawTime = v1.timestamp || v1.createdAt || v1.meta?.createdAt;
    if (typeof rawTime === 'number') {
      createdAt = rawTime;
    } else if (rawTime instanceof Date) {
      createdAt = rawTime.getTime();
    } else if (typeof rawTime === 'string') {
      createdAt = new Date(rawTime).getTime();
    } else {
      createdAt = Date.now();
    }

    const now = Date.now();

    return {
      id,
      text,
      vector,
      agentId,
      category,
      redactStatus,
      importance,
      tags: JSON.stringify(tags),
      source,
      createdAt,
      updatedAt: now,
    };
  } catch (error) {
    console.error(`轉換錯誤 ${index}:`, error);
    return null;
  }
}

/**
 * 執行遷移
 */
async function migrate(options: MigrateOptions): Promise<MigrationResult> {
  const startTime = Date.now();
  const result: MigrationResult = {
    success: false,
    migrated: 0,
    skipped: 0,
    failed: 0,
    errors: [],
    duration: 0,
  };

  console.log('🚀 開始 LanceDB V1 → V2 遷移');
  console.log(`📂 資料庫路徑: ${options.dbPath}`);
  console.log(`🔍 模式: ${options.dryRun ? '模擬執行 (dry-run)' : '實際遷移'}`);
  console.log('');

  // 檢查資料庫路徑
  if (!fs.existsSync(options.dbPath)) {
    result.errors.push(`資料庫路徑不存在: ${options.dbPath}`);
    console.error(`❌ ${result.errors[0]}`);
    return result;
  }

  try {
    // 連接資料庫
    console.log('📡 連接 LanceDB...');
    const db = await lancedb.connect(options.dbPath);

    // 列出所有表
    const tables = await db.tableNames();
    console.log(`📋 發現資料表: ${tables.join(', ') || '(無)'}`);

    // 檢查 V1 表是否存在
    if (!tables.includes(V1_TABLE_NAME)) {
      result.errors.push(`找不到 V1 資料表: ${V1_TABLE_NAME}`);
      console.error(`❌ ${result.errors[0]}`);
      return result;
    }

    // 檢查 V2 表是否已存在
    const v2Exists = tables.includes(V2_TABLE_NAME);
    if (v2Exists && !options.dryRun) {
      console.log(`⚠️  V2 資料表已存在，將追加資料`);
    }

    // 開啟 V1 表
    const v1Table = await db.openTable(V1_TABLE_NAME);

    // 讀取所有 V1 記錄
    console.log('📖 讀取 V1 記錄...');
    const v1Records = await v1Table.query().toArray() as LanceDBMemoryV1[];
    console.log(`📊 找到 ${v1Records.length} 筆記錄`);

    if (v1Records.length === 0) {
      console.log('ℹ️  沒有資料需要遷移');
      result.success = true;
      result.duration = Date.now() - startTime;
      return result;
    }

    // 轉換記錄
    console.log('🔄 轉換記錄格式...');
    const v2Records: LanceDBMemoryV2[] = [];
    const existingIds = new Set<string>();

    // 如果 V2 表已存在，取得現有 ID
    if (v2Exists) {
      const v2Table = await db.openTable(V2_TABLE_NAME);
      const existing = await v2Table.query().select(['id']).toArray();
      existing.forEach((r: any) => existingIds.add(r.id));
      console.log(`📋 V2 表已有 ${existingIds.size} 筆記錄`);
    }

    for (let i = 0; i < v1Records.length; i++) {
      const v1 = v1Records[i];

      // 跳過已存在的記錄
      if (v1.id && existingIds.has(v1.id)) {
        result.skipped++;
        if (options.verbose) {
          console.log(`⏭️  跳過已存在: ${v1.id}`);
        }
        continue;
      }

      const v2 = convertV1ToV2(v1, i);

      if (options.verbose && !v2) {
        console.log(`❌ 轉換失敗 ${i}: id=${v1.id}, text=${v1.text?.substring(0, 30)}`);
      }

      if (v2) {
        // 驗證記錄
        const validation = validateLanceDBV2Record(v2);
        if (validation.valid) {
          v2Records.push(v2);
          result.migrated++;
          if (options.verbose) {
            console.log(`✅ 轉換成功: ${v2.id} (${v2.category})`);
          }
        } else {
          result.failed++;
          result.errors.push(`記錄 ${v2.id} 驗證失敗: ${validation.errors.join(', ')}`);
        }
      } else {
        result.failed++;
        result.errors.push(`記錄 ${i} 轉換失敗`);
      }
    }

    console.log('');
    console.log('📊 轉換結果:');
    console.log(`   ✅ 成功: ${result.migrated}`);
    console.log(`   ⏭️  跳過: ${result.skipped}`);
    console.log(`   ❌ 失敗: ${result.failed}`);

    // 寫入 V2 表
    if (!options.dryRun && v2Records.length > 0) {
      console.log('');
      console.log('💾 寫入 V2 資料表...');

      // 轉換為 Record<string, unknown>[] 以符合 LanceDB API
      const recordsForDb = v2Records.map(r => ({ ...r } as Record<string, unknown>));

      if (v2Exists) {
        // 追加到現有表
        const v2Table = await db.openTable(V2_TABLE_NAME);
        for (let i = 0; i < recordsForDb.length; i += BATCH_SIZE) {
          const batch = recordsForDb.slice(i, i + BATCH_SIZE);
          await v2Table.add(batch);
          console.log(`   寫入批次 ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(recordsForDb.length / BATCH_SIZE)}`);
        }
      } else {
        // 建立新表
        await db.createTable(V2_TABLE_NAME, recordsForDb);
      }

      console.log(`✅ 已寫入 ${v2Records.length} 筆記錄到 ${V2_TABLE_NAME}`);
    } else if (options.dryRun) {
      console.log('');
      console.log('ℹ️  模擬執行完成，未實際寫入資料');
    }

    result.success = true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    result.errors.push(`遷移錯誤: ${msg}`);
    console.error(`❌ 遷移錯誤: ${msg}`);
  }

  result.duration = Date.now() - startTime;
  console.log('');
  console.log(`⏱️  耗時: ${(result.duration / 1000).toFixed(2)} 秒`);

  return result;
}

// ============================================================================
// 主程式
// ============================================================================

async function main(): Promise<void> {
  const options = parseArgs();

  try {
    const result = await migrate(options);

    if (result.success) {
      console.log('');
      console.log('🎉 遷移完成！');
      process.exit(0);
    } else {
      console.log('');
      console.log('⚠️  遷移完成但有錯誤:');
      result.errors.slice(0, 10).forEach(e => console.log(`   - ${e}`));
      if (result.errors.length > 10) {
        console.log(`   ... 還有 ${result.errors.length - 10} 個錯誤`);
      }
      process.exit(1);
    }
  } catch (error) {
    console.error('💥 致命錯誤:', error);
    process.exit(1);
  }
}

main();
