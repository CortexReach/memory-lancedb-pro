/**
 * Prompt templates for intelligent memory extraction.
 * Three mandatory prompts:
 * - buildExtractionPrompt: 6-category L0/L1/L2 extraction with few-shot
 * - buildDedupPrompt: CREATE/MERGE/SKIP dedup decision
 * - buildMergePrompt: Memory merge with three-level structure
 * Batched variants (one LLM call per pipeline stage):
 * - buildBatchDedupPrompt: one dedup decision per numbered candidate
 * - buildBatchMergePrompt: one merged record per numbered merge job
 * Consolidate prompts (post-hoc reconciliation of already-stored memories):
 * - buildConsolidatePrompt / buildConsolidateBatchPrompt: merge/supersede/
 *   contradict/skip decider, single-cluster and multi-cluster variants
 * - buildConsolidateBatchMergePrompt: one merged record per numbered
 *   consolidate merge job
 *
 * Each builder returns a {system, user} pair: instructions, criteria,
 * identity, and the output-format contract live in `system`; the per-call
 * conversation excerpt / candidate rows / neighbor rows live in `user`.
 * Static content shared across builders (category taxonomy, identity
 * openers, the candidate/job markdown formatter) is single-sourced in
 * ./prompt-blocks.ts and composed below -- copied prompt text between
 * builders is a defect.
 */

import type { CandidateMemory } from "./memory-categories.js";
import {
  CATEGORY_TAXONOMY,
  DEDUP_JUDGE_IDENTITY,
  EXTRACTION_AGENT_IDENTITY,
  MERGE_WRITER_IDENTITY,
  formatCandidateBlock,
  formatExistingMemoriesSection,
  formatMemoryFieldLines,
  jsonShape,
} from "./prompt-blocks.js";

export interface SplitPrompt {
  system: string;
  user: string;
}

