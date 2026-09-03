/**
 * Prompt templates for intelligent memory extraction.
 * - buildExtractionPrompt: 6-category L0/L1/L2 extraction with conversational grounding
 * - buildGroundingRejudgePrompt: scoped second pass reconciling register vs per-item tags
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
import { CATEGORY_TAXONOMY, DEDUP_JUDGE_IDENTITY, EXTRACTION_AGENT_IDENTITY, MERGE_WRITER_IDENTITY, formatCandidateBlock, formatExistingMemoriesSection, formatMemoryFieldLines, jsonShape, } from "./prompt-blocks.js";
export function buildExtractionPrompt(conversationText, user, options = {}) {
    // Transcript modes, driven by captureAssistant:
    // - assistantEligible (captureAssistant=true): assistant blocks appear in
    //   the transcript AND are valid grounding sources, with attribution rules.
    // - default (captureAssistant=false): assistant lines are excluded from the
    //   transcript entirely, so the prompt does not describe assistant blocks
    //   at all.
    const assistantEligible = options.assistantEligible === true;
    const assistantFormatBullet = assistantEligible
        ? `
- <assistant_message>...</assistant_message> wraps ONE message written by the AI assistant.`
        : "";
    const userGroundingSuffix = assistantEligible ? "" : " Memories may only be grounded here.";
    const assistantBlocksRule = assistantEligible
        ? `
- <assistant_message> blocks: also valid sources — but only for concrete facts the user did not correct. Skip the assistant's greetings, guesses, and self-description.
- Attribute every memory to whoever actually said it. When both said it, use the <user_message> version.`
        : "";
    const system = `${EXTRACTION_AGENT_IDENTITY} Analyze session context and extract memories worth long-term preservation.

## Transcript format
The conversation is a sequence of tagged blocks in chronological order:
- <user_message>...</user_message> wraps ONE message written by the human user.${userGroundingSuffix}${assistantFormatBullet}

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
- Raw conversation carryover: quoted or attributed transcript blocks, especially 3+ lines of speaker text, are not memories by themselves. Distill a concrete profile detail, preference, entity state, event, case, or pattern from them, or skip.
- System/runtime artifacts: content containing "System:", compaction notices, model-switch/session-reset traces, tool-call transcripts, raw JSON blobs, or similar internal execution traces must be rejected unless a clean user fact can be extracted.
- Fragment blobs: mixed filename shards, code snippets, metadata fields, or partial sentences that look like unprocessed context fragments should be skipped rather than preserved.${assistantBlocksRule}
- Atomic memory shape: each stored memory must read like one durable fact, preference, decision, entity state, event, case, or reusable pattern. If a candidate reads like an excerpt, log, or raw transcript, compress it into one atomic statement, or skip it.
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
- "Switched my commute to the M4" / "Spanish lesson before breakfast" -> preferences or patterns, not events: a change that creates a new routine or a lasting state is the user's new normal, not a one-off occurrence. Reserve events for genuinely one-off happenings.

# Conversational Grounding

A conversation carries two kinds of content. Factual content is actual, real, and certain — it describes the actual user and the real world. Hypothetical content is supposed, imagined, speculative, conjectural, or fictional — it holds only inside a "what if", a premise, a thought experiment, or a made-up situation. Never store hypothetical content as a fact about the user.

Judge grounding in two steps: first judge the register of the whole conversation and mark its hypothetical stretches; then tag each memory item on its own.

## Step 1 — Conversation register and its stretches

Judge the register over the whole conversation you just read. It is a property of the conversation, not of any single message. Set the top-level "conversation_register" field.

| conversation_register | Meaning |
|-----------------------|---------|
| "real" | Every part is factual: about the actual user and the real world. |
| "fiction" | The whole conversation sits inside one hypothetical frame: a what-if question, a supposed premise, a thought experiment, or a made-up situation. |
| "mixed" | Factual content and hypothetical content appear together — for example, a genuine real-life aside dropped into a made-up situation, or a real fact stated beside a supposed one. |

The label "fiction" covers every hypothetical frame, not only openly invented ones. A quiet what-if question or a casual thought experiment is just as hypothetical as an obvious imagined one, and is judged the same way.

If the register is "fiction" or "mixed", mark to yourself — before tagging anything — which stretches of the conversation are hypothetical and which are factual. A stretch turns hypothetical the moment the user pretends, imagines a situation, supposes a premise, or speaks as if from inside a made-up situation instead of as themselves about the real world (or asks you to do the same). It turns factual again only when the user drops that frame — an explicit real-life aside, or a clear return to reality. Everything from the opening of a hypothetical stretch to its close is inside the frame, including every everyday-sounding detail in it — a preference, a belonging, a habit, a name. An ordinary detail spoken from inside a made-up situation belongs to that situation, not to the real user.

## Step 2 — Per-item grounding (one tag per memory)

If conversation_register is "real", the whole conversation is factual: tag every memory "real" and extract normally, exactly as you would with no frame at all. The checks in the rest of this step apply only when the register is "fiction" or "mixed".

Grounding is about the CLAIM itself, not about how factual it sounds. Tag every memory's "grounding" field.

For each item, find the stretch of conversation the claim comes from.
- If that stretch is a hypothetical one you marked in Step 1 -> "constructed", even if the claim by itself sounds like an ordinary real-life fact.
- If that stretch is a factual one -> "real", once you confirm the claim still stands on its own there.

| grounding | Meaning |
|-----------|---------|
| "real" | The claim comes from a factual stretch and is true about the real user or the real world on its own. |
| "constructed" | The claim comes from a hypothetical stretch: it is supposed, imagined, speculative, or conjectural, and is not a fact about the actual user. |

One-line rule: **about-the-hypothetical is real; within-the-hypothetical is constructed.**

Rules:
- The premise of a question is not a fact. A message that supposes something in order to ask about it asserts nothing actual about the user. Tag anything taken from the premise "constructed".
- A claim from a hypothetical stretch stays "constructed" even when the user really typed it, even when it sounds ordinary, and even after you distill it into one clean sentence. Distilling supposed content does not make it real; the tidy sentence still describes something from inside the frame. Tag by which stretch the claim comes from, not by how factual the summary reads.
- Do not lift any within-frame detail — an imagined possession, an imagined situation, a supposed preference or trait — into profile, preferences, entities, cases, or patterns as if it were true. If you record it at all, tag it "constructed".
- Do not store a generalized taste for the made-up. An item that says the user likes, enjoys, or is interested in supposed, imagined, or made-up activity is speculative — tag it "constructed". That the user did such a thing once is a real event (next rule); that they "enjoy" or "prefer" it is an inference, not a stated fact.
- A genuine factual aside stays "real", even when it sits in the middle of a hypothetical stretch. Extract it normally under its natural category. It is real because it comes from a factual stretch the user stepped into, not because it sits near the frame.
- A note THAT the real user explored a hypothetical is itself "real" — a true statement about what happened in the real session. Record it as an "events" item with grounding "real". Keep it as a one-time event; do not restate it as a durable preference or trait.
- If you are genuinely unsure about a single item, default to "constructed". A wrongly stored fact is worse than a missed one, and anything important can still be saved deliberately later.

Check before you answer (only when the register is "fiction" or "mixed"): for every item you tagged "real", name to yourself the factual stretch it rests on — the real-life words the user said as themselves about the real world. If you cannot name one, change it to "constructed". Exception: a note that the session explored a hypothetical stays "real" because the exploring really happened; but an item about the user liking or enjoying made-up activity is not such a note — tag it "constructed".

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
Note: the persona's home, the invented drink, the house rule, and the bet are NOT extracted at all — not as profile, not as preferences, not as entities. This session note is a true statement about a real session (the session happened), so it carries grounding "real" even though the batch register is "fiction" — about-the-hypothetical is real.

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
- If nothing is worth recording, return {"conversation_register": "real|mixed|fiction", "memories": []}
- Maximum 5 memories per extraction
- Preferences should be aggregated by topic
- Always set the top-level "conversation_register" field, and tag every memory's "grounding" field, per the Conversational Grounding rules above`;
    // "User: User" with a generic identity confused live agents; the name line
    // only appears when a real name is configured.
    const userNameLine = user && user !== "User" ? `User: ${user}\n\n` : "";
    const userMessage = `${userNameLine}Target Output Language: auto (detect from recent messages)

Read the conversation below in chronological order, top to bottom, and understand it as a whole before extracting anything. Interpret every message through your understanding of the full conversation, not in isolation.

${assistantEligible
        ? "Extract memory candidates from <user_message> and <assistant_message> blocks, attributed to their true speaker."
        : "Extract memory candidates ONLY from <user_message> blocks."}

## Recent Conversation
${conversationText}`;
    return { system, user: userMessage };
}
export function buildDedupPrompt(candidate, existingMemories) {
    const existingSection = formatExistingMemoriesSection(String(existingMemories ?? "")
        .split("\n")
        .filter((line) => line.length > 0));
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
export function buildMergePrompt(existing, addition) {
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
/**
 * Scoped second pass fired only when the extraction's register verdict and its
 * per-item grounding tags are incoherent (e.g. register says fiction exists but
 * no item is tagged constructed), or when real-tagged durables sit beside
 * constructed siblings. One call; its verdict is final. The doctrine leads;
 * the conversation, first-pass register, and candidate rows follow as data
 * sections (composed into one string — this build has no system/user split).
 */
