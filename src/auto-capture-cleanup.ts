const AUTO_CAPTURE_INBOUND_META_SENTINELS = [
  "Conversation info (untrusted metadata):",
  "Sender (untrusted metadata):",
  "Thread starter (untrusted, for context):",
  "Replied message (untrusted, for context):",
  "Forwarded message context (untrusted metadata):",
  "Chat history since last reply (untrusted, for context):",
] as const;

const AUTO_CAPTURE_SESSION_RESET_PREFIX =
  "A new session was started via /new or /reset. Execute your Session Startup sequence now";
const AUTO_CAPTURE_ADDRESSING_PREFIX_RE = /^(?:<@!?[0-9]+>|@[A-Za-z0-9_.-]+)\s*/;
const AUTO_CAPTURE_SYSTEM_EVENT_LINE_RE = /^System:\s*\[[^\n]*?\]\s*Exec\s+(?:completed|failed|started)\b.*$/gim;
const AUTO_CAPTURE_RUNTIME_WRAPPER_LINE_RE = /^\[(?:Subagent Context|Subagent Task)\]\s*/i;
const AUTO_CAPTURE_RUNTIME_WRAPPER_PREFIX_RE = /^\[(?:Subagent Context|Subagent Task)\]/i;
const AUTO_CAPTURE_RUNTIME_WRAPPER_BOILERPLATE_RE =
  /(?:You are running as a subagent\b.*?(?:$|(?<=\.)\s+)|Results auto-announce to your requester\.?\s*|do not busy-poll for status\.?\s*|Reply with a brief acknowledgment only\.?\s*|Do not use any memory tools\.?\s*)/gi;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const AUTO_CAPTURE_INBOUND_META_BLOCK_RE = new RegExp(
  String.raw`(?:^|\n)\s*(?:${AUTO_CAPTURE_INBOUND_META_SENTINELS.map((sentinel) => escapeRegExp(sentinel)).join("|")})\s*\n\`\`\`json[\s\S]*?\n\`\`\`\s*`,
  "g",
);

function stripLeadingInboundMetadata(text: string): string {
  if (!text) {
    return text;
  }

  let normalized = text;
  for (let i = 0; i < 6; i++) {
    const before = normalized;
    normalized = normalized.replace(AUTO_CAPTURE_SYSTEM_EVENT_LINE_RE, "\n");
    normalized = normalized.replace(AUTO_CAPTURE_INBOUND_META_BLOCK_RE, "\n");
    normalized = normalized.replace(/\n{3,}/g, "\n\n").trim();
    if (normalized === before.trim()) {
      break;
    }
  }

  return normalized.trim();
}

function stripAutoCaptureSessionResetPrefix(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith(AUTO_CAPTURE_SESSION_RESET_PREFIX)) {
    return trimmed;
  }

  const blankLineIndex = trimmed.indexOf("\n\n");
  if (blankLineIndex >= 0) {
    return trimmed.slice(blankLineIndex + 2).trim();
  }

  const lines = trimmed.split("\n");
  if (lines.length <= 2) {
    return "";
  }
  return lines.slice(2).join("\n").trim();
}

function stripAutoCaptureAddressingPrefix(text: string): string {
  return text.replace(AUTO_CAPTURE_ADDRESSING_PREFIX_RE, "").trim();
}

