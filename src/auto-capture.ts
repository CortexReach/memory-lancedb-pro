import { buildAtomicMemoryMetadata, type AtomicMemoryUnitType } from "./atomic-memory.js";
import type { Embedder } from "./embedder.js";
import type { createMemoryNormalizer } from "./normalizer.js";
import { isRuntimeChatter } from "./normalization-rules.js";
import type { NormalizedMemoryDraft } from "./normalization-types.js";
import type { MemoryEntry, MemoryStore } from "./store.js";

const MEMORY_TRIGGERS = [
  /zapamatuj si|pamatuj|remember/i,
  /preferuji|radši|nechci|prefer/i,
  /rozhodli jsme|budeme používat/i,
  /\b(we )?decided\b|we'?ll use|we will use|switch(ed)? to|migrate(d)? to|going forward|from now on/i,
  /\+\d{10,}/,
  /[\w.-]+@[\w.-]+\.\w+/,
  /můj\s+\w+\s+je|je\s+můj/i,
  /my\s+\w+\s+is|is\s+my/i,
  /i (like|prefer|hate|love|want|need|care)/i,
  /always|never|important/i,
  /記住|记住|記一下|记一下|別忘了|别忘了|備註|备注/,
  /偏好|喜好|喜歡|喜欢|討厭|讨厌|不喜歡|不喜欢|愛用|爱用|習慣|习惯/,
  /決定|决定|選擇了|选择了|改用|換成|换成|以後用|以后用/,
  /我的\S+是|叫我|稱呼|称呼/,
  /老是|講不聽|總是|总是|從不|从不|一直|每次都/,
  /重要|關鍵|关键|注意|千萬別|千万别/,
  /幫我|筆記|存檔|存起来|存起來|存一下|重點|重点|原則|原则|底線|底线/,
] as const;

const CAPTURE_EXCLUDE_PATTERNS = [
  /\b(memory-pro|memory_store|memory_recall|memory_forget|memory_update)\b/i,
  /\bopenclaw\s+memory-pro\b/i,
  /\b(delete|remove|forget|purge|cleanup|clean up|clear)\b.*\b(memory|memories|entry|entries)\b/i,
  /\b(memory|memories)\b.*\b(delete|remove|forget|purge|cleanup|clean up|clear)\b/i,
  /\bhow do i\b.*\b(delete|remove|forget|purge|cleanup|clear)\b/i,
  /(删除|刪除|清理|清除).{0,12}(记忆|記憶|memory)/i,
] as const;

type MessageRole = "user" | "assistant";

export interface AutoCaptureCandidate {
  text: string;
  role: MessageRole;
  sourceKind: "user" | "agent";
  category: MemoryEntry["category"];
  unitType: AtomicMemoryUnitType;
}

export interface StoreAutoCaptureParams {
  candidates: AutoCaptureCandidate[];
  store: MemoryStore;
  embedder: Pick<Embedder, "embedPassage">;
  scope: string;
  importance?: number;
  limit?: number;
}

export interface NormalizeAndStoreAutoCaptureParams extends StoreAutoCaptureParams {
  normalizer: ReturnType<typeof createMemoryNormalizer>;
  agentId?: string;
}

export function shouldCapture(text: string): boolean {
  let s = text.trim();

  // Strip OpenClaw metadata headers before trigger matching so transport/session
  // wrappers do not get mistaken for meaningful memory content.
  const metadataPattern = /^(Conversation info|Sender) \(untrusted metadata\):[\s\S]*?\n\s*\n/gim;
  s = s.replace(metadataPattern, "");

  const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(s);
  const minLen = hasCJK ? 4 : 10;
  if (s.length < minLen || s.length > 500) return false;
  if (isRuntimeChatter(s)) return false;
  if (s.includes("<relevant-memories>")) return false;
  if (s.startsWith("<") && s.includes("</")) return false;
  if (s.includes("**") && s.includes("\n-")) return false;
  const emojiCount = (s.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length;
  if (emojiCount > 3) return false;
  if (CAPTURE_EXCLUDE_PATTERNS.some((pattern) => pattern.test(s))) return false;
  return MEMORY_TRIGGERS.some((pattern) => pattern.test(s));
}

export function detectCategory(text: string): MemoryEntry["category"] {
  const lower = text.toLowerCase();
  if (/prefer|radši|like|love|hate|want|偏好|喜歡|喜欢|討厭|讨厌|不喜歡|不喜欢|愛用|爱用|習慣|习惯|希望|想要|最好/i.test(lower)) {
    return "preference";
  }
  if (/rozhodli|decided|we decided|will use|we will use|we'?ll use|switch(ed)? to|migrate(d)? to|going forward|from now on|budeme|決定|决定|選擇了|选择了|改用|換成|换成|以後用|以后用|規則|规则|流程|SOP/i.test(lower)) {
    return "decision";
  }
  if (/\+\d{10,}|@[\w.-]+\.\w+|is called|jmenuje se|我的\S+是|叫我|稱呼|称呼/i.test(lower)) {
    return "entity";
  }
  if (/\b(is|are|has|have|je|má|jsou)\b|總是|总是|從不|从不|一直|每次都|老是/i.test(lower)) {
    return "fact";
  }
  return "other";
}

export function detectAtomicUnitType(
  text: string,
  category: MemoryEntry["category"],
): AtomicMemoryUnitType {
  const lower = text.toLowerCase();
  if (/pitfall|lesson learned|踩坑|教训|千萬別|千万别|別再|别再/i.test(lower)) {
    return "lesson";
  }
  if (/\b(path|shell|node|zsh|bash|launchd|gateway|workspace|env|environment)\b|环境|環境|路径|路徑/i.test(lower)) {
    return "environment";
  }
  switch (category) {
    case "preference":
    case "fact":
    case "decision":
    case "entity":
      return category;
    default:
      return "other";
  }
}

function extractTextBlocks(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      "type" in block &&
      (block as Record<string, unknown>).type === "text" &&
      "text" in block &&
      typeof (block as Record<string, unknown>).text === "string"
    ) {
      texts.push((block as Record<string, unknown>).text as string);
    }
  }
  return texts;
}

