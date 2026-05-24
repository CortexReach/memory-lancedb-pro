import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const {
  MemoryStore,
  normalizeStoragePath,
  validateStoragePath,
  validateStoragePathAsync,
} = jiti("../src/store.ts");

describe("storage path normalization", () => {
  it("converts Windows drive-letter file URLs to native paths", () => {
    assert.equal(
      normalizeStoragePath("file:///C:/openclaw-memory", "win32"),
      "C:\\openclaw-memory",
    );
  });

  it("converts Windows UNC file URLs to native UNC paths", () => {
    assert.equal(
      normalizeStoragePath("file://server/share/openclaw-memory", "win32"),
      "\\\\server\\share\\openclaw-memory",
    );
  });

  it("keeps native Windows paths unchanged", () => {
    assert.equal(
      normalizeStoragePath("C:/openclaw-memory", "win32"),
      "C:/openclaw-memory",
    );
  });

  it("normalizes constructor dbPath before LanceDB and lock use", () => {
    const input = "file:///tmp/openclaw-memory";
    const store = new MemoryStore({
      dbPath: input,
      vectorDim: 3,
    });

    assert.equal(store.dbPath, normalizeStoragePath(input));
  });

  it("validates local file URLs using native filesystem paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-lancedb-pro-file-url-"));
    try {
      assert.equal(validateStoragePath(pathToFileURL(dir).href), dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validates local file URLs asynchronously using native filesystem paths", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-lancedb-pro-file-url-async-"));
    try {
      assert.equal(await validateStoragePathAsync(pathToFileURL(dir).href), dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
