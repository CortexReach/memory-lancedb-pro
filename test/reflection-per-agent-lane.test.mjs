// Per-agent reflection lanes + bounded concurrency.
//
// The reflection embedded run used to hardcode sessionKey "temp:memory-reflection",
// so every agent's reflection shared ONE serial host lane (session lanes default to
// maxConcurrent 1). Under a concurrent-reflection burst (mass /reset across agents)
// runs queued behind each other and burned their timeout budget waiting in the lane.
//
// The fix: a per-agent sessionKey ("temp:memory-reflection:<agentId>") so lanes are
// independent, plus a plugin-side cap (memoryReflection.maxConcurrentRuns, default 1
// = fully serialized, matching the previous behavior) acquired BEFORE the run's
// timeout clock starts, so waiting for a slot never burns the deadline. Raising the
// cap opts into parallel reflections across agents.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginSdkStubPath = path.resolve(testDir, "helpers", "openclaw-plugin-sdk-stub.mjs");
const jiti = jitiFactory(import.meta.url, {
  interopDefault: true,
  alias: {
    "openclaw/plugin-sdk": pluginSdkStubPath,
  },
});

const {
  generateReflectionText,
  acquireReflectionRunSlot,
  parsePluginConfig,
  isAgentOrSessionExcluded,
} = jiti("../index.ts");

// loadEmbeddedPiRunner caches the first Layer-1 runner it resolves module-wide,
// so every test shares ONE fake api and swaps behavior via this dispatcher.
let currentRunnerImpl = async () => ({ payloads: [{ text: "noop" }] });
const fakeApi = {
  runtime: {
    agent: {
      runEmbeddedPiAgent: (params) => currentRunnerImpl(params),
    },
  },
};

const baseParams = {
  conversation: "user: hello\nassistant: hi",
  maxInputChars: 1000,
  cfg: {},
  workspaceDir: "/tmp",
  timeoutMs: 2000,
  thinkLevel: "off",
  api: fakeApi,
};

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

async function waitFor(cond, timeoutMs = 5000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("per-agent reflection lane", () => {
  it("passes a per-agent sessionKey to the embedded runner", async () => {
    const seenKeys = [];
    currentRunnerImpl = async (params) => {
      seenKeys.push(params.sessionKey);
      return { payloads: [{ text: "reflection text" }] };
    };

    const one = await generateReflectionText({ ...baseParams, agentId: "agent-one" });
    const two = await generateReflectionText({ ...baseParams, agentId: "agent-two" });

    assert.equal(one.runner, "embedded");
    assert.equal(two.runner, "embedded");
    assert.deepEqual(seenKeys, [
      "temp:memory-reflection:agent-one",
      "temp:memory-reflection:agent-two",
    ]);
  });

  it("keeps per-agent keys inside the internal reflection namespace (temp:* exclusion)", () => {
    assert.equal(
      isAgentOrSessionExcluded("agent-one", "temp:memory-reflection:agent-one", ["temp:*"]),
      true,
    );
    assert.equal(
      isAgentOrSessionExcluded("agent-one", "temp:memory-reflection", ["temp:*"]),
      true,
    );
    assert.equal(
      isAgentOrSessionExcluded("agent-one", "agent:agent-one:main", ["temp:*"]),
      false,
    );
  });
});

describe("reflection concurrency cap", () => {
  it("bounds concurrent embedded runs at maxConcurrentRuns and completes every run", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let completed = 0;
    const gates = [];
    currentRunnerImpl = (params) =>
      new Promise((resolve) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        gates.push(() => {
          inFlight -= 1;
          completed += 1;
          resolve({ payloads: [{ text: `done ${params.agentId}` }] });
        });
      });

    const agents = ["agent-one", "agent-two", "agent-three", "agent-four"];
    const runs = agents.map((agentId) =>
      generateReflectionText({ ...baseParams, agentId, maxConcurrentRuns: 2 }),
    );

    await waitFor(() => gates.length === 2);
    await tick();
    assert.equal(gates.length, 2, "third and fourth runs must wait for a slot");
    assert.equal(maxInFlight, 2);

    gates.shift()();
    await waitFor(() => gates.length === 2);
    gates.shift()();
    await waitFor(() => gates.length === 2);
    gates.shift()();
    gates.shift()();

    const results = await Promise.all(runs);
    assert.equal(completed, 4);
    assert.equal(maxInFlight, 2, "cap must hold across the whole burst");
    for (const result of results) {
      assert.equal(result.runner, "embedded");
      assert.match(result.text, /^done agent-/);
    }
  });

  it("hands slots to waiters FIFO and tolerates double release", async () => {
    const releaseFirst = await acquireReflectionRunSlot(2);
    const releaseSecond = await acquireReflectionRunSlot(2);

    let thirdAcquired = false;
    const thirdPending = acquireReflectionRunSlot(2).then((release) => {
      thirdAcquired = true;
      return release;
    });
    await tick();
    assert.equal(thirdAcquired, false, "third acquire must wait while both slots are held");

    releaseFirst();
    releaseFirst();
    const releaseThird = await thirdPending;
    assert.equal(thirdAcquired, true);

    let fourthAcquired = false;
    const fourthPending = acquireReflectionRunSlot(2).then((release) => {
      fourthAcquired = true;
      return release;
    });
    await tick();
    assert.equal(fourthAcquired, false, "double release must not free a second slot");

    releaseSecond();
    const releaseFourth = await fourthPending;
    assert.equal(fourthAcquired, true);

    releaseThird();
    releaseFourth();
  });
});

