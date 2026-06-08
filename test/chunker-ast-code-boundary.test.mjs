import assert from "node:assert/strict";

import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { detectCodeLanguage, smartChunk } = jiti("../src/chunker.ts");

const AST_ON = { enabled: true };
const MODEL = "gemini-embedding-001";

function assertBalancedBraces(chunk) {
  const opens = (chunk.match(/\{/g) ?? []).length;
  const closes = (chunk.match(/\}/g) ?? []).length;
  assert.equal(opens, closes, `expected balanced braces in chunk:\n${chunk}`);
}

function buildTypeScriptFixture() {
  const repeatedChecks = Array.from({ length: 13 }, (_, idx) => {
    return `  if (auditTrail.includes("step-${idx}")) {\n    events.push("step-${idx}");\n  }`;
  }).join("\n");

  return `import { LoginCredentials, AuthResult } from "./auth-types";

export async function handleUserLogin(
  userId: string,
  credentials: LoginCredentials,
): Promise<AuthResult> {
  const events: string[] = [];
  const auditTrail = credentials.auditTrail ?? [];
${repeatedChecks}
  if (!credentials.password) {
    return { success: false, error: "INVALID_PASSWORD", events };
  }
  return { success: true, session: { userId }, events };
}

export async function verifyPassword(
  inputPassword: string,
  storedHash: string,
): Promise<boolean> {
  const bcrypt = await import("bcrypt");
  const normalized = inputPassword.trim();
  if (normalized.length === 0) {
    return false;
  }
  return bcrypt.compare(normalized, storedHash);
}
`;
}

function buildPythonFixture() {
  const classLines = Array.from({ length: 15 }, (_, idx) => {
    return `        if "step_${idx}" in payload:\n            events.append("step_${idx}")`;
  }).join("\n");

  return `import hashlib

class LoginHandler:
    def handle_user_login(self, payload):
        events = []
${classLines}
        if not payload.get("password"):
            return {"success": False, "error": "INVALID_PASSWORD", "events": events}
        return {"success": True, "events": events}

def verify_password(input_password, stored_hash):
    normalized = input_password.strip()
    if not normalized:
        return False
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
    return digest == stored_hash
`;
}

{
  const code = buildTypeScriptFixture();
  const result = smartChunk(code, MODEL, AST_ON);

  assert.equal(detectCodeLanguage(code), "typescript");
  assert(result.chunkCount > 1, "fixture should split into multiple chunks");
  assert(result.chunks.every((chunk) => chunk.length <= 1433), "chunks should stay under model-derived limit");
  result.chunks.forEach(assertBalancedBraces);

  const loginChunk = result.chunks.find((chunk) => chunk.includes("handleUserLogin"));
  assert(loginChunk, "expected handleUserLogin chunk");
  assert(loginChunk.includes('return { success: true, session: { userId }, events };'));

  const verifyChunk = result.chunks.find((chunk) => chunk.includes("verifyPassword"));
  assert(verifyChunk, "expected verifyPassword chunk");
  assert(verifyChunk.includes('return bcrypt.compare(normalized, storedHash);'));
  assert(!verifyChunk.trimStart().startsWith("}"), "verifyPassword chunk should not start with a dangling brace");
}

{
  const code = buildPythonFixture();
  const result = smartChunk(code, MODEL, AST_ON);

  assert.equal(detectCodeLanguage(code), "python");
  assert(result.chunkCount > 1, "fixture should split into multiple chunks");

  const classChunk = result.chunks.find((chunk) => chunk.includes("class LoginHandler"));
  assert(classChunk, "expected LoginHandler chunk");
  assert(classChunk.includes('return {"success": True, "events": events}'));

  const verifyChunk = result.chunks.find((chunk) => chunk.includes("def verify_password"));
  assert(verifyChunk, "expected verify_password chunk");
  assert(verifyChunk.includes("return digest == stored_hash"));
  assert(!verifyChunk.includes("class LoginHandler"), "Python function should not be merged back into class chunk");
}

{
  const malformed = `function brokenExample() {\n  if (true) {\n    return "missing braces";\n`;
  assert.deepEqual(
    smartChunk(malformed, MODEL, AST_ON),
    smartChunk(malformed, MODEL),
    "malformed JS should hard-fallback to the existing splitter",
  );
}

{
  const code = buildTypeScriptFixture();
  assert.deepEqual(
    smartChunk(code, MODEL, { enabled: true, languages: ["python"] }),
    smartChunk(code, MODEL),
    "language whitelist misses should use the existing splitter",
  );
}

console.log("chunker AST/code-boundary regression tests passed");
