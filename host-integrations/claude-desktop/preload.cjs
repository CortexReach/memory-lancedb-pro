const { ipcRenderer } = require("electron");
const CHANNEL_PREFIX = "memory-lancedb-pro:claude-desktop";

const ALLOWED_HOSTS = new Set([
  "claude.ai",
  "preview.claude.ai",
  "claude.com",
  "preview.claude.com",
  "ion-preview.claude.ai",
  "localhost",
  "anthropic.com",
  "www.anthropic.com",
]);

const capturedTurnHashes = new Set();
const observedRequestKeys = new Set();
const domSubmissionHashes = new Set();
let activeFetchWrapper = null;
let xhrPatched = false;
let bridgeWatchTimer = null;
let domBridgeInstalled = false;
let domObserver = null;
let domCaptureTimer = null;
let domSendInFlight = false;
let bypassDomSend = false;
let bypassDomSendTimer = null;
let lastSubmittedDomTurn = null;
let domEventLogCount = 0;
let activeComposerMarker = null;
let pendingRecallInjection = null;

function appendLog(message, extra) {
  void ipcRenderer.invoke(`${CHANNEL_PREFIX}:log`, {
    message,
    data: extra ? safeJson(extra) : null,
  });
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(String(value));
  }
}

function isTopClaudeFrame() {
  try {
    if (window.top !== window.self) return false;
    const url = new URL(window.location.href);
    if (ALLOWED_HOSTS.has(url.hostname)) return true;
    return url.hostname.endsWith(".ant.dev");
  } catch {
    return false;
  }
}

function normalizeText(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

function payloadKeys(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  return Object.keys(payload).slice(0, 12);
}

function logObservedRequest(method, url, payload, transport = "fetch") {
  if (method !== "POST" || !url || observedRequestKeys.size >= 50) return;
  try {
    const parsed = new URL(url, window.location.href);
    const key = `${transport}:${parsed.origin}${parsed.pathname}`;
    if (observedRequestKeys.has(key)) return;
    observedRequestKeys.add(key);
    appendLog("request observed", {
      transport,
      url: `${parsed.origin}${parsed.pathname}`,
      hasPromptTarget: Boolean(findPromptTarget(payload)),
      payloadKeys: payloadKeys(payload),
    });
  } catch {}
}

function extractTextFromContent(content) {
  if (typeof content === "string") return normalizeText(content);
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return normalizeText(item);
        if (!item || typeof item !== "object") return "";
        if (typeof item.text === "string") return normalizeText(item.text);
        if (typeof item.content === "string") return normalizeText(item.content);
        if (Array.isArray(item.content)) return extractTextFromContent(item.content);
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (content && typeof content === "object") {
    if (typeof content.text === "string") return normalizeText(content.text);
    if (typeof content.content === "string") return normalizeText(content.content);
    if (Array.isArray(content.content)) return extractTextFromContent(content.content);
  }
  return "";
}

function prependRecallToContent(content, recallText) {
  if (!recallText) return content;
  if (typeof content === "string") {
    return `${recallText}\n\n${content}`;
  }
  if (Array.isArray(content)) {
    return [{ type: "text", text: recallText }, ...content];
  }
  if (content && typeof content === "object") {
    if (typeof content.text === "string") {
      return { ...content, text: `${recallText}\n\n${content.text}` };
    }
    if (typeof content.content === "string") {
      return { ...content, content: `${recallText}\n\n${content.content}` };
    }
    if (Array.isArray(content.content)) {
      return {
        ...content,
        content: prependRecallToContent(content.content, recallText),
      };
    }
  }
  return content;
}

function extractConversationKey(url, payload) {
  const candidates = [
    payload?.conversationId,
    payload?.conversation_id,
    payload?.conversation_uuid,
    payload?.chat_conversation_uuid,
    payload?.request_id,
    payload?.id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }

  try {
    const parsed = new URL(url, window.location.href);
    const match = parsed.pathname.match(/conversations\/([^/]+)/i);
    if (match?.[1]) return match[1];
  } catch {}

  return "unknown";
}

function findPromptTarget(payload) {
  if (!payload || typeof payload !== "object") return null;

  if (Array.isArray(payload.messages)) {
    for (let index = payload.messages.length - 1; index >= 0; index -= 1) {
      const message = payload.messages[index];
      if (!message || typeof message !== "object") continue;
      if (message.role !== "user") continue;
      const query = extractTextFromContent(message.content);
      if (!query) continue;
      return {
        query,
        apply(recallText) {
          message.content = prependRecallToContent(message.content, recallText);
        },
      };
    }
  }

  const directKeys = ["prompt", "text", "input", "content", "message"];
  for (const key of directKeys) {
    if (typeof payload[key] === "string" && payload[key].trim()) {
      return {
        query: normalizeText(payload[key]),
        apply(recallText) {
          payload[key] = `${recallText}\n\n${payload[key]}`;
        },
      };
    }
  }

  const nestedKeys = ["message", "user_message", "input_message"];
  for (const key of nestedKeys) {
    const value = payload[key];
    if (!value || typeof value !== "object") continue;
    const query = extractTextFromContent(value.content);
    if (!query) continue;
    return {
      query,
      apply(recallText) {
        value.content = prependRecallToContent(value.content, recallText);
      },
    };
  }

  return null;
}

function shouldInterceptRequest(urlString, method, payload) {
  if (!urlString || method !== "POST") return false;
  let url;
  try {
    url = new URL(urlString, window.location.href);
  } catch {
    return false;
  }

  const pathName = url.pathname.toLowerCase();
  if (
    pathName.includes("count_tokens") ||
    pathName.includes("/mcp/") ||
    pathName.includes("/plugins/") ||
    pathName.includes("/skills/")
  ) {
    return false;
  }

  return Boolean(findPromptTarget(payload));
}

function extractJsonBodyCandidate(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (value instanceof URLSearchParams) return value.toString();
  if (typeof FormData !== "undefined" && value instanceof FormData) return null;
  if (typeof Blob !== "undefined" && value instanceof Blob) return null;
  if (ArrayBuffer.isView(value)) {
    return new TextDecoder().decode(value);
  }
  if (value instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(value));
  }
  return null;
}