export function buildExtractionPrompt(
  conversationText: string,
  user: string,
): SplitPrompt {
  const assistantLinesRule = `- Assistant lines: in the Recent conversation turns transcript, "Assistant:" lines are provided only to help you understand what the user is referring to (e.g. "yes exactly, that one"). Do NOT create a candidate whose only support is an assistant line — every candidate must be grounded in a user-authored line. The assistant greeting or addressing the user by a name is NOT the user introducing themselves; the assistant proposing, summarizing, or confirming something is NOT the user asserting it. If the user never stated or explicitly confirmed the fact themselves, do not extract it.`;;
  const system = `${EXTRACTION_AGENT_IDENTITY} Analyze session context and extract memories worth long-term preservation.

# Memory Extraction Criteria

## What is worth remembering?
- Personalized information: Information specific to this user, not general domain knowledge
- Long-term validity: Information that will still be useful in future sessions
- Specific and clear: Has concrete details, not vague generalizations

## What is NOT worth remembering?
- General knowledge that anyone would know
- System/platform metadata: message IDs, sender IDs, timestamps, channel info, JSON envelopes (e.g. "System: [timestamp] Feishu...", "message_id", "sender_id", "ou_xxx") — these are infrastructure noise, NEVER extract them
- Temporary information: One-time questions or conversations
- Vague information: "User has questions about a feature" (no specific details)
- Tool output, error logs, or boilerplate
- Runtime scaffolding or orchestration wrappers such as "[Subagent Context]", "[Subagent Task]", bootstrap wrappers, task envelopes, or agent instructions — these are execution metadata, NEVER store them as memories
- Recall queries / meta-questions: "Do you remember X?", "你还记得X吗?", "你知道我喜欢什么吗" — these are retrieval requests, NOT new information to store
- Degraded or incomplete references: If the user mentions something vaguely ("that thing I said"), do NOT invent details or create a hollow memory
- Raw conversation carryover: quoted or attributed transcript blocks, especially 3+ lines of speaker text, are not memories by themselves. Distill a concrete profile detail, preference, entity state, event, case, or pattern from them or skip.
- System/runtime artifacts: content containing "System:", compaction notices, model-switch/session-reset traces, tool-call transcripts, raw JSON blobs, or similar internal execution traces must be rejected unless a clean user fact can be extracted.
- Fragment blobs: mixed filename shards, code snippets, metadata fields, or partial sentences that look like unprocessed context fragments should be skipped rather than preserved.
${assistantLinesRule}
- Atomic memory shape: each stored memory must read like one durable fact, preference, decision, entity state, event, case, or reusable pattern. If a candidate reads like an excerpt, log, or raw transcript, compress it into one atomic statement or skip it.
- Length/distillation gate: if a candidate is longer than about 200 characters and reads like raw conversation instead of a distilled insight, rewrite it as a single factual statement before storing; if that is not possible, skip it.

# Memory Classification

## Core Decision Logic

| Question | Answer | Category |
|----------|--------|----------|
| Who is the user? | Identity, attributes | profile |
| What does the user prefer? | Preferences, habits | preferences |
| What is this thing? | Person, project, organization | entities |
| What happened? | Decision, milestone | events |
| How was it solved? | Problem + solution | cases |
| What is the process? | Reusable steps | patterns |

## Precise Definition

**profile** - User identity (static attributes). Test: "User is..."
**preferences** - User preferences (tendencies). Test: "User prefers/likes..."
**entities** - Continuously existing nouns. Test: "XXX's state is..."
**events** - Things that happened. Test: "XXX did/completed..."
**cases** - Problem + solution pairs. Test: Contains "problem -> solution"
**patterns** - Reusable processes. Test: Can be used in "similar situations"

## Common Confusion
- "Plan to do X" -> events (action, not entity)
- "Project X status: Y" -> entities (describes entity)
- "User prefers X" -> preferences (not profile)
- "Encountered problem A, used solution B" -> cases (not events)
- "General process for handling certain problems" -> patterns (not cases)
- "Switched my commute to the M4" / "Spanish lesson before breakfast" -> preferences or patterns, not events: recurring or durable state and habit changes are the user's new normal, not a one-off occurrence. Reserve events for genuinely one-off happenings.

# Conversational Grounding

First judge the register of the WHOLE conversation once, then tag each memory item independently.

## Batch register (one judgment per extraction)

Set the top-level "conversation_register" field:

| conversation_register | Meaning |
|-----------------------|---------|
| "real" | An ordinary working/personal conversation about the actual user and the real world |
| "fiction" | The conversation is inside a constructed frame: a game in progress, roleplay, in-character dialogue, drafted fiction, a hypothetical scenario, or a sample-data exercise |
| "mixed" | A constructed frame AND genuine out-of-character content are interleaved |

## Per-item grounding

Grounding describes the truth-grounding of the ASSERTION ITSELF, not which register the conversation happened in. Ask: is this claim true about the real world, or true only inside the fiction?

Tag every memory's "grounding" field:

| grounding | Meaning |
|-----------|---------|
| "real" | The assertion is about the real world — INCLUDING an assertion ABOUT the fiction (e.g. "user and assistant played a one-round roleplay game where user was Admiral Vex" is a true statement about a real session, even though it describes fictional play). Also covers a genuine first-person aside stated in passing during a game (e.g. "btw my flight is Tuesday") |
| "constructed" | The assertion holds only WITHIN the fiction — true in-character, in-game, or in-story, but not a fact about the real user or the real world (e.g. "user's favorite drink is plasma coffee", a persona's invented backstory, a game's score or rules) |

One-line rule: **about-the-fiction is real; within-the-fiction is constructed.**

Rules:
- Grounding is judged PER ITEM, on that item's own content. There is no expected number of "real" or "constructed" tags per batch: a batch may be all-real, all-constructed, or anything between.
- A session-scoped "events" note that the real participants engaged in a game, roleplay, or other fiction is a REAL assertion — it is a true statement about what happened in the real session, not a claim that lives inside the fiction. Extract it like any other events item, under its natural category, with grounding "real".
- Do NOT lift any in-character proposition — an invented rule, a score, a bet, a persona's claim, a fictional preference or trait — into profile, preferences, entities, cases, or patterns. Such claims are true only within the fiction; if you extract one at all, tag it "constructed" so it is never mistaken for a fact about the real user.
- A real aside spoken during play is still "real" and should be extracted normally under its natural category, even though it occurred inside a constructed register.
- Self-consistency check before answering: an item asserting what happened in the real session (including a session that was itself a game) is "real"; an item asserting a claim that is only true inside the story/game/persona is "constructed". If your draft tags the session-summary note itself as "constructed", re-check — it almost certainly describes a real event and should be "real".
- If you are genuinely unsure about a single item, default to "real" — under-tagging as constructed risks losing a genuine fact.

# Three-Level Structure

Each memory contains three levels:

**abstract (L0)**: One-liner index
- Merge types (preferences/entities/profile/patterns): \`[Merge key]: [Description]\`
- Independent types (events/cases): Specific description

**overview (L1)**: Structured Markdown summary with category-specific headings

**content (L2)**: Full narrative with background and details

# Few-shot Examples

Each example is a full output batch, because register and grounding are judged together.

## Ordinary working conversation (register "real", single memory)
{
  "conversation_register": "real",
  "memories": [
    {
      "category": "cases",
      "abstract": "LanceDB BigInt numeric handling issue",
      "overview": "## Problem\\nLanceDB 0.26+ returns BigInt for numeric columns\\n\\n## Solution\\nCoerce values with Number(...) before arithmetic",
      "content": "When LanceDB returns BigInt values, wrap them with Number() before doing arithmetic operations.",
      "grounding": "real"
    }
  ]
}

## Ordinary personal conversation (register "real", two memories)
{
  "conversation_register": "real",
  "memories": [
    {
      "category": "profile",
      "abstract": "User basic info: AI development engineer, 3 years LLM experience",
      "overview": "## Background\\n- Occupation: AI development engineer\\n- Experience: 3 years LLM development\\n- Tech stack: Python, LangChain",
      "content": "User is an AI development engineer with 3 years of LLM application development experience.",
      "grounding": "real"
    },
    {
      "category": "preferences",
      "abstract": "Python code style: No type hints, concise and direct",
      "overview": "## Preference Domain\\n- Language: Python\\n- Topic: Code style\\n\\n## Details\\n- No type hints\\n- Concise function comments\\n- Direct implementation",
      "content": "User prefers Python code without type hints, with concise function comments.",
      "grounding": "real"
    }
  ]
}

## Mid-game conversation (register "fiction", session note is real; canon is not extracted)
Input was one round of an in-character guessing game where a persona claimed to live on a moon base and named an invented drink.
{
  "conversation_register": "fiction",
  "memories": [
    {
      "category": "events",
      "abstract": "agent-one and agent-two ran a two-round puzzle exercise",
      "overview": "## What happened\\n- Two agents played a puzzle guessing game with invented rules and a bet",
      "content": "agent-one and agent-two ran a two-round puzzle guessing exercise. The house rules, scores, and bet are part of the game, not durable facts.",
      "grounding": "real"
    }
  ]
}
Note: the persona's home, the invented drink, the house rule, and the bet are NOT extracted at all — not as profile, not as preferences, not as entities. This session note is a true statement about a real session (the session happened), so it carries grounding "real" even though the batch register is "fiction" — about-the-fiction is real.

## Game with a genuine out-of-character aside (register "mixed")
{
  "conversation_register": "mixed",
  "memories": [
    {
      "category": "events",
      "abstract": "User mentioned their new laptop arrives Thursday",
      "overview": "## Real-world aside\\n- Stated in passing during a game",
      "content": "In the middle of the game the user mentioned, out of character, that their new laptop arrives Thursday.",
      "grounding": "real"
    },
    {
      "category": "events",
      "abstract": "User and assistant played a riddle game",
      "overview": "## What happened\\n- One riddle game session",
      "content": "User and assistant played a short riddle game this session.",
      "grounding": "real"
    }
  ]
}

# Output Format

Return JSON only (the raw object, no markdown code fences):
${jsonShape(`{
  "conversation_register": "real|mixed|fiction",
  "memories": [
    {
      "category": "profile|preferences|entities|events|cases|patterns",
      "abstract": "One-line index",
      "overview": "Structured Markdown summary",
      "content": "Full narrative",
      "grounding": "real|constructed"
    }
  ]
}`)}

Notes:
- Output language should match the dominant language in the conversation
- Only extract truly valuable personalized information
- If nothing worth recording, return {"conversation_register": "real|mixed|fiction", "memories": []}
- Maximum 5 memories per extraction
- Preferences should be aggregated by topic
- Always set the top-level "conversation_register" field, and tag every memory's "grounding" field, per the Conversational Grounding rules above`;

  const userMessage = `User: ${user}

Target Output Language: auto (detect from recent messages)

## Recent Conversation
\`\`\`
${conversationText}
\`\`\``;

  return { system, user: userMessage };
}

