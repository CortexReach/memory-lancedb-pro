export async function runEmbeddedPiAgent() {
  return {
    payloads: [
      {
        text: [
          "## Context (session background)",
          "- Current session reflection test fixture.",
          "",
          "## Decisions (durable)",
          "- Keep reflection handoff note assembly centralized in runMemoryReflection.",
          "",
          "## User model deltas (about the human)",
          "- (none captured)",
          "",
          "## Agent model deltas (about the assistant/system)",
          "- (none captured)",
          "",
          "## Lessons & pitfalls (symptom / cause / fix / prevention)",
          "- (none captured)",
          "",
          "## Learning governance candidates (.learnings / promotion / skill extraction)",
          "- (none captured)",
          "",
          "## Open loops / next actions",
          "- Verify current reflection handoff after reset.",
          "",
          "## Retrieval tags / keywords",
          "- memory-reflection",
          "",
          "## Invariants",
          "- Keep inherited-rules in before_agent_start only.",
          "",
          "## Derived",
          "- Fresh derived line from this run.",
        ].join("\n"),
      },
    ],
  };
}
