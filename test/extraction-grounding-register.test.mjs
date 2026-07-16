/**
 * Regression tests for grounding-aware extraction (Option A) and the
 * scope-glob extraction-policy knob (Option C).
 *
 * extractCandidates() tags each raw candidate "grounding": "real" | "constructed".
 * A deterministic post-filter drops constructed candidates typed as
 * profile/preferences/entities/cases/patterns, and allows at most one
 * session-scoped "events" note per extraction for a constructed register
 * (game/roleplay/fiction/hypothetical). A genuine first-person aside spoken
 * during play is tagged "real" and must survive under its natural category.
 *
 * Fixtures are entirely synthetic (agent-one/agent-two, invented game
 * content) — no real fleet data.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { SmartExtractor, resolveExtractionPolicy } = jiti("../src/smart-extractor.ts");

// ============================================================================
// Helpers
// ============================================================================

/**
 * One-hot embedder keyed by a text hash. Distinct abstracts land on distinct
 * dimensions, so cosine similarity between any two different fixture texts is
 * 0 — this keeps Step 1b's batch-internal dedup (threshold 0.85) from
 * accidentally collapsing genuinely-different candidates in these tests.
 * (A naive char-code-based mock makes short English strings look >0.85
 * "similar" to each other purely from shared letter frequency — verified
 * against this file's fixtures before choosing this approach.)
 */
function hashToIndex(text, dims) {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (h * 31 + text.charCodeAt(i)) >>> 0;
  }
  return h % dims;
}

function makeEmbedder(dims = 97) {
  const embed = async (text) => {
    const v = new Array(dims).fill(0);
    v[hashToIndex(text || "", dims)] = 1;
    return v;
  };
  return {
    embed,
    async embedBatch(texts) {
      return Promise.all((texts || []).map((t) => embed(t)));
    },
  };
}

/**
 * `memories` is the raw memories array the mocked "extract-candidates" LLM
 * call returns; `conversationRegister` (optional) is the batch-level
 * conversation_register field — omitted to simulate legacy payloads.
 */
function makeLlm(memories, conversationRegister) {
  let extractCandidatesCalls = 0;
  return {
    async completeJson(_prompt, mode) {
      if (mode !== "extract-candidates") return null;
      extractCandidatesCalls++;
      return conversationRegister
        ? { conversation_register: conversationRegister, memories }
        : { memories };
    },
    get extractCandidatesCalls() {
      return extractCandidatesCalls;
    },
  };
}

function makeStore() {
  const bulkStoreCalls = [];
  return {
    async vectorSearch() { return []; },
    async store(entry) { return entry; },
    async bulkStore(entries) {
      bulkStoreCalls.push(entries);
      return entries;
    },
    async update() {},
    async getById() { return null; },
    get bulkStoreCalls() { return bulkStoreCalls; },
  };
}

function makeExtractor(embedder, llm, store, config = {}) {
  return new SmartExtractor(store, embedder, llm, {
    user: "User",
    extractMinMessages: 1,
    extractMaxChars: 8000,
    defaultScope: "global",
    log() {},
    debugLog() {},
    ...config,
  });
}

/** Flatten every category persisted across this extraction's bulkStore call(s), in order. */
function persistedCategories(store) {
  return store.bulkStoreCalls.flat().map((entry) => {
    const meta = JSON.parse(entry.metadata || "{}");
    return meta.memory_category;
  });
}

// ============================================================================
// Fixtures — synthetic two-agent transcript, invented game content
// ============================================================================

const GAME_TRANSCRIPT = [
  "agent-one: let's play a two-round puzzle guessing game, loser buys drinks",
  "agent-two: deal, I'll set the rule: the answer is always an even number",
  "agent-one: round 1 answer is 42",
  "agent-two: round 2 answer is 8, I win the bet",
].join("\n");

