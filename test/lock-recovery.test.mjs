// test/lock-recovery.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "memory-lancedb-pro-lock-recovery-"));
  const store = new MemoryStore({ dbPath: dir, vectorDim: 3 });
  return { store, dir };
}

function makeEntry(i = 1) {
  return {
    text: `memory-${i}`,
    vector: [0.1 * i, 0.2 * i, 0.3 * i],
    category: "fact",
    scope: "global",
    importance: 0.5,
    metadata: "{}",
  };
}

function waitForLine(stream, pattern, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for output: ${pattern}`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("error", onError);
    }

    function onError(err) {
      cleanup();
      reject(err);
    }

    function onData(chunk) {
      buffer += chunk.toString();
      if (buffer.includes(pattern)) {
        cleanup();
        resolve(buffer);
      }
    }

    stream.on("data", onData);
    stream.on("error", onError);
  });
}

function waitForExit(child, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error("Timed out waiting for child process to exit"));
    }, timeoutMs);

    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

describe("runWithFileLock recovery", () => {
  it("first write succeeds without a pre-created lock artifact", async () => {
    const { store, dir } = makeStore();
    try {
      const lockPath = join(dir, ".memory-write.lock");
      assert.strictEqual(existsSync(lockPath), false);

      const entry = await store.store(makeEntry(1));

      assert.ok(entry.id);
      assert.strictEqual(entry.text, "memory-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("concurrent writes serialize correctly", async () => {
    const { store, dir } = makeStore();
    try {
      const results = await Promise.all([
        store.store(makeEntry(1)),
        store.store(makeEntry(2)),
        store.store(makeEntry(3)),
      ]);

      assert.strictEqual(results.length, 3);

      const all = await store.list(undefined, undefined, 20, 0);
      assert.strictEqual(all.length, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cleans up the lock artifact after a successful release", async () => {
    const { store, dir } = makeStore();
    try {
      await store.store(makeEntry(1));

      const lockPath = join(dir, ".memory-write.lock");
      assert.strictEqual(existsSync(lockPath), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recovers from an artificially stale lock directory", async () => {
    const { store, dir } = makeStore();
    const lockPath = join(dir, ".memory-write.lock");

    try {
      mkdirSync(lockPath, { recursive: true });

      const oldTime = new Date(Date.now() - 120_000);
      utimesSync(lockPath, oldTime, oldTime);

      const stat = statSync(lockPath);
      assert.ok(stat.mtimeMs < Date.now() - 60_000);

      const entry = await store.store(makeEntry(1));
      assert.ok(entry.id);

      const all = await store.list(undefined, undefined, 20, 0);
      assert.strictEqual(all.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skip("recovers after a process is force-killed while holding the lock", async () => {
    const { dir } = makeStore();
    const holderScript = join(dir, "lock-holder.mjs");
    const recoveryScript = join(dir, "lock-recover.mjs");

    try {
      writeFileSync(
        holderScript,
        `
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { mkdirSync } from "node:fs";

const dbPath = ${JSON.stringify(dir)};
mkdirSync(dbPath, { recursive: true });

const release = await lockfile.lock(dbPath, {
  lockfilePath: join(dbPath, ".memory-write.lock"),
  stale: 10000,
  retries: 0,
});

console.log("LOCK_ACQUIRED");

// Hold forever so the parent can force-kill us while the lock is active.
await new Promise(() => {});
await release();
`,
        "utf8",
      );

      writeFileSync(
        recoveryScript,
        `
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti(${JSON.stringify(join(process.cwd(), "src", "store.ts"))});

const store = new MemoryStore({ dbPath: ${JSON.stringify(dir)}, vectorDim: 3 });
await store.store({
  text: "recovered",
  vector: [0.1, 0.2, 0.3],
  category: "fact",
  scope: "global",
  importance: 0.5,
  metadata: "{}",
});

console.log("RECOVERED_WRITE_OK");
`,
        "utf8",
      );

      const holder = spawn("node", [holderScript], {
        cwd: dir,
        stdio: ["ignore", "pipe", "pipe"],
      });

      await waitForLine(holder.stdout, "LOCK_ACQUIRED");

      const lockPath = join(dir, ".memory-write.lock");
      assert.strictEqual(existsSync(lockPath), true);

      try {
        holder.kill("SIGKILL");
      } catch {
        holder.kill();
      }

      await waitForExit(holder);

      assert.strictEqual(existsSync(lockPath), true);

      await new Promise((resolve) => setTimeout(resolve, 11_500));

      const recovery = spawn("node", [recoveryScript], {
        cwd: dir,
        stdio: ["ignore", "pipe", "pipe"],
      });

      await waitForLine(recovery.stdout, "RECOVERED_WRITE_OK");
      const result = await waitForExit(recovery);

      assert.strictEqual(result.code, 0);

      const jiti2 = jitiFactory(import.meta.url, { interopDefault: true });
      const { MemoryStore: VerifyStore } = jiti2("../src/store.ts");
      const verifyStore = new VerifyStore({ dbPath: dir, vectorDim: 3 });

      const all = await verifyStore.list(undefined, undefined, 20, 0);
      assert.strictEqual(all.length, 1);
      assert.strictEqual(all[0].text, "recovered");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Issue #670: ENOENT from proper-lockfile realpath() after proactive stale lock cleanup
 *
 * 情境：proactive cleanup 刪除 stale lock file 後（T=0），下一個 lock() 嘗試在
 * 已刪除檔案上呼叫 realpath()（T=3ms），導致 ENOENT。
 *
 * 根本原因：proper-lockfile v4 的 resolveCanonicalPath 預設呼叫 fs.realpath()。
 * 修復：realpath:false 完全繞過 realpath()，對 lock file 場景無副作用。
 *
 * 測試策略：直接呼叫 lockfile.lock()，在 artifact 已被刪除的狀態下，
 * 驗證 realpath:false 不會拋出 ENOENT，並成功建立新 lock。
 */
it("store() succeeds when lock artifact was already deleted (Issue #670)", async () => {
  const { store, dir } = makeStore();
  const lockPath = join(dir, ".memory-write.lock");

  try {
    // Step 1: 先建立一個正常的 store，讓 proper-lockfile 建立 artifact
    await store.store(makeEntry(1));

    // Step 2: 直接刪除 lock artifact，模擬 proactive cleanup 已執行的狀態
    if (existsSync(lockPath)) {
      rmSync(lockPath, { recursive: true, force: true });
    }
    const artifactPath = lockPath + ".lock";
    if (existsSync(artifactPath)) {
      rmSync(artifactPath, { recursive: true, force: true });
    }

    // Step 3: 驗證 artifact 真的不存在了
    assert.strictEqual(existsSync(lockPath), false);
    assert.strictEqual(existsSync(artifactPath), false);

    // Step 4: 再次 store()，在 artifact 已被刪除的狀態下
    // 有了 realpath:false，這不會拋出 ENOENT
    const entry = await store.store(makeEntry(2));
    assert.ok(entry.id, "store() should succeed even when lock artifact was deleted");

    // Step 5: 驗證資料真的寫入了
    const all = await store.list(undefined, undefined, 20, 0);
    assert.strictEqual(all.length, 2, "should have 2 entries total");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Issue #670 變種：ELOCKED 恢復後的 lock acquisition
 * 當另一個 process 持有 lock 並超過 stale threshold，ELOCKED handler 會刪除
 * artifact 並重試。這時 realpath:false 確保重試不會因為 artifact 已被刪除而失敗。
 */
it("store() succeeds after ELOCKED recovery cleaned up the artifact", async () => {
  const { store, dir } = makeStore();
  const lockPath = join(dir, ".memory-write.lock");

  try {
    // 建立一個超舊的 artifact，模擬崩潰的 holder 已超過 5min threshold
    mkdirSync(lockPath, { recursive: true });
    const oldTime = new Date(Date.now() - 10 * 60 * 1000); // 10 分鐘前
    utimesSync(lockPath, oldTime, oldTime);

    // 驗證 artifact 存在且是 stale
    const stat = statSync(lockPath);
    assert.ok(stat.mtimeMs < Date.now() - 5 * 60 * 1000, "artifact should be >5min old");

    // 嘗試 store() — proactive cleanup 會在 lock() 前刪除這個超舊 artifact，
    // lock() 不會因為 realpath() 在已刪除檔案上而拋出 ENOENT
    const entry = await store.store(makeEntry(1));
    assert.ok(entry.id, "store() should succeed after recovering from stale lock");

    const all = await store.list(undefined, undefined, 20, 0);
    assert.strictEqual(all.length, 1, "should have exactly 1 entry");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
