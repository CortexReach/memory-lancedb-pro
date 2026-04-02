/**
 * Temporal Classifier
 * Classifies memory text as static (permanent fact) or dynamic (time-sensitive).
 * Infers expiry timestamps from temporal expressions.
 */

export type TemporalType = "static" | "dynamic";

// Dynamic keywords — time-sensitive indicators
const DYNAMIC_KEYWORDS_EN = [
  "today", "yesterday", "tomorrow", "recently", "currently",
  "right now", "this week", "this month", "last week", "next week",
  "this morning", "tonight", "later",
];

const DYNAMIC_KEYWORDS_ZH = [
  "今天", "昨天", "明天", "最近", "正在", "刚才", "刚刚",
  "这周", "这个月", "上周", "下周", "目前", "现在",
  "今晚", "今早", "稍后", "待会",
];

// Static keywords — permanent fact indicators
const STATIC_KEYWORDS_EN = [
  "favorite", "prefer", "always", "name is", "born",
  "graduated", "live in", "work at", "job", "profession",
  "hobby", "allergic",
];

const STATIC_KEYWORDS_ZH = [
  "喜欢", "偏好", "一直", "名字", "叫做", "出生",
  "毕业", "住在", "工作", "职业", "爱好", "过敏",
];

/**
 * Classify memory text as static (permanent fact) or dynamic (time-sensitive).
 * Rule-based: keywords → classification. Default: "static" (safer default).
 */
export function classifyTemporal(text: string): TemporalType {
  const lower = text.toLowerCase();

  const hasDynamic =
    DYNAMIC_KEYWORDS_EN.some((kw) => lower.includes(kw)) ||
    DYNAMIC_KEYWORDS_ZH.some((kw) => text.includes(kw));

  const hasStatic =
    STATIC_KEYWORDS_EN.some((kw) => lower.includes(kw)) ||
    STATIC_KEYWORDS_ZH.some((kw) => text.includes(kw));

  // If BOTH match → "dynamic" wins (time-sensitive info takes priority)
  if (hasDynamic) return "dynamic";
  // If only static matches → static
  if (hasStatic) return "static";
  // If NEITHER match → "static" (safer default, avoids premature expiry)
  return "static";
}

// Expiry rules: pattern → milliseconds to add from now
const EXPIRY_RULES: Array<{ patterns: RegExp[]; offsetMs: number }> = [
  {
    // 后天 / day after tomorrow → +48h
    patterns: [/后天/, /day after tomorrow/i],
    offsetMs: 48 * 60 * 60 * 1000,
  },
  {
    // 明天 / tomorrow → +24h
    patterns: [/明天/, /\btomorrow\b/i],
    offsetMs: 24 * 60 * 60 * 1000,
  },
  {
    // 下周 / next week → +7d
    patterns: [/下周/, /\bnext week\b/i],
    offsetMs: 7 * 24 * 60 * 60 * 1000,
  },
  {
    // 这周 / this week → +3d
    patterns: [/这周/, /\bthis week\b/i],
    offsetMs: 3 * 24 * 60 * 60 * 1000,
  },
  {
    // 下个月 / next month → +30d
    patterns: [/下个月/, /\bnext month\b/i],
    offsetMs: 30 * 24 * 60 * 60 * 1000,
  },
  {
    // 这个月 / this month → +15d
    patterns: [/这个月/, /\bthis month\b/i],
    offsetMs: 15 * 24 * 60 * 60 * 1000,
  },
  {
    // 今晚 / tonight → +12h
    patterns: [/今晚/, /\btonight\b/i],
    offsetMs: 12 * 60 * 60 * 1000,
  },
  {
    // 今天 / today → +18h
    patterns: [/今天/, /\btoday\b/i],
    offsetMs: 18 * 60 * 60 * 1000,
  },
];

/**
 * Infer expiry timestamp from temporal expressions in text.
 * Returns undefined if no temporal expression found.
 * @param text - memory text
 * @param now - current timestamp (default: Date.now())
 */
export function inferExpiry(text: string, now?: number): number | undefined {
  const baseTime = now ?? Date.now();

  for (const rule of EXPIRY_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(text)) {
        return baseTime + rule.offsetMs;
      }
    }
  }

  return undefined;
}