export function extractAutoCaptureCandidates(
  messages: unknown[],
  options: { captureAssistant?: boolean } = {},
): AutoCaptureCandidate[] {
  const candidates: AutoCaptureCandidate[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const msgObj = msg as Record<string, unknown>;
    const role = msgObj.role;
    if (role !== "user" && !(options.captureAssistant === true && role === "assistant")) {
      continue;
    }

    const texts = extractTextBlocks(msgObj.content);
    for (const text of texts) {
      if (!text || !shouldCapture(text)) continue;
      const category = detectCategory(text);
      candidates.push({
        text,
        role: role as MessageRole,
        sourceKind: role === "assistant" ? "agent" : "user",
        category,
        unitType: detectAtomicUnitType(text, category),
      });
    }
  }
  return candidates;
}

async function storeNormalizedDrafts({
  drafts,
  store,
  embedder,
  scope,
  importance = 0.7,
}: {
  drafts: NormalizedMemoryDraft[];
  store: MemoryStore;
  embedder: Pick<Embedder, "embedPassage">;
  scope: string;
  importance?: number;
}): Promise<MemoryEntry[]> {
  const stored: MemoryEntry[] = [];

  for (const draft of drafts) {
    const vector = await embedder.embedPassage(draft.canonicalText);
    const existing = await store.vectorSearch(vector, 1, 0.1, [scope]);
    if (existing.length > 0 && existing[0].score > 0.95) {
      continue;
    }

    const metadata = buildAtomicMemoryMetadata(draft.category, {
      unitType: draft.atomic.unitType,
      sourceKind: draft.atomic.sourceKind,
      confidence: draft.atomic.confidence ?? importance,
      sourceRef: draft.atomic.sourceRef,
      tags: draft.atomic.tags,
    });

    const entry = await store.store({
      text: draft.canonicalText,
      vector,
      importance,
      category: draft.category,
      scope,
      ...(metadata ? { metadata } : {}),
    });
    stored.push(entry);
  }

  return stored;
}

export async function storeAutoCaptureCandidates({
  candidates,
  store,
  embedder,
  scope,
  importance = 0.7,
  limit = 3,
}: StoreAutoCaptureParams): Promise<MemoryEntry[]> {
  const stored: MemoryEntry[] = [];

  for (const candidate of candidates.slice(0, limit)) {
    const vector = await embedder.embedPassage(candidate.text);
    const existing = await store.vectorSearch(vector, 1, 0.1, [scope]);
    if (existing.length > 0 && existing[0].score > 0.95) {
      continue;
    }

    const metadata = buildAtomicMemoryMetadata(candidate.category, {
      unitType: candidate.unitType,
      sourceKind: candidate.sourceKind,
      confidence: importance,
    });

    const entry = await store.store({
      text: candidate.text,
      vector,
      importance,
      category: candidate.category,
      scope,
      ...(metadata ? { metadata } : {}),
    });
    stored.push(entry);
  }

  return stored;
}

export async function normalizeAndStoreAutoCaptureCandidates({
  candidates,
  store,
  embedder,
  scope,
  importance = 0.7,
  limit = 3,
  normalizer,
  agentId,
}: NormalizeAndStoreAutoCaptureParams): Promise<MemoryEntry[]> {
  const normalizedDrafts: NormalizedMemoryDraft[] = [];

  for (const candidate of candidates.slice(0, limit)) {
    const entries = await normalizer.normalizeCandidate(candidate, {
      agentId,
      scope,
      source: "auto_capture",
      confidence: importance,
      sourceRef: "auto_capture",
    });
    normalizedDrafts.push(...entries.slice(0, limit));
  }

  return storeNormalizedDrafts({
    drafts: normalizedDrafts.slice(0, limit),
    store,
    embedder,
    scope,
    importance,
  });
}
