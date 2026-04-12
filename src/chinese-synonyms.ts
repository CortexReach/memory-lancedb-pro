/**
 * Chinese Synonyms Expansion
 * Enables synonym-based query expansion for better retrieval
 */

// ============================================================================
// Types
// ============================================================================

export interface SynonymsConfig {
  /** Enable synonym expansion (default: true) */
  enabled: boolean;
  /** Maximum number of expanded queries (default: 5) */
  maxExpandedQueries: number;
  /** Minimum similarity score to use synonyms (default: 0.5) */
  minSimilarityScore: number;
  /** Use built-in synonyms (default: true) */
  useBuiltIn: boolean;
  /** Custom synonyms dictionary */
  customSynonyms?: Record<string, string[]>;
}

export const DEFAULT_SYNONYMS_CONFIG: SynonymsConfig = {
  enabled: true,
  maxExpandedQueries: 5,
  minSimilarityScore: 0.5,
  useBuiltIn: true,
  customSynonyms: undefined,
};

// ============================================================================
// Built-in Chinese Synonyms Dictionary
// ============================================================================

const BUILT_IN_SYNONYMS: Record<string, string[]> = {
  // AI/技术相关
  "AI": ["人工智能", "人工智慧", "machine learning", "机器学习", "深度学习"],
  "人工智能": ["AI", "人工智慧", "machine learning", "机器学习"],
  "机器学习": ["machine learning", "ML", "人工智能", "AI"],
  "深度学习": ["deep learning", "DL", "神经网络", "人工智能"],
  "大模型": ["LLM", "大语言模型", "foundation model", "基础模型"],
  "语言模型": ["language model", "LM", "LLM", "大语言模型"],
  
  // 编程开发
  "代码": ["code", "program", "程序", "源码", "源代码"],
  "程序": ["program", "code", "代码", "软件"],
  "开发": ["development", "dev", "编程", "写代码"],
  "编程": ["programming", "coding", "写代码", "开发"],
  "bug": ["错误", "缺陷", "问题", "issue", "故障"],
  "错误": ["error", "bug", "异常", "问题", "故障"],
  "调试": ["debug", "除错", "排查", "diagnose"],
  "测试": ["test", "testing", "检验", "验证"],
  
  // 项目相关
  "项目": ["project", "工程", "计划", "任务"],
  "任务": ["task", "job", "工作", "项目"],
  "功能": ["feature", "function", "特性", "能力"],
  "需求": ["requirement", "requirement", "需要", "要求"],
  
  // 电脑/设备
  "电脑": ["计算机", "PC", "主机", "computer"],
  "计算机": ["电脑", "PC", "computer"],
  "手机": ["电话", "移动电话", "smartphone", "mobile"],
  "服务器": ["server", "主机", "服务端"],
  
  // 文件/数据
  "文件": ["file", "document", "文档", "资料"],
  "数据": ["data", "信息", "资料", "database"],
  "数据库": ["database", "DB", "数据仓库", "data store"],
  
  // 网络/互联网
  "网络": ["network", "internet", "互联网", "web"],
  "网站": ["website", "web", "站点", "网页"],
  "API": ["接口", "应用程序接口", "application programming interface"],
  
  // 常用词
  "好": ["优秀", "良好", "不错", "good", "excellent"],
  "快": ["快速", "迅速", "speed", "fast", "quick"],
  "慢": ["缓慢", "slow", "delay", "delayed"],
  "大": ["巨大", "large", "big", "huge"],
  "小": ["微小", "small", "little", "tiny"],
  
  // 时间相关
  "今天": ["今日", "today", "current day"],
  "明天": ["明日", "tomorrow", "next day"],
  "昨天": ["昨日", "yesterday", "previous day"],
  "现在": ["目前", "当前", "now", "current"],
  "以后": ["未来", "将来", "future", "later"],
  
  // 人物相关
  "用户": ["user", "client", "customer", "使用者"],
  "开发者": ["developer", "dev", "程序员", "programmer"],
  "工程师": ["engineer", "工程师", "技术人员"],
  
  // 动作相关
  "创建": ["create", "build", "新建", "establish"],
  "删除": ["delete", "remove", "移除", "destroy"],
  "修改": ["modify", "update", "更改", "change", "edit"],
  "查询": ["query", "search", "搜索", "查找", "find"],
  "学习": ["learn", "study", "学习", "training"],
};

