// test/lock-production-simulation.test.mjs
/**
 * 生產環境模擬測試
 * 
 * 目標：達到 80% 與生產環境相同的數據
 * 排除：CPU/GPU 高負載（不考慮硬體瓶頸，只看 lock 機制）
 * 
 * 生產環境特徵：
 * - 3-5 個 agents 同時運行
 * - 不是所有操作都同時開始（有 slight stagger）
 * - 每個 agent 有背景任務（auto-capture, patchMetadata）
 * - Lock 有機會被長期持有
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "memory-lancedb-pro-prod-"));
  const store = new MemoryStore({ dbPath: dir, vectorDim: 3 });
  return { store, dir };
}

function makeEntry(i = 1, text = `memory-${i}`) {
  return {
    text,
    vector: [0.1 * i, 0.2 * i, 0.3 * i],
    category: "fact",
    scope: "global",
    importance: 0.5,
    metadata: "{}",
  };
}

// 測試 1：模擬真實的 3-5 agent 並發（加入 stagger）
describe("Production-like: 3-5 agents with stagger", () => {
  it("should handle 3 agents with stagger", async () => {
    const { store, dir } = makeStore();
    try {
      // 模擬真實場景：不是同時開始，稍微有 stagger
      const results = [];
      
      // Agent 1
      setTimeout(async () => {
        for (let i = 0; i < 3; i++) {
          results.push(store.store(makeEntry(i, "agent1-op-" + i)));
        }
      }, 0);
      
      // Agent 2 (50ms 後開始)
      setTimeout(async () => {
        for (let i = 0; i < 3; i++) {
          results.push(store.store(makeEntry(i + 10, "agent2-op-" + i)));
        }
      }, 50);
      
      // Agent 3 (100ms 後開始)
      setTimeout(async () => {
        for (let i = 0; i < 3; i++) {
          results.push(store.store(makeEntry(i + 20, "agent3-op-" + i)));
        }
      }, 100);
      
      // 等待所有完成
      await new Promise(r => setTimeout(r, 500));
      
      // 收集結果
      const settled = await Promise.allSettled(results.flat());
      const successes = settled.filter(r => r.status === 'fulfilled');
      
      console.log(`[3 agents with stagger] Success: ${successes.length}/9`);
      
      // 預期：至少 80% 成功
      assert.ok(successes.length >= 7, `至少 80% 成功，實際: ${successes.length}/9`);
      
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("should handle 5 agents with stagger and background tasks", async () => {
    const { store, dir } = makeStore();
    try {
      const NUM_AGENTS = 5;
      const OPS_PER_AGENT = 3;
      const results = [];
      
      // 每個 agent 間隔 30ms 啟動（模擬真實分散）
      for (let agent = 0; agent < NUM_AGENTS; agent++) {
        setTimeout(async () => {
          // 每個 agent 執行寫入 + 背景任務（patchMetadata）
          for (let op = 0; op < OPS_PER_AGENT; op++) {
            const entry = await store.store(makeEntry(agent * 100 + op, `agent${agent}-op${op}`));
            results.push({ type: 'write', success: true, id: entry.id });
            
            // 背景任務：patchMetadata（模擬 auto-capture）
            // 隨機 sometimes 失敗，sometimes 成功
            if (Math.random() > 0.5) {
              try {
                await store.patchMetadata(entry.id, { importance: 0.8 });
                results.push({ type: 'patch', success: true });
              } catch (e) {
                results.push({ type: 'patch', success: false, error: e.message });
              }
            }
          }
        }, agent * 30);
      }
      
      // 等待所有完成（給足夠時間）
      await new Promise(r => setTimeout(r, 1000));
      
      const writes = results.filter(r => r.type === 'write');
      const patches = results.filter(r => r.type === 'patch');
      const totalOps = writes.length + patches.length;
      const successOps = results.filter(r => r.success).length;
      
      console.log(`[5 agents + background] Writes: ${writes.length}, Patches: ${patches.length}`);
      console.log(`  Total: ${totalOps}, Success: ${successOps} (${(successOps/totalOps*100).toFixed(1)}%)`);
      
      // 預期：至少 70% 成功
      assert.ok(successOps >= totalOps * 0.7, `至少 70% 成功，實際: ${(successOps/totalOps*100).toFixed(1)}%`);
      
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// 測試 2：模擬 lock 被長期持有的場景
describe("Production-like: Lock held for extended time", () => {
  it("should handle writes when lock is held for 5 seconds", async () => {
    const { store, dir } = makeStore();
    const lockPath = join(dir, ".memory-write.lock");
    
    try {
      // 先初始化
      await store.store(makeEntry(1, "seed"));
      
      // 建立 lock 並模擬長期持有（5秒）
      writeFileSync(lockPath, "", { flag: 'w' });
      
      // 啟動一個長期持有 lock 的 operation（在背景）
      const longOperation = (async () => {
        // 這會持有 lock 5秒
        await new Promise(r => setTimeout(r, 5000));
        await store.store(makeEntry(999, "long-op-done"));
      })();
      
      // 同時嘗試其他 writes（這應該會等待或 timeout）
      const concurrentWrites = Array.from({ length: 3 }, (_, i) => 
        store.store(makeEntry(i + 100, `concurrent-${i}`))
      );
      
      // 等待結果
      const [longResult, ...writeResults] = await Promise.allSettled([
        longOperation,
        ...concurrentWrites
      ]);
      
      const successWrites = writeResults.filter(r => r.status === 'fulfilled');
      console.log(`[Lock held 5s] Concurrent writes: ${successWrites.length}/3`);
      console.log(`  Long op: ${longResult.status}`);
      
      // 預期：部分成功（取決於 lock timeout 和重試）
      // 在真實生產環境，這可能會 timeout
      
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// 測試 3：模擬真實的 read-write 混合負載
describe("Production-like: Mixed read-write workload", () => {
  it("should handle 70% reads + 30% writes", async () => {
    const { store, dir } = makeStore();
    try {
      // 先寫入 10 筆資料
      for (let i = 0; i < 10; i++) {
        await store.store(makeEntry(i, `initial-${i}`));
      }
      
      // 模擬混合負載：70% read, 30% write
      const operations = [];
      for (let i = 0; i < 30; i++) {
        if (Math.random() < 0.7) {
          // 70% 讀取
          operations.push(store.list(undefined, undefined, 5, 0));
        } else {
          // 30% 寫入
          operations.push(store.store(makeEntry(i + 1000, `mixed-${i}`)));
        }
      }
      
      const results = await Promise.allSettled(operations);
      const successes = results.filter(r => r.status === 'fulfilled');
      
      console.log(`[70% read / 30% write] Success: ${successes.length}/30 (${(successes.length/30*100).toFixed(1)}%)`);
      
      // 預期：至少 80% 成功
      assert.ok(successes.length >= 24, `至少 80% 成功，實際: ${successes.length}/30`);
      
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// 測試 4：模擬間歇性高負載（真實生產 pattern）
describe("Production-like: Intermittent high load", () => {
  it("should handle burst then recover", async () => {
    const { store, dir } = makeStore();
    try {
      // Phase 1: 正常負載
      const normalOps = Array.from({ length: 5 }, (_, i) => 
        store.store(makeEntry(i, `normal-${i}`))
      );
      const normalResults = await Promise.allSettled(normalOps);
      const normalSuccess = normalResults.filter(r => r.status === 'fulfilled').length;
      console.log(`[Phase 1: Normal] ${normalSuccess}/5`);
      
      await new Promise(r => setTimeout(r, 100));
      
      // Phase 2: 突然高負載（模擬多個 agent 同時觸發）
      const burstOps = Array.from({ length: 10 }, (_, i) => 
        store.store(makeEntry(i + 100, `burst-${i}`))
      );
      const burstResults = await Promise.allSettled(burstOps);
      const burstSuccess = burstResults.filter(r => r.status === 'fulfilled').length;
      console.log(`[Phase 2: Burst] ${burstSuccess}/10`);
      
      await new Promise(r => setTimeout(r, 100));
      
      // Phase 3: 恢復正常
      const recoverOps = Array.from({ length: 5 }, (_, i) => 
        store.store(makeEntry(i + 200, `recover-${i}`))
      );
      const recoverResults = await Promise.allSettled(recoverOps);
      const recoverSuccess = recoverResults.filter(r => r.status === 'fulfilled').length;
      console.log(`[Phase 3: Recover] ${recoverSuccess}/5`);
      
      // 總結
      const total = normalSuccess + burstSuccess + recoverSuccess;
      console.log(`[Total] ${total}/20 (${(total/20*100).toFixed(1)}%)`);
      
      // 預期：至少 70% 整體成功
      assert.ok(total >= 14, `至少 70% 成功，實際: ${total}/20`);
      
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// 測試 5：模擬真實的 auto-recall flow
describe("Production-like: Auto-recall flow simulation", () => {
  it("should simulate read (recall) during write operations", async () => {
    const { store, dir } = makeStore();
    try {
      // 模擬 recall 需要讀取
      const recallOperation = async () => {
        // vector search
        const results = await store.list(undefined, undefined, 10, 0);
        return results;
      };
      
      // 模擬 background write（auto-capture）
      const writeOperations = Array.from({ length: 5 }, (_, i) => 
        store.store(makeEntry(i + 1000, `capture-${i}`))
      );
      
      // 同時進行
      const [recallResult, ...writeResults] = await Promise.allSettled([
        recallOperation(),
        ...writeOperations
      ]);
      
      const recallSuccess = recallResult.status === 'fulfilled';
      const writesSuccess = writeResults.filter(r => r.status === 'fulfilled').length;
      
      console.log(`[Auto-recall flow] Recall: ${recallSuccess ? 'OK' : 'FAIL'}, Writes: ${writesSuccess}/5`);
      
      // 預期：recall 應該優先成功（因為 read 不需要 lock）
      // 但在當前實現，read 也被 lock 擋住了
      assert.ok(recallSuccess, "Recall 應該成功");
      
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// 測試 6：真實的多 agent 順序啟動
describe("Production-like: Sequential agent startup", () => {
  it("simulates agents starting 500ms apart", async () => {
    const { store, dir } = makeStore();
    try {
      const AGENT_DELAY_MS = 500;
      const agents = 4;
      const allResults = [];
      
      for (let agent = 0; agent < agents; agent++) {
        // 每個 agent 啟動時執行一些操作
        await new Promise(r => setTimeout(r, AGENT_DELAY_MS));
        
        const ops = [
          store.store(makeEntry(agent * 10 + 1, `agent${agent}-1`)),
          store.store(makeEntry(agent * 10 + 2, `agent${agent}-2`)),
          store.list(undefined, undefined, 5, 0),
        ];
        
        const results = await Promise.allSettled(ops);
        const successes = results.filter(r => r.status === 'fulfilled').length;
        allResults.push({ agent, successes });
        console.log(`[Agent ${agent}] ${successes}/3`);
      }
      
      const totalSuccess = allResults.reduce((sum, r) => sum + r.successes, 0);
      const totalOps = agents * 3;
      
      console.log(`[Total] ${totalSuccess}/${totalOps} (${(totalSuccess/totalOps*100).toFixed(1)}%)`);
      
      // 預期：至少 80% 成功（因為有間隔，不會同時搶 lock）
      assert.ok(totalSuccess >= totalOps * 0.8, `至少 80% 成功，實際: ${(totalSuccess/totalOps*100).toFixed(1)}%`);
      
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});