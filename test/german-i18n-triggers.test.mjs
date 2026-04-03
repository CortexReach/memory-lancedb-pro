import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import jitiFactory from "jiti";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginSdkStubPath = path.resolve(testDir, "helpers", "openclaw-plugin-sdk-stub.mjs");

const jiti = jitiFactory(import.meta.url, {
  interopDefault: true,
  alias: {
    "openclaw/plugin-sdk": pluginSdkStubPath,
  },
});

// --- shouldCapture (index.ts) ---
const { shouldCapture } = jiti("../index.ts");

// --- shouldSkipRetrieval (adaptive-retrieval.ts) ---
const { shouldSkipRetrieval } = jiti("../src/adaptive-retrieval.ts");

// ==========================================================================
// shouldCapture â German positive cases
// ==========================================================================
describe("shouldCapture â German triggers", () => {
  // --- Memory / remember commands ---
  it("captures 'Merke dir: mein API-Key ist xyz'", () => {
    assert.equal(shouldCapture("Merke dir: mein API-Key ist xyz"), true);
  });

  it("captures 'Merk dir das bitte'", () => {
    assert.equal(shouldCapture("Merk dir das bitte fÃ¼r spÃ¤ter"), true);
  });

  it("captures 'Merk es dir: wir nutzen Postgres'", () => {
    assert.equal(shouldCapture("Merk es dir: wir nutzen Postgres"), true);
  });

  it("captures 'Vergiss nicht: deployment immer Ã¼ber CI'", () => {
    assert.equal(shouldCapture("Vergiss nicht: deployment immer Ã¼ber CI"), true);
  });

  it("captures 'Vergiss das nicht: Port 8080'", () => {
    assert.equal(shouldCapture("Vergiss das nicht: Port 8080 fÃ¼r dev"), true);
  });

  it("captures 'Nicht vergessen: Meeting um 14 Uhr'", () => {
    assert.equal(shouldCapture("Nicht vergessen: Meeting um 14 Uhr"), true);
  });

  it("captures 'Erinnere dich an die neue Config'", () => {
    assert.equal(shouldCapture("Erinnere dich an die neue Config"), true);
  });

  it("captures 'Erinner dich: Redis auf Port 6379'", () => {
    assert.equal(shouldCapture("Erinner dich: Redis auf Port 6379"), true);
  });

  // --- Preference triggers ---
  it("captures 'Ich bevorzuge TypeScript Ã¼ber JavaScript'", () => {
    assert.equal(shouldCapture("Ich bevorzuge TypeScript Ã¼ber JavaScript"), true);
  });

  it("captures 'Ich mag keine Tabs, nur Spaces'", () => {
    assert.equal(shouldCapture("Ich mag keine Tabs, nur Spaces"), true);
  });

  it("captures 'Ich hasse lange Meetings'", () => {
    assert.equal(shouldCapture("Ich hasse lange Meetings ohne Agenda"), true);
  });

  it("captures 'Ich will Tests vor dem Merge'", () => {
    assert.equal(shouldCapture("Ich will Tests vor dem Merge immer durchfÃ¼hren"), true);
  });

  it("captures 'Ich brauche eine Zusammenfassung'", () => {
    assert.equal(shouldCapture("Ich brauche immer eine Zusammenfassung"), true);
  });

  // --- Decision triggers ---
  it("captures 'Wir haben entschieden: Kubernetes statt Docker Swarm'", () => {
    assert.equal(shouldCapture("Wir haben entschieden: Kubernetes statt Docker Swarm"), true);
  });

  it("captures 'Wir nutzen ab jetzt pnpm'", () => {
    assert.equal(shouldCapture("Wir nutzen ab jetzt pnpm statt npm"), true);
  });

  it("captures 'Ab sofort deployen wir nur Ã¼ber main'", () => {
    assert.equal(shouldCapture("Ab sofort deployen wir nur Ã¼ber main"), true);
  });

  it("captures 'In Zukunft verwenden wir ESLint flat config'", () => {
    assert.equal(shouldCapture("In Zukunft verwenden wir ESLint flat config"), true);
  });

  // --- Personal info triggers ---
  it("captures 'Mein Name ist Max'", () => {
    assert.equal(shouldCapture("Mein Name ist Max und ich bin Entwickler"), true);
  });

  it("captures 'Mein Projekt heiÃt OpenClaw'", () => {
    assert.equal(shouldCapture("Mein Projekt heiÃt OpenClaw"), true);
  });

  it("captures 'Ich wohne in Berlin'", () => {
    assert.equal(shouldCapture("Ich wohne in Berlin seit drei Jahren"), true);
  });

  it("captures 'Ich arbeite bei Anthropic'", () => {
    assert.equal(shouldCapture("Ich arbeite bei Anthropic als Engineer"), true);
  });

  // --- Scoped intent triggers for 'immer' ---
  it("captures 'immer wenn wir deployen' (intent: conditional)", () => {
    assert.equal(shouldCapture("Immer wenn wir deployen, mÃ¼ssen wir Tests laufen lassen"), true);
  });

  it("captures 'immer daran denken' (intent: reminder)", () => {
    assert.equal(shouldCapture("Immer daran denken: Backups vor Migration"), true);
  });

  it("captures 'immer merken' (intent: memory)", () => {
    assert.equal(shouldCapture("Immer merken: Port 5432 ist reserviert"), true);
  });

  it("captures 'Niemals ohne Review mergen'", () => {
    assert.equal(shouldCapture("Niemals ohne Review mergen, das ist Pflicht"), true);
  });

  it("captures 'Wichtig: erst testen, dann deployen'", () => {
    assert.equal(shouldCapture("Wichtig: erst testen, dann deployen"), true);
  });
});

