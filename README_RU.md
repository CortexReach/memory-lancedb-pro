<div align="center">

# 🧠 memory-lancedb-pro · 🦞OpenClaw Plugin

**ИИ-ассистент памяти для агентов [OpenClaw](https://github.com/openclaw/openclaw)**

*Дайте вашему ИИ-агенту мозг, который действительно помнит: между сессиями, между агентами и с течением времени.*

Плагин долгосрочной памяти для OpenClaw на базе LanceDB, который сохраняет предпочтения, решения и контекст проекта, а затем автоматически вспоминает их в будущих сессиях.

[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-blue)](https://github.com/openclaw/openclaw)
[![npm version](https://img.shields.io/npm/v/memory-lancedb-pro)](https://www.npmjs.com/package/memory-lancedb-pro)
[![LanceDB](https://img.shields.io/badge/LanceDB-Vectorstore-orange)](https://lancedb.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

[English](README.md) | [简体中文](README_CN.md) | [繁體中文](README_TW.md) | [日本語](README_JA.md) | [한국어](README_KO.md) | [Français](README_FR.md) | [Español](README_ES.md) | [Deutsch](README_DE.md) | [Italiano](README_IT.md) | [Русский](README_RU.md) | [Português (Brasil)](README_PT-BR.md)

</div>

---

## Почему memory-lancedb-pro?

Большинство ИИ-агентов страдают амнезией. Они забывают все, как только вы начинаете новый чат.

**memory-lancedb-pro** — это production-grade плагин долгосрочной памяти для OpenClaw, который превращает вашего агента в настоящего **ИИ-ассистента памяти**. Он автоматически фиксирует важное, позволяет шуму естественно угасать и поднимает нужное воспоминание в нужный момент. Никаких ручных тегов, никаких мучений с конфигурацией.

### Как это выглядит на практике

**Без памяти: каждая сессия начинается с нуля**

> **Вы:** "Используй табы для отступов и всегда добавляй обработку ошибок."
> *(следующая сессия)*
> **Вы:** "Я же уже говорил: табы, а не пробелы!" 😤
> *(еще одна сессия)*
> **Вы:** "...серьезно, табы. И обработка ошибок. Снова."

**С memory-lancedb-pro агент учится и помнит**

> **Вы:** "Используй табы для отступов и всегда добавляй обработку ошибок."
> *(следующая сессия: агент автоматически вспоминает ваши предпочтения)*
> **Агент:** *(молча применяет табы + обработку ошибок)* ✅
> **Вы:** "Почему в прошлом месяце мы выбрали PostgreSQL, а не MongoDB?"
> **Агент:** "Судя по нашему обсуждению 12 февраля, основные причины были..." ✅

В этом и есть разница: **ИИ-ассистент памяти** изучает ваш стиль, вспоминает прошлые решения и дает персонализированные ответы без необходимости повторять одно и то же.

### Что еще он умеет?

| | Что вы получаете |
|---|---|
| **Автозахват** | Агент учится на каждом разговоре, без ручного `memory_store` |
| **Умное извлечение** | Классификация на основе LLM по 6 категориям: профили, предпочтения, сущности, события, кейсы, паттерны |
| **Интеллектуальное забывание** | Модель затухания Weibull: важные воспоминания остаются, шум естественно исчезает |
| **Гибридный поиск** | Векторный поиск + полнотекстовый BM25 с объединением и cross-encoder rerank |
| **Инъекция контекста** | Релевантные воспоминания автоматически подаются перед каждым ответом |
| **Изоляция областей памяти** | Границы памяти на уровне агента, пользователя и проекта |
| **Любой провайдер** | OpenAI, Jina, Gemini, Ollama или любой OpenAI-compatible API |
| **Полный набор инструментов** | CLI, backup, migration, upgrade, export/import — готово к продакшену |

---

## Быстрый старт

### Вариант A: скрипт установки в один клик (рекомендуется)

Поддерживаемый сообществом **[скрипт установки](https://github.com/CortexReach/toolbox/tree/main/memory-lancedb-pro-setup)** берет на себя установку, обновление и восстановление одной командой:

```bash
curl -fsSL https://raw.githubusercontent.com/CortexReach/toolbox/main/memory-lancedb-pro-setup/setup-memory.sh -o setup-memory.sh
bash setup-memory.sh
```

> Полный список сценариев, которые покрывает скрипт, и другие инструменты сообщества смотрите ниже в разделе [Экосистема](#экосистема).

### Вариант B: ручная установка

**Через OpenClaw CLI (рекомендуется):**
```bash
openclaw plugins install memory-lancedb-pro@beta
```

**Или через npm:**
```bash
npm i memory-lancedb-pro@beta
```
> Если используете npm, вам также нужно добавить директорию установки плагина как **абсолютный** путь в `plugins.load.paths` вашего `openclaw.json`. Это самая частая проблема при настройке.

Добавьте в `openclaw.json`:

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

**Почему именно такие значения по умолчанию?**
- `autoCapture` + `smartExtraction` → агент автоматически учится на каждом разговоре
- `autoRecall` → релевантные воспоминания подставляются перед каждым ответом
- `extractMinMessages: 2` → извлечение срабатывает в обычном двухходовом диалоге
- `sessionMemory.enabled: false` → поиск не засоряется сводками сессий с первого дня

Проверьте и перезапустите:

```bash
openclaw config validate
openclaw gateway restart
openclaw logs --follow --plain | grep "memory-lancedb-pro"
```

Вы должны увидеть:
- `memory-lancedb-pro: smart extraction enabled`
- `memory-lancedb-pro@...: plugin registered`

Готово. Теперь у вашего агента есть долгосрочная память.

<details>
<summary><strong>Дополнительные варианты установки (для действующих пользователей и апгрейдов)</strong></summary>

**Уже используете OpenClaw?**

1. Добавьте плагин в `plugins.load.paths` как **абсолютный** путь
2. Привяжите memory slot: `plugins.slots.memory = "memory-lancedb-pro"`
3. Проверьте: `openclaw plugins info memory-lancedb-pro && openclaw memory-pro stats`

**Обновляетесь с версии до v1.1.0?**

```bash
# 1) Резервная копия
openclaw memory-pro export --scope global --output memories-backup.json
# 2) Пробный запуск
openclaw memory-pro upgrade --dry-run
# 3) Выполнить апгрейд
openclaw memory-pro upgrade
# 4) Проверка
openclaw memory-pro stats
```

Изменения поведения и причины апгрейда описаны в `CHANGELOG-v1.1.0.md`.

</details>

<details>
<summary><strong>Быстрый импорт для Telegram Bot (нажмите, чтобы раскрыть)</strong></summary>

Если вы используете Telegram-интеграцию OpenClaw, самый простой путь — отправить команду импорта прямо основному боту вместо ручного редактирования конфига.

Отправьте такое сообщение:

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

## Экосистема

memory-lancedb-pro — это основной плагин. Сообщество построило вокруг него инструменты, чтобы установка и ежедневная работа были еще проще.

### Скрипт установки: установка, апгрейд и ремонт в один клик

> **[CortexReach/toolbox/memory-lancedb-pro-setup](https://github.com/CortexReach/toolbox/tree/main/memory-lancedb-pro-setup)**

Это не просто установщик: скрипт грамотно обрабатывает широкий набор реальных сценариев.

| Ваша ситуация | Что делает скрипт |
|---|---|
| Никогда не устанавливали | Скачивает заново → ставит зависимости → помогает выбрать конфиг → записывает в `openclaw.json` → перезапускает |
| Установлено через `git clone`, но застряли на старом коммите | Автоматически делает `git fetch` + `checkout` на актуальную версию → переустанавливает зависимости → проверяет |
| В конфиге есть невалидные поля | Автоматически находит их через schema filter и удаляет неподдерживаемые значения |
| Установлено через `npm` | Пропускает git-обновление и напоминает вручную запустить `npm update` |
| `openclaw` CLI сломан из-за невалидного конфига | Фолбэк: читает путь workspace напрямую из файла `openclaw.json` |
| Используется `extensions/`, а не `plugins/` | Автоматически определяет расположение плагина по конфигу или файловой системе |
| Уже актуальная версия | Запускает только health checks, без изменений |

```bash
bash setup-memory.sh                    # Установить или обновить
bash setup-memory.sh --dry-run          # Только предпросмотр
bash setup-memory.sh --beta             # Включить pre-release версии
bash setup-memory.sh --uninstall        # Откатить конфиг и удалить плагин
```

Встроенные пресеты провайдеров: **Jina / DashScope / SiliconFlow / OpenAI / Ollama**, либо любой собственный OpenAI-compatible API. Полное использование (включая `--ref`, `--selfcheck-only` и другое) смотрите в [README скрипта установки](https://github.com/CortexReach/toolbox/tree/main/memory-lancedb-pro-setup).

### Навык Claude Code / OpenClaw: настройка под управлением ИИ

> **[CortexReach/memory-lancedb-pro-skill](https://github.com/CortexReach/memory-lancedb-pro-skill)**

Установите этот навык, и ваш ИИ-агент (Claude Code или OpenClaw) получит глубокое знание всех возможностей memory-lancedb-pro. Достаточно сказать **"help me enable the best config"**, и вы получите:

- **Пошаговый процесс настройки из 7 шагов** с 4 вариантами деплоя:
  - Полная мощность (Jina + OpenAI) / Экономный (бесплатный reranker от SiliconFlow) / Простой (только OpenAI) / Полностью локальный (Ollama, нулевая стоимость API)
- **Корректное использование всех 9 инструментов MCP**: `memory_recall`, `memory_store`, `memory_forget`, `memory_update`, `memory_stats`, `memory_list`, `self_improvement_log`, `self_improvement_extract_skill`, `self_improvement_review` *(полный набор доступен при `enableManagementTools: true` — стандартный Quick Start открывает только 4 базовых инструмента)*
- **Защиту от типичных ошибок**: включение плагина в workspace, `autoRecall` со значением false по умолчанию, кэш jiti, переменные окружения, изоляция областей памяти и другое

**Установка для Claude Code:**
```bash
git clone https://github.com/CortexReach/memory-lancedb-pro-skill.git ~/.claude/skills/memory-lancedb-pro
```

**Установка для OpenClaw:**
```bash
git clone https://github.com/CortexReach/memory-lancedb-pro-skill.git ~/.openclaw/workspace/skills/memory-lancedb-pro-skill
```

---

## Видеоруководство

> Полный разбор: установка, настройка и внутреннее устройство гибридного поиска.

[![YouTube Video](https://img.shields.io/badge/YouTube-Watch%20Now-red?style=for-the-badge&logo=youtube)](https://youtu.be/MtukF1C8epQ)
**https://youtu.be/MtukF1C8epQ**

[![Bilibili Video](https://img.shields.io/badge/Bilibili-Watch%20Now-00A1D6?style=for-the-badge&logo=bilibili&logoColor=white)](https://www.bilibili.com/video/BV1zUf2BGEgn/)
**https://www.bilibili.com/video/BV1zUf2BGEgn/**

---

## Архитектура

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

> Для глубокого разбора полной архитектуры смотрите [docs/memory_architecture_analysis.md](docs/memory_architecture_analysis.md).

<details>
<summary><strong>Справочник по файлам (нажмите, чтобы раскрыть)</strong></summary>

| Файл | Назначение |
| --- | --- |
| `index.ts` | Точка входа плагина. Регистрация в API плагинов OpenClaw, разбор конфига, подключение хуков жизненного цикла |
| `openclaw.plugin.json` | Метаданные плагина + полная декларация JSON Schema для конфига |
| `cli.ts` | CLI-команды: `memory-pro list/search/stats/delete/delete-bulk/export/import/reembed/upgrade/migrate` |
| `src/store.ts` | Слой хранения LanceDB. Создание таблиц / FTS-индекс / векторный поиск / BM25-поиск / CRUD |
| `src/embedder.ts` | Абстракция эмбеддингов. Совместима с любым провайдером OpenAI-compatible API |
| `src/retriever.ts` | Движок гибридного поиска. Векторный поиск + BM25 → гибридное объединение → реранжирование → затухание жизненного цикла → фильтрация |
| `src/scopes.ts` | Контроль доступа для нескольких областей памяти |
| `src/tools.ts` | Определения инструментов агента: `memory_recall`, `memory_store`, `memory_forget`, `memory_update` + административные инструменты |
| `src/noise-filter.ts` | Фильтрует отказы агента, мета-вопросы, приветствия и низкокачественный контент |
| `src/adaptive-retrieval.ts` | Определяет, нужен ли конкретному запросу поиск по памяти |
| `src/migrate.ts` | Миграция со встроенного `memory-lancedb` на Pro |
| `src/smart-extractor.ts` | Извлечение по 6 категориям на базе LLM с многослойным хранением L0/L1/L2 и двухэтапной дедупликацией |
| `src/decay-engine.ts` | Модель растянутого экспоненциального затухания Weibull |
| `src/tier-manager.ts` | Трехуровневое продвижение/понижение: Peripheral ↔ Working ↔ Core |

</details>

---

## Ключевые возможности

### Гибридный поиск

```
Query → embedQuery() ─┐
                       ├─→ Hybrid Fusion → Rerank → Lifecycle Decay Boost → Length Norm → Filter
Query → BM25 FTS ─────┘
```

- **Векторный поиск** — семантическая близость через LanceDB ANN (cosine distance)
- **Полнотекстовый BM25** — точное совпадение по ключевым словам через LanceDB FTS index
- **Hybrid Fusion** — векторный score служит базой, а BM25-попадания получают взвешенный буст (это не стандартный RRF, а вариант, настроенный под качество реального recall)
- **Настраиваемые веса** — `vectorWeight`, `bm25Weight`, `minScore`

### Кросс-энкодерное реранжирование

- Встроенные адаптеры для **Jina**, **SiliconFlow**, **Voyage AI** и **Pinecone**
- Совместимо с любым Jina-compatible endpoint (например, Hugging Face TEI, DashScope)
- Гибридный скоринг: 60% cross-encoder + 40% исходный fused score
- Graceful degradation: при сбое API откатывается к cosine similarity

### Многоэтапный пайплайн скоринга

| Этап | Эффект |
| --- | --- |
| **Hybrid Fusion** | Комбинирует семантический recall и точное совпадение |
| **Cross-Encoder Rerank** | Продвигает семантически точные попадания |
| **Lifecycle Decay Boost** | Свежесть по Weibull + частота доступа + важность × уверенность |
| **Length Normalization** | Не дает длинным записям доминировать (anchor: 500 chars) |
| **Hard Min Score** | Убирает нерелевантные результаты (по умолчанию: 0.35) |
| **MMR Diversity** | Cosine similarity > 0.85 → понижается |

### Умное извлечение памяти (v1.1.0)

- **LLM-powered извлечение по 6 категориям**: profile, preferences, entities, events, cases, patterns
- **Многослойное хранение L0/L1/L2**: L0 (одно предложение-индекс) → L1 (структурированное summary) → L2 (полный narrative)
- **Двухэтапная дедупликация**: предварительный фильтр по векторному сходству (≥0.7) → LLM-решение по смыслу (CREATE/MERGE/SKIP)
- **Слияние с учетом категории**: `profile` всегда merge, `events` и `cases` добавляются append-only

### Управление жизненным циклом памяти (v1.1.0)

- **Weibull Decay Engine**: composite score = recency + frequency + intrinsic value
- **Трехуровневое продвижение**: `Peripheral ↔ Working ↔ Core` с настраиваемыми порогами
- **Усиление при доступе**: часто вспоминаемые записи затухают медленнее (в духе spaced repetition)
- **Half-life с учетом важности**: важные воспоминания живут дольше

### Изоляция между областями памяти

- Встроенные области памяти: `global`, `agent:<id>`, `custom:<name>`, `project:<id>`, `user:<id>`
- Контроль доступа агента через `scopes.agentAccess`
- По умолчанию каждый агент видит `global` + собственную область `agent:<id>`

### Auto-Capture и Auto-Recall

- **Auto-Capture** (`agent_end`): извлекает preference/fact/decision/entity из диалога, дедуплицирует и сохраняет до 3 записей за ход
- **Auto-Recall** (`before_agent_start`): внедряет контекст `<relevant-memories>` (до 3 записей)

### Фильтрация шума и адаптивный поиск по памяти

- Фильтрует низкокачественный контент: отказы агента, мета-вопросы, приветствия
- Пропускает поиск по памяти для приветствий, slash-команд, простых подтверждений и emoji
- Принудительно включает поиск по памяти по ключевым словам ("remember", "previously", "last time")
- Пороги с учетом CJK (китайский: 6 символов против английского: 15 символов)

---

<details>
<summary><strong>Сравнение со встроенным <code>memory-lancedb</code> (нажмите, чтобы раскрыть)</strong></summary>

| Возможность | Встроенный `memory-lancedb` | **memory-lancedb-pro** |
| --- | :---: | :---: |
| Векторный поиск | Yes | Yes |
| Полнотекстовый BM25 | - | Yes |
| Гибридное объединение (Vector + BM25) | - | Yes |
| Реранжирование cross-encoder (несколько провайдеров) | - | Yes |
| Буст по свежести и затухание во времени | - | Yes |
| Нормализация по длине | - | Yes |
| MMR-диверсификация | - | Yes |
| Изоляция областей памяти | - | Yes |
| Фильтрация шума | - | Yes |
| Адаптивный поиск по памяти | - | Yes |
| Административный CLI | - | Yes |
| Память сессий | - | Yes |
| Эмбеддинги с учетом задачи | - | Yes |
| **Умное извлечение LLM (6 категорий)** | - | Yes (v1.1.0) |
| **Затухание Weibull + продвижение по уровням** | - | Yes (v1.1.0) |
| Любые OpenAI-compatible эмбеддинги | Limited | Yes |

</details>

---

## Конфигурация

<details>
<summary><strong>Полный пример конфигурации</strong></summary>

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
<summary><strong>Провайдеры эмбеддингов</strong></summary>

Работает с **любым OpenAI-compatible API для эмбеддингов**:

| Provider | Model | Base URL | Dimensions |
| --- | --- | --- | --- |
| **Jina** (recommended) | `jina-embeddings-v5-text-small` | `https://api.jina.ai/v1` | 1024 |
| **OpenAI** | `text-embedding-3-small` | `https://api.openai.com/v1` | 1536 |
| **Voyage** | `voyage-4-lite` / `voyage-4` | `https://api.voyageai.com/v1` | 1024 / 1024 |
| **Google Gemini** | `gemini-embedding-001` | `https://generativelanguage.googleapis.com/v1beta/openai/` | 3072 |
| **Ollama** (local) | `nomic-embed-text` | `http://localhost:11434/v1` | зависит от провайдера |

</details>

<details>
<summary><strong>Провайдеры реранжирования</strong></summary>

Кросс-энкодерное реранжирование поддерживает несколько провайдеров через `rerankProvider`:

| Provider | `rerankProvider` | Example Model |
| --- | --- | --- |
| **Jina** (default) | `jina` | `jina-reranker-v3` |
| **SiliconFlow** (есть бесплатный тариф) | `siliconflow` | `BAAI/bge-reranker-v2-m3` |
| **Voyage AI** | `voyage` | `rerank-2.5` |
| **Pinecone** | `pinecone` | `bge-reranker-v2-m3` |

Подойдет и любой Jina-compatible rerank endpoint: задайте `rerankProvider: "jina"` и укажите ваш `rerankEndpoint` (например, Hugging Face TEI, DashScope `qwen3-rerank`).

</details>

<details>
<summary><strong>Smart Extraction (LLM) — v1.1.0</strong></summary>

Когда включен `smartExtraction` (по умолчанию: `true`), плагин использует LLM для интеллектуального извлечения и классификации воспоминаний вместо правил на регулярных выражениях.

| Поле | Тип | По умолчанию | Описание |
|-------|------|---------|-------------|
| `smartExtraction` | boolean | `true` | Включить/выключить извлечение по 6 категориям на базе LLM |
| `llm.auth` | string | `api-key` | `api-key` использует `llm.apiKey` / `embedding.apiKey`; `oauth` по умолчанию использует OAuth-файл токена в области плагина |
| `llm.apiKey` | string | *(по умолчанию берется из `embedding.apiKey`)* | API-ключ провайдера LLM |
| `llm.model` | string | `openai/gpt-oss-120b` | Имя модели LLM |
| `llm.baseURL` | string | *(по умолчанию берется из `embedding.baseURL`)* | URL LLM API |
| `llm.oauthProvider` | string | `openai-codex` | Идентификатор OAuth-провайдера, используемый при `llm.auth = "oauth"` |
| `llm.oauthPath` | string | `~/.openclaw/.memory-lancedb-pro/oauth.json` | Путь к OAuth-файлу токена при `llm.auth = "oauth"` |
| `llm.timeoutMs` | number | `30000` | Таймаут запроса к LLM в миллисекундах |
| `extractMinMessages` | number | `2` | Минимум сообщений до срабатывания извлечения |
| `extractMaxChars` | number | `8000` | Максимум символов, отправляемых в LLM |


OAuth `llm` config (использует существующий кэш логина Codex / ChatGPT для LLM-запросов):
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

Примечания для `llm.auth: "oauth"`:

- `llm.oauthProvider` сейчас равен `openai-codex`.
- По умолчанию OAuth token хранится в `~/.openclaw/.memory-lancedb-pro/oauth.json`.
- Если хотите хранить этот файл в другом месте, можно задать `llm.oauthPath`.
- `auth login` сохраняет снимок предыдущего `llm` конфига в режиме api-key рядом с OAuth-файлом, а `auth logout` восстанавливает этот снимок, если он доступен.
- При переключении с `api-key` на `oauth` значение `llm.baseURL` автоматически не переносится. Указывайте его вручную в OAuth-режиме только если вам действительно нужен кастомный ChatGPT/Codex-compatible backend.

</details>

<details>
<summary><strong>Конфигурация жизненного цикла (Decay + Tier)</strong></summary>

| Поле | По умолчанию | Описание |
|-------|---------|-------------|
| `decay.recencyHalfLifeDays` | `30` | Базовый период полураспада для Weibull recency decay |
| `decay.frequencyWeight` | `0.3` | Вес частоты доступа в composite score |
| `decay.intrinsicWeight` | `0.3` | Вес `importance × confidence` |
| `decay.betaCore` | `0.8` | Weibull beta для воспоминаний уровня `core` |
| `decay.betaWorking` | `1.0` | Weibull beta для `working` |
| `decay.betaPeripheral` | `1.3` | Weibull beta для `peripheral` |
| `tier.coreAccessThreshold` | `10` | Минимальное число recall перед повышением в `core` |
| `tier.peripheralAgeDays` | `60` | Порог возраста для понижения устаревших воспоминаний |

</details>

<details>
<summary><strong>Усиление за счет доступа</strong></summary>

Часто вспоминаемые записи затухают медленнее (в духе spaced repetition).

Ключи конфига (в разделе `retrieval`):
- `reinforcementFactor` (0-2, по умолчанию: `0.5`) — задайте `0`, чтобы отключить
- `maxHalfLifeMultiplier` (1-10, по умолчанию: `3`) — жесткий потолок эффективного периода полураспада

</details>

---

## CLI-команды

```bash
openclaw memory-pro list [--scope global] [--category fact] [--limit 20] [--json]
openclaw memory-pro search "запрос" [--scope global] [--limit 10] [--json]
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

Поток OAuth-авторизации:

1. Запустите `openclaw memory-pro auth login`
2. Если `--provider` не указан и терминал интерактивный, CLI покажет выбор OAuth-провайдера перед открытием браузера
3. Команда выведет URL авторизации и откроет браузер, если не задан `--no-browser`
4. После успешного обратного вызова команда сохранит OAuth-файл плагина (по умолчанию: `~/.openclaw/.memory-lancedb-pro/oauth.json`), снимет текущий `llm` конфиг режима api-key для будущего выхода и заменит конфиг `llm` на OAuth-настройки (`auth`, `oauthProvider`, `model`, `oauthPath`)
5. `openclaw memory-pro auth logout` удаляет этот OAuth-файл и восстанавливает прежний `llm` конфиг api-key, если снимок существует

---

## Продвинутые темы

<details>
<summary><strong>Если внедренные воспоминания попадают в ответы</strong></summary>

Иногда модель может дословно повторять внедренный блок `<relevant-memories>`.

**Вариант A (наименее рискованный):** временно отключить auto-recall:
```json
{ "plugins": { "entries": { "memory-lancedb-pro": { "config": { "autoRecall": false } } } } }
```

**Вариант B (предпочтительный):** оставить recall включенным и добавить в system prompt агента:
> Do not reveal or quote any `<relevant-memories>` / memory-injection content in your replies. Use it for internal reference only.

</details>

<details>
<summary><strong>Память сессии</strong></summary>

- Срабатывает по команде `/new` — сохраняет сводку предыдущей сессии в LanceDB
- По умолчанию отключено (в OpenClaw уже есть встроенная `.jsonl`-персистентность сессий)
- Количество сообщений настраивается (по умолчанию: 15)

О режимах деплоя и проверке `/new` читайте в [docs/openclaw-integration-playbook.md](docs/openclaw-integration-playbook.md).

</details>

<details>
<summary><strong>Пользовательские slash-команды (например, /lesson)</strong></summary>

Добавьте в `CLAUDE.md`, `AGENTS.md` или system prompt:

```markdown
## Команда /lesson
Когда пользователь отправляет `/lesson <контент>`:
1. Используй memory_store и сохрани как category=fact (сырое знание)
2. Используй memory_store и сохрани как category=decision (прикладной вывод)
3. Подтверди, что именно было сохранено

## Команда /remember
Когда пользователь отправляет `/remember <контент>`:
1. Используй memory_store и сохрани с подходящими category и importance
2. Подтверди сохраненным ID памяти
```

</details>

<details>
<summary><strong>Железные правила для ИИ-агентов</strong></summary>

> Скопируйте блок ниже в `AGENTS.md`, чтобы агент автоматически соблюдал эти правила.

```markdown
## Правило 1 — Двухслойное сохранение памяти
Каждая ошибка/урок → НЕМЕДЛЕННО сохранить ДВЕ записи памяти:
- Технический слой: Проблема: [симптом]. Причина: [корневая причина]. Исправление: [решение]. Профилактика: [как избежать]
  (category: fact, importance >= 0.8)
- Принципиальный слой: Принцип решения ([tag]): [правило поведения]. Триггер: [когда]. Действие: [что делать]
  (category: decision, importance >= 0.85)

## Правило 2 — Гигиена LanceDB
Записи должны быть короткими и атомарными (< 500 chars). Никаких сырых summary разговоров и дубликатов.

## Правило 3 — Recall перед повторной попыткой
При ЛЮБОЙ ошибке инструмента ВСЕГДА выполняй memory_recall по релевантным ключевым словам ПЕРЕД повторной попыткой.

## Правило 4 — Подтверди целевую кодовую базу
Перед изменениями убедись, что редактируешь memory-lancedb-pro, а не встроенный memory-lancedb.

## Правило 5 — Очищай кэш jiti после изменений кода плагина
После изменения .ts-файлов в plugins/ ОБЯЗАТЕЛЬНО выполни rm -rf /tmp/jiti/ перед openclaw gateway restart.
```

</details>

<details>
<summary><strong>Схема базы данных</strong></summary>

Таблица LanceDB `memories`:

| Поле | Тип | Описание |
| --- | --- | --- |
| `id` | string (UUID) | Первичный ключ |
| `text` | string | Текст памяти (индексируется для FTS) |
| `vector` | float[] | Вектор эмбеддинга |
| `category` | string | Категория хранения: `preference` / `fact` / `decision` / `entity` / `reflection` / `other` |
| `scope` | string | Идентификатор области памяти (например, `global`, `agent:main`) |
| `importance` | float | Оценка важности от 0 до 1 |
| `timestamp` | int64 | Временная метка создания (мс) |
| `metadata` | string (JSON) | Расширенные метаданные |

Обычные ключи `metadata` в v1.1.0: `l0_abstract`, `l1_overview`, `l2_content`, `memory_category`, `tier`, `access_count`, `confidence`, `last_accessed_at`

> **Примечание о категориях:** поле верхнего уровня `category` использует 6 storage categories. Семантические метки Smart Extraction (`profile` / `preferences` / `entities` / `events` / `cases` / `patterns`) сохраняются в `metadata.memory_category`.

</details>

<details>
<summary><strong>Устранение неполадок</strong></summary>

### "Cannot mix BigInt and other types" (LanceDB / Apache Arrow)

Начиная с LanceDB 0.26+, некоторые числовые колонки могут возвращаться как `BigInt`. Обновитесь до **memory-lancedb-pro >= 1.0.14**: теперь плагин приводит такие значения через `Number(...)` перед арифметикой.

</details>

---

## Документация

| Документ | Описание |
| --- | --- |
| [OpenClaw Integration Playbook](docs/openclaw-integration-playbook.md) | Режимы деплоя, проверка, матрица регрессии |
| [Memory Architecture Analysis](docs/memory_architecture_analysis.md) | Глубокий разбор полной архитектуры |
| [CHANGELOG v1.1.0](docs/CHANGELOG-v1.1.0.md) | Изменения поведения в v1.1.0 и причины апгрейда |
| [Long-Context Chunking](docs/long-context-chunking.md) | Стратегия разбиения длинных документов |

---

## Бета: Smart Memory v1.1.0

> Статус: Beta — доступно через `npm i memory-lancedb-pro@beta`. Пользователи стабильного `latest` не затронуты.

| Возможность | Описание |
|---------|-------------|
| **Умное извлечение** | Извлечение по 6 категориям на базе LLM с метаданными L0/L1/L2. При отключении откатывается к регулярным правилам. |
| **Оценка жизненного цикла** | Затухание Weibull встроено в поиск по памяти: записи с высокой частотой и важностью ранжируются выше. |
| **Управление уровнями** | Трехуровневая система (Core → Working → Peripheral) с автоматическим повышением и понижением. |

Обратная связь: [GitHub Issues](https://github.com/CortexReach/memory-lancedb-pro/issues) · Откат: `npm i memory-lancedb-pro@latest`

---

## Зависимости

| Пакет | Назначение |
| --- | --- |
| `@lancedb/lancedb` ≥0.26.2 | Векторная база данных (ANN + FTS) |
| `openai` ≥6.21.0 | Клиент OpenAI-compatible Embedding API |
| `@sinclair/typebox` 0.34.48 | Определения типов для JSON Schema |

---

## Участники

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

Полный список: [Участники](https://github.com/CortexReach/memory-lancedb-pro/graphs/contributors)

## История звезд

<a href="https://star-history.com/#CortexReach/memory-lancedb-pro&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=CortexReach/memory-lancedb-pro&type=Date&theme=dark&transparent=true" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=CortexReach/memory-lancedb-pro&type=Date&transparent=true" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=CortexReach/memory-lancedb-pro&type=Date&transparent=true" />
  </picture>
</a>

## Лицензия

MIT

---

## Мой QR-код WeChat

<img src="https://github.com/win4r/AISuperDomain/assets/42172631/7568cf78-c8ba-4182-aa96-d524d903f2bc" width="214.8" height="291">
