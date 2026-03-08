const LEADING_BULLET_RE = /^\s*(?:[-*+•◦▪▫‣·●○▸▹►]|\d+[.)]|[a-zA-Z][.)])\s+/;
const DASH_VARIANTS_RE = /[‐‑‒–—―]/g;
const DOUBLE_QUOTE_VARIANTS_RE = /[“”«»]/g;
const SINGLE_QUOTE_VARIANTS_RE = /[‘’`´]/g;
const TRAILING_PUNCT_RE = /[.,!?;:，。！？；：]+$/g;
const SOFT_PUNCT_RE = /[()[\]{}"':;,.!?，。！？；：/\\|]+/g;

function normalizeReflectionConservativeBase(line: string): string {
  return String(line)
    .replace(/\r?\n+/g, " ")
    .replace(DASH_VARIANTS_RE, "-")
    .replace(DOUBLE_QUOTE_VARIANTS_RE, "\"")
    .replace(SINGLE_QUOTE_VARIANTS_RE, "'")
    .trim()
    .replace(LEADING_BULLET_RE, "")
    .replace(/\s*([:;,.!?])\s*/g, "$1 ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeReflectionStrictKey(line: string): string {
  const normalized = normalizeReflectionConservativeBase(line)
    .toLowerCase()
    .replace(TRAILING_PUNCT_RE, "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized;
}

export function normalizeReflectionSoftKey(line: string): string {
  const strict = normalizeReflectionStrictKey(line);
  if (!strict) return "";

  const soft = strict
    .replace(SOFT_PUNCT_RE, " ")
    .replace(/\s*-\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return soft || strict;
}