describe("memoryReflection.maxConcurrentRuns config", () => {
  const parseCfg = (memoryReflection) =>
    parsePluginConfig({
      embedding: { apiKey: "dummy" },
      sessionStrategy: "memoryReflection",
      ...(memoryReflection === undefined ? {} : { memoryReflection }),
    });

  it("parses valid values, floors decimals, and defaults invalid ones", () => {
    assert.equal(parseCfg({ maxConcurrentRuns: 3 }).memoryReflection.maxConcurrentRuns, 3);
    assert.equal(parseCfg({ maxConcurrentRuns: 2 }).memoryReflection.maxConcurrentRuns, 2);
    assert.equal(parseCfg({ maxConcurrentRuns: 1.5 }).memoryReflection.maxConcurrentRuns, 1);
    assert.equal(parseCfg({}).memoryReflection.maxConcurrentRuns, 1);
    assert.equal(parseCfg(undefined).memoryReflection.maxConcurrentRuns, 1);

    for (const bad of [0, -1, "three", null]) {
      assert.equal(
        parseCfg({ maxConcurrentRuns: bad }).memoryReflection.maxConcurrentRuns,
        1,
        `invalid value ${String(bad)} must fall back to the default`,
      );
    }
  });

  it("declares the knob in the plugin manifest schema", async () => {
    const { readFile } = await import("node:fs/promises");
    const manifest = JSON.parse(
      await readFile(path.resolve(testDir, "..", "openclaw.plugin.json"), "utf8"),
    );

    const findMemoryReflectionSchema = (node) => {
      if (!node || typeof node !== "object") return undefined;
      const candidate = node.memoryReflection;
      if (candidate && typeof candidate === "object" && candidate.properties) return candidate;
      for (const value of Object.values(node)) {
        const found = findMemoryReflectionSchema(value);
        if (found) return found;
      }
      return undefined;
    };

    const schema = findMemoryReflectionSchema(manifest);
    assert.ok(schema, "memoryReflection schema block must exist in the manifest");
    assert.equal(schema.additionalProperties, false);

    const knob = schema.properties.maxConcurrentRuns;
    assert.ok(knob, "maxConcurrentRuns must be declared (additionalProperties is false)");
    assert.equal(knob.type, "integer");
    assert.equal(knob.minimum, 1);
    assert.equal(knob.default, 1);
  });
});
