# Phase 2 — Import Boundaries and Preview-First Upgrade Scan

## Purpose
Turn the Phase 2 design freeze into a concrete, implementation-ready boundary definition for:
- legacy source interpretation,
- preview-only upgrade scanning,
- later safe import behavior.

This document intentionally stays at the main-agent design layer. It defines what implementation workers should build, not the full code yet.

---

## 1. Import boundaries

## 1.1 Markdown sources
### A. `MEMORY.md`
Treat `MEMORY.md` as the highest-value legacy import source.

Recommended interpretation:
- import unit: bullet/list item, heading-scoped paragraph, or small authored fact block
- expected value: durable preferences, identity facts, long-lived project rules, stable policies
- import destination: usually `agent:<agentId>` for workspace-local memory, occasionally `global` if explicitly shared

### B. `memory/YYYY-MM-DD.md`
Treat daily memory files as event-oriented, noisy-by-default, but still valuable.

Recommended interpretation:
- import unit: bullet item or short event paragraph
- expected value: decisions, commitments, discoveries, follow-up obligations, problems solved
- default behavior: preview first, then filter/distill before import

### C. mdMirror-generated Markdown
Treat mdMirror as structured compatibility material when present.

Recommended interpretation:
- import unit: machine-friendly memory records / append entries
- expected value: higher consistency, potentially safer bulk import/export
- note: avoid duplicating memories already represented in manually curated Markdown

---

## 1.2 SQLite legacy sources
### Per-agent SQLite under `~/.openclaw/memory/*.sqlite`
Treat SQLite as a compatibility/inspection source, not as the default canonical authored source.

Recommended Phase 2 treatment:
- detect and report per-agent store presence
- support preview / inspection of importable content
- favor Markdown-derived import when overlapping Markdown exists
- only import from SQLite when:
  - Markdown is absent, or
  - SQLite contains unique structured records not represented elsewhere

Why:
- SQLite is likely to contain retrieval/index-oriented representations
- blindly importing SQLite can duplicate memory that was already authored in Markdown

---

## 1.3 Exclusions / low-priority material
Do not eagerly import:
- boilerplate profile text repeated across files
- transient logs that do not encode durable value
- obviously auto-generated retrieval artifacts without durable user meaning
- raw duplicates where the same durable fact appears in long-term Markdown already

---

## 2. Upgrade scan model

## 2.1 Command surface
### Proposed command
`memory-pro upgrade-scan`

### Purpose
Produce a read-only inventory of legacy memory sources and their likely import value.

### Required output sections
1. **Workspace memory sources**
   - workspace path
   - inferred agent id (if known)
   - `MEMORY.md` present?
   - `memory/` dir present?
   - dated daily files present?
2. **SQLite memory sources**
   - file path
   - inferred agent id / agent name
   - overlap risk if corresponding workspace Markdown exists
3. **Discovery metadata**
   - `config` or `filesystem-fallback`
   - unresolved / ambiguous mappings
4. **Upgrade readiness summary**
   - likely importable sources
   - likely noisy sources
   - warnings requiring human confirmation

---

## 2.2 Output schema (design-level)
A future machine-readable schema should contain at least:

```json
{
  "workspaceMemorySources": [
    {
      "workspacePath": "string",
      "agentId": "string|null",
      "hasMemoryMd": true,
      "hasMemoryDir": true,
      "memoryDirDateFiles": ["YYYY-MM-DD.md"],
      "importPriority": "high|medium|low",
      "warnings": ["string"]
    }
  ],
  "sqliteStores": [
    {
      "filePath": "string",
      "basename": "string",
      "agentName": "string",
      "agentId": "string|null",
      "importPriority": "high|medium|low",
      "overlapWithWorkspaceMarkdown": true,
      "warnings": ["string"]
    }
  ],
  "discoveryMode": "config|filesystem-fallback",
  "summary": {
    "workspaceSourceCount": 0,
    "sqliteSourceCount": 0,
    "ambiguousSourceCount": 0
  }
}
```

This should remain additive; human-friendly table output can be layered on top.

---

## 3. Preview-first import workflow

## 3.1 Required commands
### Markdown preview
- `memory-pro import-md <path> --dry-run`

### SQLite preview
- `memory-pro import-sqlite <path> --dry-run`

### Source-specific preview
- `memory-pro upgrade-preview --source <path-or-id>`

---

## 3.2 Preview output should answer
For any proposed source, preview must show:
1. What candidate memories were found
2. Which scope each candidate would target
3. Which entries are probably durable vs noisy
4. Which entries appear duplicate/superseded
5. What would be skipped and why

---

## 4. Import safety rules

1. **Dry-run first by default**
2. **No broad silent import on plugin enable**
3. **Ambiguous agent mapping requires caution or confirmation**
4. **Prefer Markdown over SQLite when both overlap**
5. **Preserve evidence trails** — imports should produce a report
6. **Avoid duplicate durable facts** — import should respect dedupe/supersede logic

---

## 5. Recommended implementation order for D1

### D1-Step 1
Implement `upgrade-scan` reporting only

### D1-Step 2
Implement Markdown dry-run parsing and preview

### D1-Step 3
Implement SQLite dry-run preview semantics

### D1-Step 4
Implement real Markdown import with filtering + dedupe

### D1-Step 5
Implement real SQLite import only after overlap/uniqueness rules are validated

---

## 6. Main-agent notes for worker assignment
A future worker for D1 should be tightly scoped to:
- source parsing + preview/reporting
- no runtime sync logic yet
- no disable/uninstall flow yet
- no docs/skill preference work yet
