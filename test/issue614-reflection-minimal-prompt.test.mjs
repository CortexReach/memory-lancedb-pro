/**
 * Regression test for issue #614.
 *
 * The embedded memory reflection runner must explicitly request the minimal
 * prompt surface so the runtime omits the skills catalog, instead of relying
 * only on disabled tools and lightweight bootstrap.
 *
 * Run: node --test test/issue614-reflection-minimal-prompt.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = resolve(__dirname, "..", "index.ts");

describe("issue #614 embedded reflection prompt mode", () => {
  it("passes the minimal prompt signal to runEmbeddedPiAgent", () => {
    const content = readFileSync(INDEX_PATH, "utf-8");
    const callIdx = content.indexOf("runEmbeddedPiAgent({");
    assert.ok(callIdx > 0, "embedded reflection runner call must exist");

    const payloadRegion = content.slice(callIdx, callIdx + 1200);
    assert.match(
      payloadRegion,
      /promptMode:\s*"minimal"/,
      'embedded reflection runner payload must include promptMode: "minimal"'
    );
    assert.ok(
      payloadRegion.indexOf('promptMode: "minimal"') > payloadRegion.indexOf("prompt,"),
      "promptMode must be passed in the same runner payload as the reflection prompt"
    );
    assert.ok(
      payloadRegion.indexOf('promptMode: "minimal"') < payloadRegion.indexOf("disableTools: true"),
      "promptMode should be an explicit prompt-surface setting, not a tool fallback"
    );
    assert.doesNotMatch(
      payloadRegion,
      /toolsAllow/,
      "reflection should request a minimal prompt directly instead of using a toolsAllow workaround"
    );
  });
});