function stripRuntimeWrapperBoilerplate(text: string): string {
  return text
    .replace(AUTO_CAPTURE_RUNTIME_WRAPPER_BOILERPLATE_RE, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function stripRuntimeWrapperLine(line: string): string {
  const trimmed = line.trim();
  if (!AUTO_CAPTURE_RUNTIME_WRAPPER_PREFIX_RE.test(trimmed)) {
    return line;
  }

  const remainder = trimmed.replace(AUTO_CAPTURE_RUNTIME_WRAPPER_LINE_RE, "").trim();
  if (!remainder) {
    return "";
  }

  return stripRuntimeWrapperBoilerplate(remainder);
}

function stripLeadingRuntimeWrappers(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return trimmed;
  }

  const lines = trimmed.split("\n");
  const cleanedLines: string[] = [];
  let strippingLeadIn = true;

  for (const line of lines) {
    const current = line.trim();

    if (strippingLeadIn && current === "") {
      continue;
    }

    if (strippingLeadIn && AUTO_CAPTURE_RUNTIME_WRAPPER_PREFIX_RE.test(current)) {
      const cleaned = stripRuntimeWrapperLine(current);
      if (cleaned) {
        cleanedLines.push(cleaned);
        strippingLeadIn = false;
      }
      continue;
    }

    strippingLeadIn = false;
    cleanedLines.push(line);
  }

  return cleanedLines.join("\n").trim();
}

export function stripAutoCaptureInjectedPrefix(role: string, text: string): string {
  if (role !== "user") {
    return text.trim();
  }

  let normalized = text.trim();
  normalized = normalized.replace(/<relevant-memories>\s*[\s\S]*?<\/relevant-memories>\s*/gi, "");
  normalized = normalized.replace(
    /\[UNTRUSTED DATA[^\n]*\][\s\S]*?\[END UNTRUSTED DATA\]\s*/gi,
    "",
  );
  normalized = stripAutoCaptureSessionResetPrefix(normalized);
  normalized = stripLeadingInboundMetadata(normalized);
  normalized = stripAutoCaptureAddressingPrefix(normalized);
  normalized = stripLeadingRuntimeWrappers(normalized);
  normalized = stripLeadingInboundMetadata(normalized);
  normalized = normalized.replace(/\n{3,}/g, "\n\n");
  return normalized.trim();
}

export function normalizeAutoCaptureText(
  role: unknown,
  text: string,
  shouldSkipMessage?: (role: string, text: string) => boolean,
): string | null {
  if (typeof role !== "string") return null;
  const normalized = stripAutoCaptureInjectedPrefix(role, text);
  if (!normalized) return null;
  if (shouldSkipMessage?.(role, normalized)) return null;
  return normalized;
}

/** One turn in the extraction prompt's conversation transcript. */
export interface ConversationTurn {
  role: "user" | "assistant";
  text: string;
  /**
   * Stable identity of the source message: every block of one multi-block
   * message shares it, distinct messages never do. Referent-run walks extend
   * only across turns carrying the SAME id, because role adjacency alone
   * cannot distinguish blocks of one message from separate messages once
   * assistant turns are omitted (captureAssistant=false). Turns synthesized
   * without a source message get fresh ids and therefore never extend a run.
   */
  messageId?: number;
}

let autoCaptureMessageIdCounter = 0;

/** Monotonic across the process so ids from different capture calls mixed in
 *  one recents window can never collide. */
export function nextAutoCaptureMessageId(): number {
  autoCaptureMessageIdCounter += 1;
  return autoCaptureMessageIdCounter;
}

/**
 * A literal speaker tag typed INSIDE a message could fake a block boundary
 * (or defeat tag-boundary trimming, which trusts that literal tags only occur
 * as real boundaries). Rewritten with guillemets the text stays readable but
 * can no longer be confused with transcript structure.
 *
 * Implemented as a single forward scan instead of a regex: quantified
 * scanning over attacker-influenced text kept going superlinear (first the
 * whitespace run around the optional slash, then the attribute arm), and a
 * bounded whitespace budget waved longer padding through unneutralized. The
 * scan never re-visits a character, accepts any amount of padding, and still
 * covers attribute-bearing and self-closing forms like
 * <assistant_message id="x"> and <user_message/>.
 */
const SPEAKER_TAG_SPOOF_NAMES = ["user_message", "assistant_message"];

function isSpoofWhitespaceCode(code: number): boolean {
  return (
    (code >= 9 && code <= 13) ||
    code === 32 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

// Invisible format characters read as a clean tag to a human and to the model
// while failing an exact match, and none of them are in JS \s, so
// isSpoofWhitespaceCode (a deliberate \s replica) does not cover them. The
// whole class is accepted as padding: soft hyphen, CGJ, Mongolian vowel
// separator, zero-width and joiner set, bidi marks AND bidi overrides
// (deliberate: they are invisible here, and reordering is spoof material,
// never legitimate tag-adjacent prose), invisible operators, and the
// deprecated formatting range. Visibly malformed padding (a second slash, a
// backslash) is deliberately NOT accepted: it renders as an obvious non-tag,
// and matching arbitrary junk before the name would mangle ordinary prose
// about this code.
function isSpoofInvisibleCode(code: number): boolean {
  return (
    code === 0x00ad ||
    code === 0x034f ||
    code === 0x180e ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2064) ||
    (code >= 0x2066 && code <= 0x206f)
  );
}

function isSpoofPaddingCode(code: number): boolean {
  return isSpoofWhitespaceCode(code) || isSpoofInvisibleCode(code);
}

function isSpoofWordCharCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95
  );
}

