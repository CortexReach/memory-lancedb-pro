import { test } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { summarizeScopesByType, createScopeManager } = jiti("../src/scopes.ts");

test("configured scopes and observed scopes are counted separately", () => {
  const scopeManager = createScopeManager({
    default: "global",
    definitions: {
      global: { description: "Shared scope" },
    },
  });

  const configured = scopeManager.getStats();
  const observed = summarizeScopesByType(["global", "agent:main", "agent:junshi"]);

  assert.equal(configured.totalScopes, 1);
  assert.equal(configured.scopesByType.global, 1);
  assert.equal(configured.scopesByType.agent, 0);

  assert.equal(observed.totalScopes, 3);
  assert.equal(observed.scopesByType.global, 1);
  assert.equal(observed.scopesByType.agent, 2);
});

test("observed scope summary handles empty scope list", () => {
  const observed = summarizeScopesByType([]);
  assert.equal(observed.totalScopes, 0);
  assert.equal(observed.scopesByType.global, 0);
  assert.equal(observed.scopesByType.agent, 0);
});
