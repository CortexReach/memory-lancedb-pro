const AUTO_CAPTURE_INBOUND_META_SENTINELS = [
    "Conversation info (untrusted metadata):",
    "Sender (untrusted metadata):",
    "Thread starter (untrusted, for context):",
    "Replied message (untrusted, for context):",
    "Forwarded message context (untrusted metadata):",
    "Chat history since last reply (untrusted, for context):",
];
const AUTO_CAPTURE_SESSION_RESET_PREFIX = "A new session was started via /new or /reset. Execute your Session Startup sequence now";
const AUTO_CAPTURE_ADDRESSING_PREFIX_RE = /^(?:<@!?[0-9]+>|@[A-Za-z0-9_.-]+)\s*/;
const AUTO_CAPTURE_SYSTEM_EVENT_LINE_RE = /^System:\s*\[[^\n]*?\]\s*Exec\s+(?:completed|failed|started)\b.*$/gim;
const AUTO_CAPTURE_RUNTIME_WRAPPER_LINE_RE = /^\[(?:Subagent Context|Subagent Task)\]\s*/i;
const AUTO_CAPTURE_RUNTIME_WRAPPER_PREFIX_RE = /^\[(?:Subagent Context|Subagent Task)\]/i;
const AUTO_CAPTURE_RUNTIME_WRAPPER_BOILERPLATE_RE = /(?:You are running as a subagent\b.*?(?:$|(?<=\.)\s+)|Results auto-announce to your requester\.?\s*|do not busy-poll for status\.?\s*|Reply with a brief acknowledgment only\.?\s*|Do not use any memory tools\.?\s*)/gi;
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const AUTO_CAPTURE_INBOUND_META_BLOCK_RE = new RegExp(String.raw `(?:^|\n)\s*(?:${AUTO_CAPTURE_INBOUND_META_SENTINELS.map((sentinel) => escapeRegExp(sentinel)).join("|")})\s*\n\`\`\`json[\s\S]*?\n\`\`\`\s*`, "g");
function stripLeadingInboundMetadata(text) {
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
function stripAutoCaptureSessionResetPrefix(text) {
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
function stripAutoCaptureAddressingPrefix(text) {
    return text.replace(AUTO_CAPTURE_ADDRESSING_PREFIX_RE, "").trim();
}
function stripRuntimeWrapperBoilerplate(text) {
    return text
        .replace(AUTO_CAPTURE_RUNTIME_WRAPPER_BOILERPLATE_RE, "")
        .replace(/\s{2,}/g, " ")
        .trim();
}
function stripRuntimeWrapperLine(line) {
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
function stripLeadingRuntimeWrappers(text) {
    const trimmed = text.trim();
    if (!trimmed) {
        return trimmed;
    }
    const lines = trimmed.split("\n");
    const cleanedLines = [];
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
export function stripAutoCaptureInjectedPrefix(role, text) {
    if (role !== "user") {
        return text.trim();
    }
    let normalized = text.trim();
    normalized = normalized.replace(/<relevant-memories>\s*[\s\S]*?<\/relevant-memories>\s*/gi, "");
    normalized = normalized.replace(/\[UNTRUSTED DATA[^\n]*\][\s\S]*?\[END UNTRUSTED DATA\]\s*/gi, "");
    normalized = stripAutoCaptureSessionResetPrefix(normalized);
    normalized = stripLeadingInboundMetadata(normalized);
    normalized = stripAutoCaptureAddressingPrefix(normalized);
    normalized = stripLeadingRuntimeWrappers(normalized);
    normalized = stripLeadingInboundMetadata(normalized);
    normalized = normalized.replace(/\n{3,}/g, "\n\n");
    return normalized.trim();
}
export function normalizeAutoCaptureText(role, text, shouldSkipMessage) {
    if (typeof role !== "string")
        return null;
    const normalized = stripAutoCaptureInjectedPrefix(role, text);
    if (!normalized)
        return null;
    if (shouldSkipMessage?.(role, normalized))
        return null;
    return normalized;
}
/**
 * Renders turns oldest-first with each message wholly enclosed in
 * <user_message>/<assistant_message> tags. Line prefixes ("User:") mark only
 * the first line of a message, so a multi-paragraph assistant reply sheds its
 * speaker after the first paragraph and the extractor misattributes the rest
 * to the user; whole-message tags give every line an unambiguous owner. The
 * `_userLabel` parameter is kept for call-site compatibility -- the user's
 * display name now travels in the prompt header, not per turn.
 */
export function formatConversationTranscript(turns, _userLabel = "User") {
    return turns
        .map((turn) => turn.role === "user"
        ? `<user_message>\n${turn.text}\n</user_message>`
        : `<assistant_message>\n${turn.text}\n</assistant_message>`)
        .join("\n");
}
/**
 * Bounds a tag-wrapped transcript to `maxChars` by keeping the tail and then
 * snapping the cut to the next opening tag, so the prompt never leads with a
 * headless half message whose speaker was sliced away.
 */
export function trimTranscriptToTagBoundary(transcript, maxChars) {
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
 * results. The window is PAIR-shaped: an assistant turn belongs to the user
 * turn it follows (a reply), so dropping an already-extracted user turn also
 * drops the assistant turns of its pair.
 * - `newUserTexts` narrower than `eligibleTexts` (watermark tail-slice):
 *   drop that many leading user turns AND every assistant turn that precedes
 *   the first kept user turn (they are replies to the dropped pairs).
 * - `newUserTexts` not a tail-slice of `eligibleTexts` at all (pending-ingress
 *   replay from a different source, no per-message role correlation
 *   available): fall back to flat user turns for the replayed content.
 * Prior-call assistant context is never resurrected here -- pair windows
 * carry across calls through the caller's rolling pair buffer (see
 * trimTurnsToUserCap), not through a separate assistant-only carry.
 */
export function buildConversationTurnsForExtraction(params) {
    const { messageLoopTurns, eligibleTexts, newUserTexts } = params;
    const isTailSliceOfEligible = newUserTexts.length <= eligibleTexts.length &&
        eligibleTexts
            .slice(eligibleTexts.length - newUserTexts.length)
            .every((text, i) => text === newUserTexts[i]);
    if (!isTailSliceOfEligible) {
        return newUserTexts.map((text) => ({ role: "user", text }));
    }
    const skipUserCount = eligibleTexts.length - newUserTexts.length;
    const thisCallTurns = [];
    let userSeen = 0;
    for (const turn of messageLoopTurns) {
        if (turn.role === "user") {
            userSeen++;
            if (userSeen <= skipUserCount)
                continue;
        }
        else if (userSeen <= skipUserCount) {
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
 * an orphan assistant turn ahead of the window's first user turn. This is how
 * extractMinMessages acts as the window size in PAIRS: the caller passes
 * max(extractMinMessages, this call's new user turns), so the transcript
 * always contains every not-yet-extracted user turn, padded with earlier
 * still-buffered pairs up to the configured window.
 */
export function trimTurnsToUserCap(turns, maxUserTurns) {
    const cap = Math.max(1, maxUserTurns);
    let userCount = 0;
    let start = turns.length;
    for (let i = turns.length - 1; i >= 0; i--) {
        if (turns[i].role === "user") {
            userCount++;
            if (userCount > cap)
                break;
            start = i;
        }
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
export function dedupePairWindow(turns) {
    const groups = [];
    let current = null;
    for (const turn of turns) {
        if (turn.role === "user") {
            current = { turns: [turn], userText: turn.text, replies: "" };
            groups.push(current);
        }
        else if (current) {
            current.turns.push(turn);
            current.replies = JSON.stringify(current.turns.slice(1).map((t) => t.text));
        }
        else {
            groups.push({ turns: [turn], userText: null, replies: "" });
        }
    }
    const kept = [];
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
            }
            else {
                kept.push(group);
            }
        }
        else if (currPaired && !prevPaired) {
            kept.splice(prevIndex, 1);
            kept.push(group);
        }
        else if (!currPaired && prevPaired) {
            continue;
        }
        else {
            kept.splice(prevIndex, 1);
            kept.push(group);
        }
    }
    return kept.flatMap((group) => group.turns);
}
