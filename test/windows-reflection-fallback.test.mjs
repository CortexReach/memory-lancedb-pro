import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginSdkStubPath = path.resolve(testDir, "helpers", "openclaw-plugin-sdk-stub.mjs");
const jiti = jitiFactory(import.meta.url, {
  interopDefault: true,
  alias: {
    "openclaw/plugin-sdk": pluginSdkStubPath,
  },
});

const {
  toImportSpecifier,
  getExtensionApiImportSpecifiers,
} = jiti("../index.ts");

describe("Windows reflection fallback helpers", () => {
  it("converts Windows paths when platform is provided explicitly", () => {
    const result = toImportSpecifier(
      "C:\\Users\\admin\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\extensionAPI.js",
      "win32",
    );
    assert.ok(result.startsWith("file:///C:/"), `Expected Windows file:// URL, got: ${result}`);
    assert.ok(result.includes("AppData/Roaming/npm"));
  });

  it("converts UNC paths when platform is provided explicitly", () => {
    const result = toImportSpecifier(
      "\\\\server\\share\\openclaw\\dist\\extensionAPI.js",
      "win32",
    );
    assert.ok(result.startsWith("file://"), `Expected file:// URL, got: ${result}`);
    assert.ok(result.includes("server"));
    assert.ok(result.includes("share"));
  });

  it("omits POSIX extension API fallbacks on Windows", () => {
    const specifiers = getExtensionApiImportSpecifiers({
      platform: "win32",
      env: {
        APPDATA: "C:\\Users\\admin\\AppData\\Roaming",
        ProgramFiles: "C:\\Program Files",
      },
      resolveOpenClawExtensionApi: () => {
        throw new Error("openclaw package not installed in test process");
      },
    });

    assert.ok(!specifiers.some((s) => s.includes("/usr/lib")), `Unexpected /usr/lib fallback: ${JSON.stringify(specifiers)}`);
    assert.ok(!specifiers.some((s) => s.includes("/usr/local")), `Unexpected /usr/local fallback: ${JSON.stringify(specifiers)}`);
    assert.ok(!specifiers.some((s) => s.includes("/opt/homebrew")), `Unexpected /opt/homebrew fallback: ${JSON.stringify(specifiers)}`);
    assert.ok(specifiers.some((s) => s.includes("AppData/Roaming/npm")), `Expected APPDATA fallback: ${JSON.stringify(specifiers)}`);
    assert.ok(specifiers.some((s) => s.includes("Program%20Files/nodejs")), `Expected Program Files fallback: ${JSON.stringify(specifiers)}`);
  });


});
