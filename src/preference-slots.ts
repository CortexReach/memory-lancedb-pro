const ROLE_PREFIX_RE = /^\[(用户|助手)\]\s*/gm;
const PREFERENCE_SPLIT_RE = /(?:、|,|，|\/|以及|及|与|和| and | & )/iu;
const PREFERENCE_CLAUSE_STOP_RE = /(?:因为|所以|但是|不过|if |when |because |but )/iu;
const BRAND_ITEM_PREFERENCE_PATTERNS = [
  /(?:^|[\s，,。；;！!？?])(?:我|用户)?(?:很|更|还)?(?:喜欢|爱吃|偏爱|常吃|想吃)(?:吃|喝|用|买)?(?<brand>[\p{Script=Han}A-Za-z0-9&·'\-]{1,24})的(?<items>[\p{Script=Han}A-Za-z0-9&·'\-\s、,，和及与/]{1,80})/u,
  /\b(?:i|user)?\s*(?:really\s+|still\s+|also\s+)?(?:like|love|prefer|enjoy)\s+(?<items>[a-z0-9'&\-\s]{1,80})\s+from\s+(?<brand>[a-z0-9'&\-\s]{1,40})/iu,
] as const;

export interface ParsedBrandItemPreference {
  brand: string;
  items: string[];
  aggregate: boolean;
}

export interface AtomicBrandItemPreferenceSlot {
  type: "brand-item";
  brand: string;
  item: string;
}

function normalizePreferenceText(value: string): string {
  return value
    .replace(ROLE_PREFIX_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizePreferenceToken(value: string): string {
  return normalizePreferenceText(value)
    .replace(/^[“"'`‘’]+|[”"'`‘’。！!？?，,；;:：]+$/gu, "")
    .replace(/\b(?:the|a|an)\s+/giu, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function splitPreferenceItems(rawItems: string): string[] {
  const trimmed = rawItems.split(PREFERENCE_CLAUSE_STOP_RE)[0] || rawItems;
  return trimmed
    .split(PREFERENCE_SPLIT_RE)
    .map((item) => normalizePreferenceToken(item))
    .filter((item) => item.length > 0);
}

export function parseBrandItemPreference(text: string): ParsedBrandItemPreference | null {
  const normalizedText = normalizePreferenceText(text);

  for (const pattern of BRAND_ITEM_PREFERENCE_PATTERNS) {
    const match = normalizedText.match(pattern);
    if (!match?.groups) continue;

    const brand = normalizePreferenceToken(match.groups.brand || "");
    const items = splitPreferenceItems(match.groups.items || "");
    if (!brand || items.length === 0) continue;

    return {
      brand,
      items,
      aggregate: items.length > 1,
    };
  }

  return null;
}

export function inferAtomicBrandItemPreferenceSlot(text: string): AtomicBrandItemPreferenceSlot | null {
  const parsed = parseBrandItemPreference(text);
  if (!parsed || parsed.aggregate || parsed.items.length !== 1) {
    return null;
  }

  return {
    type: "brand-item",
    brand: parsed.brand,
    item: parsed.items[0],
  };
}
