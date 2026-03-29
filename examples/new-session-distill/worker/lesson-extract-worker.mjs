#!/usr/bin/env node

/**
 * lesson-extract-worker (example)
 *
 * Watches a repo-backed inbox for lesson extraction tasks and processes them asynchronously:
 * - reads session JSONL transcript (streaming)
 * - Map: per-chunk extraction via Gemini (native API)
 * - Reduce: merge/dedupe/score -> 0..20 lessons
 * - writes to LanceDB Pro via `openclaw memory-pro import`
 * - sends Telegram notification via `openclaw message send` (optional)
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFile as execFileCallback } from "node:child_process";
import readline from "node:readline";
import { promisify } from "node:util";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execFile = promisify(execFileCallback);

// In your deployment, set LESSON_QUEUE_ROOT to your workspace queue.
// By default we assume repo layout similar to OpenClaw-Memory.
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const QUEUE_ROOT = process.env.LESSON_QUEUE_ROOT || path.join(REPO_ROOT, "workspaces", "main", "tasks", "lesson-extract");

const INBOX = path.join(QUEUE_ROOT, "inbox");
const PROCESSING = path.join(QUEUE_ROOT, "processing");
const DONE = path.join(QUEUE_ROOT, "done");
const ERROR = path.join(QUEUE_ROOT, "error");

const DISTILL_API = process.env.DISTILL_API || "gemini-native";
const DISTILL_MODEL = process.env.DISTILL_MODEL || process.env.GEMINI_MODEL || "gemini-3-flash-preview";
const DISTILL_BASE_URL = process.env.DISTILL_BASE_URL || "";
const DISTILL_ANTHROPIC_VERSION = process.env.DISTILL_ANTHROPIC_VERSION || "2023-06-01";

const ONCE = process.argv.includes("--once");

function ensureDirs() {
  for (const d of [INBOX, PROCESSING, DONE, ERROR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

function nowIso() {
  return new Date().toISOString();
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString("utf-8")));
    child.stderr.on("data", (d) => (err += d.toString("utf-8")));
    child.on("close", (code) => resolve({ code: code ?? 0, out, err }));
  });
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function resolveEnvVars(value) {
  return String(value).replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

// NOTE: This duplicates the logic in src/secret-resolver.ts (parseBitwardenSecretRef +
// resolveBitwardenSecret). This worker is a standalone ESM script that cannot import
// the compiled TypeScript, so the logic lives here as well.
// IMPORTANT: If you update either copy, keep the other in sync.
async function resolveMaybeBitwardenSecret(value) {
  const resolved = resolveEnvVars(String(value || "").trim());
  if (!resolved) return "";
  if (!resolved.startsWith("bws://")) return resolved;

  const parsed = new URL(resolved);
  const secretId = `${parsed.hostname}${parsed.pathname}`.replace(/^\/+/, "").replace(/^secret\//i, "");
  if (!secretId) throw new Error(`Invalid Bitwarden secret reference: ${resolved}`);

  const args = ["secret", "get", secretId, "--output", "json"];
  const accessToken = parsed.searchParams.get("accessToken");
  const configFile = parsed.searchParams.get("configFile");
  const profile = parsed.searchParams.get("profile");
  const serverUrl = parsed.searchParams.get("serverUrl");
  if (accessToken) args.push("--access-token", resolveEnvVars(accessToken));
  if (configFile) args.push("--config-file", resolveEnvVars(configFile));
  if (profile) args.push("--profile", resolveEnvVars(profile));
  if (serverUrl) args.push("--server-url", resolveEnvVars(serverUrl));

  const { stdout } = await execFile("bws", args, { timeout: 10_000 });
  const payload = JSON.parse(stdout);
  if (typeof payload?.value !== "string" || !payload.value.trim()) {
    throw new Error(`Bitwarden secret ${secretId} has no value`);
  }
  return payload.value;
}

async function resolveDistillApiKey() {
  const raw = process.env.DISTILL_API_KEY || process.env.GEMINI_API_KEY || "";
  if (!raw.trim()) {
    if (DISTILL_API === "gemini-native") {
      throw new Error("DISTILL_API_KEY or GEMINI_API_KEY is not set");
    }
    throw new Error("DISTILL_API_KEY is not set");
  }
  return resolveMaybeBitwardenSecret(raw);
}

function normalizeText(s) {
  return (s || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .toLowerCase();
}

function detectLang(text) {
  const s = text || "";
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (s.match(/[A-Za-z]/g) || []).length;
  if (cjk > latin * 0.8) return "zh";
  if (latin > cjk * 0.8) return "en";
  return "mixed";
}

async function* iterJsonlMessages(sessionFile) {
  const stream = fs.createReadStream(sessionFile, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let id = 0;
  for await (const line of rl) {
    if (!line) continue;
    const obj = safeJsonParse(line);
    if (!obj || obj.type !== "message") continue;
    const m = obj.message;
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;

    let text = "";
    if (typeof m.content === "string") {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      text = m.content
        .filter((c) => c && c.type === "text" && c.text)
        .map((c) => c.text)
        .join("\n");
    }
    text = (text || "").trim();
    if (!text) continue;

    id++;
    yield {
      id,
      role: m.role,
      timestamp: obj.timestamp || "",
      text,
    };
  }
}

async function buildChunksFromJsonl(sessionFile, { maxChars = 12000, overlapMsgs = 10, maxChunks = 200 } = {}) {
  const chunks = [];
  let chunk = [];
  let size = 0;

  const sampleTexts = [];

  for await (const m of iterJsonlMessages(sessionFile)) {
    if (sampleTexts.length < 200) sampleTexts.push(m.text);

    const line = `[${m.role === "user" ? "U" : "A"}${m.id}] ${m.text}\n`;

    if (size + line.length > maxChars && chunk.length > 0) {
      chunks.push(chunk);
      if (chunks.length >= maxChunks) break;

      chunk = chunk.slice(Math.max(0, chunk.length - overlapMsgs));
      size = chunk.reduce((acc, mm) => acc + (`[${mm.role === "user" ? "U" : "A"}${mm.id}] ${mm.text}\n`).length, 0);
    }

    chunk.push(m);
    size += line.length;
  }

  if (chunk.length > 0 && chunks.length < maxChunks) chunks.push(chunk);

  const lang = detectLang(sampleTexts.join("\n"));
  const messageCount = chunk.length === 0 && chunks.length === 0 ? 0 : chunks[chunks.length - 1][chunks[chunks.length - 1].length - 1].id;

  return { chunks, lang, messageCount };
}

function buildMapPrompt({ lang, chunk }) {
  const langInstr = lang === "zh" ? "请用中文输出 lessons。" : lang === "en" ? "Output lessons in English." : "Follow the dominant language of the transcript.";

  return `You are extracting high-signal technical lessons from a chat transcript chunk.\n\nRules:\n- Output STRICT JSON only. No markdown, no backticks.\n- If nothing valuable, output: {\"lessons\":[]}\n- Max 8 lessons.\n- Each lesson.text must be <= 480 characters.\n- Categories: fact | decision | preference | other (use fact/decision primarily).\n- importance: number 0..1 (high-signal: 0.8-0.95).\n- evidence MUST quote exact short snippets from the chunk and include message_ids.\n- Do NOT include secrets/tokens/credentials.\n- Add Keywords (zh) inside each lesson:\n  - Include >=1 Entity keyword that appears verbatim in the chunk (project/library/tool/service/config key/error code).\n  - Include >=1 Action keyword (e.g., 修复/回滚/重启/迁移/去重/限流).\n  - Include >=1 Symptom keyword (e.g., OOM/超时/429/重复/命中率差).\n  - Do NOT invent entity names; copy entity keywords from the chunk.\n\n${langInstr}\n\nChunk:\n${chunk.map((m) => `[${m.role === "user" ? "U" : "A"}${m.id}] ${m.text}`).join("\n\n")}\n\nReturn JSON schema:\n{\n  \"lessons\": [\n    {\n      \"category\": \"fact\",\n      \"importance\": 0.8,\n      \"text\": \"Pitfall: ... Cause: ... Fix: ... Prevention: ...\",\n      \"evidence\": [\n        {\"message_ids\":[12,13],\"quote\":\"...\"}\n      ],\n      \"tags\": [\"optional\"]\n    }\n  ]\n}`;
}

async function geminiGenerateJson(prompt) {
  const apiKey = await resolveDistillApiKey();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${DISTILL_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 4096,
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Gemini error ${res.status}: ${JSON.stringify(json).slice(0, 500)}`);
  }

  const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  return text;
}

function normalizeAnthropicEndpoint(baseURL) {
  const trimmed = String(baseURL || "").trim();
  if (!trimmed) return "https://api.anthropic.com/v1/messages";
  if (/\/messages\/?$/i.test(trimmed)) return trimmed;
  return `${trimmed.replace(/\/+$/, "")}/messages`;
}

// TODO: This builds Anthropic requests independently from createAnthropicApiKeyClient
// in src/llm-client.ts. The two implementations may diverge over time (e.g. retry
// logic, model defaults, streaming). Consider unifying into a shared module.
async function anthropicGenerateJson(prompt) {
  const apiKey = await resolveDistillApiKey();
  const res = await fetch(normalizeAnthropicEndpoint(DISTILL_BASE_URL), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "x-api-key": apiKey,
      "anthropic-version": DISTILL_ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: DISTILL_MODEL,
      system: "You extract high-signal technical lessons. Return valid JSON only.",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 4096,
      temperature: 0.2,
    }),
  });

  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Anthropic error ${res.status}: ${JSON.stringify(json).slice(0, 500)}`);
  }

  const text = Array.isArray(json?.content)
    ? json.content
      .filter((part) => part && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("")
    : "";
  return text;
}

async function generateJson(prompt) {
  if (DISTILL_API === "anthropic-messages") {
    return anthropicGenerateJson(prompt);
  }
  return geminiGenerateJson(prompt);
}

function coerceLessons(obj) {
  const lessons = Array.isArray(obj?.lessons) ? obj.lessons : [];
  return lessons
    .filter((l) => l && typeof l.text === "string" && l.text.trim().length >= 10)
    .map((l) => ({
      category: ["fact", "decision", "preference", "other"].includes(l.category) ? l.category : "other",
      importance: typeof l.importance === "number" ? l.importance : 0.7,
      text: l.text.trim().slice(0, 480),
      evidence: Array.isArray(l.evidence) ? l.evidence : [],
      tags: Array.isArray(l.tags) ? l.tags : [],
    }));
}

function scoreLesson(l) {
  let s = 0;
  const t = l.text || "";
  if (/pitfall\s*:|cause\s*:|fix\s*:|prevention\s*:/i.test(t)) s += 2;
  if (/decision principle|trigger\s*:|action\s*:/i.test(t)) s += 2;
  if (/\b(openclaw|docker|systemd|ssh|git|api|json|yaml|config)\b/i.test(t)) s += 1;
  if (t.length < 120) s += 0.5;
  if (l.evidence?.length >= 1) s += 1;
  if (l.evidence?.length >= 2) s += 0.5;
  const imp = Math.max(0, Math.min(1, l.importance ?? 0.7));
  s += imp;
  return s;
}

function reduceLessons(allLessons, maxFinal = 20) {
  const seen = new Set();
  const merged = [];

  for (const l of allLessons) {
    const key = normalizeText(l.text);
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(l);
  }

  merged.sort((a, b) => scoreLesson(b) - scoreLesson(a));

  const filtered = merged.filter((l) => {
    if (!l.evidence || l.evidence.length === 0) return false;
    const t = normalizeText(l.text);
    if (t.length < 20) return false;
    if (/(be careful|best practice|should|建议|注意)/.test(t) && !/(cause|fix|prevention|trigger|action|原因|修复|预防|触发)/.test(t)) {
      return false;
    }
    return true;
  });

  return filtered.slice(0, maxFinal);
}

async function importToLanceDb({ lessons, scope }) {
  const importFile = path.join("/tmp", `lesson-import-${Date.now()}.json`);
  const payload = {
    memories: lessons.map((l) => ({
      text: l.text,
      importance: Math.max(0.0, Math.min(1.0, l.importance ?? 0.7)),
      category: l.category,
    })),
  };
  await fsp.writeFile(importFile, JSON.stringify(payload), "utf-8");

  const { code, out, err } = await run("openclaw", ["memory-pro", "import", importFile, "--scope", scope], { cwd: REPO_ROOT });
  await fsp.unlink(importFile).catch(() => {});

  return { code, out, err };
}

async function notifyTelegram(chatId, message) {
  const args = ["message", "send", "--channel", "telegram", "--target", String(chatId), "--message", message];
  await run("openclaw", args, { cwd: REPO_ROOT });
}

async function processTaskFile(taskPath) {
  const started = Date.now();
  const taskRaw = await fsp.readFile(taskPath, "utf-8");
  const task = JSON.parse(taskRaw);

  const baseName = path.basename(taskPath);
  const processingPath = path.join(PROCESSING, baseName);
  await fsp.rename(taskPath, processingPath);

  const result = {
    taskId: task.taskId,
    startedAt: nowIso(),
    finishedAt: null,
    ok: false,
    sessionId: task.session?.sessionId,
    sessionFile: task.session?.sessionFile,
    stats: {},
    error: null,
  };

  try {
    const sessionFile = task.session?.sessionFile;
    if (!sessionFile || !fs.existsSync(sessionFile)) {
      throw new Error(`sessionFile missing or not found: ${sessionFile}`);
    }

    const { chunks, lang, messageCount } = await buildChunksFromJsonl(sessionFile, {
      maxChars: task.extract?.mapChunkChars ?? 12000,
      overlapMsgs: task.extract?.mapOverlapMsgs ?? 10,
      maxChunks: 200,
    });

    const allLessons = [];
    let mapErrors = 0;

    for (let idx = 0; idx < chunks.length; idx++) {
      const prompt = buildMapPrompt({ lang, chunk: chunks[idx] });
      try {
        const text = await generateJson(prompt);
        const obj = safeJsonParse(text);
        if (!obj) {
          mapErrors++;
          continue;
        }
        const lessons = coerceLessons(obj);
        for (const l of lessons) allLessons.push(l);
      } catch {
        mapErrors++;
      }
    }

    const reduced = reduceLessons(allLessons, task.extract?.maxFinal ?? 20);

    const scope = task.scope || "agent:main";
    const importRes = await importToLanceDb({ lessons: reduced, scope });

    const durationMs = Date.now() - started;
    result.ok = importRes.code === 0;
    result.finishedAt = nowIso();
    result.stats = {
      lang,
      messages: messageCount,
      chunks: chunks.length,
      mapCandidates: allLessons.length,
      mapErrors,
      reduced: reduced.length,
      importCode: importRes.code,
      durationMs,
    };

    const notifyChatId = task.notify?.telegramChatId;
    if (notifyChatId) {
      const text = [
        `Lesson Extract ✅ (${task.agentId || "main"})`,
        `taskId: ${task.taskId?.slice(0, 8) || "unknown"}`,
        `sessionId: ${task.session?.sessionId || "unknown"}`,
        `lang: ${lang}`,
        `messages: ${messageCount}, chunks: ${chunks.length}`,
        `candidates: ${allLessons.length}, reduced: ${reduced.length}`,
        `import: code=${importRes.code}`,
        `time: ${(durationMs / 1000).toFixed(1)}s`,
      ].join("\n");
      await notifyTelegram(notifyChatId, text);
    }

    const donePath = path.join(DONE, `${task.taskId}.json`);
    await fsp.writeFile(donePath, JSON.stringify(result, null, 2) + "\n", "utf-8");
    await fsp.unlink(processingPath).catch(() => {});
  } catch (err) {
    result.ok = false;
    result.finishedAt = nowIso();
    result.error = err instanceof Error ? err.message : String(err);

    const durationMs = Date.now() - started;
    result.stats.durationMs = durationMs;

    const notifyChatId = task.notify?.telegramChatId;
    if (notifyChatId) {
      await notifyTelegram(
        notifyChatId,
        `Lesson Extract ❌ (${task.agentId || "main"})\n` +
          `taskId: ${task.taskId?.slice(0, 8) || "unknown"}\n` +
          `error: ${result.error}\n` +
          `time: ${(durationMs / 1000).toFixed(1)}s`
      );
    }

    const errPath = path.join(ERROR, `${task.taskId}.json`);
    await fsp.writeFile(errPath, JSON.stringify(result, null, 2) + "\n", "utf-8");
    await fsp.unlink(processingPath).catch(() => {});
  }
}

async function drainInboxOnce() {
  ensureDirs();
  const files = (await fsp.readdir(INBOX)).filter((f) => f.endsWith(".json")).sort();
  for (const f of files) {
    await processTaskFile(path.join(INBOX, f));
  }
}

async function main() {
  ensureDirs();
  await drainInboxOnce();
  if (ONCE) return;

  const watcher = fs.watch(INBOX, async (_eventType, filename) => {
    if (!filename || !filename.endsWith(".json")) return;
    const full = path.join(INBOX, filename);
    setTimeout(() => {
      processTaskFile(full).catch(() => {});
    }, 150);
  });

  let alive = true;
  const shutdown = () => {
    alive = false;
    watcher.close();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (alive) {
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
