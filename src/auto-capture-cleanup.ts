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
}

/**
 * A literal speaker tag typed INSIDE a message could fake a block boundary
 * (or defeat tag-boundary trimming, which trusts that literal tags only occur
 * as real boundaries). Rewritten with guillemets the text stays readable but
 * can no longer be confused with transcript structure.
 */
export function neutralizeSpeakerTagSpoof(text: string): string {
  return text.replace(/<(\/?)((?:user|assistant)_message)>/g, "‹$1$2›");
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
 * Bounds a tag-wrapped transcript to `maxChars` by keeping the tail and then
 * snapping the cut to the next opening tag, so the prompt never leads with a
 * headless half message whose speaker was sliced away.
 */
export function trimTranscriptToTagBoundary(transcript: string, maxChars: number): string {
  if (transcript.length <= maxChars) {
    return transcript;
  }
  const sliced = transcript.slice(-maxChars);
  const tagStarts = ["<user_message>", "<assistant_message>"]
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