export function buildDedupPrompt(
  candidate: CandidateMemory,
  existingMemories: string,
): SplitPrompt {
  const existingSection = formatExistingMemoriesSection(
    String(existingMemories ?? "")
      .split("\n")
      .filter((line) => line.length > 0),
  );

  const system = `${DEDUP_JUDGE_IDENTITY}

${CATEGORY_TAXONOMY}

Please decide:
- SKIP: Candidate memory duplicates existing memories, no need to save. Also SKIP if the candidate contains LESS information than an existing memory on the same topic (information degradation — e.g., candidate says "programming language preference" but existing memory already says "programming language preference: Python, TypeScript")
- CREATE: This is completely new information not covered by any existing memory, should be created
- MERGE: Candidate memory adds genuinely NEW details to an existing memory and should be merged
- SUPERSEDE: Candidate states that the same mutable fact has changed over time. Keep the old memory as historical but no longer current, and create a new current memory.
- SUPPORT: Candidate reinforces/confirms an existing memory in a specific context (e.g. "still prefers tea in the evening")
- CONTEXTUALIZE: Candidate adds a situational nuance to an existing memory (e.g. existing: "likes coffee", candidate: "prefers tea at night" — different context, same topic)
- CONTRADICT: Candidate directly contradicts an existing memory in a specific context (e.g. existing: "runs on weekends", candidate: "stopped running on weekends")

IMPORTANT:
- "events" and "cases" categories are independent records — they do NOT support MERGE/SUPERSEDE/SUPPORT/CONTEXTUALIZE/CONTRADICT. For these categories, only use SKIP or CREATE.
- Category labels NEVER decide the verdict by themselves. Outside the events/cases rule above, a candidate and an existing memory in DIFFERENT categories (profile, preferences, entities, patterns) can still describe the same fact — judge the CONTENT. If an existing memory in another category already covers the candidate with equal or more detail, SKIP; if the candidate replaces that fact's current truth, SUPERSEDE it.
- If the candidate appears to be derived from a recall question (e.g., "Do you remember X?" / "你记得X吗？") and an existing memory already covers topic X with equal or more detail, you MUST choose SKIP.
- A candidate with less information than an existing memory on the same topic should NEVER be CREATED or MERGED — always SKIP.
- For "preferences" and "entities", use SUPERSEDE when the candidate replaces the current truth instead of adding detail or context. Example: existing "Preferred editor: VS Code", candidate "Preferred editor: Zed".
- For SUPPORT/CONTEXTUALIZE/CONTRADICT, you MUST provide a context_label from this vocabulary: general, morning, evening, night, weekday, weekend, work, leisure, summer, winter, travel.

Return JSON only (the raw object, no markdown code fences):
${jsonShape(`{
  "decision": "skip|create|merge|supersede|support|contextualize|contradict",
  "match_index": 1,
  "reason": "Decision reason",
  "context_label": "evening"
}`)}

- If decision is "merge"/"supersede"/"support"/"contextualize"/"contradict", set "match_index" to the number of the existing memory (1-based).
- Only include "context_label" for support/contextualize/contradict decisions.`;

  const userMessage = `## Candidate

${formatCandidateBlock(1, candidate)}

${existingSection}`;

  return { system, user: userMessage };
}

