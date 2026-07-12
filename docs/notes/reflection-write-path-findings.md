# Reflection write-path findings

Findings from a code-plus-trace audit of the reflection persistence paths.
Kept here as discussion material; each item states what the code does today
and what remains open.

## Two writers, different gates

The reflection distiller output is persisted by two independent writers:

1. **Writer 1 (mapped rows).** Four headings of the reflection markdown
   (User model deltas, Agent model deltas, Lessons & pitfalls, Decisions)
   are parsed into individual rows (`extractInjectableReflectionMappedMemoryItems`)
   and bulk-stored as ordinary memories with `metadata.type =
   "memory-reflection-mapped"`. Until the accompanying change, this path had
   no admission gate and no gating knob; `reflectionStoreToLanceDB` gates
   only writer 2. Mapped rows now route through the same AdmissionController
   as extraction candidates when admission control is enabled (passthrough
   when disabled, fail-open on infra errors). Scoring category mapping:
   `preference` (user/agent model deltas) scores as `preferences`, `fact`
   (lessons) as `cases`, `decision` as `events`.

2. **Writer 2 (reflection documents).** `storeReflectionToLanceDB` persists
   sliced reflection documents under category `reflection`, gated by the
   `reflectionStoreToLanceDB` config knob. Unchanged by this work.

## Dead reader

`loadReflectionMappedRowsFromEntries` (reflection-store) was built to read
mapped rows back for a dedicated injection path, but it has no production
callers (only a test imports it). The only living read path for mapped rows
is generic semantic recall. A code comment now marks this. Open question:
either wire the dedicated reader or consider retiring mapped rows in favor
of writer 2 plus recall.

## Cross-writer double-store

"Decisions (durable)" bullets can be persisted twice: once by writer 1 as a
`decision` row, and once inside writer 2's document slices (invariant
fallback). There is no cross-lane dedup between the two writers. Any future
dedup would need to compare across `metadata.type` values.

## memory_layer parity question

The auto-recall governance filter drops entries with `memory_layer` in
`{archive, reflection}`, but only the dreaming engine sets layer
`reflection`. Mapped rows carry layer semantics of ordinary confirmed
memories, so they pass recall filters that reflection-layer content does
not. If mapped rows are conceptually reflection output, they may deserve
the same layer tag; if they are conceptually ordinary memories, the
admission gate added here is the appropriate control. Left as a design
question.

## Auto-capture watermark

The per-session auto-capture cursor (`autoCaptureSeenTextCount`) is reset
to zero after every successful smart extraction, which makes the next
capture of the same session re-read the whole history instead of the
delta. Analysis and fix (recording the consumed length instead) are on the
dedicated watermark fix branch.

## Residual gap

The mapped-row admission gate reuses the SmartExtractor's controller
instance. When smart extraction is disabled while admission control is
enabled, mapped rows still pass ungated (no controller exists to borrow).
This mirrors the pre-change behavior and is called out here for
completeness.
