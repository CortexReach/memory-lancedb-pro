import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MdMirrorWriter } from "./tools.js";

export interface CompatibilityMdMirrorOptions {
  fallbackDir: string;
  workspaceMap: Record<string, string>;
  logger?: {
    warn?: (msg: string) => void;
  };
}

const README_CONTENT = `# memory-lancedb-pro compatibility subtree

This directory was created because \`memory-lancedb-pro\` was enabled for this agent workspace.

## What this directory is
- A compatibility / reversibility projection of plugin-managed durable memory.
- A bridge that helps OpenClaw's original Markdown / SQLite memory systems remain usable.
- Not the primary human-authored daily log.

## What the files mean
- \`YYYY-MM-DD.md\` files contain plugin-managed compatibility memory written during active plugin use.

## Important note
The top-level file \`memory/YYYY-MM-DD.md\` remains the normal human-authored / agent-authored daily memory log.
Files under \`memory/plugins/memory-lancedb-pro/\` exist so that enabling and later disabling the plugin is non-destructive and reversible.
`;

export function getWorkspaceCompatibilityMirrorDir(workspaceDir: string): string {
  return join(workspaceDir, "memory", "plugins", "memory-lancedb-pro");
}

async function ensureCompatibilityReadme(mirrorDir: string): Promise<void> {
  await mkdir(mirrorDir, { recursive: true });
  try {
    await writeFile(join(mirrorDir, "README.md"), README_CONTENT, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") {
      throw err;
    }
  }
}

function buildMirrorLine(
  entry: { text: string; category: string; scope: string; timestamp?: number },
  meta?: { source?: string; agentId?: string },
): string {
  const ts = new Date(entry.timestamp || Date.now());
  const agentLabel = meta?.agentId ? ` agent=${meta.agentId}` : "";
  const sourceLabel = meta?.source ? ` source=${meta.source}` : "";
  const safeText = entry.text.replace(/\n/g, " ").slice(0, 500);
  return `- ${ts.toISOString()} [${entry.category}:${entry.scope}]${agentLabel}${sourceLabel} ${safeText}\n`;
}

export function createCompatibilityMdMirrorWriter(
  options: CompatibilityMdMirrorOptions,
): MdMirrorWriter {
  return async (entry, meta) => {
    try {
      const ts = new Date(entry.timestamp || Date.now());
      const dateStr = ts.toISOString().split("T")[0];

      let mirrorDir = options.fallbackDir;
      if (meta?.agentId && options.workspaceMap[meta.agentId]) {
        mirrorDir = getWorkspaceCompatibilityMirrorDir(options.workspaceMap[meta.agentId]);
      }

      await ensureCompatibilityReadme(mirrorDir);
      await appendFile(join(mirrorDir, `${dateStr}.md`), buildMirrorLine(entry, meta), "utf8");
    } catch (err) {
      options.logger?.warn?.(`mdMirror: write failed: ${String(err)}`);
    }
  };
}
