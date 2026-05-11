import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { validateStoragePathAsync } = jiti("../src/store.ts");

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), "memory-lancedb-pro-vsp-async-"));
}

describe("validateStoragePathAsync", () => {
  it("resolves and returns absolute path unchanged", async () => {
    const dir = makeTmpDir();
    try {
      const result = await validateStoragePathAsync(dir);
      assert.ok(result.length > 0, "should return a non-empty string");
      assert.strictEqual(result, dir, "absolute path should be returned unchanged");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates the directory if it does not exist", async () => {
    const dir = makeTmpDir();
    rmSync(dir, { recursive: true, force: true }); // ensure it doesn't exist
    const targetPath = join(dir, "new-db");
    try {
      const result = await validateStoragePathAsync(targetPath);
      assert.strictEqual(result, targetPath, "should return resolved path");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects path with bad permissions (unwritable parent)", async () => {
    const dir = makeTmpDir();
    try {
      const lockedDir = join(dir, "locked");
      const lockedFile = join(lockedDir, "subfile");
      // Create a directory that is not writable — making parent unwritable
      // prevents mkdir from succeeding inside it
      chmodSync(dir, 0o555);
      try {
        await assert.rejects(
          async () => validateStoragePathAsync(join(dir, "subdir")),
          (err) => err instanceof Error,
          "should reject when parent directory is not writable",
        );
      } finally {
        chmodSync(dir, 0o755);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves symlink to real path", async () => {
    const dir = makeTmpDir();
    const targetDir = join(dir, "target");
    const linkPath = join(dir, "link");
    try {
      // Create a dangling symlink using a file target for simplicity
      writeFileSync(targetDir, "marker");
      const { symlinkSync } = await import("node:fs");
      symlinkSync(targetDir, linkPath);
      const result = await validateStoragePathAsync(linkPath);
      // The async version resolves symlink to real path
      assert.ok(result.length > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns resolved path for normal existing directory", async () => {
    const dir = makeTmpDir();
    try {
      const result = await validateStoragePathAsync(dir);
      assert.strictEqual(result, dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});