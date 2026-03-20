#!/usr/bin/env node

import { readFileSync } from "node:fs";

import { recallMemories } from "../../host-runtime.mjs";

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

function readLastClaudeUserMessage(transcriptPath) {
  if (typeof transcriptPath !== "string" || !transcriptPath.trim()) return "";
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
      if (entry?.type !== "user") continue;
      const message = entry.message;
      if (typeof message?.content === "string") return message.content.trim();
      const blocks = extractTextBlocks(message?.content);
      if (blocks.length > 0) return blocks.join("\n").trim();
    }
  } catch {}
  return "";
}

function resolvePrompt(payload) {
  const directCandidates = [
    payload.prompt,
    payload.text,
    payload.input,
    payload.user_prompt,
    payload.userPrompt,
    payload.message,
    payload.content,
  ];
  for (const candidate of directCandidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  const nestedCandidates = [
    payload.message?.content,
    payload.user_message?.content,
    payload.input_message?.content,
  ];
  for (const candidate of nestedCandidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
    const blocks = extractTextBlocks(candidate);
    if (blocks.length > 0) return blocks.join("\n").trim();
  }

  return readLastClaudeUserMessage(payload.transcript_path);
}

async function main() {
  try {
    const payload = parseJson(await readStdin());
    const prompt = resolvePrompt(payload);
    if (!prompt) return;

    const recall = await recallMemories({
      query: prompt,
      agentId: process.env.MEMORY_AGENT_ID || "main",
      limit: 3,
    });

    if (recall?.text) {
      process.stdout.write(`${recall.text}\n`);
    }
  } catch (error) {
    console.error(
      `memory-lancedb-pro claude-code recall hook failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

await main();