const GAME_CANDIDATES = [
  {
    category: "preferences",
    abstract: "House rule: puzzle answers must be even numbers",
    overview: "## Rule\n- Even numbers only",
    content: "agent-two's puzzle house rule is that answers must always be even numbers.",
    grounding: "constructed",
  },
  {
    category: "cases",
    abstract: "Puzzle round 2 answer was 8",
    overview: "## Answer\n- 8",
    content: "The round 2 puzzle answer was 8, so agent-two won the bet.",
    grounding: "constructed",
  },
  {
    category: "events",
    abstract: "agent-one and agent-two ran a two-round puzzle exercise",
    overview: "## What happened\n- Two agents played a puzzle guessing game",
    content: "agent-one and agent-two ran a two-round puzzle guessing exercise with an invented house rule and a bet.",
    grounding: "constructed",
  },
];

const REAL_ASIDE_CANDIDATE = {
  category: "events",
  abstract: "operators new laptop arrives Thursday",
  overview: "## Real-world aside\n- New laptop arrives Thursday",
  content: "In the middle of the puzzle game, the operator mentioned their new laptop arrives Thursday.",
  grounding: "real",
};

const FACTUAL_CANDIDATES = [
  {
    category: "preferences",
    abstract: "Python code style: no type hints, concise",
    overview: "## Preference\n- No type hints",
    content: "User prefers Python code without type hints.",
    grounding: "real",
  },
  {
    category: "profile",
    abstract: "User basic info: backend engineer",
    overview: "## Background\n- Backend engineer",
    content: "User is a backend engineer.",
    // no grounding field at all — regression guard for the default extraction path
  },
];

// ============================================================================
// Option A — grounding-aware extraction
// ============================================================================

describe("SmartExtractor grounding-aware extraction (Option A)", () => {
  it("drops constructed non-events candidates from a game transcript, keeping only the episodic events note", async () => {
    const store = makeStore();
    const llm = makeLlm(GAME_CANDIDATES);
    const extractor = makeExtractor(makeEmbedder(), llm, store);

    const stats = await extractor.extractAndPersist(GAME_TRANSCRIPT, "s1");

    const categories = persistedCategories(store);
    assert.deepEqual(categories, ["events"], "only the single constructed-but-episodic events note should survive");
    assert.equal(stats.created, 1);
  });

  it("caps constructed events notes at one per extraction", async () => {
    const store = makeStore();
    const twoEventsNotes = [
      GAME_CANDIDATES[2],
      {
        ...GAME_CANDIDATES[2],
        abstract: "agent-one and agent-two also played a second puzzle round",
      },
    ];
    const llm = makeLlm(twoEventsNotes);
    const extractor = makeExtractor(makeEmbedder(), llm, store);

    const stats = await extractor.extractAndPersist(GAME_TRANSCRIPT, "s1");

    const categories = persistedCategories(store);
    assert.equal(categories.length, 1, "only the first constructed events note should survive the cap");
    assert.equal(stats.created, 1);
  });

  it("keeps a genuine real first-person aside stated during play (false-positive guard)", async () => {
    const store = makeStore();
    const llm = makeLlm([...GAME_CANDIDATES, REAL_ASIDE_CANDIDATE]);
    const extractor = makeExtractor(makeEmbedder(), llm, store);

    await extractor.extractAndPersist(GAME_TRANSCRIPT, "s1");

    const abstracts = store.bulkStoreCalls.flat().map((e) => e.text);
    assert.ok(
      abstracts.some((a) => a.includes("laptop arrives Thursday")),
      "the real aside must survive even though it was stated during a constructed register",
    );
    // The constructed episodic note + the real aside both land as "events".
    const categories = persistedCategories(store);
    assert.equal(categories.filter((c) => c === "events").length, 2);
    assert.equal(categories.length, 2, "constructed non-events candidates must still be dropped");
  });

  it("leaves a purely factual transcript unchanged (regression guard)", async () => {
    const store = makeStore();
    const llm = makeLlm(FACTUAL_CANDIDATES);
    const extractor = makeExtractor(makeEmbedder(), llm, store);

    const stats = await extractor.extractAndPersist("some factual conversation", "s1");

    assert.equal(stats.created, 2, "both real/default-real candidates must be extracted, unchanged from current behavior");
    const categories = persistedCategories(store).sort();
    assert.deepEqual(categories, ["preferences", "profile"].sort());
  });

  it("fails open to 'real' for a malformed/missing grounding field", async () => {
    const store = makeStore();
    const llm = makeLlm([
      { category: "preferences", abstract: "Prefers dark mode UI themes", overview: "", content: "User prefers dark mode.", grounding: 12345 },
      { category: "entities", abstract: "Project Foo status: active", overview: "", content: "Project Foo is active.", grounding: "unsure" },
    ]);
    const extractor = makeExtractor(makeEmbedder(), llm, store);

    const stats = await extractor.extractAndPersist("some conversation", "s1");

    assert.equal(stats.created, 2, "non-string/unrecognized grounding values must fail open to 'real' and be kept");
  });

  it("buildExtractionPrompt documents the grounding contract (structural check)", async () => {
    const { buildExtractionPrompt } = jiti("../src/extraction-prompts.ts");
    const prompt = buildExtractionPrompt("some conversation", "test-user");

    assert.match(prompt, /grounding/i);
    assert.match(prompt, /"real"\s*\|\s*"constructed"|real.*constructed/i);
    assert.match(prompt, /at most one/i);
  });
});

