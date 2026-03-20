#!/usr/bin/env node

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

function resolvePrompt(payload) {
  const prompt = typeof payload?.prompt === "string" ? payload.prompt.trim() : "";
  return prompt;
}

async function main() {
  try {
    const payload = parseJson(await readStdin());
    const prompt = resolvePrompt(payload);
    if (!prompt) return;

    const recall = await recallMemories({
      query: prompt,
      agentId: process.env.MEMORY_AGENT_ID || "codex",
      limit: 3,
    });

    if (!recall?.text) return;

    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: recall.text,
        },
      }) + "\n",
    );
  } catch (error) {
    console.error(
      `memory-lancedb-pro codex recall hook failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

await main();
