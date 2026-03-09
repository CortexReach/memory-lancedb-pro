import assert from "node:assert/strict";

import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { expandQuery } = jiti("../src/query-expander.ts");

async function run() {
  // --- True positives: should expand ---

  {
    const result = expandQuery("服务突然挂了");
    assert.ok(result.includes("崩溃"), `expected "崩溃" in: ${result}`);
    assert.ok(result.includes("crash"), `expected "crash" in: ${result}`);
  }

  {
    const result = expandQuery("程序报错了");
    assert.ok(result.includes("error"), `expected "error" in: ${result}`);
    assert.ok(result.includes("exception"), `expected "exception" in: ${result}`);
  }

  {
    const result = expandQuery("配置文件");
    assert.ok(result.includes("config"), `expected "config" in: ${result}`);
  }

  // --- False positives: must NOT expand ---

  {
    const result = expandQuery("download the file");
    assert.equal(result, "download the file", `"download" should not trigger: ${result}`);
  }

  {
    const result = expandQuery("blog post about AI");
    assert.equal(result, "blog post about AI", `"blog" should not trigger: ${result}`);
  }

  {
    const result = expandQuery("dialog component");
    assert.equal(result, "dialog component", `"dialog" should not trigger: ${result}`);
  }

  {
    const result = expandQuery("changelog update");
    assert.equal(result, "changelog update", `"changelog" should not trigger: ${result}`);
  }

  {
    const result = expandQuery("markdown formatting");
    assert.equal(result, "markdown formatting", `"markdown" should not trigger: ${result}`);
  }

  {
    const result = expandQuery("pushover notification");
    assert.equal(result, "pushover notification", `"pushover" should not trigger: ${result}`);
  }

  {
    const result = expandQuery("catalog of tools");
    assert.equal(result, "catalog of tools", `"catalog" should not trigger: ${result}`);
  }

  {
    const result = expandQuery("找到答案了");
    assert.equal(result, "找到答案了", `"找到" should not trigger search expansion: ${result}`);
  }

  // --- Edge cases ---

  {
    const result = expandQuery("JINA_API_KEY");
    assert.equal(result, "JINA_API_KEY", `precise query should pass through: ${result}`);
  }

  {
    assert.equal(expandQuery(""), "", "empty string should pass through");
    assert.equal(expandQuery("hi"), "hi", "short query should pass through");
  }

  // --- Expansion cap: max 5 terms ---

  {
    const result = expandQuery("服务挂了，日志里报错了");
    const addedTerms = result.slice("服务挂了，日志里报错了".length).trim().split(/\s+/).filter(Boolean);
    assert.ok(
      addedTerms.length <= 5,
      `expansion should cap at 5 terms, got ${addedTerms.length}: ${addedTerms.join(", ")}`,
    );
  }

  console.log("OK: query-expander tests passed (%d assertions)", 16);
}

run().catch((err) => {
  console.error("FAIL: query-expander test failed");
  console.error(err);
  process.exit(1);
});
