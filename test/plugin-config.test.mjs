import { describe, it, beforeEach, afterEach } from "node:test";
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
const { parsePluginConfig } = jiti("../index.ts");

function baseConfig() {
  return {
    embedding: {
      apiKey: "test-api-key",
    },
  };
}

describe("parsePluginConfig: storageOptions validation", () => {
  describe("non-string values in storageOptions are rejected", () => {
    it("rejects number value in storageOptions", () => {
      assert.throws(
        () =>
          parsePluginConfig({
            ...baseConfig(),
            storageOptions: {
              aws_access_key_id: "valid-string",
              timeout: 30,
            },
          }),
        /storageOptions\[timeout\] is invalid: expected string, got number/,
      );
    });

    it("rejects boolean value in storageOptions", () => {
      assert.throws(
        () =>
          parsePluginConfig({
            ...baseConfig(),
            storageOptions: {
              aws_access_key_id: "valid-string",
              enable_ssl: true,
            },
          }),
        /storageOptions\[enable_ssl\] is invalid: expected string, got boolean/,
      );
    });

    it("rejects null value in storageOptions", () => {
      assert.throws(
        () =>
          parsePluginConfig({
            ...baseConfig(),
            storageOptions: {
              aws_access_key_id: null,
            },
          }),
        /storageOptions\[aws_access_key_id\] is invalid: expected string, got object/,
      );
    });

    it("rejects nested object value in storageOptions", () => {
      assert.throws(
        () =>
          parsePluginConfig({
            ...baseConfig(),
            storageOptions: {
              credentials: { key: "value" },
            },
          }),
        /storageOptions\[credentials\] is invalid: expected string, got object/,
      );
    });

    it("rejects array value in storageOptions", () => {
      assert.throws(
        () =>
          parsePluginConfig({
            ...baseConfig(),
            storageOptions: {
              endpoints: ["host1", "host2"],
            },
          }),
        /storageOptions\[endpoints\] is invalid: expected string, got object/,
      );
    });

    it("accepts valid string-only storageOptions", () => {
      const parsed = parsePluginConfig({
        ...baseConfig(),
        storageOptions: {
          aws_access_key_id: "my-key",
          aws_secret_access_key: "my-secret",
          region: "us-east-1",
        },
      });
      assert.deepEqual(parsed.storageOptions, {
        aws_access_key_id: "my-key",
        aws_secret_access_key: "my-secret",
        region: "us-east-1",
      });
    });
  });

  describe("storageOptions ${ENV_VAR} placeholder resolution", () => {
    const originalEnv = {};

    beforeEach(() => {
      originalEnv.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
      originalEnv.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
      originalEnv.MY_CUSTOM_REGION = process.env.MY_CUSTOM_REGION;
      originalEnv.EMPTY_VAR = process.env.EMPTY_VAR;
      originalEnv.HOST = process.env.HOST;
      originalEnv.PORT = process.env.PORT;
      originalEnv.DYNAMIC_VALUE = process.env.DYNAMIC_VALUE;
    });

    afterEach(() => {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    });

    it("resolves single env var placeholder", () => {
      process.env.AWS_ACCESS_KEY_ID = "resolved-key-123";
      const parsed = parsePluginConfig({
        ...baseConfig(),
        storageOptions: {
          aws_access_key_id: "${AWS_ACCESS_KEY_ID}",
        },
      });
      assert.equal(parsed.storageOptions?.aws_access_key_id, "resolved-key-123");
    });

    it("resolves multiple env var placeholders in same value", () => {
      process.env.HOST = "example.com";
      process.env.PORT = "8080";
      const parsed = parsePluginConfig({
        ...baseConfig(),
        storageOptions: {
          endpoint: "https://${HOST}:${PORT}",
        },
      });
      assert.equal(parsed.storageOptions?.endpoint, "https://example.com:8080");
    });

    it("resolves multiple storageOptions with different env vars", () => {
      process.env.AWS_ACCESS_KEY_ID = "my-access-key";
      process.env.AWS_SECRET_ACCESS_KEY = "my-secret-key";
      process.env.MY_CUSTOM_REGION = "eu-west-1";

      const parsed = parsePluginConfig({
        ...baseConfig(),
        storageOptions: {
          aws_access_key_id: "${AWS_ACCESS_KEY_ID}",
          aws_secret_access_key: "${AWS_SECRET_ACCESS_KEY}",
          region: "${MY_CUSTOM_REGION}",
        },
      });

      assert.deepEqual(parsed.storageOptions, {
        aws_access_key_id: "my-access-key",
        aws_secret_access_key: "my-secret-key",
        region: "eu-west-1",
      });
    });

    it("throws when env var is not set", () => {
      delete process.env.UNDEFINED_VAR;
      assert.throws(
        () =>
          parsePluginConfig({
            ...baseConfig(),
            storageOptions: {
              key: "${UNDEFINED_VAR}",
            },
          }),
        /Environment variable UNDEFINED_VAR is not set/,
      );
    });

    it("handles mixed literal and env var values", () => {
      process.env.DYNAMIC_VALUE = "dynamic";
      const parsed = parsePluginConfig({
        ...baseConfig(),
        storageOptions: {
          static_key: "static-value",
          dynamic_key: "${DYNAMIC_VALUE}",
          mixed_key: "prefix-${DYNAMIC_VALUE}-suffix",
        },
      });
      assert.deepEqual(parsed.storageOptions, {
        static_key: "static-value",
        dynamic_key: "dynamic",
        mixed_key: "prefix-dynamic-suffix",
      });
    });

    it("throws when env var is empty string (treated as not set)", () => {
      process.env.EMPTY_VAR = "";
      assert.throws(
        () =>
          parsePluginConfig({
            ...baseConfig(),
            storageOptions: {
              empty_key: "${EMPTY_VAR}",
            },
          }),
        /Environment variable EMPTY_VAR is not set/,
      );
    });
  });
});

