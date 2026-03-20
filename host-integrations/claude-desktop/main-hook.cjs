const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

if (!process.versions?.electron || process.type === "renderer") {
  module.exports = {};
} else {

const { app, clipboard, ipcMain, session, webContents } = require("electron");

const preloadPath = path.resolve(__dirname, "preload.cjs");
const installedSessions = new WeakSet();
const LOG_PATH = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Claude",
  "Logs",
  "memory-bridge.log",
);
const CONTROL_HOST = "127.0.0.1";
const CONTROL_PORT = 43129;
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
let runtimePromise = null;
let handlersRegistered = false;
let controlServer = null;
const observedNetworkSessions = new WeakSet();
const observedDebuggerContents = new WeakSet();
const pendingCompletionCaptures = new Map();
const pendingCompletionByConversation = new Map();
const activeCompletionCapturePolls = new Set();

function log(message, data) {
  const prefix = "[memory-lancedb-pro][claude-desktop][main-hook]";
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    const extra = data
      ? ` ${
          data instanceof Error
            ? data.stack || data.message
            : JSON.stringify(data)
        }`
      : "";
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${prefix} ${message}${extra}\n`);
  } catch {}
  if (data) {
    console.error(`${prefix} ${message}`, data);
    return;
  }
  console.log(`${prefix} ${message}`);
}

function getRuntime() {
  if (!runtimePromise) {
    const runtimePath = path.resolve(__dirname, "../../host-runtime.mjs");
    runtimePromise = import(runtimePath);
  }
  return runtimePromise;
}

function readUploadPreview(details) {
  const uploadData = Array.isArray(details?.uploadData) ? details.uploadData : [];
  for (const entry of uploadData) {
    if (entry?.bytes) {
      try {
        return Buffer.from(entry.bytes).toString("utf8").slice(0, 400);
      } catch {}
    }
    if (typeof entry?.file === "string" && entry.file) {
      return `[file] ${entry.file}`;
    }
  }
  return null;
}

function shouldLogNetworkRequest(details) {
  if (!details?.url || typeof details.url !== "string") return false;
  if (details.method !== "POST") return false;
  try {
    const parsed = new URL(details.url);
    if (ALLOWED_HOSTS.has(parsed.hostname)) return true;
    return parsed.hostname.endsWith(".ant.dev");
  } catch {
    return false;
  }
}

function shouldLogDebuggerRequest(request) {
  if (!request?.url || typeof request.url !== "string") return false;
  if (request.method !== "POST") return false;
  try {
    const parsed = new URL(request.url);
    if (ALLOWED_HOSTS.has(parsed.hostname)) return true;
    return parsed.hostname.endsWith(".ant.dev");
  } catch {
    return false;
  }
}

function isCompletionRequestUrl(url) {
  if (typeof url !== "string" || !url) return false;
  return /\/chat_conversations\/[^/]+\/completion(?:[/?#]|$)/i.test(url);
}

function extractConversationId(url) {
  if (typeof url !== "string" || !url) return null;
  const match = url.match(/\/chat_conversations\/([^/?#]+)/i);
  return match?.[1] || null;
}

function decodeResponseBody(result) {
  if (!result || typeof result.body !== "string") return null;
  if (result.base64Encoded) {
    try {
      return Buffer.from(result.body, "base64").toString("utf8");
    } catch {
      return null;
    }
  }
  return result.body;
}

function extractTextFromContentNode(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => extractTextFromContentNode(item))
      .filter(Boolean)
      .join("");
  }
  if (!content || typeof content !== "object") return "";
  if (typeof content.text === "string") return content.text;
  if (typeof content.content === "string") return content.content;
  if (Array.isArray(content.content)) return extractTextFromContentNode(content.content);
  if (content.delta) return extractTextFromContentNode(content.delta);
  return "";
}

function extractAssistantTextFromEvent(event) {
  if (!event || typeof event !== "object") return { delta: "", snapshot: "" };

  const deltaCandidates = [
    event?.delta?.text,
    event?.content_block?.text,
    event?.content_block_delta?.delta?.text,
    event?.message_delta?.text,
  ]
    .filter((value) => typeof value === "string" && value)
    .join("");

  const snapshotCandidates = [
    typeof event?.completion === "string" ? event.completion : "",
    typeof event?.text === "string" ? event.text : "",
    extractTextFromContentNode(event?.content),
    extractTextFromContentNode(event?.message?.content),
  ]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);

  return {
    delta: deltaCandidates,
    snapshot: snapshotCandidates[0] || "",
  };
}

function extractAssistantTextFromCompletionBody(bodyText) {
  if (typeof bodyText !== "string" || !bodyText.trim()) return null;

  const parseStructured = (value) => {
    try {
      const parsed = JSON.parse(value);
      const extracted = extractAssistantTextFromEvent(parsed);
      return extracted.delta || extracted.snapshot || null;
    } catch {
      return null;
    }
  };

  const direct = parseStructured(bodyText);
  if (direct) return direct.trim() || null;

  const lines = bodyText.split(/\r?\n/);
  const deltas = [];
  let longestSnapshot = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const raw = trimmed.slice(5).trim();
    if (!raw || raw === "[DONE]") continue;
    try {
      const parsed = JSON.parse(raw);
      const extracted = extractAssistantTextFromEvent(parsed);
      if (extracted.delta) deltas.push(extracted.delta);
      if (extracted.snapshot && extracted.snapshot.length > longestSnapshot.length) {
        longestSnapshot = extracted.snapshot;
      }
    } catch {}
  }

  const text = deltas.length > 0 ? deltas.join("") : longestSnapshot;
  return text.trim() || null;
}

function injectRecallIntoCompletionBody(rawBody, recallText) {
  if (typeof rawBody !== "string" || !rawBody.trim()) return null;
  if (typeof recallText !== "string" || !recallText.trim()) return null;
  try {
    const payload = JSON.parse(rawBody);
    if (typeof payload?.prompt !== "string" || !payload.prompt.trim()) return null;
    const stylePrompt =
      Array.isArray(payload.personalized_styles) &&
      payload.personalized_styles[0] &&
      typeof payload.personalized_styles[0].prompt === "string"
        ? payload.personalized_styles[0].prompt
        : null;

    if (
      payload.prompt.includes("<relevant-memories>") ||
      (typeof stylePrompt === "string" && stylePrompt.includes("<relevant-memories>"))
    ) {
      return null;
    }

    if (typeof stylePrompt === "string") {
      payload.personalized_styles[0].prompt = `${stylePrompt.replace(/\s+$/g, "")}\n\n${recallText}\n`;
    } else {
      payload.prompt = `${recallText}\n\n${payload.prompt}`;
    }
    return JSON.stringify(payload);
  } catch {
    return null;
  }
}

async function handlePausedCompletionRequest(contents, params) {
  const requestId = params?.requestId;
  const request = params?.request;
  if (!requestId || !request) return;

  const continueParams = { requestId };
  try {
    if (params?.responseStatusCode || params?.responseErrorReason) {
      await handlePausedCompletionResponse(contents, params);
      return;
    }

    if (request.method !== "POST" || !isCompletionRequestUrl(request.url)) {
      await contents.debugger.sendCommand("Fetch.continueRequest", continueParams);
      return;
    }

    const postData = typeof request.postData === "string" ? request.postData : "";
    if (!postData) {
      log("fetch completion skipped", {
        reason: "missing-post-data",
        url: request.url,
      });
      await contents.debugger.sendCommand("Fetch.continueRequest", continueParams);
      return;
    }

    let query = "";
    try {
      const parsed = JSON.parse(postData);
      query = typeof parsed?.prompt === "string" ? parsed.prompt.trim() : "";
    } catch {}

    if (!query || query.includes("<relevant-memories>")) {
      await contents.debugger.sendCommand("Fetch.continueRequest", continueParams);
      return;
    }

    const captureMeta = {
      fetchRequestId: requestId,
      networkId: params?.networkId || null,
      query,
      conversationId: extractConversationId(request.url),
      url: request.url,
      startedAt: Date.now(),
    };
    pendingCompletionCaptures.set(requestId, captureMeta);
    if (captureMeta.networkId) {
      pendingCompletionCaptures.set(captureMeta.networkId, captureMeta);
    }
    if (captureMeta.conversationId) {
      pendingCompletionByConversation.set(captureMeta.conversationId, captureMeta);
    }

    const { recallMemories } = await getRuntime();
    const recall = await recallMemories({
      query,
      agentId: "claude-desktop",
      limit: 5,
      allowAdaptiveSkip: true,
    });

    const injectedBody = injectRecallIntoCompletionBody(postData, recall?.text);
    if (!injectedBody) {
      log("fetch recall skipped", {
        url: request.url,
        queryPreview: query.slice(0, 120),
        reason: recall?.reason || "no-recall-text",
      });
      await contents.debugger.sendCommand("Fetch.continueRequest", continueParams);
      return;
    }

    continueParams.interceptResponse = true;
    continueParams.postData = Buffer.from(injectedBody, "utf8").toString("base64");
    log("fetch recall injected", {
      url: request.url,
      queryPreview: query.slice(0, 120),
      recallReason: recall?.reason || null,
      injectedPreview: injectedBody.slice(0, 200),
    });
    await contents.debugger.sendCommand("Fetch.continueRequest", continueParams);
  } catch (error) {
    log("fetch recall injection failed", {
      url: request?.url || null,
      message: error instanceof Error ? error.message : String(error),
    });
    try {
      await contents.debugger.sendCommand("Fetch.continueRequest", continueParams);
    } catch {}
  }
}

async function handlePausedCompletionResponse(contents, params) {
  const requestId = params?.requestId;
  const request = params?.request;
  if (!requestId || !request) return;

  const continueParams = { requestId };
  const conversationId = extractConversationId(request.url);
  const captureMeta = conversationId ? pendingCompletionByConversation.get(conversationId) : null;

  try {
    if (request.method !== "POST" || !isCompletionRequestUrl(request.url)) {
      await contents.debugger.sendCommand("Fetch.continueRequest", continueParams);
      return;
    }

    if ((params?.responseStatusCode ?? 0) !== 200) {
      log("fetch completion capture skipped", {
        url: request.url,
        reason: "non-200-response",
        statusCode: params?.responseStatusCode ?? null,
      });
      await contents.debugger.sendCommand("Fetch.continueRequest", continueParams);
      return;
    }

    const response = await contents.debugger.sendCommand("Fetch.getResponseBody", { requestId });
    const bodyText = decodeResponseBody(response);
    const assistantText = extractAssistantTextFromCompletionBody(bodyText);

    log("fetch response body", {
      url: request.url,
      hasBody: Boolean(bodyText),
      bodyPreview: typeof bodyText === "string" ? bodyText.slice(0, 300) : null,
      assistantPreview: assistantText ? assistantText.slice(0, 200) : null,
    });

    if (
      !captureMeta ||
      !assistantText ||
      assistantText === captureMeta.query ||
      assistantText.includes("<relevant-memories>")
    ) {
      log("fetch completion capture skipped", {
        url: request.url,
        reason: !captureMeta
          ? "missing-capture-meta"
          : assistantText
            ? "invalid-assistant-text"
            : "no-assistant-text",
      });
      await contents.debugger.sendCommand("Fetch.continueRequest", continueParams);
      return;
    }

    const { captureMessages } = await getRuntime();
    const result = await captureMessages({
      texts: [captureMeta.query, assistantText],
      sessionKey: `claude-desktop:${captureMeta.conversationId || "unknown"}`,
      agentId: "claude-desktop",
    });

    log("fetch completion captured", {
      url: request.url,
      stored: Boolean(result?.stored),
      reason: result?.reason || null,
      assistantPreview: assistantText.slice(0, 160),
    });

    pendingCompletionCaptures.delete(requestId);
    if (captureMeta.fetchRequestId) {
      pendingCompletionCaptures.delete(captureMeta.fetchRequestId);
    }
    if (captureMeta.networkId) {
      pendingCompletionCaptures.delete(captureMeta.networkId);
    }
    if (captureMeta.conversationId) {
      pendingCompletionByConversation.delete(captureMeta.conversationId);
      activeCompletionCapturePolls.delete(captureMeta.conversationId);
    }
    await contents.debugger.sendCommand("Fetch.continueRequest", continueParams);
  } catch (error) {
    log("fetch completion capture failed", {
      url: request?.url || null,
      message: error instanceof Error ? error.message : String(error),
    });
    try {
      await contents.debugger.sendCommand("Fetch.continueRequest", continueParams);
    } catch {}
  }
}

async function handleCompletionLoadingFinished(contents, params) {
  const requestId = params?.requestId;
  if (!requestId || !pendingCompletionCaptures.has(requestId)) return;

  const captureMeta = pendingCompletionCaptures.get(requestId);
  pendingCompletionCaptures.delete(requestId);
  if (captureMeta?.fetchRequestId) {
    pendingCompletionCaptures.delete(captureMeta.fetchRequestId);
  }
  if (captureMeta?.networkId) {
    pendingCompletionCaptures.delete(captureMeta.networkId);
  }
  if (captureMeta?.conversationId) {
    pendingCompletionByConversation.delete(captureMeta.conversationId);
  }

  try {
    const response = await contents.debugger.sendCommand("Network.getResponseBody", {
      requestId,
    });
    const bodyText = decodeResponseBody(response);
    const assistantText = extractAssistantTextFromCompletionBody(bodyText);

    log("completion response body", {
      url: captureMeta?.url || null,
      hasBody: Boolean(bodyText),
      bodyPreview: typeof bodyText === "string" ? bodyText.slice(0, 300) : null,
      assistantPreview: assistantText ? assistantText.slice(0, 200) : null,
    });

    if (!assistantText || assistantText === captureMeta?.query || assistantText.includes("<relevant-memories>")) {
      log("completion capture skipped", {
        url: captureMeta?.url || null,
        reason: assistantText ? "invalid-assistant-text" : "no-assistant-text",
      });
      return;
    }

    const { captureMessages } = await getRuntime();
    const result = await captureMessages({
      texts: [captureMeta.query, assistantText],
      sessionKey: `claude-desktop:${captureMeta.conversationId || "unknown"}`,
      agentId: "claude-desktop",
    });

    log("completion captured", {
      url: captureMeta?.url || null,
      stored: Boolean(result?.stored),
      reason: result?.reason || null,
      assistantPreview: assistantText.slice(0, 160),
    });
  } catch (error) {
    log("completion capture failed", {
      url: captureMeta?.url || null,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function pollAssistantMessageFromDom(conversationId, attempt = 0) {
  const captureMeta = pendingCompletionByConversation.get(conversationId);
  if (!captureMeta) {
    activeCompletionCapturePolls.delete(conversationId);
    return;
  }

  const target = getClaudeTargetWebContents();
  if (!target || target.isDestroyed()) {
    if (attempt >= 20) {
      activeCompletionCapturePolls.delete(conversationId);
      return;
    }
    setTimeout(() => {
      void pollAssistantMessageFromDom(conversationId, attempt + 1);
    }, 1500);
    return;
  }

  try {
    const result = await readLastAssistantMessageViaWebContents();
    const assistantText = typeof result?.text === "string" ? result.text.trim() : "";
    if (
      result?.ok &&
      result?.inferredRole === "assistant" &&
      assistantText &&
      assistantText !== captureMeta.query &&
      !assistantText.includes("<relevant-memories>")
    ) {
      const { captureMessages } = await getRuntime();
      const captureResult = await captureMessages({
        texts: [captureMeta.query, assistantText],
        sessionKey: `claude-desktop:${conversationId}`,
        agentId: "claude-desktop",
      });
      log("completion captured", {
        url: captureMeta.url,
        stored: Boolean(captureResult?.stored),
        reason: captureResult?.reason || null,
        via: "dom-poll",
        assistantPreview: assistantText.slice(0, 160),
      });
      pendingCompletionByConversation.delete(conversationId);
      activeCompletionCapturePolls.delete(conversationId);
      return;
    }
  } catch (error) {
    log("completion dom poll failed", {
      conversationId,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  if (attempt >= 20) {
    log("completion capture skipped", {
      url: captureMeta.url,
      reason: "assistant-dom-timeout",
      via: "dom-poll",
    });
    pendingCompletionByConversation.delete(conversationId);
    activeCompletionCapturePolls.delete(conversationId);
    return;
  }

  setTimeout(() => {
    void pollAssistantMessageFromDom(conversationId, attempt + 1);
  }, 1500);
}

function scheduleCompletionDomCapture(details) {
  const conversationId = extractConversationId(details?.url);
  if (!conversationId) return;
  if (!pendingCompletionByConversation.has(conversationId)) return;
  if (activeCompletionCapturePolls.has(conversationId)) return;
  activeCompletionCapturePolls.add(conversationId);
  setTimeout(() => {
    void pollAssistantMessageFromDom(conversationId, 0);
  }, 1500);
}

async function logDebuggerRequest(contents, params) {
  const request = params?.request;
  if (!shouldLogDebuggerRequest(request)) return;

  let postData = typeof request?.postData === "string" ? request.postData : null;
  if (!postData && params?.requestId) {
    try {
      const result = await contents.debugger.sendCommand("Network.getRequestPostData", {
        requestId: params.requestId,
      });
      if (typeof result?.postData === "string") {
        postData = result.postData;
      }
    } catch {}
  }

  log("debugger request", {
    method: request.method,
    url: request.url,
    hasPostData: Boolean(postData),
    postDataPreview: typeof postData === "string" ? postData.slice(0, 500) : null,
  });
}

function attachDebuggerObserver(contents) {
  if (!contents || contents.isDestroyed() || observedDebuggerContents.has(contents)) return;
  if (!contents.debugger) return;

  try {
    if (!contents.debugger.isAttached()) {
      contents.debugger.attach("1.3");
    }
    contents.debugger.on("message", (_event, method, params) => {
      if (method === "Network.requestWillBeSent") {
        void logDebuggerRequest(contents, params);
        return;
      }
      if (method === "Network.loadingFinished") {
        void handleCompletionLoadingFinished(contents, params);
        return;
      }
      if (method === "Fetch.requestPaused") {
        void handlePausedCompletionRequest(contents, params);
      }
    });
    void contents.debugger.sendCommand("Network.enable");
    void contents.debugger.sendCommand("Fetch.enable", {
      patterns: [
        {
          urlPattern: "https://claude.ai/api/organizations/*/chat_conversations/*/completion*",
          requestStage: "Request",
        },
        {
          urlPattern: "https://*.claude.ai/api/organizations/*/chat_conversations/*/completion*",
          requestStage: "Request",
        },
        {
          urlPattern: "https://claude.com/api/organizations/*/chat_conversations/*/completion*",
          requestStage: "Request",
        },
        {
          urlPattern: "https://*.claude.com/api/organizations/*/chat_conversations/*/completion*",
          requestStage: "Request",
        },
        {
          urlPattern: "https://claude.ai/api/organizations/*/chat_conversations/*/completion*",
          requestStage: "Response",
        },
        {
          urlPattern: "https://*.claude.ai/api/organizations/*/chat_conversations/*/completion*",
          requestStage: "Response",
        },
        {
          urlPattern: "https://claude.com/api/organizations/*/chat_conversations/*/completion*",
          requestStage: "Response",
        },
        {
          urlPattern: "https://*.claude.com/api/organizations/*/chat_conversations/*/completion*",
          requestStage: "Response",
        },
      ],
    });
    observedDebuggerContents.add(contents);
    log("attached debugger observer", {
      url: typeof contents.getURL === "function" ? contents.getURL() : null,
    });
  } catch (error) {
    log("failed to attach debugger observer", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function installNetworkObservers(targetSession) {
  if (!targetSession || observedNetworkSessions.has(targetSession)) return;
  if (!targetSession.webRequest) return;

  const filter = {
    urls: [
      "https://claude.ai/*",
      "https://*.claude.ai/*",
      "https://claude.com/*",
      "https://*.claude.com/*",
      "https://anthropic.com/*",
      "https://*.anthropic.com/*",
    ],
  };

  targetSession.webRequest.onBeforeRequest(filter, (details, callback) => {
    try {
      if (shouldLogNetworkRequest(details)) {
        log("network request", {
          method: details.method,
          url: details.url,
          resourceType: details.resourceType || null,
          uploadPreview: readUploadPreview(details),
        });
      }
    } catch (error) {
      log("network request logging failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    callback({});
  });

  targetSession.webRequest.onCompleted(filter, (details) => {
    try {
      if (shouldLogNetworkRequest(details)) {
        log("network response", {
          method: details.method,
          url: details.url,
          statusCode: details.statusCode ?? null,
          fromCache: Boolean(details.fromCache),
        });
        if (
          details.statusCode === 200 &&
          details.method === "POST" &&
          isCompletionRequestUrl(details.url)
        ) {
          scheduleCompletionDomCapture(details);
        }
      }
    } catch (error) {
      log("network response logging failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  observedNetworkSessions.add(targetSession);
  log("registered network observers");
}

function getClaudeTargetWebContents() {
  const candidates = webContents.getAllWebContents().filter((contents) => {
    if (!contents || contents.isDestroyed()) return false;
    if (typeof contents.getURL !== "function") return false;
    try {
      const url = new URL(contents.getURL());
      if (ALLOWED_HOSTS.has(url.hostname)) return true;
      return url.hostname.endsWith(".ant.dev");
    } catch {
      return false;
    }
  });

  candidates.sort((left, right) => {
    const leftFocused = typeof left.isFocused === "function" && left.isFocused() ? 1 : 0;
    const rightFocused = typeof right.isFocused === "function" && right.isFocused() ? 1 : 0;
    return rightFocused - leftFocused;
  });

  return candidates[0] || null;
}

async function prepareNativeSendTarget(target, composerMarker) {
  if (!target || target.isDestroyed()) {
    return { ok: false, reason: "no-target-webcontents" };
  }

  const script = `
    ((preferredComposerMarker) => {
      const normalizeText = (value) =>
        typeof value === "string" ? value.replace(/\\s+/g, " ").trim() : "";
      const isVisibleElement = (element) => {
        if (!element || typeof element !== "object") return false;
        if (typeof element.getBoundingClientRect !== "function") return false;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = typeof window.getComputedStyle === "function"
          ? window.getComputedStyle(element)
          : null;
        return !style || (style.display !== "none" && style.visibility !== "hidden");
      };
      const isComposerElement = (element) => {
        if (!element || typeof element !== "object") return false;
        if (element instanceof HTMLTextAreaElement) return true;
        if (element instanceof HTMLInputElement) return true;
        if (element.isContentEditable) return true;
        const role = typeof element.getAttribute === "function" ? element.getAttribute("role") : null;
        return role === "textbox";
      };
      const setNativeValue = (element, value) => {
        const prototype = Object.getPrototypeOf(element);
        const descriptor = prototype ? Object.getOwnPropertyDescriptor(prototype, "value") : null;
        if (descriptor && typeof descriptor.set === "function") {
          descriptor.set.call(element, value);
          return;
        }
        element.value = value;
      };
      const clearComposer = (element) => {
        if (!element) return;
        if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
          setNativeValue(element, "");
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
          element.focus?.();
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
            document.execCommand("delete", false);
          }
        } catch {}
        element.textContent = "";
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      };
      const looksLikeSendButton = (element) => {
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
        if (/\\b(record|voice|audio|microphone|mic|press and hold to record|hold to record)\\b/i.test(combined)) {
          return false;
        }
        if (/(录音|语音|麦克风|麥克風)/i.test(combined)) {
          return false;
        }
        if (/\\b(send|发送|送出|提交|submit)\\b/i.test(combined) || /send/i.test(testId)) {
          return true;
        }
        return element instanceof HTMLButtonElement && element.type === "submit" && combined.length > 0;
      };
      const findComposer = () => {
        if (preferredComposerMarker) {
          const marked = document.querySelector(
            \`[data-memory-bridge-composer="\${preferredComposerMarker}"]\`
          );
          if (marked && isComposerElement(marked) && isVisibleElement(marked)) {
            return marked;
          }
        }
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
          const candidates = Array.from(document.querySelectorAll(selector)).filter(isVisibleElement);
          if (candidates.length === 0) continue;
          return candidates[0];
        }
        return null;
      };
      const findSendButton = (composer) => {
        const form = composer?.closest?.("form");
        if (form) {
          const formButton = Array.from(
            form.querySelectorAll('button[type="submit"], button, [role="button"]')
          ).find((element) => looksLikeSendButton(element));
          if (looksLikeSendButton(formButton)) return formButton;
        }
        const candidates = Array.from(
          document.querySelectorAll(
            'button[type="submit"], button[aria-label], button[title], button[data-testid], [role="button"][aria-label]'
          )
        );
        return candidates.find((element) => looksLikeSendButton(element)) || null;
      };

      const composer = findComposer();
      if (!composer) return { ok: false, reason: "no-composer" };
      clearComposer(composer);
      composer.focus?.();
      const button = findSendButton(composer);
      const rect = button?.getBoundingClientRect?.();
      return {
        ok: true,
        hasButton: Boolean(button && rect),
        composerMarker: preferredComposerMarker || null,
        buttonRect: rect
          ? {
              x: rect.left + rect.width / 2,
              y: rect.top + rect.height / 2,
            }
          : null,
      };
    })(${JSON.stringify(composerMarker || null)})
  `;

  return target.executeJavaScript(script, true);
}

async function sendPreparedMessageViaWebContents(target, text, composerMarker) {
  const normalizedText = typeof text === "string" ? text.trim() : "";
  if (!normalizedText) {
    return { ok: false, reason: "empty-text" };
  }

  const prepared = await prepareNativeSendTarget(target, composerMarker);
  if (!prepared?.ok) {
    return {
      ok: false,
      reason: prepared?.reason || "prepare-failed",
    };
  }

  const previousClipboardText = clipboard.readText();
  try {
    clipboard.writeText(text);
    if (typeof target.paste === "function") {
      target.paste();
    } else {
      await target.insertText(text);
    }
  } finally {
    if (typeof previousClipboardText === "string") {
      clipboard.writeText(previousClipboardText);
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 80));
  target.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
  target.sendInputEvent({ type: "char", keyCode: "\r" });
  target.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
  return {
    ok: true,
    reason: null,
    method: "native-paste-enter",
  };
}

async function sendMessageViaWebContents(text) {
  const normalizedText = typeof text === "string" ? text.trim() : "";
  if (!normalizedText) {
    return { ok: false, reason: "empty-text" };
  }

  const target = getClaudeTargetWebContents();
  if (!target) {
    return { ok: false, reason: "no-target-webcontents" };
  }

  const script = `
    (async (messageText) => {
      const normalizeText = (value) =>
        typeof value === "string" ? value.replace(/\\s+/g, " ").trim() : "";
      const isVisibleElement = (element) => {
        if (!element || typeof element !== "object") return false;
        if (typeof element.getBoundingClientRect !== "function") return false;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = typeof window.getComputedStyle === "function"
          ? window.getComputedStyle(element)
          : null;
        return !style || (style.display !== "none" && style.visibility !== "hidden");
      };
      const isComposerElement = (element) => {
        if (!element || typeof element !== "object") return false;
        if (element instanceof HTMLTextAreaElement) return true;
        if (element instanceof HTMLInputElement) return true;
        if (element.isContentEditable) return true;
        const role = typeof element.getAttribute === "function" ? element.getAttribute("role") : null;
        return role === "textbox";
      };
      const readComposerText = (element) => {
        if (!element) return "";
        if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
          return normalizeText(element.value);
        }
        return normalizeText(element.innerText || element.textContent || "");
      };
      const setNativeValue = (element, value) => {
        const prototype = Object.getPrototypeOf(element);
        const descriptor = prototype ? Object.getOwnPropertyDescriptor(prototype, "value") : null;
        if (descriptor && typeof descriptor.set === "function") {
          descriptor.set.call(element, value);
          return;
        }
        element.value = value;
      };
      const writeComposerText = (element, value) => {
        if (!element) return;
        if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
          setNativeValue(element, value);
        } else {
          element.focus?.();
          element.textContent = value;
        }
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      };
      const looksLikeSendButton = (element) => {
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
        if (/\\b(record|voice|audio|microphone|mic|press and hold to record|hold to record)\\b/i.test(combined)) {
          return false;
        }
        if (/(录音|语音|麦克风|麥克風)/i.test(combined)) {
          return false;
        }
        if (/\\b(send|发送|送出|提交|submit)\\b/i.test(combined) || /send/i.test(testId)) {
          return true;
        }
        return element instanceof HTMLButtonElement && element.type === "submit" && combined.length > 0;
      };
      const findComposer = () => {
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
          const candidates = Array.from(document.querySelectorAll(selector)).filter(isVisibleElement);
          if (candidates.length === 0) continue;
          candidates.sort((left, right) => readComposerText(right).length - readComposerText(left).length);
          return candidates[0];
        }
        return null;
      };
      const findSendButton = (composer) => {
        const form = composer?.closest?.("form");
        if (form) {
          const formButton = Array.from(
            form.querySelectorAll('button[type="submit"], button, [role="button"]')
          ).find((element) => looksLikeSendButton(element));
          if (looksLikeSendButton(formButton)) return formButton;
        }
        const candidates = Array.from(
          document.querySelectorAll(
            'button[type="submit"], button[aria-label], button[title], button[data-testid], [role="button"][aria-label]'
          )
        );
        return candidates.find((element) => looksLikeSendButton(element)) || null;
      };

      const composer = findComposer();
      if (!composer) {
        return { ok: false, reason: "no-composer" };
      }

      writeComposerText(composer, messageText);
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      );
      const sendButton = findSendButton(composer);
      if (sendButton) {
        if (typeof PointerEvent === "function") {
          sendButton.dispatchEvent(
            new PointerEvent("pointerdown", {
              bubbles: true,
              cancelable: true,
              button: 0,
              buttons: 1,
              pointerType: "mouse",
              isPrimary: true,
            }),
          );
        } else {
          sendButton.dispatchEvent(
            new MouseEvent("mousedown", {
              bubbles: true,
              cancelable: true,
              button: 0,
              buttons: 1,
            }),
          );
        }
        return {
          ok: true,
          method: "pointerdown",
          textPreview: normalizeText(messageText).slice(0, 120),
        };
      }

      composer.dispatchEvent(
        new KeyboardEvent("keydown", {
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
      return {
        ok: true,
        method: "keydown",
        textPreview: normalizeText(messageText).slice(0, 120),
      };
    })(${JSON.stringify(normalizedText)});
  `;

  const result = await target.executeJavaScript(script, true);
  return {
    ok: Boolean(result?.ok),
    reason: result?.reason || null,
    method: result?.method || null,
    textPreview: result?.textPreview || normalizedText.slice(0, 120),
    url: target.getURL(),
  };
}

async function navigateNewChatViaWebContents() {
  const target = getClaudeTargetWebContents();
  if (!target) {
    return { ok: false, reason: "no-target-webcontents" };
  }

  const result = await target.executeJavaScript(
    `(() => {
      window.location.href = "https://claude.ai/new";
      return { ok: true, url: window.location.href };
    })()`,
    true,
  );

  return {
    ok: Boolean(result?.ok),
    reason: result?.reason || null,
    url: target.getURL(),
  };
}

async function readLastAssistantMessageViaWebContents() {
  const target = getClaudeTargetWebContents();
  if (!target) {
    return { ok: false, reason: "no-target-webcontents" };
  }

  const result = await target.executeJavaScript(
    `(() => {
      const normalizeText = (value) =>
        typeof value === "string" ? value.replace(/\\s+/g, " ").trim() : "";
      const isVisibleElement = (element) => {
        if (!element || typeof element !== "object") return false;
        if (typeof element.getBoundingClientRect !== "function") return false;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = typeof window.getComputedStyle === "function"
          ? window.getComputedStyle(element)
          : null;
        return !style || (style.display !== "none" && style.visibility !== "hidden");
      };
      const inferMessageRole = (node, text) => {
        const authorNode = node.closest?.('[data-message-author-role]') || node;
        const author = normalizeText(authorNode?.getAttribute?.('data-message-author-role') || '');
        if (author === 'assistant') return 'assistant';
        if (author === 'user') return 'user';
        const testId = normalizeText(
          node.getAttribute?.('data-testid') ||
          authorNode?.getAttribute?.('data-testid') ||
          ''
        );
        if (/assistant/.test(testId)) return 'assistant';
        if (/user-message|human-message|user/.test(testId)) return 'user';
        const role = normalizeText(node.getAttribute?.('role') || '');
        const ariaLive = normalizeText(node.getAttribute?.('aria-live') || '');
        if (role === 'status' || ariaLive) return 'status';
        if (/^thinking(?:\\s+thinking)?$/i.test(text) || /^thought for /i.test(text)) return 'status';
        return 'unknown';
      };
      const selectors = [
        '[data-message-author-role="assistant"]',
        '[data-testid*="assistant"]',
        '[data-testid*="message"]',
        'article',
        'main section',
      ];
      const seen = new Set();
      const candidates = [];
      for (const selector of selectors) {
        const nodes = Array.from(document.querySelectorAll(selector)).slice(-30);
        for (const node of nodes) {
          if (!isVisibleElement(node)) continue;
          const text = normalizeText(node.innerText || node.textContent || "");
          if (!text || text.length < 8) continue;
          if (text.includes('<relevant-memories>')) continue;
          const inferredRole = inferMessageRole(node, text);
          if (inferredRole !== 'assistant') continue;
          const key = selector + ':' + text.slice(0, 120);
          if (seen.has(key)) continue;
          seen.add(key);
          candidates.push({ selector, text, inferredRole });
        }
      }
      const last = candidates[candidates.length - 1] || null;
      return {
        ok: Boolean(last),
        selector: last ? last.selector : null,
        text: last ? last.text : null,
        inferredRole: last ? last.inferredRole : null,
      };
    })()`,
    true,
  );

  return {
    ok: Boolean(result?.ok),
    reason: result?.ok ? null : "no-assistant-message",
    selector: result?.selector || null,
    text: result?.text || null,
    inferredRole: result?.inferredRole || null,
    url: target.getURL(),
  };
}

async function inspectMessagesViaWebContents() {
  const target = getClaudeTargetWebContents();
  if (!target) {
    return { ok: false, reason: "no-target-webcontents" };
  }

  const result = await target.executeJavaScript(
    `(() => {
      const normalizeText = (value) =>
        typeof value === "string" ? value.replace(/\\s+/g, " ").trim() : "";
      const isVisibleElement = (element) => {
        if (!element || typeof element !== "object") return false;
        if (typeof element.getBoundingClientRect !== "function") return false;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = typeof window.getComputedStyle === "function"
          ? window.getComputedStyle(element)
          : null;
        return !style || (style.display !== "none" && style.visibility !== "hidden");
      };
      const inferMessageRole = (node, text) => {
        const authorNode = node.closest?.('[data-message-author-role]') || node;
        const author = normalizeText(authorNode?.getAttribute?.('data-message-author-role') || '');
        if (author === 'assistant') return 'assistant';
        if (author === 'user') return 'user';
        const testId = normalizeText(
          node.getAttribute?.('data-testid') ||
          authorNode?.getAttribute?.('data-testid') ||
          ''
        );
        if (/assistant/.test(testId)) return 'assistant';
        if (/user-message|human-message|user/.test(testId)) return 'user';
        const role = normalizeText(node.getAttribute?.('role') || '');
        const ariaLive = normalizeText(node.getAttribute?.('aria-live') || '');
        if (role === 'status' || ariaLive) return 'status';
        if (/^thinking(?:\\s+thinking)?$/i.test(text) || /^thought for /i.test(text)) return 'status';
        return 'unknown';
      };
      const selectors = [
        '[data-message-author-role]',
        '[data-testid*="message"]',
        '[role="alert"]',
        '[aria-live="polite"]',
        '[aria-live="assertive"]',
        'article',
        'main section',
      ];
      const entries = [];
      const seen = new Set();
      for (const selector of selectors) {
        const nodes = Array.from(document.querySelectorAll(selector)).slice(-20);
        for (const node of nodes) {
          if (!isVisibleElement(node)) continue;
          const text = normalizeText(node.innerText || node.textContent || "");
          if (!text) continue;
          const authorNode = node.closest?.('[data-message-author-role]') || node;
          const author = authorNode?.getAttribute?.('data-message-author-role') || null;
          const testId = node.getAttribute?.('data-testid') || null;
          const role = node.getAttribute?.('role') || null;
          const inferredAuthor = inferMessageRole(node, text);
          const key = [selector, author, testId, text.slice(0, 200)].join('::');
          if (seen.has(key)) continue;
          seen.add(key);
          entries.push({
            selector,
            author,
            inferredAuthor,
            testId,
            role,
            tag: node.tagName,
            text,
          });
        }
      }
      const sendButton = Array.from(document.querySelectorAll('button, [role="button"]')).find((node) => {
        if (!isVisibleElement(node)) return false;
        const aria = normalizeText(node.getAttribute?.('aria-label') || '');
        const title = normalizeText(node.getAttribute?.('title') || '');
        const testId = normalizeText(node.getAttribute?.('data-testid') || '');
        const text = normalizeText(node.innerText || node.textContent || '');
        const combined = [aria, title, testId, text].filter(Boolean).join(' ');
        return /\\b(send|发送|送出|提交|submit)\\b/i.test(combined) || /send/i.test(testId);
      }) || null;
      const composerSelectors = [
        'textarea',
        '[contenteditable="true"]',
        '[contenteditable="plaintext-only"]',
        '[role="textbox"]',
        "input[type='text']",
      ];
      const composerNodes = [];
      for (const selector of composerSelectors) {
        composerNodes.push(...Array.from(document.querySelectorAll(selector)));
      }
      const composerSeen = new Set();
      const composers = [];
      for (const node of composerNodes) {
        if (!isVisibleElement(node)) continue;
        const marker = node.getAttribute?.('data-memory-bridge-composer') || null;
        const text = normalizeText(node.innerText || node.textContent || node.value || '');
        const key = [node.tagName, marker, text.slice(0, 200)].join('::');
        if (composerSeen.has(key)) continue;
        composerSeen.add(key);
        composers.push({
          tag: node.tagName,
          role: node.getAttribute?.('role') || null,
          marker,
          isActive: document.activeElement === node,
          text,
        });
      }
      return {
        ok: true,
        url: window.location.href,
        sendButton: sendButton
          ? {
              aria: sendButton.getAttribute?.('aria-label') || null,
              title: sendButton.getAttribute?.('title') || null,
              disabled: Boolean(sendButton.disabled),
              text: normalizeText(sendButton.innerText || sendButton.textContent || ''),
            }
          : null,
        composers,
        messages: entries.slice(-12),
      };
    })()`,
    true,
  );

  return {
    ok: Boolean(result?.ok),
    reason: result?.ok ? null : "inspect-failed",
    url: result?.url || target.getURL(),
    sendButton: result?.sendButton || null,
    composers: Array.isArray(result?.composers) ? result.composers : [],
    messages: Array.isArray(result?.messages) ? result.messages : [],
  };
}

function startControlServer() {
  if (controlServer) return;
  controlServer = net.createServer((socket) => {
    let buffer = "";
    let handled = false;
    socket.setEncoding("utf8");
    const handlePayload = (raw) => {
      if (handled) return;
      handled = true;
      void (async () => {
        let payload = null;
        try {
          payload = JSON.parse(raw || "{}");
        } catch (error) {
          socket.end(JSON.stringify({ ok: false, reason: "invalid-json", message: error.message }));
          return;
        }

        try {
          let result = null;
          if (payload?.action === "send") {
            result = await sendMessageViaWebContents(payload.text);
            log("control send executed", result);
          } else if (payload?.action === "new-chat") {
            result = await navigateNewChatViaWebContents();
            log("control new-chat executed", result);
          } else if (payload?.action === "read-last-assistant") {
            result = await readLastAssistantMessageViaWebContents();
            log("control read-last-assistant executed", {
              ok: result?.ok,
              selector: result?.selector || null,
              textPreview: typeof result?.text === "string" ? result.text.slice(0, 120) : null,
            });
          } else if (payload?.action === "inspect-messages") {
            result = await inspectMessagesViaWebContents();
            log("control inspect-messages executed", {
              ok: result?.ok,
              count: Array.isArray(result?.messages) ? result.messages.length : 0,
              url: result?.url || null,
            });
          } else {
            socket.end(JSON.stringify({ ok: false, reason: "unsupported-action" }));
            return;
          }
          socket.end(JSON.stringify(result));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log("control command failed", { message });
          socket.end(JSON.stringify({ ok: false, reason: "exception", message }));
        }
      })();
    };

    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex >= 0) {
        handlePayload(buffer.slice(0, newlineIndex));
      }
    });
    socket.on("end", () => {
      handlePayload(buffer);
    });
    socket.on("error", (error) => {
      log("control socket client error", { message: error.message });
    });
  });

  controlServer.on("error", (error) => {
    log("control server error", { message: error.message });
  });

  controlServer.listen(CONTROL_PORT, CONTROL_HOST, () => {
    log("control server listening", { host: CONTROL_HOST, port: CONTROL_PORT });
  });

  app.once("before-quit", () => {
    try {
      controlServer?.close();
    } catch {}
  });
}