// ============================================================================
// Option C — scope-glob extraction policy knob
// ============================================================================

describe("SmartExtractor scope-glob extraction policy (Option C)", () => {
  it("resolveExtractionPolicy: exact match wins over glob, unmatched scope defaults to full", () => {
    const policy = { "play/*": "none", "play/exact-room": "episodic-only" };
    assert.equal(resolveExtractionPolicy("play/exact-room", policy), "episodic-only");
    assert.equal(resolveExtractionPolicy("play/other-room", policy), "none");
    assert.equal(resolveExtractionPolicy("work/room", policy), "full");
    assert.equal(resolveExtractionPolicy("anything", undefined), "full");
  });

  it("scope mapped 'none' skips extraction entirely with zero LLM calls", async () => {
    const store = makeStore();
    const llm = makeLlm(GAME_CANDIDATES);
    const extractor = makeExtractor(makeEmbedder(), llm, store, {
      extractionPolicy: { "play/*": "none" },
    });

    const stats = await extractor.extractAndPersist(GAME_TRANSCRIPT, "s1", { scope: "play/room-1" });

    assert.equal(llm.extractCandidatesCalls, 0, "no LLM call should be made for a 'none'-policy scope");
    assert.deepEqual(stats, { created: 0, merged: 0, skipped: 0, boundarySkipped: 0 });
  });

  it("scope mapped 'episodic-only' keeps only events-class candidates, independent of grounding", async () => {
    const store = makeStore();
    const llm = makeLlm(FACTUAL_CANDIDATES.concat([{
      category: "events",
      abstract: "User shipped the v2 release",
      overview: "",
      content: "User shipped the v2 release.",
      grounding: "real",
    }]));
    const extractor = makeExtractor(makeEmbedder(), llm, store, {
      extractionPolicy: { "play/*": "episodic-only" },
    });

    await extractor.extractAndPersist("some conversation", "s1", { scope: "play/room-1" });

    const categories = persistedCategories(store);
    assert.deepEqual(categories, ["events"], "only events-class candidates should survive under episodic-only policy");
  });

  it("unmatched scope leaves extraction behavior unchanged ('full')", async () => {
    const store = makeStore();
    const llm = makeLlm(FACTUAL_CANDIDATES);
    const extractor = makeExtractor(makeEmbedder(), llm, store, {
      extractionPolicy: { "play/*": "none" },
    });

    const stats = await extractor.extractAndPersist("some factual conversation", "s1", { scope: "work/room" });

    assert.equal(llm.extractCandidatesCalls, 1);
    assert.equal(stats.created, 2);
  });
});

