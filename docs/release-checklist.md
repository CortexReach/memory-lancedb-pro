# Release Checklist

Use this checklist before publishing a new `memory-lancedb-pro` package. It is
intended for the release tracked in #812 and future beta/stable cuts.

## Release Target

- Current package version: `1.1.0-beta.11`
- Recommended first publish: beta dist-tag
- Stable channel decision: maintainer-owned after beta smoke testing

The current release driver is that npm users are still behind repository
`master`: merged fixes are not available from the published `latest` package,
and the `beta` dist-tag still points at an older beta package.

## Preflight

Run these from a clean checkout:

```bash
npm ci
npm run test:packaging-and-workflow
npm run build
npm pack --dry-run
```

Confirm:

- `package.json` and `openclaw.plugin.json` versions match
- `package.json main` points at `dist/index.js`
- `package.json openclaw.extensions` points at `./dist/index.js`
- `package.json files` includes `dist/**/*`
- `CHANGELOG.md` and `CHANGELOG-v1.1.0.md` start with the package version
- `npm pack --dry-run` includes compiled `dist` output and excludes test files

## Publish Dry Run

```bash
npm publish --tag beta --dry-run
```

Review the file list and package metadata before publishing.

## Publish

```bash
npm publish --tag beta
```

After publish, verify the public registry state:

```bash
npm view memory-lancedb-pro dist-tags version versions --json
npm view memory-lancedb-pro@beta version main openclaw files --json
```

The `beta` dist-tag should point at the newly published version, and the package
runtime entries should point at compiled JavaScript under `dist/`.

## Post-Publish Smoke

On a machine with a current OpenClaw install:

```bash
openclaw plugins registry --refresh
openclaw plugins install memory-lancedb-pro@beta
openclaw plugins doctor
```

Confirm OpenClaw installs the package without falling back to TypeScript source
entrypoints.
