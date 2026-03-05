import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { extname, isAbsolute, join, resolve } from "node:path";

import { tool, type Plugin, type PluginInput } from "@opencode-ai/plugin";
import OpenAI from "openai";

import { createEmbedder, getVectorDimensions } from "../src/embedder.js";
import { isNoise } from "../src/noise-filter.js";
import {
  DEFAULT_RETRIEVAL_CONFIG,
  createRetriever,
  type RetrievalConfig,
  type RetrievalResult,
} from "../src/retriever.js";
import { createScopeManager, type ScopeConfig } from "../src/scopes.js";
import { MemoryStore, validateStoragePath, type MemoryEntry } from "../src/store.js";

const SERVICE_NAME = "memory-lancedb-pro-opencode";
const MEMORY_CATEGORIES = ["preference", "fact", "decision", "entity", "other"] as const;
const MAX_AUTO_MEMORIES_PER_MESSAGE = 3;
const MAX_AUTO_MEMORY_TEXT = 1200;

const ARCHITECTURE_PATTERNS = [
  /\barchitecture\b/i,
  /\bmodule\b/i,
  /\blayer\b/i,
  /\bcomponent\b/i,
  /\bpipeline\b/i,
  /\bplugin\b/i,
  /\bscope\b/i,
  /\bDDD\b/i,
  /\bbounded context\b/i,
  /\bdata flow\b/i,
  /架构/,
  /模块/,
  /分层/,
  /组件/,
  /数据流/,
  /工作流/,
  /作用域/,
];

const REQUIREMENT_PATTERNS = [
  /\bmust\b/i,
  /\bshould\b/i,
  /\brequire(?:ment)?\b/i,
  /\bacceptance\b/i,
  /\bconstraint\b/i,
  /\bneeds? to\b/i,
  /\bnon-functional\b/i,
  /需求/,
  /必须/,
  /需要/,
  /约束/,
  /验收/,
  /无感/,
  /默认/,
];

const DECISION_PATTERNS = [
  /\bdecide(?:d)?\b/i,
  /\bchoose\b/i,
  /\bswitch\b/i,
  /\bstandardize\b/i,
  /\buse\b.*\bas default\b/i,
  /决定/,
  /改为/,
  /采用/,
  /切换/,
  /禁用/,
  /启用/,
];

const DATA_MODEL_PATTERNS = [
  /\bschema\b/i,
  /\bmigration\b/i,
  /\btable\b/i,
  /\bcolumn\b/i,
  /\bindex\b/i,
  /\bprimary key\b/i,
  /\bforeign key\b/i,
  /\bconstraint\b/i,
  /\btransaction\b/i,
  /\bisolation\b/i,
  /\bconsistency\b/i,
  /\brollback\b/i,
  /\b幂等\b/,
  /\b事务\b/,
  /\b索引\b/,
  /\b字段\b/,
  /\b表结构\b/,
  /\b迁移\b/,
];

const API_CONTRACT_PATTERNS = [
  /\bapi\b/i,
  /\bendpoint\b/i,
  /\brequest\b/i,
  /\bresponse\b/i,
  /\bcontract\b/i,
  /\bbackward compatible\b/i,
  /\bprotobuf\b/i,
  /\bopenapi\b/i,
  /\bgraphql\b/i,
  /\bwebhook\b/i,
  /\b事件模型\b/,
  /\b接口契约\b/,
  /\b兼容性\b/,
  /\b请求\b/,
  /\b响应\b/,
  /\b协议\b/,
];

const RELIABILITY_PATTERNS = [
  /\bperformance\b/i,
  /\blatency\b/i,
  /\bthroughput\b/i,
  /\bmemory leak\b/i,
  /\brace condition\b/i,
  /\bdeadlock\b/i,
  /\bthread-?safe\b/i,
  /\btimeout\b/i,
  /\bretry\b/i,
  /\bbackoff\b/i,
  /\bcircuit breaker\b/i,
  /\bsecurity\b/i,
  /\bauth(?:entication|orization)?\b/i,
  /\bencrypt(?:ion)?\b/i,
  /\b性能\b/,
  /\b超时\b/,
  /\b重试\b/,
  /\b并发\b/,
  /\b线程安全\b/,
  /\b安全\b/,
  /\b鉴权\b/,
  /\b加密\b/,
];

const PROCEDURAL_NOISE_PATTERNS = [
  /\blet me\b/i,
  /\bi will\b/i,
  /\bnext step\b/i,
  /\brun (tests?|build|lint)\b/i,
  /\bshould i\b/i,
  /\bplease confirm\b/i,
  /\bTODO\b/i,
  /\b待办\b/,
  /\b下一步\b/,
  /\b稍后\b/,
];