function isVisibleElement(element) {
  if (!element || typeof element !== "object") return false;
  if (typeof element.getBoundingClientRect !== "function") return false;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  if (typeof window.getComputedStyle !== "function") return true;
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

function isComposerElement(element) {
  if (!element || typeof element !== "object") return false;
  if (element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLInputElement) return true;
  if (element.isContentEditable) return true;
  const role = typeof element.getAttribute === "function" ? element.getAttribute("role") : null;
  return role === "textbox";
}

function getEventElements(event) {
  if (!event || typeof event.composedPath !== "function") return [];
  return event
    .composedPath()
    .filter((item) => item && typeof item === "object" && item.nodeType === 1);
}

function findComposerInElements(elements) {
  for (const element of elements) {
    if (isComposerElement(element) && isVisibleElement(element)) return element;
  }
  return null;
}

function findComposerElement(origin) {
  const eventPathComposer = Array.isArray(origin) ? findComposerInElements(origin) : null;
  if (eventPathComposer) return eventPathComposer;

  const direct = origin?.closest?.(
    'textarea, input[type="text"], [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]',
  );
  if (direct && isVisibleElement(direct)) return direct;

  const active = document.activeElement;
  if (active && isComposerElement(active) && isVisibleElement(active)) return active;

  const selectors = [
    "textarea",
    '[contenteditable="true"]',
    '[contenteditable="plaintext-only"]',
    '[role="textbox"]',
    "input[type='text']",
  ];
  for (const selector of selectors) {
    const candidates = Array.from(document.querySelectorAll(selector));
    const visible = candidates.filter((element) => isVisibleElement(element));
    if (visible.length === 0) continue;
    visible.sort((left, right) => {
      const leftText = normalizeText(readComposerText(left)).length;
      const rightText = normalizeText(readComposerText(right)).length;
      return rightText - leftText;
    });
    return visible[0];
  }

  return null;
}

function readComposerText(element) {
  if (!element) return "";
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    return normalizeText(element.value);
  }
  return normalizeText(element.innerText || element.textContent || "");
}

function setNativeValue(element, value) {
  const prototype = Object.getPrototypeOf(element);
  const descriptor = prototype ? Object.getOwnPropertyDescriptor(prototype, "value") : null;
  if (descriptor?.set) {
    descriptor.set.call(element, value);
    return;
  }
  element.value = value;
}

