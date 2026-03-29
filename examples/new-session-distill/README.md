# New Session Distillation (Recommended)

This example shows a **non-blocking /new distillation pipeline**:

- Trigger: `command:new` (when you type `/new`)
- Hook: enqueue a small JSON task file (fast, no LLM calls)
- Worker: a user-level systemd service watches the inbox and runs **Gemini or Anthropic-compatible Map-Reduce** over the session JSONL transcript
- Storage: write high-signal, atomic lessons into LanceDB Pro via `openclaw memory-pro import`
- Notify: send a notification message (optional)

Files included:
- `hook/enqueue-lesson-extract/` — OpenClaw workspace hook
- `worker/lesson-extract-worker.mjs` — Map-Reduce extractor + importer + notifier
- `worker/systemd/lesson-extract-worker.service` — user systemd unit

You must provide one of:

- Gemini-native:
  - `DISTILL_API=gemini-native` or omit it
  - `GEMINI_API_KEY` or `DISTILL_API_KEY`
  - optional `GEMINI_MODEL` / `DISTILL_MODEL`
- Anthropic-compatible:
  - `DISTILL_API=anthropic-messages`
  - `DISTILL_API_KEY`
  - `DISTILL_MODEL`
  - optional `DISTILL_BASE_URL` (defaults to `https://api.anthropic.com/v1`)
  - optional `DISTILL_ANTHROPIC_VERSION` (defaults to `2023-06-01`)

`DISTILL_API_KEY` and `GEMINI_API_KEY` also accept `bws://<secret-id>` Bitwarden Secrets Manager refs.

Install steps are documented in the main repo README.
