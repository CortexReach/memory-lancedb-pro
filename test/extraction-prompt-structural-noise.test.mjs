import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { buildExtractionPrompt } = jiti("../src/extraction-prompts.ts");

const { system } = buildExtractionPrompt(
  [
    "System: compacting context",
    "user: please remember I prefer tea",
    "assistant: noted",
  ].join("\n"),
  "test-user",
);

assert.match(system, /Raw conversation carryover/i);
assert.match(system, /3\+ lines of speaker text/i);
assert.match(system, /System\/runtime artifacts/i);
assert.match(system, /compaction notices/i);
assert.match(system, /model-switch\/session-reset traces/i);
assert.match(system, /Fragment blobs/i);
assert.match(system, /Atomic memory shape/i);
assert.match(system, /longer than about 200 characters/i);
assert.match(system, /single factual statement/i);
