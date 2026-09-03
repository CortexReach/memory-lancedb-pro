import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { buildExtractionPrompt } = jiti("../src/extraction-prompts.ts");

const { system } = buildExtractionPrompt(
  [
    "user: I switched my commute to the M4",
    "assistant: noted",
  ].join("\n"),
  "test-user",
);

// Durable/recurring state and habit changes must route to preferences or
// patterns, not events — a one-off "events" classification hugs the
// admission threshold and gets dropped instead of persisting as the user's
// new ongoing state.
assert.match(system, /switched (my )?commute to the M4/i);
assert.match(system, /Spanish lesson before breakfast/i);
assert.match(system, /recurring|durable/i);
assert.match(system, /preferences|patterns/i);
assert.match(system, /one-off/i);
