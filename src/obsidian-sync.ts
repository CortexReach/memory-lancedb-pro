#!/usr/bin/env node
/**
 * Obsidian Sync - LanceDB 記憶匯出為 Obsidian Markdown
 *
 * 功能：
 * - 從 LanceDB 讀取記憶
 * - 依 category 分類到資料夾
 * - 產生 Markdown 筆記（含 frontmatter 與 wikilinks）
 *
 * 用法：
 *   npx tsx src/obsidian-sync.ts --vault <vault-path> [選項]
 */

import * as lancedb from '@lancedb/lancedb';
import * as path from 'path';
import * as fs from 'fs';
import {
  MemoryCategory,
  parseTags,
  LANCEDB_V2_SCHEMA,
} from './schema-v2';

/**
 * 資料庫記錄格式（兼容 V1 和 V2）
 */
interface DBRecord {
  id: string;
  text: string;
  category?: string;
  importance?: number;
  timestamp?: number;
  createdAt?: number;
  agentId?: string;
  tags?: string;
  metadata?: string;
  scope?: string;
}

// ============================================================================
// 配置
// ============================================================================

const DEFAULT_DB_PATH = 'C:\\Users\\User\\.openclaw\\memory\\lancedb-pro';
const DEFAULT_VAULT_PATH = 'G:\\Memory';
const AI_MEMORY_FOLDER = '00-AI-Memory';

/** 分類到資料夾的映射 */
const CATEGORY_FOLDERS: Record<MemoryCategory, string> = {
  fact: '01-Facts',
  decision: '02-Decisions',
  entity: '03-People',
  other: '04-Projects',
};

/** 自動提取 wikilinks 的關鍵詞 */
const WIKILINK_KEYWORDS = [
  'Piku',
  '餅乾工廠',
  'n8n',
  'LINE Bot',
  'Firebase',
  'Supabase',
  'LanceDB',
  'Obsidian',
  'Claude',
  'Nova',
  'Nancy',
  'OpenClaw',
  'Ollama',
  'bge-m3',
  'Jina',
  'SiliconFlow',
  'Evolver',
  'GEP',
];

// ============================================================================
// CLI 參數解析
// ============================================================================

interface SyncOptions {
  dbPath: string;
  vaultPath: string;
  dryRun: boolean;
  verbose: boolean;
  since?: Date;
  category?: MemoryCategory;
  agentId?: string;
  clean: boolean;
}

