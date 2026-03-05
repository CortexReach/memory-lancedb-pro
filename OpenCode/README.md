# OpenCode Plugin Development (memory-lancedb-pro)

This folder contains the OpenCode plugin implementation for this repository.
It exposes memory tools backed by LanceDB + embedding retrieval.

For this open-source repository, docs and checked-in config use example values.
Environment-specific deployed values should be kept in your local OpenCode
installation (outside this repo).

## Files

- `OpenCode/memory-lancedb-pro.ts`: plugin implementation.
- `OpenCode/config.example.json`: default runtime config template.
- `OpenCode/config.json`: example runtime config for repository users.
- `.opencode/plugins/memory-lancedb-pro.ts`: project-level plugin loader.
- `.opencode/package.json`: project-level plugin dependencies.

## Tool set

The plugin registers the following custom tools:

- `memory_recall`
- `memory_store`
- `memory_forget`
- `memory_update`
- `memory_list`
- `memory_stats`

## Install modes

### 1) Project-local mode

OpenCode auto-loads plugins from `.opencode/plugins/` when you start OpenCode
in this repository root.

Install project-local dependencies:

```bash
cd .opencode && bun install
```

### 2) Global mode (`~/.config/opencode`)

If you want this plugin available for all OpenCode sessions, add a loader in
`~/.config/opencode/plugins/` and reference it from
`~/.config/opencode/opencode.json`.

Example plugin entry in `opencode.json`:

```json
{
  "plugin": [
    "~/.config/opencode/plugins/memory-lancedb-pro.ts"
  ]
}
```

## Configuration

1. Initialize config from template:

```bash
cp OpenCode/config.example.json OpenCode/config.json
```

2. Edit `OpenCode/config.json`.

Template defaults are Ollama-compatible:

- `embedding.apiKey`: `ollama`
- `embedding.baseURL`: `http://localhost:11434/v1`
- `embedding.model`: `nomic-embed-text`
- `embedding.dimensions`: `768`

## Config loading behavior

Default config path:

- `OpenCode/config.json`

Override path with:

- `OPENCODE_MEMORY_LANCEDB_PRO_CONFIG=/absolute/or/relative/path.json`

Relative paths are resolved from the project worktree root.

## Notes

- `enableManagementTools` controls `memory_list` and `memory_stats`.
- If `embedding.apiKey` is not provided, plugin falls back to `ollama`.
- If `embedding.baseURL` is not provided, plugin falls back to
  `http://localhost:11434/v1`.
- If `embedding.model` is not provided, plugin falls back to `nomic-embed-text`.
- Default LanceDB path is `~/.opencode/memory/lancedb-pro`.

## Troubleshooting

- If Node exits with `Bus error (core dumped)` when loading LanceDB, verify
  native package source. Some mirror registries may provide incompatible native
  binaries. Reinstall from official npm registry:

```bash
npm install @lancedb/lancedb@^0.26.2 --registry=https://registry.npmjs.org
```
