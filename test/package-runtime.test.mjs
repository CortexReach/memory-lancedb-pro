import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

assert.equal(pkg.scripts?.build, "tsc -p tsconfig.json");
assert.equal(
  pkg.scripts?.prepack,
  "npm run build && node scripts/verify-package-runtime.mjs",
  "prepack should build and verify compiled runtime output before publishing",
);
assert.equal(pkg.main, "dist/index.js");
assert.deepEqual(pkg.openclaw?.extensions, ["./dist/index.js"]);
assert.ok(
  pkg.files?.includes("dist/**/*"),
  "published package files should include compiled dist output",
);

const result = spawnSync(process.execPath, ["scripts/verify-package-runtime.mjs"], {
  cwd: new URL("..", import.meta.url),
  encoding: "utf8",
});

assert.equal(
  result.status,
  0,
  result.stderr || result.stdout || "verify-package-runtime.mjs should pass",
);