function writeComposerText(element, text) {
  if (!element) return;
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    setNativeValue(element, text);
    element.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        cancelable: false,
        data: text,
        inputType: "insertText",
      }),
    );
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }

  element.focus?.();
  try {
    const selection = window.getSelection?.();
    if (selection && typeof document.createRange === "function") {
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    if (typeof document.execCommand === "function") {
      document.execCommand("insertText", false, text);
    }
  } catch {}
  if (normalizeText(readComposerText(element)) !== normalizeText(text)) {
    element.textContent = text;
  }
  element.dispatchEvent(
    new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      data: text,
      inputType: "insertText",
    }),
  );
  element.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      cancelable: false,
      data: text,
      inputType: "insertText",
    }),
  );
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function markActiveComposer(element) {
  const marker = `memory-bridge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const previous = activeComposerMarker
    ? document.querySelector(`[data-memory-bridge-composer="${activeComposerMarker}"]`)
    : null;
  if (previous && previous !== element) {
    previous.removeAttribute("data-memory-bridge-composer");
  }
  if (element?.setAttribute) {
    element.setAttribute("data-memory-bridge-composer", marker);
    activeComposerMarker = marker;
    return marker;
  }
  return null;
}

function setPendingRecallInjection(query, sessionKey, text) {
  if (typeof text !== "string" || !text.trim()) {
    pendingRecallInjection = null;
    return;
  }
  pendingRecallInjection = {
    query: normalizeText(query),
    sessionKey,
    text,
    createdAt: Date.now(),
  };
}

function consumePendingRecallInjection(query, sessionKey) {
  if (!pendingRecallInjection) return null;
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return null;
  const isFresh = Date.now() - pendingRecallInjection.createdAt <= 15000;
  if (!isFresh) {
    pendingRecallInjection = null;
    return null;
  }
  if (pendingRecallInjection.query !== normalizedQuery) return null;
  if (
    typeof sessionKey === "string" &&
    typeof pendingRecallInjection.sessionKey === "string" &&
    pendingRecallInjection.sessionKey !== sessionKey
  ) {
    return null;
  }
  const text = pendingRecallInjection.text;
  pendingRecallInjection = null;
  return text;
}

function armBypassDomSend(durationMs = 400) {
  bypassDomSend = true;
  if (bypassDomSendTimer) {
    clearTimeout(bypassDomSendTimer);
  }
  bypassDomSendTimer = setTimeout(() => {
    bypassDomSend = false;
    bypassDomSendTimer = null;
  }, durationMs);
}

function dispatchSyntheticClick(button) {
  if (!button) return false;
  try {
    if (typeof PointerEvent === "function") {
      button.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons: 1,
          pointerType: "mouse",
          isPrimary: true,
        }),
      );
      button.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons: 0,
          pointerType: "mouse",
          isPrimary: true,
        }),
      );
    } else {
      button.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons: 1,
        }),
      );
      button.dispatchEvent(
        new MouseEvent("mouseup", {
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons: 0,
        }),
      );
    }
    if (typeof button.click === "function") {
      button.click();
      return true;
    }
    button.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
      }),
    );
    return true;
  } catch {
    return false;
  }
}

function dispatchSyntheticEnter(composer) {
  if (!composer) return false;
  try {
    composer.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
        code: "Enter",
      }),
    );
    composer.dispatchEvent(
      new KeyboardEvent("keypress", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
        code: "Enter",
      }),
    );
    composer.dispatchEvent(
      new KeyboardEvent("keyup", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
        code: "Enter",
      }),
    );
    return true;
  } catch {
    return false;
  }
}

function dispatchSyntheticSubmit(composer, button) {
  const form = composer?.closest?.("form");
  if (!form || typeof form.requestSubmit !== "function") return false;
  try {
    form.requestSubmit(button || undefined);
    return true;
  } catch {
    return false;
  }
}

async function performForcedSend(payload = {}) {
  const text = typeof payload?.text === "string" ? payload.text : "";
  const source = typeof payload?.source === "string" ? payload.source : "ipc";
  const originalText =
    typeof payload?.originalText === "string" ? normalizeText(payload.originalText) : "";

  appendLog("dom forced send start", {
    source,
    recallUsed: Boolean(payload?.recallUsed),
    textPreview: normalizeText(text).slice(0, 120),
  });

  if (!text.trim()) {
    appendLog("dom forced send skipped", { source, reason: "empty" });
    return { ok: false, reason: "empty" };
  }

  await new Promise((resolve) => setTimeout(resolve, 40));

  const composer = findComposerElement(document.activeElement) || findComposerElement([]);
  if (!composer) {
    appendLog("dom forced send skipped", { source, reason: "no-composer" });
    return { ok: false, reason: "no-composer" };
  }

  try {
    writeComposerText(composer, text);
    armBypassDomSend();
    const button = findSendButton(composer) || findSendButton(document.activeElement);
    let method = "keydown";
    let sent = false;
    if (dispatchSyntheticSubmit(composer, button)) {
      method = "requestSubmit";
      sent = true;
    } else if (button) {
      method = "click";
      sent = dispatchSyntheticClick(button);
    } else {
      sent = dispatchSyntheticEnter(composer);
    }
    if (!sent) {
      appendLog("dom forced send skipped", { source, reason: "dispatch-failed", method });
      return { ok: false, reason: "dispatch-failed" };
    }

    appendLog("dom forced send done", {
      source,
      method,
      recallUsed: Boolean(payload?.recallUsed),
      textPreview: normalizeText(text).slice(0, 120),
      originalPreview: originalText.slice(0, 120),
    });
    scheduleDomCapture("forced-send");
    return { ok: true, method };
  } catch (error) {
    appendLog("dom forced send failed", {
      source,
      message: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, reason: "exception" };
  }
}

function looksLikeSendButton(element) {
  if (!element || typeof element !== "object") return false;
  if (!isVisibleElement(element)) return false;
  const ariaLabel = normalizeText(element.getAttribute?.("aria-label") || "");
  const title = normalizeText(element.getAttribute?.("title") || "");
  const testId = normalizeText(element.getAttribute?.("data-testid") || "");
  const text = normalizeText(element.innerText || element.textContent || "");
  const combined = [ariaLabel, title, testId, text].filter(Boolean).join(" ");
  if (
    element.disabled ||
    normalizeText(element.getAttribute?.("aria-disabled") || "") === "true"
  ) {
    return false;
  }
  if (/\b(record|voice|audio|microphone|mic|press and hold to record|hold to record)\b/i.test(combined)) {
    return false;
  }
  if (/(录音|语音|麦克风|麥克風)/i.test(combined)) {
    return false;
  }
  if (/\b(send|发送|送出|提交|submit)\b/i.test(combined) || /send/i.test(testId)) {
    return true;
  }
  return element instanceof HTMLButtonElement && element.type === "submit" && combined.length > 0;
}

function findSendButtonInElements(elements) {
  for (const element of elements) {
    if (looksLikeSendButton(element)) return element;
  }
  return null;
}

function findSendButton(origin) {
  const eventPathButton = Array.isArray(origin) ? findSendButtonInElements(origin) : null;
  if (eventPathButton) return eventPathButton;

  const direct = origin?.closest?.('button, [role="button"]');
  if (direct && looksLikeSendButton(direct)) return direct;

  const composer = findComposerElement(origin);
  const form = composer?.closest?.("form");
  if (form) {
    const formButton = Array.from(
      form.querySelectorAll('button[type="submit"], button, [role="button"]'),
    ).find((element) => looksLikeSendButton(element));
    if (looksLikeSendButton(formButton)) return formButton;
  }

  const candidates = Array.from(
    document.querySelectorAll(
      'button[type="submit"], button[aria-label], button[title], button[data-testid], [role="button"][aria-label]',
    ),
  );
  return candidates.find((element) => looksLikeSendButton(element)) || null;
}

function extractCurrentConversationKey() {
  const pathName = typeof window?.location?.pathname === "string" ? window.location.pathname : "";
  const match = pathName.match(/(?:chat|conversation|conversations)\/([^/?#]+)/i);
  if (match?.[1]) return match[1];
  return pathName || "unknown";
}

function logDomEvent(kind, event, extra = {}) {
  if (domEventLogCount >= 40) return;
  domEventLogCount += 1;
  const elements = getEventElements(event);
  const button = findSendButton(elements);
  const composer = findComposerElement(elements);
  appendLog("dom event observed", {
    kind,
    key: event?.key || null,
    button: button
      ? {
          tag: button.tagName,
          aria: button.getAttribute?.("aria-label") || null,
          title: button.getAttribute?.("title") || null,
          testId: button.getAttribute?.("data-testid") || null,
          text: normalizeText(button.innerText || button.textContent || "").slice(0, 80),
        }
      : null,
    composer: composer
      ? {
          tag: composer.tagName,
          role: composer.getAttribute?.("role") || null,
          textPreview: readComposerText(composer).slice(0, 120),
        }
      : null,
    targetTag: event?.target?.tagName || null,
    ...extra,
  });
}

async function rememberExplicitText(query, sessionKey) {
  const result = await ipcRenderer.invoke(`${CHANNEL_PREFIX}:store-explicit`, {
    text: query,
    agentId: "claude-desktop",
    scope: "agent:claude-desktop",
    importance: 0.95,
  });
  if (result?.stored) {
    appendLog("explicit memory stored", {
      sessionKey,
      textPreview: normalizeText(query).slice(0, 120),
      reason: result.reason,
    });
  }
  return result;
}

function makeDomSubmissionHash(query, sessionKey) {
  return makeTurnHash([sessionKey || "unknown", query || ""]);
}

async function maybeStoreExplicitFromDom(query, sessionKey, trigger) {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) {
    appendLog("dom explicit skipped", { trigger, reason: "empty", sessionKey });
    return { ok: false, stored: false, reason: "empty" };
  }

  const hash = makeDomSubmissionHash(normalizedQuery, sessionKey);
  if (domSubmissionHashes.has(hash)) {
    appendLog("dom explicit skipped", { trigger, reason: "duplicate", sessionKey });
    return { ok: true, stored: false, reason: "duplicate" };
  }
  domSubmissionHashes.add(hash);

  try {
    const result = await rememberExplicitText(normalizedQuery, sessionKey);
    appendLog("dom explicit processed", {
      trigger,
      sessionKey,
      stored: Boolean(result?.stored),
      reason: result?.reason || "unknown",
      textPreview: normalizedQuery.slice(0, 120),
    });
    return result;
  } catch (error) {
    appendLog("dom explicit failed", {
      trigger,
      sessionKey,
      message: error instanceof Error ? error.message : String(error),
      textPreview: normalizedQuery.slice(0, 120),
    });
    return { ok: false, stored: false, reason: "exception" };
  }
}

async function prepareDomSubmission(origin, trigger) {
  appendLog("dom prepare start", { trigger, bypassDomSend, domSendInFlight });
  if (domSendInFlight || bypassDomSend) {
    appendLog("dom prepare skipped", { trigger, reason: "busy" });
    return { ok: false, reason: "busy" };
  }

  const composer = findComposerElement(origin);
  if (!composer) {
    appendLog("dom prepare skipped", { trigger, reason: "no-composer" });
    return { ok: false, reason: "no-composer" };
  }

  const originalText = readComposerText(composer);
  if (!originalText) {
    appendLog("dom prepare skipped", { trigger, reason: "empty" });
    return { ok: false, reason: "empty" };
  }

  domSendInFlight = true;
  try {
    const sessionKey = extractCurrentConversationKey();
    const composerMarker = markActiveComposer(composer);
    appendLog("dom prepare composer resolved", {
      trigger,
      sessionKey,
      composerMarker,
      textPreview: originalText.slice(0, 120),
    });

    lastSubmittedDomTurn = {
      sessionKey,
      userQuery: originalText,
      explicitStored: false,
      submittedAt: Date.now(),
      lastAssistantText: "",
    };
    appendLog("dom prepare delegated", {
      trigger,
      sessionKey,
      queryPreview: originalText.slice(0, 120),
    });
    const result = await ipcRenderer.invoke(`${CHANNEL_PREFIX}:prepare-send`, {
      query: originalText,
      agentId: "claude-desktop",
      sessionKey,
      limit: 5,
      composerMarker,
    });
    setPendingRecallInjection(originalText, sessionKey, result?.recallText || null);
    lastSubmittedDomTurn.explicitStored = Boolean(result?.explicitStored);
    appendLog("dom prepare result", {
      trigger,
      sessionKey,
      ok: Boolean(result?.ok),
      reason: result?.reason || null,
      recallUsed: Boolean(result?.recallUsed),
      explicitStored: Boolean(result?.explicitStored),
      recallReason: result?.recallReason || null,
    });
    scheduleDomCapture("prepare");
    return { ok: Boolean(result?.ok), composer };
  } catch (error) {
    appendLog("dom prepare failed", {
      trigger,
      message: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, reason: "exception" };
  } finally {
    domSendInFlight = false;
  }
}

function retriggerDomSend(origin) {
  const button = findSendButton(origin);
  if (button) {
    bypassDomSend = true;
    setTimeout(() => {
      bypassDomSend = false;
    }, 100);
    const form = button.form || button.closest?.("form");
    if (form && typeof form.requestSubmit === "function") {
      form.requestSubmit(button);
      return true;
    }
    if (typeof button.click === "function") {
      button.click();
      return true;
    }
    if (typeof PointerEvent === "function") {
      button.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons: 1,
          pointerType: "mouse",
          isPrimary: true,
        }),
      );
      button.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons: 0,
          pointerType: "mouse",
          isPrimary: true,
        }),
      );
    }
    button.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
      }),
    );
    return true;
  }

  const composer = findComposerElement(origin);
  if (!composer) return false;
  bypassDomSend = true;
  setTimeout(() => {
    bypassDomSend = false;
  }, 100);
  composer.dispatchEvent(
    new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
      code: "Enter",
    }),
  );
  return true;
}

function collectAssistantDomCandidates() {
  const inferMessageRole = (node, text) => {
    const authorNode = node.closest?.('[data-message-author-role]') || node;
    const author = normalizeText(authorNode?.getAttribute?.('data-message-author-role') || '');
    if (author === 'assistant') return 'assistant';
    if (author === 'user') return 'user';
    const testId = normalizeText(
      node.getAttribute?.('data-testid') ||
      authorNode?.getAttribute?.('data-testid') ||
      '',
    );
    if (/assistant/.test(testId)) return 'assistant';
    if (/user-message|human-message|user/.test(testId)) return 'user';
    const role = normalizeText(node.getAttribute?.('role') || '');
    const ariaLive = normalizeText(node.getAttribute?.('aria-live') || '');
    if (role === 'status' || ariaLive) return 'status';
    if (/^thinking(?:\s+thinking)?$/i.test(text) || /^thought for /i.test(text)) return 'status';
    return 'unknown';
  };
  const selectors = [
    '[data-message-author-role="assistant"]',
    '[data-testid*="assistant"]',
    '[data-testid*="message"]',
    "article",
    "main section",
  ];
  const seen = new Set();
  const candidates = [];
  for (const selector of selectors) {
    const nodes = Array.from(document.querySelectorAll(selector)).slice(-20);
    for (const node of nodes) {
      if (!isVisibleElement(node)) continue;
      const text = normalizeText(node.innerText || node.textContent || "");
      if (!text || text.length < 24) continue;
      const inferredRole = inferMessageRole(node, text);
      if (inferredRole === "user" || inferredRole === "status") continue;
      if (lastSubmittedDomTurn?.userQuery && text === normalizeText(lastSubmittedDomTurn.userQuery)) {
        continue;
      }
      if (text.includes("<relevant-memories>")) continue;
      const key = `${selector}:${text.slice(0, 160)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ selector, text, inferredRole });
    }
  }
  return candidates;
}