export function buildMergePrompt(
  existing: { abstract: string; overview: string; content: string },
  addition: CandidateMemory,
): SplitPrompt {
  const system = `${MERGE_WRITER_IDENTITY}

${CATEGORY_TAXONOMY}

Requirements:
- Remove duplicate information
- Keep the most up-to-date details
- Maintain a coherent narrative
- Keep code identifiers / URIs / model names unchanged when they are proper nouns

Return JSON only (the raw object, no markdown code fences):
${jsonShape(`{
  "abstract": "Merged one-line abstract",
  "overview": "Merged structured Markdown overview",
  "content": "Merged full content"
}`)}`;

  const userMessage = `## Merge job

### Existing memory
${formatMemoryFieldLines(existing).join("\n")}

### New information
${formatMemoryFieldLines(addition).join("\n")}`;

  return { system, user: userMessage };
}

export interface BatchDedupItem {
  candidate: CandidateMemory;
  /**
   * Pre-formatted numbered list of THIS candidate's own similar existing
   * memories (the same text the single-call dedup prompt embeds), so every
   * numbered block carries its own retrieved-neighbor context.
   */
  existingMemories: string;
}

/**
 * Batched variant of buildDedupPrompt: one LLM call decides every numbered
 * candidate independently. Verdict vocabulary, rules, and match_index
 * semantics are identical to the single-candidate prompt — only the call
 * topology changes.
 */