function registerIpcHandlers() {
  if (handlersRegistered) return;

  ipcMain.handle(`${CHANNEL_PREFIX}:log`, async (_event, payload = {}) => {
    log(payload.message || "renderer-log", payload.data || null);
    return { ok: true };
  });

  ipcMain.handle(`${CHANNEL_PREFIX}:recall`, async (_event, payload = {}) => {
    const request = {
      query: payload.query,
      agentId: payload.agentId || "claude-desktop",
      limit: payload.limit || 3,
      allowAdaptiveSkip: payload.allowAdaptiveSkip !== false,
    };
    log("ipc recall start", {
      agentId: request.agentId,
      limit: request.limit,
      queryPreview: typeof request.query === "string" ? request.query.slice(0, 120) : null,
    });
    const { recallMemories } = await getRuntime();
    const result = await recallMemories(request);
    log("ipc recall done", {
      agentId: request.agentId,
      reason: result?.reason || null,
      skipped: Boolean(result?.skipped),
      count: Array.isArray(result?.results) ? result.results.length : 0,
      hasText: Boolean(result?.text),
    });
    return {
      ok: Boolean(result?.ok),
      skipped: Boolean(result?.skipped),
      reason: result?.reason || null,
      text: typeof result?.text === "string" ? result.text : null,
    };
  });

  ipcMain.handle(`${CHANNEL_PREFIX}:prepare-send`, async (event, payload = {}) => {
    const query = typeof payload.query === "string" ? payload.query.trim() : "";
    const agentId = payload.agentId || "claude-desktop";
    const sessionKey = payload.sessionKey || "unknown";
    const limit = Math.max(1, Math.min(10, Math.floor(payload.limit) || 5));

    if (!query) {
      return { ok: false, reason: "empty", explicitStored: false, recallUsed: false };
    }

    log("ipc prepare-send start", {
      agentId,
      sessionKey,
      limit,
      composerMarker: payload.composerMarker || null,
      queryPreview: query.slice(0, 120),
    });

    const { recallMemories, storeExplicitMemory } = await getRuntime();
    const explicitResult = await storeExplicitMemory({
      text: query,
      agentId,
      scope: "agent:claude-desktop",
      importance: 0.95,
    });
    const recallResult = query.includes("<relevant-memories>")
      ? { ok: true, skipped: true, reason: "already-has-recall", text: null }
      : await recallMemories({
          query,
          agentId,
          limit,
          allowAdaptiveSkip: true,
        });

    const finalText =
      typeof recallResult?.text === "string" && recallResult.text.trim()
        ? `${recallResult.text}\n\n${query}`
        : query;

    log("ipc prepare-send done", {
      agentId,
      sessionKey,
      explicitStored: Boolean(explicitResult?.stored),
      explicitReason: explicitResult?.reason || null,
      recallUsed: Boolean(recallResult?.text),
      recallReason: recallResult?.reason || null,
      composerMarker: payload.composerMarker || null,
      finalPreview: finalText.slice(0, 120),
    });

    return {
      ok: true,
      reason: "prepared",
      explicitStored: Boolean(explicitResult?.stored),
      recallUsed: Boolean(recallResult?.text),
      recallReason: recallResult?.reason || null,
      recallText: typeof recallResult?.text === "string" ? recallResult.text : null,
    };
  });

  ipcMain.handle(`${CHANNEL_PREFIX}:capture`, async (_event, payload = {}) => {
    const { captureMessages } = await getRuntime();
    return captureMessages({
      texts: Array.isArray(payload.texts) ? payload.texts : [],
      sessionKey: payload.sessionKey || "claude-desktop:unknown",
      agentId: payload.agentId || "claude-desktop",
      scope: payload.scope,
    });
  });

  ipcMain.handle(`${CHANNEL_PREFIX}:store-explicit`, async (_event, payload = {}) => {
    const { storeExplicitMemory } = await getRuntime();
    return storeExplicitMemory({
      text: payload.text,
      agentId: payload.agentId || "claude-desktop",
      scope: payload.scope,
      importance: payload.importance,
    });
  });

  handlersRegistered = true;
  log("registered ipc handlers");
}

