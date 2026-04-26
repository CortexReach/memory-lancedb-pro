/**
 * Test: toImportSpecifier and Windows path fallback
 * PR #593 - Windows path support for extensionAPI.js
 *
 * Tests the behavior of `toImportSpecifier` and `getExtensionApiImportSpecifiers`.
 * Both functions are imported from index.ts (exported for testing).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginSdkStubPath = path.resolve(testDir, "helpers", "openclaw-plugin-sdk-stub.mjs");
const jitiLib = jitiFactory(import.meta.url, {
  interopDefault: true,
  alias: {
    "openclaw/plugin-sdk": pluginSdkStubPath,
  },
});

// Import actual implementations from index.ts via jiti (both exported for testing)
const { toImportSpecifier, getExtensionApiImportSpecifiers } = jitiLib("../index.ts");

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

  // --- Windows paths ---
  if (process.platform === "win32") {
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

    // --- UNC paths ---
    it("converts UNC path (\\\\server\\share) to file:// URL", () => {
      const result = toImportSpecifier("\\\\server\\share\\path\\to\\file.js");
      assert.ok(result.startsWith("file://"), `Expected file:// URL, got: ${result}`);
    });

    it("converts UNC path with deep nested path to file:// URL", () => {
      const result = toImportSpecifier("\\\\fileserver\\company-share\\openclaw\\dist\\extensionAPI.js");
      assert.ok(result.startsWith("file://"), `Expected file:// URL, got: ${result}`);
      assert.ok(result.includes("fileserver"), `Expected fileserver in URL, got: ${result}`);
      assert.ok(result.includes("company-share"), `Expected company-share in URL, got: ${result}`);
    });

    it("converts long-server-name UNC path to file:// URL", () => {
      const result = toImportSpecifier("\\\\my-long-server-name\\shared-folder\\file.js");
      assert.ok(result.startsWith("file://"), `Expected file:// URL, got: ${result}`);
    });

    it("converts single-level UNC root to file:// URL", () => {
      const result = toImportSpecifier("\\\\server\\share");
      assert.ok(result.startsWith("file://"), `Expected file:// URL, got: ${result}`);
    });

    it("passes through already-normalized \\\\?\\UNC\\\\ prefix unchanged", () => {
      // \\\\?\\UNC\\server\\share should also be converted
      const result = toImportSpecifier("\\\\?\\UNC\\server\\share\\file.js");
      assert.ok(result.startsWith("file://"), `Expected file:// URL, got: ${result}`);
    });

    it("UNC path with spaces in share name converts correctly", () => {
      const result = toImportSpecifier("\\\\server\\my shared folder\\path\\file.js");
      assert.ok(result.startsWith("file://"), `Expected file:// URL, got: ${result}`);
    });
  }

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

  if (process.platform === "win32") {
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
  }
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

  // Windows-specific env-var tests — skip on non-Windows CI
  if (process.platform === "win32") {
    it("converts OPENCLAW_EXTENSION_API_PATH Windows path to file:// URL (hidden issue #1 fix)", () => {
      withEnv("OPENCLAW_EXTENSION_API_PATH", "C:\\Program Files\\openclaw\\dist\\extensionAPI.js", () => {
        const specifiers = getExtensionApiImportSpecifiers();
        const winSpec = specifiers.find(s => s.startsWith("file:///C:/") && s.includes("openclaw") && s.includes("dist") && s.includes("extensionAPI"));
        assert.ok(winSpec, `Expected Windows path as file:// URL: ${JSON.stringify(specifiers)}`);
        assert.ok(winSpec.includes("Program") || winSpec.includes("Program%20"), `Expected Program Files in path, got: ${winSpec}`);
      });
    });

    it("converts OPENCLAW_EXTENSION_API_PATH UNC path to file:// URL", () => {
      withEnv("OPENCLAW_EXTENSION_API_PATH", "\\\\server\\share\\openclaw\\dist\\extensionAPI.js", () => {
        const specifiers = getExtensionApiImportSpecifiers();
        const uncSpec = specifiers.find(s => s.startsWith("file://") && s.includes("server") && s.includes("share"));
        assert.ok(uncSpec, `Expected UNC path as file:// URL: ${JSON.stringify(specifiers)}`);
      });
    });
  }

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
// Integration: pathToFileURL Windows path conversion (Windows-only)
// ============================================================================

if (process.platform === "win32") {
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

    it("produces valid file:// URL from UNC path", async () => {
      const { pathToFileURL } = await import("node:url");
      // UNC: \\\\server\\share\\path -> \\\\?\\UNC\\server\\share\\path -> file://server/share/path
      const uncPath = "\\\\?\\UNC\\\\server\\\\share\\\\path\\\\file.js";
      const result = pathToFileURL(uncPath).href;
      assert.ok(result.startsWith("file://"), `Expected file:// URL, got: ${result}`);
      assert.ok(result.includes("server"), `Expected server in URL, got: ${result}`);
    });
  });
}
