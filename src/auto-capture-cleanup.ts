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

/**
 * Message-tool channels (Slack groups and other non-auto-delivery runs) hand
 * the plugin a "user" message that concatenates runtime scaffolding around the
 * real inbound content: a Delivery banner first, then optionally a quoted
 * re-render of channel history the session has already seen. Both are
 * host-emitted grammar, matched exactly and stripped fail-closed — unmatched
 * lines always pass through. Full group-channel support (per-sender speaker
 * awareness) is the permanent design; this keeps the transcript clean until
 * that lands.
 */
export const MESSAGE_TOOL_DELIVERY_BANNER_PREFIX =
  "Delivery: Final assistant text is not automatically delivered in this run.";
const CHAT_HISTORY_QUOTE_HEADERS = [
  "Chat history since last reply (untrusted, for context):",
  "Conversation context (untrusted, chronological, selected for current message):",
];
const QUOTED_HISTORY_LINE = /^#\d+(?:\.\d+)? \S+ \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \S+ [^:]+: /;

export function stripGroupChannelScaffold(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.startsWith(MESSAGE_TOOL_DELIVERY_BANNER_PREFIX)) {
      index++;
      continue;
    }
    if (CHAT_HISTORY_QUOTE_HEADERS.includes(line.trim())) {
      index++;
      while (index < lines.length && (QUOTED_HISTORY_LINE.test(lines[index]) || lines[index].trim() === "")) {
        index++;
      }
      continue;
    }
    kept.push(line);
    index++;
  }
  return kept.join("\n").trim();
}

/**
 * Channel-agnostic injection slicing: the ingress hook delivers each inbound
 * message RAW, before the host composes the prompt and layers channel
 * injections above it, and the raw message always sits at the absolute
 * bottom of the composed text. Anchoring on a recently seen raw text slices
 * every injection shape — including channels whose grammar we have never
 * seen — without parsing any of them. The newline boundary requirement stops
 * mid-line false matches (a raw that merely ends the same as real content),
 * the minimum length keeps trivial raws ("ok") from slicing multi-line
 * messages, and no match leaves the text untouched (the deterministic
 * header strips remain the fallback).
 */
export const RAW_INGRESS_ANCHOR_MIN_LENGTH = 12;

export function anchorTextToRawIngress(text: string, recentRaws: readonly string[]): string {
  let best: string | null = null;
  for (const raw of recentRaws) {
    if (!raw || raw.length < RAW_INGRESS_ANCHOR_MIN_LENGTH) continue;
    if (text === raw) return text;
    if (text.endsWith("\n" + raw) && (best === null || raw.length > best.length)) {
      best = raw;
    }
  }
  return best ?? text;
}

export function normalizeAutoCaptureText(
  role: unknown,
  text: string,
  shouldSkipMessage?: (role: string, text: string) => boolean,
): string | null {
  if (typeof role !== "string") return null;
  const descaffolded = role === "user" ? stripGroupChannelScaffold(text) : text;
  if (!descaffolded) return null;
  const normalized = stripAutoCaptureInjectedPrefix(role, descaffolded);
  if (!normalized) return null;
  if (shouldSkipMessage?.(role, normalized)) return null;
  return normalized;
}

/**
 * Direct (1:1) conversations by session-key grammar, allowlisted from the
 * host's key builder: the dmScope-collapsed main key, dashboard/webchat
 * sessions, and the explicit `:direct:` peer forms. Everything else —
 * channels, groups, threads, topics, and any key shape we have never seen —
 * is treated as a group chat, fail-closed. The context window falls back to
 * contextTurns=0 there (original captureAssistant-gated behavior); full
 * group-channel support arrives with per-sender speaker awareness.
 */
export function isDirectConversationSessionKey(sessionKey: unknown): boolean {
  if (typeof sessionKey !== "string" || sessionKey.length === 0) return false;
  const key = sessionKey.toLowerCase();
  if (/^agent:[^:]+:main$/.test(key)) return true;
  if (/^agent:[^:]+:dashboard(?::|$)/.test(key)) return true;
  if (key.includes(":direct:")) return true;
  return false;
}

/** One turn in the extraction prompt's conversation transcript. */
export interface ConversationTurn {
  role: "user" | "assistant";
  text: string;
  /** Already processed by a previous extraction (retained window turn): renders as a context_* tag, never an extraction source. */
  context?: boolean;
}

/**
 * A literal speaker tag typed INSIDE a message could fake a block boundary
 * (or defeat tag-boundary trimming, which trusts that literal tags only occur
 * as real boundaries). Rewritten with guillemets the text stays readable but
 * can no longer be confused with transcript structure.
 */