function matchSpoofTagNameEnd(text: string, from: number): number {
  for (const name of SPEAKER_TAG_SPOOF_NAMES) {
    if (from + name.length > text.length) {
      continue;
    }
    let matched = true;
    for (let k = 0; k < name.length; k++) {
      let code = text.charCodeAt(from + k);
      if (code >= 65 && code <= 90) {
        code += 32;
      }
      if (code !== name.charCodeAt(k)) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return from + name.length;
    }
  }
  return -1;
}

export function neutralizeSpeakerTagSpoof(text: string): string {
  let out = "";
  let copiedUpTo = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (text.charCodeAt(i) !== 60 /* < */) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < n && isSpoofPaddingCode(text.charCodeAt(j))) j++;
    if (j < n && text.charCodeAt(j) === 47 /* / */) {
      j++;
      while (j < n && isSpoofPaddingCode(text.charCodeAt(j))) j++;
    }
    const nameEnd = matchSpoofTagNameEnd(text, j);
    if (nameEnd < 0) {
      // Nothing in (i, j) can open a tag; j itself may, so resume there.
      i = j > i + 1 ? j : i + 1;
      continue;
    }
    if (nameEnd < n && isSpoofWordCharCode(text.charCodeAt(nameEnd))) {
      i = nameEnd + 1;
      continue;
    }
    let k = nameEnd;
    while (k < n && text.charCodeAt(k) !== 62 /* > */) k++;
    if (k >= n) {
      // No ">" anywhere to the right: no later candidate can close either.
      break;
    }
    out += `${text.slice(copiedUpTo, i)}‹${text.slice(i + 1, k)}›`;
    copiedUpTo = k + 1;
    i = k + 1;
  }
  return copiedUpTo === 0 ? text : out + text.slice(copiedUpTo);
}

/**
 * Renders turns oldest-first with each message wholly enclosed in
 * <user_message>/<assistant_message> tags. Line prefixes ("User:") mark only
 * the first line of a message, so a multi-paragraph assistant reply sheds its
 * speaker after the first paragraph and the extractor misattributes the rest
 * to the user; whole-message tags give every line an unambiguous owner. The
 * `_userLabel` parameter is kept for call-site compatibility -- the user's
 * display name travels in the prompt header, not per turn.
 */
export function formatConversationTranscript(
  turns: ConversationTurn[],
  _userLabel: string = "User",
): string {
  return turns
    .map((turn) => {
      const tag = turn.role === "user" ? "user_message" : "assistant_message";
      return `<${tag}>\n${neutralizeSpeakerTagSpoof(turn.text)}\n</${tag}>`;
    })
    .join("\n");
}

/**
 * Renders the maximal tail of `turns` whose TOTAL rendered length fits
 * `maxChars` (an absolute ceiling, matching the flat-text path's
 * `slice(-maxChars)` contract). Whole turns are kept from the end; the
 * oldest turn that only partially fits has its TEXT tail-sliced with its
 * tags left intact, so attribution survives truncation structurally rather
 * than through surgery on the rendered string. A turn whose envelope alone
 * exceeds the remaining budget is dropped whole.
 */
export function buildBoundedTranscript(turns: ConversationTurn[], maxChars: number): string {
  return buildBoundedTranscriptWithStats(turns, maxChars).transcript;
}

