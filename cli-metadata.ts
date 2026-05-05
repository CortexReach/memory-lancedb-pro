import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "memory-lancedb-pro",
  name: "Memory (LanceDB Pro)",
  description: "Enhanced LanceDB-backed long-term memory with hybrid retrieval, multi-scope isolation, long-context chunking, and management CLI",
  kind: "memory",
  register(api) {
    api.registerCli(() => {}, {
      commands: ["memory-pro"],
      descriptors: [
        {
          name: "memory-pro",
          description: "Enhanced memory management commands (LanceDB Pro)",
          hasSubcommands: true,
        },
      ],
    });
  },
});