export function buildGroundingRejudgePrompt(conversationText, conversationRegister, candidates) {
    // The reviewer judges the conversation as one whole; the extractor's
    // context-vs-new distinction is noise here. Normalize the context tags to
    // the plain speaker tags so no "context" concept reaches the judge.
    const reviewTranscript = conversationText
        .replaceAll("<context_only_user_turn>", "<user_message>")
        .replaceAll("</context_only_user_turn>", "</user_message>")
        .replaceAll("<context_only_assistant_turn>", "<assistant_message>")
        .replaceAll("</context_only_assistant_turn>", "</assistant_message>");
    const candidateList = candidates
        .map((c) => `${c.index}. [${c.category}] (first-pass grounding: "${c.grounding}")\n   Abstract: ${c.abstract}\n   Content: ${c.content}`)
        .join("\n");
    const system = `You are a grounding reviewer for a memory system. A first pass read a conversation, judged its register, and tagged each candidate memory's grounding. The register and the grounding tags do not fit together, so you must re-judge them. Your verdict is final.

Factual content is actual, real, and certain — it describes the actual user and the real world. Hypothetical content is supposed, imagined, speculative, conjectural, or fictional — it holds only inside a "what if", a premise, a thought experiment, or a made-up situation.

## How to judge

1. Re-judge the register of the WHOLE conversation:
   - "real": every part is factual.
   - "fiction": the whole conversation sits inside one hypothetical frame.
   - "mixed": factual and hypothetical content appear together.
   Mark to yourself which stretches of the conversation are hypothetical and which are factual. A stretch turns hypothetical the moment the user pretends, imagines a situation, supposes a premise, or speaks as if from inside a made-up situation; it turns factual again only when the user drops that frame.

2. Re-tag each candidate's grounding by the stretch its claim comes from:
   - "real": the claim comes from a factual stretch — the user said it as themselves, about the real world. Name that stretch to yourself; if you cannot, the tag is "constructed".
   - "constructed": the claim comes from a hypothetical stretch — including the premise of a what-if question, and everyday-sounding details spoken from inside a made-up situation.
   One-line rule: about-the-hypothetical is real; within-the-hypothetical is constructed. A note THAT the user explored a hypothetical is "real"; every claim living INSIDE the hypothetical is "constructed".
   If you are genuinely unsure about an item, tag it "constructed" — a wrongly stored fact is worse than a missed one.

## Output

Return JSON only (the raw object, no markdown code fences):
{
  "conversation_register": "real|mixed|fiction",
  "results": [
    { "index": 1, "grounding": "real|constructed", "reason": "one short sentence naming the stretch the claim rests on" }
  ]
}

Include every candidate index exactly once.`;
    const user = `## Conversation
${reviewTranscript}

## First-pass register
"${conversationRegister}"

## Candidate memories
${candidateList}`;
    return `${system}\n\n${user}`;
}
/**
 * Batched variant of buildDedupPrompt: one LLM call decides every numbered
 * candidate independently. Verdict vocabulary, rules, and match_index
 * semantics are identical to the single-candidate prompt — only the call
 * topology changes.
 */
export function buildBatchDedupPrompt(items) {
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
        const existingSection = formatExistingMemoriesSection(String(item.existingMemories ?? "")
            .split("\n")
            .filter((line) => line.length > 0));
        return existingSection ? `${candidateBlock}\n\n${existingSection}` : candidateBlock;
    });
    const user = `## Candidates

${blocks.join("\n\n")}`;
    return { system, user };
}
/**
 * Batched variant of buildMergePrompt: one LLM call writes every numbered
 * merge job. Each job carries its target ("Existing memory") and every
 * candidate merging into it ("New information"); merge requirements are
 * identical to the single-job prompt — only the call topology changes.
 */
export function buildBatchMergePrompt(jobs) {
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