/**
 * `buildBoundedTranscript` plus the length the untruncated render would have
 * had, so a caller that needs both does not render the turns twice (the
 * untruncated render here is byte-identical to `formatConversationTranscript`).
 */
export function buildBoundedTranscriptWithStats(
  turns: ConversationTurn[],
  maxChars: number,
  options: { protectedPrefixTurns?: number } = {},
): { transcript: string; fullLength: number; protectedPrefixKept: boolean } {
  const blocks = turns.map((turn) => ({
    open: turn.role === "user" ? "<user_message>" : "<assistant_message>",
    close: turn.role === "user" ? "</user_message>" : "</assistant_message>",
    text: neutralizeSpeakerTagSpoof(turn.text),
  }));
  const rendered = blocks.map((block) => `${block.open}\n${block.text}\n${block.close}`);
  const full = rendered.join("\n");
  if (full.length <= maxChars) {
    return { transcript: full, fullLength: full.length, protectedPrefixKept: true };
  }
  const protectedCount = Math.min(
    Math.max(Math.trunc(options.protectedPrefixTurns ?? 0), 0),
    blocks.length,
  );
  const separatorCost = 1;
  if (protectedCount === 0 || protectedCount === blocks.length || maxChars <= separatorCost) {
    const kept = keepRenderedTail(blocks, rendered, 0, blocks.length, maxChars);
    return {
      transcript: kept.join("\n"),
      fullLength: full.length,
      // With no protected prefix nothing is owed; when every turn is protected
      // the plain walk is already the best effort available.
      protectedPrefixKept: protectedCount === 0 || kept.length > 0,
    };
  }
  // Fair-share split: whichever side needs less than half the budget gets
  // exactly what it needs and the other takes the remainder, so a prepended
  // referent at the OLDEST end is never the first thing a newest-first walk
  // sacrifices, and the newest turns are never starved either.
  const available = maxChars - separatorCost;
  const half = Math.floor(available / 2);
  const prefixLength = rendered.slice(0, protectedCount).join("\n").length;
  const tailLength = rendered.slice(protectedCount).join("\n").length;
  let prefixBudget: number;
  let tailBudget: number;
  if (prefixLength <= half) {
    prefixBudget = prefixLength;
    tailBudget = available - prefixLength;
  } else if (tailLength <= available - half) {
    tailBudget = tailLength;
    prefixBudget = available - tailLength;
  } else {
    prefixBudget = half;
    tailBudget = available - half;
  }
  const keptPrefix = keepRenderedTail(blocks, rendered, 0, protectedCount, prefixBudget);
  const keptTail = keepRenderedTail(blocks, rendered, protectedCount, blocks.length, tailBudget);
  return {
    transcript: [...keptPrefix, ...keptTail].join("\n"),
    fullLength: full.length,
    protectedPrefixKept: keptPrefix.length > 0,
  };
}

/**
 * Keeps the maximal tail of `blocks[start, end)` whose rendered length fits
 * `budget`: whole blocks from the end, tail-slicing the TEXT of the oldest
 * block that only partially fits so its tags stay intact.
 */
function keepRenderedTail(
  blocks: Array<{ open: string; close: string; text: string }>,
  rendered: string[],
  start: number,
  end: number,
  budget: number,
): string[] {
  const kept: string[] = [];
  let total = 0;
  for (let i = end - 1; i >= start; i--) {
    const joinCost = kept.length > 0 ? 1 : 0;
    if (total + rendered[i].length + joinCost <= budget) {
      kept.unshift(rendered[i]);
      total += rendered[i].length + joinCost;
      continue;
    }
    const envelope = blocks[i].open.length + blocks[i].close.length + 2 + joinCost;
    const room = budget - total - envelope;
    if (room > 0) {
      const tail = blocks[i].text.slice(blocks[i].text.length - room);
      kept.unshift(`${blocks[i].open}\n${tail}\n${blocks[i].close}`);
    }
    break;
  }
  return kept;
}