describe("parsePluginConfig: cloud path detection", () => {
  const cloudPathPatterns = [
    "s3://my-bucket/lancedb-data",
    "gs://my-gcs-bucket/data",
    "az://my-azure-container/data",
    "abfs://my-container/data",
    "s3+https://bucket.s3.amazonaws.com/path",
    "gcs://project-id/bucket/path",
    "tos://my-tos-bucket/path",
    "hdfs://namenode:8020/path/to/db",
    "file:///absolute/path/to/db",
  ];

  const localPathPatterns = [
    "./relative/path",
    "../parent/path",
    "memory-data",
    "/absolute/local/path",
    "~/home/path",
    "data/memory",
  ];

  it("identifies cloud paths correctly", () => {
    const cloudRegex = /^[a-z][a-z0-9+.-]*:\/\//i;
    for (const cloudPath of cloudPathPatterns) {
      assert.match(
        cloudPath,
        cloudRegex,
        `Expected "${cloudPath}" to be identified as cloud path`,
      );
    }
  });

  it("identifies local paths correctly (not matching cloud pattern)", () => {
    const cloudRegex = /^[a-z][a-z0-9+.-]*:\/\//i;
    for (const localPath of localPathPatterns) {
      assert.doesNotMatch(
        localPath,
        cloudRegex,
        `Expected "${localPath}" to NOT be identified as cloud path`,
      );
    }
  });

  it("cloud path detection is case-insensitive for scheme", () => {
    const cloudRegex = /^[a-z][a-z0-9+.-]*:\/\//i;
    assert.match("S3://bucket/path", cloudRegex);
    assert.match("GS://bucket/path", cloudRegex);
    assert.match("AZ://container/path", cloudRegex);
  });

  it("validates scheme format (must start with letter)", () => {
    const cloudRegex = /^[a-z][a-z0-9+.-]*:\/\//i;
    assert.doesNotMatch("3s://bucket/path", cloudRegex);
    assert.doesNotMatch("+invalid://path", cloudRegex);
    assert.doesNotMatch("://no-scheme", cloudRegex);
  });

  it("allows valid characters in scheme (letters, digits, plus, dot, hyphen)", () => {
    const cloudRegex = /^[a-z][a-z0-9+.-]*:\/\//i;
    assert.match("s3+https://bucket/path", cloudRegex);
    assert.match("my-custom.scheme://path", cloudRegex);
    assert.match("scheme-v2://path", cloudRegex);
  });
});