function installOnSession(targetSession) {
  if (!targetSession || installedSessions.has(targetSession)) return;

  try {
    installNetworkObservers(targetSession);
    if (typeof targetSession.registerPreloadScript === "function") {
      targetSession.registerPreloadScript({
        type: "frame",
        filePath: preloadPath,
      });
    } else if (typeof targetSession.getPreloads === "function" && typeof targetSession.setPreloads === "function") {
      const existing = targetSession.getPreloads();
      if (!existing.includes(preloadPath)) {
        targetSession.setPreloads([preloadPath, ...existing]);
      }
    } else {
      log("session does not support preload registration");
      return;
    }

    installedSessions.add(targetSession);
    log(`registered preload: ${preloadPath}`);
  } catch (error) {
    log("failed to register preload", error);
  }
}

function installForApp() {
  registerIpcHandlers();
  startControlServer();
  try {
    installOnSession(session.defaultSession);
  } catch (error) {
    log("failed to install on default session", error);
  }

  app.on("web-contents-created", (_event, contents) => {
    try {
      installOnSession(contents?.session);
      attachDebuggerObserver(contents);
    } catch (error) {
      log("failed to install on webContents session", error);
    }
  });
}

if (app.isReady()) {
  installForApp();
} else {
  app.once("ready", installForApp);
}
}