async function maybeCaptureFromDom(reason) {
  if (!lastSubmittedDomTurn?.userQuery) return;
  const candidates = collectAssistantDomCandidates();
  const candidate = candidates[candidates.length - 1];
  if (!candidate) {
    appendLog("dom capture skipped: no assistant candidate", { reason });
    return;
  }
  if (candidate.text === lastSubmittedDomTurn.lastAssistantText) return;

  lastSubmittedDomTurn.lastAssistantText = candidate.text;
  const hash = makeTurnHash([
    lastSubmittedDomTurn.sessionKey,
    lastSubmittedDomTurn.userQuery,
    candidate.text,
  ]);
  if (capturedTurnHashes.has(hash)) return;
  capturedTurnHashes.add(hash);

  const result = await ipcRenderer.invoke(`${CHANNEL_PREFIX}:capture`, {
    texts: [lastSubmittedDomTurn.userQuery, candidate.text],
    sessionKey: `claude-desktop:${lastSubmittedDomTurn.sessionKey}`,
    agentId: "claude-desktop",
  });
  appendLog("dom captured turn", {
    reason,
    selector: candidate.selector,
    sessionKey: lastSubmittedDomTurn.sessionKey,
    stored: result?.stored,
    captureReason: result?.reason,
  });
}

function scheduleDomCapture(reason) {
  if (domCaptureTimer) clearTimeout(domCaptureTimer);
  domCaptureTimer = setTimeout(() => {
    void maybeCaptureFromDom(reason);
  }, 2200);
}

