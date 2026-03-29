import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { isNoise, filterNoise } = jiti("../src/noise-filter.ts");

describe("isNoise", () => {
  // --- CJK short text fix ---
  describe("CJK short text should not be marked as noise", () => {
    it("4-char CJK is not noise", () => {
      assert.equal(isNoise("\u4ed6\u559c\u6b22\u732b"), false);
    });

    it("3-char mixed CJK is not noise", () => {
      assert.equal(isNoise("\u7528Go\u5199"), false);
    });

    it("2-char CJK is not noise", () => {
      assert.equal(isNoise("\u5b66\u4e60"), false);
    });

    it("single CJK char is noise", () => {
      assert.equal(isNoise("\u597d"), true);
    });
  });

  // --- English short text preserved ---
  describe("English short text filtering preserved", () => {
    it("marks 'ok' as noise", () => {
      assert.equal(isNoise("ok"), true);
    });

    it("marks 'hi' as noise", () => {
      assert.equal(isNoise("hi"), true);
    });

    it("marks 'test' as noise", () => {
      assert.equal(isNoise("test"), true);
    });

    it("does not mark 5+ char English as noise by length alone", () => {
      assert.equal(isNoise("hello world this is a real memory"), false);
    });
  });

  // --- pattern filters ---
  describe("denial pattern filtering", () => {
    it("marks agent denial as noise", () => {
      assert.equal(isNoise("I don't have any information about that"), true);
    });
  });

  describe("meta-question pattern filtering", () => {
    it("marks meta-question as noise", () => {
      assert.equal(isNoise("do you remember what I said"), true);
    });
  });

  describe("boilerplate pattern filtering", () => {
    it("marks greeting as noise", () => {
      assert.equal(isNoise("hello there"), true);
    });
  });

  // --- options control ---
  describe("options control", () => {
    it("respects filterBoilerplate: false", () => {
      assert.equal(isNoise("hello there", { filterBoilerplate: false }), false);
    });

    it("respects filterDenials: false", () => {
      assert.equal(isNoise("I don't have any information", { filterDenials: false }), false);
    });

    it("respects filterMetaQuestions: false", () => {
      assert.equal(isNoise("do you remember", { filterMetaQuestions: false }), false);
    });
  });
});

describe("filterNoise", () => {
  it("filters noise items from array", () => {
    const items = [
      { id: 1, text: "\u4ed6\u559c\u6b22\u732b" },
      { id: 2, text: "ok" },
      { id: 3, text: "I prefer dark mode for all editors" },
      { id: 4, text: "\u597d" },
    ];
    const result = filterNoise(items, (item) => item.text);
    assert.deepEqual(
      result.map((r) => r.id),
      [1, 3]
    );
  });
});
