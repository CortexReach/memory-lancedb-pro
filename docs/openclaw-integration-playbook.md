# OpenClaw Integration Playbook

This guide turns the integration and test findings for `memory-lancedb-pro` into a reusable checklist for two audiences:

- OpenClaw users who want a stable first deployment
- Maintainers who need a practical regression guide for future iterations

It is intentionally generic. It focuses on verifiable behavior, failure signatures, and operating rules instead of local machine paths.

## 0. Start with the correct user path

Before following the rest of this guide, classify your current state:

- new OpenClaw user or first-time memory setup
- existing OpenClaw user adding this plugin later
- existing `memory-lancedb-pro` user upgrading from a pre-v1.1.0 release

The operating rule is:

- `upgrade` is for older `memory-lancedb-pro` data
- `migrate` is for built-in `memory-lancedb` data
- `reembed` is for embedding rebuilds, not routine upgrades

If you mix those paths, debugging becomes much harder because storage-format issues and retrieval-quality issues get conflated.

## 1. Recommended Deployment Modes

Choose one of these modes explicitly.

### Mode A: Retrieval-first memory

Use this when you want:

- `memory_store` / `memory_recall`
- hybrid search (`vector + BM25`)
- auto-capture / auto-recall
- smart extraction and lifecycle ranking

Keep plugin session summaries disabled unless you have a concrete retrieval need for prior sessions.

### Mode B: Retrieval + session-summary search

Use this when you also want `/new` to write a searchable session summary into LanceDB.

In this mode:

- set plugin `sessionStrategy: "memoryReflection"` for LLM-powered reflection (structured extraction, dedup, lifecycle scoring)
- decide whether OpenClaw built-in `session-memory` should also remain enabled

> **Note:** The legacy `sessionMemory.enabled = true` maps to `systemSessionMemory` (simple session summary stored directly in LanceDB), not `memoryReflection`. If you need the full reflection pipeline, use `sessionStrategy` explicitly.

If both are enabled, `/new` can produce two outputs:

- built-in workspace/session summary files
- LanceDB session-summary memories written by `memory-lancedb-pro`

That is valid, but it is a double-write design. If you do not want duplicated session summarization paths, keep only one.

## 2. Recommended Session Memory Strategy

For most users, use one of these patterns.

### Option 1: Disabled (no plugin session hooks)

Choose this when you mainly want transcript persistence and workspace summaries without plugin involvement.

- plugin `sessionStrategy: "none"` (or omit `sessionStrategy` entirely)
- OpenClaw built-in `hooks.internal.entries.session-memory.enabled = true`

### Option 2: Plugin only (LLM reflection)

Choose this when you want session summaries to participate in LanceDB retrieval with LLM-powered structured extraction, dedup, and lifecycle scoring.

- plugin `sessionStrategy: "memoryReflection"`
- OpenClaw built-in `hooks.internal.entries.session-memory.enabled = false`

### Option 3: Plugin only (simple summary)

Choose this when you want session summaries stored in LanceDB but do not need the full LLM reflection pipeline.

- plugin `sessionStrategy: "systemSessionMemory"`
- OpenClaw built-in `hooks.internal.entries.session-memory.enabled = false`

This writes a plain session summary directly into LanceDB as `fact` / `peripheral` tier entries, without LLM-driven dedup or lifecycle scoring.

### Option 4: Dual write

Choose this only if you explicitly want both:

- workspace markdown/session artifacts (via built-in session-memory)
- LanceDB-searchable session memories (via plugin `sessionStrategy`)

If you use dual write, document it for your team. Otherwise it will look like duplicate behavior during debugging.

### Strategy comparison

| Configuration | Strategy | Behavior |
|---|---|---|
| `sessionStrategy: "memoryReflection"` | memoryReflection | LLM-powered reflection: structured extraction, dedup, lifecycle scoring |
| `sessionStrategy: "systemSessionMemory"` | systemSessionMemory | Simple session summary stored directly in LanceDB as fact/peripheral |
| `sessionMemory: { enabled: true }` | systemSessionMemory | Legacy shorthand, same as `systemSessionMemory` above |
| `sessionStrategy: "none"` or omitted | none | Plugin session hooks disabled |

## 3. Baseline Verification Checklist

Run this before debugging retrieval quality.

```bash
openclaw config validate
openclaw status
openclaw gateway status
openclaw plugins info memory-lancedb-pro
openclaw hooks list --json
```

Confirm:

- plugin is loaded from the expected path
- `plugins.slots.memory` points to `memory-lancedb-pro`
- the expected hooks are enabled
- the gateway has been restarted after config changes

If you use plugin session memory, `openclaw hooks list --json` should show the plugin hook:

- `memory-lancedb-pro-session-memory`

If you want plugin-only session summaries, also confirm:

- built-in `session-memory` is disabled

## 4. Fresh-Agent Bootstrap Checks

When a newly created agent fails on its first real turn, do not start with retrieval debugging. Verify agent bootstrap first.

Typical symptom:

- `Unknown model: openai-codex/gpt-5.4`

