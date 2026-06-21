import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

assert.equal(pkg.scripts?.build, "tsc -p tsconfig.json");
assert.equal(
  pkg.scripts?.["verify-package-runtime"],
  "npm run build && node scripts/verify-package-runtime.mjs",
  "package runtime verification should build before checking dist freshness",
);
assert.equal(
  pkg.scripts?.prepack,
  "npm run verify-package-runtime",
  "prepack should use the build-and-verify package runtime script",
);
assert.equal(pkg.main, "dist/index.js");
assert.deepEqual(pkg.openclaw?.extensions, ["./dist/index.js"]);
assert.ok(
  pkg.files?.includes("dist/**/*"),
  "published package files should include compiled dist output",
);

const result = spawnSync(npmCommand, ["run", "verify-package-runtime"], {
  cwd: new URL("..", import.meta.url),
  encoding: "utf8",
});

assert.equal(
  result.status,
  0,
  result.stderr || result.stdout || "verify-package-runtime.mjs should pass and dist should be fresh",
);

const untrackedDistFile = new URL("../dist/__verify-package-runtime-untracked.tmp", import.meta.url);
writeFileSync(untrackedDistFile, "untracked generated output\n");
try {
  const untrackedResult = spawnSync(process.execPath, ["scripts/verify-package-runtime.mjs"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });

  assert.notEqual(
    untrackedResult.status,
    0,
    "verify-package-runtime.mjs should fail when dist contains untracked generated output",
  );
  assert.match(
    untrackedResult.stderr || untrackedResult.stdout,
    /uncommitted or untracked output/,
  );
} finally {
  rmSync(untrackedDistFile, { force: true });
}