// ============================================================================
// Synonyms Manager
// ============================================================================

export class SynonymsManager {
  private config: SynonymsConfig;
  private synonyms: Record<string, string[]>;

  constructor(config: SynonymsConfig = DEFAULT_SYNONYMS_CONFIG) {
    this.config = config;
    this.synonyms = {};
    
    // Load built-in synonyms
    if (config.useBuiltIn) {
      this.synonyms = { ...BUILT_IN_SYNONYMS };
    }
    
    // Merge custom synonyms
    if (config.customSynonyms) {
      this.synonyms = {
        ...this.synonyms,
        ...config.customSynonyms,
      };
    }
  }

  /**
   * Expand a query with synonyms
   * Returns original query + synonym variants
   */
  expandQuery(query: string): string[] {
    if (!this.config.enabled) {
      return [query];
    }

    const expanded: Set<string> = new Set([query]);
    const normalizedQuery = query.toLowerCase().trim();

    // Find matching synonyms
    for (const [word, synonyms] of Object.entries(this.synonyms)) {
      // Check if query contains the word
      if (normalizedQuery.includes(word.toLowerCase())) {
        // Add all synonyms
        for (const synonym of synonyms) {
          if (expanded.size >= this.config.maxExpandedQueries) {
            break;
          }
          
          // Replace word with synonym in query
          const variant = query.replace(
            new RegExp(word, 'gi'),
            synonym
          );
          
          if (variant !== query) {
            expanded.add(variant);
          }
        }
      }
    }

    return Array.from(expanded).slice(0, this.config.maxExpandedQueries);
  }

  /**
   * Get synonyms for a specific word
   */
  getSynonyms(word: string): string[] {
    const normalized = word.toLowerCase().trim();
    
    for (const [key, synonyms] of Object.entries(this.synonyms)) {
      if (key.toLowerCase() === normalized) {
        return synonyms;
      }
      // Also check if word is in synonym list
      if (synonyms.some(s => s.toLowerCase() === normalized)) {
        return [key, ...synonyms.filter(s => s.toLowerCase() !== normalized)];
      }
    }
    
    return [];
  }

  /**
   * Add custom synonyms
   */
  addSynonyms(word: string, synonyms: string[]): void {
    this.synonyms[word] = synonyms;
  }

  /**
   * Remove synonyms for a word
   */
  removeSynonyms(word: string): void {
    delete this.synonyms[word];
  }

  /**
   * Get all synonyms
   */
  getAllSynonyms(): Record<string, string[]> {
    return { ...this.synonyms };
  }

  /**
   * Load synonyms from JSON file
   */
  async loadFromFile(filePath: string): Promise<void> {
    try {
      const fs = await import('node:fs/promises');
      const content = await fs.readFile(filePath, 'utf-8');
      const custom = JSON.parse(content);
      
      this.synonyms = {
        ...this.synonyms,
        ...custom,
      };
      
      console.log(`[Synonyms] Loaded ${Object.keys(custom).length} synonym entries from ${filePath}`);
    } catch (error) {
      console.error('[Synonyms] Failed to load from file:', error);
    }
  }

  /**
   * Save synonyms to JSON file
   */
  async saveToFile(filePath: string): Promise<void> {
    try {
      const fs = await import('node:fs/promises');
      await fs.writeFile(
        filePath,
        JSON.stringify(this.synonyms, null, 2),
        'utf-8'
      );
      console.log(`[Synonyms] Saved ${Object.keys(this.synonyms).length} entries to ${filePath}`);
    } catch (error) {
      console.error('[Synonyms] Failed to save to file:', error);
    }
  }
}