// ============================================================================
// Grounding v2 — batch register signal, contradiction check, propagation,
// grounding-aware admission
// ============================================================================

/** Fiction-frame durables the extractor mislabeled as "real" (Mode A shape). */
const MISLABELED_FICTION_CANDIDATES = [
  {
    category: "profile",
    abstract: "User lives in Moon Base 9",
    overview: "## Background\n- Residence: Moon Base 9",
    content: "User lives in Moon Base 9.",
    grounding: "real", // wrong: asserted only inside the game canon
  },
  {
    category: "preferences",
    abstract: "Favorite drink is nebula tea",
    overview: "## Preference\n- Drink: nebula tea",
    content: "User's favorite drink is nebula tea.",
    grounding: "real", // wrong: asserted only inside the game canon
  },
  {
    category: "events",
    abstract: "User and assistant played one round of a space roleplay game",
    overview: "## What happened\n- One roleplay round",
    content: "User and assistant played one round of a space roleplay game this session.",
    grounding: "constructed",
  },
];

describe("SmartExtractor batch register signal (grounding v2)", () => {
  it("register 'fiction' drops ALL durable candidates even when their per-item tags say 'real'", async () => {
    const store = makeStore();
    const llm = makeLlm(MISLABELED_FICTION_CANDIDATES, "fiction");
    const extractor = makeExtractor(makeEmbedder(), llm, store);

    const stats = await extractor.extractAndPersist(GAME_TRANSCRIPT, "s1");

    const categories = persistedCategories(store);
    assert.deepEqual(
      categories,
      ["events"],
      "mislabeled real-tagged durables must not survive a fiction-register batch",
    );
    assert.equal(stats.created, 1);
  });

  it("register 'fiction' caps events notes at one, regardless of per-item tags", async () => {
    const store = makeStore();
    const llm = makeLlm(
      [
        MISLABELED_FICTION_CANDIDATES[2],
        {
          ...MISLABELED_FICTION_CANDIDATES[2],
          abstract: "User and assistant also played a bonus round",
          grounding: "real", // tag wobble: still capped by the register rule
        },
      ],
      "fiction",
    );
    const extractor = makeExtractor(makeEmbedder(), llm, store);

    await extractor.extractAndPersist(GAME_TRANSCRIPT, "s1");

    assert.equal(persistedCategories(store).length, 1);
  });

  it("register 'mixed' with a constructed sibling demotes real-tagged durables (batch contradiction check)", async () => {
    const store = makeStore();
    const llm = makeLlm(
      [
        MISLABELED_FICTION_CANDIDATES[0], // profile tagged real
        MISLABELED_FICTION_CANDIDATES[2], // events tagged constructed — the contradiction evidence
        REAL_ASIDE_CANDIDATE, // real events aside must still survive
      ],
      "mixed",
    );
    const extractor = makeExtractor(makeEmbedder(), llm, store);

    await extractor.extractAndPersist(GAME_TRANSCRIPT, "s1");

    const categories = persistedCategories(store);
    assert.ok(!categories.includes("profile"), "real-tagged durable must be demoted in a mixed-register batch with constructed siblings");
    assert.equal(categories.filter((c) => c === "events").length, 2, "both events notes (constructed episodic + real aside) survive");
  });

  it("register 'real' fully trusts per-item tags (durables kept alongside a constructed events note)", async () => {
    const store = makeStore();
    const llm = makeLlm(
      [FACTUAL_CANDIDATES[0], MISLABELED_FICTION_CANDIDATES[2]],
      "real",
    );
    const extractor = makeExtractor(makeEmbedder(), llm, store);

    await extractor.extractAndPersist("mostly factual conversation with a brief game", "s1");

    const categories = persistedCategories(store).sort();
    assert.deepEqual(categories, ["events", "preferences"], "register 'real' must not demote per-item-real durables");
  });

  it("missing register (legacy payload) with no constructed tags behaves exactly as before", async () => {
    const store = makeStore();
    const llm = makeLlm(FACTUAL_CANDIDATES); // no conversation_register field
    const extractor = makeExtractor(makeEmbedder(), llm, store);

    const stats = await extractor.extractAndPersist("some factual conversation", "s1");

    assert.equal(stats.created, 2, "legacy payloads (no register, no constructed tags) must be unaffected");
  });

  it("missing register (legacy payload) WITH a constructed sibling still arms the batch-wide durable wipe", async () => {
    // Complements the test above: a missing/malformed register defaults to "mixed" (not
    // "real"), and — unlike the no-constructed-tags case — a genuinely constructed sibling
    // in the same batch is enough to arm the same wipe a "fiction"/"mixed" register would.
    // This is the compound path a malformed extraction response could realistically hit
    // (a legacy or dropped conversation_register field alongside a real constructed note),
    // which the existing per-register tests don't individually cover.
    const store = makeStore();
    const llm = makeLlm([...FACTUAL_CANDIDATES, MISLABELED_FICTION_CANDIDATES[2]]); // no conversation_register field
    const extractor = makeExtractor(makeEmbedder(), llm, store);

    const stats = await extractor.extractAndPersist(GAME_TRANSCRIPT, "s1");

    const categories = persistedCategories(store);
    assert.deepEqual(
      categories,
      ["events"],
      "a constructed sibling arms the wipe even when conversation_register is missing entirely",
    );
    assert.equal(stats.created, 1);
  });

  it("propagates grounding and conversation_register into stored metadata", async () => {
    const store = makeStore();
    const llm = makeLlm(
      [FACTUAL_CANDIDATES[0], MISLABELED_FICTION_CANDIDATES[2]],
      "real",
    );
    const extractor = makeExtractor(makeEmbedder(), llm, store);

    await extractor.extractAndPersist("mostly factual conversation with a brief game", "s1");

    const metas = store.bulkStoreCalls.flat().map((e) => JSON.parse(e.metadata || "{}"));
    const prefMeta = metas.find((m) => m.memory_category === "preferences");
    const eventsMeta = metas.find((m) => m.memory_category === "events");
    assert.equal(prefMeta.grounding, "real");
    assert.equal(prefMeta.conversation_register, "real");
    assert.equal(eventsMeta.grounding, "constructed");
    assert.equal(eventsMeta.conversation_register, "real");
  });

  it("buildExtractionPrompt documents the batch register contract (structural check)", () => {
    const { buildExtractionPrompt } = jiti("../src/extraction-prompts.ts");
    const prompt = buildExtractionPrompt("some conversation", "test-user");

    assert.match(prompt, /conversation_register/);
    assert.match(prompt, /"real\|mixed\|fiction"/);
    assert.match(prompt, /storage rule applied after tagging/i, "the cap must be framed as a storage rule, not a tagging quota");
    assert.match(prompt, /all-constructed batch/i, "all-constructed batches must be documented as normal");
    assert.match(prompt, /self-consistency/i, "the batch self-consistency instruction must be present");
  });
});

