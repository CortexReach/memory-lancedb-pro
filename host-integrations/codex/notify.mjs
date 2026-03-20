#!/usr/bin/env node

import { captureMessages } from "../../host-runtime.mjs";

function parseNotification(raw) {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function main() {
  try {
    const notification = parseNotification(process.argv[2]);
    if (notification.type !== "agent-turn-complete") {
      return;
    }

    const inputMessages = Array.isArray(notification["input-messages"])
      ? notification["input-messages"].filter((item) => typeof item === "string" && item.trim())
      : [];
    const lastAssistantMessage =
      typeof notification["last-assistant-message"] === "string" &&
      notification["last-assistant-message"].trim()
        ? notification["last-assistant-message"].trim()
        : "";

    const texts = [...inputMessages, lastAssistantMessage].filter(Boolean);
    if (texts.length === 0) return;

    await captureMessages({
      texts,
      sessionKey: `codex:${notification["thread-id"] || "unknown"}`,
      agentId: process.env.MEMORY_AGENT_ID || "main",
    });
  } catch (error) {
    console.error(
      `memory-lancedb-pro codex notify hook failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

await main();
