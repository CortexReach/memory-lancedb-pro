import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const {
  writeRedoMarker,
  deleteRedoMarker,
  scanRedoMarkers,
  createRedoMarker,
  isStale,
} = jiti("../src/redo-log.ts");

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "redo-log-test-"));
}

describe("redo-log", () => {
  describe("createRedoMarker", () => {
    it("generates a marker with UUID and current timestamp", () => {
      const marker = createRedoMarker({
        sessionKey: "session-1",
        conversationText: "Hello, world!",
        scope: "global",
        agentId: "main",
      });

      assert.ok(marker.taskId, "taskId should be set");
      assert.strictEqual(marker.taskId.length, 36, "taskId should be a UUID");
      assert.strictEqual(marker.sessionKey, "session-1");
      assert.strictEqual(marker.conversationText, "Hello, world!");
      assert.strictEqual(marker.scope, "global");
      assert.strictEqual(marker.agentId, "main");
      assert.strictEqual(marker.version, 1);
      assert.ok(
        Math.abs(marker.createdAt - Date.now()) < 1000,
        "createdAt should be close to now",
      );
    });

    it("includes optional scopeFilter when provided", () => {
      const marker = createRedoMarker({
        sessionKey: "s",
        conversationText: "t",
        scope: "global",
        scopeFilter: ["global", "project:alpha"],
        agentId: "bot",
      });

      assert.deepStrictEqual(marker.scopeFilter, ["global", "project:alpha"]);
    });
  });

  describe("writeRedoMarker + scanRedoMarkers", () => {
    it("writes a marker and scans it back", async () => {
      const dir = makeTempDir();
      try {
        const marker = createRedoMarker({
          sessionKey: "sess-1",
          conversationText: "test conversation",
          scope: "global",
          agentId: "main",
        });

        await writeRedoMarker(dir, marker);

        // _redo directory should exist
        assert.ok(existsSync(join(dir, "_redo")), "_redo dir should be created");

        // Marker file should exist
        assert.ok(
          existsSync(join(dir, "_redo", `${marker.taskId}.json`)),
          "marker file should exist",
        );

        // Scan should return the marker
        const scanned = await scanRedoMarkers(dir);
        assert.strictEqual(scanned.length, 1);
        assert.strictEqual(scanned[0].taskId, marker.taskId);
        assert.strictEqual(scanned[0].sessionKey, "sess-1");
        assert.strictEqual(scanned[0].conversationText, "test conversation");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("auto-creates _redo directory", async () => {
      const dir = makeTempDir();
      try {
        assert.ok(
          !existsSync(join(dir, "_redo")),
          "_redo should not exist initially",
        );

        const marker = createRedoMarker({
          sessionKey: "s",
          conversationText: "t",
          scope: "g",
          agentId: "a",
        });

        await writeRedoMarker(dir, marker);
        assert.ok(
          existsSync(join(dir, "_redo")),
          "_redo dir should be auto-created",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("scans multiple markers sorted by createdAt", async () => {
      const dir = makeTempDir();
      try {
        const m1 = createRedoMarker({
          sessionKey: "s1",
          conversationText: "t1",
          scope: "g",
          agentId: "a",
        });
        m1.createdAt = 1000;

        const m2 = createRedoMarker({
          sessionKey: "s2",
          conversationText: "t2",
          scope: "g",
          agentId: "a",
        });
        m2.createdAt = 3000;

        const m3 = createRedoMarker({
          sessionKey: "s3",
          conversationText: "t3",
          scope: "g",
          agentId: "a",
        });
        m3.createdAt = 2000;

        await writeRedoMarker(dir, m1);
        await writeRedoMarker(dir, m2);
        await writeRedoMarker(dir, m3);

        const scanned = await scanRedoMarkers(dir);
        assert.strictEqual(scanned.length, 3);
        assert.strictEqual(scanned[0].sessionKey, "s1"); // oldest first
        assert.strictEqual(scanned[1].sessionKey, "s3");
        assert.strictEqual(scanned[2].sessionKey, "s2");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("deleteRedoMarker", () => {
    it("removes a marker file", async () => {
      const dir = makeTempDir();
      try {
        const marker = createRedoMarker({
          sessionKey: "s",
          conversationText: "t",
          scope: "g",
          agentId: "a",
        });

        await writeRedoMarker(dir, marker);
        assert.ok(
          existsSync(join(dir, "_redo", `${marker.taskId}.json`)),
          "marker should exist before delete",
        );

        await deleteRedoMarker(dir, marker.taskId);
        assert.ok(
          !existsSync(join(dir, "_redo", `${marker.taskId}.json`)),
          "marker should be gone after delete",
        );

        // Scan should return empty
        const scanned = await scanRedoMarkers(dir);
        assert.strictEqual(scanned.length, 0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("does not throw when deleting non-existent marker", async () => {
      const dir = makeTempDir();
      try {
        // Should not throw
        await deleteRedoMarker(dir, "non-existent-id");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("scanRedoMarkers edge cases", () => {
    it("returns empty when _redo directory does not exist", async () => {
      const dir = makeTempDir();
      try {
        const scanned = await scanRedoMarkers(dir);
        assert.strictEqual(scanned.length, 0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("isStale", () => {
    it("returns false for fresh marker", () => {
      const marker = createRedoMarker({
        sessionKey: "s",
        conversationText: "t",
        scope: "g",
        agentId: "a",
      });

      assert.strictEqual(isStale(marker, 24 * 3600_000), false);
    });

    it("returns true for old marker", () => {
      const marker = createRedoMarker({
        sessionKey: "s",
        conversationText: "t",
        scope: "g",
        agentId: "a",
      });
      marker.createdAt = Date.now() - 25 * 3600_000; // 25 hours ago

      assert.strictEqual(isStale(marker, 24 * 3600_000), true);
    });

    it("returns true at exactly maxAgeMs boundary", () => {
      const maxAgeMs = 10_000;
      const marker = createRedoMarker({
        sessionKey: "s",
        conversationText: "t",
        scope: "g",
        agentId: "a",
      });
      marker.createdAt = Date.now() - maxAgeMs - 1;

      assert.strictEqual(isStale(marker, maxAgeMs), true);
    });
  });
});