// ==========================================================================
// shouldCapture â German negative / false-positive cases
// ==========================================================================
describe("shouldCapture â German false-positive prevention", () => {
  it("does NOT capture 'Zimmermann' (contains 'immer' substring)", () => {
    assert.equal(shouldCapture("Herr Zimmermann hat angerufen und eine Nachricht hinterlassen"), false);
  });

  it("does NOT capture 'Schwimmerin' (contains 'immer' substring)", () => {
    assert.equal(shouldCapture("Die Schwimmerin hat den Wettkampf gewonnen heute Mittag"), false);
  });

  it("does NOT capture 'Flimmern' (contains 'immer' substring)", () => {
    assert.equal(shouldCapture("Das Flimmern auf dem Monitor ist stÃ¶rend und nervt mich"), false);
  });

  it("does NOT capture 'Das ist immer so' (standalone 'immer' without intent context)", () => {
    assert.equal(shouldCapture("Das ist immer so in Production bei uns"), false);
  });

  it("does NOT capture 'Wichtigkeit' (contains 'wichtig' substring but word boundary fails)", () => {
    assert.equal(shouldCapture("Die Wichtigkeit dieser Metrik wird Ã¼berschÃ¤tzt finde ich"), false);
  });

  it("does NOT capture 'Er heiÃt Peter' (no 'mein' prefix)", () => {
    assert.equal(shouldCapture("Er heiÃt Peter und kommt aus Hamburg in Norddeutschland"), false);
  });

  it("does NOT capture 'Die Stadt heiÃt Berlin' (no 'mein' prefix)", () => {
    assert.equal(shouldCapture("Die Stadt heiÃt Berlin und ist die Hauptstadt Deutschlands"), false);
  });

  it("does NOT capture 'Sie wohne dort seit Jahren' (no 'ich' prefix)", () => {
    // 'wohne' without 'ich' should not match
    assert.equal(shouldCapture("Das GebÃ¤ude in dem sie wohne ist renoviert worden letztes Jahr"), false);
  });

  it("does NOT capture too-short German text", () => {
    assert.equal(shouldCapture("Wichtig"), false);  // < 10 chars
  });

  it("does NOT capture too-long German text (>500 chars)", () => {
    const longText = "Wichtig: " + "a".repeat(500);
    assert.equal(shouldCapture(longText), false);
  });
});

