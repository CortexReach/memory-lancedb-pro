/**
 * Prompt templates for intelligent memory extraction.
 * Three mandatory prompts:
 * - buildExtractionPrompt: 6-category L0/L1/L2 extraction with few-shot
 * - buildDedupPrompt: CREATE/MERGE/SKIP dedup decision
 * - buildMergePrompt: Memory merge with three-level structure
 */
export function buildExtractionPrompt(conversationText, user) {
    return `Analyze the following session context and extract memories worth long-term preservation.

User: ${user}

Target Output Language: auto (detect from recent messages)

## Recent Conversation
${conversationText}

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
- Raw conversation carryover: quoted or attributed transcript blocks, especially 3+ lines of speaker text, are not memories by themselves. Distill a concrete profile fact, preference, entity state, event, case, or pattern from them or skip.
- System/runtime artifacts: content containing "System:", compaction notices, model-switch/session-reset traces, tool-call transcripts, raw JSON blobs, or similar internal execution traces must be rejected unless a clean user fact can be extracted.
- Fragment blobs: mixed filename shards, code snippets, metadata fields, or partial sentences that look like unprocessed context fragments should be skipped rather than preserved.
- Atomic memory shape: each stored memory must read like one atomic profile fact, preference, entity state, event, case, or pattern. If a candidate reads like an excerpt, log, or raw transcript, compress it into one atomic statement or skip it.
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

Tag every memory's "grounding" field:

| grounding | Meaning |
|-----------|---------|
| "real" | An assertion about the actual user, the real world, or this real working session — including a genuine first-person aside stated in passing during a game (e.g. "btw my flight is Tuesday") |
| "constructed" | An assertion whose truth exists only inside an in-conversation constructed context: a game's rules/scores/bets, a role or persona's claims, drafted fiction, a hypothetical ("suppose X"), or sample/test data being manipulated |

Rules:
- Grounding is judged PER ITEM, on that item's own content. There is no expected number of "real" or "constructed" tags per batch: a batch may be all-real, all-constructed, or anything between.
- If the conversation is in-character or mid-fiction, EVERY item derived from the narrative is "constructed" — an all-constructed batch is the normal result for such input.
- Do NOT lift any in-context proposition — an invented rule, a score, a bet, a persona's claim — into profile, preferences, entities, cases, or patterns. From a constructed frame, the only extractable memory is a session-scoped "events" note that the real participants did the activity; the storage layer keeps at most one such note per extraction. That cap is a storage rule applied after tagging — it is NOT a tagging quota, so never re-tag extra items "real" to fit under it.
- A real aside spoken during play is still "real" and should be extracted normally under its natural category, even though it occurred inside a constructed register.
- Self-consistency check before answering: items derived from the same fictional frame must share the same grounding tag. If your draft tags one game-derived item "constructed" and another game-derived item "real", re-check the batch — either the item is a genuine out-of-character aside, or its tag is wrong.
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
\`\`\`json
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
\`\`\`

## Ordinary personal conversation (register "real", two memories)
\`\`\`json
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
\`\`\`

## Mid-game conversation (register "fiction", ALL items constructed)
Input was one round of an in-character guessing game where a persona claimed to live on a moon base and named an invented drink.
\`\`\`json
{
  "conversation_register": "fiction",
  "memories": [
    {
      "category": "events",
      "abstract": "agent-one and agent-two ran a two-round puzzle exercise",
      "overview": "## What happened\\n- Two agents played a puzzle guessing game with invented rules and a bet",
      "content": "agent-one and agent-two ran a two-round puzzle guessing exercise. The house rules, scores, and bet are part of the game, not durable facts.",
      "grounding": "constructed"
    }
  ]
}
\`\`\`
Note: the persona's home, the invented drink, the house rule, and the bet are NOT extracted at all — not as profile, not as preferences, not as entities. The whole batch carries "constructed" tags; that is the expected shape for mid-fiction input.

## Game with a genuine out-of-character aside (register "mixed")
\`\`\`json
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
      "grounding": "constructed"
    }
  ]
}
\`\`\`

# Output Format

Return JSON:
{
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
}

Notes:
- Output language should match the dominant language in the conversation
- Only extract truly valuable personalized information
- If nothing worth recording, return {"conversation_register": "real|mixed|fiction", "memories": []}
- Maximum 5 memories per extraction
- Preferences should be aggregated by topic
- Always set the top-level "conversation_register" field, and tag every memory's "grounding" field, per the Conversational Grounding rules above`;
}
export function buildDedupPrompt(candidateAbstract, candidateOverview, candidateContent, existingMemories) {
    return `Determine how to handle this candidate memory.

**Candidate Memory**:
Abstract: ${candidateAbstract}
Overview: ${candidateOverview}
Content: ${candidateContent}

**Existing Similar Memories**:
${existingMemories}

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
- If the candidate appears to be derived from a recall question (e.g., "Do you remember X?" / "你记得X吗？") and an existing memory already covers topic X with equal or more detail, you MUST choose SKIP.
- A candidate with less information than an existing memory on the same topic should NEVER be CREATED or MERGED — always SKIP.
- For "preferences" and "entities", use SUPERSEDE when the candidate replaces the current truth instead of adding detail or context. Example: existing "Preferred editor: VS Code", candidate "Preferred editor: Zed".
- For SUPPORT/CONTEXTUALIZE/CONTRADICT, you MUST provide a context_label from this vocabulary: general, morning, evening, night, weekday, weekend, work, leisure, summer, winter, travel.

Return JSON format:
{
  "decision": "skip|create|merge|supersede|support|contextualize|contradict",
  "match_index": 1,
  "reason": "Decision reason",
  "context_label": "evening"
}

- If decision is "merge"/"supersede"/"support"/"contextualize"/"contradict", set "match_index" to the number of the existing memory (1-based).
- Only include "context_label" for support/contextualize/contradict decisions.`;
}
export function buildMergePrompt(existingAbstract, existingOverview, existingContent, newAbstract, newOverview, newContent, category) {
    return `Merge the following memory into a single coherent record with all three levels.

** Category **: ${category}

** Existing Memory:**
    Abstract: ${existingAbstract}
  Overview:
${existingOverview}
  Content:
${existingContent}

** New Information:**
    Abstract: ${newAbstract}
  Overview:
${newOverview}
  Content:
${newContent}

  Requirements:
  - Remove duplicate information
    - Keep the most up - to - date details
      - Maintain a coherent narrative
        - Keep code identifiers / URIs / model names unchanged when they are proper nouns

Return JSON:
  {
    "abstract": "Merged one-line abstract",
      "overview": "Merged structured Markdown overview",
        "content": "Merged full content"
  } `;
}