/**
 * Assembles the ordered turn sequence for the extraction prompt's transcript
 * from this call's true message-loop order, without recomputing any
 * eligibility or watermark decision -- it only consumes their already-decided
 * results.
 * - `newUserTexts` narrower than `eligibleTexts` (watermark tail-slice): skip
 *   the already-extracted prefix. The eligibility loop pushes exactly one
 *   turn per eligible text, so when the counts line up the skip is a plain
 *   index slice -- deliberately role-agnostic, because under
 *   captureAssistant=true eligible texts are mixed-role and a user-turn
 *   counting walk over-skips (it consumes one USER turn per already-seen
 *   text of ANY role, emptying the transcript).
 * - Counts misaligned (defensive): fall back to the role-aware walk that
 *   drops one leading user turn per already-seen text, along with the
 *   assistant replies of the dropped pairs.
 * - `newUserTexts` not a tail-slice of `eligibleTexts` at all (pending-ingress
 *   replay from a different source, no per-message role correlation
 *   available): fall back to flat user turns for the replayed content.
 */
export function buildConversationTurnsForExtraction(params: {
  messageLoopTurns: ConversationTurn[];
  eligibleTexts: string[];
  newUserTexts: string[];
}): ConversationTurn[] {
  const { messageLoopTurns, eligibleTexts, newUserTexts } = params;

  const isTailSliceOfEligible =
    newUserTexts.length <= eligibleTexts.length &&
    eligibleTexts
      .slice(eligibleTexts.length - newUserTexts.length)
      .every((text, i) => text === newUserTexts[i]);

  if (!isTailSliceOfEligible) {
    return newUserTexts.map((text) => ({
      role: "user",
      text,
      messageId: nextAutoCaptureMessageId(),
    }));
  }

  if (messageLoopTurns.length === eligibleTexts.length) {
    return messageLoopTurns.slice(eligibleTexts.length - newUserTexts.length);
  }

  const skipUserCount = eligibleTexts.length - newUserTexts.length;
  const thisCallTurns: ConversationTurn[] = [];
  let userSeen = 0;
  for (const turn of messageLoopTurns) {
    if (turn.role === "user") {
      userSeen++;
      if (userSeen <= skipUserCount) continue;
    } else if (userSeen <= skipUserCount) {
      // Reply to a dropped (already-extracted) user turn: goes with its pair.
      continue;
    }
    thisCallTurns.push(turn);
  }

  return thisCallTurns;
}

/**
 * Filters `turns` down to the sequence whose texts survived every upstream
 * selector (session compression, embedding noise filter), so the tagged
 * transcript mirrors the FINAL extraction input. When `keptIndices` (the
 * survivors' positions in `turns`) aligns with `keptTexts`, selection is
 * positional, which pins a byte-identical text uttered by both roles to the
 * copy that actually survived. Otherwise occurrence counting over the kept
 * texts covers both roles and repeated texts: each surviving copy licenses
 * exactly one turn, consumed in original turn order.
 */
export function reconcileTurnsWithKeptTexts(
  turns: ConversationTurn[],
  keptTexts: string[],
  keptIndices?: number[],
): ConversationTurn[] {
  if (keptIndices && keptIndices.length === keptTexts.length) {
    const aligned = keptIndices.every(
      (turnIndex, k) =>
        Number.isInteger(turnIndex) &&
        turnIndex >= 0 &&
        turnIndex < turns.length &&
        (k === 0 || turnIndex > keptIndices[k - 1]) &&
        turns[turnIndex].text === keptTexts[k],
    );
    if (aligned) {
      return keptIndices.map((turnIndex) => turns[turnIndex]);
    }
  }
  const remainingByText = new Map<string, number>();
  for (const text of keptTexts) {
    remainingByText.set(text, (remainingByText.get(text) ?? 0) + 1);
  }
  const reconciled: ConversationTurn[] = [];
  for (const turn of turns) {
    const remaining = remainingByText.get(turn.text) ?? 0;
    if (remaining <= 0) {
      continue;
    }
    remainingByText.set(turn.text, remaining - 1);
    reconciled.push(turn);
  }
  return reconciled;
}
