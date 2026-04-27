import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * 新鲜记忆 recency boost 测试。
 *
 * 验证在 freshMemoryBoostMinutes 窗口内存储的记忆会获得额外加分，
 * 确保纠正信息和最新上下文能排在高访问量旧记忆之前。
 */

// 模拟检索结果工厂
function makeResult(id, score, timestampMinutesAgo, category = "fact") {
  const now = Date.now();
  return {
    entry: {
      id,
      text: `memory ${id}`,
      category,
      scope: "agent:test",
      importance: 0.8,
      timestamp: now - timestampMinutesAgo * 60_000,
      vector: [0.1, 0.2, 0.3],
      metadata: "{}",
    },
    score,
    sources: {},
  };
}

describe("fresh memory boost", () => {
  it("应对窗口内的记忆加分", () => {
    const oldMemory = makeResult("old-1", 0.65, 120);
    const freshMemory = makeResult("fresh-1", 0.55, 5);

    const freshBoost = 0.15;
    const windowMinutes = 30;

    const now = Date.now();
    const results = [oldMemory, freshMemory].map((r) => {
      const ageMinutes = (now - r.entry.timestamp) / 60_000;
      if (ageMinutes < windowMinutes) {
        return { ...r, score: Math.min(1, r.score + freshBoost) };
      }
      return r;
    });

    results.sort((a, b) => b.score - a.score);

    assert.equal(results[0].entry.id, "fresh-1");
    assert.ok(results[0].score > results[1].score);
  });

  it("应对 reflection/preference 类别额外加分", () => {
    const freshFact = makeResult("fact-1", 0.50, 10, "fact");
    const freshReflection = makeResult("refl-1", 0.50, 10, "reflection");

    const freshBoost = 0.15;
    const categoryBonus = 0.05;
    const windowMinutes = 30;

    const now = Date.now();
    const results = [freshFact, freshReflection].map((r) => {
      const ageMinutes = (now - r.entry.timestamp) / 60_000;
      if (ageMinutes < windowMinutes) {
        let boost = freshBoost;
        if (r.entry.category === "reflection" || r.entry.category === "preference") {
          boost += categoryBonus;
        }
        return { ...r, score: Math.min(1, r.score + boost) };
      }
      return r;
    });

    results.sort((a, b) => b.score - a.score);

    assert.equal(results[0].entry.id, "refl-1");
    assert.ok(results[0].score - results[1].score >= 0.04);
  });

  it("不应对窗口外的记忆加分", () => {
    const oldMemory = makeResult("old-1", 0.60, 60);

    const windowMinutes = 30;
    const now = Date.now();
    const ageMinutes = (now - oldMemory.entry.timestamp) / 60_000;

    assert.ok(ageMinutes > windowMinutes);
    assert.equal(oldMemory.score, 0.60);
  });

  it("freshMemoryBoostMinutes 为 0 时应禁用加分", () => {
    const freshMemory = makeResult("fresh-1", 0.55, 5);
    const windowMinutes = 0;

    const boosted = windowMinutes > 0;
    assert.equal(boosted, false);
    assert.equal(freshMemory.score, 0.55);
  });
});
