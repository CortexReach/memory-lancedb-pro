#!/usr/bin/env node

import { readFileSync } from "node:fs";

import { captureMessages } from "../../host-runtime.mjs";

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(chunks.join("")));
    process.stdin.on("error", reject);
  });
}

function parseJson(text) {
  if (!text || !text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function extractTextBlocks(value) {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      if (typeof item.text === "string") return item.text;
      if (typeof item.content === "string") return item.content;
      return "";
    })
    .filter(Boolean);
}

function readRecentClaudeTurn(transcriptPath) {
  const result = { user: "", assistant: "" };
  if (typeof transcriptPath !== "string" || !transcriptPath.trim()) return result;

  try {
    const lines = readFileSync(transcriptPath, "utf8")
      .split("\n")
      .filter(Boolean);

    for (let i = lines.length - 1; i >= 0; i -= 1) {
      let entry;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        continue;
      }

      if (!result.assistant && entry?.type === "assistant") {
        const message = entry.message;
        if (typeof message?.content === "string" && message.content.trim()) {
          result.assistant = message.content.trim();
          continue;
        }
        const blocks = extractTextBlocks(message?.content);
        if (blocks.length > 0) {
          result.assistant = blocks.join("\n").trim();
          continue;
        }
      }

      if (!result.user && entry?.type === "user") {
        const message = entry.message;
        if (typeof message?.content === "string" && message.content.trim()) {
          result.user = message.content.trim();
          continue;
        }
        const blocks = extractTextBlocks(message?.content);
        if (blocks.length > 0) {
          result.user = blocks.join("\n").trim();
        }
      }

      if (result.user && result.assistant) break;
    }
  } catch {}

  return result;
}

async function main() {
  try {
    const payload = parseJson(await readStdin());
    const lastAssistantMessage =
      typeof payload.last_assistant_message === "string" && payload.last_assistant_message.trim()
        ? payload.last_assistant_message.trim()
        : "";
    const recentTurn = readRecentClaudeTurn(payload.transcript_path);
    const texts = [
      recentTurn.user,
      lastAssistantMessage || recentTurn.assistant,
    ].filter(Boolean);

    if (texts.length === 0) return;

    await captureMessages({
      texts,
      sessionKey: `claude-code:${payload.session_id || payload.sessionId || "unknown"}`,
      agentId: process.env.MEMORY_AGENT_ID || "main",
    });
  } catch (error) {
    console.error(
      `memory-lancedb-pro claude-code capture hook failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

await main();
