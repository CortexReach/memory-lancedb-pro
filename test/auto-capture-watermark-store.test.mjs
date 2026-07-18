/**
 * Unit coverage for the auto-capture watermark's on-disk persistence
 * (restart-survivability for `autoCaptureSeenTextCount` -- see
 * test/autocapture-watermark-restart-survival.test.mjs for the full
 * hook-level behavior this unblocks).
 *
 * Fixtures are entirely synthetic; no real fleet data.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const {
  loadAutoCaptureWatermarks,
  saveAutoCaptureWatermarks,
} = jiti(path.resolve(testDir, "..", "src", "auto-capture-watermark-store.ts"));

describe("auto-capture watermark persistence", () => {
  let workspaceDir;
  let dbPath;

  beforeEach(() => {
    workspaceDir = mkdtempSync(path.join(tmpdir(), "autocapture-watermark-store-"));
    dbPath = path.join(workspaceDir, "db");
    mkdirSync(dbPath, { recursive: true });
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("returns an empty map when no watermark file exists yet", () => {
    const map = loadAutoCaptureWatermarks(dbPath);
    assert.equal(map.size, 0);
  });

  it("returns an empty map when the watermark file is malformed JSON", () => {
    writeFileSync(path.join(workspaceDir, ".auto-capture-watermark.json"), "{not valid json", "utf8");
    const map = loadAutoCaptureWatermarks(dbPath);
    assert.equal(map.size, 0);
  });

  it("skips non-numeric entries but keeps valid ones", () => {
    writeFileSync(
      path.join(workspaceDir, ".auto-capture-watermark.json"),
      JSON.stringify({ "agent:a:main": 3, "agent:b:main": "not-a-number", "agent:c:main": null }),
      "utf8",
    );
    const map = loadAutoCaptureWatermarks(dbPath);
    assert.equal(map.size, 1);
    assert.equal(map.get("agent:a:main"), 3);
  });

  it("round-trips a saved map through load", async () => {
    const original = new Map([
      ["agent:agent-one:webchat", 1],
      ["agent:agent-two:main", 4],
    ]);
    await saveAutoCaptureWatermarks(dbPath, original);
    const reloaded = loadAutoCaptureWatermarks(dbPath);
    assert.equal(reloaded.size, 2);
    assert.equal(reloaded.get("agent:agent-one:webchat"), 1);
    assert.equal(reloaded.get("agent:agent-two:main"), 4);
  });

  it("writes the watermark file next to the LanceDB dir, not inside it (matches the compaction-state.json convention)", async () => {
    await saveAutoCaptureWatermarks(dbPath, new Map([["agent:a:main", 2]]));
    const sidecarPath = path.join(workspaceDir, ".auto-capture-watermark.json");
    const raw = readFileSync(sidecarPath, "utf8");
    assert.deepEqual(JSON.parse(raw), { "agent:a:main": 2 });
  });

  it("creates the parent directory on first save (fresh dbPath, nothing on disk yet)", async () => {
    const freshDbPath = path.join(workspaceDir, "not-yet-created", "db");
    await saveAutoCaptureWatermarks(freshDbPath, new Map([["agent:a:main", 1]]));
    const reloaded = loadAutoCaptureWatermarks(freshDbPath);
    assert.equal(reloaded.get("agent:a:main"), 1);
  });

  it("save never throws when the parent directory is unwritable", async () => {
    const unwritableParent = path.join(workspaceDir, "unwritable");
    mkdirSync(unwritableParent, { mode: 0o444 });
    const bogusDbPath = path.join(unwritableParent, "nested", "db");
    const warnings = [];
    await assert.doesNotReject(
      saveAutoCaptureWatermarks(bogusDbPath, new Map([["agent:a:main", 1]]), (msg) => warnings.push(msg)),
    );
    if (process.getuid && process.getuid() !== 0) {
      assert.ok(warnings.length > 0, "expected a warning callback on a genuine write failure");
    }
  });
});
