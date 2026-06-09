import { describe, it, beforeEach } from "node:test";
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
  resetRegistration,
  warnForDisabledChannelPlugin,
} = jiti("../index.ts");

function createLogger() {
  const warnings = [];
  return {
    warnings,
    logger: {
      warn(message) {
        warnings.push(String(message));
      },
    },
  };
}

describe("Telegram plugin status diagnostic", () => {
  beforeEach(() => {
    resetRegistration();
  });

  it("warns when Telegram channel config is enabled but the Telegram plugin is disabled", () => {
    const { logger, warnings } = createLogger();

    warnForDisabledChannelPlugin({
      channels: {
        telegram: { enabled: true },
      },
      plugins: {
        entries: {
          telegram: { enabled: false },
        },
      },
    }, logger);

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /telegram channel config is enabled/i);
    assert.match(warnings[0], /openclaw plugin enable telegram/i);
  });

  it("does not warn repeatedly for the same channel", () => {
    const { logger, warnings } = createLogger();
    const config = {
      channels: { telegram: { enabled: true } },
      plugins: { entries: { telegram: { enabled: false } } },
    };

    warnForDisabledChannelPlugin(config, logger);
    warnForDisabledChannelPlugin(config, logger);

    assert.equal(warnings.length, 1);
  });

  it("stays quiet when the Telegram plugin is not explicitly disabled", () => {
    const { logger, warnings } = createLogger();

    warnForDisabledChannelPlugin({
      channels: {
        telegram: { enabled: true },
      },
      plugins: {
        entries: {
          telegram: { enabled: true },
        },
      },
    }, logger);

    assert.deepEqual(warnings, []);
  });
});
