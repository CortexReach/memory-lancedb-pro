import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyzeIntent, applyCategoryBoost, formatAtDepth } from "../src/intent-analyzer.ts";

describe("analyzeIntent", () => {
  it("detects preference intent (English)", () => {
    const result = analyzeIntent("What is my preferred coding style?");
    assert.equal(result.label, "preference");
    assert.equal(result.confidence, "high");
    assert.equal(result.depth, "l0");
    assert.ok(result.categories.includes("preference"));
  });

  it("detects preference intent (Chinese)", () => {
    const result = analyzeIntent("我的代码风格偏好是什么？");
    assert.equal(result.label, "preference");
    assert.equal(result.confidence, "high");
  });

  it("detects decision intent", () => {
    const result = analyzeIntent("Why did we choose PostgreSQL over MySQL?");
    assert.equal(result.label, "decision");
    assert.equal(result.confidence, "high");
    assert.equal(result.depth, "l1");
    assert.ok(result.categories.includes("decision"));
  });

  it("detects decision intent (Chinese)", () => {
    const result = analyzeIntent("当时决定用哪个方案？");
    assert.equal(result.label, "decision");
    assert.equal(result.confidence, "high");
  });

  it("detects entity intent", () => {
    const result = analyzeIntent("Who is the project lead for auth service?");
    assert.equal(result.label, "entity");
    assert.equal(result.confidence, "high");
    assert.ok(result.categories.includes("entity"));
  });

  it("detects entity intent (Chinese)", () => {
    const result = analyzeIntent("谁是这个项目的负责人？");
    assert.equal(result.label, "entity");
    assert.equal(result.confidence, "high");
  });

  it("does NOT misclassify tool/component queries as entity", () => {
    // These should match fact, not entity (Codex review finding #4)
    const tool = analyzeIntent("How do I install the tool?");
    assert.notEqual(tool.label, "entity");
    const component = analyzeIntent("How does this component work?");
    assert.notEqual(component.label, "entity");
  });

  it("detects event intent and routes to entity+decision categories", () => {
    const result = analyzeIntent("What happened during last week's deploy?");
    assert.equal(result.label, "event");
    assert.equal(result.confidence, "high");
    assert.equal(result.depth, "full");
    // event is not a stored category — should route to entity + decision
    assert.ok(result.categories.includes("entity"));
    assert.ok(result.categories.includes("decision"));
    assert.ok(!result.categories.includes("event"));
  });

  it("detects event intent (Chinese)", () => {
    const result = analyzeIntent("最近发生了什么？");
    assert.equal(result.label, "event");
    assert.equal(result.confidence, "high");
    assert.ok(!result.categories.includes("event"));
  });

  it("detects fact intent", () => {
    const result = analyzeIntent("How does the authentication API work?");
    assert.equal(result.label, "fact");
    assert.equal(result.confidence, "high");
    assert.equal(result.depth, "l1");
  });

  it("detects fact intent (Chinese)", () => {
    const result = analyzeIntent("这个接口怎么配置？");
    assert.equal(result.label, "fact");
    assert.equal(result.confidence, "high");
  });

  it("returns broad signal for ambiguous queries", () => {
    const result = analyzeIntent("write a function to sort arrays");
    assert.equal(result.label, "broad");
    assert.equal(result.confidence, "low");
    assert.deepEqual(result.categories, []);
    assert.equal(result.depth, "l0");
  });

  it("returns empty signal for empty input", () => {
    const result = analyzeIntent("");
    assert.equal(result.label, "empty");
    assert.equal(result.confidence, "low");
  });
});

describe("applyCategoryBoost", () => {
  const mockResults = [
    { entry: { category: "fact" }, score: 0.8 },
    { entry: { category: "preference" }, score: 0.75 },
    { entry: { category: "entity" }, score: 0.7 },
  ];

  it("boosts matching categories and re-sorts", () => {
    const intent = {
      categories: ["preference"],
      depth: "l0",
      confidence: "high",
      label: "preference",
    };
    const boosted = applyCategoryBoost(mockResults, intent);
    // preference entry (0.75 * 1.15 = 0.8625) should now rank first
    assert.equal(boosted[0].entry.category, "preference");
    assert.ok(boosted[0].score > 0.75);
  });

  it("returns results unchanged for low confidence", () => {
    const intent = {
      categories: [],
      depth: "l0",
      confidence: "low",
      label: "broad",
    };
    const result = applyCategoryBoost(mockResults, intent);
    assert.equal(result[0].entry.category, "fact"); // original order preserved
  });

  it("caps boosted scores at 1.0", () => {
    const highScoreResults = [
      { entry: { category: "preference" }, score: 0.95 },
    ];
    const intent = {
      categories: ["preference"],
      depth: "l0",
      confidence: "high",
      label: "preference",
    };
    const boosted = applyCategoryBoost(highScoreResults, intent);
    assert.ok(boosted[0].score <= 1.0);
  });
});

describe("formatAtDepth", () => {
  const entry = {
    text: "User prefers TypeScript over JavaScript for all new projects. This was decided after the migration incident in Q3 where type errors caused a production outage.",
    category: "preference",
    scope: "global",
  };

  it("l0: returns compact one-line summary", () => {
    const line = formatAtDepth(entry, "l0", 0.85, 0);
    assert.ok(line.length < entry.text.length + 30); // shorter than full
    assert.ok(line.includes("[preference]"));
    assert.ok(line.includes("85%"));
    assert.ok(!line.includes("global")); // l0 omits scope
  });

  it("l1: returns medium detail with scope", () => {
    const line = formatAtDepth(entry, "l1", 0.72, 1);
    assert.ok(line.includes("[preference:global]"));
    assert.ok(line.includes("72%"));
  });

  it("full: returns complete text", () => {
    const line = formatAtDepth(entry, "full", 0.9, 0);
    assert.ok(line.includes(entry.text));
    assert.ok(line.includes("[preference:global]"));
  });

  it("includes BM25 and rerank source tags", () => {
    const line = formatAtDepth(entry, "full", 0.8, 0, { bm25Hit: true, reranked: true });
    assert.ok(line.includes("vector+BM25"));
    assert.ok(line.includes("+reranked"));
  });

  it("handles short text without truncation", () => {
    const short = { text: "Use tabs.", category: "preference", scope: "global" };
    const l0 = formatAtDepth(short, "l0", 0.9, 0);
    assert.ok(l0.includes("Use tabs."));
  });

  it("splits CJK sentences correctly at l0 depth", () => {
    const cjk = {
      text: "第一句结束。第二句开始，这里有更多内容需要处理。",
      category: "fact",
      scope: "global",
    };
    const l0 = formatAtDepth(cjk, "l0", 0.8, 0);
    // Should stop at first 。 not include second sentence
    assert.ok(l0.includes("第一句结束。"));
    assert.ok(!l0.includes("第二句开始"));
  });

  it("applies sanitize function when provided", () => {
    const malicious = {
      text: '<script>alert("xss")</script> normal text',
      category: "fact",
      scope: "global",
    };
    const sanitize = (t) => t.replace(/<[^>]*>/g, "").trim();
    const line = formatAtDepth(malicious, "full", 0.8, 0, { sanitize });
    assert.ok(!line.includes("<script>"));
    assert.ok(line.includes("normal text"));
  });
});
