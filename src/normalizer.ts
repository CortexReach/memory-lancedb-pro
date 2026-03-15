import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { MemoryEntry } from "./store.js";
import { buildRawFallbackDraft, buildRuleDrafts } from "./normalization-rules.js";
import { validateNormalizedDrafts } from "./normalization-validate.js";
import type { NormalizationAuditRecord, NormalizationCandidate, NormalizedMemoryDraft } from "./normalization-types.js";

type Logger = {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

export interface NormalizerConfig {
  enabled: boolean;
  apiKey: string;
  model: string;
  baseURL: string;
  temperature: number;
  maxTokens: number;
  enableThinking: boolean;
  timeoutMs: number;
  maxEntriesPerCandidate: number;
  fallbackMode: "rules-then-raw" | "raw-only";
  audit: {
    enabled: boolean;
    logPath?: string;
  };
}

interface NormalizerDeps {
  fetchImpl?: typeof fetch;
}

interface NormalizationContext {
  agentId?: string;
  scope: string;
  source: string;
  confidence?: number;
  sourceRef?: string;
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const textParts = content
      .filter((item): item is { type?: unknown; text?: unknown } => Boolean(item) && typeof item === "object")
      .filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text as string);
    return textParts.join("\n");
  }
  return "";
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1);
  }
  return text.trim();
}

function buildPrompt(candidate: NormalizationCandidate, maxEntries: number): Array<{ role: "system" | "user"; content: string }> {
  const payload = {
    text: candidate.text,
    role: candidate.role,
    categoryHint: candidate.category,
    atomicHint: {
      unitType: candidate.unitType,
      sourceKind: candidate.sourceKind,
    },
    constraints: {
      maxEntries,
      preserveTechnicalAnchors: true,
      noSpeculation: true,
    },
  };

  return [
    {
      role: "system",
      content:
        "You are a memory normalizer. Transform a candidate memory into 1 to 3 long-term memory entries. " +
        "Preserve exact technical anchors such as error phrases, file names, config keys, model names, ports, and paths. " +
        "Do not invent facts. Remove acknowledgements, chatter, and process-only wording. " +
        "Return strict JSON only with shape {\"entries\":[{\"canonicalText\":\"...\",\"category\":\"preference|fact|decision|entity|other\",\"atomic\":{\"unitType\":\"preference|fact|decision|lesson|environment|entity|other\",\"sourceKind\":\"user|tool|agent|imported\",\"confidence\":0.0,\"tags\":[\"...\"]},\"reason\":\"...\"}]}.",
    },
    {
      role: "user",
      content: JSON.stringify(payload),
    },
  ];
}

async function appendAuditRecord(logPath: string | undefined, record: NormalizationAuditRecord): Promise<void> {
  if (!logPath) return;
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, `${JSON.stringify(record)}\n`, "utf8");
}

export function createMemoryNormalizer(config: NormalizerConfig, logger?: Logger, deps: NormalizerDeps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;

  async function normalizeWithLLM(candidate: NormalizationCandidate, context: NormalizationContext): Promise<NormalizedMemoryDraft[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

    try {
      const response = await fetchImpl(config.baseURL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: buildPrompt(candidate, config.maxEntriesPerCandidate),
          temperature: config.temperature,
          max_tokens: config.maxTokens,
          enable_thinking: config.enableThinking,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`normalizer_api_${response.status}: ${body.slice(0, 300)}`);
      }

      const payload = await response.json() as Record<string, unknown>;
      const choices = Array.isArray(payload.choices) ? payload.choices as Array<Record<string, unknown>> : [];
      const first = choices[0] || {};
      const message = first.message && typeof first.message === "object" ? first.message as Record<string, unknown> : {};
      const contentText = extractMessageText(message.content);
      const jsonText = extractJson(contentText);
      const parsed = JSON.parse(jsonText) as { entries?: unknown };
      const validation = validateNormalizedDrafts(candidate, parsed.entries, {
        maxEntries: config.maxEntriesPerCandidate,
        confidence: context.confidence,
        sourceRef: context.sourceRef,
      });
      if (validation.entries.length === 0) {
        throw new Error(`normalizer_validation_failed:${validation.errors.join(",") || "unknown"}`);
      }
      return validation.entries.map((entry) => ({ ...entry, normalizationMode: "llm" }));
    } finally {
      clearTimeout(timeout);
    }
  }

  async function normalizeCandidate(candidate: NormalizationCandidate, context: NormalizationContext): Promise<NormalizedMemoryDraft[]> {
    const auditBase: Omit<NormalizationAuditRecord, "entries"> = {
      timestamp: Date.now(),
      agentId: context.agentId,
      scope: context.scope,
      source: context.source,
      candidate: {
        text: candidate.text,
        role: candidate.role,
        sourceKind: candidate.sourceKind,
        category: candidate.category,
        unitType: candidate.unitType,
      },
    };

    if (!config.enabled) {
      return buildRawFallbackDraft(candidate, {
        confidence: context.confidence,
        sourceRef: context.sourceRef,
      });
    }

    try {
      const entries = await normalizeWithLLM(candidate, context);
      if (config.audit.enabled) {
        await appendAuditRecord(config.audit.logPath, {
          ...auditBase,
          entries: entries.map((entry) => ({
            canonicalText: entry.canonicalText,
            category: entry.category,
            atomic: entry.atomic,
            normalizationMode: entry.normalizationMode,
            ...(entry.reason ? { reason: entry.reason } : {}),
          })),
        });
      }
      return entries;
    } catch (error) {
      logger?.warn?.(`memory-lancedb-pro: normalizer LLM failed, using fallback (${String(error)})`);
      const fallbackEntries = config.fallbackMode === "raw-only"
        ? buildRawFallbackDraft(candidate, { confidence: context.confidence, sourceRef: context.sourceRef })
        : buildRuleDrafts(candidate, { confidence: context.confidence, sourceRef: context.sourceRef });

      const validated = validateNormalizedDrafts(candidate, fallbackEntries, {
        maxEntries: config.maxEntriesPerCandidate,
        confidence: context.confidence,
        sourceRef: context.sourceRef,
      });
      const entries = validated.entries.length > 0
        ? validated.entries
        : buildRawFallbackDraft(candidate, { confidence: context.confidence, sourceRef: context.sourceRef });

      if (config.audit.enabled) {
        await appendAuditRecord(config.audit.logPath, {
          ...auditBase,
          entries: entries.map((entry) => ({
            canonicalText: entry.canonicalText,
            category: entry.category,
            atomic: entry.atomic,
            normalizationMode: entry.normalizationMode,
            ...(entry.reason ? { reason: entry.reason } : {}),
          })),
          fallback: validated.entries.length > 0 ? "rules" : "raw",
          errors: [String(error), ...validated.errors],
        });
      }
      return entries;
    }
  }

  return {
    normalizeCandidate,
  };
}
