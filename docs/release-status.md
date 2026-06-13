# Release Status

This note captures the release gap tracked in #812 so maintainers can verify the
public package channel before and after the next beta publish.

## Live npm snapshot

Checked on 2026-06-13:

```json
{
  "dist-tags": {
    "latest": "1.0.32",
    "dev": "1.1.0-beta.5",
    "beta": "1.1.0-beta.9"
  },
  "version": "1.0.32"
}
```

The repository package version is `1.1.0-beta.11`, so npm users installing
`memory-lancedb-pro@beta` still receive an older package than current `master`.

## Target after publish

After the next beta publish:

- `npm view memory-lancedb-pro@beta version` should return `1.1.0-beta.11`
- `npm view memory-lancedb-pro@beta main` should return `dist/index.js`
- `npm view memory-lancedb-pro@beta openclaw.extensions --json` should include `./dist/index.js`
- `npm pack --dry-run` should include compiled `dist/**/*` output and exclude `test/**/*`

Stable `latest` remains a maintainer decision after the beta package is smoke
tested on current OpenClaw.
