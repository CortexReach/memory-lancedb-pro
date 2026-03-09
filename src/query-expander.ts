/**
 * Lightweight Chinese query expansion via static synonym dictionary.
 * Expands colloquial/fuzzy terms into technical equivalents for BM25 boost.
 * No API calls — pure local dictionary lookup.
 *
 * Why: Chinese users often search with colloquial terms ("挂了", "炸了")
 * while stored content uses technical terms ("crash", "崩溃"). Vector search
 * handles semantic similarity, but BM25 needs exact term matches — this
 * bridges that gap.
 *
 * Matching strategy:
 * - Chinese triggers: exact substring match (Chinese has no word boundaries)
 * - English triggers: word-boundary regex (\b) to avoid false positives
 *   (e.g. "download" should NOT match "down", "blog" should NOT match "log")
 */

/** Maximum number of expansion terms appended to a query */
const MAX_EXPANSION_TERMS = 5;

// Each entry: { cn: Chinese triggers, en: English triggers (word-boundary matched), expansions }
interface SynonymEntry {
  cn: string[];
  en: string[];
  expansions: string[];
}

const SYNONYM_MAP: SynonymEntry[] = [
  // --- Status / Failure ---
  {
    cn: ["挂了", "挂掉", "宕机"],
    en: ["shutdown", "crashed"],
    expansions: ["崩溃", "crash", "error", "报错", "宕机", "失败"],
  },
  {
    cn: ["卡住", "卡死", "没反应"],
    en: ["hung", "frozen"],
    expansions: ["hang", "timeout", "超时", "无响应", "stuck"],
  },
  {
    cn: ["炸了", "爆了"],
    en: ["oom"],
    expansions: ["崩溃", "crash", "OOM", "内存溢出", "error"],
  },

  // --- Config / Deploy ---
  {
    cn: ["配置", "设置"],
    en: ["config", "configuration"],
    expansions: ["配置", "config", "configuration", "settings", "设置"],
  },
  {
    cn: ["部署", "上线"],
    en: ["deploy", "deployment"],
    expansions: ["deploy", "部署", "上线", "发布", "release"],
  },
  {
    cn: ["容器"],
    en: ["docker", "container"],
    expansions: ["Docker", "容器", "container", "docker-compose"],
  },

  // --- Code / Debug ---
  {
    cn: ["报错", "出错", "错误"],
    en: ["error", "exception"],
    expansions: ["error", "报错", "exception", "错误", "失败", "bug"],
  },
  {
    cn: ["修复", "修了", "修好"],
    en: ["bugfix", "hotfix"],
    expansions: ["fix", "修复", "patch", "解决"],
  },
  {
    cn: ["踩坑"],
    en: ["troubleshoot"],
    expansions: ["踩坑", "bug", "问题", "教训", "排查", "troubleshoot"],
  },

  // --- Search / Memory ---
  {
    cn: ["记忆", "记忆系统"],
    en: ["memory"],
    expansions: ["记忆", "memory", "记忆系统", "LanceDB", "索引"],
  },
  {
    cn: ["搜索", "查找", "找不到"],
    en: ["search", "retrieval"],
    expansions: ["搜索", "search", "retrieval", "检索", "查找"],
  },

  // --- Infrastructure ---
  {
    cn: ["推送"],
    en: ["git push"],
    expansions: ["push", "推送", "git push", "commit"],
  },
  {
    cn: ["日志"],
    en: ["logfile", "logging"],
    expansions: ["日志", "log", "logging", "输出", "打印"],
  },
  {
    cn: ["权限"],
    en: ["permission", "authorization"],
    expansions: ["权限", "permission", "access", "授权", "认证"],
  },
];

/** Build a word-boundary regex for an English trigger */
function buildWordBoundaryRegex(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i");
}

/**
 * Expand a query by appending synonym terms from the dictionary.
 * Returns the original query with additional terms appended.
 * Idempotent — already-precise queries pass through unchanged.
 */
export function expandQuery(query: string): string {
  if (!query || query.trim().length < 2) return query;

  const lower = query.toLowerCase();
  const additions = new Set<string>();

  for (const entry of SYNONYM_MAP) {
    // Check Chinese triggers via substring (Chinese has no word boundaries)
    const cnMatch = entry.cn.some((t) => lower.includes(t.toLowerCase()));
    // Check English triggers via word-boundary regex
    const enMatch = entry.en.some((t) => buildWordBoundaryRegex(t).test(query));

    if (cnMatch || enMatch) {
      for (const exp of entry.expansions) {
        if (!lower.includes(exp.toLowerCase())) {
          additions.add(exp);
        }
        if (additions.size >= MAX_EXPANSION_TERMS) break;
      }
    }
    if (additions.size >= MAX_EXPANSION_TERMS) break;
  }

  if (additions.size === 0) return query;
  return `${query} ${[...additions].join(" ")}`;
}
