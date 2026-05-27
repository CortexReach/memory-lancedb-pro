import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { buildExtractionPrompt } = jiti("../src/extraction-prompts.ts");

const prompt = buildExtractionPrompt(
  [
    "System: compacting context",
    "user: please remember I prefer tea",
    "assistant: noted",
  ].join("\n"),
  "test-user",
);

assert.match(prompt, /Raw conversation carryover/i);
assert.match(prompt, /3\+ lines of speaker text/i);
assert.match(prompt, /System\/runtime artifacts/i);
assert.match(prompt, /compaction notices/i);
assert.match(prompt, /model-switch\/session-reset traces/i);
assert.match(prompt, /Fragment blobs/i);
assert.match(prompt, /Atomic memory shape/i);
assert.match(prompt, /longer than about 200 characters/i);
assert.match(prompt, /single factual statement/i);