function installDomBridge() {
  if (domBridgeInstalled) return;

  document.addEventListener(
    "submit",
    (event) => {
      logDomEvent("submit", event);
      if (bypassDomSend) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const elements = getEventElements(event);
      void prepareDomSubmission(elements, "submit").then((result) => {
        if (result?.ok) retriggerDomSend(event.target);
      });
    },
    true,
  );

  document.addEventListener(
    "pointerdown",
    (event) => {
      logDomEvent("pointerdown", event);
      if (event.button !== 0) return;
      const elements = getEventElements(event);
      const button = findSendButton(elements) || event.target?.closest?.('button, [role="button"]');
      if (!looksLikeSendButton(button) || bypassDomSend) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void prepareDomSubmission(elements, "pointerdown").then((result) => {
        if (result?.ok) retriggerDomSend(button);
      });
    },
    true,
  );

  document.addEventListener(
    "mousedown",
    (event) => {
      logDomEvent("mousedown", event);
      if (event.button !== 0) return;
      const elements = getEventElements(event);
      const button = findSendButton(elements) || event.target?.closest?.('button, [role="button"]');
      if (!looksLikeSendButton(button) || bypassDomSend) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void prepareDomSubmission(elements, "mousedown").then((result) => {
        if (result?.ok) retriggerDomSend(button);
      });
    },
    true,
  );

  document.addEventListener(
    "click",
    (event) => {
      logDomEvent("click", event);
      const elements = getEventElements(event);
      const button = findSendButton(elements) || event.target?.closest?.('button, [role="button"]');
      if (!looksLikeSendButton(button) || bypassDomSend) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void prepareDomSubmission(elements, "click").then((result) => {
        if (result?.ok) retriggerDomSend(button);
      });
    },
    true,
  );

  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Enter") return;
      logDomEvent("keydown", event);
      if (bypassDomSend) {
        appendLog("keydown skipped", { reason: "bypass" });
        return;
      }
      if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) {
        appendLog("keydown skipped", {
          reason: "modified-enter",
          shiftKey: Boolean(event.shiftKey),
          metaKey: Boolean(event.metaKey),
          ctrlKey: Boolean(event.ctrlKey),
          altKey: Boolean(event.altKey),
        });
        return;
      }
      try {
        const elements = getEventElements(event);
        const composer =
          findComposerElement(elements) ||
          findComposerElement(event.target) ||
          (isComposerElement(event.target) ? event.target : null);
        appendLog("keydown candidate", {
          targetTag: event?.target?.tagName || null,
          hasComposer: Boolean(composer),
          composerTag: composer?.tagName || null,
          composerRole: composer?.getAttribute?.("role") || null,
          textPreview: composer ? readComposerText(composer).slice(0, 120) : null,
        });
        if (!composer) {
          appendLog("keydown skipped", { reason: "no-composer" });
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        void prepareDomSubmission(composer, "keydown").then((result) => {
          if (result?.ok) retriggerDomSend(composer);
        });
      } catch (error) {
        appendLog("keydown handler failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    true,
  );

  domObserver = new MutationObserver(() => {
    scheduleDomCapture("mutation");
  });
  domObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  domBridgeInstalled = true;
  appendLog("dom bridge installed");
}

async function readRequestBodyText(input, init) {
  const initBody = extractJsonBodyCandidate(init?.body);
  if (typeof initBody === "string") return initBody;

  if (typeof Request !== "undefined" && input instanceof Request) {
    try {
      return await input.clone().text();
    } catch {
      return null;
    }
  }

  return null;
}

function parseJson(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function buildMutatedFetchArgs(input, init, bodyText) {
  if (typeof Request !== "undefined" && input instanceof Request) {
    return [new Request(input, { body: bodyText }), init];
  }
  return [input, { ...(init || {}), body: bodyText }];
}

function collectAssistantTextFromObject(value, chunks) {
  if (!value) return;
  if (typeof value === "string") return;
  if (Array.isArray(value)) {
    for (const item of value) collectAssistantTextFromObject(item, chunks);
    return;
  }
  if (typeof value !== "object") return;

  if (typeof value.completion === "string" && value.completion.trim()) {
    chunks.push(value.completion.trim());
  }
  if (typeof value.text === "string" && value.text.trim()) {
    chunks.push(value.text.trim());
  }
  if (value.delta && typeof value.delta.text === "string" && value.delta.text.trim()) {
    chunks.push(value.delta.text.trim());
  }
  if (
    value.content_block &&
    typeof value.content_block.text === "string" &&
    value.content_block.text.trim()
  ) {
    chunks.push(value.content_block.text.trim());
  }
  if (value.message) {
    const text = extractTextFromContent(value.message.content);
    if (text) chunks.push(text);
  }
  if (value.content) {
    const text = extractTextFromContent(value.content);
    if (text) chunks.push(text);
  }
}

function extractAssistantTextFromResponseBody(rawText) {
  if (typeof rawText !== "string" || !rawText.trim()) return "";

  const directJson = parseJson(rawText);
  if (directJson) {
    const chunks = [];
    collectAssistantTextFromObject(directJson, chunks);
    return dedupeChunks(chunks).join("").trim();
  }

  const chunks = [];
  for (const line of rawText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    const parsed = parseJson(payload);
    if (!parsed) continue;
    collectAssistantTextFromObject(parsed, chunks);
  }
  return dedupeChunks(chunks).join("").trim();
}

function dedupeChunks(chunks) {
  const result = [];
  for (const chunk of chunks) {
    const normalized = normalizeText(chunk);
    if (!normalized) continue;
    if (result.length === 0) {
      result.push(chunk);
      continue;
    }
    const last = result[result.length - 1];
    if (normalized === normalizeText(last)) continue;
    result.push(chunk);
  }
  return result;
}

function makeTurnHash(parts) {
  return parts
    .map((part) => normalizeText(String(part)).slice(0, 300))
    .join("\u0000");
}

async function maybeCaptureTurn(meta, response) {
  if (!meta?.userQuery || !response) return;

  try {
    const rawText = await response.clone().text();
    const assistantText = extractAssistantTextFromResponseBody(rawText);
    if (!assistantText) {
      appendLog("capture skipped: no assistant text", { url: meta.url });
      return;
    }

    const hash = makeTurnHash([meta.sessionKey, meta.userQuery, assistantText]);
    if (capturedTurnHashes.has(hash)) return;
    capturedTurnHashes.add(hash);

    const result = await ipcRenderer.invoke(`${CHANNEL_PREFIX}:capture`, {
      texts: [meta.userQuery, assistantText],
      sessionKey: `claude-desktop:${meta.sessionKey}`,
      agentId: "claude-desktop",
    });
    appendLog("captured turn", {
      sessionKey: meta.sessionKey,
      stored: result?.stored,
      reason: result?.reason,
    });
  } catch (error) {
    appendLog("capture failed", {
      message: error instanceof Error ? error.message : String(error),
      url: meta?.url,
    });
  }
}

async function patchFetch() {
  if (typeof window.fetch !== "function") return;

  const originalFetch = window.fetch.bind(window);

  const wrappedFetch = async function memoryBridgeFetch(input, init) {
    let requestMeta = null;

    try {
      const method = String(
        init?.method ||
          (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET"),
      ).toUpperCase();
      const url =
        typeof input === "string" || input instanceof URL
          ? String(input)
          : typeof input?.url === "string"
            ? input.url
            : "";
      const bodyText = await readRequestBodyText(input, init);
      const payload = parseJson(bodyText);
      logObservedRequest(method, url, payload, "fetch");

      if (payload && shouldInterceptRequest(url, method, payload)) {
        const promptTarget = findPromptTarget(payload);
        if (promptTarget && !promptTarget.query.includes("<relevant-memories>")) {
          requestMeta = {
            url,
            userQuery: promptTarget.query,
            sessionKey: extractConversationKey(url, payload),
          };

          const pendingRecallText = consumePendingRecallInjection(
            promptTarget.query,
            requestMeta.sessionKey,
          );

          if (pendingRecallText) {
            promptTarget.apply(pendingRecallText);
            const mutatedBody = JSON.stringify(payload);
            [input, init] = buildMutatedFetchArgs(input, init, mutatedBody);
            appendLog("recall injected", {
              url,
              sessionKey: requestMeta.sessionKey,
              queryPreview: promptTarget.query.slice(0, 120),
              source: "pending",
            });
          } else {
            const recall = await ipcRenderer.invoke(`${CHANNEL_PREFIX}:recall`, {
              query: promptTarget.query,
              agentId: "claude-desktop",
              limit: 3,
            });

            if (recall?.text) {
              promptTarget.apply(recall.text);
              const mutatedBody = JSON.stringify(payload);
              [input, init] = buildMutatedFetchArgs(input, init, mutatedBody);
              appendLog("recall injected", {
                url,
                sessionKey: requestMeta.sessionKey,
                queryPreview: promptTarget.query.slice(0, 120),
              });
            } else {
              appendLog("recall skipped", {
                url,
                sessionKey: requestMeta.sessionKey,
                reason: recall?.reason || "unknown",
              });
            }
          }
        }
      }
    } catch (error) {
      appendLog("request interception failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }

    const response = await originalFetch(input, init);
    if (requestMeta && response?.ok) {
      void maybeCaptureTurn(requestMeta, response);
    }
    return response;
  };

  window.fetch = wrappedFetch;
  activeFetchWrapper = wrappedFetch;
  appendLog("fetch bridge installed");
}

function buildResponseLike(text) {
  return {
    clone() {
      return {
        async text() {
          return typeof text === "string" ? text : "";
        },
      };
    },
  };
}

function patchXhr() {
  if (xhrPatched || typeof XMLHttpRequest === "undefined") return;

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function memoryBridgeOpen(method, url, ...rest) {
    this.__memoryBridgeRequest = {
      method: typeof method === "string" ? method.toUpperCase() : "GET",
      url: typeof url === "string" ? url : String(url || ""),
    };
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function memoryBridgeSend(body) {
    const meta = this.__memoryBridgeRequest || { method: "GET", url: "" };
    const bodyText = extractJsonBodyCandidate(body);
    const payload = parseJson(bodyText);
    let requestMeta = null;

    logObservedRequest(meta.method, meta.url, payload, "xhr");

    const sendPromise = (async () => {
      try {
        if (payload && shouldInterceptRequest(meta.url, meta.method, payload)) {
          const promptTarget = findPromptTarget(payload);
          if (promptTarget && !promptTarget.query.includes("<relevant-memories>")) {
            requestMeta = {
              url: meta.url,
              userQuery: promptTarget.query,
              sessionKey: extractConversationKey(meta.url, payload),
            };

            const pendingRecallText = consumePendingRecallInjection(
              promptTarget.query,
              requestMeta.sessionKey,
            );

            if (pendingRecallText) {
              promptTarget.apply(pendingRecallText);
              body = JSON.stringify(payload);
              appendLog("recall injected", {
                url: meta.url,
                sessionKey: requestMeta.sessionKey,
                queryPreview: promptTarget.query.slice(0, 120),
                transport: "xhr",
                source: "pending",
              });
            } else {
              const recall = await ipcRenderer.invoke(`${CHANNEL_PREFIX}:recall`, {
                query: promptTarget.query,
                agentId: "claude-desktop",
                limit: 3,
              });

              if (recall?.text) {
                promptTarget.apply(recall.text);
                body = JSON.stringify(payload);
                appendLog("recall injected", {
                  url: meta.url,
                  sessionKey: requestMeta.sessionKey,
                  queryPreview: promptTarget.query.slice(0, 120),
                  transport: "xhr",
                });
              } else {
                appendLog("recall skipped", {
                  url: meta.url,
                  sessionKey: requestMeta.sessionKey,
                  reason: recall?.reason || "unknown",
                  transport: "xhr",
                });
              }
            }
          }
        }
      } catch (error) {
        appendLog("request interception failed", {
          message: error instanceof Error ? error.message : String(error),
          transport: "xhr",
        });
      }

      return originalSend.call(this, body);
    })();

    this.addEventListener(
      "loadend",
      () => {
        if (!requestMeta) return;
        if (!(this.status >= 200 && this.status < 300)) return;
        const responseText = typeof this.responseText === "string" ? this.responseText : "";
        void maybeCaptureTurn(requestMeta, buildResponseLike(responseText));
      },
      { once: true },
    );

    return sendPromise;
  };

  xhrPatched = true;
  appendLog("xhr bridge installed");
}

function watchBridge() {
  if (bridgeWatchTimer) return;
  bridgeWatchTimer = setInterval(() => {
    if (!isTopClaudeFrame()) return;
    if (typeof window.fetch === "function" && window.fetch !== activeFetchWrapper) {
      void patchFetch();
    }
    if (!domBridgeInstalled && document?.documentElement) {
      try {
        installDomBridge();
      } catch (error) {
        appendLog("dom bridge install failed", {
          message: error instanceof Error ? error.message : String(error),
          phase: "watch",
        });
      }
    }
  }, 1500);
}

function installBridge() {
  ipcRenderer.on(`${CHANNEL_PREFIX}:perform-send`, (_event, payload = {}) => {
    void performForcedSend(payload);
  });
  appendLog("preload loaded", {
    href: typeof window?.location?.href === "string" ? window.location.href : "",
  });
  if (!isTopClaudeFrame()) {
    appendLog("bridge skipped: non-target frame-or-host", {
      href: typeof window?.location?.href === "string" ? window.location.href : "",
    });
    return;
  }
  void patchFetch();
  patchXhr();
  try {
    installDomBridge();
  } catch (error) {
    appendLog("dom bridge install failed", {
      message: error instanceof Error ? error.message : String(error),
      phase: "initial",
    });
  }
  watchBridge();
}

installBridge();