// ============================================================================
// Query Expansion for Retrieval
// ============================================================================

/**
 * Expand query for BM25 retrieval with synonyms
 */
export async function expandQueryForBM25(
  query: string,
  config: SynonymsConfig = DEFAULT_SYNONYMS_CONFIG
): Promise<string[]> {
  const manager = new SynonymsManager(config);
  return manager.expandQuery(query);
}

/**
 * Search with synonym expansion
 * Searches with original query + all synonym variants
 */
export async function searchWithSynonyms<T>(
  query: string,
  searchFn: (q: string) => Promise<T[]>,
  config: SynonymsConfig = DEFAULT_SYNONYMS_CONFIG
): Promise<Array<{ result: T; query: string; source: 'original' | 'synonym' }>> {
  const manager = new SynonymsManager(config);
  const queries = manager.expandQuery(query);
  
  const allResults: Array<{ result: T; query: string; source: 'original' | 'synonym' }> = [];
  
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    const isOriginal = i === 0;
    
    try {
      const results = await searchFn(q);
      
      for (const result of results) {
        allResults.push({
          result,
          query: q,
          source: isOriginal ? 'original' : 'synonym',
        });
      }
    } catch (error) {
      console.error(`[Synonyms] Search failed for query "${q}":`, error);
    }
  }
  
  // Deduplicate results (assuming T has an 'id' field)
  const seen = new Set<string>();
  const uniqueResults = allResults.filter(item => {
    const id = (item.result as any).id;
    if (id && seen.has(id)) {
      return false;
    }
    if (id) {
      seen.add(id);
    }
    return true;
  });
  
  return uniqueResults;
}

// ============================================================================
// Singleton Instance
// ============================================================================

let globalSynonymsManager: SynonymsManager | null = null;

/**
 * Get or create the global synonyms manager
 */
export function getSynonymsManager(): SynonymsManager {
  if (!globalSynonymsManager) {
    globalSynonymsManager = new SynonymsManager(DEFAULT_SYNONYMS_CONFIG);
  }
  return globalSynonymsManager;
}

/**
 * Reset global synonyms manager (for testing)
 */
export function resetSynonymsManager(): void {
  if (globalSynonymsManager) {
    globalSynonymsManager = null;
  }
}

// ============================================================================
// Usage Examples
// ============================================================================

/**
 * Example: Query expansion for search
 */
export async function exampleQueryExpansion() {
  const manager = new SynonymsManager();
  
  // Original query
  const query = "我想学习人工智能";
  
  // Expand with synonyms
  const expanded = manager.expandQuery(query);
  
  console.log('Original:', query);
  console.log('Expanded:', expanded);
  // Output: [
  //   "我想学习人工智能",
  //   "我想学习 AI",
  //   "我想学习人工智慧",
  //   "我想学习 machine learning"
  // ]
}

/**
 * Example: Search with synonyms
 */
export async function exampleSearchWithSynonyms() {
  // Mock search function
  const mockSearch = async (query: string) => {
    console.log('Searching:', query);
    return [{ id: 1, text: `Result for "${query}"` }];
  };
  
  const query = "电脑配置";
  const results = await searchWithSynonyms(query, mockSearch);
  
  console.log('Results:', results);
  // Will search with: "电脑配置", "计算机配置", "PC 配置", etc.
}

/**
 * Example: Custom synonyms
 */
export async function exampleCustomSynonyms() {
  const manager = new SynonymsManager({
    ...DEFAULT_SYNONYMS_CONFIG,
    customSynonyms: {
      "小龙虾": ["OpenClaw", "claw", "龙虾"],
      "记忆": ["memory", "回忆", "记性"],
    },
  });
  
  const expanded = manager.expandQuery("小龙虾的记忆");
  console.log('Expanded:', expanded);
  // Output: ["小龙虾的记忆", "OpenClaw 的记忆", "claw 的记忆", ...]
}
