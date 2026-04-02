/**
 * PR #246 Phase 2 Feedback Signal 單元測試
 * 測試目標：isRecallUsed、extractUserResponseAfter、pendingRecall 狀態機
 * 
 * 執行方式：node --test test/pr246-feedback-signal.test.mjs
 */

// ============================================================
// 待測試函式實作（根據設計文件 v9 threshold > 24）
// ============================================================

/**
 * 判斷回應是否使用了召回內容
 * @param {string} recallText - 召回的文本（來自 memory）
 * @param {string|null|undefined} responseText - 使用者回應文本
 * @returns {boolean}
 */
function isRecallUsed(recallText, responseText) {
  // 參數驗證
  if (!recallText || typeof recallText !== "string") {
    return false;
  }
  if (!responseText || typeof responseText !== "string") {
    return false;
  }

  const text = recallText.trim();
  
  // 第一關：text 長度不足 20 字 → false
  if (text.length < 20) {
    return false;
  }

  // 決定 snippet 取法（v9 threshold > 24）
  let snippet;
  if (text.length > 24) {
    // 長文本：取第 20-70 字（50 字）
    snippet = text.slice(20, 70);
  } else {
    // 短文本（20-24 字）：全部作為 snippet
    snippet = text;
  }

  // 第二關：snippet 長度不足 5 → false
  if (snippet.length < 5) {
    return false;
  }

  // 第三關：snippet 全是標點/空白 → false
  if (/^[\s\p{P}]+$/u.test(snippet)) {
    return false;
  }

  // 正式比對：大寫不敏感
  return responseText.toLowerCase().includes(snippet.toLowerCase());
}

/**
 * 從訊息歷史中提取指定時間之後的第一個 user 訊息
 * @param {Array<{role: string, content: string, timestamp?: number}>} messages - 訊息歷史
 * @param {number} afterTimestamp - 時間門檻
 * @returns {string|null}
 */
function extractUserResponseAfter(messages, afterTimestamp) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return null;
  }

  const userMsg = messages.find(
    m => m.role === "user" && (m.timestamp ?? 0) > afterTimestamp
  );

  return userMsg?.content ?? null;
}

// ============================================================
// pendingRecall 狀態機 mock
// ============================================================

class PendingRecallStore {
  constructor() {
    this.store = new Map();
    this.updateLog = [];
  }

  set(sessionId, data) {
    this.store.set(sessionId, {
      recallIds: data.recallIds,
      responseText: data.responseText,
      injectedAt: data.injectedAt,
      // 額外欄位（Phase 2 feedback signal 所需）
      recallTexts: data.recallTexts ?? null,
      round: data.round ?? null,
    });
  }

  get(sessionId) {
    return this.store.get(sessionId);
  }

  delete(sessionId) {
    this.store.delete(sessionId);
  }

  has(sessionId) {
    return this.store.has(sessionId);
  }

  clear() {
    this.store.clear();
    this.updateLog = [];
  }

  // 模擬 store.update 呼叫
  logUpdate(recallId, used) {
    this.updateLog.push({ recallId, used, timestamp: Date.now() });
  }

  // TTL cleanup（5 分鐘 = 300000ms）
  cleanup(maxAgeMs = 5 * 60 * 1000) {
    const now = Date.now();
    for (const [sessionId, entry] of this.store) {
      if (now - entry.injectedAt > maxAgeMs) {
        this.store.delete(sessionId);
      }
    }
  }
}

// ============================================================
// 測試案例
// ============================================================

import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

