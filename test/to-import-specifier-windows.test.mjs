/**
 * Test: toImportSpecifier and Windows path fallback
 * PR #576 - Windows APPDATA path fallback for extensionAPI.js
 *
 * Tests the behavior of `toImportSpecifier` and `getExtensionApiImportSpecifiers`
 * using local implementations that mirror the PR #576 code exactly.
 * Functions are NOT exported from index.ts, so we copy the logic to test it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Copy of the PR #576 toImportSpecifier implementation (index.ts:414-423)
function toImportSpecifier(value) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("file://")) return trimmed;
  if (trimmed.startsWith("/")) return pathToFileURL(trimmed).href;
  // Handle Windows absolute paths (e.g. C:\Users\... or D:/Program Files/...)
  if (/^[a-zA-Z]:[/\\]/.test(trimmed)) return pathToFileURL(trimmed).href;
  return trimmed;
}

// Copy of the PR #576 getExtensionApiImportSpecifiers implementation (index.ts:425-444)
// Note: intentionally does NOT include the requireFromHere.resolve() call (dead code)
function getExtensionApiImportSpecifiers() {
  const envPath = process.env.OPENCLAW_EXTENSION_API_PATH?.trim();
  const specifiers = [];

  if (envPath) specifiers.push(toImportSpecifier(envPath));
  specifiers.push("openclaw/dist/extensionAPI.js");

  specifiers.push(toImportSpecifier("/usr/lib/node_modules/openclaw/dist/extensionAPI.js"));
  specifiers.push(toImportSpecifier("/usr/local/lib/node_modules/openclaw/dist/extensionAPI.js"));
  specifiers.push(toImportSpecifier("/opt/homebrew/lib/node_modules/openclaw/dist/extensionAPI.js"));

  if (process.platform === "win32" && process.env.APPDATA) {
    const windowsNpmPath = join(process.env.APPDATA, "npm", "node_modules", "openclaw", "dist", "extensionAPI.js");
    specifiers.push(toImportSpecifier(windowsNpmPath));
  }

  return [...new Set(specifiers.filter(Boolean))];
}

// Env helper: set key to value, run fn, restore original
function withEnv(key, value, fn) {
  const original = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    fn();
  } finally {
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
}

// ============================================================================
// toImportSpecifier tests
// ============================================================================

describe("toImportSpecifier", () => {
  // --- POSIX paths ---
  it("converts POSIX absolute path to file:// URL", () => {
    const result = toImportSpecifier("/usr/local/lib/node_modules/openclaw/dist/extensionAPI.js");
    assert.ok(result.startsWith("file://"), `Expected file:// URL, got: ${result}`);
    assert.ok(result.includes("/usr/local/lib"));
  });

  it("converts POSIX path with spaces to file:// URL", () => {
    const result = toImportSpecifier("/opt/My App/node_modules/test.js");
    assert.ok(result.startsWith("file://"), `Expected file:// URL, got: ${result}`);
  });

  // --- Windows paths (PR #576 new fix) ---
  it("converts Windows drive-letter backslash path to file:// URL", () => {
    const result = toImportSpecifier("C:\\Users\\admin\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\extensionAPI.js");
    assert.ok(result.startsWith("file://"), `Expected file:// URL, got: ${result}`);
    assert.ok(result.includes("C:/"), `Expected C:/ prefix, got: ${result}`);
  });

  it("converts Windows drive-letter forward-slash path to file:// URL", () => {
    const result = toImportSpecifier("D:/Program Files/openclaw/dist/extensionAPI.js");
    assert.ok(result.startsWith("file://"), `Expected file:// URL, got: ${result}`);
    assert.ok(result.includes("D:/"), `Expected D:/ prefix, got: ${result}`);
  });

  it("converts Windows path with spaces to file:// URL", () => {
    const result = toImportSpecifier("E:\\code\\my project\\file.js");
    assert.ok(result.startsWith("file://"), `Expected file:// URL, got: ${result}`);
  });

  it("rejects Windows drive letter without separator (C: -> unchanged)", () => {
    const result = toImportSpecifier("C:");
    assert.equal(result, "C:");
  });

  it("rejects DOS 8.3 short path (C:path\\to\\file.js -> unchanged)", () => {
    const result = toImportSpecifier("C:path\\to\\file.js");
    assert.equal(result, "C:path\\to\\file.js");
  });

  it("rejects single-backslash UNC-like path (\\server\\share -> unchanged)", () => {
    const result = toImportSpecifier("\\server\\share\\file.js");
    assert.equal(result, "\\server\\share\\file.js");
  });

  // --- Pass-through cases ---
  it("passes through file:// POSIX URL unchanged", () => {
    const input = "file:///usr/local/lib/extensionAPI.js";
    const result = toImportSpecifier(input);
    assert.equal(result, input);
  });

  it("passes through file:// Windows path unchanged", () => {
    const input = "file:///C:/Users/admin/AppData/Roaming/test.js";
    const result = toImportSpecifier(input);
    assert.equal(result, input);
  });

  it("passes through bare module specifier unchanged", () => {
    const input = "openclaw/dist/extensionAPI.js";
    const result = toImportSpecifier(input);
    assert.equal(result, input);
  });

  it("passes through relative path unchanged", () => {
    const input = "./lib/extensionAPI.js";
    const result = toImportSpecifier(input);
    assert.equal(result, input);
  });

  // --- Edge cases ---
  it("returns empty string for whitespace-only input", () => {
    const result = toImportSpecifier("   ");
    assert.equal(result, "");
  });

  it("handles path with trailing slash", () => {
    const result = toImportSpecifier("C:\\Users\\admin\\");
    assert.ok(result.startsWith("file://"), `Expected file:// URL, got: ${result}`);
  });

  it("handles lowercase drive letter", () => {
    const result = toImportSpecifier("c:\\users\\test\\file.js");
    assert.ok(result.startsWith("file://"), `Expected file:// URL, got: ${result}`);
  });

  it("handles uppercase drive letter", () => {
    const result = toImportSpecifier("E:\\Users\\Admin\\Desktop\\file.js");
    assert.ok(result.startsWith("file://"), `Expected file:// URL, got: ${result}`);
  });
});

// ============================================================================
// getExtensionApiImportSpecifiers tests
// ============================================================================

describe("getExtensionApiImportSpecifiers", () => {
  it("always includes bare module specifier", () => {
    const specifiers = getExtensionApiImportSpecifiers();
    assert.ok(specifiers.includes("openclaw/dist/extensionAPI.js"), "Should include bare module specifier");
  });

  it("includes OPENCLAW_EXTENSION_API_PATH POSIX path as file:// URL", () => {
    withEnv("OPENCLAW_EXTENSION_API_PATH", "/custom/path/extensionAPI.js", () => {
      const specifiers = getExtensionApiImportSpecifiers();
      const found = specifiers.find(s => s.includes("/custom/path"));
      assert.ok(found, `Expected custom path, got: ${JSON.stringify(specifiers)}`);
      assert.ok(found.startsWith("file://"), `Expected file:// URL, got: ${found}`);
    });
  });

  it("converts OPENCLAW_EXTENSION_API_PATH Windows path to file:// URL (hidden issue #1 fix)", () => {
    withEnv("OPENCLAW_EXTENSION_API_PATH", "C:\\Program Files\\openclaw\\dist\\extensionAPI.js", () => {
      const specifiers = getExtensionApiImportSpecifiers();
      const winSpec = specifiers.find(s => s.startsWith("file:///C:/") && s.includes("openclaw") && s.includes("dist") && s.includes("extensionAPI"));
      assert.ok(winSpec, `Expected Windows path as file:// URL: ${JSON.stringify(specifiers)}`);
      assert.ok(winSpec.includes("Program") || winSpec.includes("Program%20"), `Expected Program Files in path, got: ${winSpec}`);
    });
  });

  it("includes POSIX fallback paths on all platforms", () => {
    const specifiers = getExtensionApiImportSpecifiers();
    assert.ok(specifiers.some(s => s.includes("/usr/lib")), `Expected /usr/lib path, got: ${JSON.stringify(specifiers)}`);
    assert.ok(specifiers.some(s => s.includes("/usr/local")), `Expected /usr/local path, got: ${JSON.stringify(specifiers)}`);
    assert.ok(specifiers.some(s => s.includes("/opt/homebrew")), `Expected /opt/homebrew path, got: ${JSON.stringify(specifiers)}`);
  });

  it("returns deduped specifiers (no duplicates)", () => {
    const specifiers = getExtensionApiImportSpecifiers();
    const unique = [...new Set(specifiers)];
    assert.equal(specifiers.length, unique.length, `Found duplicate specifiers: ${JSON.stringify(specifiers)}`);
  });

  it("does not include empty strings", () => {
    const specifiers = getExtensionApiImportSpecifiers();
    assert.ok(!specifiers.includes(""), "Should not contain empty strings");
    assert.ok(!specifiers.some(s => typeof s === "string" && s.trim() === ""), "Should not contain whitespace-only strings");
  });

  it("on non-win32, does NOT add APPDATA fallback", () => {
    if (process.platform !== "win32") {
      const specifiers = getExtensionApiImportSpecifiers();
      const hasAppData = specifiers.some(s => s.includes("AppData") && s.includes("npm"));
      assert.ok(!hasAppData, "Non-Windows should not add APPDATA fallback");
    }
  });

  it("on win32 with APPDATA, includes APPDATA fallback as file:// URL", () => {
    if (process.platform === "win32" && process.env.APPDATA) {
      const specifiers = getExtensionApiImportSpecifiers();
      const appDataSpec = specifiers.find(s => s.includes("AppData") && s.includes("npm"));
      assert.ok(appDataSpec, `Expected APPDATA path in specifiers: ${JSON.stringify(specifiers)}`);
      assert.ok(appDataSpec.startsWith("file://"), `APPDATA specifier should be file:// URL, got: ${appDataSpec}`);
    }
  });

  it("on win32 without APPDATA env var, does not crash", () => {
    if (process.platform === "win32") {
      const original = process.env.APPDATA;
      delete process.env.APPDATA;
      try {
        // Should not throw - just skip the APPDATA fallback
        const specifiers = getExtensionApiImportSpecifiers();
        assert.ok(Array.isArray(specifiers), "Should return array even without APPDATA");
      } finally {
        if (original !== undefined) process.env.APPDATA = original;
      }
    }
  });
});

// ============================================================================
// Integration: pathToFileURL Windows path conversion
// ============================================================================

describe("pathToFileURL Windows path conversion", () => {
  it("produces valid file:// URL from Windows backslash path", async () => {
    const { pathToFileURL } = await import("node:url");
    const input = "C:\\Users\\admin\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\extensionAPI.js";
    const result = pathToFileURL(input).href;
    assert.equal(result, "file:///C:/Users/admin/AppData/Roaming/npm/node_modules/openclaw/dist/extensionAPI.js");
  });

  it("produces valid file:// URL from Windows forward-slash path", async () => {
    const { pathToFileURL } = await import("node:url");
    const input = "D:/Program Files/openclaw/dist/extensionAPI.js";
    const result = pathToFileURL(input).href;
    assert.ok(result.startsWith("file://"));
    assert.ok(result.includes("D:/"));
  });
});