import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function fail(message) {
  throw new Error(`package runtime verification failed: ${message}`);
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

function normalizeRuntimePath(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`invalid runtime path ${JSON.stringify(value)}`);
  }
  return value.replace(/^\.\//, "");
}

function verifyCompiledRuntime(relativePath, sourceLabel) {
  const normalized = normalizeRuntimePath(relativePath);
  if (!/^dist\/.+\.m?js$/i.test(normalized)) {
    fail(`${sourceLabel} must point at compiled JavaScript under dist/, got ${relativePath}`);
  }

  const absolutePath = path.join(repoRoot, normalized);
  if (!existsSync(absolutePath)) {
    fail(`${sourceLabel} points to missing file ${relativePath}; run npm run build before packaging`);
  }
  if (!statSync(absolutePath).isFile()) {
    fail(`${sourceLabel} does not point to a file: ${relativePath}`);
  }
}

const pkg = readJson("package.json");

verifyCompiledRuntime(pkg.main, "package.json main");

const extensions = pkg.openclaw?.extensions;
if (!Array.isArray(extensions) || extensions.length === 0) {
  fail("package.json openclaw.extensions must list at least one runtime entry");
}

for (const extension of extensions) {
  verifyCompiledRuntime(extension, "package.json openclaw.extensions entry");
}

const files = Array.isArray(pkg.files) ? pkg.files : [];
if (!files.includes("dist/**/*")) {
  fail('package.json files must include "dist/**/*" so compiled runtime output is published');
}

console.log("Package runtime entries point to compiled dist output");
