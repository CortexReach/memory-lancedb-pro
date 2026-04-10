<div align="center">

# 🧠 memory-lancedb-pro · 🦞OpenClaw Plugin

**Assistente Memoria IA per Agenti [OpenClaw](https://github.com/openclaw/openclaw)**

*Dai al tuo agente IA un cervello che ricorda davvero — tra sessioni, tra agenti, nel tempo.*

Un plugin di memoria a lungo termine per OpenClaw basato su LanceDB che memorizza preferenze, decisioni e contesto di progetto, e li richiama automaticamente nelle sessioni future.

[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-blue)](https://github.com/openclaw/openclaw)
[![npm version](https://img.shields.io/npm/v/memory-lancedb-pro)](https://www.npmjs.com/package/memory-lancedb-pro)
[![LanceDB](https://img.shields.io/badge/LanceDB-Vectorstore-orange)](https://lancedb.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

[English](README.md) | [简体中文](README_CN.md) | [繁體中文](README_TW.md) | [日本語](README_JA.md) | [한국어](README_KO.md) | [Français](README_FR.md) | [Español](README_ES.md) | [Deutsch](README_DE.md) | [Italiano](README_IT.md) | [Русский](README_RU.md) | [Português (Brasil)](README_PT-BR.md)

</div>

---

## Perché memory-lancedb-pro?

La maggior parte degli agenti IA soffre di amnesia. Dimenticano tutto nel momento in cui si avvia una nuova chat.

**memory-lancedb-pro** è un plugin di memoria a lungo termine di livello produttivo per OpenClaw che trasforma il tuo agente in un vero **Assistente Memoria IA** — cattura automaticamente ciò che conta, lascia il rumore dissolversi naturalmente e recupera il ricordo giusto al momento giusto. Nessun tag manuale, nessuna configurazione complicata.

### Il tuo Assistente Memoria IA in azione

**Senza memoria — ogni sessione parte da zero:**

> **Tu:** "Usa i tab per l'indentazione, aggiungi sempre la gestione degli errori."
> *(sessione successiva)*
> **Tu:** "Te l'ho già detto — tab, non spazi!" 😤
> *(sessione successiva)*
> **Tu:** "…sul serio, tab. E gestione degli errori. Di nuovo."

**Con memory-lancedb-pro — il tuo agente impara e ricorda:**

> **Tu:** "Usa i tab per l'indentazione, aggiungi sempre la gestione degli errori."
> *(sessione successiva — l'agente richiama automaticamente le tue preferenze)*
> **Agente:** *(applica silenziosamente tab + gestione errori)* ✅
> **Tu:** "Perché il mese scorso abbiamo scelto PostgreSQL invece di MongoDB?"
> **Agente:** "In base alla nostra discussione del 12 febbraio, i motivi principali erano…" ✅

Questa è la differenza che fa un **Assistente Memoria IA** — impara il tuo stile, ricorda le decisioni passate e fornisce risposte personalizzate senza che tu debba ripeterti.

### Cos'altro può fare?

| | Cosa ottieni |
|---|---|
| **Auto-Capture** | Il tuo agente impara da ogni conversazione — nessun `memory_store` manuale necessario |
| **Estrazione intelligente** | Classificazione LLM in 6 categorie: profili, preferenze, entità, eventi, casi, pattern |
| **Oblio intelligente** | Modello di decadimento Weibull — i ricordi importanti restano, il rumore svanisce |
| **Ricerca ibrida** | Ricerca vettoriale + BM25 full-text, fusa con reranking cross-encoder |
| **Iniezione di contesto** | I ricordi rilevanti emergono automaticamente prima di ogni risposta |
| **Isolamento multi-scope** | Confini di memoria per agente, per utente, per progetto |
| **Qualsiasi provider** | OpenAI, Jina, Gemini, Ollama o qualsiasi API compatibile OpenAI |
| **Toolkit completo** | CLI, backup, migrazione, upgrade, esportazione/importazione — pronto per la produzione |

---

## Avvio rapido

> **Requisito CPU:** La tua CPU deve supportare le istruzioni **AVX/AVX2** (Intel Sandy Bridge 2011+ / AMD Bulldozer 2011+). Il motore vettoriale nativo di LanceDB le richiede — su CPU non supportate il plugin andrà in crash con `SIGILL` (Istruzione illegale). Verifica con: `grep -o 'avx[^ ]*' /proc/cpuinfo | head -1` (nessun output = non supportato). Vedi [#419](https://github.com/CortexReach/memory-lancedb-pro/issues/419).

### Opzione A: Script di installazione con un clic (consigliato)

Lo **[script di installazione](https://github.com/CortexReach/toolbox/tree/main/memory-lancedb-pro-setup)** mantenuto dalla community gestisce installazione, aggiornamento e riparazione in un solo comando:

```bash
curl -fsSL https://raw.githubusercontent.com/CortexReach/toolbox/main/memory-lancedb-pro-setup/setup-memory.sh -o setup-memory.sh
bash setup-memory.sh
```

> Vedi [Ecosistema](#ecosistema) qui sotto per l'elenco completo degli scenari coperti e altri strumenti della community.

### Opzione B: Installazione manuale

**Tramite OpenClaw CLI (consigliato):**
```bash
openclaw plugins install memory-lancedb-pro@beta
```

**Oppure tramite npm:**
```bash
npm i memory-lancedb-pro@beta
```
> Se usi npm, dovrai anche aggiungere la directory di installazione del plugin come percorso **assoluto** in `plugins.load.paths` nel tuo `openclaw.json`. Questo è il problema di configurazione più comune.

Aggiungi al tuo `openclaw.json`:

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

**Perché questi valori predefiniti?**
- `autoCapture` + `smartExtraction` → il tuo agente impara automaticamente da ogni conversazione
- `autoRecall` → i ricordi rilevanti vengono iniettati prima di ogni risposta
- `extractMinMessages: 2` → l'estrazione si attiva nelle normali chat a due turni
- `sessionMemory.enabled: false` → evita di inquinare la ricerca con riassunti di sessione all'inizio

Valida e riavvia:

```bash
openclaw config validate
openclaw gateway restart
openclaw logs --follow --plain | grep "memory-lancedb-pro"
```

Dovresti vedere:
- `memory-lancedb-pro: smart extraction enabled`
- `memory-lancedb-pro@...: plugin registered`

Fatto! Il tuo agente ora ha una memoria a lungo termine.

<details>
<summary><strong>Ulteriori percorsi di installazione (utenti esistenti, aggiornamenti)</strong></summary>

**Usi già OpenClaw?**

1. Aggiungi il plugin con un percorso **assoluto** in `plugins.load.paths`
2. Associa lo slot di memoria: `plugins.slots.memory = "memory-lancedb-pro"`
3. Verifica: `openclaw plugins info memory-lancedb-pro && openclaw memory-pro stats`

**Aggiornamento da versioni precedenti alla v1.1.0?**

```bash
# 1) Backup
openclaw memory-pro export --scope global --output memories-backup.json
# 2) Dry run
openclaw memory-pro upgrade --dry-run
# 3) Run upgrade
openclaw memory-pro upgrade
# 4) Verify
openclaw memory-pro stats
```

Vedi `CHANGELOG-v1.1.0.md` per le modifiche comportamentali e le motivazioni dell'aggiornamento.

</details>

<details>
<summary><strong>Importazione rapida Telegram Bot (clicca per espandere)</strong></summary>

Se stai usando l'integrazione Telegram di OpenClaw, il modo più semplice è inviare un comando di importazione direttamente al Bot principale invece di modificare manualmente la configurazione.

Invia questo messaggio:

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

## Ecosistema

memory-lancedb-pro è il plugin principale. La community ha costruito strumenti per rendere l'installazione e l'uso quotidiano ancora più fluidi:

### Script di installazione — Installazione, aggiornamento e riparazione con un clic

> **[CortexReach/toolbox/memory-lancedb-pro-setup](https://github.com/CortexReach/toolbox/tree/main/memory-lancedb-pro-setup)**

Non è un semplice installer — lo script gestisce in modo intelligente numerosi scenari reali:

| La tua situazione | Cosa fa lo script |
|---|---|
| Mai installato | Download → installazione dipendenze → scelta configurazione → scrittura in openclaw.json → riavvio |
| Installato tramite `git clone`, bloccato su un vecchio commit | `git fetch` + `checkout` automatico all'ultima versione → reinstallazione dipendenze → verifica |
| La configurazione ha campi non validi | Rilevamento automatico tramite filtro schema, rimozione campi non supportati |
| Installato tramite `npm` | Salta l'aggiornamento git, ricorda di eseguire `npm update` autonomamente |
| CLI `openclaw` non funzionante per configurazione non valida | Fallback: lettura diretta del percorso workspace dal file `openclaw.json` |
| `extensions/` invece di `plugins/` | Rilevamento automatico della posizione del plugin da configurazione o filesystem |
| Già aggiornato | Solo controlli di integrità, nessuna modifica |

```bash
bash setup-memory.sh                    # Installa o aggiorna
bash setup-memory.sh --dry-run          # Solo anteprima
bash setup-memory.sh --beta             # Includi versioni pre-release
bash setup-memory.sh --uninstall        # Ripristina configurazione e rimuovi plugin
```

Preset di provider integrati: **Jina / DashScope / SiliconFlow / OpenAI / Ollama**, oppure usa la tua API compatibile OpenAI. Per l'utilizzo completo (inclusi `--ref`, `--selfcheck-only` e altro), consulta il [README dello script di installazione](https://github.com/CortexReach/toolbox/tree/main/memory-lancedb-pro-setup).

### Claude Code / OpenClaw Skill — Configurazione guidata dall'IA

> **[CortexReach/memory-lancedb-pro-skill](https://github.com/CortexReach/memory-lancedb-pro-skill)**

Installa questa Skill e il tuo agente IA (Claude Code o OpenClaw) acquisisce una conoscenza approfondita di tutte le funzionalità di memory-lancedb-pro. Basta dire **"aiutami ad attivare la configurazione migliore"** per ottenere:

- **Workflow di configurazione guidato in 7 passaggi** con 4 piani di distribuzione:
  - Full Power (Jina + OpenAI) / Budget (reranker SiliconFlow gratuito) / Simple (solo OpenAI) / Completamente locale (Ollama, zero costi API)
- **Tutti i 9 strumenti MCP** usati correttamente: `memory_recall`, `memory_store`, `memory_forget`, `memory_update`, `memory_stats`, `memory_list`, `self_improvement_log`, `self_improvement_extract_skill`, `self_improvement_review` *(il set completo richiede `enableManagementTools: true` — la configurazione Quick Start predefinita espone i 4 strumenti principali)*
- **Prevenzione delle insidie comuni**: attivazione plugin workspace, `autoRecall` predefinito a false, cache jiti, variabili d'ambiente, isolamento scope, ecc.

**Installazione per Claude Code:**
```bash
git clone https://github.com/CortexReach/memory-lancedb-pro-skill.git ~/.claude/skills/memory-lancedb-pro
```

**Installazione per OpenClaw:**
```bash
git clone https://github.com/CortexReach/memory-lancedb-pro-skill.git ~/.openclaw/workspace/skills/memory-lancedb-pro-skill
```

---

## Tutorial video

> Guida completa: installazione, configurazione e funzionamento interno della ricerca ibrida.

[![YouTube Video](https://img.shields.io/badge/YouTube-Watch%20Now-red?style=for-the-badge&logo=youtube)](https://youtu.be/MtukF1C8epQ)
**https://youtu.be/MtukF1C8epQ**

[![Bilibili Video](https://img.shields.io/badge/Bilibili-Watch%20Now-00A1D6?style=for-the-badge&logo=bilibili&logoColor=white)](https://www.bilibili.com/video/BV1zUf2BGEgn/)
**https://www.bilibili.com/video/BV1zUf2BGEgn/**

---

## Architettura

```
┌─────────────────────────────────────────────────────────┐
│                   index.ts (Entry Point)                │
│  Plugin Registration · Config Parsing · Lifecycle Hooks │
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
    │ (Agent API) │   │ (CLI)    │
    └─────────────┘   └──────────┘
```

> Per un approfondimento sull'architettura completa, consulta [docs/memory_architecture_analysis.md](docs/memory_architecture_analysis.md).

<details>
<summary><strong>Riferimento file (clicca per espandere)</strong></summary>

| File | Scopo |
| --- | --- |
| `index.ts` | Punto di ingresso del plugin. Si registra con l'API Plugin di OpenClaw, analizza la configurazione, monta gli hook del ciclo di vita |
| `openclaw.plugin.json` | Metadati del plugin + dichiarazione completa della configurazione JSON Schema |
| `cli.ts` | Comandi CLI: `memory-pro list/search/stats/delete/delete-bulk/export/import/reembed/upgrade/migrate` |
| `src/store.ts` | Layer di storage LanceDB. Creazione tabelle / indicizzazione FTS / ricerca vettoriale / ricerca BM25 / CRUD |
| `src/embedder.ts` | Astrazione embedding. Compatibile con qualsiasi provider API compatibile OpenAI |
| `src/retriever.ts` | Motore di ricerca ibrido. Vettoriale + BM25 → Fusione ibrida → Rerank → Decadimento ciclo di vita → Filtro |
| `src/scopes.ts` | Controllo accessi multi-scope |
| `src/tools.ts` | Definizioni degli strumenti agente: `memory_recall`, `memory_store`, `memory_forget`, `memory_update` + strumenti di gestione |
| `src/noise-filter.ts` | Filtra rifiuti dell'agente, meta-domande, saluti e contenuti di bassa qualità |
| `src/adaptive-retrieval.ts` | Determina se una query necessita di ricerca nella memoria |
| `src/migrate.ts` | Migrazione dal `memory-lancedb` integrato a Pro |
| `src/smart-extractor.ts` | Estrazione LLM in 6 categorie con archiviazione a strati L0/L1/L2 e deduplicazione in due fasi |
| `src/decay-engine.ts` | Modello di decadimento esponenziale esteso Weibull |
| `src/tier-manager.ts` | Promozione/retrocessione a tre livelli: Peripheral ↔ Working ↔ Core |

</details>

---

## Funzionalità principali

### Ricerca ibrida

```
Query → embedQuery() ─┐
                       ├─→ Hybrid Fusion → Rerank → Lifecycle Decay Boost → Length Norm → Filter
Query → BM25 FTS ─────┘
```

- **Ricerca vettoriale** — similarità semantica tramite LanceDB ANN (distanza del coseno)
- **Ricerca full-text BM25** — corrispondenza esatta delle parole chiave tramite indice FTS di LanceDB
- **Fusione ibrida** — punteggio vettoriale come base, i risultati BM25 ricevono un boost ponderato (non RRF standard — ottimizzato per la qualità di richiamo nel mondo reale)
- **Pesi configurabili** — `vectorWeight`, `bm25Weight`, `minScore`

### Reranking Cross-Encoder

- Adattatori integrati per **Jina**, **SiliconFlow**, **Voyage AI** e **Pinecone**
- Compatibile con qualsiasi endpoint compatibile Jina (ad es. Hugging Face TEI, DashScope)
- Punteggio ibrido: 60% cross-encoder + 40% punteggio fuso originale
- Degradazione elegante: fallback sulla similarità del coseno in caso di errore API

### Pipeline di punteggio multi-fase

| Fase | Effetto |
| --- | --- |
| **Fusione ibrida** | Combina richiamo semantico e corrispondenza esatta |
| **Rerank Cross-Encoder** | Promuove risultati semanticamente precisi |
| **Boost decadimento ciclo di vita** | Freschezza Weibull + frequenza di accesso + importance × confidence |
| **Normalizzazione lunghezza** | Impedisce alle voci lunghe di dominare (ancora: 500 caratteri) |
| **Punteggio minimo rigido** | Rimuove risultati irrilevanti (predefinito: 0.35) |
| **Diversità MMR** | Similarità coseno > 0.85 → retrocesso |

### Estrazione intelligente della memoria (v1.1.0)

- **Estrazione LLM in 6 categorie**: profilo, preferenze, entità, eventi, casi, pattern
- **Archiviazione a strati L0/L1/L2**: L0 (indice in una frase) → L1 (riepilogo strutturato) → L2 (narrazione completa)
- **Deduplicazione in due fasi**: pre-filtro similarità vettoriale (≥0.7) → decisione semantica LLM (CREATE/MERGE/SKIP)
- **Fusione consapevole delle categorie**: `profile` viene sempre fuso, `events`/`cases` solo in aggiunta

### Gestione del ciclo di vita della memoria (v1.1.0)

- **Motore di decadimento Weibull**: punteggio composito = freschezza + frequenza + valore intrinseco
- **Promozione a tre livelli**: `Peripheral ↔ Working ↔ Core` con soglie configurabili
- **Rinforzo per accesso**: i ricordi richiamati frequentemente decadono più lentamente (stile ripetizione spaziata)
- **Emivita modulata dall'importanza**: i ricordi importanti decadono più lentamente

### Isolamento multi-scope

- Scope integrati: `global`, `agent:<id>`, `custom:<name>`, `project:<id>`, `user:<id>`
- Controllo accessi a livello agente tramite `scopes.agentAccess`
- Predefinito: ogni agente accede a `global` + il proprio scope `agent:<id>`

### Auto-Capture e Auto-Recall

- **Auto-Capture** (`agent_end`): estrae preferenze/fatti/decisioni/entità dalle conversazioni, deduplica, memorizza fino a 3 per turno
- **Auto-Recall** (`before_agent_start`): inietta il contesto `<relevant-memories>` (fino a 3 voci)

### Filtraggio del rumore e ricerca adattiva

- Filtra contenuti di bassa qualità: rifiuti dell'agente, meta-domande, saluti
- Salta la ricerca per: saluti, comandi slash, conferme semplici, emoji
- Forza la ricerca per parole chiave della memoria ("ricorda", "precedentemente", "l'ultima volta")
- Soglie CJK (cinese: 6 caratteri vs inglese: 15 caratteri)

---

<details>
<summary><strong>Confronto con <code>memory-lancedb</code> integrato (clicca per espandere)</strong></summary>

| Funzionalità | `memory-lancedb` integrato | **memory-lancedb-pro** |
| --- | :---: | :---: |
| Ricerca vettoriale | Sì | Sì |
| Ricerca full-text BM25 | - | Sì |
| Fusione ibrida (Vettoriale + BM25) | - | Sì |
| Rerank cross-encoder (multi-provider) | - | Sì |
| Boost di freschezza e decadimento temporale | - | Sì |
| Normalizzazione lunghezza | - | Sì |
| Diversità MMR | - | Sì |
| Isolamento multi-scope | - | Sì |
| Filtraggio del rumore | - | Sì |
| Ricerca adattiva | - | Sì |
| CLI di gestione | - | Sì |
| Memoria di sessione | - | Sì |
| Embedding task-aware | - | Sì |
| **Estrazione intelligente LLM (6 categorie)** | - | Sì (v1.1.0) |
| **Decadimento Weibull + promozione livelli** | - | Sì (v1.1.0) |
| Qualsiasi embedding compatibile OpenAI | Limitato | Sì |

</details>

---

## Configurazione

<details>
<summary><strong>Esempio di configurazione completa</strong></summary>

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
<summary><strong>Provider di embedding</strong></summary>

Funziona con **qualsiasi API di embedding compatibile OpenAI**:

| Provider | Modello | Base URL | Dimensioni |
| --- | --- | --- | --- |
| **Jina** (consigliato) | `jina-embeddings-v5-text-small` | `https://api.jina.ai/v1` | 1024 |
| **OpenAI** | `text-embedding-3-small` | `https://api.openai.com/v1` | 1536 |
| **Voyage** | `voyage-4-lite` / `voyage-4` | `https://api.voyageai.com/v1` | 1024 / 1024 |
| **Google Gemini** | `gemini-embedding-001` | `https://generativelanguage.googleapis.com/v1beta/openai/` | 3072 |
| **Ollama** (locale) | `nomic-embed-text` | `http://localhost:11434/v1` | specifico del provider |

</details>

<details>
<summary><strong>Provider di rerank</strong></summary>

Il reranking cross-encoder supporta più provider tramite `rerankProvider`:

| Provider | `rerankProvider` | Modello di esempio |
| --- | --- | --- |
| **Jina** (predefinito) | `jina` | `jina-reranker-v3` |
| **SiliconFlow** (piano gratuito disponibile) | `siliconflow` | `BAAI/bge-reranker-v2-m3` |
| **Voyage AI** | `voyage` | `rerank-2.5` |
| **Pinecone** | `pinecone` | `bge-reranker-v2-m3` |

Funziona anche qualsiasi endpoint di rerank compatibile Jina — imposta `rerankProvider: "jina"` e punta `rerankEndpoint` al tuo servizio (ad es. Hugging Face TEI, DashScope `qwen3-rerank`).

</details>

<details>
<summary><strong>Estrazione intelligente (LLM) — v1.1.0</strong></summary>

Quando `smartExtraction` è abilitato (predefinito: `true`), il plugin utilizza un LLM per estrarre e classificare intelligentemente i ricordi invece di trigger basati su regex.

| Campo | Tipo | Predefinito | Descrizione |
|-------|------|---------|-------------|
| `smartExtraction` | boolean | `true` | Abilita/disabilita l'estrazione LLM in 6 categorie |
| `llm.auth` | string | `api-key` | `api-key` usa `llm.apiKey` / `embedding.apiKey`; `oauth` usa un file token OAuth con scope plugin per impostazione predefinita |
| `llm.apiKey` | string | *(fallback su `embedding.apiKey`)* | Chiave API per il provider LLM |
| `llm.model` | string | `openai/gpt-oss-120b` | Nome del modello LLM |
| `llm.baseURL` | string | *(fallback su `embedding.baseURL`)* | Endpoint API LLM |
| `llm.oauthProvider` | string | `openai-codex` | ID del provider OAuth usato quando `llm.auth` è `oauth` |
| `llm.oauthPath` | string | `~/.openclaw/.memory-lancedb-pro/oauth.json` | File token OAuth usato quando `llm.auth` è `oauth` |
| `llm.timeoutMs` | number | `30000` | Timeout della richiesta LLM in millisecondi |
| `extractMinMessages` | number | `2` | Messaggi minimi prima che l'estrazione si attivi |
| `extractMaxChars` | number | `8000` | Caratteri massimi inviati al LLM |


Configurazione `llm` OAuth (usa la cache di login esistente di Codex / ChatGPT per le chiamate LLM):
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

Note per `llm.auth: "oauth"`:

- `llm.oauthProvider` è attualmente `openai-codex`.
- I token OAuth sono salvati di default in `~/.openclaw/.memory-lancedb-pro/oauth.json`.
- Puoi impostare `llm.oauthPath` se vuoi salvare quel file altrove.
- `auth login` crea uno snapshot della configurazione `llm` precedente con api-key accanto al file OAuth, e `auth logout` ripristina quello snapshot quando disponibile.
- Il passaggio da `api-key` a `oauth` non trasferisce automaticamente `llm.baseURL`. Impostalo manualmente in modalità OAuth solo quando vuoi intenzionalmente un backend personalizzato compatibile ChatGPT/Codex.

</details>

<details>
<summary><strong>Configurazione ciclo di vita (Decadimento + Livelli)</strong></summary>

| Campo | Predefinito | Descrizione |
|-------|---------|-------------|
| `decay.recencyHalfLifeDays` | `30` | Emivita base per il decadimento di freschezza Weibull |
| `decay.frequencyWeight` | `0.3` | Peso della frequenza di accesso nel punteggio composito |
| `decay.intrinsicWeight` | `0.3` | Peso di `importance × confidence` |
| `decay.betaCore` | `0.8` | Beta Weibull per i ricordi `core` |
| `decay.betaWorking` | `1.0` | Beta Weibull per i ricordi `working` |
| `decay.betaPeripheral` | `1.3` | Beta Weibull per i ricordi `peripheral` |
| `tier.coreAccessThreshold` | `10` | Conteggio minimo richiami prima della promozione a `core` |
| `tier.peripheralAgeDays` | `60` | Soglia di età per retrocedere i ricordi inattivi |

</details>

<details>
<summary><strong>Rinforzo per accesso</strong></summary>

I ricordi richiamati frequentemente decadono più lentamente (stile ripetizione spaziata).

Chiavi di configurazione (sotto `retrieval`):
- `reinforcementFactor` (0-2, predefinito: `0.5`) — imposta `0` per disabilitare
- `maxHalfLifeMultiplier` (1-10, predefinito: `3`) — limite massimo sull'emivita effettiva

</details>

---

## Comandi CLI

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

Flusso di login OAuth:

1. Esegui `openclaw memory-pro auth login`
2. Se `--provider` è omesso in un terminale interattivo, la CLI mostra un selettore di provider OAuth prima di aprire il browser
3. Il comando stampa un URL di autorizzazione e apre il browser, a meno che non sia impostato `--no-browser`
4. Dopo il successo del callback, il comando salva il file OAuth del plugin (predefinito: `~/.openclaw/.memory-lancedb-pro/oauth.json`), crea uno snapshot della configurazione `llm` precedente con api-key per il logout, e sostituisce la configurazione `llm` del plugin con le impostazioni OAuth (`auth`, `oauthProvider`, `model`, `oauthPath`)
5. `openclaw memory-pro auth logout` elimina quel file OAuth e ripristina la configurazione `llm` precedente con api-key quando quello snapshot esiste

---

## Argomenti avanzati

<details>
<summary><strong>Se i ricordi iniettati appaiono nelle risposte</strong></summary>

A volte il modello può ripetere il blocco `<relevant-memories>` iniettato.

**Opzione A (rischio minimo):** disabilita temporaneamente l'auto-recall:
```json
{ "plugins": { "entries": { "memory-lancedb-pro": { "config": { "autoRecall": false } } } } }
```

**Opzione B (preferita):** mantieni il recall, aggiungi al prompt di sistema dell'agente:
> Do not reveal or quote any `<relevant-memories>` / memory-injection content in your replies. Use it for internal reference only.

</details>

<details>
<summary><strong>Memoria di sessione</strong></summary>

- Si attiva con il comando `/new` — salva il riepilogo della sessione precedente in LanceDB
- Disabilitata per impostazione predefinita (OpenClaw ha già la persistenza nativa delle sessioni in `.jsonl`)
- Conteggio messaggi configurabile (predefinito: 15)

Vedi [docs/openclaw-integration-playbook.md](docs/openclaw-integration-playbook.md) per le modalità di distribuzione e la verifica di `/new`.

</details>

<details>
<summary><strong>Comandi slash personalizzati (ad es. /lesson)</strong></summary>

Aggiungi al tuo `CLAUDE.md`, `AGENTS.md` o prompt di sistema:

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
<summary><strong>Regole d'oro per agenti IA</strong></summary>

> Copia il blocco seguente nel tuo `AGENTS.md` in modo che il tuo agente applichi queste regole automaticamente.

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
<summary><strong>Schema del database</strong></summary>

Tabella LanceDB `memories`:

| Campo | Tipo | Descrizione |
| --- | --- | --- |
| `id` | string (UUID) | Chiave primaria |
| `text` | string | Testo del ricordo (indicizzato FTS) |
| `vector` | float[] | Vettore di embedding |
| `category` | string | Categoria di archiviazione: `preference` / `fact` / `decision` / `entity` / `reflection` / `other` |
| `scope` | string | Identificatore scope (ad es. `global`, `agent:main`) |
| `importance` | float | Punteggio di importanza 0-1 |
| `timestamp` | int64 | Timestamp di creazione (ms) |
| `metadata` | string (JSON) | Metadati estesi |

Chiavi `metadata` comuni nella v1.1.0: `l0_abstract`, `l1_overview`, `l2_content`, `memory_category`, `tier`, `access_count`, `confidence`, `last_accessed_at`

> **Nota sulle categorie:** Il campo `category` di primo livello usa 6 categorie di archiviazione. Le 6 etichette semantiche dell'Estrazione Intelligente (`profile` / `preferences` / `entities` / `events` / `cases` / `patterns`) sono memorizzate in `metadata.memory_category`.

</details>

<details>
<summary><strong>Risoluzione dei problemi</strong></summary>

### "Cannot mix BigInt and other types" (LanceDB / Apache Arrow)

Con LanceDB 0.26+, alcune colonne numeriche potrebbero essere restituite come `BigInt`. Aggiorna a **memory-lancedb-pro >= 1.0.14** — questo plugin ora converte i valori usando `Number(...)` prima delle operazioni aritmetiche.

</details>

---

## Documentazione

| Documento | Descrizione |
| --- | --- |
| [Playbook di integrazione OpenClaw](docs/openclaw-integration-playbook.md) | Modalità di distribuzione, verifica, matrice di regressione |
| [Analisi dell'architettura della memoria](docs/memory_architecture_analysis.md) | Analisi approfondita dell'architettura completa |
| [CHANGELOG v1.1.0](docs/CHANGELOG-v1.1.0.md) | Modifiche comportamentali v1.1.0 e motivazioni per l'upgrade |
| [Chunking contesto lungo](docs/long-context-chunking.md) | Strategia di chunking per documenti lunghi |

---

## Beta: Smart Memory v1.1.0

> Stato: Beta — disponibile tramite `npm i memory-lancedb-pro@beta`. Gli utenti stabili su `latest` non sono interessati.

| Funzionalità | Descrizione |
|---------|-------------|
| **Estrazione intelligente** | Estrazione LLM in 6 categorie con metadati L0/L1/L2. Fallback su regex se disabilitato. |
| **Punteggio ciclo di vita** | Decadimento Weibull integrato nella ricerca — i ricordi frequenti e importanti si posizionano più in alto. |
| **Gestione livelli** | Sistema a tre livelli (Core → Working → Peripheral) con promozione/retrocessione automatica. |

Feedback: [GitHub Issues](https://github.com/CortexReach/memory-lancedb-pro/issues) · Ripristina: `npm i memory-lancedb-pro@latest`

---

## Dipendenze

| Pacchetto | Scopo |
| --- | --- |
| `@lancedb/lancedb` ≥0.26.2 | Database vettoriale (ANN + FTS) |
| `openai` ≥6.21.0 | Client API Embedding compatibile OpenAI |
| `@sinclair/typebox` 0.34.48 | Definizioni di tipo JSON Schema |

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

## Licenza

MIT

---

## Il mio QR Code WeChat

<img src="https://github.com/win4r/AISuperDomain/assets/42172631/7568cf78-c8ba-4182-aa96-d524d903f2bc" width="214.8" height="291">
