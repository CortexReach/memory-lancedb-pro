---
name: lesson
description: Store a lesson learned from the current conversation. Triggered by /lesson command. Use when Master signals that the recent conversation contains a pitfall, fix, or key insight that should be persisted to long-term memory.
metadata: { "openclaw": { "requires": { "config": ["plugins.entries.memory-lancedb-pro.enabled"] } } }
---

# Lesson Extraction & Storage

When triggered, extract and store lessons from the **recent conversation context**.

## Steps

1. **Scan recent context** — identify the pitfall, bug fix, or key insight just discussed
2. **Store technical layer** (category: fact, importance ≥ 0.8):
   ```
   Pitfall: [symptom]. Cause: [root cause]. Fix: [solution]. Prevention: [how to avoid].
   ```
3. **Store principle layer** (category: decision, importance ≥ 0.85):
   ```
   Decision principle ([tag]): [behavioral rule]. Trigger: [when]. Action: [what to do].
   ```
4. **Verify** — `memory_recall` with anchor keywords to confirm both entries retrievable
5. **Report** — tell Master what was stored (brief summary)

## Rules

- Keep entries short and atomic (< 500 chars each)
- If the lesson also affects a checklist or SKILL.md, update those files too
- If no clear lesson is found in recent context, ask Master what to store