function parseArgs(): SyncOptions {
  const args = process.argv.slice(2);
  const options: SyncOptions = {
    dbPath: DEFAULT_DB_PATH,
    vaultPath: DEFAULT_VAULT_PATH,
    dryRun: false,
    verbose: false,
    clean: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--vault':
      case '-o':
        options.vaultPath = args[++i];
        break;
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
      case '--since':
        options.since = new Date(args[++i]);
        break;
      case '--category':
      case '-c':
        options.category = args[++i] as MemoryCategory;
        break;
      case '--agent':
      case '-a':
        options.agentId = args[++i];
        break;
      case '--clean':
        options.clean = true;
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
Obsidian Sync - LanceDB 記憶匯出工具

用法：
  npx tsx src/obsidian-sync.ts --vault <vault-path> [選項]

選項：
  --vault, -o <path>    Obsidian Vault 路徑 (預設: ${DEFAULT_VAULT_PATH})
  --db, -d <path>       LanceDB 資料庫路徑 (預設: ${DEFAULT_DB_PATH})
  --dry-run             僅模擬匯出，不實際寫入
  --verbose, -v         顯示詳細輸出
  --since <date>        只匯出此日期之後的記憶 (ISO 格式)
  --category, -c <cat>  只匯出指定分類 (fact/decision/entity/other)
  --agent, -a <id>      只匯出指定 Agent 的記憶
  --clean               清除現有匯出後重新匯出
  --help, -h            顯示此說明

範例：
  npx tsx src/obsidian-sync.ts --vault "G:\\Memory"
  npx tsx src/obsidian-sync.ts --vault "G:\\Memory" --category fact --dry-run
  npx tsx src/obsidian-sync.ts --vault "G:\\Memory" --since 2025-01-01 --agent nova
`);
}

// ============================================================================
// 同步結果
// ============================================================================

interface SyncResult {
  success: boolean;
  exported: number;
  skipped: number;
  failed: number;
  errors: string[];
  filePaths: string[];
  duration: number;
}

// ============================================================================
// Markdown 產生
// ============================================================================

/**
 * 從文字中提取 wikilinks
 */
function extractWikilinks(text: string): string[] {
  const found: string[] = [];

  for (const keyword of WIKILINK_KEYWORDS) {
    // 使用正則匹配完整單詞（考慮中文）
    const pattern = new RegExp(escapeRegex(keyword), 'gi');
    if (pattern.test(text)) {
      found.push(keyword);
    }
  }

  return Array.from(new Set(found)); // 去重
}

/**
 * 跳脫正則特殊字元
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 將文字中的關鍵詞轉為 wikilinks
 */
function addWikilinksToText(text: string): string {
  let result = text;

  for (const keyword of WIKILINK_KEYWORDS) {
    const pattern = new RegExp(`(?<!\\[\\[)${escapeRegex(keyword)}(?!\\]\\])`, 'g');
    result = result.replace(pattern, `[[${keyword}]]`);
  }

  return result;
}

/**
 * 產生安全的檔案名稱
 */
function sanitizeFilename(text: string, maxLength: number = 40): string {
  // 取前 N 個字元
  let name = text.substring(0, maxLength);

  // 移除或替換不安全字元
  name = name
    .replace(/[<>:"/\\|?*]/g, '')  // 移除 Windows 不允許的字元
    .replace(/[\r\n\t]/g, ' ')      // 換行變空格
    .replace(/\s+/g, ' ')           // 合併多空格
    .trim();

  // 確保不為空
  if (!name) {
    name = 'untitled';
  }

  return name;
}

/**
 * 格式化日期為 ISO 格式
 */
function formatDate(timestamp: number | string | undefined): string {
  if (!timestamp) return new Date().toISOString().split('T')[0];
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return new Date().toISOString().split('T')[0];
  return d.toISOString().split('T')[0];
}

/**
 * 產生 Markdown 筆記內容
 */
function generateMarkdown(record: LanceDBMemoryV2): string {
  const tags = parseTags(record.tags);
  const wikilinks = extractWikilinks(record.text);
  const textWithLinks = addWikilinksToText(record.text);

  // Frontmatter
  const frontmatter = [
    '---',
    `id: ${record.id}`,
    `category: ${record.category}`,
    `importance: ${record.importance.toFixed(2)}`,
    `created: ${formatDate(record.createdAt)}`,
    `tags: [${tags.join(', ')}]`,
    `agent: ${record.agentId}`,
    '---',
  ].join('\n');

  // 標題（前 40 字）
  const title = sanitizeFilename(record.text, 40);

  // 內容
  const content = textWithLinks;

  // Related（wikilinks）
  const related = wikilinks.length > 0
    ? `\n## Related\n${wikilinks.map(w => `[[${w}]]`).join(' ')}`
    : '';

  return `${frontmatter}

# ${title}

${content}
${related}
`;
}

// ============================================================================
// 同步邏輯
// ============================================================================

/**
 * 確保資料夾存在
 */
function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * 執行同步
 */
async function sync(options: SyncOptions): Promise<SyncResult> {
  const startTime = Date.now();
  const result: SyncResult = {
    success: false,
    exported: 0,
    skipped: 0,
    failed: 0,
    errors: [],
    filePaths: [],
    duration: 0,
  };

  console.log('🔄 開始 Obsidian 同步');
  console.log(`📂 LanceDB: ${options.dbPath}`);
  console.log(`📁 Vault: ${options.vaultPath}`);
  console.log(`🔍 模式: ${options.dryRun ? '模擬執行 (dry-run)' : '實際匯出'}`);
  console.log('');

  // 檢查資料庫路徑
  if (!fs.existsSync(options.dbPath)) {
    result.errors.push(`資料庫路徑不存在: ${options.dbPath}`);
    console.error(`❌ ${result.errors[0]}`);
    return result;
  }

  // 檢查 Vault 路徑
  if (!fs.existsSync(options.vaultPath)) {
    result.errors.push(`Vault 路徑不存在: ${options.vaultPath}`);
    console.error(`❌ ${result.errors[0]}`);
    return result;
  }

  try {
    // 連接資料庫
    console.log('📡 連接 LanceDB...');
    const db = await lancedb.connect(options.dbPath);

    // 確認 V2 表存在
    const tables = await db.tableNames();
    const tableName = tables.includes(LANCEDB_V2_SCHEMA.tableName)
      ? LANCEDB_V2_SCHEMA.tableName
      : 'memories';

    console.log(`📋 使用資料表: ${tableName}`);

    const table = await db.openTable(tableName);

    // 讀取記錄
    console.log('📖 讀取記憶...');
    let records = await table.query().toArray() as LanceDBMemoryV2[];
    console.log(`📊 找到 ${records.length} 筆記錄`);

    // 應用過濾條件
    if (options.since) {
      const sinceTs = options.since.getTime();
      records = records.filter(r => r.createdAt >= sinceTs);
      console.log(`📅 過濾後: ${records.length} 筆 (since ${options.since.toISOString()})`);
    }

    if (options.category) {
      records = records.filter(r => r.category === options.category);
      console.log(`🏷️  過濾後: ${records.length} 筆 (category=${options.category})`);
    }

    if (options.agentId) {
      records = records.filter(r => r.agentId === options.agentId);
      console.log(`🤖 過濾後: ${records.length} 筆 (agent=${options.agentId})`);
    }

    if (records.length === 0) {
      console.log('ℹ️  沒有符合條件的記憶');
      result.success = true;
      result.duration = Date.now() - startTime;
      return result;
    }

    // 建立目標資料夾
    const baseDir = path.join(options.vaultPath, AI_MEMORY_FOLDER);

    if (!options.dryRun) {
      ensureDir(baseDir);
      for (const folder of Object.values(CATEGORY_FOLDERS)) {
        ensureDir(path.join(baseDir, folder));
      }
      console.log(`📁 已建立資料夾結構: ${baseDir}`);
    }

    // 清除現有檔案（如果要求）
    if (options.clean && !options.dryRun) {
      console.log('🧹 清除現有匯出...');
      for (const folder of Object.values(CATEGORY_FOLDERS)) {
        const folderPath = path.join(baseDir, folder);
        if (fs.existsSync(folderPath)) {
          const files = fs.readdirSync(folderPath);
          for (const file of files) {
            if (file.endsWith('.md')) {
              fs.unlinkSync(path.join(folderPath, file));
            }
          }
        }
      }
    }

    // 追蹤已存在的檔案（用於跳過）
    const existingFiles = new Set<string>();
    if (!options.clean) {
      for (const folder of Object.values(CATEGORY_FOLDERS)) {
        const folderPath = path.join(baseDir, folder);
        if (fs.existsSync(folderPath)) {
          const files = fs.readdirSync(folderPath);
          files.forEach(f => existingFiles.add(f));
        }
      }
    }

    // 匯出記錄
    console.log('');
    console.log('📝 匯出記憶...');

    for (const record of records) {
      try {
        // 確定分類
        const category: MemoryCategory = record.category || 'other';
        const folder = CATEGORY_FOLDERS[category] || CATEGORY_FOLDERS.other;

        // 產生檔案名稱
        const filename = `${sanitizeFilename(record.text, 40)}-${record.id.substring(0, 8)}.md`;
        const filePath = path.join(baseDir, folder, filename);

        // 檢查是否已存在
        if (existingFiles.has(filename) && !options.clean) {
          result.skipped++;
          if (options.verbose) {
            console.log(`⏭️  跳過已存在: ${filename}`);
          }
          continue;
        }

        // 產生 Markdown
        const markdown = generateMarkdown(record);

        // 寫入檔案
        if (!options.dryRun) {
          fs.writeFileSync(filePath, markdown, 'utf-8');
        }

        result.exported++;
        result.filePaths.push(filePath);

        if (options.verbose) {
          console.log(`✅ 匯出: ${folder}/${filename}`);
        }
      } catch (error) {
        result.failed++;
        const msg = error instanceof Error ? error.message : String(error);
        result.errors.push(`匯出 ${record.id} 失敗: ${msg}`);
        if (options.verbose) {
          console.log(`❌ 匯出失敗: ${record.id} - ${msg}`);
        }
      }
    }

    // 產生索引檔案
    if (!options.dryRun && result.exported > 0) {
      const indexContent = generateIndexFile(records, baseDir);
      const indexPath = path.join(baseDir, 'INDEX.md');
      fs.writeFileSync(indexPath, indexContent, 'utf-8');
      console.log(`📑 已產生索引: ${indexPath}`);
    }

    console.log('');
    console.log('📊 匯出結果:');
    console.log(`   ✅ 成功: ${result.exported}`);
    console.log(`   ⏭️  跳過: ${result.skipped}`);
    console.log(`   ❌ 失敗: ${result.failed}`);

    result.success = true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    result.errors.push(`同步錯誤: ${msg}`);
    console.error(`❌ 同步錯誤: ${msg}`);
  }

  result.duration = Date.now() - startTime;
  console.log('');
  console.log(`⏱️  耗時: ${(result.duration / 1000).toFixed(2)} 秒`);

  return result;
}

/**
 * 產生索引檔案
 */
function generateIndexFile(records: LanceDBMemoryV2[], baseDir: string): string {
  const stats = {
    total: records.length,
    byCategory: {} as Record<string, number>,
    byAgent: {} as Record<string, number>,
  };

  for (const record of records) {
    const cat = record.category || 'other';
    stats.byCategory[cat] = (stats.byCategory[cat] || 0) + 1;
    stats.byAgent[record.agentId] = (stats.byAgent[record.agentId] || 0) + 1;
  }

  const now = new Date().toISOString();

  return `---
title: AI Memory Index
updated: ${now}
total: ${stats.total}
---

# 🧠 AI Memory Index

> 自動產生於 ${now}

## 📊 統計

- **總記憶數**: ${stats.total}

### 依分類
${Object.entries(stats.byCategory)
    .map(([cat, count]) => `- **${cat}**: ${count}`)
    .join('\n')}

### 依 Agent
${Object.entries(stats.byAgent)
    .map(([agent, count]) => `- **${agent}**: ${count}`)
    .join('\n')}

## 📁 資料夾結構

- [[01-Facts]] - 事實與知識
- [[02-Decisions]] - 決策紀錄
- [[03-People]] - 人物資料
- [[04-Projects]] - 專案資訊

## 🔗 快速連結

${WIKILINK_KEYWORDS.map(k => `[[${k}]]`).join(' ')}
`;
}

// ============================================================================
// 主程式
// ============================================================================

async function main(): Promise<void> {
  const options = parseArgs();

  try {
    const result = await sync(options);

    if (result.success) {
      console.log('');
      console.log('🎉 同步完成！');
      process.exit(0);
    } else {
      console.log('');
      console.log('⚠️  同步完成但有錯誤:');
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
