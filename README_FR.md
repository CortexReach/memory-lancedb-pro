<div align="center">

# 🧠 memory-lancedb-pro · 🦞OpenClaw Plugin

**Assistant Mémoire IA pour les Agents [OpenClaw](https://github.com/openclaw/openclaw)**

*Donnez à votre agent IA un cerveau qui se souvient vraiment — entre les sessions, entre les agents, dans le temps.*

Un plugin de mémoire long terme pour OpenClaw basé sur LanceDB qui stocke les préférences, les décisions et le contexte du projet, puis les rappelle automatiquement dans les sessions futures.

[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-blue)](https://github.com/openclaw/openclaw)
[![npm version](https://img.shields.io/npm/v/memory-lancedb-pro)](https://www.npmjs.com/package/memory-lancedb-pro)
[![LanceDB](https://img.shields.io/badge/LanceDB-Vectorstore-orange)](https://lancedb.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

[English](README.md) | [简体中文](README_CN.md) | [繁體中文](README_TW.md) | [日本語](README_JA.md) | [한국어](README_KO.md) | [Français](README_FR.md) | [Español](README_ES.md) | [Deutsch](README_DE.md) | [Italiano](README_IT.md) | [Русский](README_RU.md) | [Português (Brasil)](README_PT-BR.md)

</div>

---

## Pourquoi memory-lancedb-pro ?

La plupart des agents IA souffrent d'amnésie. Ils oublient tout dès que vous démarrez une nouvelle conversation.

**memory-lancedb-pro** est un plugin de mémoire long terme de niveau production pour OpenClaw qui transforme votre agent en un véritable **Assistant Mémoire IA** — il capture automatiquement ce qui compte, laisse le bruit s'estomper naturellement et retrouve le bon souvenir au bon moment. Pas d'étiquetage manuel, pas de configuration compliquée.

### Votre Assistant Mémoire IA en action

**Sans mémoire — chaque session repart de zéro :**

> **Vous :** « Utilise des tabulations pour l'indentation, ajoute toujours la gestion d'erreurs. »
> *(session suivante)*
> **Vous :** « Je t'ai déjà dit — des tabulations, pas des espaces ! » 😤
> *(session suivante)*
> **Vous :** « …sérieusement, des tabulations. Et la gestion d'erreurs. Encore. »

**Avec memory-lancedb-pro — votre agent apprend et se souvient :**

> **Vous :** « Utilise des tabulations pour l'indentation, ajoute toujours la gestion d'erreurs. »
> *(session suivante — l'agent rappelle automatiquement vos préférences)*
> **Agent :** *(applique silencieusement tabulations + gestion d'erreurs)* ✅
> **Vous :** « Pourquoi avons-nous choisi PostgreSQL plutôt que MongoDB le mois dernier ? »
> **Agent :** « Selon notre discussion du 12 février, les raisons principales étaient… » ✅

Voilà la différence que fait un **Assistant Mémoire IA** — il apprend votre style, rappelle les décisions passées et fournit des réponses personnalisées sans que vous ayez à vous répéter.

### Que peut-il faire d'autre ?

| | Ce que vous obtenez |
|---|---|
| **Capture automatique** | Votre agent apprend de chaque conversation — pas besoin de `memory_store` manuel |
| **Extraction intelligente** | Classification LLM en 6 catégories : profils, préférences, entités, événements, cas, patterns |
| **Oubli intelligent** | Modèle de décroissance Weibull — les souvenirs importants restent, le bruit s'estompe |
| **Recherche hybride** | Recherche vectorielle + BM25 plein texte, fusionnée avec un reranking cross-encoder |
| **Injection de contexte** | Les souvenirs pertinents remontent automatiquement avant chaque réponse |
| **Isolation multi-scope** | Limites mémoire par agent, par utilisateur, par projet |
| **Tout fournisseur** | OpenAI, Jina, Gemini, Ollama ou toute API compatible OpenAI |
| **Boîte à outils complète** | CLI, sauvegarde, migration, mise à niveau, export/import — prêt pour la production |

---

## Démarrage rapide

### Option A : Script d'installation en un clic (recommandé)

Le **[script d'installation](https://github.com/CortexReach/toolbox/tree/main/memory-lancedb-pro-setup)** maintenu par la communauté gère l'installation, la mise à niveau et la réparation en une seule commande :

```bash
curl -fsSL https://raw.githubusercontent.com/CortexReach/toolbox/main/memory-lancedb-pro-setup/setup-memory.sh -o setup-memory.sh
bash setup-memory.sh
```

> Consultez [Écosystème](#écosystème) ci-dessous pour la liste complète des scénarios couverts et les autres outils communautaires.

### Option B : Installation manuelle

**Via OpenClaw CLI (recommandé) :**
```bash
openclaw plugins install memory-lancedb-pro@beta
```

**Ou via npm :**
```bash
npm i memory-lancedb-pro@beta
```
> Si vous utilisez npm, vous devrez également ajouter le répertoire d'installation du plugin comme chemin **absolu** dans `plugins.load.paths` de votre `openclaw.json`. C'est le problème de configuration le plus courant.

Ajoutez à votre `openclaw.json` :

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

**Pourquoi ces valeurs par défaut ?**
- `autoCapture` + `smartExtraction` → votre agent apprend automatiquement de chaque conversation
- `autoRecall` → les souvenirs pertinents sont injectés avant chaque réponse
- `extractMinMessages: 2` → l'extraction se déclenche dans les conversations normales à deux tours
- `sessionMemory.enabled: false` → évite de polluer la recherche avec des résumés de session au début

Validez et redémarrez :

```bash
openclaw config validate
openclaw gateway restart
openclaw logs --follow --plain | grep "memory-lancedb-pro"
```

Vous devriez voir :
- `memory-lancedb-pro: smart extraction enabled`
- `memory-lancedb-pro@...: plugin registered`

Terminé ! Votre agent dispose maintenant d'une mémoire long terme.

<details>
<summary><strong>Plus de chemins d'installation (utilisateurs existants, mises à niveau)</strong></summary>

**Déjà utilisateur d'OpenClaw ?**

1. Ajoutez le plugin avec un chemin **absolu** dans `plugins.load.paths`
2. Liez le slot mémoire : `plugins.slots.memory = "memory-lancedb-pro"`
3. Vérifiez : `openclaw plugins info memory-lancedb-pro && openclaw memory-pro stats`

**Mise à niveau depuis une version antérieure à v1.1.0 ?**

```bash
# 1) Sauvegarde
openclaw memory-pro export --scope global --output memories-backup.json
# 2) Simulation
openclaw memory-pro upgrade --dry-run
# 3) Exécution de la mise à niveau
openclaw memory-pro upgrade
# 4) Vérification
openclaw memory-pro stats
```

Consultez `CHANGELOG-v1.1.0.md` pour les changements de comportement et la justification de la mise à niveau.

</details>

<details>
<summary><strong>Import rapide Telegram Bot (cliquez pour développer)</strong></summary>

Si vous utilisez l'intégration Telegram d'OpenClaw, le plus simple est d'envoyer une commande d'import directement au Bot principal au lieu de modifier manuellement la configuration.

Envoyez ce message :

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

## Écosystème

memory-lancedb-pro est le plugin principal. La communauté a construit des outils autour pour faciliter l'installation et l'utilisation quotidienne :

### Script d'installation — Installation, mise à niveau et réparation en un clic

> **[CortexReach/toolbox/memory-lancedb-pro-setup](https://github.com/CortexReach/toolbox/tree/main/memory-lancedb-pro-setup)**

Pas un simple installateur — le script gère intelligemment de nombreux scénarios réels :

| Votre situation | Ce que fait le script |
|---|---|
| Jamais installé | Téléchargement → installation des dépendances → choix de la config → écriture dans openclaw.json → redémarrage |
| Installé via `git clone`, bloqué sur un ancien commit | `git fetch` + `checkout` automatique vers la dernière version → réinstallation des dépendances → vérification |
| La config contient des champs invalides | Détection automatique via filtre de schéma, suppression des champs non supportés |
| Installé via `npm` | Saute la mise à jour git, rappelle d'exécuter `npm update` soi-même |
| CLI `openclaw` cassé à cause d'une config invalide | Solution de repli : lecture directe du chemin workspace depuis le fichier `openclaw.json` |
| `extensions/` au lieu de `plugins/` | Détection automatique de l'emplacement du plugin depuis la config ou le système de fichiers |
| Déjà à jour | Exécution des vérifications de santé uniquement, aucune modification |

```bash
bash setup-memory.sh                    # Installer ou mettre à niveau
bash setup-memory.sh --dry-run          # Aperçu uniquement
bash setup-memory.sh --beta             # Inclure les versions pré-release
bash setup-memory.sh --uninstall        # Restaurer la config et supprimer le plugin
```

Presets de fournisseurs intégrés : **Jina / DashScope / SiliconFlow / OpenAI / Ollama**, ou apportez votre propre API compatible OpenAI. Pour l'utilisation complète (incluant `--ref`, `--selfcheck-only`, etc.), consultez le [README du script d'installation](https://github.com/CortexReach/toolbox/tree/main/memory-lancedb-pro-setup).

### Claude Code / OpenClaw Skill — Configuration guidée par IA

> **[CortexReach/memory-lancedb-pro-skill](https://github.com/CortexReach/memory-lancedb-pro-skill)**

Installez ce Skill et votre agent IA (Claude Code ou OpenClaw) acquiert une connaissance approfondie de toutes les fonctionnalités de memory-lancedb-pro. Dites simplement **« aide-moi à activer la meilleure config »** et obtenez :

- **Workflow de configuration guidé en 7 étapes** avec 4 plans de déploiement :
  - Full Power (Jina + OpenAI) / Budget (reranker SiliconFlow gratuit) / Simple (OpenAI uniquement) / Entièrement local (Ollama, zéro coût API)
- **Les 9 outils MCP** utilisés correctement : `memory_recall`, `memory_store`, `memory_forget`, `memory_update`, `memory_stats`, `memory_list`, `self_improvement_log`, `self_improvement_extract_skill`, `self_improvement_review` *(l'ensemble complet nécessite `enableManagementTools: true` — la config Quick Start par défaut expose les 4 outils principaux)*
- **Évitement des pièges courants** : activation du plugin workspace, `autoRecall` par défaut à false, cache jiti, variables d'environnement, isolation des scopes, etc.

**Installation pour Claude Code :**
```bash
git clone https://github.com/CortexReach/memory-lancedb-pro-skill.git ~/.claude/skills/memory-lancedb-pro
```

**Installation pour OpenClaw :**
```bash
git clone https://github.com/CortexReach/memory-lancedb-pro-skill.git ~/.openclaw/workspace/skills/memory-lancedb-pro-skill
```

---

## Tutoriel vidéo

> Présentation complète : installation, configuration et fonctionnement interne de la recherche hybride.

[![YouTube Video](https://img.shields.io/badge/YouTube-Watch%20Now-red?style=for-the-badge&logo=youtube)](https://youtu.be/MtukF1C8epQ)
**https://youtu.be/MtukF1C8epQ**

[![Bilibili Video](https://img.shields.io/badge/Bilibili-Watch%20Now-00A1D6?style=for-the-badge&logo=bilibili&logoColor=white)](https://www.bilibili.com/video/BV1zUf2BGEgn/)
**https://www.bilibili.com/video/BV1zUf2BGEgn/**

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   index.ts (Point d'entrée)             │
│  Enregistrement du plugin · Parsing config · Hooks      │
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
    │ (API Agent) │   │ (CLI)    │
    └─────────────┘   └──────────┘
```

> Pour une analyse approfondie de l'architecture complète, consultez [docs/memory_architecture_analysis.md](docs/memory_architecture_analysis.md).

<details>
<summary><strong>Référence des fichiers (cliquez pour développer)</strong></summary>

| Fichier | Rôle |
| --- | --- |
| `index.ts` | Point d'entrée du plugin. S'enregistre auprès de l'API Plugin OpenClaw, parse la config, monte les hooks de cycle de vie |
| `openclaw.plugin.json` | Métadonnées du plugin + déclaration complète du JSON Schema de config |
| `cli.ts` | Commandes CLI : `memory-pro list/search/stats/delete/delete-bulk/export/import/reembed/upgrade/migrate` |
| `src/store.ts` | Couche de stockage LanceDB. Création de tables / Indexation FTS / Recherche vectorielle / Recherche BM25 / CRUD |
| `src/embedder.ts` | Abstraction d'embedding. Compatible avec tout fournisseur API compatible OpenAI |
| `src/retriever.ts` | Moteur de recherche hybride. Vectoriel + BM25 → Fusion hybride → Rerank → Décroissance cycle de vie → Filtre |
| `src/scopes.ts` | Contrôle d'accès multi-scope |
| `src/tools.ts` | Définitions des outils agent : `memory_recall`, `memory_store`, `memory_forget`, `memory_update` + outils de gestion |
| `src/noise-filter.ts` | Filtre les refus d'agent, les méta-questions, les salutations et le contenu de faible qualité |
| `src/adaptive-retrieval.ts` | Détermine si une requête nécessite une recherche en mémoire |
| `src/migrate.ts` | Migration depuis `memory-lancedb` intégré vers Pro |
| `src/smart-extractor.ts` | Extraction LLM en 6 catégories avec stockage L0/L1/L2 et déduplication en deux étapes |
| `src/decay-engine.ts` | Modèle de décroissance exponentielle étirée Weibull |
| `src/tier-manager.ts` | Promotion/rétrogradation à trois niveaux : Périphérique ↔ Travail ↔ Noyau |

</details>

---

## Fonctionnalités principales

### Recherche hybride

```
Requête → embedQuery() ─┐
                         ├─→ Fusion hybride → Rerank → Boost décroissance → Normalisation longueur → Filtre
Requête → BM25 FTS ─────┘
```

- **Recherche vectorielle** — similarité sémantique via LanceDB ANN (distance cosinus)
- **Recherche plein texte BM25** — correspondance exacte de mots-clés via l'index FTS de LanceDB
- **Fusion hybride** — score vectoriel comme base, les résultats BM25 reçoivent un boost pondéré (pas du RRF standard — optimisé pour la qualité de rappel réelle)
- **Poids configurables** — `vectorWeight`, `bm25Weight`, `minScore`

### Reranking Cross-Encoder

- Adaptateurs intégrés pour **Jina**, **SiliconFlow**, **Voyage AI** et **Pinecone**
- Compatible avec tout endpoint compatible Jina (ex. Hugging Face TEI, DashScope)
- Scoring hybride : 60% cross-encoder + 40% score fusionné original
- Dégradation gracieuse : repli sur la similarité cosinus en cas d'échec API

### Pipeline de scoring multi-étapes

| Étape | Effet |
| --- | --- |
| **Fusion hybride** | Combine rappel sémantique et correspondance exacte |
| **Rerank Cross-Encoder** | Promeut les résultats sémantiquement précis |
| **Boost décroissance cycle de vie** | Fraîcheur Weibull + fréquence d'accès + importance × confiance |
| **Normalisation de longueur** | Empêche les entrées longues de dominer (ancre : 500 caractères) |
| **Score minimum dur** | Supprime les résultats non pertinents (par défaut : 0.35) |
| **Diversité MMR** | Similarité cosinus > 0.85 → rétrogradé |

### Extraction mémoire intelligente (v1.1.0)

- **Extraction LLM en 6 catégories** : profil, préférences, entités, événements, cas, patterns
- **Stockage par couches L0/L1/L2** : L0 (index en une phrase) → L1 (résumé structuré) → L2 (récit complet)
- **Déduplication en deux étapes** : pré-filtre de similarité vectorielle (≥0.7) → décision sémantique LLM (CREATE/MERGE/SKIP)
- **Fusion sensible aux catégories** : `profile` fusionne toujours, `events`/`cases` en ajout uniquement

### Gestion du cycle de vie mémoire (v1.1.0)

- **Moteur de décroissance Weibull** : score composite = fraîcheur + fréquence + valeur intrinsèque
- **Promotion à trois niveaux** : `Périphérique ↔ Travail ↔ Noyau` avec seuils configurables
- **Renforcement par accès** : les souvenirs fréquemment rappelés décroissent plus lentement (style répétition espacée)
- **Demi-vie modulée par l'importance** : les souvenirs importants décroissent plus lentement

### Isolation multi-scope

- Scopes intégrés : `global`, `agent:<id>`, `custom:<name>`, `project:<id>`, `user:<id>`
- Contrôle d'accès au niveau agent via `scopes.agentAccess`
- Par défaut : chaque agent accède à `global` + son propre scope `agent:<id>`

### Capture automatique et rappel automatique

- **Capture auto** (`agent_end`) : extrait préférences/faits/décisions/entités des conversations, déduplique, stocke jusqu'à 3 par tour
- **Rappel auto** (`before_agent_start`) : injecte le contexte `<relevant-memories>` (jusqu'à 3 entrées)

### Filtrage du bruit et recherche adaptative

- Filtre le contenu de faible qualité : refus d'agent, méta-questions, salutations
- Ignore la recherche pour : salutations, commandes slash, confirmations simples, emoji
- Force la recherche pour les mots-clés mémoire (« souviens-toi », « précédemment », « la dernière fois »)
- Seuils CJK (chinois : 6 caractères vs anglais : 15 caractères)

---

<details>
<summary><strong>Comparaison avec <code>memory-lancedb</code> intégré (cliquez pour développer)</strong></summary>

| Fonctionnalité | `memory-lancedb` intégré | **memory-lancedb-pro** |
| --- | :---: | :---: |
| Recherche vectorielle | Oui | Oui |
| Recherche plein texte BM25 | - | Oui |
| Fusion hybride (Vectoriel + BM25) | - | Oui |
| Rerank cross-encoder (multi-fournisseur) | - | Oui |
| Boost de fraîcheur et décroissance temporelle | - | Oui |
| Normalisation de longueur | - | Oui |
| Diversité MMR | - | Oui |
| Isolation multi-scope | - | Oui |
| Filtrage du bruit | - | Oui |
| Recherche adaptative | - | Oui |
| CLI de gestion | - | Oui |
| Mémoire de session | - | Oui |
| Embeddings sensibles aux tâches | - | Oui |
| **Extraction intelligente LLM (6 catégories)** | - | Oui (v1.1.0) |
| **Décroissance Weibull + Promotion par niveaux** | - | Oui (v1.1.0) |
| Tout embedding compatible OpenAI | Limité | Oui |

</details>

---

## Configuration

<details>
<summary><strong>Exemple de configuration complète</strong></summary>

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
<summary><strong>Fournisseurs d'embedding</strong></summary>

Fonctionne avec **toute API d'embedding compatible OpenAI** :

| Fournisseur | Modèle | Base URL | Dimensions |
| --- | --- | --- | --- |
| **Jina** (recommandé) | `jina-embeddings-v5-text-small` | `https://api.jina.ai/v1` | 1024 |
| **OpenAI** | `text-embedding-3-small` | `https://api.openai.com/v1` | 1536 |
| **Voyage** | `voyage-4-lite` / `voyage-4` | `https://api.voyageai.com/v1` | 1024 / 1024 |
| **Google Gemini** | `gemini-embedding-001` | `https://generativelanguage.googleapis.com/v1beta/openai/` | 3072 |
| **Ollama** (local) | `nomic-embed-text` | `http://localhost:11434/v1` | selon le modèle |

</details>

<details>
<summary><strong>Fournisseurs de reranking</strong></summary>

Le reranking cross-encoder supporte plusieurs fournisseurs via `rerankProvider` :

| Fournisseur | `rerankProvider` | Modèle exemple |
| --- | --- | --- |
| **Jina** (par défaut) | `jina` | `jina-reranker-v3` |
| **SiliconFlow** (niveau gratuit disponible) | `siliconflow` | `BAAI/bge-reranker-v2-m3` |
| **Voyage AI** | `voyage` | `rerank-2.5` |
| **Pinecone** | `pinecone` | `bge-reranker-v2-m3` |

Tout endpoint de reranking compatible Jina fonctionne également — définissez `rerankProvider: "jina"` et pointez `rerankEndpoint` vers votre service (ex. Hugging Face TEI, DashScope `qwen3-rerank`).

</details>

<details>
<summary><strong>Extraction intelligente (LLM) — v1.1.0</strong></summary>

Quand `smartExtraction` est activé (par défaut : `true`), le plugin utilise un LLM pour extraire et classifier intelligemment les souvenirs au lieu de déclencheurs basés sur des regex.

| Champ | Type | Défaut | Description |
|-------|------|---------|-------------|
| `smartExtraction` | boolean | `true` | Activer/désactiver l'extraction LLM en 6 catégories |
| `llm.auth` | string | `api-key` | `api-key` utilise `llm.apiKey` / `embedding.apiKey` ; `oauth` utilise un fichier token OAuth au niveau plugin |
| `llm.apiKey` | string | *(repli sur `embedding.apiKey`)* | Clé API pour le fournisseur LLM |
| `llm.model` | string | `openai/gpt-oss-120b` | Nom du modèle LLM |
| `llm.baseURL` | string | *(repli sur `embedding.baseURL`)* | Point de terminaison API LLM |
| `llm.oauthProvider` | string | `openai-codex` | ID du fournisseur OAuth utilisé quand `llm.auth` est `oauth` |
| `llm.oauthPath` | string | `~/.openclaw/.memory-lancedb-pro/oauth.json` | Fichier token OAuth utilisé quand `llm.auth` est `oauth` |
| `llm.timeoutMs` | number | `30000` | Timeout des requêtes LLM en millisecondes |
| `extractMinMessages` | number | `2` | Nombre minimum de messages avant le déclenchement de l'extraction |
| `extractMaxChars` | number | `8000` | Nombre maximum de caractères envoyés au LLM |


OAuth `llm` config (utiliser le cache de connexion Codex / ChatGPT existant pour les appels LLM) :
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

Notes pour `llm.auth: "oauth"` :

- `llm.oauthProvider` est actuellement `openai-codex`.
- Les tokens OAuth sont stockés par défaut dans `~/.openclaw/.memory-lancedb-pro/oauth.json`.
- Vous pouvez définir `llm.oauthPath` si vous souhaitez stocker ce fichier ailleurs.
- `auth login` sauvegarde la configuration `llm` api-key précédente à côté du fichier OAuth, et `auth logout` restaure cette sauvegarde lorsqu'elle est disponible.
- Passer de `api-key` à `oauth` ne transfère pas automatiquement `llm.baseURL`. Définissez-le manuellement en mode OAuth uniquement si vous souhaitez intentionnellement un backend personnalisé compatible ChatGPT/Codex.

</details>

<details>
<summary><strong>Configuration du cycle de vie (Décroissance + Niveaux)</strong></summary>

| Champ | Défaut | Description |
|-------|---------|-------------|
| `decay.recencyHalfLifeDays` | `30` | Demi-vie de base pour la décroissance Weibull |
| `decay.frequencyWeight` | `0.3` | Poids de la fréquence d'accès dans le score composite |
| `decay.intrinsicWeight` | `0.3` | Poids de `importance × confiance` |
| `decay.betaCore` | `0.8` | Beta Weibull pour les souvenirs `noyau` |
| `decay.betaWorking` | `1.0` | Beta Weibull pour les souvenirs `travail` |
| `decay.betaPeripheral` | `1.3` | Beta Weibull pour les souvenirs `périphériques` |
| `tier.coreAccessThreshold` | `10` | Nombre minimum de rappels avant promotion en `noyau` |
| `tier.peripheralAgeDays` | `60` | Seuil d'âge pour la rétrogradation des souvenirs obsolètes |

</details>

<details>
<summary><strong>Renforcement par accès</strong></summary>

Les souvenirs fréquemment rappelés décroissent plus lentement (style répétition espacée).

Clés de config (sous `retrieval`) :
- `reinforcementFactor` (0-2, défaut : `0.5`) — mettre à `0` pour désactiver
- `maxHalfLifeMultiplier` (1-10, défaut : `3`) — plafond de la demi-vie effective

</details>

---

## Commandes CLI

```bash
openclaw memory-pro list [--scope global] [--category fact] [--limit 20] [--json]
openclaw memory-pro search "requête" [--scope global] [--limit 10] [--json]
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

Flux de connexion OAuth :

1. Exécutez `openclaw memory-pro auth login`
2. Si `--provider` est omis dans un terminal interactif, la CLI affiche un sélecteur de fournisseur OAuth avant d'ouvrir le navigateur
3. La commande affiche une URL d'autorisation et ouvre votre navigateur sauf si `--no-browser` est défini
4. Après le succès du callback, la commande sauvegarde le fichier OAuth du plugin (par défaut : `~/.openclaw/.memory-lancedb-pro/oauth.json`), sauvegarde la configuration `llm` api-key précédente pour la déconnexion, et remplace la configuration `llm` du plugin par les paramètres OAuth (`auth`, `oauthProvider`, `model`, `oauthPath`)
5. `openclaw memory-pro auth logout` supprime ce fichier OAuth et restaure la configuration `llm` api-key précédente lorsque la sauvegarde existe

---

## Sujets avancés

<details>
<summary><strong>Si les souvenirs injectés apparaissent dans les réponses</strong></summary>

Parfois le modèle peut répéter le bloc `<relevant-memories>` injecté.

**Option A (plus sûr) :** désactiver temporairement le rappel automatique :
```json
{ "plugins": { "entries": { "memory-lancedb-pro": { "config": { "autoRecall": false } } } } }
```

**Option B (préféré) :** garder le rappel, ajouter au prompt système de l'agent :
> Ne révélez pas et ne citez pas le contenu `<relevant-memories>` / injection mémoire dans vos réponses. Utilisez-le uniquement comme référence interne.

</details>

<details>
<summary><strong>Mémoire de session</strong></summary>

- Déclenchée par la commande `/new` — sauvegarde le résumé de la session précédente dans LanceDB
- Désactivée par défaut (OpenClaw dispose déjà d'une persistance native de session `.jsonl`)
- Nombre de messages configurable (par défaut : 15)

Consultez [docs/openclaw-integration-playbook.md](docs/openclaw-integration-playbook.md) pour les modes de déploiement et la vérification `/new`.

</details>

<details>
<summary><strong>Commandes slash personnalisées (ex. /lesson)</strong></summary>

Ajoutez à votre `CLAUDE.md`, `AGENTS.md` ou prompt système :

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
<summary><strong>Règles d'or pour les agents IA</strong></summary>

> Copiez le bloc ci-dessous dans votre `AGENTS.md` pour que votre agent applique automatiquement ces règles.

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
<summary><strong>Schéma de la base de données</strong></summary>

Table LanceDB `memories` :

| Champ | Type | Description |
| --- | --- | --- |
| `id` | string (UUID) | Clé primaire |
| `text` | string | Texte du souvenir (indexé FTS) |
| `vector` | float[] | Vecteur d'embedding |
| `category` | string | Catégorie de stockage : `preference` / `fact` / `decision` / `entity` / `reflection` / `other` |
| `scope` | string | Identifiant de scope (ex. `global`, `agent:main`) |
| `importance` | float | Score d'importance 0-1 |
| `timestamp` | int64 | Horodatage de création (ms) |
| `metadata` | string (JSON) | Métadonnées étendues |

Clés `metadata` courantes en v1.1.0 : `l0_abstract`, `l1_overview`, `l2_content`, `memory_category`, `tier`, `access_count`, `confidence`, `last_accessed_at`

> **Note sur les catégories :** Le champ `category` de niveau supérieur utilise 6 catégories de stockage. Les 6 labels sémantiques de l'Extraction Intelligente (`profile` / `preferences` / `entities` / `events` / `cases` / `patterns`) sont stockés dans `metadata.memory_category`.

</details>

<details>
<summary><strong>Dépannage</strong></summary>

### "Cannot mix BigInt and other types" (LanceDB / Apache Arrow)

Avec LanceDB 0.26+, certaines colonnes numériques peuvent être retournées en `BigInt`. Mettez à niveau vers **memory-lancedb-pro >= 1.0.14** — ce plugin convertit maintenant les valeurs avec `Number(...)` avant les opérations arithmétiques.

</details>

---

## Documentation

| Document | Description |
| --- | --- |
| [Playbook d'intégration OpenClaw](docs/openclaw-integration-playbook.md) | Modes de déploiement, vérification, matrice de régression |
| [Analyse de l'architecture mémoire](docs/memory_architecture_analysis.md) | Analyse approfondie de l'architecture complète |
| [CHANGELOG v1.1.0](docs/CHANGELOG-v1.1.0.md) | Changements de comportement v1.1.0 et justification de la mise à niveau |
| [Chunking long contexte](docs/long-context-chunking.md) | Stratégie de chunking pour les longs documents |

---

## Beta : Smart Memory v1.1.0

> Statut : Beta — disponible via `npm i memory-lancedb-pro@beta`. Les utilisateurs stables sur `latest` ne sont pas affectés.

| Fonctionnalité | Description |
|---------|-------------|
| **Extraction intelligente** | Extraction LLM en 6 catégories avec métadonnées L0/L1/L2. Repli sur regex si désactivé. |
| **Scoring du cycle de vie** | Décroissance Weibull intégrée à la recherche — les souvenirs fréquents et importants sont mieux classés. |
| **Gestion des niveaux** | Système à trois niveaux (Noyau → Travail → Périphérique) avec promotion/rétrogradation automatique. |

Retours : [GitHub Issues](https://github.com/CortexReach/memory-lancedb-pro/issues) · Retour en arrière : `npm i memory-lancedb-pro@latest`

---

## Dépendances

| Package | Rôle |
| --- | --- |
| `@lancedb/lancedb` ≥0.26.2 | Base de données vectorielle (ANN + FTS) |
| `openai` ≥6.21.0 | Client API d'embedding compatible OpenAI |
| `@sinclair/typebox` 0.34.48 | Définitions de types JSON Schema |

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

## Licence

MIT

---

## Mon QR Code WeChat

<img src="https://github.com/win4r/AISuperDomain/assets/42172631/7568cf78-c8ba-4182-aa96-d524d903f2bc" width="214.8" height="291">
