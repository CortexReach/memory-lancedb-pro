import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const { isNoise } = jiti("../src/noise-filter.ts");

describe("noise-filter structural patterns", () => {
  const samples = [
    "System: compaction safeguard engaged",
    "Compaction context safeguard tripped",
    "model switch detected",
    "model changed to gpt-5",
    "session reset due to inactivity",
    "(untrusted metadata): Sender (untrusted metadata): foo",
    "{\"type\":\"meta\",\"payload\":{\"note\":\"wrapper\"}}",
    "<relevant-memories>foo</relevant-memories>",
    "> quote one\n> quote two\n> quote three\n> quote four\n",
  ];

  for (const input of samples) {
    it(`filters structural noise: ${input.slice(0, 40)}`, () => {
      assert.equal(isNoise(input), true);
    });
  }

  it("allows structural noise when disabled", () => {
    const input = "System: model switch detected";
    assert.equal(isNoise(input, { filterStructuralNoise: false }), false);
  });
});