describe("AdmissionController grounding awareness (grounding v2)", () => {
  const { AdmissionController, ADMISSION_CONTROL_PRESETS, scoreGroundedTypePrior } = jiti("../src/admission-control.ts");
  const balanced = ADMISSION_CONTROL_PRESETS.balanced;

  function makeAdmissionLlm() {
    let utilityCalls = 0;
    return {
      async completeJson(_prompt, mode) {
        if (mode === "admission-utility") {
          utilityCalls++;
          return { utility: 0.9, reason: "mock" };
        }
        return null;
      },
      get utilityCalls() {
        return utilityCalls;
      },
    };
  }

  const admissionStore = { async vectorSearch() { return []; } };

  it("short-circuits constructed durable candidates to reject with zero LLM calls", async () => {
    const llm = makeAdmissionLlm();
    const controller = new AdmissionController(admissionStore, llm, balanced);

    const evaluation = await controller.evaluate({
      candidate: {
        category: "preferences",
        abstract: "House rule: puzzle answers must be even numbers",
        overview: "## Rule\n- Even numbers only",
        content: "The puzzle house rule is that answers must always be even numbers.",
        grounding: "constructed",
        conversationRegister: "fiction",
      },
      candidateVector: [1, 0, 0],
      conversationText: GAME_TRANSCRIPT,
      scopeFilter: ["global"],
    });

    assert.equal(evaluation.decision, "reject");
    assert.equal(llm.utilityCalls, 0, "the short-circuit must not spend an LLM call");
    assert.match(evaluation.audit.reason, /constructed-grounding/);
    assert.equal(evaluation.audit.grounding, "constructed");
    assert.equal(evaluation.audit.conversation_register, "fiction");
  });

  it("constructed events candidates still go through normal scoring (only durables short-circuit)", async () => {
    const llm = makeAdmissionLlm();
    const controller = new AdmissionController(admissionStore, llm, balanced);

    const evaluation = await controller.evaluate({
      candidate: {
        category: "events",
        abstract: "User and assistant played one round of a space roleplay game",
        overview: "## What happened\n- One roleplay round",
        content: "User and assistant played one round of a space roleplay game this session.",
        grounding: "constructed",
        conversationRegister: "fiction",
      },
      candidateVector: [1, 0, 0],
      conversationText: GAME_TRANSCRIPT,
      scopeFilter: ["global"],
    });

    assert.equal(llm.utilityCalls, 1, "events candidates use the normal scoring path");
    assert.equal(evaluation.audit.grounding, "constructed");
  });

  it("scoreGroundedTypePrior caps durable priors at the events prior for fiction-register candidates", () => {
    const priors = balanced.typePriors;
    const fictionProfile = {
      category: "profile",
      abstract: "x",
      overview: "",
      content: "",
      grounding: "real",
      conversationRegister: "fiction",
    };
    const realProfile = { ...fictionProfile, conversationRegister: "real" };

    assert.equal(scoreGroundedTypePrior(fictionProfile, priors), priors.events, "fiction register must cap the profile prior at the events prior");
    assert.equal(scoreGroundedTypePrior(realProfile, priors), priors.profile, "real register keeps the raw prior");
  });

  it("buildUtilityPrompt interpolates grounding and names all six registers (structural check)", async () => {
    const llm = {
      prompts: [],
      async completeJson(prompt, mode) {
        if (mode === "admission-utility") {
          this.prompts.push(prompt);
          return { utility: 0.5, reason: "mock" };
        }
        return null;
      },
    };
    const controller = new AdmissionController(admissionStore, llm, balanced);

    await controller.evaluate({
      candidate: {
        category: "events",
        abstract: "User and assistant played one round of a space roleplay game",
        overview: "",
        content: "One roleplay round happened.",
        grounding: "constructed",
        conversationRegister: "fiction",
      },
      candidateVector: [1, 0, 0],
      conversationText: GAME_TRANSCRIPT,
      scopeFilter: ["global"],
    });

    assert.equal(llm.prompts.length, 1);
    const prompt = llm.prompts[0];
    assert.match(prompt, /Grounding: constructed/);
    assert.match(prompt, /Conversation register: fiction/);
    for (const register of ["profile", "preferences", "entities", "events", "cases", "patterns"]) {
      assert.match(prompt, new RegExp(register), `utility prompt must name the ${register} register`);
    }
    assert.match(prompt, /roleplay/i, "utility prompt must carry the fiction guidance");
  });
});
