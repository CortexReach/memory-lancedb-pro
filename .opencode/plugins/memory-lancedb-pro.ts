import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

if (!process.env.OPENCODE_MEMORY_LANCEDB_PRO_CONFIG) {
  const globalConfigPath = join(
    homedir(),
    ".config",
    "opencode",
    "plugins",
    "memory-lancedb-pro.config.json",
  );

  if (existsSync(globalConfigPath)) {
    process.env.OPENCODE_MEMORY_LANCEDB_PRO_CONFIG = globalConfigPath;
  }
}

export {
  MemoryLanceDBProPlugin,
  MemoryLanceDBProPlugin as default,
} from "../../OpenCode/memory-lancedb-pro.ts";
