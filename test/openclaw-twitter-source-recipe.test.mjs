import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const playbook = readFileSync(
  new URL("../docs/openclaw-integration-playbook.md", import.meta.url),
  "utf8",
);

describe("OpenClaw X/Twitter source recipe", () => {
  it("documents the public TweetClaw-to-memory_store flow", () => {
    assert.match(playbook, /Public X\/Twitter source capture/);
    assert.match(playbook, /TweetClaw/);
    assert.match(playbook, /memory_store/);
    assert.match(playbook, /tweet URL/i);
    assert.match(playbook, /author handle/i);
    assert.match(playbook, /capture date/i);
    assert.match(playbook, /category: "fact"/);
    assert.match(playbook, /category: "decision"/);
  });

  it("keeps privacy and visible-action guardrails in the recipe", () => {
    assert.match(playbook, /API keys, cookies, bearer tokens, or account credentials/);
    assert.match(playbook, /direct-message content/);
    assert.match(playbook, /draft post or reply text/);
    assert.match(playbook, /non-public profile, follower, or media data/);
    assert.match(playbook, /explicit user approval/);
    assert.match(playbook, /memory-lancedb-pro` should only persist the reviewed summary/);
  });
});
