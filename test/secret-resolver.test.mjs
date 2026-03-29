import assert from "node:assert/strict";
import { describe, it } from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const {
  resolveEnvVarsSync,
  resolveSecretValue,
  resolveSecretValues,
} = jiti("../src/secret-resolver.ts");

describe("secret resolver", () => {
  it("resolves environment-variable templates synchronously", () => {
    const value = resolveEnvVarsSync("${TEST_SECRET_VALUE}", {
      TEST_SECRET_VALUE: "resolved",
    });
    assert.equal(value, "resolved");
  });

  it("passes through plain strings without executing bws", async () => {
    let called = false;
    const value = await resolveSecretValue("plain-value", {
      execFileImpl: async () => {
        called = true;
        return { stdout: "", stderr: "" };
      },
    });
    assert.equal(value, "plain-value");
    assert.equal(called, false);
  });

  it("resolves bws:// refs via the Bitwarden CLI", async () => {
    let captured;
    const value = await resolveSecretValue(
      "bws://49e0d691-11c4-43cc-a3f9-b40e00f83237?profile=${BWS_PROFILE}",
      {
        env: { BWS_PROFILE: "ops" },
        execFileImpl: async (file, args) => {
          captured = { file, args };
          return {
            stdout: JSON.stringify({
              id: "49e0d691-11c4-43cc-a3f9-b40e00f83237",
              value: "secret-from-bws",
            }),
            stderr: "",
          };
        },
      },
    );

    assert.equal(value, "secret-from-bws");
    assert.deepEqual(captured, {
      file: "bws",
      args: [
        "secret",
        "get",
        "49e0d691-11c4-43cc-a3f9-b40e00f83237",
        "--output",
        "json",
        "--profile",
        "ops",
      ],
    });
  });

  it("resolves arrays of secret refs", async () => {
    const values = await resolveSecretValues(
      ["bws://first-secret", "${SECOND_SECRET}"],
      {
        env: { SECOND_SECRET: "second-value" },
        execFileImpl: async (_file, args) => ({
          stdout: JSON.stringify({
            id: args[2],
            value: `${args[2]}-value`,
          }),
          stderr: "",
        }),
      },
    );

    assert.deepEqual(values, ["first-secret-value", "second-value"]);
  });

  it("throws on bws:// URL with no secret ID (empty hostname and path)", async () => {
    await assert.rejects(
      () => resolveSecretValue("bws:///", {}),
      /Invalid Bitwarden secret reference/,
    );
  });

  it("throws on bws:// URL with only a slash path and no hostname", async () => {
    await assert.rejects(
      () => resolveSecretValue("bws:///secret/", {}),
      /Invalid Bitwarden secret reference/,
    );
  });

  it("throws on bws:// URL where secret ID reduces to empty after prefix strip", async () => {
    await assert.rejects(
      () => resolveSecretValue("bws://secret/", {}),
      /Invalid Bitwarden secret reference/,
    );
  });
});