// ==========================================================================
// shouldSkipRetrieval â German force-retrieve patterns
// ==========================================================================
describe("shouldSkipRetrieval â German retrieval triggers", () => {
  it("forces retrieval for 'Erinnerst du dich an den Bug?'", () => {
    assert.equal(shouldSkipRetrieval("Erinnerst du dich an den Bug von gestern?"), false);
  });

  it("forces retrieval for 'WeiÃt du noch welchen Port wir nutzen?'", () => {
    assert.equal(shouldSkipRetrieval("WeiÃt du noch welchen Port wir nutzen?"), false);
  });

  it("forces retrieval for 'Was war mein API-Key?'", () => {
    assert.equal(shouldSkipRetrieval("Was war mein API-Key nochmal?"), false);
  });

  it("forces retrieval for 'Was ist mein bevorzugter Editor?'", () => {
    assert.equal(shouldSkipRetrieval("Was ist mein bevorzugter Editor?"), false);
  });

  it("forces retrieval for 'Letztes Mal hatten wir Probleme'", () => {
    assert.equal(shouldSkipRetrieval("Letztes Mal hatten wir Probleme mit dem Deploy"), false);
  });

  it("forces retrieval for 'Vorher war das anders konfiguriert'", () => {
    assert.equal(shouldSkipRetrieval("Vorher war das anders konfiguriert"), false);
  });

  it("forces retrieval for 'Vorhin habe ich dir was gesagt'", () => {
    assert.equal(shouldSkipRetrieval("Vorhin habe ich dir was gesagt"), false);
  });

  it("forces retrieval for 'Gestern hatten wir den Fehler'", () => {
    assert.equal(shouldSkipRetrieval("Gestern hatten wir den gleichen Fehler"), false);
  });

  it("forces retrieval for 'Neulich hast du das richtig gemacht'", () => {
    assert.equal(shouldSkipRetrieval("Neulich hast du das richtig gemacht"), false);
  });

  it("forces retrieval for 'Habe ich dir gesagt dass wir Postgres nutzen?'", () => {
    assert.equal(shouldSkipRetrieval("Habe ich dir gesagt dass wir Postgres nutzen?"), false);
  });

  it("forces retrieval for 'Habe ich erwÃ¤hnt dass Tests Pflicht sind?'", () => {
    assert.equal(shouldSkipRetrieval("Habe ich erwÃ¤hnt dass Tests Pflicht sind?"), false);
  });

  it("forces retrieval for 'Merke dir: wir nutzen nur main' (also a capture trigger)", () => {
    assert.equal(shouldSkipRetrieval("Merke dir: wir nutzen nur main"), false);
  });

  // -- Negative: short non-question commands SHOULD skip retrieval --
  it("skips retrieval for short command 'ls -la'", () => {
    assert.equal(shouldSkipRetrieval("ls -la"), true);
  });

  it("skips retrieval for short affirmation 'ok danke'", () => {
    assert.equal(shouldSkipRetrieval("ok danke"), true);
  });

  // -- German force-retrieve should override length-based skip --
  it("forces retrieval for short 'vorher?' (< 15 chars but matches pattern)", () => {
    assert.equal(shouldSkipRetrieval("vorher?"), false);
  });
});

// ==========================================================================
// Explicit remember command consistency
// ==========================================================================
describe("shouldCapture â explicit remember command consistency", () => {
  // All German remember variants should be captured by shouldCapture
  const explicitForms = [
    "Merk dir!",                     // short imperative
    "Merke dir!",                    // formal imperative
    "Merk es dir!",                  // emphatic variant
    "Vergiss nicht!",                // negation imperative
    "Vergiss das nicht!",            // negation with object
    "Nicht vergessen!",              // reversed negation
  ];

  // These are short (< 10 chars) so some won't fire shouldCapture due to length.
  // We test them padded to ensure the regex itself works.
  for (const form of explicitForms) {
    const padded = form.length < 10 ? `${form} das ist relevant fÃ¼r spÃ¤ter` : form;
    it(`captures padded form: "${padded}"`, () => {
      assert.equal(shouldCapture(padded), true,
        `Expected shouldCapture to return true for: "${padded}"`);
    });
  }
});

console.log("OK: german-i18n-triggers test passed");
