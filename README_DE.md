<div align="center">

# 🧠 memory-lancedb-pro · 🦞OpenClaw Plugin

**KI-Gedächtnisassistent für [OpenClaw](https://github.com/openclaw/openclaw)-Agenten**

*Geben Sie Ihrem KI-Agenten ein Gehirn, das sich wirklich erinnert — über Sitzungen, Agenten und Zeit hinweg.*

Ein LanceDB-basiertes OpenClaw-Langzeitgedächtnis-Plugin, das Präferenzen, Entscheidungen und Projektkontext speichert und in zukünftigen Sitzungen automatisch abruft.

[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-blue)](https://github.com/openclaw/openclaw)
[![npm version](https://img.shields.io/npm/v/memory-lancedb-pro)](https://www.npmjs.com/package/memory-lancedb-pro)
[![LanceDB](https://img.shields.io/badge/LanceDB-Vectorstore-orange)](https://lancedb.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

[English](README.md) | [简体中文](README_CN.md) | [繁體中文](README_TW.md) | [日本語](README_JA.md) | [한국어](README_KO.md) | [Français](README_FR.md) | [Español](README_ES.md) | [Deutsch](README_DE.md) | [Italiano](README_IT.md) | [Русский](README_RU.md) | [Português (Brasil)](README_PT-BR.md)

</div>

---

## Warum memory-lancedb-pro?

Die meisten KI-Agenten leiden unter Amnesie. Sie vergessen alles, sobald Sie einen neuen Chat starten.

**memory-lancedb-pro** ist ein produktionsreifes Langzeitgedächtnis-Plugin für OpenClaw, das Ihren Agenten in einen echten **KI-Gedächtnisassistenten** verwandelt — es erfasst automatisch, was wichtig ist, lässt Rauschen natürlich verblassen und ruft die richtige Erinnerung zum richtigen Zeitpunkt ab. Kein manuelles Taggen, keine Konfigurationsprobleme.

### Ihr KI-Gedächtnisassistent in Aktion

**Ohne Gedächtnis — jede Sitzung beginnt bei null:**

> **Sie:** „Verwende Tabs für die Einrückung, füge immer Fehlerbehandlung hinzu."
> *(nächste Sitzung)*
> **Sie:** „Ich habe es dir schon gesagt — Tabs, nicht Leerzeichen!" 😤
> *(nächste Sitzung)*
> **Sie:** „…ernsthaft, Tabs. Und Fehlerbehandlung. Schon wieder."

**Mit memory-lancedb-pro — Ihr Agent lernt und erinnert sich:**

> **Sie:** „Verwende Tabs für die Einrückung, füge immer Fehlerbehandlung hinzu."
> *(nächste Sitzung — Agent ruft automatisch Ihre Präferenzen ab)*
> **Agent:** *(wendet still Tabs + Fehlerbehandlung an)* ✅
> **Sie:** „Warum haben wir letzten Monat PostgreSQL statt MongoDB gewählt?"
> **Agent:** „Basierend auf unserer Diskussion am 12. Februar waren die Hauptgründe…" ✅

Das ist der Unterschied, den ein **KI-Gedächtnisassistent** macht — er lernt Ihren Stil, erinnert sich an vergangene Entscheidungen und liefert personalisierte Antworten, ohne dass Sie sich wiederholen müssen.

### Was kann es noch?

| | Was Sie bekommen |
|---|---|
| **Auto-Capture** | Ihr Agent lernt aus jeder Unterhaltung — kein manuelles `memory_store` nötig |
| **Intelligente Extraktion** | LLM-gestützte 6-Kategorien-Klassifikation: Profile, Präferenzen, Entitäten, Ereignisse, Fälle, Muster |
| **Intelligentes Vergessen** | Weibull-Zerfallsmodell — wichtige Erinnerungen bleiben, Rauschen verblasst natürlich |
| **Hybride Suche** | Vektor + BM25 Volltextsuche, fusioniert mit Cross-Encoder-Reranking |
| **Kontextinjektion** | Relevante Erinnerungen tauchen automatisch vor jeder Antwort auf |
| **Multi-Scope-Isolation** | Gedächtnisgrenzen pro Agent, pro Benutzer, pro Projekt |
| **Jeder Anbieter** | OpenAI, Jina, Gemini, Ollama oder jede OpenAI-kompatible API |
| **Vollständiges Toolkit** | CLI, Backup, Migration, Upgrade, Export/Import — produktionsbereit |

---

## Schnellstart

> **CPU-Anforderung:** Deine CPU muss **AVX/AVX2**-Befehle unterstützen (Intel Sandy Bridge 2011+ / AMD Bulldozer 2011+). Die native Vektor-Engine von LanceDB benötigt diese — auf nicht unterstützten CPUs stürzt das Plugin mit `SIGILL` (Illegal Instruction) ab. Prüfe mit: `grep -o 'avx[^ ]*' /proc/cpuinfo | head -1` (keine Ausgabe = nicht unterstützt). Siehe [#419](https://github.com/CortexReach/memory-lancedb-pro/issues/419).

### Option A: Ein-Klick-Installationsskript (empfohlen)

Das community-gepflegte **[Setup-Skript](https://github.com/CortexReach/toolbox/tree/main/memory-lancedb-pro-setup)** erledigt Installation, Upgrade und Reparatur in einem Befehl:

```bash
curl -fsSL https://raw.githubusercontent.com/CortexReach/toolbox/main/memory-lancedb-pro-setup/setup-memory.sh -o setup-memory.sh
bash setup-memory.sh
```

> Siehe [Ökosystem](#ökosystem) unten für die vollständige Liste der abgedeckten Szenarien und andere Community-Tools.

### Option B: Manuelle Installation

**Über OpenClaw CLI (empfohlen):**
```bash
openclaw plugins install memory-lancedb-pro@beta
```

**Oder über npm:**
```bash
npm i memory-lancedb-pro@beta
```
> Bei npm-Installation müssen Sie auch das Plugin-Installationsverzeichnis als **absoluten** Pfad in `plugins.load.paths` Ihrer `openclaw.json` hinzufügen. Dies ist das häufigste Einrichtungsproblem.

Fügen Sie zu Ihrer `openclaw.json` hinzu:

```json
{
  "plugins": {
    "slots": { "memory": "memory-lancedb-pro" },
    "entries": {
      "memory-lancedb-pro": {
        "enabled": true,
        "config": {
          "embedding": {
            "provider": "openai-compatible",
            "apiKey": "${OPENAI_API_KEY}",
            "model": "text-embedding-3-small"
          },
          "autoCapture": true,
          "autoRecall": true,
          "smartExtraction": true,
          "extractMinMessages": 2,
          "extractMaxChars": 8000,
          "sessionMemory": { "enabled": false }
        }
      }
    }
  }
}
```

**Warum diese Standardwerte?**
- `autoCapture` + `smartExtraction` → Ihr Agent lernt automatisch aus jeder Unterhaltung
- `autoRecall` → relevante Erinnerungen werden vor jeder Antwort injiziert
- `extractMinMessages: 2` → Extraktion wird bei normalen Zwei-Runden-Chats ausgelöst
- `sessionMemory.enabled: false` → vermeidet Verschmutzung der Suche durch Sitzungszusammenfassungen am Anfang

Validieren und neu starten:

```bash
openclaw config validate
openclaw gateway restart
openclaw logs --follow --plain | grep "memory-lancedb-pro"
```

Sie sollten sehen:
- `memory-lancedb-pro: smart extraction enabled`
- `memory-lancedb-pro@...: plugin registered`

Fertig! Ihr Agent verfügt jetzt über Langzeitgedächtnis.

<details>
<summary><strong>Weitere Installationswege (bestehende Benutzer, Upgrades)</strong></summary>

**Bereits OpenClaw-Benutzer?**

1. Fügen Sie das Plugin mit einem **absoluten** `plugins.load.paths`-Eintrag hinzu
2. Binden Sie den Memory-Slot: `plugins.slots.memory = "memory-lancedb-pro"`
3. Überprüfen: `openclaw plugins info memory-lancedb-pro && openclaw memory-pro stats`

**Upgrade von vor v1.1.0?**

```bash
# 1) Backup
openclaw memory-pro export --scope global --output memories-backup.json
# 2) Testlauf
openclaw memory-pro upgrade --dry-run
# 3) Upgrade ausführen
openclaw memory-pro upgrade
# 4) Überprüfen
openclaw memory-pro stats
```

Siehe `CHANGELOG-v1.1.0.md` für Verhaltensänderungen und Upgrade-Begründung.

</details>

<details>
<summary><strong>Telegram-Bot-Schnellimport (zum Aufklappen klicken)</strong></summary>

Wenn Sie die Telegram-Integration von OpenClaw verwenden, ist es am einfachsten, einen Importbefehl direkt an den Hauptbot zu senden, anstatt die Konfiguration manuell zu bearbeiten.

Senden Sie diese Nachricht:

```text
Help me connect this memory plugin with the most user-friendly configuration: https://github.com/CortexReach/memory-lancedb-pro

Requirements:
1. Set it as the only active memory plugin
2. Use Jina for embedding
3. Use Jina for reranker
4. Use gpt-4o-mini for the smart-extraction LLM
5. Enable autoCapture, autoRecall, smartExtraction
6. extractMinMessages=2
7. sessionMemory.enabled=false
8. captureAssistant=false
9. retrieval mode=hybrid, vectorWeight=0.7, bm25Weight=0.3
10. rerank=cross-encoder, candidatePoolSize=12, minScore=0.6, hardMinScore=0.62
11. Generate the final openclaw.json config directly, not just an explanation
```

</details>

---

## Ökosystem

memory-lancedb-pro ist das Kern-Plugin. Die Community hat Tools darum herum gebaut, um Einrichtung und tägliche Nutzung noch reibungsloser zu machen:

### Setup-Skript — Ein-Klick-Installation, Upgrade und Reparatur

> **[CortexReach/toolbox/memory-lancedb-pro-setup](https://github.com/CortexReach/toolbox/tree/main/memory-lancedb-pro-setup)**

Nicht nur ein einfacher Installer — das Skript behandelt intelligent eine Vielzahl realer Szenarien:

| Ihre Situation | Was das Skript macht |
|---|---|
| Nie installiert | Frischer Download → Abhängigkeiten installieren → Konfiguration wählen → in openclaw.json schreiben → Neustart |
| Per `git clone` installiert, auf altem Commit hängen geblieben | Automatisches `git fetch` + `checkout` auf neueste Version → Abhängigkeiten neu installieren → Verifizieren |
| Konfiguration hat ungültige Felder | Automatische Erkennung per Schema-Filter, nicht unterstützte Felder entfernen |
| Per `npm` installiert | Überspringt Git-Update, erinnert Sie daran, `npm update` selbst auszuführen |
| `openclaw` CLI durch ungültige Konfiguration defekt | Fallback: Workspace-Pfad direkt aus der `openclaw.json`-Datei lesen |
| `extensions/` statt `plugins/` | Automatische Erkennung des Plugin-Standorts aus Konfiguration oder Dateisystem |
| Bereits aktuell | Nur Gesundheitschecks ausführen, keine Änderungen |

```bash
bash setup-memory.sh                    # Installieren oder upgraden
bash setup-memory.sh --dry-run          # Nur Vorschau
bash setup-memory.sh --beta             # Pre-Release-Versionen einschließen
bash setup-memory.sh --uninstall        # Konfiguration zurücksetzen und Plugin entfernen
```

Eingebaute Anbieter-Presets: **Jina / DashScope / SiliconFlow / OpenAI / Ollama**, oder bringen Sie Ihre eigene OpenAI-kompatible API mit. Für die vollständige Nutzung (einschließlich `--ref`, `--selfcheck-only` und mehr) siehe das [Setup-Skript README](https://github.com/CortexReach/toolbox/tree/main/memory-lancedb-pro-setup).

### Claude Code / OpenClaw Skill — KI-geführte Konfiguration

> **[CortexReach/memory-lancedb-pro-skill](https://github.com/CortexReach/memory-lancedb-pro-skill)**

Installieren Sie diesen Skill und Ihr KI-Agent (Claude Code oder OpenClaw) erhält tiefgreifendes Wissen über alle Funktionen von memory-lancedb-pro. Sagen Sie einfach **„hilf mir die beste Konfiguration zu aktivieren"** und erhalten Sie:

- **Geführter 7-Schritte-Konfigurationsworkflow** mit 4 Bereitstellungsplänen:
  - Full Power (Jina + OpenAI) / Budget (kostenloser SiliconFlow Reranker) / Simple (nur OpenAI) / Vollständig lokal (Ollama, null API-Kosten)
- **Alle 9 MCP-Tools** korrekt verwendet: `memory_recall`, `memory_store`, `memory_forget`, `memory_update`, `memory_stats`, `memory_list`, `self_improvement_log`, `self_improvement_extract_skill`, `self_improvement_review` *(vollständiges Toolset erfordert `enableManagementTools: true` — die Standard-Schnellstart-Konfiguration stellt nur die 4 Kern-Tools bereit)*
- **Vermeidung häufiger Fallstricke**: Workspace-Plugin-Aktivierung, `autoRecall` standardmäßig false, jiti-Cache, Umgebungsvariablen, Scope-Isolation und mehr

**Installation für Claude Code:**
```bash
git clone https://github.com/CortexReach/memory-lancedb-pro-skill.git ~/.claude/skills/memory-lancedb-pro
```

**Installation für OpenClaw:**
```bash
git clone https://github.com/CortexReach/memory-lancedb-pro-skill.git ~/.openclaw/workspace/skills/memory-lancedb-pro-skill
```

---

## Video-Tutorial

> Vollständige Anleitung: Installation, Konfiguration und Funktionsweise der hybriden Suche.

[![YouTube Video](https://img.shields.io/badge/YouTube-Watch%20Now-red?style=for-the-badge&logo=youtube)](https://youtu.be/MtukF1C8epQ)
**https://youtu.be/MtukF1C8epQ**

[![Bilibili Video](https://img.shields.io/badge/Bilibili-Watch%20Now-00A1D6?style=for-the-badge&logo=bilibili&logoColor=white)](https://www.bilibili.com/video/BV1zUf2BGEgn/)
**https://www.bilibili.com/video/BV1zUf2BGEgn/**

---

## Architektur

```
┌─────────────────────────────────────────────────────────┐
│                   index.ts (Einstiegspunkt)             │
│  Plugin-Registrierung · Config-Parsing · Lifecycle-Hooks│
└────────┬──────────┬──────────┬──────────┬───────────────┘
         │          │          │          │
    ┌────▼───┐ ┌────▼───┐ ┌───▼────┐ ┌──▼──────────┐
    │ store  │ │embedder│ │retriever│ │   scopes    │
    │ .ts    │ │ .ts    │ │ .ts    │ │    .ts      │
    └────────┘ └────────┘ └────────┘ └─────────────┘
         │                     │
    ┌────▼───┐           ┌─────▼──────────┐
    │migrate │           │noise-filter.ts │
    │ .ts    │           │adaptive-       │
    └────────┘           │retrieval.ts    │
                         └────────────────┘
    ┌─────────────┐   ┌──────────┐
    │  tools.ts   │   │  cli.ts  │
    │ (Agent-API) │   │ (CLI)    │
    └─────────────┘   └──────────┘
```

> Für eine detaillierte Analyse der vollständigen Architektur siehe [docs/memory_architecture_analysis.md](docs/memory_architecture_analysis.md).

<details>
<summary><strong>Dateireferenz (zum Aufklappen klicken)</strong></summary>

| Datei | Zweck |
| --- | --- |
| `index.ts` | Plugin-Einstiegspunkt. Registriert sich bei der OpenClaw Plugin API, parst Konfiguration, bindet Lifecycle-Hooks ein |
| `openclaw.plugin.json` | Plugin-Metadaten + vollständige JSON-Schema-Konfigurationsdeklaration |
| `cli.ts` | CLI-Befehle: `memory-pro list/search/stats/delete/delete-bulk/export/import/reembed/upgrade/migrate` |
| `src/store.ts` | LanceDB-Speicherschicht. Tabellenerstellung / FTS-Indexierung / Vektorsuche / BM25-Suche / CRUD |
| `src/embedder.ts` | Embedding-Abstraktion. Kompatibel mit jedem OpenAI-kompatiblen API-Anbieter |
| `src/retriever.ts` | Hybride Suchmaschine. Vektor + BM25 → Hybride Fusion → Rerank → Lifecycle-Zerfall → Filter |
| `src/scopes.ts` | Multi-Scope-Zugriffskontrolle |
| `src/tools.ts` | Agent-Tool-Definitionen: `memory_recall`, `memory_store`, `memory_forget`, `memory_update` + Verwaltungstools |
| `src/noise-filter.ts` | Filtert Agent-Ablehnungen, Meta-Fragen, Begrüßungen und minderwertige Inhalte |
| `src/adaptive-retrieval.ts` | Bestimmt, ob eine Abfrage Gedächtnisabruf benötigt |
| `src/migrate.ts` | Migration vom eingebauten `memory-lancedb` zu Pro |
| `src/smart-extractor.ts` | LLM-gestützte 6-Kategorien-Extraktion mit L0/L1/L2 Schichtspeicherung und zweistufiger Deduplizierung |
| `src/decay-engine.ts` | Weibull Stretched-Exponential-Zerfallsmodell |
| `src/tier-manager.ts` | Dreistufige Beförderung/Herabstufung: Peripheral ↔ Working ↔ Core |

</details>

---

## Kernfunktionen

### Hybride Suche

```
Query → embedQuery() ─┐
                       ├─→ Hybride Fusion → Rerank → Lifecycle-Zerfall-Boost → Längennorm → Filter
Query → BM25 FTS ─────┘
```

- **Vektorsuche** — semantische Ähnlichkeit über LanceDB ANN (Kosinus-Distanz)
- **BM25 Volltextsuche** — exakte Schlüsselwortübereinstimmung über LanceDB FTS-Index
- **Hybride Fusion** — Vektorscore als Basis, BM25-Treffer erhalten gewichteten Boost (kein Standard-RRF — optimiert für reale Abrufqualität)
- **Konfigurierbare Gewichte** — `vectorWeight`, `bm25Weight`, `minScore`

### Cross-Encoder Reranking

- Eingebaute Adapter für **Jina**, **SiliconFlow**, **Voyage AI** und **Pinecone**
- Kompatibel mit jedem Jina-kompatiblen Endpunkt (z.B. Hugging Face TEI, DashScope)
- Hybrid-Scoring: 60% Cross-Encoder + 40% ursprünglicher fusionierter Score
- Graceful Degradation: Rückfall auf Kosinus-Ähnlichkeit bei API-Ausfall

### Mehrstufige Scoring-Pipeline

| Stufe | Effekt |
| --- | --- |
| **Hybride Fusion** | Kombiniert semantische und exakte Suche |
| **Cross-Encoder Rerank** | Fördert semantisch präzise Treffer |
| **Lifecycle-Zerfall-Boost** | Weibull-Aktualität + Zugriffshäufigkeit + Wichtigkeit × Konfidenz |
| **Längennormalisierung** | Verhindert, dass lange Einträge dominieren (Anker: 500 Zeichen) |
| **Harter Mindestscore** | Entfernt irrelevante Ergebnisse (Standard: 0.35) |
| **MMR-Diversität** | Kosinus-Ähnlichkeit > 0.85 → herabgestuft |

### Intelligente Gedächtnisextraktion (v1.1.0)

- **LLM-gestützte 6-Kategorien-Extraktion**: Profil, Präferenzen, Entitäten, Ereignisse, Fälle, Muster
- **L0/L1/L2 Schichtspeicherung**: L0 (Einzeiler-Index) → L1 (strukturierte Zusammenfassung) → L2 (vollständige Erzählung)
- **Zweistufige Deduplizierung**: Vektor-Ähnlichkeits-Vorfilter (≥0.7) → LLM semantische Entscheidung (CREATE/MERGE/SKIP)
- **Kategoriebasierte Zusammenführung**: `profile` wird immer zusammengeführt, `events`/`cases` sind nur anfügbar

### Gedächtnis-Lebenszyklusverwaltung (v1.1.0)

- **Weibull-Zerfallsmotor**: Gesamtscore = Aktualität + Häufigkeit + intrinsischer Wert
- **Dreistufige Beförderung**: `Peripheral ↔ Working ↔ Core` mit konfigurierbaren Schwellenwerten
- **Zugriffsverstärkung**: Häufig abgerufene Erinnerungen zerfallen langsamer (Spaced-Repetition-Stil)
- **Wichtigkeitsmodulierte Halbwertszeit**: Wichtige Erinnerungen zerfallen langsamer

### Multi-Scope-Isolation

- Eingebaute Scopes: `global`, `agent:<id>`, `custom:<name>`, `project:<id>`, `user:<id>`
- Zugriffskontrolle auf Agentenebene über `scopes.agentAccess`
- Standard: Jeder Agent greift auf `global` + seinen eigenen `agent:<id>`-Scope zu

### Auto-Capture und Auto-Recall

- **Auto-Capture** (`agent_end`): Extrahiert Präferenzen/Fakten/Entscheidungen/Entitäten aus Gesprächen, dedupliziert, speichert bis zu 3 pro Runde
- **Auto-Recall** (`before_agent_start`): Injiziert `<relevant-memories>`-Kontext (bis zu 3 Einträge)

### Rauschfilterung und adaptive Suche

- Filtert minderwertige Inhalte: Agent-Ablehnungen, Meta-Fragen, Begrüßungen
- Überspringt Suche bei: Begrüßungen, Slash-Befehlen, einfachen Bestätigungen, Emoji
- Erzwingt Suche bei Gedächtnis-Schlüsselwörtern („erinnere dich", „vorher", „letztes Mal")
- CJK-bewusste Schwellenwerte (Chinesisch: 6 Zeichen vs Englisch: 15 Zeichen)

---

<details>
<summary><strong>Vergleich mit dem eingebauten <code>memory-lancedb</code> (zum Aufklappen klicken)</strong></summary>

| Funktion | Eingebautes `memory-lancedb` | **memory-lancedb-pro** |
| --- | :---: | :---: |
| Vektorsuche | Ja | Ja |
| BM25 Volltextsuche | - | Ja |
| Hybride Fusion (Vektor + BM25) | - | Ja |
| Cross-Encoder Rerank (Multi-Anbieter) | - | Ja |
| Aktualitäts-Boost und Zeitzerfall | - | Ja |
| Längennormalisierung | - | Ja |
| MMR-Diversität | - | Ja |
| Multi-Scope-Isolation | - | Ja |
| Rauschfilterung | - | Ja |
| Adaptive Suche | - | Ja |
| Verwaltungs-CLI | - | Ja |
| Sitzungsgedächtnis | - | Ja |
| Aufgabenbezogene Embeddings | - | Ja |
| **LLM Intelligente Extraktion (6 Kategorien)** | - | Ja (v1.1.0) |
| **Weibull-Zerfall + Stufenbeförderung** | - | Ja (v1.1.0) |
| Beliebiges OpenAI-kompatibles Embedding | Eingeschränkt | Ja |

</details>

---

## Konfiguration

<details>
<summary><strong>Vollständiges Konfigurationsbeispiel</strong></summary>

```json
{
  "embedding": {
    "apiKey": "${JINA_API_KEY}",
    "model": "jina-embeddings-v5-text-small",
    "baseURL": "https://api.jina.ai/v1",
    "dimensions": 1024,
    "taskQuery": "retrieval.query",
    "taskPassage": "retrieval.passage",
    "normalized": true
  },
  "dbPath": "~/.openclaw/memory/lancedb-pro",
  "autoCapture": true,
  "autoRecall": true,
  "retrieval": {
    "mode": "hybrid",
    "vectorWeight": 0.7,
    "bm25Weight": 0.3,
    "minScore": 0.3,
    "rerank": "cross-encoder",
    "rerankApiKey": "${JINA_API_KEY}",
    "rerankModel": "jina-reranker-v3",
    "rerankEndpoint": "https://api.jina.ai/v1/rerank",
    "rerankProvider": "jina",
    "candidatePoolSize": 20,
    "recencyHalfLifeDays": 14,
    "recencyWeight": 0.1,
    "filterNoise": true,
    "lengthNormAnchor": 500,
    "hardMinScore": 0.35,
    "timeDecayHalfLifeDays": 60,
    "reinforcementFactor": 0.5,
    "maxHalfLifeMultiplier": 3
  },
  "enableManagementTools": false,
  "scopes": {
    "default": "global",
    "definitions": {
      "global": { "description": "Shared knowledge" },
      "agent:discord-bot": { "description": "Discord bot private" }
    },
    "agentAccess": {
      "discord-bot": ["global", "agent:discord-bot"]
    }
  },
  "sessionMemory": {
    "enabled": false,
    "messageCount": 15
  },
  "smartExtraction": true,
  "llm": {
    "apiKey": "${OPENAI_API_KEY}",
    "model": "gpt-4o-mini",
    "baseURL": "https://api.openai.com/v1"
  },
  "extractMinMessages": 2,
  "extractMaxChars": 8000
}
```

</details>

<details>
<summary><strong>Embedding-Anbieter</strong></summary>

Funktioniert mit **jeder OpenAI-kompatiblen Embedding-API**:

| Anbieter | Modell | Basis-URL | Dimensionen |
| --- | --- | --- | --- |
| **Jina** (empfohlen) | `jina-embeddings-v5-text-small` | `https://api.jina.ai/v1` | 1024 |
| **OpenAI** | `text-embedding-3-small` | `https://api.openai.com/v1` | 1536 |
| **Voyage** | `voyage-4-lite` / `voyage-4` | `https://api.voyageai.com/v1` | 1024 / 1024 |
| **Google Gemini** | `gemini-embedding-001` | `https://generativelanguage.googleapis.com/v1beta/openai/` | 3072 |
| **Ollama** (lokal) | `nomic-embed-text` | `http://localhost:11434/v1` | anbieterspezifisch |

</details>

<details>
<summary><strong>Rerank-Anbieter</strong></summary>

Cross-Encoder Reranking unterstützt mehrere Anbieter über `rerankProvider`:

| Anbieter | `rerankProvider` | Beispielmodell |
| --- | --- | --- |
| **Jina** (Standard) | `jina` | `jina-reranker-v3` |
| **SiliconFlow** (kostenlose Stufe verfügbar) | `siliconflow` | `BAAI/bge-reranker-v2-m3` |
| **Voyage AI** | `voyage` | `rerank-2.5` |
| **Pinecone** | `pinecone` | `bge-reranker-v2-m3` |

Jeder Jina-kompatible Rerank-Endpunkt funktioniert ebenfalls — setzen Sie `rerankProvider: "jina"` und verweisen Sie `rerankEndpoint` auf Ihren Dienst (z.B. Hugging Face TEI, DashScope `qwen3-rerank`).

</details>

<details>
<summary><strong>Intelligente Extraktion (LLM) — v1.1.0</strong></summary>

Wenn `smartExtraction` aktiviert ist (Standard: `true`), verwendet das Plugin ein LLM, um Erinnerungen intelligent zu extrahieren und zu klassifizieren, anstatt regex-basierte Auslöser zu verwenden.

| Feld | Typ | Standard | Beschreibung |
|-------|------|---------|-------------|
| `smartExtraction` | boolean | `true` | LLM-gestützte 6-Kategorien-Extraktion aktivieren/deaktivieren |
| `llm.auth` | string | `api-key` | `api-key` verwendet `llm.apiKey` / `embedding.apiKey`; `oauth` verwendet standardmäßig eine plugin-spezifische OAuth-Token-Datei |
| `llm.apiKey` | string | *(Rückfall auf `embedding.apiKey`)* | API-Schlüssel für den LLM-Anbieter |
| `llm.model` | string | `openai/gpt-oss-120b` | LLM-Modellname |
| `llm.baseURL` | string | *(Rückfall auf `embedding.baseURL`)* | LLM-API-Endpunkt |
| `llm.oauthProvider` | string | `openai-codex` | OAuth-Anbieter-ID bei `llm.auth` = `oauth` |
| `llm.oauthPath` | string | `~/.openclaw/.memory-lancedb-pro/oauth.json` | OAuth-Token-Datei bei `llm.auth` = `oauth` |
| `llm.timeoutMs` | number | `30000` | LLM-Anfrage-Timeout in Millisekunden |
| `extractMinMessages` | number | `2` | Mindestanzahl an Nachrichten bevor Extraktion ausgelöst wird |
| `extractMaxChars` | number | `8000` | Maximale Zeichenanzahl, die an das LLM gesendet wird |


OAuth `llm`-Konfiguration (vorhandenen Codex / ChatGPT Login-Cache für LLM-Aufrufe verwenden):
```json
{
  "llm": {
    "auth": "oauth",
    "oauthProvider": "openai-codex",
    "model": "gpt-5.4",
    "oauthPath": "${HOME}/.openclaw/.memory-lancedb-pro/oauth.json",
    "timeoutMs": 30000
  }
}
```

Hinweise zu `llm.auth: "oauth"`:

- `llm.oauthProvider` ist derzeit `openai-codex`.
- OAuth-Tokens werden standardmäßig unter `~/.openclaw/.memory-lancedb-pro/oauth.json` gespeichert.
- Sie können `llm.oauthPath` setzen, wenn Sie die Datei an einem anderen Ort speichern möchten.
- `auth login` erstellt eine Sicherung der vorherigen api-key `llm`-Konfiguration neben der OAuth-Datei, und `auth logout` stellt diese Sicherung bei Verfügbarkeit wieder her.
- Der Wechsel von `api-key` zu `oauth` überträgt `llm.baseURL` nicht automatisch. Setzen Sie es im OAuth-Modus nur manuell, wenn Sie absichtlich ein benutzerdefiniertes ChatGPT/Codex-kompatibles Backend verwenden möchten.

</details>

<details>
<summary><strong>Lebenszyklus-Konfiguration (Zerfall + Stufen)</strong></summary>

| Feld | Standard | Beschreibung |
|-------|---------|-------------|
| `decay.recencyHalfLifeDays` | `30` | Basis-Halbwertszeit für Weibull-Aktualitätszerfall |
| `decay.frequencyWeight` | `0.3` | Gewichtung der Zugriffshäufigkeit im Gesamtscore |
| `decay.intrinsicWeight` | `0.3` | Gewichtung von `Wichtigkeit × Konfidenz` |
| `decay.betaCore` | `0.8` | Weibull-Beta für `core`-Erinnerungen |
| `decay.betaWorking` | `1.0` | Weibull-Beta für `working`-Erinnerungen |
| `decay.betaPeripheral` | `1.3` | Weibull-Beta für `peripheral`-Erinnerungen |
| `tier.coreAccessThreshold` | `10` | Mindestanzahl Abrufe vor Beförderung zu `core` |
| `tier.peripheralAgeDays` | `60` | Altersschwelle für die Herabstufung veralteter Erinnerungen |

</details>

<details>
<summary><strong>Zugriffsverstärkung</strong></summary>

Häufig abgerufene Erinnerungen zerfallen langsamer (Spaced-Repetition-Stil).

Konfigurationsschlüssel (unter `retrieval`):
- `reinforcementFactor` (0-2, Standard: `0.5`) — auf `0` setzen zum Deaktivieren
- `maxHalfLifeMultiplier` (1-10, Standard: `3`) — harte Obergrenze für die effektive Halbwertszeit

</details>

---

## CLI-Befehle

```bash
openclaw memory-pro list [--scope global] [--category fact] [--limit 20] [--json]
openclaw memory-pro search "query" [--scope global] [--limit 10] [--json]
openclaw memory-pro stats [--scope global] [--json]
openclaw memory-pro auth login [--provider openai-codex] [--model gpt-5.4] [--oauth-path /abs/path/oauth.json]
openclaw memory-pro auth status
openclaw memory-pro auth logout
openclaw memory-pro delete <id>
openclaw memory-pro delete-bulk --scope global [--before 2025-01-01] [--dry-run]
openclaw memory-pro export [--scope global] [--output memories.json]
openclaw memory-pro import memories.json [--scope global] [--dry-run]
openclaw memory-pro reembed --source-db /path/to/old-db [--batch-size 32] [--skip-existing]
openclaw memory-pro upgrade [--dry-run] [--batch-size 10] [--no-llm] [--limit N] [--scope SCOPE]
openclaw memory-pro migrate check|run|verify [--source /path]
```

OAuth-Login-Ablauf:

1. Führen Sie `openclaw memory-pro auth login` aus
2. Wenn `--provider` in einem interaktiven Terminal weggelassen wird, zeigt die CLI eine OAuth-Anbieterauswahl an, bevor der Browser geöffnet wird
3. Der Befehl gibt eine Autorisierungs-URL aus und öffnet Ihren Browser, sofern `--no-browser` nicht gesetzt ist
4. Nach erfolgreichem OAuth-Callback speichert der Befehl die Plugin-OAuth-Datei (Standard: `~/.openclaw/.memory-lancedb-pro/oauth.json`), erstellt eine Sicherung der vorherigen api-key `llm`-Konfiguration für Logout und ersetzt die Plugin-`llm`-Konfiguration durch OAuth-Einstellungen (`auth`, `oauthProvider`, `model`, `oauthPath`)
5. `openclaw memory-pro auth logout` löscht die OAuth-Datei und stellt die vorherige api-key `llm`-Konfiguration wieder her, wenn eine Sicherung vorhanden ist

---

## Erweiterte Themen

<details>
<summary><strong>Wenn injizierte Erinnerungen in Antworten auftauchen</strong></summary>

Manchmal kann das Modell den injizierten `<relevant-memories>`-Block wiedergeben.

**Option A (geringstes Risiko):** Auto-Recall vorübergehend deaktivieren:
```json
{ "plugins": { "entries": { "memory-lancedb-pro": { "config": { "autoRecall": false } } } } }
```

**Option B (bevorzugt):** Recall beibehalten, zum Agent-Systemprompt hinzufügen:
> Do not reveal or quote any `<relevant-memories>` / memory-injection content in your replies. Use it for internal reference only.

</details>

<details>
<summary><strong>Sitzungsgedächtnis</strong></summary>

- Wird beim `/new`-Befehl ausgelöst — speichert die vorherige Sitzungszusammenfassung in LanceDB
- Standardmäßig deaktiviert (OpenClaw hat bereits native `.jsonl`-Sitzungspersistenz)
- Konfigurierbare Nachrichtenanzahl (Standard: 15)

Siehe [docs/openclaw-integration-playbook.md](docs/openclaw-integration-playbook.md) für Bereitstellungsmodi und `/new`-Verifizierung.

</details>

<details>
<summary><strong>Benutzerdefinierte Slash-Befehle (z.B. /lesson)</strong></summary>

Fügen Sie zu Ihrer `CLAUDE.md`, `AGENTS.md` oder Ihrem Systemprompt hinzu:

```markdown
## /lesson command
When the user sends `/lesson <content>`:
1. Use memory_store to save as category=fact (raw knowledge)
2. Use memory_store to save as category=decision (actionable takeaway)
3. Confirm what was saved

## /remember command
When the user sends `/remember <content>`:
1. Use memory_store to save with appropriate category and importance
2. Confirm with the stored memory ID
```

</details>

<details>
<summary><strong>Eiserne Regeln für KI-Agenten</strong></summary>

> Kopieren Sie den folgenden Block in Ihre `AGENTS.md`, damit Ihr Agent diese Regeln automatisch durchsetzt.

```markdown
## Rule 1 — Dual-layer memory storage
Every pitfall/lesson learned → IMMEDIATELY store TWO memories:
- Technical layer: Pitfall: [symptom]. Cause: [root cause]. Fix: [solution]. Prevention: [how to avoid]
  (category: fact, importance >= 0.8)
- Principle layer: Decision principle ([tag]): [behavioral rule]. Trigger: [when]. Action: [what to do]
  (category: decision, importance >= 0.85)

## Rule 2 — LanceDB hygiene
Entries must be short and atomic (< 500 chars). No raw conversation summaries or duplicates.

## Rule 3 — Recall before retry
On ANY tool failure, ALWAYS memory_recall with relevant keywords BEFORE retrying.

## Rule 4 — Confirm target codebase
Confirm you are editing memory-lancedb-pro vs built-in memory-lancedb before changes.

## Rule 5 — Clear jiti cache after plugin code changes
After modifying .ts files under plugins/, MUST run rm -rf /tmp/jiti/ BEFORE openclaw gateway restart.
```

</details>

<details>
<summary><strong>Datenbankschema</strong></summary>

LanceDB-Tabelle `memories`:

| Feld | Typ | Beschreibung |
| --- | --- | --- |
| `id` | string (UUID) | Primärschlüssel |
| `text` | string | Gedächtnistext (FTS-indiziert) |
| `vector` | float[] | Embedding-Vektor |
| `category` | string | Speicherkategorie: `preference` / `fact` / `decision` / `entity` / `reflection` / `other` |
| `scope` | string | Scope-Bezeichner (z.B. `global`, `agent:main`) |
| `importance` | float | Wichtigkeitsscore 0-1 |
| `timestamp` | int64 | Erstellungszeitstempel (ms) |
| `metadata` | string (JSON) | Erweiterte Metadaten |

Häufige `metadata`-Schlüssel in v1.1.0: `l0_abstract`, `l1_overview`, `l2_content`, `memory_category`, `tier`, `access_count`, `confidence`, `last_accessed_at`

> **Hinweis zu Kategorien:** Das Top-Level-Feld `category` verwendet 6 Speicherkategorien. Die 6-Kategorien-semantischen Labels der intelligenten Extraktion (`profile` / `preferences` / `entities` / `events` / `cases` / `patterns`) werden in `metadata.memory_category` gespeichert.

</details>

<details>
<summary><strong>Fehlerbehebung</strong></summary>

### "Cannot mix BigInt and other types" (LanceDB / Apache Arrow)

Bei LanceDB 0.26+ können einige numerische Spalten als `BigInt` zurückgegeben werden. Aktualisieren Sie auf **memory-lancedb-pro >= 1.0.14** — dieses Plugin konvertiert Werte nun mit `Number(...)` vor arithmetischen Operationen.

</details>

---

## Dokumentation

| Dokument | Beschreibung |
| --- | --- |
| [OpenClaw Integrations-Playbook](docs/openclaw-integration-playbook.md) | Bereitstellungsmodi, Verifizierung, Regressionsmatrix |
| [Gedächtnisarchitektur-Analyse](docs/memory_architecture_analysis.md) | Vollständige Architektur-Tiefenanalyse |
| [CHANGELOG v1.1.0](docs/CHANGELOG-v1.1.0.md) | Verhaltensänderungen v1.1.0 und Upgrade-Begründung |
| [Langkontext-Chunking](docs/long-context-chunking.md) | Chunking-Strategie für lange Dokumente |

---

## Beta: Smart Memory v1.1.0

> Status: Beta — verfügbar über `npm i memory-lancedb-pro@beta`. Stabile Benutzer auf `latest` sind nicht betroffen.

| Funktion | Beschreibung |
|---------|-------------|
| **Intelligente Extraktion** | LLM-gestützte 6-Kategorien-Extraktion mit L0/L1/L2 Metadaten. Rückfall auf Regex wenn deaktiviert. |
| **Lebenszyklus-Scoring** | Weibull-Zerfall in die Suche integriert — häufige und wichtige Erinnerungen ranken höher. |
| **Stufenverwaltung** | Dreistufiges System (Core → Working → Peripheral) mit automatischer Beförderung/Herabstufung. |

Feedback: [GitHub Issues](https://github.com/CortexReach/memory-lancedb-pro/issues) · Zurücksetzen: `npm i memory-lancedb-pro@latest`

---

## Abhängigkeiten

| Paket | Zweck |
| --- | --- |
| `@lancedb/lancedb` ≥0.26.2 | Vektordatenbank (ANN + FTS) |
| `openai` ≥6.21.0 | OpenAI-kompatibler Embedding-API-Client |
| `@sinclair/typebox` 0.34.48 | JSON-Schema-Typdefinitionen |

---

## Contributors

<p>
<a href="https://github.com/win4r"><img src="https://avatars.githubusercontent.com/u/42172631?v=4" width="48" height="48" alt="@win4r" /></a>
<a href="https://github.com/kctony"><img src="https://avatars.githubusercontent.com/u/1731141?v=4" width="48" height="48" alt="@kctony" /></a>
<a href="https://github.com/Akatsuki-Ryu"><img src="https://avatars.githubusercontent.com/u/8062209?v=4" width="48" height="48" alt="@Akatsuki-Ryu" /></a>
<a href="https://github.com/JasonSuz"><img src="https://avatars.githubusercontent.com/u/612256?v=4" width="48" height="48" alt="@JasonSuz" /></a>
<a href="https://github.com/Minidoracat"><img src="https://avatars.githubusercontent.com/u/11269639?v=4" width="48" height="48" alt="@Minidoracat" /></a>
<a href="https://github.com/furedericca-lab"><img src="https://avatars.githubusercontent.com/u/263020793?v=4" width="48" height="48" alt="@furedericca-lab" /></a>
<a href="https://github.com/joe2643"><img src="https://avatars.githubusercontent.com/u/19421931?v=4" width="48" height="48" alt="@joe2643" /></a>
<a href="https://github.com/AliceLJY"><img src="https://avatars.githubusercontent.com/u/136287420?v=4" width="48" height="48" alt="@AliceLJY" /></a>
<a href="https://github.com/chenjiyong"><img src="https://avatars.githubusercontent.com/u/8199522?v=4" width="48" height="48" alt="@chenjiyong" /></a>
</p>

Full list: [Contributors](https://github.com/CortexReach/memory-lancedb-pro/graphs/contributors)

## Star History

<a href="https://star-history.com/#CortexReach/memory-lancedb-pro&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=CortexReach/memory-lancedb-pro&type=Date&theme=dark&transparent=true" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=CortexReach/memory-lancedb-pro&type=Date&transparent=true" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=CortexReach/memory-lancedb-pro&type=Date&transparent=true" />
  </picture>
</a>

## Lizenz

MIT

---

## Mein WeChat QR-Code

<img src="https://github.com/win4r/AISuperDomain/assets/42172631/7568cf78-c8ba-4182-aa96-d524d903f2bc" width="214.8" height="291">