Common root cause:

- the new agent has not been initialized with agent-local model/auth indexes

Verify these files exist under the new agent directory:

- `~/.openclaw/agents/<agentId>/agent/models.json`
- `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`

Also verify the agent can resolve at least one usable model before testing memory behavior.

Practical rule:

- if a fresh agent cannot complete a plain text turn, memory tests on that agent are not meaningful yet

## 5. Retrieval Quality Rules

### Short CJK keyword queries need explicit validation

Short Chinese keywords are a common false-negative case in hybrid retrieval systems.

Observed pattern during testing:

- unique identifiers or full sentences recall well
- short CJK keywords may depend on BM25/lexical matching quality
- lowering `minScore` can improve recall but often increases noise

Recommended tuning order:

1. verify BM25 / lexical fallback behavior first
2. verify hybrid fusion behavior second
3. tune `minScore` / `hardMinScore` last

Do not start by aggressively lowering thresholds. That often converts a retrieval-quality problem into a relevance-noise problem.

### Lifecycle scoring must not suppress strong fresh hits

If you use lifecycle decay and tiering:

- apply relevance filtering before lifecycle/time decay demotion
- ensure new `working` memories are not pushed below `hardMinScore` simply because decay was applied too early

Regression target:

- a fresh, high-relevance working-tier memory must remain retrievable

## 6. Functional Smoke Tests

These tests cover the core closed loop.

### CLI and storage

```bash
openclaw memory-pro stats
openclaw memory-pro list --scope global --limit 5
openclaw memory-pro search "your test keyword" --scope global --limit 5
```

Validate:

- stats returns usable counts
- list returns stored items in the expected scope
- search returns deterministic results for at least one exact identifier and one natural-language query

### Tool loop

Validate at least once:

- `memory_store`
- `memory_recall`
- `memory_update`
- `memory_forget`
- `memory_list`
- `memory_stats`

### Scope isolation

Validate at least:

- `main -> main` hits
- `main -> work` miss
- `work -> global` allowed if intended
- `life -> work` miss unless explicitly permitted

### Smart extraction stability

Validate the three semantic branches:

- `create`
- `merge`
- `skip`

Then run a multi-turn sequence such as:

- `create -> skip -> merge -> skip`

Expected result:

- one stable memory record
- duplicates suppressed
- new facts merged without unbounded duplication

## 7. Real `/new` Session Test

If plugin session memory is enabled, run one real `/new` validation after the basic smoke tests.

Check for three facts:

1. the active session changes
2. the expected hook fires
3. the summary lands in the intended storage path

Plugin evidence should look like:

- a log entry that the session summary was stored for the previous session

If built-in session memory is also enabled, you should additionally see the built-in workspace/session artifact.

If built-in session memory is disabled, do not treat the absence of a workspace session-summary markdown file as a plugin failure.

## 8. Recommended Regression Matrix

Run this matrix before release candidates or after major retrieval changes.

### Integration

- plugin loads successfully
- gateway restart preserves plugin registration
- `hooks list` shows expected hook state

### Retrieval

- exact identifier recall
- short CJK keyword recall
- full sentence semantic recall
- rerank fallback behavior when reranker is unavailable

### Memory lifecycle

- fresh `working` memory remains retrievable
- tier promotion/demotion does not erase useful recall

### Extraction

- `create`
- `merge`
- `skip`
- multi-turn duplicate suppression

### Session flow

- `/new` triggers the intended hook path
- plugin-only mode does not rely on built-in session artifacts
- dual-write mode is explicit and understood

### Agent bootstrap

- newly added agent can complete its first turn
- new agent has usable model/auth indexes

## 9. Troubleshooting Patterns

### Search returns empty, but the store contains data

Check in this order:

1. scope mismatch
2. `minScore` / `hardMinScore`
3. BM25 / lexical fallback availability
4. rerank endpoint health
5. lifecycle decay ordering

### `/new` appears to do nothing

Check:

- plugin `sessionStrategy` is set to `"memoryReflection"` or `"systemSessionMemory"` (not `"none"`)
- plugin hook is actually registered and named
- gateway has been restarted after the hook/config change
- built-in hook state matches your intended design

### Results became noisy after tuning

Likely cause:

- threshold reduction solved recall at the cost of precision

Preferred fix order:

1. lexical/BM25 improvement
2. hybrid-fusion tuning
3. rerank tuning
4. threshold change

## 10. Upgrade and Maintenance Notes

If you maintain local patches against the OpenClaw installation itself, treat them as temporary operational fixes, not durable plugin behavior.

After any `openclaw update`, re-check:

- fresh-agent bootstrap
- model provider resolution for newly added agents
- hook registration state
- `/new` behavior

If your team depends on local installation patches, keep them in a repeatable patch or automation script outside the plugin repo.

## 11. Recommended Documentation Policy for Future Changes

When changing retrieval or hook behavior, update all three artifacts together:

- user-facing README summary
- this integration playbook
- regression tests that prove the changed behavior

That keeps operational guidance aligned with actual behavior and prevents README drift.
