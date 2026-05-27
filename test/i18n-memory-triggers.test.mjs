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

const { shouldCapture, detectCategory } = jiti("../index.ts");
const { shouldSkipRetrieval } = jiti("../src/adaptive-retrieval.ts");

const germanCaptureCases = [
  ["Merke dir: Testtoken ist Cobalt Tiger 7742", "fact"],
  ["Ich bevorzuge Espresso nach dem Mittagessen", "preference"],
  ["Wir haben entschieden ab sofort Qdrant nicht mehr zu nutzen", "decision"],
  ["Mein Projektname ist Atlas Nord", "entity"],
  ["Wichtig: immer die EU-Region fuer Deployments verwenden", "fact"],
];

for (const [text, category] of germanCaptureCases) {
  assert.equal(shouldCapture(text), true, `should capture German memory intent: ${text}`);
  assert.equal(detectCategory(text), category, `should categorize German memory intent: ${text}`);
}

const germanRecallQueries = [
  "Erinnerst du dich an mein Testtoken?",
  "Weisst du noch was mein Projektname war?",
  "Habe ich dir gesagt welche Region wir verwenden?",
  "Was war mein bevorzugtes Deployment-Ziel?",
];

for (const query of germanRecallQueries) {
  assert.equal(shouldSkipRetrieval(query), false, `should force recall for German query: ${query}`);
}
