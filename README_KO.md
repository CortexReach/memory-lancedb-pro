<div align="center">

# 🧠 memory-lancedb-pro · 🦞OpenClaw Plugin

**[OpenClaw](https://github.com/openclaw/openclaw) 에이전트를 위한 AI 메모리 어시스턴트**

*AI 에이전트에게 진짜 기억하는 두뇌를 선물하세요 — 세션을 넘어, 에이전트를 넘어, 시간을 넘어.*

LanceDB 기반 OpenClaw 메모리 플러그인으로, 사용자 선호도·의사결정·프로젝트 맥락을 저장하고 이후 세션에서 자동으로 불러옵니다.

[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-blue)](https://github.com/openclaw/openclaw)
[![npm version](https://img.shields.io/npm/v/memory-lancedb-pro)](https://www.npmjs.com/package/memory-lancedb-pro)
[![LanceDB](https://img.shields.io/badge/LanceDB-Vectorstore-orange)](https://lancedb.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

[English](README.md) | [简体中文](README_CN.md) | [繁體中文](README_TW.md) | [日本語](README_JA.md) | [한국어](README_KO.md) | [Français](README_FR.md) | [Español](README_ES.md) | [Deutsch](README_DE.md) | [Italiano](README_IT.md) | [Русский](README_RU.md) | [Português (Brasil)](README_PT-BR.md)

</div>

---

## 왜 memory-lancedb-pro인가?

대부분의 AI 에이전트는 건망증이 있습니다. 새 채팅을 시작하는 순간 모든 것을 잊어버립니다.

**memory-lancedb-pro**는 OpenClaw를 위한 프로덕션 수준의 장기 기억 플러그인으로, 에이전트를 **AI 메모리 어시스턴트**로 바꿔줍니다 — 중요한 내용을 자동으로 캡처하고, 노이즈는 자연스럽게 희미해지게 하며, 적시에 적절한 기억을 검색합니다. 수동 태그 지정도, 복잡한 설정도 필요 없습니다.

### AI 메모리 어시스턴트 실제 사용 모습

**기억 없이 — 매 세션이 처음부터 시작:**

> **사용자:** "들여쓰기에 탭을 사용하고, 항상 에러 처리를 추가해."
> *(다음 세션)*
> **사용자:** "이미 말했잖아 — 스페이스 말고 탭이라고!" 😤
> *(다음 세션)*
> **사용자:** "...진짜로, 탭이라고. 에러 처리도. 또."

**memory-lancedb-pro와 함께 — 에이전트가 학습하고 기억합니다:**

> **사용자:** "들여쓰기에 탭을 사용하고, 항상 에러 처리를 추가해."
> *(다음 세션 — 에이전트가 사용자 선호도를 자동으로 불러옴)*
> **에이전트:** *(자동으로 탭 + 에러 처리 적용)* ✅
> **사용자:** "지난달에 왜 MongoDB 대신 PostgreSQL을 선택했지?"
> **에이전트:** "2월 12일 논의 내용에 따르면, 주요 이유는..." ✅

이것이 **AI 메모리 어시스턴트**가 만드는 차이입니다 — 사용자의 스타일을 학습하고, 과거 결정을 불러오며, 반복 없이 개인화된 응답을 제공합니다.

### 그 외 무엇을 할 수 있나요?

| | 제공 기능 |
|---|---|
| **Auto-Capture** | 에이전트가 모든 대화에서 학습 — 수동 `memory_store` 불필요 |
| **Smart Extraction** | LLM 기반 6개 카테고리 분류: profile, preferences, entities, events, cases, patterns |
| **Intelligent Forgetting** | Weibull 감쇠 모델 — 중요한 기억은 유지, 노이즈는 자연스럽게 사라짐 |
| **Hybrid Retrieval** | 벡터 + BM25 전문 검색, Cross-Encoder 리랭킹으로 융합 |
| **Context Injection** | 관련 기억이 매 응답 전에 자동으로 불러와짐 |
| **Multi-Scope Isolation** | 에이전트별, 사용자별, 프로젝트별 메모리 경계 |
| **Any Provider** | OpenAI, Jina, Gemini, Ollama 또는 OpenAI 호환 API 모두 지원 |
| **Full Toolkit** | CLI, 백업, 마이그레이션, 업그레이드, 내보내기/가져오기 — 프로덕션 환경에 적합 |

---

## 빠른 시작

> **CPU 요구사항:** CPU가 **AVX/AVX2** 명령어 세트를 지원해야 합니다 (Intel Sandy Bridge 2011년 이후 / AMD Bulldozer 2011년 이후). LanceDB의 네이티브 벡터 엔진에 필수이며, 미지원 CPU에서는 플러그인이 `SIGILL` (잘못된 명령어)로 크래시됩니다. 확인 방법: `grep -o 'avx[^ ]*' /proc/cpuinfo | head -1` (출력 없음 = 미지원). [#419](https://github.com/CortexReach/memory-lancedb-pro/issues/419) 참조.

### 옵션 A: 원클릭 설치 스크립트 (권장)

커뮤니티에서 관리하는 **[설치 스크립트](https://github.com/CortexReach/toolbox/tree/main/memory-lancedb-pro-setup)**가 설치, 업그레이드, 복구를 하나의 명령어로 처리합니다:

```bash
curl -fsSL https://raw.githubusercontent.com/CortexReach/toolbox/main/memory-lancedb-pro-setup/setup-memory.sh -o setup-memory.sh
bash setup-memory.sh
```

> 스크립트가 다루는 전체 시나리오와 기타 커뮤니티 도구 목록은 아래 [에코시스템](#에코시스템)을 참조하세요.

### 옵션 B: 수동 설치

**OpenClaw CLI를 통한 설치 (권장):**
```bash
openclaw plugins install memory-lancedb-pro@beta
```

**또는 npm을 통한 설치:**
```bash
npm i memory-lancedb-pro@beta
```
> npm을 사용하는 경우, `openclaw.json`의 `plugins.load.paths`에 플러그인 설치 디렉터리의 **절대** 경로를 추가해야 합니다. 이것이 가장 흔한 설정 문제입니다.

`openclaw.json`에 다음을 추가하세요:

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

**왜 이러한 기본값인가?**
- `autoCapture` + `smartExtraction` → 에이전트가 모든 대화에서 자동으로 학습
- `autoRecall` → 매 응답 전에 관련 기억이 주입됨
- `extractMinMessages: 2` → 일반적인 두 턴 대화에서 추출이 시작됨
- `sessionMemory.enabled: false` → 초기에 세션 요약으로 검색이 오염되는 것을 방지

검증 및 재시작:

```bash
openclaw config validate
openclaw gateway restart
openclaw logs --follow --plain | grep "memory-lancedb-pro"
```

다음이 표시되어야 합니다:
- `memory-lancedb-pro: smart extraction enabled`
- `memory-lancedb-pro@...: plugin registered`

완료! 이제 에이전트가 장기 기억을 갖게 됩니다.

<details>
<summary><strong>추가 설치 경로 (기존 사용자, 업그레이드)</strong></summary>

**이미 OpenClaw를 사용 중인 경우:**

1. **절대** 경로의 `plugins.load.paths` 항목으로 플러그인 추가
2. 메모리 슬롯 바인딩: `plugins.slots.memory = "memory-lancedb-pro"`
3. 확인: `openclaw plugins info memory-lancedb-pro && openclaw memory-pro stats`

**v1.1.0 이전 버전에서 업그레이드하는 경우:**

```bash
# 1) 백업
openclaw memory-pro export --scope global --output memories-backup.json
# 2) 시뮬레이션 실행
openclaw memory-pro upgrade --dry-run
# 3) 업그레이드 실행
openclaw memory-pro upgrade
# 4) 확인
openclaw memory-pro stats
```

동작 변경사항과 업그레이드 근거는 `CHANGELOG-v1.1.0.md`를 참조하세요.

</details>

<details>
<summary><strong>Telegram 봇 빠른 가져오기 (클릭하여 펼치기)</strong></summary>

OpenClaw의 Telegram 연동을 사용하는 경우, 수동으로 설정을 편집하는 대신 메인 봇에 가져오기 명령어를 직접 보내는 것이 가장 쉬운 방법입니다.

다음 메시지를 전송하세요 (봇에 그대로 복사하여 붙여넣기하는 영문 프롬프트입니다):

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

## 에코시스템

memory-lancedb-pro는 핵심 플러그인입니다. 커뮤니티에서 설정과 일상적인 사용을 더욱 원활하게 만드는 도구들을 구축했습니다:

### 설치 스크립트 — 원클릭 설치, 업그레이드 및 복구

> **[CortexReach/toolbox/memory-lancedb-pro-setup](https://github.com/CortexReach/toolbox/tree/main/memory-lancedb-pro-setup)**

단순한 인스톨러가 아닙니다 — 스크립트가 다양한 실제 시나리오를 지능적으로 처리합니다:

| 상황 | 스크립트의 동작 |
|---|---|
| 설치한 적 없음 | 새로 다운로드 → 의존성 설치 → 설정 선택 → openclaw.json에 기록 → 재시작 |
| `git clone`으로 설치, 이전 커밋에서 멈춤 | 자동 `git fetch` + `checkout`으로 최신 버전 이동 → 의존성 재설치 → 확인 |
| 설정에 유효하지 않은 필드 존재 | 스키마 필터를 통한 자동 감지, 지원되지 않는 필드 제거 |
| `npm`으로 설치 | git 업데이트 건너뜀, `npm update` 직접 실행 알림 |
| 유효하지 않은 설정으로 `openclaw` CLI 동작 불가 | 대체 방법: `openclaw.json` 파일에서 직접 워크스페이스 경로 읽기 |
| `plugins/` 대신 `extensions/` 사용 | 설정 또는 파일시스템에서 플러그인 위치 자동 감지 |
| 이미 최신 상태 | 상태 확인만 실행, 변경 없음 |

```bash
bash setup-memory.sh                    # 설치 또는 업그레이드
bash setup-memory.sh --dry-run          # 미리보기만
bash setup-memory.sh --beta             # 사전 릴리스 버전 포함
bash setup-memory.sh --uninstall        # 설정 복원 및 플러그인 제거
```

내장 프로바이더 프리셋: **Jina / DashScope / SiliconFlow / OpenAI / Ollama**, 또는 자체 OpenAI 호환 API를 사용할 수 있습니다. `--ref`, `--selfcheck-only` 등 전체 사용법은 [설치 스크립트 README](https://github.com/CortexReach/toolbox/tree/main/memory-lancedb-pro-setup)를 참조하세요.

### Claude Code / OpenClaw Skill — AI 가이드 설정

> **[CortexReach/memory-lancedb-pro-skill](https://github.com/CortexReach/memory-lancedb-pro-skill)**

이 Skill을 설치하면 AI 에이전트(Claude Code 또는 OpenClaw)가 memory-lancedb-pro의 모든 기능에 대한 깊은 지식을 갖게 됩니다. **"최적의 설정을 도와줘"**라고 말하면 다음을 제공합니다:

- **가이드 7단계 설정 워크플로우**와 4가지 배포 계획:
  - Full Power (Jina + OpenAI) / Budget (무료 SiliconFlow 리랭커) / Simple (OpenAI만) / Fully Local (Ollama, API 비용 제로)
- **모든 9개 MCP 도구**의 올바른 사용법: `memory_recall`, `memory_store`, `memory_forget`, `memory_update`, `memory_stats`, `memory_list`, `self_improvement_log`, `self_improvement_extract_skill`, `self_improvement_review` *(전체 도구 세트를 사용하려면 `enableManagementTools: true`가 필요합니다 — 기본 빠른 시작 설정은 4개 핵심 도구만 노출합니다)*
- **일반적인 함정 방지**: 워크스페이스 플러그인 활성화, `autoRecall` 기본값 false, jiti 캐시, 환경 변수, 스코프 격리 등

**Claude Code용 설치:**
```bash
git clone https://github.com/CortexReach/memory-lancedb-pro-skill.git ~/.claude/skills/memory-lancedb-pro
```

**OpenClaw용 설치:**
```bash
git clone https://github.com/CortexReach/memory-lancedb-pro-skill.git ~/.openclaw/workspace/skills/memory-lancedb-pro-skill
```

---

## 비디오 튜토리얼

> 전체 안내: 설치, 설정, 하이브리드 검색 내부 구조.

[![YouTube Video](https://img.shields.io/badge/YouTube-Watch%20Now-red?style=for-the-badge&logo=youtube)](https://youtu.be/MtukF1C8epQ)
**https://youtu.be/MtukF1C8epQ**

[![Bilibili Video](https://img.shields.io/badge/Bilibili-Watch%20Now-00A1D6?style=for-the-badge&logo=bilibili&logoColor=white)](https://www.bilibili.com/video/BV1zUf2BGEgn/)
**https://www.bilibili.com/video/BV1zUf2BGEgn/**

---

## 아키텍처

```
┌─────────────────────────────────────────────────────────┐
│                   index.ts (진입점)                      │
│  플러그인 등록 · 설정 파싱 · 라이프사이클 훅              │
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
    │ (에이전트API)│   │ (CLI)    │
    └─────────────┘   └──────────┘
```

> 전체 아키텍처에 대한 심층 분석은 [docs/memory_architecture_analysis.md](docs/memory_architecture_analysis.md)를 참조하세요.

<details>
<summary><strong>파일 레퍼런스 (클릭하여 펼치기)</strong></summary>

| 파일 | 용도 |
| --- | --- |
| `index.ts` | 플러그인 진입점. OpenClaw Plugin API에 등록, 설정 파싱, 라이프사이클 훅 마운트 |
| `openclaw.plugin.json` | 플러그인 메타데이터 + 전체 JSON Schema 설정 선언 |
| `cli.ts` | CLI 명령어: `memory-pro list/search/stats/delete/delete-bulk/export/import/reembed/upgrade/migrate` |
| `src/store.ts` | LanceDB 스토리지 레이어. 테이블 생성 / FTS 인덱싱 / 벡터 검색 / BM25 검색 / CRUD |
| `src/embedder.ts` | 임베딩 추상화. OpenAI 호환 API 프로바이더 모두 지원 |
| `src/retriever.ts` | 하이브리드 검색 엔진. 벡터 + BM25 → 하이브리드 퓨전 → 리랭크 → 라이프사이클 감쇠 → 필터 |
| `src/scopes.ts` | 멀티 스코프 접근 제어 |
| `src/tools.ts` | 에이전트 도구 정의: `memory_recall`, `memory_store`, `memory_forget`, `memory_update` + 관리 도구 |
| `src/noise-filter.ts` | 에이전트 거절, 메타 질문, 인사, 저품질 콘텐츠 필터링 |
| `src/adaptive-retrieval.ts` | 쿼리에 메모리 검색이 필요한지 판단 |
| `src/migrate.ts` | 내장 `memory-lancedb`에서 Pro로의 마이그레이션 |
| `src/smart-extractor.ts` | LLM 기반 6개 카테고리 추출 + L0/L1/L2 계층 저장 + 2단계 중복 제거 |
| `src/decay-engine.ts` | Weibull 확장 지수 감쇠 모델 |
| `src/tier-manager.ts` | 3단계 승격/강등: Peripheral ↔ Working ↔ Core |

</details>

---

## 핵심 기능

### 하이브리드 검색

```
Query → embedQuery() ─┐
                       ├─→ Hybrid Fusion → Rerank → Lifecycle Decay Boost → Length Norm → Filter
Query → BM25 FTS ─────┘
```

- **벡터 검색** — LanceDB ANN을 통한 의미적 유사도 (코사인 거리)
- **BM25 전문 검색** — LanceDB FTS 인덱스를 통한 정확한 키워드 매칭
- **하이브리드 퓨전** — 벡터 스코어를 기본으로, BM25 히트에 가중 부스트 적용 (표준 RRF가 아님 — 실제 검색 품질에 맞게 튜닝됨)
- **가중치 설정 가능** — `vectorWeight`, `bm25Weight`, `minScore`

### Cross-Encoder 리랭킹

- **Jina**, **SiliconFlow**, **Voyage AI**, **Pinecone** 내장 어댑터
- Jina 호환 엔드포인트와 호환 (예: Hugging Face TEI, DashScope)
- 하이브리드 스코어링: Cross-Encoder 60% + 원래 퓨전 스코어 40%
- 그레이스풀 디그레이데이션: API 실패 시 코사인 유사도로 폴백

### 다단계 스코어링 파이프라인

| 단계 | 효과 |
| --- | --- |
| **하이브리드 퓨전** | 의미적 검색과 정확한 매칭 결합 |
| **Cross-Encoder 리랭크** | 의미적으로 정확한 결과 승격 |
| **라이프사이클 감쇠 부스트** | Weibull 최신성 + 접근 빈도 + 중요도 × 신뢰도 |
| **길이 정규화** | 긴 항목이 결과를 지배하는 것을 방지 (앵커: 500자) |
| **최소 점수 하한** | 관련 없는 결과 제거 (기본값: 0.35) |
| **MMR 다양성** | 코사인 유사도 > 0.85 → 강등 |

### Smart Memory Extraction (v1.1.0)

- **LLM 기반 6개 카테고리 추출**: profile, preferences, entities, events, cases, patterns
- **L0/L1/L2 계층 저장**: L0 (한 줄 인덱스) → L1 (구조화된 요약) → L2 (전체 내러티브)
- **2단계 중복 제거**: 벡터 유사도 사전 필터 (≥0.7) → LLM 의미 판단 (CREATE/MERGE/SKIP)
- **카테고리 인식 병합**: `profile`은 항상 병합, `events`/`cases`는 추가 전용

### 메모리 라이프사이클 관리 (v1.1.0)

- **Weibull 감쇠 엔진**: 복합 점수 = 최신성 + 빈도 + 내재적 가치
- **3단계 승격**: `Peripheral ↔ Working ↔ Core`, 설정 가능한 임계값
- **접근 강화**: 자주 불러오는 기억은 더 느리게 감쇠 (간격 반복 학습 방식)
- **중요도 조절 반감기**: 중요한 기억은 더 느리게 감쇠

### Multi-Scope 격리

- 내장 스코프: `global`, `agent:<id>`, `custom:<name>`, `project:<id>`, `user:<id>`
- `scopes.agentAccess`를 통한 에이전트 수준 접근 제어
- 기본값: 각 에이전트가 `global` + 자체 `agent:<id>` 스코프에 접근

### Auto-Capture 및 Auto-Recall

- **Auto-Capture** (`agent_end`): 대화에서 선호도/사실/결정/엔티티를 추출, 중복 제거, 턴당 최대 3개 저장
- **Auto-Recall** (`before_agent_start`): `<relevant-memories>` 컨텍스트 주입 (최대 3개 항목)

### 노이즈 필터링 및 적응형 검색

- 저품질 콘텐츠 필터링: 에이전트 거절, 메타 질문, 인사
- 인사, 슬래시 명령어, 간단한 확인, 이모지에 대해서는 검색 건너뜀
- 기억 키워드에 대해서는 검색 강제 실행 ("기억해", "이전에", "지난번에")
- CJK 인식 임계값 (중국어: 6자 vs 영어: 15자)

---

<details>
<summary><strong>내장 <code>memory-lancedb</code>와의 비교 (클릭하여 펼치기)</strong></summary>

| 기능 | 내장 `memory-lancedb` | **memory-lancedb-pro** |
| --- | :---: | :---: |
| 벡터 검색 | 예 | 예 |
| BM25 전문 검색 | - | 예 |
| 하이브리드 퓨전 (벡터 + BM25) | - | 예 |
| Cross-Encoder 리랭크 (멀티 프로바이더) | - | 예 |
| 최신성 부스트 및 시간 감쇠 | - | 예 |
| 길이 정규화 | - | 예 |
| MMR 다양성 | - | 예 |
| 멀티 스코프 격리 | - | 예 |
| 노이즈 필터링 | - | 예 |
| 적응형 검색 | - | 예 |
| 관리 CLI | - | 예 |
| 세션 메모리 | - | 예 |
| 태스크 인식 임베딩 | - | 예 |
| **LLM Smart Extraction (6개 카테고리)** | - | 예 (v1.1.0) |
| **Weibull 감쇠 + 단계 승격** | - | 예 (v1.1.0) |
| OpenAI 호환 임베딩 | 제한적 | 예 |

</details>

---

## 설정

<details>
<summary><strong>전체 설정 예시</strong></summary>

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
<summary><strong>임베딩 프로바이더</strong></summary>

**OpenAI 호환 임베딩 API**와 모두 동작합니다:

| 프로바이더 | 모델 | Base URL | 차원 |
| --- | --- | --- | --- |
| **Jina** (권장) | `jina-embeddings-v5-text-small` | `https://api.jina.ai/v1` | 1024 |
| **OpenAI** | `text-embedding-3-small` | `https://api.openai.com/v1` | 1536 |
| **Voyage** | `voyage-4-lite` / `voyage-4` | `https://api.voyageai.com/v1` | 1024 / 1024 |
| **Google Gemini** | `gemini-embedding-001` | `https://generativelanguage.googleapis.com/v1beta/openai/` | 3072 |
| **Ollama** (로컬) | `nomic-embed-text` | `http://localhost:11434/v1` | 프로바이더별 상이 |

</details>

<details>
<summary><strong>리랭크 프로바이더</strong></summary>

Cross-Encoder 리랭킹은 `rerankProvider`를 통해 여러 프로바이더를 지원합니다:

| 프로바이더 | `rerankProvider` | 예시 모델 |
| --- | --- | --- |
| **Jina** (기본값) | `jina` | `jina-reranker-v3` |
| **SiliconFlow** (무료 티어 제공) | `siliconflow` | `BAAI/bge-reranker-v2-m3` |
| **Voyage AI** | `voyage` | `rerank-2.5` |
| **Pinecone** | `pinecone` | `bge-reranker-v2-m3` |

Jina 호환 리랭크 엔드포인트도 사용 가능합니다 — `rerankProvider: "jina"`로 설정하고 `rerankEndpoint`를 해당 서비스로 지정하세요 (예: Hugging Face TEI, DashScope `qwen3-rerank`).

</details>

<details>
<summary><strong>Smart Extraction (LLM) — v1.1.0</strong></summary>

`smartExtraction`이 활성화되면 (기본값: `true`), 플러그인이 정규식 기반 트리거 대신 LLM을 사용하여 기억을 지능적으로 추출하고 분류합니다.

| 필드 | 타입 | 기본값 | 설명 |
|-------|------|---------|-------------|
| `smartExtraction` | boolean | `true` | LLM 기반 6개 카테고리 추출 활성화/비활성화 |
| `llm.auth` | string | `api-key` | `api-key`는 `llm.apiKey` / `embedding.apiKey`를 사용; `oauth`는 기본적으로 플러그인 범위의 OAuth 토큰 파일을 사용 |
| `llm.apiKey` | string | *(`embedding.apiKey`로 폴백)* | LLM 프로바이더용 API 키 |
| `llm.model` | string | `openai/gpt-oss-120b` | LLM 모델명 |
| `llm.baseURL` | string | *(`embedding.baseURL`로 폴백)* | LLM API 엔드포인트 |
| `llm.oauthProvider` | string | `openai-codex` | `llm.auth`가 `oauth`일 때 사용되는 OAuth 프로바이더 ID |
| `llm.oauthPath` | string | `~/.openclaw/.memory-lancedb-pro/oauth.json` | `llm.auth`가 `oauth`일 때 사용되는 OAuth 토큰 파일 |
| `llm.timeoutMs` | number | `30000` | LLM 요청 타임아웃 (밀리초) |
| `extractMinMessages` | number | `2` | 추출이 시작되는 최소 메시지 수 |
| `extractMaxChars` | number | `8000` | LLM에 전송되는 최대 문자 수 |


OAuth `llm` 설정 (기존 Codex / ChatGPT 로그인 캐시를 LLM 호출에 사용):
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

`llm.auth: "oauth"` 참고사항:

- `llm.oauthProvider`는 현재 `openai-codex`입니다.
- OAuth 토큰은 기본적으로 `~/.openclaw/.memory-lancedb-pro/oauth.json`에 저장됩니다.
- 파일을 다른 곳에 저장하려면 `llm.oauthPath`를 설정하세요.
- `auth login`은 OAuth 파일 옆에 이전 api-key `llm` 설정의 스냅샷을 저장하며, `auth logout`은 해당 스냅샷이 있을 때 복원합니다.
- `api-key`에서 `oauth`로 전환할 때 `llm.baseURL`이 자동으로 이전되지 않습니다. OAuth 모드에서 의도적으로 사용자 정의 ChatGPT/Codex 호환 백엔드를 원하는 경우에만 수동으로 설정하세요.

</details>

<details>
<summary><strong>라이프사이클 설정 (감쇠 + 단계)</strong></summary>

| 필드 | 기본값 | 설명 |
|-------|---------|-------------|
| `decay.recencyHalfLifeDays` | `30` | Weibull 최신성 감쇠의 기본 반감기 |
| `decay.frequencyWeight` | `0.3` | 복합 점수에서 접근 빈도의 가중치 |
| `decay.intrinsicWeight` | `0.3` | `importance × confidence`의 가중치 |
| `decay.betaCore` | `0.8` | `core` 기억의 Weibull 베타 |
| `decay.betaWorking` | `1.0` | `working` 기억의 Weibull 베타 |
| `decay.betaPeripheral` | `1.3` | `peripheral` 기억의 Weibull 베타 |
| `tier.coreAccessThreshold` | `10` | `core`로 승격하기 위한 최소 호출 횟수 |
| `tier.peripheralAgeDays` | `60` | 오래된 기억을 강등하기 위한 경과 일수 임계값 |

</details>

<details>
<summary><strong>접근 강화</strong></summary>

자주 불러오는 기억은 더 느리게 감쇠합니다 (간격 반복 학습 방식).

설정 키 (`retrieval` 하위):
- `reinforcementFactor` (0-2, 기본값: `0.5`) — `0`으로 설정하면 비활성화
- `maxHalfLifeMultiplier` (1-10, 기본값: `3`) — 유효 반감기의 하드 캡

</details>

---

## CLI 명령어

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

OAuth 로그인 흐름:

1. `openclaw memory-pro auth login` 실행
2. `--provider`를 생략하고 대화형 터미널에서 실행하면, 브라우저를 열기 전에 CLI가 OAuth 프로바이더 선택기를 표시합니다
3. 명령어가 인증 URL을 출력하고 `--no-browser`가 설정되지 않은 한 브라우저를 엽니다
4. 콜백이 성공하면, 명령어가 플러그인 OAuth 파일 (기본값: `~/.openclaw/.memory-lancedb-pro/oauth.json`)을 저장하고, 이전 api-key `llm` 설정의 스냅샷을 로그아웃용으로 저장하며, 플러그인 `llm` 설정을 OAuth 설정 (`auth`, `oauthProvider`, `model`, `oauthPath`)으로 교체합니다
5. `openclaw memory-pro auth logout`은 해당 OAuth 파일을 삭제하고 스냅샷이 존재하면 이전 api-key `llm` 설정을 복원합니다

---

## 고급 주제

<details>
<summary><strong>주입된 기억이 응답에 표시되는 경우</strong></summary>

가끔 모델이 주입된 `<relevant-memories>` 블록을 그대로 출력할 수 있습니다.

**옵션 A (가장 안전):** 일시적으로 Auto-Recall 비활성화:
```json
{ "plugins": { "entries": { "memory-lancedb-pro": { "config": { "autoRecall": false } } } } }
```

**옵션 B (권장):** Auto-Recall은 유지하고 에이전트 시스템 프롬프트에 추가:
> `<relevant-memories>` / 메모리 주입 콘텐츠를 응답에 노출하거나 인용하지 마세요. 내부 참고용으로만 사용하세요.

</details>

<details>
<summary><strong>세션 메모리</strong></summary>

- `/new` 명령어 시 작동 — 이전 세션 요약을 LanceDB에 저장
- 기본적으로 비활성화 (OpenClaw에 이미 네이티브 `.jsonl` 세션 영속화 기능이 있음)
- 메시지 수 설정 가능 (기본값: 15)

배포 모드와 `/new` 검증에 대해서는 [docs/openclaw-integration-playbook.md](docs/openclaw-integration-playbook.md)를 참조하세요.

</details>

<details>
<summary><strong>커스텀 슬래시 명령어 (예: /lesson)</strong></summary>

`CLAUDE.md`, `AGENTS.md` 또는 시스템 프롬프트에 다음을 추가하세요 (에이전트가 읽는 영문 지시문이므로 그대로 사용합니다):

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
<summary><strong>AI 에이전트를 위한 철칙</strong></summary>

> 아래 블록을 `AGENTS.md`에 복사하여 에이전트가 이 규칙을 자동으로 적용하도록 하세요 (에이전트가 읽는 영문 지시문이므로 그대로 사용합니다).

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
<summary><strong>데이터베이스 스키마</strong></summary>

LanceDB 테이블 `memories`:

| 필드 | 타입 | 설명 |
| --- | --- | --- |
| `id` | string (UUID) | 기본 키 |
| `text` | string | 기억 텍스트 (FTS 인덱싱됨) |
| `vector` | float[] | 임베딩 벡터 |
| `category` | string | 저장 카테고리: `preference` / `fact` / `decision` / `entity` / `reflection` / `other` |
| `scope` | string | 스코프 식별자 (예: `global`, `agent:main`) |
| `importance` | float | 중요도 점수 0-1 |
| `timestamp` | int64 | 생성 타임스탬프 (ms) |
| `metadata` | string (JSON) | 확장 메타데이터 |

v1.1.0의 주요 `metadata` 키: `l0_abstract`, `l1_overview`, `l2_content`, `memory_category`, `tier`, `access_count`, `confidence`, `last_accessed_at`

> **카테고리 참고:** 최상위 `category` 필드는 6개 저장 카테고리를 사용합니다. Smart Extraction의 6개 카테고리 의미 라벨 (`profile` / `preferences` / `entities` / `events` / `cases` / `patterns`)은 `metadata.memory_category`에 저장됩니다.

</details>

<details>
<summary><strong>문제 해결</strong></summary>

### "Cannot mix BigInt and other types" (LanceDB / Apache Arrow)

LanceDB 0.26 이상에서 일부 숫자 열이 `BigInt`로 반환될 수 있습니다. **memory-lancedb-pro >= 1.0.14**로 업그레이드하세요 — 이 플러그인은 이제 산술 연산 전에 `Number(...)`를 사용하여 값을 변환합니다.

</details>

---

## 문서

| 문서 | 설명 |
| --- | --- |
| [OpenClaw 통합 플레이북](docs/openclaw-integration-playbook.md) | 배포 모드, 검증, 회귀 매트릭스 |
| [메모리 아키텍처 분석](docs/memory_architecture_analysis.md) | 전체 아키텍처 심층 분석 |
| [CHANGELOG v1.1.0](docs/CHANGELOG-v1.1.0.md) | v1.1.0 동작 변경사항 및 업그레이드 근거 |
| [장문 컨텍스트 청킹](docs/long-context-chunking.md) | 긴 문서를 위한 청킹 전략 |

---

## 베타: Smart Memory v1.1.0

> 상태: 베타 — `npm i memory-lancedb-pro@beta`로 사용 가능. `latest`를 사용하는 안정 버전 사용자는 영향 없음.

| 기능 | 설명 |
|---------|-------------|
| **Smart Extraction** | LLM 기반 6개 카테고리 추출 + L0/L1/L2 메타데이터. 비활성화 시 정규식으로 폴백. |
| **라이프사이클 스코어링** | 검색에 Weibull 감쇠 통합 — 높은 빈도와 높은 중요도의 기억이 상위에 랭크. |
| **단계 관리** | 3단계 시스템 (Core → Working → Peripheral), 자동 승격/강등. |

피드백: [GitHub Issues](https://github.com/CortexReach/memory-lancedb-pro/issues) · 되돌리기: `npm i memory-lancedb-pro@latest`

---

## 의존성

| 패키지 | 용도 |
| --- | --- |
| `@lancedb/lancedb` ≥0.26.2 | 벡터 데이터베이스 (ANN + FTS) |
| `openai` ≥6.21.0 | OpenAI 호환 Embedding API 클라이언트 |
| `@sinclair/typebox` 0.34.48 | JSON Schema 타입 정의 |

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

## 라이선스

MIT

---

## WeChat QR 코드

<img src="https://github.com/win4r/AISuperDomain/assets/42172631/7568cf78-c8ba-4182-aa96-d524d903f2bc" width="214.8" height="291">