export function buildBatchDedupPrompt(items: BatchDedupItem[]): SplitPrompt {
  const system = `${DEDUP_JUDGE_IDENTITY} Decide every candidate independently, using only that candidate's own "Existing similar memories" list — never another candidate's.

${CATEGORY_TAXONOMY}

For each candidate, decide:
- SKIP: Candidate memory duplicates existing memories, no need to save. Also SKIP if the candidate contains LESS information than an existing memory on the same topic (information degradation — e.g., candidate says "programming language preference" but existing memory already says "programming language preference: Python, TypeScript")
- CREATE: This is completely new information not covered by any existing memory, should be created
- MERGE: Candidate memory adds genuinely NEW details to an existing memory and should be merged
- SUPERSEDE: Candidate states that the same mutable fact has changed over time. Keep the old memory as historical but no longer current, and create a new current memory.
- SUPPORT: Candidate reinforces/confirms an existing memory in a specific context (e.g. "still prefers tea in the evening")
- CONTEXTUALIZE: Candidate adds a situational nuance to an existing memory (e.g. existing: "likes coffee", candidate: "prefers tea at night" — different context, same topic)
- CONTRADICT: Candidate directly contradicts an existing memory in a specific context (e.g. existing: "runs on weekends", candidate: "stopped running on weekends")

IMPORTANT:
- "events" and "cases" categories are independent records — they do NOT support MERGE/SUPERSEDE/SUPPORT/CONTEXTUALIZE/CONTRADICT. For these categories, only use SKIP or CREATE.
- Category labels NEVER decide the verdict by themselves. Outside the events/cases rule above, a candidate and an existing memory in DIFFERENT categories (profile, preferences, entities, patterns) can still describe the same fact — judge the CONTENT. If an existing memory in another category already covers the candidate with equal or more detail, SKIP; if the candidate replaces that fact's current truth, SUPERSEDE it.
- If the candidate appears to be derived from a recall question (e.g., "Do you remember X?" / "你记得X吗？") and an existing memory already covers topic X with equal or more detail, you MUST choose SKIP.
- A candidate with less information than an existing memory on the same topic should NEVER be CREATED or MERGED — always SKIP.
- For "preferences" and "entities", use SUPERSEDE when the candidate replaces the current truth instead of adding detail or context. Example: existing "Preferred editor: VS Code", candidate "Preferred editor: Zed".
- For SUPPORT/CONTEXTUALIZE/CONTRADICT, you MUST provide a context_label from this vocabulary: general, morning, evening, night, weekday, weekend, work, leisure, summer, winter, travel.
- "match_index" always refers to the numbering of that candidate's OWN "Existing similar memories" list (1-based), never to another candidate's list and never to the candidate numbering itself.

Return JSON only (the raw object, no markdown code fences), with exactly one entry per candidate, in this shape:
${jsonShape(`{
  "results": [
    { "index": 1, "decision": "skip|create|merge|supersede|support|contextualize|contradict", "match_index": 1, "reason": "Decision reason", "context_label": "evening" }
  ]
}`)}

- "index" is the candidate's number in the batch below.
- If decision is "merge"/"supersede"/"support"/"contextualize"/"contradict", set "match_index" to the number of the matching existing memory (1-based) in that candidate's own list.
- Only include "context_label" for support/contextualize/contradict decisions.`;

  const blocks = items.map((item, i) => {
    const candidateBlock = formatCandidateBlock(i + 1, item.candidate);
    const existingSection = formatExistingMemoriesSection(
      String(item.existingMemories ?? "")
        .split("\n")
        .filter((line) => line.length > 0),
    );
    return existingSection ? `${candidateBlock}\n\n${existingSection}` : candidateBlock;
  });

  const user = `## Candidates

${blocks.join("\n\n")}`;

  return { system, user };
}

