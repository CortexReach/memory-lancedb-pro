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

function extractTextBlocks(content) {
  if (!Array.isArray(content)) return [];
  return content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      if (item.type === "input_text" && typeof item.text === "string") {
        return item.text.trim();
      }
      if (item.type === "output_text" && typeof item.text === "string") {
        return item.text.trim();
      }
      return "";
    })
    .filter(Boolean);
}

function readRecentCodexTurn(transcriptPath) {
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

      if (entry?.type !== "response_item") continue;
      const payload = entry.payload;
      if (payload?.type !== "message") continue;

      if (!result.assistant && payload.role === "assistant") {
        const blocks = extractTextBlocks(payload.content);
        if (blocks.length > 0) {
          result.assistant = blocks.join("\n").trim();
          continue;
        }
      }

      if (!result.user && payload.role === "user") {
        const blocks = extractTextBlocks(payload.content);
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
      typeof payload?.last_assistant_message === "string" && payload.last_assistant_message.trim()
        ? payload.last_assistant_message.trim()
        : "";
    const recentTurn = readRecentCodexTurn(payload?.transcript_path);
    const texts = [
      recentTurn.user,
      lastAssistantMessage || recentTurn.assistant,
    ].filter(Boolean);

    if (texts.length === 0) return;

    await captureMessages({
      texts,
      sessionKey: `codex:${payload.session_id || "unknown"}:${payload.turn_id || "unknown"}`,
      agentId: process.env.MEMORY_AGENT_ID || "codex",
    });
  } catch (error) {
    console.error(
      `memory-lancedb-pro codex capture hook failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

await main();
