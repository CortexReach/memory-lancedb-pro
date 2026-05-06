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