export function neutralizeSpeakerTagSpoof(text: string): string {
  return text.replace(/<(\/?)((?:context_)?(?:user|assistant)_message)>/g, "‹$1$2›");
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
  options: { assistantContextOnly?: boolean } = {},
): string {
  return turns
    .map((turn) => {
      const tag =
        turn.role === "user"
          ? turn.context
            ? "context_user_message"
            : "user_message"
          : turn.context || options.assistantContextOnly === true
            ? "context_assistant_message"
            : "assistant_message";
      return `<${tag}>\n${neutralizeSpeakerTagSpoof(turn.text)}\n</${tag}>`;
    })
    .join("\n");
}

/**
 * Bounds a tag-wrapped transcript to `maxChars` by keeping the tail and then
 * snapping the cut to the next opening tag, so the prompt never leads with a
 * headless half message whose speaker was sliced away.
 */
export function trimTranscriptToTagBoundary(transcript: string, maxChars: number): string {
  if (transcript.length <= maxChars) {
    return transcript;
  }
  const sliced = transcript.slice(-maxChars);
  const tagStarts = ["<user_message>", "<assistant_message>", "<context_user_message>", "<context_assistant_message>"]
    .map((tag) => sliced.indexOf(tag))
    .filter((index) => index >= 0);
  if (tagStarts.length === 0) {
    return sliced;
  }
  return sliced.slice(Math.min(...tagStarts));
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
    return newUserTexts.map((text) => ({ role: "user", text }));
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
 * Bounds a rolling pair window to at most `maxUserTurns` user turns, keeping
 * the newest ones with their interleaved assistant replies, and never leaving
 * an orphan assistant turn ahead of the window's first user turn. The caller
 * passes max(autoCaptureContextTurns, this call's new user turns), so the
 * transcript always contains every not-yet-extracted user turn, padded with
 * earlier still-buffered pairs up to the configured window.
 */
export function trimTurnsToUserCap(
  turns: ConversationTurn[],
  maxUserTurns: number,
): ConversationTurn[] {
  const cap = Math.max(1, maxUserTurns);
  let userCount = 0;
  let start = turns.length;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === "user") {
      userCount++;
      if (userCount > cap) break;
      start = i;
    }
  }
  if (userCount === 0) {
    // All-assistant window (possible under captureAssistant=true when the
    // delta carries only assistant turns): no user anchor exists, so keep
    // the newest `cap` turns instead of silently dropping everything.
    return turns.slice(-cap);
  }
  return turns.slice(start);
}

/**
 * Repairs a pair window that double-preserved deferred turns. A below-threshold
 * deferral keeps content alive on two independent paths -- the rolling pair
 * buffer, and the watermark rollback (or pending-ingress re-queue) whose next
 * slice re-includes the same turns -- so the assembled window can carry the
 * same exchange twice. Collapse duplicates by user text at pair granularity:
 * a pair-shaped copy (user turn plus its replies) beats a flat re-queued copy,
 * copies of an identical exchange collapse to the latest, and a repeated user
 * text whose replies differ is a real conversation and is kept whole.
 */
export function dedupePairWindow(turns: ConversationTurn[]): ConversationTurn[] {
  interface PairGroup {
    turns: ConversationTurn[];
    userText: string | null;
    replies: string;
  }
  const groups: PairGroup[] = [];
  let current: PairGroup | null = null;
  for (const turn of turns) {
    if (turn.role === "user") {
      current = { turns: [turn], userText: turn.text, replies: "" };
      groups.push(current);
    } else if (current) {
      current.turns.push(turn);
      current.replies = JSON.stringify(current.turns.slice(1).map((t) => t.text));
    } else {
      groups.push({ turns: [turn], userText: null, replies: "" });
    }
  }

  const kept: PairGroup[] = [];
  for (const group of groups) {
    if (group.userText === null) {
      kept.push(group);
      continue;
    }
    let prevIndex = -1;
    for (let i = kept.length - 1; i >= 0; i--) {
      if (kept[i].userText === group.userText) {
        prevIndex = i;
        break;
      }
    }
    if (prevIndex < 0) {
      kept.push(group);
      continue;
    }
    const prev = kept[prevIndex];
    const prevPaired = prev.turns.length > 1;
    const currPaired = group.turns.length > 1;
    if (currPaired && prevPaired) {
      if (prev.replies === group.replies) {
        kept.splice(prevIndex, 1);
        kept.push(group);
      } else {
        kept.push(group);
      }
    } else if (currPaired && !prevPaired) {
      kept.splice(prevIndex, 1);
      kept.push(group);
    } else if (!currPaired && prevPaired) {
      continue;
    } else {
      kept.splice(prevIndex, 1);
      kept.push(group);
    }
  }
  return kept.flatMap((group) => group.turns);
}