const CODE_PATTERNS = [
  /```[\s\S]*?```/,
  /\bclass\s+[A-Za-z_][A-Za-z0-9_]*/,
  /\binterface\s+[A-Za-z_][A-Za-z0-9_]*/,
  /\bfunction\s+[A-Za-z_][A-Za-z0-9_]*/,
  /\btype\s+[A-Za-z_][A-Za-z0-9_]*/,
  /\bextends\b/,
  /\bimplements\b/,
  /\bimpl\s+[A-Za-z_][A-Za-z0-9_<>:,\s]*\s+for\s+[A-Za-z_][A-Za-z0-9_<>:]*/,
  /\btrait\s+[A-Za-z_][A-Za-z0-9_]*/,
  /\bstruct\s+[A-Za-z_][A-Za-z0-9_]*/,
  /\bclass\s+[A-Za-z_][A-Za-z0-9_]*\s*\([^)]*\):/,
  /\bclass\s+[A-Za-z_][A-Za-z0-9_]*\s*:\s*(public|protected|private)\s+[A-Za-z_][A-Za-z0-9_]*/,
  /\btype\s+[A-Za-z_][A-Za-z0-9_]*\s+interface\s*\{/,
  /\btype\s+[A-Za-z_][A-Za-z0-9_]*\s+struct\s*\{/,
  /\bfunc\s*\(\s*\w+\s+\*?[A-Za-z_][A-Za-z0-9_]*\s*\)\s*[A-Za-z_][A-Za-z0-9_]*/,
  /\btypedef\s+struct\b/,
  /\bnamespace\s+[A-Za-z_][A-Za-z0-9_:]*/,
  /\bpackage\s+[A-Za-z_][A-Za-z0-9_.]*/,
];

const FILE_EXT_LANG: Record<string, string> = {
  ".py": "python",
  ".c": "c",
  ".h": "c",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".hxx": "cpp",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".rs": "rust",
  ".go": "golang",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
};

type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

interface AutoMemoryDraft {
  text: string;
  category: MemoryCategory;
  importance: number;
  score: number;
  metadata?: Record<string, unknown>;
}

interface PluginConfig {
  embedding: {
    apiKey: string | string[];
    model: string;
    baseURL?: string;
    dimensions?: number;
    taskQuery?: string;
    taskPassage?: string;
    normalized?: boolean;
    chunking?: boolean;
  };
  dbPath: string;
  retrieval: Partial<RetrievalConfig>;
  scopes?: Partial<ScopeConfig>;
  enableManagementTools: boolean;
}

interface Runtime {
  config: PluginConfig;
  store: MemoryStore;
  retriever: ReturnType<typeof createRetriever>;
  scopeManager: ReturnType<typeof createScopeManager>;
  embedder: ReturnType<typeof createEmbedder>;
  projectScope: string;
}

interface SessionModelInfo {
  providerID: string;
  modelID: string;
}

interface LlmDecision {
  id: string;
  store: boolean;
  category?: MemoryCategory;
  importance?: number;
  summary?: string;
  confidence?: number;
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function clamp01(value: number, fallback = 0.7): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

function formatPreview(text: string, max = 100): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= max) return singleLine;
  return `${singleLine.slice(0, max)}...`;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateText(text: string, max = MAX_AUTO_MEMORY_TEXT): string {
  const normalized = normalizeText(text);
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}...`;
}

function detectLanguageFromPath(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase();
  return FILE_EXT_LANG[ext] || null;
}

function detectLanguagesFromText(text: string): string[] {
  const found = new Set<string>();

  if (/\bimpl\s+\w[\w<>:,\s]*\s+for\s+\w/.test(text) || /\btrait\s+\w+/.test(text)) {
    found.add("rust");
  }
  if (/\bfunc\s*\(\s*\w+\s+\*?\w+\s*\)\s*\w+/.test(text) || /\btype\s+\w+\s+interface\s*\{/.test(text)) {
    found.add("golang");
  }
  if (/\bclass\s+\w+\s*\([^)]*\):/.test(text) || /\bdef\s+\w+\s*\(/.test(text)) {
    found.add("python");
  }
  if (/\bclass\s+\w+\s*:\s*(public|protected|private)\s+\w+/.test(text) || /#include\s*[<"]/i.test(text)) {
    found.add("cpp");
  }
  if (/\btypedef\s+struct\b/.test(text) || /\bstruct\s+\w+\s*\{/.test(text)) {
    found.add("c");
  }

  return [...found];
}

function parseMetadata(metadata?: string): Record<string, unknown> {
  if (!metadata) return {};
  try {
    const parsed = JSON.parse(metadata);
    return toRecord(parsed) ?? {};
  } catch {
    return {};
  }
}

function formatMetadataSuffix(metadata?: string): string {
  const obj = parseMetadata(metadata);
  const files = Array.isArray(obj.file_paths)
    ? obj.file_paths.filter((v): v is string => typeof v === "string")
    : [];
  const langs = Array.isArray(obj.languages)
    ? obj.languages.filter((v): v is string => typeof v === "string")
    : [];

  const pieces: string[] = [];
  if (files.length > 0) {
    pieces.push(`files:${files.slice(0, 2).join(",")}${files.length > 2 ? "..." : ""}`);
  }
  if (langs.length > 0) {
    pieces.push(`lang:${langs.slice(0, 3).join(",")}`);
  }

  return pieces.length > 0 ? ` [${pieces.join("; ")}]` : "";
}

function extractQueryKeys(query: string): string[] {
  const lowered = query.toLowerCase();
  const latinTokens = lowered.match(/[a-z0-9_:.\-/]{2,}/g) ?? [];
  const cjkTokens = query.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  const keys = [...latinTokens, ...cjkTokens].map((t) => t.trim()).filter(Boolean);
  return [...new Set(keys)].slice(0, 12);
}

function hasLexicalOverlap(text: string, keys: string[]): boolean {
  if (keys.length === 0) return false;
  const lowered = text.toLowerCase();
  return keys.some((k) => lowered.includes(k.toLowerCase()));
}

function applyPrecisionFilter(
  query: string,
  results: RetrievalResult[],
  limit: number,
): RetrievalResult[] {
  const keys = extractQueryKeys(query);
  const shortQuery = normalizeText(query).length <= 6;

  const filtered = results.filter((r) => {
    const overlap = hasLexicalOverlap(r.entry.text, keys);
    if (r.score < 0.3) return false;
    if (overlap) return true;
    if (keys.length === 0) {
      return r.score >= 0.55;
    }
    if (shortQuery) {
      return r.score >= 0.75;
    }
    return r.score >= 0.62;
  });

  return filtered.slice(0, limit);
}

function matchCount(text: string, patterns: RegExp[]): number {
  return patterns.reduce((count, pattern) => (pattern.test(text) ? count + 1 : count), 0);
}

function classifyCategory(text: string): MemoryCategory {
  if (matchCount(text, REQUIREMENT_PATTERNS) > 0 || matchCount(text, DECISION_PATTERNS) > 0) {
    return "decision";
  }
  if (matchCount(text, API_CONTRACT_PATTERNS) > 0 || matchCount(text, DATA_MODEL_PATTERNS) > 0) {
    return "fact";
  }
  if (matchCount(text, ARCHITECTURE_PATTERNS) > 0 || matchCount(text, CODE_PATTERNS) > 0) {
    return "entity";
  }
  return "fact";
}

function scoreCandidate(text: string): number {
  const normalized = normalizeText(text);
  if (normalized.length < 25) return 0;

  let score = 0;
  if (normalized.length > 60) score += 1;
  if (normalized.length > 180) score += 1;

  score += matchCount(normalized, ARCHITECTURE_PATTERNS) * 2;
  score += matchCount(normalized, REQUIREMENT_PATTERNS) * 2;
  score += matchCount(normalized, DECISION_PATTERNS) * 2;
  score += matchCount(normalized, DATA_MODEL_PATTERNS) * 2;
  score += matchCount(normalized, API_CONTRACT_PATTERNS) * 2;
  score += matchCount(normalized, RELIABILITY_PATTERNS) * 2;
  score += matchCount(normalized, CODE_PATTERNS) * 1;
  score -= matchCount(normalized, PROCEDURAL_NOISE_PATTERNS) * 2;

  const lineCount = text.split("\n").length;
  if (lineCount >= 20) score += 2;

  return Math.max(0, score);
}

function scoreToImportance(score: number): number {
  if (score >= 10) return 0.95;
  if (score >= 7) return 0.9;
  if (score >= 5) return 0.85;
  if (score >= 4) return 0.8;
  return 0.75;
}

function extractCodeSummaries(text: string): string[] {
  const results: string[] = [];
  const inheritanceMatches = [
    ...text.matchAll(
      /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\s+extends\s+([A-Za-z_][A-Za-z0-9_]*)/g,
    ),
  ];

  for (const match of inheritanceMatches.slice(0, 4)) {
    const child = match[1];
    const parent = match[2];
    results.push(`Class inheritance: ${child} extends ${parent}.`);
  }

  const implementsMatches = [
    ...text.matchAll(
      /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\s+implements\s+([A-Za-z0-9_,\s]+)/g,
    ),
  ];

  for (const match of implementsMatches.slice(0, 4)) {
    const child = match[1];
    const rawInterfaces = match[2];
    const interfaces = rawInterfaces
      .split(",")
      .map((i) => i.trim())
      .filter(Boolean)
      .slice(0, 4)
      .join(", ");
    if (interfaces) {
      results.push(`Type contract: ${child} implements ${interfaces}.`);
    }
  }

  const classMatches = [...text.matchAll(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)/g)];

  for (const classMatch of classMatches.slice(0, 3)) {
    const className = classMatch[1];
    const methodMatches = [
      ...text.matchAll(/(?:async\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*\{/g),
    ]
      .map((m) => m[1])
      .filter((name) => name !== "if" && name !== "for" && name !== "while");

    const uniqueMethods = [...new Set(methodMatches)].slice(0, 6);
    const methodPart =
      uniqueMethods.length > 0
        ? ` key methods: ${uniqueMethods.join(", ")}`
        : " key methods discussed";

    results.push(`Code architecture: class ${className}.${methodPart}`);
  }

  const fencedBlocks = [...text.matchAll(/```([\s\S]*?)```/g)];

  const pyInheritance = [...text.matchAll(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\):/g)];
  for (const match of pyInheritance.slice(0, 4)) {
    const child = match[1];
    const bases = match[2]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 4)
      .join(", ");
    if (bases) {
      results.push(`Class inheritance: ${child} extends ${bases} (python).`);
    }
  }

  const cppInheritance = [
    ...text.matchAll(
      /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(?:public|protected|private)\s+([A-Za-z_][A-Za-z0-9_:]*)/g,
    ),
  ];
  for (const match of cppInheritance.slice(0, 4)) {
    results.push(`Class inheritance: ${match[1]} extends ${match[2]} (cpp).`);
  }

  const rustImpls = [
    ...text.matchAll(/\bimpl\s+([A-Za-z_][A-Za-z0-9_<>:,\s]*)\s+for\s+([A-Za-z_][A-Za-z0-9_<>:]*)/g),
  ];
  for (const match of rustImpls.slice(0, 4)) {
    const trait = normalizeText(match[1]);
    const ty = normalizeText(match[2]);
    if (trait && ty) {
      results.push(`Trait relationship: ${ty} implements ${trait} (rust).`);
    }
  }

  const goReceivers = [
    ...text.matchAll(/\bfunc\s*\(\s*\w+\s+\*?([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*([A-Za-z_][A-Za-z0-9_]*)/g),
  ];
  for (const match of goReceivers.slice(0, 4)) {
    results.push(`Method ownership: ${match[1]}.${match[2]} receiver method (golang).`);
  }

  const goInterfaces = [...text.matchAll(/\btype\s+([A-Za-z_][A-Za-z0-9_]*)\s+interface\s*\{/g)];
  for (const match of goInterfaces.slice(0, 3)) {
    results.push(`Architecture type: interface ${match[1]} defined (golang).`);
  }

  const cStructs = [...text.matchAll(/\b(?:typedef\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)?\s*\{/g)];
  for (const match of cStructs.slice(0, 3)) {
    const name = match[1] || "(anonymous)";
    results.push(`Data architecture: struct ${name} defined (c/cpp).`);
  }

  for (const block of fencedBlocks.slice(0, 2)) {
    const code = block[1] || "";
    const lines = code.split("\n").length;
    if (lines >= 25) {
      results.push(`Large code block discussed (${lines} lines) with structural details.`);
    }
  }

  return results;
}

function extractTopicSummaries(text: string): string[] {
  const summaries: string[] = [];
  const lines = text
    .split("\n")
    .map((line) => normalizeText(line))
    .filter((line) => line.length >= 20)
    .slice(0, 80);

  for (const line of lines) {
    if (matchCount(line, API_CONTRACT_PATTERNS) > 0) {
      summaries.push(`API contract constraint: ${line}`);
    }
    if (matchCount(line, DATA_MODEL_PATTERNS) > 0) {
      summaries.push(`Data model constraint: ${line}`);
    }
    if (matchCount(line, RELIABILITY_PATTERNS) > 0) {
      summaries.push(`Reliability constraint: ${line}`);
    }
  }

  return summaries.slice(0, 8);
}

function extractAutoMemoryDrafts(
  text: string,
  context?: { role?: string; filePaths?: string[]; languages?: string[] },
): AutoMemoryDraft[] {
  const normalized = text.trim();
  if (!normalized || isNoise(normalized)) return [];
  if (context?.role && context.role !== "user" && context.role !== "assistant") return [];

  const candidates: string[] = [];

  const codeSummaries = extractCodeSummaries(normalized);
  candidates.push(...codeSummaries);

  const topicSummaries = extractTopicSummaries(normalized);
  candidates.push(...topicSummaries);

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);

  for (const paragraph of paragraphs) {
    const score = scoreCandidate(paragraph);
    if (score >= 4) {
      candidates.push(paragraph);
    }
  }

  const seen = new Set<string>();
  const drafts: AutoMemoryDraft[] = [];

  const detectedLangs = new Set<string>(detectLanguagesFromText(normalized));
  for (const lang of context?.languages ?? []) {
    detectedLangs.add(lang);
  }
  const baseMetadata: Record<string, unknown> = {};
  if (context?.role) {
    baseMetadata.role = context.role;
  }
  if ((context?.filePaths?.length ?? 0) > 0) {
    baseMetadata.file_paths = [...new Set(context!.filePaths)].slice(0, 10);
  }
  if (detectedLangs.size > 0) {
    baseMetadata.languages = [...detectedLangs].slice(0, 8);
  }

  for (const candidate of candidates) {
    const compact = truncateText(candidate);
    const key = compact.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const score = scoreCandidate(candidate);
    if (score < 4) continue;

    drafts.push({
      text: compact,
      category: classifyCategory(candidate),
      importance: scoreToImportance(score),
      score,
      metadata: Object.keys(baseMetadata).length > 0 ? { ...baseMetadata } : undefined,
    });
  }

  drafts.sort((a, b) => b.score - a.score);
  return drafts.slice(0, MAX_AUTO_MEMORIES_PER_MESSAGE);
}

function parseModelRef(modelRef?: string): SessionModelInfo | null {
  if (!modelRef || !modelRef.includes("/")) return null;
  const [providerID, modelID] = modelRef.split("/", 2);
  if (!providerID || !modelID) return null;
  return { providerID, modelID };
}

async function resolveDecisionModelConfig(
  ctx: PluginInput,
  sessionModel?: SessionModelInfo,
): Promise<{
  apiKey: string;
  baseURL?: string;
  model: string;
} | null> {
  try {
    const response = await (ctx.client.config.get as any)({
      query: { directory: ctx.directory },
      responseStyle: "data",
      throwOnError: true,
    });

    const config = toRecord(response) ?? toRecord((response as any)?.data);
    if (!config) return null;

    const providerMap = toRecord(config.provider);
    if (!providerMap) return null;

    const selected =
      sessionModel ||
      parseModelRef(typeof config.model === "string" ? config.model : undefined);
    if (!selected) return null;

    const providerConfig = toRecord(providerMap[selected.providerID]);
    const options = toRecord(providerConfig?.options) ?? {};
    const apiKey =
      typeof options.apiKey === "string" ? options.apiKey : process.env.OPENAI_API_KEY;
    const baseURL = typeof options.baseURL === "string" ? options.baseURL : undefined;

    if (!apiKey || !selected.modelID) return null;

    return {
      apiKey,
      baseURL,
      model: selected.modelID,
    };
  } catch {
    return null;
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function decideDraftsWithModel(
  ctx: PluginInput,
  drafts: AutoMemoryDraft[],
  sessionModel?: SessionModelInfo,
): Promise<LlmDecision[] | null> {
  if (drafts.length === 0) return [];

  const modelConfig = await resolveDecisionModelConfig(ctx, sessionModel);
  if (!modelConfig) {
    return null;
  }

  const client = new OpenAI({
    apiKey: modelConfig.apiKey,
    baseURL: modelConfig.baseURL,
  });

  const numbered = drafts.map((draft, idx) => ({
    id: `c${idx + 1}`,
    text: draft.text,
    heuristic_category: draft.category,
    heuristic_importance: draft.importance,
    heuristic_score: draft.score,
  }));

  const systemPrompt = [
    "You are a strict memory curator for a software-engineering assistant.",
    "Decide what should be stored as long-term memory.",
    "Store only high-value durable facts.",
    "Strongly prioritize:",
    "1) Class inheritance/implements relationships and architectural responsibilities.",
    "2) Overall project architecture design, module boundaries, data flow.",
    "3) Hard requirements/constraints/default behaviors and non-negotiable rules.",
    "4) API/interface contracts, compatibility guarantees, protocol schemas.",
    "5) Data model decisions: schema, migration constraints, transaction/isolation rules.",
    "6) Reliability/security/performance constraints that shape implementation.",
    "Do NOT store generic chatter, temporary plans, routine steps, or command transcripts.",
    "Prefer summarizing the durable WHY/INVARIANT/TRADEOFF, not ephemeral wording.",
    "If one message contains multiple independent durable topics, keep them as separate memories (up to 3).",
    "Return JSON only in shape:",
    '{"decisions":[{"id":"c1","store":true,"category":"entity|decision|fact|preference|other","importance":0.0,"summary":"...","confidence":0.0}]}',
  ].join("\n");

  const userPrompt = JSON.stringify({
    instruction: "Evaluate candidates and decide storage.",
    candidates: numbered,
  });

  try {
    let content = "";

    try {
      const response = await client.responses.create({
        model: modelConfig.model,
        input: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        text: { format: { type: "json_object" } },
        reasoning: { effort: "low" },
      });
      content = typeof response.output_text === "string" ? response.output_text : "";
    } catch {
      const completion = await client.chat.completions.create({
        model: modelConfig.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      });
      content = completion.choices?.[0]?.message?.content || "";
    }

    if (!content) return null;
    const parsed = safeJsonParse(content);
    const record = toRecord(parsed);
    const decisionsRaw = record && Array.isArray(record.decisions) ? record.decisions : [];

    const decisions: LlmDecision[] = [];
    for (const raw of decisionsRaw) {
      const item = toRecord(raw);
      if (!item) continue;
      if (typeof item.id !== "string") continue;
      const decision: LlmDecision = {
        id: item.id,
        store: Boolean(item.store),
      };
      if (typeof item.category === "string" && MEMORY_CATEGORIES.includes(item.category as MemoryCategory)) {
        decision.category = item.category as MemoryCategory;
      }
      if (typeof item.importance === "number") {
        decision.importance = clamp01(item.importance, 0.8);
      }
      if (typeof item.summary === "string") {
        decision.summary = truncateText(item.summary, 600);
      }
      if (typeof item.confidence === "number") {
        decision.confidence = clamp01(item.confidence, 0.5);
      }
      decisions.push(decision);
    }

    return decisions;
  } catch {
    return null;
  }
}

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envName) => {
    const envValue = process.env[envName];
    if (!envValue) {
      throw new Error(`Environment variable ${envName} is not set`);
    }
    return envValue;
  });
}

function resolveDeepEnv<T>(value: T): T {
  if (typeof value === "string") {
    return resolveEnvVars(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveDeepEnv(item)) as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveDeepEnv(v);
    }
    return out as T;
  }
  return value;
}

function expandHomePath(pathValue: string): string {
  if (pathValue === "~") return homedir();
  if (pathValue.startsWith("~/")) {
    return join(homedir(), pathValue.slice(2));
  }
  return pathValue;
}

function resolvePathFromWorktree(worktree: string, pathValue: string): string {
  const expanded = expandHomePath(pathValue);
  if (isAbsolute(expanded)) return expanded;
  return resolve(worktree, expanded);
}

function createProjectScopeFromPath(worktree: string): string {
  const normalized = resolve(worktree).replace(/\\/g, "/");
  const slug = normalized
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(-48) || "project";
  const digest = createHash("sha1").update(normalized).digest("hex").slice(0, 10);
  return `project:${slug}:${digest}`;
}

function withProjectScope(
  scopes: Partial<ScopeConfig> | undefined,
  projectScope: string,
  worktree: string,
): Partial<ScopeConfig> {
  const definitions = {
    ...(scopes?.definitions ?? {}),
  };

  if (!definitions[projectScope]) {
    definitions[projectScope] = {
      description: `Project-scoped memory for ${worktree}`,
      metadata: {
        worktree,
      },
    };
  }

  return {
    ...scopes,
    definitions,
  };
}

function ensureScopeDefinition(runtime: Runtime, scope: string, description: string): void {
  if (runtime.scopeManager.getScopeDefinition(scope)) {
    return;
  }
  runtime.scopeManager.addScopeDefinition(scope, { description });
}

function looksLikeMemoryId(value: string): boolean {
  const fullUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const shortPrefix = /^[0-9a-f]{8,}$/i;
  return fullUuid.test(value) || shortPrefix.test(value);
}

async function loadRawConfig(worktree: string): Promise<Record<string, unknown>> {
  const explicitPath = process.env.OPENCODE_MEMORY_LANCEDB_PRO_CONFIG?.trim();
  const configPath = explicitPath
    ? resolvePathFromWorktree(worktree, explicitPath)
    : join(worktree, "OpenCode", "config.json");

  try {
    await access(configPath);
  } catch (error) {
    if (!explicitPath) {
      return {};
    }
    throw new Error(`Config file not found: ${configPath} (${String(error)})`);
  }

  const rawText = await readFile(configPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new Error(`Invalid JSON in config file ${configPath}: ${String(error)}`);
  }

  const record = toRecord(parsed);
  if (!record) {
    throw new Error(`Config file must contain a JSON object: ${configPath}`);
  }

  return resolveDeepEnv(record);
}

function parsePluginConfig(rawConfig: Record<string, unknown>, worktree: string): PluginConfig {
  const embedding = toRecord(rawConfig.embedding) ?? {};

  let apiKey: string | string[] | undefined;
  if (typeof embedding.apiKey === "string") {
    apiKey = embedding.apiKey;
  } else if (Array.isArray(embedding.apiKey)) {
    const keys = embedding.apiKey
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
    if (keys.length > 0) {
      apiKey = keys;
    }
  }

  if (!apiKey && process.env.OPENAI_API_KEY) {
    apiKey = process.env.OPENAI_API_KEY;
  }

  if (!apiKey) {
    apiKey = "ollama";
  }

  if (typeof apiKey === "string") {
    apiKey = apiKey.trim();
  }

  if (typeof apiKey === "string" && apiKey.length === 0) {
    apiKey = "ollama";
  }

  if (Array.isArray(apiKey) && apiKey.length === 0) {
    apiKey = "ollama";
  }

  const model =
    typeof embedding.model === "string" && embedding.model.trim().length > 0
      ? embedding.model
      : "nomic-embed-text";

  const baseURL =
    typeof embedding.baseURL === "string" && embedding.baseURL.trim().length > 0
      ? embedding.baseURL
      : "http://localhost:11434/v1";

  const dbPathRaw =
    typeof rawConfig.dbPath === "string" && rawConfig.dbPath.trim().length > 0
      ? rawConfig.dbPath
      : "~/.opencode/memory/lancedb-pro";

  const dbPath = resolvePathFromWorktree(worktree, dbPathRaw);
  const retrieval = (toRecord(rawConfig.retrieval) ?? {}) as Partial<RetrievalConfig>;
  const scopes = toRecord(rawConfig.scopes) as Partial<ScopeConfig> | undefined;

  const enableManagementTools =
    typeof rawConfig.enableManagementTools === "boolean"
      ? rawConfig.enableManagementTools
      : true;

  return {
    embedding: {
      apiKey,
      model,
      baseURL,
      dimensions:
        typeof embedding.dimensions === "number" && embedding.dimensions > 0
          ? Math.floor(embedding.dimensions)
          : undefined,
      taskQuery:
        typeof embedding.taskQuery === "string" ? embedding.taskQuery : undefined,
      taskPassage:
        typeof embedding.taskPassage === "string"
          ? embedding.taskPassage
          : undefined,
      normalized:
        typeof embedding.normalized === "boolean"
          ? embedding.normalized
          : undefined,
      chunking:
        typeof embedding.chunking === "boolean" ? embedding.chunking : undefined,
    },
    dbPath,
    retrieval,
    scopes,
    enableManagementTools,
  };
}

async function appLog(
  ctx: PluginInput,
  level: "debug" | "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  try {
    await ctx.client.app.log({
      body: {
        service: SERVICE_NAME,
        level,
        message,
        extra,
      },
    });
  } catch {
    // keep tools usable even if app logging is unavailable
  }
}

async function buildRuntime(ctx: PluginInput): Promise<Runtime> {
  const rawConfig = await loadRawConfig(ctx.worktree);
  const config = parsePluginConfig(rawConfig, ctx.worktree);
  const projectScope = createProjectScopeFromPath(ctx.worktree);

  validateStoragePath(config.dbPath);

  const vectorDim = getVectorDimensions(
    config.embedding.model,
    config.embedding.dimensions,
  );

  const store = new MemoryStore({ dbPath: config.dbPath, vectorDim });

  const embedder = createEmbedder({
    provider: "openai-compatible",
    apiKey: config.embedding.apiKey,
    model: config.embedding.model,
    baseURL: config.embedding.baseURL,
    dimensions: config.embedding.dimensions,
    taskQuery: config.embedding.taskQuery,
    taskPassage: config.embedding.taskPassage,
    normalized: config.embedding.normalized,
    chunking: config.embedding.chunking,
  });

  const retriever = createRetriever(store, embedder, {
    ...DEFAULT_RETRIEVAL_CONFIG,
    ...config.retrieval,
  });

  const scopeManager = createScopeManager(
    withProjectScope(config.scopes, projectScope, ctx.worktree),
  );

  await appLog(ctx, "info", "plugin runtime initialized", {
    dbPath: config.dbPath,
    embeddingModel: config.embedding.model,
    retrievalMode: retriever.getConfig().mode,
    projectScope,
  });

  return {
    config,
    store,
    retriever,
    scopeManager,
    embedder,
    projectScope,
  };
}

function ensureCategory(value?: string): MemoryCategory | undefined {
  if (!value) return undefined;
  if (MEMORY_CATEGORIES.includes(value as MemoryCategory)) {
    return value as MemoryCategory;
  }
  return undefined;
}

function resolveScopeFilter(
  runtime: Runtime,
  _agentId: string,
  requestedScope?: string,
): { scopeFilter?: string[]; error?: string } {
  if (requestedScope) {
    if (!runtime.scopeManager.validateScope(requestedScope)) {
      return { error: `Invalid scope: ${requestedScope}` };
    }
    ensureScopeDefinition(runtime, requestedScope, `Auto-created scope: ${requestedScope}`);
    return { scopeFilter: [requestedScope] };
  }
  return { scopeFilter: [runtime.projectScope] };
}

function requireManagement(runtime: Runtime): string | null {
  if (runtime.config.enableManagementTools) {
    return null;
  }
  return "Management tools are disabled. Set enableManagementTools=true in OpenCode/config.json.";
}

function hashText(text: string): string {
  return createHash("sha1").update(normalizeText(text).toLowerCase()).digest("hex");
}

async function storeAutoMemoryDraft(
  runtime: Runtime,
  draft: AutoMemoryDraft,
  recentHashes: Set<string>,
): Promise<{ stored: boolean; reason?: string; id?: string }> {
  if (isNoise(draft.text)) {
    return { stored: false, reason: "noise" };
  }

  const digest = hashText(draft.text);
  if (recentHashes.has(digest)) {
    return { stored: false, reason: "recent-duplicate" };
  }

  const vector = await runtime.embedder.embedPassage(draft.text);
  const existing = await runtime.store.vectorSearch(vector, 1, 0.1, [runtime.projectScope]);
  if (existing.length > 0 && existing[0].score > 0.985) {
    recentHashes.add(digest);
    return { stored: false, reason: "vector-duplicate" };
  }

  const stored = await runtime.store.store({
    text: draft.text,
    vector,
    importance: draft.importance,
    category: draft.category,
    scope: runtime.projectScope,
    metadata: JSON.stringify(draft.metadata ?? {}),
  });

  recentHashes.add(digest);
  if (recentHashes.size > 1000) {
    const first = recentHashes.values().next();
    if (!first.done) {
      recentHashes.delete(first.value);
    }
  }

  return { stored: true, id: stored.id };
}

export const MemoryLanceDBProPlugin: Plugin = async (ctx) => {
  let runtimePromise: Promise<Runtime> | null = null;
  const messageTextCache = new Map<string, string>();
  const messageRoleCache = new Map<string, string>();
  const messageSessionCache = new Map<string, string>();
  const messageFileCache = new Map<string, Set<string>>();
  const messageLanguageCache = new Map<string, Set<string>>();
  const sessionModelCache = new Map<string, SessionModelInfo>();
  const processedMessageHashes = new Set<string>();
  const recentMemoryHashes = new Set<string>();
  const sessionProcessing = new Set<string>();

  const getRuntime = async (): Promise<Runtime> => {
    if (!runtimePromise) {
      runtimePromise = buildRuntime(ctx).catch((error) => {
        runtimePromise = null;
        throw error;
      });
    }
    return runtimePromise;
  };

  const collectMessageSnapshot = (event: any): void => {
    const props = toRecord(event?.properties);
    if (!props) return;

    const info = toRecord(props.info);
    if (info) {
      const messageId = typeof info.id === "string" ? info.id : undefined;
      const role = typeof info.role === "string" ? info.role : undefined;
      const sessionID = typeof info.sessionID === "string" ? info.sessionID : undefined;

      if (messageId && role) {
        messageRoleCache.set(messageId, role);
      }
      if (messageId && sessionID) {
        messageSessionCache.set(messageId, sessionID);
      }

      const modelRef = typeof info.model === "string" ? info.model : undefined;
      if (sessionID && modelRef) {
        const parsed = parseModelRef(modelRef);
        if (parsed) {
          sessionModelCache.set(sessionID, parsed);
        }
      }

      const summary = toRecord(info.summary);
      const summaryText =
        (summary && typeof summary.body === "string" && summary.body) ||
        (summary && typeof summary.title === "string" && summary.title) ||
        undefined;

      if (messageId && summaryText && !messageTextCache.has(messageId)) {
        messageTextCache.set(messageId, summaryText);
      }
    }

    const part = toRecord(props.part);
    if (part && part.type === "text") {
      const messageID = typeof part.messageID === "string" ? part.messageID : undefined;
      const sessionID = typeof part.sessionID === "string" ? part.sessionID : undefined;
      if (!messageID) return;

      if (sessionID) {
        messageSessionCache.set(messageID, sessionID);
      }

      const existing = messageTextCache.get(messageID) || "";
      if (typeof props.delta === "string" && props.delta.length > 0) {
        messageTextCache.set(messageID, `${existing}${props.delta}`);
        return;
      }

      if (typeof part.text === "string" && part.text.length > 0) {
        messageTextCache.set(messageID, part.text);
      }
      return;
    }

    if (part && part.type === "file") {
      const messageID = typeof part.messageID === "string" ? part.messageID : undefined;
      const sessionID = typeof part.sessionID === "string" ? part.sessionID : undefined;
      if (!messageID) return;

      if (sessionID) {
        messageSessionCache.set(messageID, sessionID);
      }

      const source = toRecord(part.source);
      const pathValue = source && typeof source.path === "string" ? source.path : undefined;
      if (pathValue) {
        const files = messageFileCache.get(messageID) ?? new Set<string>();
        files.add(pathValue);
        messageFileCache.set(messageID, files);

        const detected = detectLanguageFromPath(pathValue);
        if (detected) {
          const langs = messageLanguageCache.get(messageID) ?? new Set<string>();
          langs.add(detected);
          messageLanguageCache.set(messageID, langs);
        }
      }
    }
  };

  const processOneMessageAutoMemory = async (
    sessionID: string,
    messageID: string,
  ): Promise<{
    candidateCount: number;
    modelAcceptedCount: number;
    modelDecisionUnavailableCount: number;
    storedCount: number;
  }> => {
    const cachedText = messageTextCache.get(messageID) || "";
    const normalized = normalizeText(cachedText);
    if (!normalized) {
      return {
        candidateCount: 0,
        modelAcceptedCount: 0,
        modelDecisionUnavailableCount: 0,
        storedCount: 0,
      };
    }

    const messageHash = hashText(`${sessionID}|${messageID}|${normalized}`);
    if (processedMessageHashes.has(messageHash)) {
      return {
        candidateCount: 0,
        modelAcceptedCount: 0,
        modelDecisionUnavailableCount: 0,
        storedCount: 0,
      };
    }

    processedMessageHashes.add(messageHash);
    if (processedMessageHashes.size > 5000) {
      const first = processedMessageHashes.values().next();
      if (!first.done) {
        processedMessageHashes.delete(first.value);
      }
    }

    const role = messageRoleCache.get(messageID);
    const filePaths = [...(messageFileCache.get(messageID) ?? new Set<string>())];
    const languages = [...(messageLanguageCache.get(messageID) ?? new Set<string>())];
    const runtime = await getRuntime();
    ensureScopeDefinition(
      runtime,
      runtime.projectScope,
      `Project-scoped memory for ${ctx.worktree}`,
    );

    const drafts = extractAutoMemoryDrafts(normalized, {
      role,
      filePaths,
      languages,
    });

    const decisions = await decideDraftsWithModel(
      ctx,
      drafts,
      sessionModelCache.get(sessionID),
    );

    const decisionMap = new Map<string, LlmDecision>();
    for (const decision of decisions ?? []) {
      decisionMap.set(decision.id, decision);
    }

    let storedCount = 0;
    let modelAcceptedCount = 0;
    const modelDecisionUnavailableCount =
      drafts.length > 0 && decisions === null ? drafts.length : 0;

    for (let idx = 0; idx < drafts.length; idx++) {
      const draft = drafts[idx];
      const candidateId = `c${idx + 1}`;
      const decision = decisionMap.get(candidateId);

      if (!decision?.store) {
        continue;
      }

      if (typeof decision.confidence === "number" && decision.confidence < 0.6) {
        continue;
      }

      modelAcceptedCount += 1;

      const finalDraft: AutoMemoryDraft = {
        ...draft,
        text: decision.summary ? truncateText(decision.summary, 900) : draft.text,
        category: decision.category ?? draft.category,
        importance: decision.importance ?? draft.importance,
      };

      const result = await storeAutoMemoryDraft(runtime, finalDraft, recentMemoryHashes);
      if (result.stored) {
        storedCount += 1;
      }
    }

    return {
      candidateCount: drafts.length,
      modelAcceptedCount,
      modelDecisionUnavailableCount,
      storedCount,
    };
  };

  const flushSessionAutoMemories = async (sessionID: string): Promise<void> => {
    if (!sessionID || sessionProcessing.has(sessionID)) {
      return;
    }

    sessionProcessing.add(sessionID);
    try {
      const runtime = await getRuntime();
      ensureScopeDefinition(
        runtime,
        runtime.projectScope,
        `Project-scoped memory for ${ctx.worktree}`,
      );

      let storedCount = 0;
      let candidateCount = 0;
      let modelAcceptedCount = 0;
      let modelDecisionUnavailableCount = 0;

      for (const [messageID, cachedText] of messageTextCache.entries()) {
        if (messageSessionCache.get(messageID) !== sessionID) {
          continue;
        }

        const res = await processOneMessageAutoMemory(sessionID, messageID);
        candidateCount += res.candidateCount;
        modelAcceptedCount += res.modelAcceptedCount;
        modelDecisionUnavailableCount += res.modelDecisionUnavailableCount;
        storedCount += res.storedCount;

        messageTextCache.delete(messageID);
        messageRoleCache.delete(messageID);
        messageSessionCache.delete(messageID);
        messageFileCache.delete(messageID);
        messageLanguageCache.delete(messageID);
      }

      if (storedCount > 0 || candidateCount > 0) {
        await appLog(ctx, "info", "auto memory extraction completed", {
          sessionID,
          projectScope: runtime.projectScope,
          candidateCount,
          modelAcceptedCount,
          modelDecisionUnavailableCount,
          storedCount,
        });
      }
    } finally {
      sessionProcessing.delete(sessionID);
    }
  };

  return {
    tool: {
      memory_recall: tool({
        description:
          "Search long-term memories using hybrid retrieval (vector + BM25).",
        args: {
          query: tool.schema.string().min(1).describe("Search query"),
          limit: tool.schema
            .number()
            .int()
            .min(1)
            .max(20)
            .optional()
            .describe("Max results (default 5)"),
          scope: tool.schema
            .string()
            .optional()
            .describe("Optional scope filter"),
          category: tool.schema
            .enum(MEMORY_CATEGORIES)
            .optional()
            .describe("Optional category filter"),
        },
        async execute(args, toolCtx) {
          const runtime = await getRuntime();
          const agentId = toolCtx.agent || "main";
          const { scopeFilter, error } = resolveScopeFilter(
            runtime,
            agentId,
            args.scope,
          );
          if (error || !scopeFilter) return error || "Invalid scope";

          const requestedLimit = args.limit ?? 5;
          const candidates = await runtime.retriever.retrieve({
            query: args.query,
            limit: Math.min(20, Math.max(requestedLimit * 4, requestedLimit)),
            scopeFilter,
            category: ensureCategory(args.category),
            source: "manual",
          });

          const results = applyPrecisionFilter(args.query, candidates, requestedLimit);

          if (results.length === 0) {
            return "No relevant memories found.";
          }

          const lines = results.map((item, index) => {
            const sourceTags: string[] = [];
            if (item.sources.vector) sourceTags.push("vector");
            if (item.sources.bm25) sourceTags.push("bm25");
            if (item.sources.reranked) sourceTags.push("reranked");
            const sourceText = sourceTags.length > 0 ? `, ${sourceTags.join("+")}` : "";
            const metadataSuffix = formatMetadataSuffix(item.entry.metadata);
            return `${index + 1}. [${item.entry.id}] [${item.entry.category}:${item.entry.scope}] ${formatPreview(item.entry.text, 140)}${metadataSuffix} (${(item.score * 100).toFixed(0)}%${sourceText})`;
          });

          return `Found ${results.length} memories:\n${lines.join("\n")}`;
        },
      }),

      memory_store: tool({
        description: "Store a new long-term memory entry.",
        args: {
          text: tool.schema.string().min(1).describe("Memory text"),
          importance: tool.schema
            .number()
            .min(0)
            .max(1)
            .optional()
            .describe("Importance score 0-1"),
          category: tool.schema
            .enum(MEMORY_CATEGORIES)
            .optional()
            .describe("Memory category"),
          scope: tool.schema
            .string()
            .optional()
            .describe("Target scope (optional)"),
        },
        async execute(args, toolCtx) {
          const runtime = await getRuntime();

          const targetScope =
            args.scope || runtime.projectScope;
          if (!runtime.scopeManager.validateScope(targetScope)) {
            return `Invalid scope: ${targetScope}`;
          }

          ensureScopeDefinition(runtime, targetScope, `Auto-created scope: ${targetScope}`);

          if (isNoise(args.text)) {
            return "Skipped: text detected as noise (greetings/meta/boilerplate).";
          }

          const category = ensureCategory(args.category) || "other";
          const importance = clamp01(args.importance ?? 0.7, 0.7);

          const vector = await runtime.embedder.embedPassage(args.text);
          const existing = await runtime.store.vectorSearch(vector, 1, 0.1, [
            targetScope,
          ]);

          if (existing.length > 0 && existing[0].score > 0.98) {
            return `Similar memory already exists: [${existing[0].entry.id}] ${formatPreview(existing[0].entry.text)}`;
          }

          const entry = await runtime.store.store({
            text: args.text,
            vector,
            importance,
            category,
            scope: targetScope,
          });

          return `Stored memory [${entry.id}] in scope '${entry.scope}' as ${entry.category}.`;
        },
      }),

      memory_forget: tool({
        description: "Delete memory by id, or find-and-delete by query.",
        args: {
          memoryId: tool.schema
            .string()
            .optional()
            .describe("Memory ID (full UUID or 8+ prefix)"),
          query: tool.schema
            .string()
            .optional()
            .describe("Query used to find memory candidates"),
          scope: tool.schema
            .string()
            .optional()
            .describe("Optional scope filter"),
        },
        async execute(args, toolCtx) {
          const runtime = await getRuntime();
          const agentId = toolCtx.agent || "main";
          const { scopeFilter, error } = resolveScopeFilter(
            runtime,
            agentId,
            args.scope,
          );
          if (error || !scopeFilter) return error || "Invalid scope";

          if (args.memoryId) {
            const deleted = await runtime.store.delete(args.memoryId, scopeFilter);
            if (!deleted) {
              return `Memory ${args.memoryId} not found (or inaccessible).`;
            }
            return `Memory ${args.memoryId} deleted.`;
          }

          if (!args.query) {
            return "Provide either memoryId or query.";
          }

          const results = await runtime.retriever.retrieve({
            query: args.query,
            limit: 5,
            scopeFilter,
            source: "manual",
          });

          if (results.length === 0) {
            return "No matching memories found.";
          }

          if (results.length === 1 && results[0].score > 0.9) {
            await runtime.store.delete(results[0].entry.id, scopeFilter);
            return `Deleted matched memory [${results[0].entry.id}].`;
          }

          const candidates = results
            .map(
              (item) =>
                `- [${item.entry.id.slice(0, 8)}] ${formatPreview(item.entry.text, 120)} (${(item.score * 100).toFixed(0)}%)`,
            )
            .join("\n");

          return `Found ${results.length} candidates. Re-run with memoryId:\n${candidates}`;
        },
      }),

      memory_update: tool({
        description:
          "Update an existing memory entry (text/importance/category) while keeping its original timestamp.",
        args: {
          memoryId: tool.schema
            .string()
            .min(1)
            .describe("Memory ID or search text"),
          scope: tool.schema
            .string()
            .optional()
            .describe("Optional scope filter for target memory"),
          text: tool.schema
            .string()
            .optional()
            .describe("New memory text"),
          importance: tool.schema
            .number()
            .min(0)
            .max(1)
            .optional()
            .describe("New importance score"),
          category: tool.schema
            .enum(MEMORY_CATEGORIES)
            .optional()
            .describe("New category"),
        },
        async execute(args, toolCtx) {
          const runtime = await getRuntime();
          const agentId = toolCtx.agent || "main";
          const { scopeFilter, error } = resolveScopeFilter(
            runtime,
            agentId,
            args.scope,
          );
          if (error || !scopeFilter) return error || "Invalid scope";

          if (
            args.text === undefined &&
            args.importance === undefined &&
            args.category === undefined
          ) {
            return "Nothing to update. Provide text, importance, or category.";
          }

          let resolvedId = args.memoryId;
          if (!looksLikeMemoryId(args.memoryId)) {
            const candidates = await runtime.retriever.retrieve({
              query: args.memoryId,
              limit: 3,
              scopeFilter,
              source: "manual",
            });

            if (candidates.length === 0) {
              return `No memory found for '${args.memoryId}'.`;
            }

            if (candidates.length === 1 || candidates[0].score > 0.85) {
              resolvedId = candidates[0].entry.id;
            } else {
              const lines = candidates
                .map(
                  (item) =>
                    `- [${item.entry.id.slice(0, 8)}] ${formatPreview(item.entry.text, 110)} (${(item.score * 100).toFixed(0)}%)`,
                )
                .join("\n");
              return `Multiple matches found. Use memoryId:\n${lines}`;
            }
          }

          if (args.text && isNoise(args.text)) {
            return "Skipped: updated text detected as noise.";
          }

          const updates: {
            text?: string;
            vector?: number[];
            importance?: number;
            category?: MemoryEntry["category"];
          } = {};

          if (args.text) {
            updates.text = args.text;
            updates.vector = await runtime.embedder.embedPassage(args.text);
          }
          if (args.importance !== undefined) {
            updates.importance = clamp01(args.importance, 0.7);
          }
          if (args.category) {
            updates.category = args.category;
          }

          const updated = await runtime.store.update(resolvedId, updates, scopeFilter);
          if (!updated) {
            return `Memory ${resolvedId} not found (or inaccessible).`;
          }

          return `Updated memory [${updated.id}] (${updated.category}, importance=${updated.importance.toFixed(2)}).`;
        },
      }),

      memory_list: tool({
        description: "List memory entries with optional filters.",
        args: {
          limit: tool.schema
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .describe("Page size, default 10"),
          offset: tool.schema
            .number()
            .int()
            .min(0)
            .max(1000)
            .optional()
            .describe("Offset, default 0"),
          scope: tool.schema
            .string()
            .optional()
            .describe("Optional scope filter"),
          category: tool.schema
            .enum(MEMORY_CATEGORIES)
            .optional()
            .describe("Optional category filter"),
        },
        async execute(args, toolCtx) {
          const runtime = await getRuntime();
          const managementError = requireManagement(runtime);
          if (managementError) return managementError;

          const agentId = toolCtx.agent || "main";
          const { scopeFilter, error } = resolveScopeFilter(
            runtime,
            agentId,
            args.scope,
          );
          if (error || !scopeFilter) return error || "Invalid scope";

          const limit = clampInt(args.limit ?? 10, 1, 50);
          const offset = clampInt(args.offset ?? 0, 0, 1000);
          const entries = await runtime.store.list(
            scopeFilter,
            ensureCategory(args.category),
            limit,
            offset,
          );

          if (entries.length === 0) {
            return "No memories found.";
          }

          const lines = entries.map((entry, index) => {
            const date = new Date(entry.timestamp).toISOString().slice(0, 10);
            const metadataSuffix = formatMetadataSuffix(entry.metadata);
            return `${offset + index + 1}. [${entry.id}] [${entry.category}:${entry.scope}] ${formatPreview(entry.text, 120)}${metadataSuffix} (${date})`;
          });

          return `Listed ${entries.length} memories:\n${lines.join("\n")}`;
        },
      }),

      memory_stats: tool({
        description: "Show memory statistics across scopes and categories.",
        args: {
          scope: tool.schema
            .string()
            .optional()
            .describe("Optional scope filter"),
        },
        async execute(args, toolCtx) {
          const runtime = await getRuntime();
          const managementError = requireManagement(runtime);
          if (managementError) return managementError;

          const agentId = toolCtx.agent || "main";
          const { scopeFilter, error } = resolveScopeFilter(
            runtime,
            agentId,
            args.scope,
          );
          if (error || !scopeFilter) return error || "Invalid scope";

          const stats = await runtime.store.stats(scopeFilter);
          const retrievalCfg = runtime.retriever.getConfig();

          const scopeLines = Object.entries(stats.scopeCounts)
            .map(([scope, count]) => `- ${scope}: ${count}`)
            .join("\n");
          const categoryLines = Object.entries(stats.categoryCounts)
            .map(([category, count]) => `- ${category}: ${count}`)
            .join("\n");

          return [
            "Memory statistics:",
            `- total: ${stats.totalCount}`,
            `- retrieval mode: ${retrievalCfg.mode}`,
            `- FTS enabled: ${runtime.store.hasFtsSupport ? "yes" : "no"}`,
            "",
            "By scope:",
            scopeLines || "- (none)",
            "",
            "By category:",
            categoryLines || "- (none)",
          ].join("\n");
        },
      }),
    },

    "chat.message": async (input, output) => {
      if (input.model?.providerID && input.model?.modelID) {
        sessionModelCache.set(input.sessionID, {
          providerID: input.model.providerID,
          modelID: input.model.modelID,
        });
      }

      if (input.messageID && Array.isArray(output?.parts)) {
        const chunks: string[] = [];
        const files = new Set<string>();
        const langs = new Set<string>();

        for (const part of output.parts) {
          if (part.type === "text" && "text" in part && typeof part.text === "string") {
            chunks.push(part.text);
            continue;
          }

          if (part.type === "file" && "source" in part) {
            const src = toRecord(part.source);
            const pathValue = src && typeof src.path === "string" ? src.path : undefined;
            if (pathValue) {
              files.add(pathValue);
              const lang = detectLanguageFromPath(pathValue);
              if (lang) {
                langs.add(lang);
              }
            }
          }
        }

        const text = chunks.join("\n").trim();
        if (text) {
          messageTextCache.set(input.messageID, text);
          messageRoleCache.set(input.messageID, "user");
          messageSessionCache.set(input.messageID, input.sessionID);
        }

        if (files.size > 0) {
          messageFileCache.set(input.messageID, files);
        }
        if (langs.size > 0) {
          messageLanguageCache.set(input.messageID, langs);
        }

        // Synchronous auto-memory extraction: process immediately after message arrives.
        // session.idle remains as a safety net for streamed/partial event paths.
        try {
          const res = await processOneMessageAutoMemory(input.sessionID, input.messageID);
          if (res.candidateCount > 0) {
            await appLog(ctx, "info", "auto memory extraction synced", {
              sessionID: input.sessionID,
              messageID: input.messageID,
              candidateCount: res.candidateCount,
              modelAcceptedCount: res.modelAcceptedCount,
              modelDecisionUnavailableCount: res.modelDecisionUnavailableCount,
              storedCount: res.storedCount,
            });
          }
        } catch (error) {
          await appLog(ctx, "warn", "auto memory sync failed", {
            sessionID: input.sessionID,
            messageID: input.messageID,
            error: String(error),
          });
        }

        // Cleanup message-level cache eagerly; dedup hash prevents reprocessing.
        messageTextCache.delete(input.messageID);
        messageRoleCache.delete(input.messageID);
        messageSessionCache.delete(input.messageID);
        messageFileCache.delete(input.messageID);
        messageLanguageCache.delete(input.messageID);
      }
    },

    event: async ({ event }) => {
      if (event.type === "server.connected") {
        try {
          const runtime = await getRuntime();
          await appLog(ctx, "info", "project scope ready", {
            projectScope: runtime.projectScope,
            worktree: ctx.worktree,
          });
        } catch (error) {
          await appLog(ctx, "error", "project scope init failed", {
            error: String(error),
            worktree: ctx.worktree,
          });
        }

        await appLog(ctx, "info", "plugin loaded", {
          directory: ctx.directory,
          worktree: ctx.worktree,
        });
        return;
      }

      if (event.type === "message.updated" || event.type === "message.part.updated") {
        collectMessageSnapshot(event as any);
        return;
      }

      if (event.type === "message.removed") {
        const props = toRecord((event as any)?.properties);
        const messageID = props && typeof props.messageID === "string" ? props.messageID : undefined;
        if (messageID) {
          messageTextCache.delete(messageID);
          messageRoleCache.delete(messageID);
          messageSessionCache.delete(messageID);
          messageFileCache.delete(messageID);
          messageLanguageCache.delete(messageID);
        }
        return;
      }

      if (event.type === "session.idle") {
        const props = toRecord((event as any)?.properties);
        const sessionID = props && typeof props.sessionID === "string" ? props.sessionID : undefined;
        if (sessionID) {
          await flushSessionAutoMemories(sessionID);
        }
        return;
      }
    },
  };
};

export default MemoryLanceDBProPlugin;
