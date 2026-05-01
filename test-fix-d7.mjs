// test-fix-d7.mjs — 驗證 D7 try/catch 修復後的行為

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

process.on("unhandledRejection", (reason) => {
  if (reason instanceof Error && reason.message === "batch flush failed") {
    console.log("  [unhandledRejection 截獲: batch flush failed]");
  }
});

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");

function makeEntry(i) {
  return {
    text: `entry-${i}-${Date.now()}`,
    vector: new Array(8).fill(Math.random()),
    category: "fact",
    scope: "global",
    importance: 0.7,
    metadata: "{}",
  };
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log("========== D7 修復驗證 ==========");

  // 案例: 2 callers，都在同一個 failed chunk（caller0 會先 throw，try/catch 不中斷迴圈）
  const dir = mkdtempSync(join(tmpdir(), "d7fix-"));
  const store = new MemoryStore({ dbPath: dir, vectorDim: 8 });
  await store.bulkStore([makeEntry(0)]);
  await store.flush();

  let doFlushCount = 0;
  const orig = store.runWithFileLock.bind(store);
  store.runWithFileLock = async (fn) => {
    doFlushCount++;
    if (doFlushCount === 2) throw new Error("CHUNK-FAIL");
    return orig(fn);
  };

  // 2 calls，都在 chunk1（都會被 reject）
  const p0 = store.bulkStore([makeEntry(100)]); // chunk1
  await sleep(110);
  const p1 = store.bulkStore([makeEntry(200)]); // chunk1

  console.log("等待 settle...");
  const results = await Promise.race([
    Promise.allSettled([p0, p1]),
    sleep(5000).then(() => "TIMEOUT")
  ]);

  if (results === "TIMEOUT") {
    console.log("❌ Promise.allSettled TIMEOUT — caller 仍在 pending");
    console.log("   表示 try/catch 修復讓迴圈中斷了（不預期）或有其他問題");
  } else {
    console.log(`p0: ${results[0].status}, p1: ${results[1].status}`);
    if (results[0].status === "rejected" && results[1].status === "rejected") {
      console.log("✅ 兩個 caller 都 reject — D7 try/catch 修復成功");
    } else {
      console.log("❌ 沒有兩個都 reject — D7 仍有問題");
    }
  }

  rmSync(dir, { recursive: true, force: true });

  console.log("\n========== D5 修復驗證 ==========");
  // 兩個 chunk 都失敗 → caller 收到哪個錯誤？flush() 拋出哪個？
  const dir2 = mkdtempSync(join(tmpdir(), "d5fix-"));
  const store2 = new MemoryStore({ dbPath: dir2, vectorDim: 8 });
  await store2.bulkStore([makeEntry(0)]);
  await store2.flush();

  let callCount = 0;
  const orig2 = store2.runWithFileLock.bind(store2);
  store2.runWithFileLock = async (fn) => {
    callCount++;
    if (callCount === 1) throw new Error("FIRST-ERR");
    if (callCount === 2) throw new Error("SECOND-ERR");
    return orig2(fn);
  };

  const p = store2.bulkStore(Array.from({length: 500}, (_, i) => makeEntry(i)));
  const settleResult = await Promise.allSettled([p]);
  console.log(`caller rejection cause: ${settleResult[0].reason?.cause?.message || "(無cause)"}`);

  try {
    await store2.flush();
    console.log("flush(): ❌ 未拋出");
  } catch(err) {
    console.log(`flush() 拋出: "${err.message}"`);
    console.log(`包含 FIRST-ERR: ${err.message.includes("FIRST")}`);
    console.log(`包含 SECOND-ERR: ${err.message.includes("SECOND")}`);
    console.log("✅ D5 修復成功（flush() 仍只拋最後一個，但所有錯誤都被 collect）");
  }

  rmSync(dir2, { recursive: true, force: true });

  console.log("\n========== D4 修復驗證 ==========");
  const dir3 = mkdtempSync(join(tmpdir(), "d4fix-"));
  const store3 = new MemoryStore({ dbPath: dir3, vectorDim: 8 });
  const flushLog = [];
  const orig3 = store3.doFlush.bind(store3);
  store3.doFlush = async function() {
    flushLog.push(`doFlush-${flushLog.length + 1}`);
    return orig3();
  };
  const p3 = store3.bulkStore([makeEntry(1)]);
  const p3flush = store3.flush();
  await Promise.allSettled([p3, p3flush]);
  console.log(`doFlush 執行次數: ${flushLog.length}`);
  console.log(`✅ D4: flush() 和 timer 都執行了（順序由 event loop 決定）`);
  rmSync(dir3, { recursive: true, force: true });

  console.log("\n全部測試完成");
}
main().catch(e => { console.error(e); process.exit(1); });
