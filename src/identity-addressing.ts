import type { CandidateMemory } from "./memory-categories.js";

export const CANONICAL_NAME_FACT_KEY = "entities:姓名";
export const CANONICAL_ADDRESSING_FACT_KEY = "preferences:称呼偏好";

type IdentityKind = "name" | "addressing";
export type IdentityAddressingSlot = "name" | "addressing";

type IdentityAddressingMemoryLike = {
  factKey?: string;
  text?: string;
  abstract?: string;
  overview?: string;
  content?: string;
};

function trimCapturedValue(value: string): string {
  return value
    .replace(/^[\s"'“”‘’「」『』*`_]+/, "")
    .replace(/[\s"'“”‘’「」『』*`_。！，、,.!?:：；;]+$/u, "")
    .trim();
}

function extractFirst(patterns: RegExp[], text: string): string | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const captured = match?.[1] ? trimCapturedValue(match[1]) : "";
    if (captured) return captured;
  }
  return undefined;
}

function combineIdentityTextProbe(params: IdentityAddressingMemoryLike): string {
  return [
    params.text,
    params.abstract,
    params.overview,
    params.content,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim())
    .join("\n");
}

const NAME_PATTERNS = [
  /(?:我的名字是|我(?:现在)?叫|本名是)\s*([^\s，。,.!！?？"'“”‘’「」『』]+)/iu,
  /calls?\s+themselves\s+['"]([^'"]+)['"]/i,
  /name\s+is\s+['"]?([^'".,\n]+)['"]?/i,
];

const ADDRESSING_PATTERNS = [
  /(?:以后你叫我|以后请叫我|请叫我|以后称呼我(?:为)?|称呼我(?:为)?|称呼其为|称呼他为)\s*([^\s，。,.!！?？"'“”‘’「」『』]+)/iu,
  /(?:希望(?:在[^\n。]{0,20})?(?:以后)?(?:你)?(?:被)?称呼(?:我|其|他)?为)\s*([^\s，。,.!！?？"'“”‘’「」『』]+)/iu,
  /(?:被称呼为|称呼偏好(?:是)?|Preferred address(?: is)?|be addressed as|addressed as)\s*['"]?([^'".,\n]+)['"]?/i,
  /(?:addressive identifier is|preferred (?:and permanently assigned )?addressive identifier is)\s*['"]?([^'".,\n]+)['"]?/i,
];

const NAME_HINT_PATTERNS = [
  /^姓名[:：]/m,
  /^## Identity$/m,
  /(?:^|\n)-\s*Name:\s+/i,
  /用户当前姓名\/自称为/u,
];

const ADDRESSING_HINT_PATTERNS = [
  /^称呼偏好[:：]/m,
  /^## Addressing$/m,
  /Preferred form of address/i,
  /被称呼为/u,
  /addressive identifier/i,
];

function makeCandidate(kind: IdentityKind, alias: string, sourceText: string): CandidateMemory {
  if (kind === "name") {
    return {
      category: "entities",
      abstract: `姓名：${alias}`,
      overview: `## Identity\n- Name: ${alias}`,
      content: `用户当前姓名/自称为“${alias}”。原始表述：${sourceText}`,
    };
  }

  return {
    category: "preferences",
    abstract: `称呼偏好：${alias}`,
    overview: `## Addressing\n- Preferred form of address: ${alias}`,
    content: `用户希望以后被称呼为“${alias}”。原始表述：${sourceText}`,
  };
}

export function createIdentityAndAddressingCandidates(text: string): CandidateMemory[] {
  const sourceText = text.trim();
  if (!sourceText) return [];

  const name = extractFirst(NAME_PATTERNS, sourceText);
  const addressing = extractFirst(ADDRESSING_PATTERNS, sourceText);
  const candidates: CandidateMemory[] = [];

  if (name) {
    candidates.push(makeCandidate("name", name, sourceText));
  }
  if (addressing) {
    const duplicateOfName = name && addressing === name;
    if (!duplicateOfName || candidates.length === 0) {
      candidates.push(makeCandidate("addressing", addressing, sourceText));
    } else {
      candidates.push(makeCandidate("addressing", addressing, sourceText));
    }
  }

  return candidates;
}

export function extractIdentityAndAddressingValues(text: string): {
  name?: string;
  addressing?: string;
} {
  const sourceText = text.trim();
  if (!sourceText) return {};

  return {
    name: extractFirst(NAME_PATTERNS, sourceText),
    addressing: extractFirst(ADDRESSING_PATTERNS, sourceText),
  };
}

export function classifyIdentityAndAddressingMemory(
  params: IdentityAddressingMemoryLike,
): {
  slots: Set<IdentityAddressingSlot>;
  name?: string;
  addressing?: string;
} {
  const slots = new Set<IdentityAddressingSlot>();

  if (params.factKey === CANONICAL_NAME_FACT_KEY) {
    slots.add("name");
  }
  if (params.factKey === CANONICAL_ADDRESSING_FACT_KEY) {
    slots.add("addressing");
  }

  const probe = combineIdentityTextProbe(params);
  if (!probe) {
    return { slots };
  }

  const extracted = extractIdentityAndAddressingValues(probe);

  if (extracted.name || NAME_HINT_PATTERNS.some((pattern) => pattern.test(probe))) {
    slots.add("name");
  }
  if (
    extracted.addressing ||
    ADDRESSING_HINT_PATTERNS.some((pattern) => pattern.test(probe))
  ) {
    slots.add("addressing");
  }

  return {
    slots,
    name: extracted.name,
    addressing: extracted.addressing,
  };
}

export function canonicalizeIdentityAndAddressingCandidate(
  candidate: CandidateMemory,
): CandidateMemory {
  const combined = [candidate.abstract, candidate.overview, candidate.content]
    .filter(Boolean)
    .join("\n");

  if (candidate.category === "entities") {
    const name = extractFirst(NAME_PATTERNS, combined);
    if (name) {
      return makeCandidate("name", name, candidate.content || candidate.abstract);
    }
    const addressing = extractFirst(ADDRESSING_PATTERNS, combined);
    if (addressing) {
      return makeCandidate("addressing", addressing, candidate.content || candidate.abstract);
    }
    return candidate;
  }

  const addressing = extractFirst(ADDRESSING_PATTERNS, combined);
  if (addressing) {
    return makeCandidate("addressing", addressing, candidate.content || candidate.abstract);
  }

  const name = extractFirst(NAME_PATTERNS, combined);
  if (name) {
    return makeCandidate("name", name, candidate.content || candidate.abstract);
  }

  return candidate;
}

export function isCanonicalIdentityOrAddressingFactKey(factKey: string | undefined): boolean {
  return factKey === CANONICAL_NAME_FACT_KEY || factKey === CANONICAL_ADDRESSING_FACT_KEY;
}
