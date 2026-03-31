<div align="center">

# 🧠 memory-lancedb-pro · 🦞OpenClaw Plugin

**Assistente de Memória IA para Agentes [OpenClaw](https://github.com/openclaw/openclaw)**

*Dê ao seu agente de IA um cérebro que realmente lembra — entre sessões, entre agentes, ao longo do tempo.*

Um plugin de memória de longo prazo para OpenClaw baseado em LanceDB que armazena preferências, decisões e contexto de projetos, e os recupera automaticamente em sessões futuras.

[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-blue)](https://github.com/openclaw/openclaw)
[![npm version](https://img.shields.io/npm/v/memory-lancedb-pro)](https://www.npmjs.com/package/memory-lancedb-pro)
[![LanceDB](https://img.shields.io/badge/LanceDB-Vectorstore-orange)](https://lancedb.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

[English](README.md) | [简体中文](README_CN.md) | [繁體中文](README_TW.md) | [日本語](README_JA.md) | [한국어](README_KO.md) | [Français](README_FR.md) | [Español](README_ES.md) | [Deutsch](README_DE.md) | [Italiano](README_IT.md) | [Русский](README_RU.md) | [Português (Brasil)](README_PT-BR.md)

</div>

---

## Por que memory-lancedb-pro?

A maioria dos agentes de IA sofre de amnésia. Eles esquecem tudo no momento em que você inicia um novo chat.

**memory-lancedb-pro** é um plugin de memória de longo prazo de nível de produção para OpenClaw que transforma seu agente em um verdadeiro **Assistente de Memória IA** — captura automaticamente o que importa, deixa o ruído desaparecer naturalmente e recupera a memória certa no momento certo. Sem tags manuais, sem dores de cabeça com configuração.

### Seu Assistente de Memória IA em ação

**Sem memória — cada sessão começa do zero:**

> **Você:** "Use tabs para indentação, sempre adicione tratamento de erros."
> *(próxima sessão)*
> **Você:** "Eu já te disse — tabs, não espaços!" 😤
> *(próxima sessão)*
> **Você:** "…sério, tabs. E tratamento de erros. De novo."

**Com memory-lancedb-pro — seu agente aprende e lembra:**

> **Você:** "Use tabs para indentação, sempre adicione tratamento de erros."
> *(próxima sessão — agente recupera automaticamente suas preferências)*
> **Agente:** *(aplica silenciosamente tabs + tratamento de erros)* ✅
> **Você:** "Por que escolhemos PostgreSQL em vez de MongoDB no mês passado?"
> **Agente:** "Com base na nossa discussão de 12 de fevereiro, os principais motivos foram…" ✅

Essa é a diferença que um **Assistente de Memória IA** faz — aprende seu estilo, lembra decisões passadas e entrega respostas personalizadas sem você precisar se repetir.

### O que mais ele pode fazer?

| | O que você obtém |
|---|---|
| **Auto-Capture** | Seu agente aprende de cada conversa — sem necessidade de `memory_store` manual |
| **Extração inteligente** | Classificação LLM em 6 categorias: perfis, preferências, entidades, eventos, casos, padrões |
| **Esquecimento inteligente** | Modelo de decaimento Weibull — memórias importantes permanecem, ruído desaparece |
| **Busca híbrida** | Busca vetorial + BM25 full-text, fundida com reranking cross-encoder |
| **Injeção de contexto** | Memórias relevantes aparecem automaticamente antes de cada resposta |
| **Isolamento multi-scope** | Limites de memória por agente, por usuário, por projeto |
| **Qualquer provedor** | OpenAI, Jina, Gemini, Ollama ou qualquer API compatível com OpenAI |
| **Toolkit completo** | CLI, backup, migração, upgrade, exportação/importação — pronto para produção |

---

## Início rápido

### Opção A: Script de instalação com um clique (recomendado)

O **[script de instalação](https://github.com/CortexReach/toolbox/tree/main/memory-lancedb-pro-setup)** mantido pela comunidade gerencia instalação, atualização e reparo em um único comando:

```bash
curl -fsSL https://raw.githubusercontent.com/CortexReach/toolbox/main/memory-lancedb-pro-setup/setup-memory.sh -o setup-memory.sh
bash setup-memory.sh
```

> Veja [Ecossistema](#ecossistema) abaixo para a lista completa de cenários cobertos e outras ferramentas da comunidade.

### Opção B: Instalação manual

**Via OpenClaw CLI (recomendado):**
```bash
openclaw plugins install memory-lancedb-pro@beta
```

**Ou via npm:**
```bash
npm i memory-lancedb-pro@beta
```
> Se usar npm, você também precisará adicionar o diretório de instalação do plugin como caminho **absoluto** em `plugins.load.paths` no seu `openclaw.json`. Este é o problema de configuração mais comum.

Adicione ao seu `openclaw.json`:

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

**Por que esses valores padrão?**
- `autoCapture` + `smartExtraction` → seu agente aprende automaticamente de cada conversa
- `autoRecall` → memórias relevantes são injetadas antes de cada resposta
- `extractMinMessages: 2` → a extração é acionada em chats normais de dois turnos
- `sessionMemory.enabled: false` → evita poluir a busca com resumos de sessão no início

Valide e reinicie:

```bash
openclaw config validate
openclaw gateway restart
openclaw logs --follow --plain | grep "memory-lancedb-pro"
```

Você deve ver:
- `memory-lancedb-pro: smart extraction enabled`
- `memory-lancedb-pro@...: plugin registered`

Pronto! Seu agente agora tem memória de longo prazo.

<details>
<summary><strong>Mais caminhos de instalação (usuários existentes, upgrades)</strong></summary>

**Já está usando OpenClaw?**

1. Adicione o plugin com um caminho **absoluto** em `plugins.load.paths`
2. Vincule o slot de memória: `plugins.slots.memory = "memory-lancedb-pro"`
3. Verifique: `openclaw plugins info memory-lancedb-pro && openclaw memory-pro stats`

**Atualizando de versões anteriores ao v1.1.0?**

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

Veja `CHANGELOG-v1.1.0.md` para mudanças de comportamento e justificativa de upgrade.

</details>

<details>
<summary><strong>Importação rápida via Telegram Bot (clique para expandir)</strong></summary>

Se você está usando a integração Telegram do OpenClaw, a maneira mais fácil é enviar um comando de importação diretamente para o Bot principal em vez de editar a configuração manualmente.

Envie esta mensagem:

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

## Ecossistema

memory-lancedb-pro é o plugin principal. A comunidade construiu ferramentas ao redor dele para tornar a configuração e o uso diário ainda mais suaves:

### Script de instalação — Instalação, atualização e reparo com um clique

> **[CortexReach/toolbox/memory-lancedb-pro-setup](https://github.com/CortexReach/toolbox/tree/main/memory-lancedb-pro-setup)**

Não é apenas um instalador simples — o script lida inteligentemente com diversos cenários reais:

| Sua situação | O que o script faz |
|---|---|
| Nunca instalou | Download → instalar dependências → escolher config → gravar em openclaw.json → reiniciar |
| Instalado via `git clone`, preso em um commit antigo | `git fetch` + `checkout` automático para a versão mais recente → reinstalar dependências → verificar |
| Config tem campos inválidos | Detecção automática via filtro de schema, remoção de campos não suportados |
| Instalado via `npm` | Pula atualização git, lembra de executar `npm update` por conta própria |
| CLI `openclaw` quebrado por config inválida | Fallback: ler caminho do workspace diretamente do arquivo `openclaw.json` |
| `extensions/` em vez de `plugins/` | Detecção automática da localização do plugin a partir da config ou sistema de arquivos |
| Já está atualizado | Executa apenas verificações de saúde, sem alterações |

```bash
bash setup-memory.sh                    # Install or upgrade
bash setup-memory.sh --dry-run          # Preview only
bash setup-memory.sh --beta             # Include pre-release versions
bash setup-memory.sh --uninstall        # Revert config and remove plugin
```

Presets de provedores integrados: **Jina / DashScope / SiliconFlow / OpenAI / Ollama**, ou traga sua própria API compatível com OpenAI. Para uso completo (incluindo `--ref`, `--selfcheck-only` e mais), veja o [README do script de instalação](https://github.com/CortexReach/toolbox/tree/main/memory-lancedb-pro-setup).

### Claude Code / OpenClaw Skill — Configuração guiada por IA

> **[CortexReach/memory-lancedb-pro-skill](https://github.com/CortexReach/memory-lancedb-pro-skill)**

Instale esta Skill e seu agente de IA (Claude Code ou OpenClaw) ganha conhecimento profundo de todas as funcionalidades do memory-lancedb-pro. Basta dizer **"me ajude a ativar a melhor configuração"** e obtenha:

- **Workflow de configuração guiado em 7 etapas** com 4 planos de implantação:
  - Full Power (Jina + OpenAI) / Budget (reranker SiliconFlow gratuito) / Simple (apenas OpenAI) / Totalmente local (Ollama, custo API zero)
- **Todas as 9 ferramentas MCP** usadas corretamente: `memory_recall`, `memory_store`, `memory_forget`, `memory_update`, `memory_stats`, `memory_list`, `self_improvement_log`, `self_improvement_extract_skill`, `self_improvement_review` *(o toolkit completo requer `enableManagementTools: true` — a configuração padrão do Quick Start expõe as 4 ferramentas principais)*
- **Prevenção de armadilhas comuns**: ativação de plugin workspace, `autoRecall` padrão false, cache jiti, variáveis de ambiente, isolamento de scope, etc.

**Instalação para Claude Code:**
```bash
git clone https://github.com/CortexReach/memory-lancedb-pro-skill.git ~/.claude/skills/memory-lancedb-pro
```

**Instalação para OpenClaw:**
```bash
git clone https://github.com/CortexReach/memory-lancedb-pro-skill.git ~/.openclaw/workspace/skills/memory-lancedb-pro-skill
```

---

## Tutorial em vídeo

> Guia completo: instalação, configuração e funcionamento interno da busca híbrida.

[![YouTube Video](https://img.shields.io/badge/YouTube-Watch%20Now-red?style=for-the-badge&logo=youtube)](https://youtu.be/MtukF1C8epQ)
**https://youtu.be/MtukF1C8epQ**

[![Bilibili Video](https://img.shields.io/badge/Bilibili-Watch%20Now-00A1D6?style=for-the-badge&logo=bilibili&logoColor=white)](https://www.bilibili.com/video/BV1zUf2BGEgn/)
**https://www.bilibili.com/video/BV1zUf2BGEgn/**

---

## Arquitetura

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

> Para um mergulho profundo na arquitetura completa, veja [docs/memory_architecture_analysis.md](docs/memory_architecture_analysis.md).

<details>
<summary><strong>Referência de arquivos (clique para expandir)</strong></summary>

| Arquivo | Finalidade |
| --- | --- |
| `index.ts` | Ponto de entrada do plugin. Registra na API de Plugin do OpenClaw, analisa config, monta lifecycle hooks |
| `openclaw.plugin.json` | Metadados do plugin + declaração completa de config via JSON Schema |
| `cli.ts` | Comandos CLI: `memory-pro list/search/stats/delete/delete-bulk/export/import/reembed/upgrade/migrate` |
| `src/store.ts` | Camada de armazenamento LanceDB. Criação de tabelas / Indexação FTS / Busca vetorial / Busca BM25 / CRUD |
| `src/embedder.ts` | Abstração de embedding. Compatível com qualquer provedor de API compatível com OpenAI |
| `src/retriever.ts` | Motor de busca híbrida. Vector + BM25 → Fusão Híbrida → Rerank → Decaimento do Ciclo de Vida → Filtro |
| `src/scopes.ts` | Controle de acesso multi-scope |
| `src/tools.ts` | Definições de ferramentas do agente: `memory_recall`, `memory_store`, `memory_forget`, `memory_update` + ferramentas de gerenciamento |
| `src/noise-filter.ts` | Filtra recusas do agente, meta-perguntas, saudações e conteúdo de baixa qualidade |
| `src/adaptive-retrieval.ts` | Determina se uma consulta precisa de busca na memória |
| `src/migrate.ts` | Migração do `memory-lancedb` integrado para o Pro |
| `src/smart-extractor.ts` | Extração LLM em 6 categorias com armazenamento em camadas L0/L1/L2 e deduplicação em dois estágios |
| `src/decay-engine.ts` | Modelo de decaimento exponencial esticado Weibull |
| `src/tier-manager.ts` | Promoção/rebaixamento em três níveis: Peripheral ↔ Working ↔ Core |

</details>

---

## Funcionalidades principais

### Busca híbrida

```
Query → embedQuery() ─┐
                       ├─→ Hybrid Fusion → Rerank → Lifecycle Decay Boost → Length Norm → Filter
Query → BM25 FTS ─────┘
```

- **Busca vetorial** — similaridade semântica via LanceDB ANN (distância cosseno)
- **Busca full-text BM25** — correspondência exata de palavras-chave via índice FTS do LanceDB
- **Fusão híbrida** — pontuação vetorial como base, resultados BM25 recebem boost ponderado (não é RRF padrão — ajustado para qualidade de recall no mundo real)
- **Pesos configuráveis** — `vectorWeight`, `bm25Weight`, `minScore`

### Reranking Cross-Encoder

- Adaptadores integrados para **Jina**, **SiliconFlow**, **Voyage AI** e **Pinecone**
- Compatível com qualquer endpoint compatível com Jina (ex.: Hugging Face TEI, DashScope)
- Pontuação híbrida: 60% cross-encoder + 40% pontuação fundida original
- Degradação elegante: fallback para similaridade cosseno em caso de falha da API

### Pipeline de pontuação multi-estágio

| Estágio | Efeito |
| --- | --- |
| **Fusão híbrida** | Combina recall semântico e correspondência exata |
| **Rerank Cross-Encoder** | Promove resultados semanticamente precisos |
| **Boost de decaimento do ciclo de vida** | Frescor Weibull + frequência de acesso + importância × confiança |
| **Normalização de comprimento** | Impede que entradas longas dominem (âncora: 500 caracteres) |
| **Pontuação mínima rígida** | Remove resultados irrelevantes (padrão: 0.35) |
| **Diversidade MMR** | Similaridade cosseno > 0.85 → rebaixado |

### Extração inteligente de memória (v1.1.0)

- **Extração LLM em 6 categorias**: perfil, preferências, entidades, eventos, casos, padrões
- **Armazenamento em camadas L0/L1/L2**: L0 (índice em uma frase) → L1 (resumo estruturado) → L2 (narrativa completa)
- **Deduplicação em dois estágios**: pré-filtro de similaridade vetorial (≥0.7) → decisão semântica LLM (CREATE/MERGE/SKIP)
- **Fusão consciente de categorias**: `profile` sempre funde, `events`/`cases` apenas adicionam

### Gerenciamento do ciclo de vida da memória (v1.1.0)

- **Motor de decaimento Weibull**: pontuação composta = frescor + frequência + valor intrínseco
- **Promoção em três níveis**: `Peripheral ↔ Working ↔ Core` com limiares configuráveis
- **Reforço por acesso**: memórias recuperadas frequentemente decaem mais lentamente (estilo repetição espaçada)
- **Meia-vida modulada pela importância**: memórias importantes decaem mais lentamente

### Isolamento multi-scope

- Scopes integrados: `global`, `agent:<id>`, `custom:<name>`, `project:<id>`, `user:<id>`
- Controle de acesso no nível do agente via `scopes.agentAccess`
- Padrão: cada agente acessa `global` + seu próprio scope `agent:<id>`

### Auto-Capture e Auto-Recall

- **Auto-Capture** (`agent_end`): extrai preferências/fatos/decisões/entidades das conversas, deduplica, armazena até 3 por turno
- **Auto-Recall** (`before_agent_start`): injeta contexto `<relevant-memories>` (até 3 entradas)

### Filtragem de ruído e busca adaptativa

- Filtra conteúdo de baixa qualidade: recusas do agente, meta-perguntas, saudações
- Pula a busca para: saudações, comandos slash, confirmações simples, emoji
- Força a busca para palavras-chave de memória ("lembra", "anteriormente", "da última vez")
- Limiares CJK (chinês: 6 caracteres vs inglês: 15 caracteres)

---

<details>
<summary><strong>Comparação com o <code>memory-lancedb</code> integrado (clique para expandir)</strong></summary>

| Funcionalidade | `memory-lancedb` integrado | **memory-lancedb-pro** |
| --- | :---: | :---: |
| Busca vetorial | Sim | Sim |
| Busca full-text BM25 | - | Sim |
| Fusão híbrida (Vector + BM25) | - | Sim |
| Rerank cross-encoder (multi-provedor) | - | Sim |
| Boost de frescor e decaimento temporal | - | Sim |
| Normalização de comprimento | - | Sim |
| Diversidade MMR | - | Sim |
| Isolamento multi-scope | - | Sim |
| Filtragem de ruído | - | Sim |
| Busca adaptativa | - | Sim |
| CLI de gerenciamento | - | Sim |
| Memória de sessão | - | Sim |
| Embeddings conscientes de tarefa | - | Sim |
| **Extração inteligente LLM (6 categorias)** | - | Sim (v1.1.0) |
| **Decaimento Weibull + Promoção de nível** | - | Sim (v1.1.0) |
| Qualquer embedding compatível com OpenAI | Limitado | Sim |

</details>

---

## Configuração

<details>
<summary><strong>Exemplo de configuração completa</strong></summary>

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
<summary><strong>Provedores de Embedding</strong></summary>

Funciona com **qualquer API de embedding compatível com OpenAI**:

| Provedor | Modelo | Base URL | Dimensões |
| --- | --- | --- | --- |
| **Jina** (recomendado) | `jina-embeddings-v5-text-small` | `https://api.jina.ai/v1` | 1024 |
| **OpenAI** | `text-embedding-3-small` | `https://api.openai.com/v1` | 1536 |
| **Voyage** | `voyage-4-lite` / `voyage-4` | `https://api.voyageai.com/v1` | 1024 / 1024 |
| **Google Gemini** | `gemini-embedding-001` | `https://generativelanguage.googleapis.com/v1beta/openai/` | 3072 |
| **Ollama** (local) | `nomic-embed-text` | `http://localhost:11434/v1` | específico do provedor |

</details>

<details>
<summary><strong>Provedores de Rerank</strong></summary>

O reranking cross-encoder suporta múltiplos provedores via `rerankProvider`:

| Provedor | `rerankProvider` | Modelo de exemplo |
| --- | --- | --- |
| **Jina** (padrão) | `jina` | `jina-reranker-v3` |
| **SiliconFlow** (plano gratuito disponível) | `siliconflow` | `BAAI/bge-reranker-v2-m3` |
| **Voyage AI** | `voyage` | `rerank-2.5` |
| **Pinecone** | `pinecone` | `bge-reranker-v2-m3` |

Qualquer endpoint de rerank compatível com Jina também funciona — defina `rerankProvider: "jina"` e aponte `rerankEndpoint` para seu serviço (ex.: Hugging Face TEI, DashScope `qwen3-rerank`).

</details>

<details>
<summary><strong>Extração inteligente (LLM) — v1.1.0</strong></summary>

Quando `smartExtraction` está habilitado (padrão: `true`), o plugin usa um LLM para extrair e classificar memórias de forma inteligente em vez de gatilhos baseados em regex.

| Campo | Tipo | Padrão | Descrição |
|-------|------|--------|-----------|
| `smartExtraction` | boolean | `true` | Habilitar/desabilitar extração LLM em 6 categorias |
| `llm.auth` | string | `api-key` | `api-key` usa `llm.apiKey` / `embedding.apiKey`; `oauth` usa um arquivo de token OAuth com escopo de plugin por padrão |
| `llm.apiKey` | string | *(fallback para `embedding.apiKey`)* | Chave de API para o provedor LLM |
| `llm.model` | string | `openai/gpt-oss-120b` | Nome do modelo LLM |
| `llm.baseURL` | string | *(fallback para `embedding.baseURL`)* | Endpoint da API LLM |
| `llm.oauthProvider` | string | `openai-codex` | ID do provedor OAuth usado quando `llm.auth` é `oauth` |
| `llm.oauthPath` | string | `~/.openclaw/.memory-lancedb-pro/oauth.json` | Arquivo de token OAuth usado quando `llm.auth` é `oauth` |
| `llm.timeoutMs` | number | `30000` | Timeout da requisição LLM em milissegundos |
| `extractMinMessages` | number | `2` | Mensagens mínimas antes da extração ser acionada |
| `extractMaxChars` | number | `8000` | Máximo de caracteres enviados ao LLM |


Configuração `llm` com OAuth (usa cache de login existente do Codex / ChatGPT para chamadas LLM):
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

Notas para `llm.auth: "oauth"`:

- `llm.oauthProvider` é atualmente `openai-codex`.
- Tokens OAuth têm como padrão `~/.openclaw/.memory-lancedb-pro/oauth.json`.
- Você pode definir `llm.oauthPath` se quiser armazenar esse arquivo em outro lugar.
- `auth login` faz snapshot da configuração `llm` anterior (api-key) ao lado do arquivo OAuth, e `auth logout` restaura esse snapshot quando disponível.
- Mudar de `api-key` para `oauth` não transfere automaticamente `llm.baseURL`. Defina-o manualmente no modo OAuth apenas quando você intencionalmente quiser um backend personalizado compatível com ChatGPT/Codex.

</details>

<details>
<summary><strong>Configuração do ciclo de vida (Decaimento + Nível)</strong></summary>

| Campo | Padrão | Descrição |
|-------|--------|-----------|
| `decay.recencyHalfLifeDays` | `30` | Meia-vida base para decaimento de frescor Weibull |
| `decay.frequencyWeight` | `0.3` | Peso da frequência de acesso na pontuação composta |
| `decay.intrinsicWeight` | `0.3` | Peso de `importance × confidence` |
| `decay.betaCore` | `0.8` | Beta Weibull para memórias `core` |
| `decay.betaWorking` | `1.0` | Beta Weibull para memórias `working` |
| `decay.betaPeripheral` | `1.3` | Beta Weibull para memórias `peripheral` |
| `tier.coreAccessThreshold` | `10` | Contagem mínima de recall antes de promover para `core` |
| `tier.peripheralAgeDays` | `60` | Limiar de idade para rebaixar memórias inativas |

</details>

<details>
<summary><strong>Reforço por acesso</strong></summary>

Memórias recuperadas com frequência decaem mais lentamente (estilo repetição espaçada).

Chaves de configuração (em `retrieval`):
- `reinforcementFactor` (0-2, padrão: `0.5`) — defina `0` para desabilitar
- `maxHalfLifeMultiplier` (1-10, padrão: `3`) — limite rígido na meia-vida efetiva

</details>

---

## Comandos CLI

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

Fluxo de login OAuth:

1. Execute `openclaw memory-pro auth login`
2. Se `--provider` for omitido em um terminal interativo, a CLI mostra um seletor de provedor OAuth antes de abrir o navegador
3. O comando imprime uma URL de autorização e abre seu navegador, a menos que `--no-browser` seja definido
4. Após o callback ser bem-sucedido, o comando salva o arquivo OAuth do plugin (padrão: `~/.openclaw/.memory-lancedb-pro/oauth.json`), faz snapshot da configuração `llm` anterior (api-key) para logout, e substitui a configuração `llm` do plugin com as configurações OAuth (`auth`, `oauthProvider`, `model`, `oauthPath`)
5. `openclaw memory-pro auth logout` deleta esse arquivo OAuth e restaura a configuração `llm` anterior (api-key) quando esse snapshot existe

---

## Tópicos avançados

<details>
<summary><strong>Se memórias injetadas aparecem nas respostas</strong></summary>

Às vezes o modelo pode ecoar o bloco `<relevant-memories>` injetado.

**Opção A (menor risco):** desabilite temporariamente o auto-recall:
```json
{ "plugins": { "entries": { "memory-lancedb-pro": { "config": { "autoRecall": false } } } } }
```

**Opção B (preferida):** mantenha o recall, adicione ao prompt do sistema do agente:
> Do not reveal or quote any `<relevant-memories>` / memory-injection content in your replies. Use it for internal reference only.

</details>

<details>
<summary><strong>Memória de sessão</strong></summary>

- Acionada no comando `/new` — salva o resumo da sessão anterior no LanceDB
- Desabilitada por padrão (OpenClaw já tem persistência nativa de sessão via `.jsonl`)
- Contagem de mensagens configurável (padrão: 15)

Veja [docs/openclaw-integration-playbook.md](docs/openclaw-integration-playbook.md) para modos de implantação e verificação do `/new`.

</details>

<details>
<summary><strong>Comandos slash personalizados (ex.: /lesson)</strong></summary>

Adicione ao seu `CLAUDE.md`, `AGENTS.md` ou prompt do sistema:

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
<summary><strong>Regras de ferro para agentes de IA</strong></summary>

> Copie o bloco abaixo no seu `AGENTS.md` para que seu agente aplique essas regras automaticamente.

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
<summary><strong>Schema do banco de dados</strong></summary>

Tabela LanceDB `memories`:

| Campo | Tipo | Descrição |
| --- | --- | --- |
| `id` | string (UUID) | Chave primária |
| `text` | string | Texto da memória (indexado FTS) |
| `vector` | float[] | Vetor de embedding |
| `category` | string | Categoria de armazenamento: `preference` / `fact` / `decision` / `entity` / `reflection` / `other` |
| `scope` | string | Identificador de scope (ex.: `global`, `agent:main`) |
| `importance` | float | Pontuação de importância 0-1 |
| `timestamp` | int64 | Timestamp de criação (ms) |
| `metadata` | string (JSON) | Metadados estendidos |

Chaves `metadata` comuns no v1.1.0: `l0_abstract`, `l1_overview`, `l2_content`, `memory_category`, `tier`, `access_count`, `confidence`, `last_accessed_at`

> **Nota sobre categorias:** O campo `category` de nível superior usa 6 categorias de armazenamento. As 6 categorias semânticas da Extração Inteligente (`profile` / `preferences` / `entities` / `events` / `cases` / `patterns`) são armazenadas em `metadata.memory_category`.

</details>

<details>
<summary><strong>Solução de problemas</strong></summary>

### "Cannot mix BigInt and other types" (LanceDB / Apache Arrow)

No LanceDB 0.26+, algumas colunas numéricas podem ser retornadas como `BigInt`. Atualize para **memory-lancedb-pro >= 1.0.14** — este plugin agora converte valores usando `Number(...)` antes de operações aritméticas.

</details>

---

## Documentação

| Documento | Descrição |
| --- | --- |
| [Playbook de integração OpenClaw](docs/openclaw-integration-playbook.md) | Modos de implantação, verificação, matriz de regressão |
| [Análise da arquitetura de memória](docs/memory_architecture_analysis.md) | Análise aprofundada da arquitetura completa |
| [CHANGELOG v1.1.0](docs/CHANGELOG-v1.1.0.md) | Mudanças de comportamento v1.1.0 e justificativa de upgrade |
| [Chunking de contexto longo](docs/long-context-chunking.md) | Estratégia de chunking para documentos longos |

---

## Beta: Smart Memory v1.1.0

> Status: Beta — disponível via `npm i memory-lancedb-pro@beta`. Usuários estáveis no `latest` não são afetados.

| Funcionalidade | Descrição |
|---------|-------------|
| **Extração inteligente** | Extração LLM em 6 categorias com metadados L0/L1/L2. Fallback para regex quando desabilitado. |
| **Pontuação do ciclo de vida** | Decaimento Weibull integrado à busca — memórias frequentes e importantes ficam mais bem ranqueadas. |
| **Gerenciamento de níveis** | Sistema de três níveis (Core → Working → Peripheral) com promoção/rebaixamento automático. |

Feedback: [GitHub Issues](https://github.com/CortexReach/memory-lancedb-pro/issues) · Reverter: `npm i memory-lancedb-pro@latest`

---

## Dependências

| Pacote | Finalidade |
| --- | --- |
| `@lancedb/lancedb` ≥0.26.2 | Banco de dados vetorial (ANN + FTS) |
| `openai` ≥6.21.0 | Cliente de API de Embedding compatível com OpenAI |
| `@sinclair/typebox` 0.34.48 | Definições de tipo JSON Schema |

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

## Licença

MIT

---

## Meu QR Code WeChat

<img src="https://github.com/win4r/AISuperDomain/assets/42172631/7568cf78-c8ba-4182-aa96-d524d903f2bc" width="214.8" height="291">