export interface BatchMergeJobPrompt {
  category: string;
  existing: { abstract: string; overview: string; content: string };
  /** One or more new-information records to fold into the existing memory. */
  additions: Array<{ abstract: string; overview: string; content: string }>;
}

/**
 * Batched variant of buildMergePrompt: one LLM call writes every numbered
 * merge job. Each job carries its target ("Existing memory") and every
 * candidate merging into it ("New information"); merge requirements are
 * identical to the single-job prompt — only the call topology changes.
 */
export function buildBatchMergePrompt(jobs: BatchMergeJobPrompt[]): SplitPrompt {
  const system = `${MERGE_WRITER_IDENTITY} For each job, merge every "New information" section into that job's "Existing memory"; never mix content across jobs.

${CATEGORY_TAXONOMY}

Requirements:
- Remove duplicate information
- Keep the most up-to-date details
- Maintain a coherent narrative
- Keep code identifiers / URIs / model names unchanged when they are proper nouns

Return JSON only (the raw object, no markdown code fences), with exactly one entry per job, in this shape:
${jsonShape(`{
  "results": [
    { "index": 1, "abstract": "Merged one-line abstract", "overview": "Merged structured Markdown overview", "content": "Merged full content" }
  ]
}`)}

- "index" is the job's number in the batch below.`;

  const blocks = jobs.map((job, i) => {
    const lines = [`### ${i + 1}. ${job.category}`, "", "#### Existing memory", ...formatMemoryFieldLines(job.existing)];
    job.additions.forEach((addition, j) => {
      const heading = job.additions.length > 1 ? `#### New information ${j + 1}` : "#### New information";
      lines.push("", heading, ...formatMemoryFieldLines(addition));
    });
    return lines.join("\n");
  });

  const user = `## Merge jobs

${blocks.join("\n\n")}`;

  return { system, user };
}

