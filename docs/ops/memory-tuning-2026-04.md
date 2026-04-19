# DGG-2684 — LanceDB 메모리 검색 정확도 진단 + ranking 튜닝 (2026-04)

## 1) 문제
- 넓은 질의(예: `최근 작업`)에서 오래된 항목/타 scope 혼입이 자주 발생.
- `scope:*` 태그 질의가 안정적으로 동작하지 않는 케이스 확인.

## 2) 진단 데이터셋 (AC-1)
- 대표 질의 10개, 각 질의 top-5 결과 수집.
- 결과 파일: `docs/ops/memory-tuning-2026-04-baseline.csv` (총 150행 = 10질의 x 5결과 x 3변형)
- 라벨: `relevant`, `partial`, `irrelevant`
  - 기준: 질의 토큰 매칭 + 기대 scope 매칭
  - `scope:*` 질의는 scope 일치 여부를 우선 판정

## 3) 실험 (AC-2)

### baseline
- 현행값
  - `vectorWeight=0.7`, `bm25Weight=0.3`
  - `recencyHalfLifeDays=14`, `recencyWeight=0.1`
  - `hardMinScore=0.28`
- scopeFilter: 기존 agentAccess(광범위)

### exp_recent
- 최근성 강화
  - `recencyHalfLifeDays=7`, `recencyWeight=0.2`
  - `timeDecayHalfLifeDays=30`
  - `hardMinScore=0.30`
- scopeFilter: 기존 agentAccess

### exp_scope_hybrid (선정안)
- hybrid + scope 집중
  - `vectorWeight=0.55`, `bm25Weight=0.45`
  - `recencyHalfLifeDays=10`, `recencyWeight=0.18`
  - `hardMinScore=0.32`
- scopeFilter: 역할 중심 축소(own agent + shared dggd scopes)
  - 정책 원본: `scripts/ops/dgg-2684-scope-policy.json`
  - 실험 스크립트(`scripts/ops/dgg-2684-eval.mjs`)와 운영 반영 스크립트(`scripts/ops/dgg-2684-apply-scope-policy.mjs`)가 동일 정책 파일을 사용

## 4) 결과
출처: `docs/ops/memory-tuning-2026-04-summary.json`

- baseline
  - weightedPrecision@5: `0.52`
  - scopeLeakageRate: `0.56`
- exp_recent
  - weightedPrecision@5: `0.54` (+0.02)
  - scopeLeakageRate: `0.52` (-0.04)
- exp_scope_hybrid
  - weightedPrecision@5: `0.63` (+0.11)
  - scopeLeakageRate: `0.34` (-0.22)

결론: `exp_scope_hybrid`가 정확도/혼입률 모두 가장 좋음.

## 5) 적용 변경 (AC-3)

### 코드/기본값
- `src/retriever.ts`
  - 태그 파싱 정규식 수정 (`scope:dggd:ops` 같은 콜론 포함 값 정상 파싱)
  - `DEFAULT_RETRIEVAL_CONFIG`를 선정안으로 갱신
    - `vectorWeight: 0.55`
    - `bm25Weight: 0.45`
    - `recencyHalfLifeDays: 10`
    - `recencyWeight: 0.18`
    - `hardMinScore: 0.32`

### 스키마 기본값
- `openclaw.plugin.json`
  - `configSchema.properties.retrieval.properties.*.default`를 동일 값으로 갱신

### 테스트
- `test/retriever-tag-query.test.mjs`
  - scope-tag 관련 케이스 검증 통과

### 재현 스크립트
- `scripts/ops/dgg-2684-eval.mjs`
  - baseline / exp_recent / exp_scope_hybrid 3개 변형 실행
  - 산출물: `docs/ops/memory-tuning-2026-04-baseline.csv`, `docs/ops/memory-tuning-2026-04-summary.json`

### 운영 프로파일 반영 (전 에이전트)
- 정책 파일: `scripts/ops/dgg-2684-scope-policy.json`
- 적용 스크립트: `scripts/ops/dgg-2684-apply-scope-policy.mjs`
- 원격 증거 파일:
  - `docs/ops/evidence/dgg-2684-agent-access-before.json`
  - `docs/ops/evidence/dgg-2684-agent-access-after.json`
  - `docs/ops/evidence/dgg-2684-agent-access-apply-report.json`
- 반영 요약 (`apply-report` 기준):
  - 변경 대상 1개 프로파일(`main`), 타 에이전트 private scope 5개 제거
  - 나머지 8개 프로파일은 정책과 동일(변경 없음)
  - retrieval 튜닝값(`0.55/0.45/10/0.18/0.32`)과 함께 운영 config hash 변경 확인

## 6) CTO 재질의 top-5 검증 (AC-4)
질의: `최근 작업`

- before: `docs/ops/evidence/dgg-2684-top5-before.png`
- after: `docs/ops/evidence/dgg-2684-top5-after.png`

(동일 질의 top-5 비교에서 scope 혼입 감소 확인)

## 7) 재현 명령
- 벤치 스크립트: `scripts/ops/dgg-2684-eval.mjs`
- 실행:
  - `cd <memory-lancedb-pro repo root>`
  - `node scripts/ops/dgg-2684-eval.mjs --config ~/.openclaw/openclaw.json --out docs/ops --agent badtz-dev --scope-policy scripts/ops/dgg-2684-scope-policy.json`

- 운영 프로파일 반영:
  - `node scripts/ops/dgg-2684-apply-scope-policy.mjs --write --config ~/.openclaw/openclaw.json --scope-policy scripts/ops/dgg-2684-scope-policy.json --before-out docs/ops/evidence/dgg-2684-agent-access-before.json --after-out docs/ops/evidence/dgg-2684-agent-access-after.json --report-out docs/ops/evidence/dgg-2684-agent-access-apply-report.json`