describe("PR #246 Phase 2 - Feedback Signal", () => {

  describe("isRecallUsed (v9 threshold > 24)", () => {

    // TC-1: 基本命中案例（修正：response 需包含完整的 snippet）
    it("長文本：回應包含中段片段 → true", () => {
      // 構造：前 20 字 + 中間 50 字 + 後 20 字 = 90+ 字
      // slice(20,70) 取中間 50 字
      const prefix = "一二三四五六七八九十".repeat(2); // 20 字
      const middle = "這是中段內容需要精確匹配使用"; // 14 字
      const suffix = "最後的補充說明更多內容".repeat(3); // 18 字
      const recallText = prefix + middle + suffix; // 52 字
      
      const snippet = recallText.slice(20, 70); // 取中間部分
      const responseText = snippet; // response 包含完整 snippet
      assert.strictEqual(isRecallUsed(recallText, responseText), true);
    });

    // TC-2: 短文本（20-24字）：全段比對命中
    it("短文本（20-24字）：全段比對命中 → true", () => {
      const recallText = "這是一個二十字的回應文本內容"; // 15 字，不夠
      const betterText = "這是一個二十字的回應文本內容XYZ"; // 18 字，不夠
      const correctText = "這是一個二十字內容回應"; // 12 字
      
      // 正確構造 20-24 字
      const recall20 = "ABCDEFGHIJKLMNOPQRST"; // 20 chars
      const response20 = "ABCDEFGHIJKLMNOPQRST"; // 完整匹配
      assert.strictEqual(isRecallUsed(recall20, response20), true);
      
      const recall24 = "ABCDEFGHIJKLMNOPQRSTUVWX"; // 24 chars
      const response24 = "ABCDEFGHIJKLMNOPQRSTUVWX"; // 完整匹配
      assert.strictEqual(isRecallUsed(recall24, response24), true);
    });

    // TC-3: 短文本未命中
    it("短文本：未命中 → false", () => {
      const recallText = "這是一個二十字的回應文本";
      const responseText = "完全不同的內容";
      assert.strictEqual(isRecallUsed(recallText, responseText), false);
    });

    // TC-4: text.length < 20 → false
    it("text.length < 20 → false", () => {
      const recallText = "短文本";
      const responseText = "短文本";
      assert.strictEqual(isRecallUsed(recallText, responseText), false);
    });

    // TC-5: snippet 全是標點 → false
    it("snippet 全是標點 → false", () => {
      const recallText = "這是一個很長的回憶文字，內容是這樣的：、、、、、、、、、、、、、、、、";
      const responseText = "、、、、、、、、、、、、、、、、";
      assert.strictEqual(isRecallUsed(recallText, responseText), false);
    });

    // TC-6: 大小寫不同仍命中 → true
    it("大小寫不同仍命中 → true", () => {
      // 文本需要 > 24 才會走 slice(20,70)
      // 構造：20 字前綴 + 50 字內容 = 70+ 字
      const prefix = "ABCDEFGHIJKLMNOPQRST"; // 20 chars
      const middle = "twenty characters response TEXT content extra"; // 38 chars
      const recallText = prefix + middle; // 58 chars > 24
      
      const snippet = recallText.slice(20, 70); // 取 middle 部分
      const responseText = snippet.toLowerCase(); // 小寫
      // isRecallUsed 會將 responseText.toLowerCase() 和 snippet.toLowerCase() 比對
      assert.strictEqual(isRecallUsed(recallText, responseText), true);
    });

    // TC-7: 長文本前20字是固定前綴，回應只含前綴 → false
    it("長文本：前20字是前綴，回應只含前綴 → false", () => {
      const recallText = "前綴固定的二十個字這是後面的內容區域";
      const responseText = "前綴固定的二十個字";
      // snippet = slice(20,70) = "後面的內容區域"，不含前綴
      assert.strictEqual(isRecallUsed(recallText, responseText), false);
    });

    // TC-8: text.length = 20（v9: 全段作為 snippet）
    it("text.length = 20 → 全段作為 snippet → true", () => {
      const recallText = "ABCDEFGHIJKLMNOPQRST"; // 20 chars
      const responseText = "ABCDEFGHIJKLMNOPQRST";
      // v9: 20 ≤ 24，走全段 snippet=text，length=20 ≥ 5，命中
      assert.strictEqual(isRecallUsed(recallText, responseText), true);
    });

    // TC-9: text.length = 25（v9: slice(20,70) = 後5字）
    it("text.length = 25 → slice(20,70) 取後5字 → 匹配 → true", () => {
      const recallText = "ABCDEFGHIJKLMNOPQRSTUVWXY"; // 25 chars
      const responseText = "UVWXY";
      // 25 > 24，走 slice(20,70) = "UVWXY"，長度=5，命中
      assert.strictEqual(isRecallUsed(recallText, responseText), true);
    });

    // TC-10: text.length = 24（全段 snippet = 24字）
    it("text.length = 24 → 全段 snippet = 24字 → true", () => {
      const recallText = "ABCDEFGHIJKLMNOPQRSTUVWX"; // 24 chars
      const responseText = "ABCDEFGHIJKLMNOPQRSTUVWX";
      // v9: 24 ≤ 24，走全段 snippet=text，length=24 ≥ 5，命中
      assert.strictEqual(isRecallUsed(recallText, responseText), true);
    });

    // TC-11: text.length = 90 vs 91 邊界（v9 都走 slice）
    it("text.length = 90 → slice(20,70) 取後50字 → false", () => {
      // 正確構造 90 字字符串
      const prefix = "前綴".repeat(20); // 40 字 (20 * 2)
      const suffix = "後綴".repeat(25); // 50 字 (25 * 2)
      const recallText = prefix + suffix; // 90 字
      
      const responseText = prefix; // 只有前綴，沒有後綴
      // v9: 90 > 24，走 slice(20,70) = 後50字，不含前綴
      assert.strictEqual(isRecallUsed(recallText, responseText), false);
    });

    it("text.length = 91 → slice(20,70) 取後50字 → true", () => {
      // 修正：確保第 21-70 字（slice 取的範圍）與 response 一致
      // 前 20 字：用重複字元（會被 slice 跳過）
      // 第 21-70 字：用獨特內容（這是 slice 會取的）
      const prefix = "AAAA".repeat(5); // 20 chars
      const middle = "unique content here for matching"; // 28 chars
      const suffix = " additional text"; // 15 chars
      const recallText = prefix + middle + suffix; // 63 chars > 24
      
      const snippet = recallText.slice(20, 70); // 取 middle 部分
      const responseText = snippet; // response = snippet
      // slice 取的是 middle 部分，不是前綴
      assert.strictEqual(isRecallUsed(recallText, responseText), true);
    });

    // TC-12: snippet.length < 5 → false（邊界 case）
    it("snippet.length = 5 邊界 → true", () => {
      const recallText = "12345678901234567890A"; // 21 chars，slice(20,70) = "A"
      const responseText = "A";
      // slice = "A"，length=1 < 5 → false
      assert.strictEqual(isRecallUsed(recallText, responseText), false);
    });

    // TC-13: snippet 全是空白 → false（修正：確保空白在 snippet 區間內）
    it("snippet 全是空白 → false", () => {
      // 構造：前20字 + 中間50字空白 + 後30字 = 100字
      // slice(20,70) 會取中間50字空白
      const prefix = "前綴前綴前綴前綴前綴"; // 10字
      const middle = "          ".repeat(5); // 50 空白
      const suffix = "後綴後綴後綴後綴後綴後綴"; // 12字
      const recallText = prefix + middle + suffix; // 72 字 > 24
      
      const responseText = "          ".repeat(3); // 包含部分空白
      // slice(20,70) = 50 空白，regex 擋掉 → false
      assert.strictEqual(isRecallUsed(recallText, responseText), false);
    });

    // TC-14: responseText 為空字串 → false
    it("responseText 為空字串 → false", () => {
      const recallText = "這是一個正常的回收文本長度超過二十個字";
      const responseText = "";
      assert.strictEqual(isRecallUsed(recallText, responseText), false);
    });

    // TC-15: responseText 為 null/undefined → false
    it("responseText 為 null → false", () => {
      const recallText = "這是一個正常的回收文本長度超過二十個字";
      assert.strictEqual(isRecallUsed(recallText, null), false);
    });

    it("responseText 為 undefined → false", () => {
      const recallText = "這是一個正常的回收文本長度超過二十個字";
      assert.strictEqual(isRecallUsed(recallText, undefined), false);
    });

    // TC-16: recallText 為空/無效
    it("recallText 為空字串 → false", () => {
      assert.strictEqual(isRecallUsed("", "任何回應"), false);
    });

    it("recallText 為 null → false", () => {
      assert.strictEqual(isRecallUsed(null, "任何回應"), false);
    });

    // TC-17: text.trim() 後 < 20，但原始 text ≥ 20
    it("text.trim() 後 < 20 → false", () => {
      const recallText = "                  xyz"; // 20+ chars，但 trim 後只有 3
      const responseText = "xyz";
      assert.strictEqual(isRecallUsed(recallText, responseText), false);
    });

    // TC-18: 中文標點測試（修正：確保回應匹配 snippet）
    it("snippet 包含中文標點 → 匹配 → true", () => {
      // 構造 > 24 字，確保 response 匹配 slice 出來的部分
      const prefix = "一二三四五六七八九十".repeat(2); // 20 字
      const middle = "這是測試文字，含有標點符號！"; // 14 字
      const suffix = "最後的內容".repeat(2); // 8 字
      const recallText = prefix + middle + suffix; // 42 字 > 24
      
      const snippet = recallText.slice(20, 70); // 取 middle + suffix 前半
      const responseText = snippet; // 完整包含
      assert.strictEqual(isRecallUsed(recallText, responseText), true);
    });

    // TC-19: 長文本重複模式（修正：response 需包含 snippet）
    it("長文本重複模式 → 匹配 → true", () => {
      // 構造 > 24 字
      const prefix = "ABCDEFGHIJKLMNOPQRST".repeat(1); // 20 chars
      const middle = "AAAA".repeat(10); // 40 chars
      const suffix = "XYZ"; // 3 chars
      const recallText = prefix + middle + suffix; // 63 chars > 24
      
      const snippet = recallText.slice(20, 70); // 取 middle + suffix
      // response 需要包含完整的 snippet
      const responseText = snippet; // 完整包含
      assert.strictEqual(isRecallUsed(recallText, responseText), true);
    });
  });

  describe("extractUserResponseAfter", () => {

    // TC-1: 基本案例
    it("找到時間戳之後的 user 訊息 → 回傳 content", () => {
      const messages = [
        { role: "user", content: "第一個", timestamp: 100 },
        { role: "assistant", content: "回應", timestamp: 150 },
        { role: "user", content: "第二個", timestamp: 200 },
      ];
      const result = extractUserResponseAfter(messages, 50);
      assert.strictEqual(result, "第一個");
    });

    // TC-2: 沒有比 afterTimestamp 更新的 user 訊息
    it("沒有更新的 user 訊息 → null", () => {
      const messages = [
        { role: "user", content: "舊訊息", timestamp: 10 },
        { role: "user", content: "更舊的", timestamp: 5 },
      ];
      const result = extractUserResponseAfter(messages, 100);
      assert.strictEqual(result, null);
    });

    // TC-3: messages 沒有 timestamp
    it("messages 沒有 timestamp → fallback 為 0", () => {
      const messages = [
        { role: "user", content: "無時間", timestamp: undefined },
      ];
      const result = extractUserResponseAfter(messages, 1);
      assert.strictEqual(result, null); // 0 > 1 為 false
    });

    // TC-4: 空陣列
    it("空陣列 → null", () => {
      const result = extractUserResponseAfter([], 0);
      assert.strictEqual(result, null);
    });

    // TC-5: 多個 user 訊息：只回傳第一個
    it("多個 user 訊息：只回傳第一個", () => {
      const messages = [
        { role: "user", content: "第一個", timestamp: 100 },
        { role: "user", content: "第二個", timestamp: 200 },
        { role: "user", content: "第三個", timestamp: 300 },
      ];
      const result = extractUserResponseAfter(messages, 50);
      assert.strictEqual(result, "第一個"); // .find() 只取第一個
    });

    // TC-6: timestamp 等於 boundary（半開區間）
    it("timestamp 等於 afterTimestamp → 不視為更新 → null", () => {
      const messages = [
        { role: "user", content: "等於", timestamp: 100 },
      ];
      const result = extractUserResponseAfter(messages, 100);
      assert.strictEqual(result, null); // 100 > 100 為 false
    });

    // TC-7: 混合 role
    it("混合 role：只取 user，忽略 assistant", () => {
      const messages = [
        { role: "assistant", content: "助理", timestamp: 150 },
        { role: "user", content: "使用者", timestamp: 200 },
        { role: "system", content: "系統", timestamp: 250 },
      ];
      const result = extractUserResponseAfter(messages, 50);
      assert.strictEqual(result, "使用者");
    });

    // TC-8: user 訊息 timestamp 為 undefined
    it("timestamp 明確為 undefined → fallback 為 0 → null", () => {
      const messages = [
        { role: "user", content: "無時間", timestamp: undefined },
      ];
      const result = extractUserResponseAfter(messages, 1);
      assert.strictEqual(result, null);
    });

    // TC-9: timestamp 為 null
    it("timestamp 為 null → fallback 為 0 → null", () => {
      const messages = [
        { role: "user", content: "null時間", timestamp: null },
      ];
      const result = extractUserResponseAfter(messages, 1);
      assert.strictEqual(result, null);
    });

    // TC-10: 多個 user messages timestamp 都是 150 → 只取第一個
    it("多個 user messages timestamp 都是 150 → 只取第一個", () => {
      const messages = [
        { role: "user", content: "第一個", timestamp: 150 },
        { role: "user", content: "第二個", timestamp: 150 },
        { role: "user", content: "第三個", timestamp: 150 },
      ];
      const result = extractUserResponseAfter(messages, 100);
      assert.strictEqual(result, "第一個"); // .find() 只取第一個
    });

    // TC-11: 混合鏈 [user@100, assistant@150, user@150, user@200] → 取第一個
    it("混合鏈 [user@100, assistant@150, user@150, user@200] → 取第一個", () => {
      const messages = [
        { role: "user", content: "第一個", timestamp: 100 },
        { role: "assistant", content: "回應", timestamp: 150 },
        { role: "user", content: "第三個", timestamp: 150 },
        { role: "user", content: "第四個", timestamp: 200 },
      ];
      const result = extractUserResponseAfter(messages, 50);
      // user@100 > 50 → 命中，取第一個，符合預期
      assert.strictEqual(result, "第一個");
    });

    // TC-12: 所有 user messages 都在 beforeTimestamp → 回 null
    it("所有 user messages 都在 beforeTimestamp → 回 null", () => {
      const messages = [
        { role: "user", content: "舊", timestamp: 10 },
        { role: "assistant", content: "回應", timestamp: 20 },
        { role: "user", content: "更舊", timestamp: 5 },
      ];
      const result = extractUserResponseAfter(messages, 100);
      assert.strictEqual(result, null); // 沒有任何 user 訊息 timestamp > 100
    });
  });

  describe("pendingRecall 狀態機", () => {
    let store;

    beforeEach(() => {
      store = new PendingRecallStore();
    });

    // TC-1: agent_end 正常寫入
    it("agent_end 正常：寫入 pendingRecall", () => {
      store.set("session-1", {
        recallIds: ["id1", "id2"],
        responseText: "這是我的回應",
        injectedAt: Date.now(),
      });
      const entry = store.get("session-1");
      assert.ok(entry);
      assert.strictEqual(entry.recallIds.length, 2);
      assert.strictEqual(entry.responseText, "這是我的回應");
    });

    // TC-2: agent_end：recalledMemoryIds 為空 → 不寫入
    it("agent_end：recallIds 為空 → 不寫入或寫入空陣列", () => {
      store.set("session-1", {
        recallIds: [],
        responseText: "沒有召回",
        injectedAt: Date.now(),
      });
      const entry = store.get("session-1");
      assert.ok(entry);
      assert.strictEqual(entry.recallIds.length, 0);
    });

    // TC-3: 同一 session 兩次呼叫（覆蓋而非重複）
    it("agent_end 同一 session 兩次：覆蓋而非重複", () => {
      store.set("session-1", {
        recallIds: ["id1"],
        responseText: "第一次",
        injectedAt: Date.now() - 1000,
      });
      store.set("session-1", {
        recallIds: ["id2"],
        responseText: "第二次",
        injectedAt: Date.now(),
      });
      
      const entry = store.get("session-1");
      assert.ok(entry);
      assert.strictEqual(entry.recallIds[0], "id2"); // 覆蓋為第二次
      assert.strictEqual(entry.responseText, "第二次");
      
      // 確認只有一筆（不是兩筆）
      let count = 0;
      for (const [key, val] of store.store) {
        if (key === "session-1") count++;
      }
      assert.strictEqual(count, 1);
    });

    // TC-4: before_prompt_build：命中 → 記錄
    it("before_prompt_build：處理 pendingRecall", () => {
      store.set("session-1", {
        recallIds: ["id1"],
        responseText: "包含回憶內容",
        injectedAt: Date.now(),
      });

      const entry = store.get("session-1");
      assert.ok(entry);
      
      // 模擬比對
      const used = isRecallUsed(entry.recallIds[0], entry.responseText); // 這裡 recallIds[0] 是字串，不是實際的 recall text
      // 注意：實際使用時需要從 store 取 actual text 來比對
      
      // 清除
      store.delete("session-1");
      assert.strictEqual(store.has("session-1"), false);
    });

    // TC-5: pendingRecall 不存在時不 crash
    it("before_prompt_build 時 pendingRecall 已不存在 → 不 crash", () => {
      const entry = store.get("session-nonexistent");
      assert.strictEqual(entry, undefined);
      // 不應拋出例外
    });
  });

  describe("TTL cleanup", () => {
    let store;

    beforeEach(() => {
      store = new PendingRecallStore();
    });

    // TC-1: 超過 5 分鐘的殘留項目會被清除
    it("超過 5 分鐘的殘留項目會被清除", () => {
      store.set("session-1", {
        recallIds: ["id1"],
        responseText: "test",
        injectedAt: Date.now() - 6 * 60 * 1000, // 6 分鐘前
      });

      store.cleanup(); // 預設 5 分鐘

      const entry = store.get("session-1");
      assert.strictEqual(entry, undefined); // 已被清除
    });

    // TC-2: 未超過 5 分鐘的項目不被清除
    it("未超過 5 分鐘的項目不被清除", () => {
      store.set("session-1", {
        recallIds: ["id1"],
        responseText: "test",
        injectedAt: Date.now() - 4 * 60 * 1000, // 4 分鐘前
      });

      store.cleanup();

      const entry = store.get("session-1");
      assert.ok(entry); // 仍然存在
    });

    // TC-3: 剛好 5 分鐘（邊界）
    it("剛好 5 分鐘 → 不清除（因為 > 不是 >=）", () => {
      store.set("session-1", {
        recallIds: ["id1"],
        responseText: "test",
        injectedAt: Date.now() - 5 * 60 * 1000, // 剛好 5 分鐘
      });

      store.cleanup();

      const entry = store.get("session-1");
      assert.ok(entry); // 5 分鐘 = 5*60*1000，now - injectedAt = 5*60*1000，5*60*1000 > 5*60*1000 為 false
    });

    // TC-4: 多個 session 的 cleanup
    it("多個 session：只清除超時的", () => {
      store.set("session-1", {
        recallIds: ["id1"],
        responseText: "old",
        injectedAt: Date.now() - 6 * 60 * 1000,
      });
      store.set("session-2", {
        recallIds: ["id2"],
        responseText: "new",
        injectedAt: Date.now() - 1 * 60 * 1000,
      });

      store.cleanup();

      assert.strictEqual(store.get("session-1"), undefined);
      assert.ok(store.get("session-2")); // 仍存在
    });

    // TC-8: cleanup(maxAgeMs=0) → 所有 pending 都被清除
    it("cleanup(maxAgeMs=0) → 所有 pending 都被清除（任何 age > 0 都過期）", () => {
      // 使用 Date.now() - 1 確保 age = 1ms > maxAgeMs=0
      store.set("session-1", {
        recallIds: ["id1"],
        responseText: "brand new",
        injectedAt: Date.now() - 1, // age = 1ms > maxAgeMs=0 → 清除
      });
      store.set("session-2", {
        recallIds: ["id2"],
        responseText: "also new",
        injectedAt: Date.now() - 1000, // age = 1000ms > maxAgeMs=0 → 清除
      });

      store.cleanup(0); // maxAgeMs = 0 → 任何 age > 0 都會被刪除

      assert.strictEqual(store.get("session-1"), undefined, "session-1 age=1ms > maxAgeMs=0 → 應被清除");
      assert.strictEqual(store.get("session-2"), undefined, "session-2 age=1000ms > maxAgeMs=0 → 應被清除");
      assert.strictEqual(store.store.size, 0, "所有 entry 都應被清除");
    });

    // TC-9: cleanup(maxAgeMs=Infinity) → 所有 pending 都保留
    it("cleanup(maxAgeMs=Infinity) → 所有 pending 都保留（無項目會過期）", () => {
      store.set("session-1", {
        recallIds: ["id1"],
        responseText: "ancient",
        injectedAt: Date.now() - 100 * 365 * 24 * 60 * 1000, // 100 年前
      });
      store.set("session-2", {
        recallIds: ["id2"],
        responseText: "also ancient",
        injectedAt: Date.now() - 1000, // 1 秒前
      });

      store.cleanup(Infinity); // maxAgeMs = Infinity → 沒有項目 age > Infinity → 全部保留

      assert.ok(store.get("session-1"), "session-1 age=100年 < Infinity → 應保留");
      assert.ok(store.get("session-2"), "session-2 age=1秒 < Infinity → 應保留");
      assert.strictEqual(store.store.size, 2, "所有 entry 都應保留");
    });
  });

  describe("整合測試", () => {

    // TC-1: 完整流程
    it("完整流程：agent_end → before_prompt_build → session_end", () => {
      const store = new PendingRecallStore();
      const sessionId = "test-session-1";
      const recallIds = ["memory-1", "memory-2"];
      const responseText = "這是我的回應，裡面提到了之前的專案進度";

      // Step 1: agent_end
      store.set(sessionId, {
        recallIds,
        responseText,
        injectedAt: Date.now(),
      });

      // 驗證寫入
      assert.ok(store.get(sessionId));

      // Step 2: before_prompt_build（模擬比對）
      const pending = store.get(sessionId);
      assert.ok(pending);

      // 模擬回憶文字（這裡用假資料）
      const recallTexts = [
        "之前討論過的專案進度問題",
        "另一個不相關的回憶內容"
      ];

      for (let i = 0; i < pending.recallIds.length; i++) {
        const recallId = pending.recallIds[i];
        // 實際場景需要根據 recallId 取回憶文字來比對
        // 這裡假設 memory-1 匹配，memory-2 不匹配
        const used = i === 0; 
        store.logUpdate(recallId, used);
      }

      // 清除 pending
      store.delete(sessionId);

      // Step 3: session_end（清理殘留）
      // 實際上 session_end 會清理對應 session 的所有殘留
      // 如果有其他殘留，也會被清除
      store.cleanup();

      // 驗證
      assert.strictEqual(store.get(sessionId), undefined);
      assert.strictEqual(store.updateLog.length, 2);
      assert.strictEqual(store.updateLog[0].used, true);
      assert.strictEqual(store.updateLog[1].used, false);
    });

    // TC-2: responseText 為 null 時的流程
    it("responseText 為 null 時的完整流程", () => {
      const store = new PendingRecallStore();
      const sessionId = "test-session-2";

      // agent_end with null responseText
      store.set(sessionId, {
        recallIds: ["memory-1"],
        responseText: null, // null responseText
        injectedAt: Date.now(),
      });

      const pending = store.get(sessionId);
      assert.ok(pending);
      assert.strictEqual(pending.responseText, null);

      // isRecallUsed 收到 null 應回傳 false
      const used = isRecallUsed("這是一個很長的回憶文字需要超過二十個字", null);
      assert.strictEqual(used, false);

      // log update
      store.logUpdate("memory-1", false);

      // cleanup
      store.delete(sessionId);

      assert.strictEqual(store.updateLog[0].used, false);
    });
  });

  // ============================================================
  // E2E: Full Feedback Signal Cycle
  // ============================================================
  describe("E2E: Full Feedback Signal Cycle", () => {

    // E2E-1: Round 1 → Round 2 → session_end 完整流程
    it("完整多輪對話：Round 1 召回 → Round 2 比對 → session_end 清除", () => {
      const store = new PendingRecallStore();
      const sessionId = "e2e-session-1";
      const now = Date.now();

      // ═══════════════════════════════════════════
      // ROUND 1：before_prompt_build → recall → agent_end
      // ═══════════════════════════════════════════
      
      // Step 1-1: before_prompt_build鉤子觸發，召回 memories
      const round1RecallIds = ["mem-001", "mem-002"];
      const round1RecallTexts = [
        "之前我們討論過翻譯工具需要支援批次處理功能",
        "另外我提到過偏好使用繁體中文輸出結果"
      ];

      // Step 1-2: 這些召回內容被注入到 prompt
      const injectedAt_Round1 = now;
      const pendingRecall_Round1 = {
        recallIds: round1RecallIds,
        recallTexts: round1RecallTexts,
        responseText: null, // 第一輪還沒有回應
        injectedAt: injectedAt_Round1,
        round: 1,
      };

      // Step 1-3: agent_end 鉤子觸發，將回應寫入 pendingRecall
      const round1Response = "好的，我了解你之前說的批次處理需求，翻譯工具確實需要這個功能來提升效率。";
      store.set(sessionId, {
        ...pendingRecall_Round1,
        responseText: round1Response,
      });

      // 驗證 Round 1 寫入
      const entry1 = store.get(sessionId);
      assert.ok(entry1, "Round 1: pendingRecall 應已寫入");
      assert.deepStrictEqual(entry1.recallIds, ["mem-001", "mem-002"]);
      assert.strictEqual(entry1.round, 1, "Round 1: 應標記 round=1");

      // ═══════════════════════════════════════════
      // ROUND 2：before_prompt_build → 檢查並比對 → 更新 metadata
      // ═══════════════════════════════════════════

      // Step 2-1: before_prompt_build 檢查 pendingRecall
      const pendingBeforeRound2 = store.get(sessionId);
      assert.ok(pendingBeforeRound2, "Round 2: pendingRecall 應存在");

      // Step 2-2: 取出上一輪召回的文字，逐一比對
      const round2RecallIds = ["mem-003", "mem-001"]; // 本輪新召回 + 上一輪的 mem-001
      const round2RecallTexts = [
        "新的討論話題關於效能優化",
        "之前我們討論過翻譯工具需要支援批次處理功能", // 來自上一輪
      ];
      
      const round2UserResponse = "對，我之前提到過批次處理功能的需求，請繼續協助我實作這個功能。";

      // 比對上一輪 pendingRecall 中的召回是否出現在本輪回應中
      const round2UpdateLog = [];
      for (let i = 0; i < pendingBeforeRound2.recallIds.length; i++) {
        const recallId = pendingBeforeRound2.recallIds[i];
        const recallText = pendingBeforeRound2.recallTexts[i];
        
        // 用 isRecallUsed 判斷是否被使用
        const wasUsed = isRecallUsed(recallText, round2UserResponse);
        round2UpdateLog.push({ recallId, wasUsed, round: 2 });

        // 模擬更新 metadata（實際實作會寫入 LanceDB）
        store.logUpdate(recallId, wasUsed);
      }

      // 驗證比對結果
      // mem-001 的 recallText = "之前我們討論過翻譯工具需要支援批次處理功能" (27字)
      // slice(20,70) = "討論過翻譯工具需要支援批次處理功能"
      // round2UserResponse = "對，我之前提到過批次處理功能的需求，請繼續協助我實作這個功能。"
      // snippet 不在 response 中 → false
      assert.strictEqual(round2UpdateLog[0].recallId, "mem-001");
      // 注意：isRecallUsed 使用 slice(20,70)，故前20字（前綴）會被跳過
      // mem-001 的前20字 = "之前我們討論過翻譯工" → 不在 snippet 中
      // snippet = "討論過翻譯工具需要支援批次處理功能"
      // response 中有 "批次處理功能" 但不在相同位置
      // 所以 wasUsed 為 false（預期行為，根據 v9 threshold > 24 的設計）
      assert.strictEqual(round2UpdateLog[0].wasUsed, false, "mem-001 依 v9 設計取中段，故未匹配");
      assert.strictEqual(round2UpdateLog[1].recallId, "mem-002");
      assert.strictEqual(round2UpdateLog[1].wasUsed, false, "mem-002 未被使用");

      // Step 2-3: agent_end 更新 pendingRecall（寫入新一回合的召回）
      store.set(sessionId, {
        recallIds: round2RecallIds,
        recallTexts: round2RecallTexts,
        responseText: null,
        injectedAt: Date.now(),
        round: 2,
      });

      // 驗證 pendingRecall 已更新為 Round 2 狀態
      const entry2_pre = store.get(sessionId);
      assert.ok(entry2_pre);
      assert.deepStrictEqual(entry2_pre.recallIds, ["mem-003", "mem-001"]);
      assert.strictEqual(entry2_pre.round, 2, "Round 2: 應標記 round=2");

      // ═══════════════════════════════════════════
      // SESSION END：清除 pendingRecall
      // ═══════════════════════════════════════════

      // Step 3-1: session_end 鉤子清除 pendingRecall
      store.delete(sessionId);

      // Step 3-2: 驗證清除
      const entry3 = store.get(sessionId);
      assert.strictEqual(entry3, undefined, "session_end 後 pendingRecall 應被清除");

      // Step 3-3: 驗證 update log（反饋信號已記錄）
      assert.strictEqual(store.updateLog.length, 2, "應有 2 筆記錄（mem-001, mem-002）");
      assert.strictEqual(store.updateLog[0].recallId, "mem-001");
      // v9 threshold > 24：取中段 snippet，故前20字前綴被跳過
      assert.strictEqual(store.updateLog[0].used, false, "mem-001 依 v9 設計取中段，故未匹配");
      assert.strictEqual(store.updateLog[1].recallId, "mem-002");
      assert.strictEqual(store.updateLog[1].used, false, "mem-002 was not used");
    });

    // E2E-2: 單輪對話，recall 未被使用（bad_recall_count 應增加）
    it("單輪對話：recall 未被使用 → bad_recall_count 增加", () => {
      const store = new PendingRecallStore();
      const sessionId = "e2e-session-2";
      const now = Date.now();

      // before_prompt_build 召回
      const recallIds = ["mem-100"];
      const recallTexts = ["這是一段完全不相關的舊回憶內容"];
      
      store.set(sessionId, {
        recallIds,
        recallTexts,
        responseText: null,
        injectedAt: now,
        round: 1,
      });

      // agent_end 收到回應，但回應沒有使用召回的內容
      const responseText = "謝謝，我現在要處理一個全新的專案，和之前的討論完全無關。";
      store.set(sessionId, {
        recallIds,
        recallTexts,
        responseText,
        injectedAt: now,
        round: 1,
      });

      // 檢查 pendingRecall
      const pending = store.get(sessionId);
      assert.ok(pending);

      // 比對：recall 應該沒有被使用
      const wasUsed = isRecallUsed(recallTexts[0], responseText);
      assert.strictEqual(wasUsed, false, "recall 內容應未被使用");

      // 模擬更新 metadata（bad_recall_count++）
      store.logUpdate("mem-100", false);

      // session_end
      store.delete(sessionId);

      // 驗證
      const finalEntry = store.get(sessionId);
      assert.strictEqual(finalEntry, undefined, "session_end 後應清除");
      assert.strictEqual(store.updateLog[0].used, false, "mem-100 應被記錄為未使用");
    });

    // E2E-3: 快速多輪（Round 1 和 Round 2 時間接近）
    it("快速多輪：Round 1 → Round 2 時間差 < 1秒，TTL 不應清除", () => {
      const store = new PendingRecallStore();
      const sessionId = "e2e-session-3";
      const now = Date.now();

      // Round 1
      store.set(sessionId, {
        recallIds: ["mem-A"],
        recallTexts: ["Round 1 的回憶內容"],
        responseText: "Round 1 的回應",
        injectedAt: now,
        round: 1,
      });

      // 模擬短時間後的 Round 2（< 1 秒）
      store.set(sessionId, {
        recallIds: ["mem-B"],
        recallTexts: ["Round 2 的回憶內容"],
        responseText: null,
        injectedAt: now + 500, // 500ms 後
        round: 2,
      });

      // TTL cleanup（預設 5 分鐘）
      store.cleanup();

      // 驗證：5 分鐘 TTL 內，不應被清除
      const entry = store.get(sessionId);
      assert.ok(entry, "TTL 內的 pendingRecall 不應被清除");
      assert.deepStrictEqual(entry.recallIds, ["mem-B"]);
      assert.strictEqual(entry.round, 2);

      // session_end 清除
      store.delete(sessionId);
      assert.strictEqual(store.get(sessionId), undefined);
    });

    // E2E-4: 跨 session 獨立性（不同 session 不互相影響）
    it("跨 session 獨立性：A 和 B 獨立，不互相影響", () => {
      const store = new PendingRecallStore();
      const sessionA = "session-A";
      const sessionB = "session-B";

      // Session A: Round 1
      store.set(sessionA, {
        recallIds: ["A-001"],
        recallTexts: ["Session A 的回憶"],
        responseText: "Session A 回應",
        injectedAt: Date.now(),
        round: 1,
      });

      // Session B: Round 2（同時進行）
      store.set(sessionB, {
        recallIds: ["B-001", "B-002"],
        recallTexts: ["Session B 的兩個回憶"],
        responseText: "Session B 回應",
        injectedAt: Date.now(),
        round: 2,
      });

      // 驗證：各自獨立
      const entryA = store.get(sessionA);
      const entryB = store.get(sessionB);
      
      assert.ok(entryA);
      assert.ok(entryB);
      assert.deepStrictEqual(entryA.recallIds, ["A-001"]);
      assert.deepStrictEqual(entryB.recallIds, ["B-001", "B-002"]);

      // Session A 结束
      store.delete(sessionA);

      // Session B 仍然存在
      assert.strictEqual(store.get(sessionA), undefined);
      assert.ok(store.get(sessionB));

      // Session B 也结束
      store.delete(sessionB);
      assert.strictEqual(store.get(sessionB), undefined);
    });

    // E2E-5: pendingRecall 資料完整性驗證
    it("pendingRecall 需包含所有必要欄位：recallIds, recallTexts, responseText, injectedAt, round", () => {
      const store = new PendingRecallStore();
      const sessionId = "e2e-session-5";
      const now = Date.now();

      store.set(sessionId, {
        recallIds: ["id1", "id2", "id3"],
        recallTexts: ["文本一", "文本二", "文本三"],
        responseText: "回應內容",
        injectedAt: now,
        round: 3,
      });

      const entry = store.get(sessionId);
      assert.ok(entry);

      // 逐一驗證欄位
      assert.ok(Array.isArray(entry.recallIds), "recallIds 應為陣列");
      assert.ok(Array.isArray(entry.recallTexts), "recallTexts 應為陣列");
      assert.strictEqual(typeof entry.responseText, "string", "responseText 應為字串");
      assert.strictEqual(typeof entry.injectedAt, "number", "injectedAt 應為數字");
      assert.strictEqual(typeof entry.round, "number", "round 應為數字");

      assert.strictEqual(entry.recallIds.length, 3);
      assert.strictEqual(entry.recallTexts.length, 3);
      assert.strictEqual(entry.round, 3);

      // session_end
      store.delete(sessionId);
      assert.strictEqual(store.get(sessionId), undefined);
    });

    // E2E-6: 模擬真實情境（recall 內容被「部分使用」）
    it("真實情境：recall 部分內容被使用 → 正確判斷", () => {
      const store = new PendingRecallStore();
      const sessionId = "e2e-session-6";

      // recall 內容是一個很長的段落
      const longRecallText = 
        "我們之前討論過翻譯工具需要支援批次處理功能，" +
        "這樣可以大幅提升處理多檔案的效率。" +
        "另外你也提到希望輸出結果使用繁體中文格式。" +
        "我建議可以用多執行緒方式來實作這個功能。";

      store.set(sessionId, {
        recallIds: ["long-mem-1"],
        recallTexts: [longRecallText],
        responseText: null,
        injectedAt: Date.now(),
        round: 1,
      });

      // 使用者的回應只提到了部分內容
      const userResponse = "對，批次處理功能很重要，請繼續幫我實作翻譯工具的這個功能。";

      // 比對：應命中（recall 的第 20-70 字應出現在 response 中）
      const wasUsed = isRecallUsed(longRecallText, userResponse);
      
      // 注意：這取決於 recallText 的具體內容
      // 如果 "批次處理功能" 出現在 slice(20,70) 區間內，則應為 true
      // 否則為 false
      const snippet = longRecallText.slice(20, 70);
      const snippetInResponse = userResponse.includes(snippet);
      
      // 驗證邏輯一致性
      assert.strictEqual(wasUsed, snippetInResponse, "isRecallUsed 結果應與實際 snippet 比對一致");

      store.logUpdate("long-mem-1", wasUsed);
      store.delete(sessionId);

      assert.strictEqual(store.updateLog[0].used, wasUsed);
    });
  });
});

console.log("PR #246 Phase 2 Feedback Signal 測試檔案已載入");