# 📘 SI 사업 AI 챗봇 운영 표준 문서

> **목적**: SI 프로젝트에서 AI 챗봇을 도입할 때 적용할 표준 정책·아키텍처·운영 절차
> **버전**: 1.0 (2026-05-13 기준)
> **출처**: 함께워크_SI 사이트 (hamkkework-si.netlify.app) 실전 적용 검증
> **작성**: 박두용 PM (함께워크_SI) + AI 협업

---

## 0. 핵심 철학 — 두 마리 토끼 (효율 + 저비용)

AI 챗봇을 비즈니스에 도입할 때 가장 중요한 원칙은 **"AI에게 데이터를 통째로 주지 않는다"**입니다. 데이터는 DB에 두고, AI는 **필요한 만큼만 API로 조회**합니다.

| 안 좋은 방식 | 좋은 방식 |
|---|---|
| 시스템 프롬프트에 전체 리드 30건 박아넣기 | 도구 카탈로그만 알려주고 AI가 `leads_find(name)` 호출 |
| 데이터 누적될수록 비용 증가 | 데이터 1만 건이어도 동일 비용 |
| AI가 추측·환각 가능 | DB가 진실. AI는 자연어 정리만 |

**결과**: 호출당 -57% 입력 토큰 / -52% 비용 / 확장성 무한대

---

## 1. 아키텍처 표준

### 1.1 Function Calling First (도구 호출 우선)

**정의**: 모든 데이터 조회·수정은 AI가 직접 하지 않고 **명시적인 도구 호출**로 처리.

**동작**:
1. AI는 시스템 프롬프트에 "어떤 도구가 있는지"만 받음
2. 사용자 질문에 대해 AI가 적절한 도구 선택 (예: `leads_find`)
3. 서버가 도구 실행해서 결과 반환
4. AI가 결과를 자연어로 요약

**효과**:
- 시스템 프롬프트 토큰 -60% (데이터 dump 제거)
- DB 크기와 무관한 비용 (확장성)
- AI 환각 위험 0 (DB가 진실)
- 모든 호출이 감사 가능 (로그)

**기술 스택**: Gemini Native Function Calling (또는 OpenAI tool_choice, Anthropic tool_use)

**적용 조건**: AI가 DB·외부 시스템 조회·수정해야 하는 모든 경우 (즉, 거의 모든 챗봇)

---

### 1.2 도메인별 CRUD API 패턴

**정의**: 각 데이터 도메인마다 일관된 5개 작업(Create/Read/Update/Delete/List)을 API로 노출.

**도구 명명 표준**:
```
<도메인>_<동작>
- leads_find    (단건 검색)
- leads_list    (조건 목록)
- leads_update  (수정)
- leads_create  (생성)
- leads_stats   (집계)
- leads_delete  (삭제)
```

**도구 설계 원칙**:

| 원칙 | 이유 |
|---|---|
| description은 **간결한 영어**로 (예: "Find one lead by name/email/phone") | 한글 대비 토큰 효율 3배 |
| 응답은 **최소 필드**만 (기본 5-7개 필드) | 토큰 낭비 방지 |
| 긴 문자열은 **60-80자 truncate** + "…" | 토큰 낭비 방지 |
| 목록은 `{total, returned, items}` 메타 포함 | AI가 결과 규모 파악 |
| 에러는 `{error: "...", id?}` 구조화 | AI가 재시도 가능 |

**참고 코드**: `netlify/functions/_lib/tools.js`

---

### 1.3 데이터 dump 완전 제거 원칙

**정의**: 시스템 프롬프트에 **사용자별·상태별로 변하는 데이터**를 절대 박아넣지 않는다.

**금지 패턴 ❌**:
```
시스템 프롬프트:
  ## 운영자 컨텍스트
  ### 리드 (30건)
  - 김민수 | a@b.com | new
  - 이영희 | c@d.com | quote
  ...
```

**권장 패턴 ✅**:
```
시스템 프롬프트:
  ## 도구 매핑
  - "○○ 누구야" → leads_find(name)
  - "리드 목록" → leads_list(...)

AI가 필요할 때 도구 호출 → 데이터 받음
```

**효과**: 시스템 프롬프트 -600 토큰 / 호출당 -$0.0001 / Implicit Caching 적중률↑

---

### 1.4 Stream + Agent Loop

**정의**: SSE 스트리밍 + 다중 도구 호출 사이클을 한 요청 안에 묶음.

**Agent Loop 패턴**:
```
사용자 질문
  ↓
[Iter 1] AI 호출 (system + tools + 사용자 메시지)
  ↓ functionCall 반환
[서버] 도구 실행
  ↓
[Iter 2] AI 호출 (이전 + 도구 결과)
  ↓ 자연어 응답
사용자에게 SSE 스트림
```

**안전장치**:
- 최대 5 iteration (무한 루프 방지)
- Iter 2+는 경량 프롬프트 (system 60 토큰 + tools 없음) → 토큰 -80%

**SSE 이벤트 표준**:
- `token` — 텍스트 청크
- `tool_call` — 도구 실행 시작 (UX 인디케이터용)
- `tool_result` — 도구 결과 요약
- `done` — 최종 (cost, tokens, tool_calls 포함)
- `error` — 에러

---

## 2. 비용 관리 표준

### 2.1 스마트 모델 라우팅 (Smart Routing)

**정의**: 질문 복잡도에 따라 다른 모델로 자동 분기.

| 조건 | 모델 | 이유 |
|---|---|---|
| 운영자 모드 | Flash | 추론·도구 호출 필요 |
| 복잡 키워드 (`견적서`, `초안`, `PM` 등 20개) | Flash | 다중 파라미터 처리 |
| 대화 6턴 이상 | Flash | 컨텍스트 이해 필요 |
| 위 외 모든 단순 질문 | Lite | 저렴·빠름 |

**효과**: 단가 차이 3배 (Flash $0.30/M vs Lite $0.10/M) → 평균 비용 -45%

**적용 코드**: `chat.js selectModel()`

---

### 2.2 시스템 프롬프트 정적/동적 분리

**정의**: 매 호출에서 **동일한 부분(정적)**과 **달라지는 부분(동적)**을 분리해서 정적 부분만 캐시 받게 함.

**구조**:
```
[정적] 회사 소개 + 가격표 + 케이스 + 가이드 + 도구 사용 정책 → systemInstruction 필드
       ↑ 매 호출 100% 동일 → Gemini Implicit Caching 적용

[동적] 운영자 이름 + A/B variant + 추가 지침 → contents 첫 user 메시지
       ↑ 호출마다 다름 → 캐시 X
```

**효과**: 정적 부분(~2,100 토큰)이 **75% 할인 단가**로 계산 → 입력 비용 -60% (캐시 적중 시)

**적용 코드**: `chat.js buildSystemPrompt()` returns `{ staticPrompt, dynamicPreamble }`

---

### 2.3 Implicit Caching 활용

**정의**: 동일한 prefix가 단시간 내 반복되면 Gemini가 **자동으로** 캐시 적용 (1,024 토큰 이상).

**조건**:
- Gemini 2.5+ 모델 사용
- 동일 systemInstruction
- 단시간 (몇 분 내) 반복

**효과**: 캐시된 토큰은 **25% 단가**로 청구 (75% 할인)

**모니터링**: 어드민 → 비용 카드 "캐시 적중 N%"

**주의**: 명시적(Explicit) Caching은 최소 32K 토큰 필요. 작은 corpus엔 안 됨. **Implicit Caching이 최선**.

---

### 2.4 출력 토큰 캡

**정의**: AI 응답 길이를 **모델별로 강제 제한**.

| 모드 | maxOutputTokens |
|---|---|
| Lite (단순 응대) | 250 |
| Flash (복잡 추론) | 500 |
| Admin (운영자) | 600 |

**효과**: 출력 비용은 입력의 8배 (Flash 기준). 출력 캡 -40% = 출력 비용 -40%

**적용 코드**: `chat.js maxTokensFor()`

---

### 2.5 대화 히스토리 압축

**정의**: 대화가 길어질수록 오래된 메시지를 **요약 1줄**로 압축.

**전략**:
- 최근 12개 메시지 그대로 전송
- 6개 이상 쌓이면 오래된 것들을 `[이전 대화 N개 — 다룬 주제: 견적, 일정, AI]` 1줄로
- 키워드 추출은 정해진 사전(견적·계약·AI 등)으로

**효과**: 긴 대화 입력 토큰 **-60%**

**적용 코드**: `chatbot.js compressHistory()`

---

### 2.6 LRU 응답 캐시 (5분 TTL)

**정의**: 동일 사용자가 같은 질문 반복 시 **AI 호출 0회**로 캐시 응답.

**조건**:
- 첫 메시지만 (멀티 턴 대화는 캐시 X)
- 운영자 모드 제외 (도구 호출 가능성)
- 도구 호출 응답 제외 (매번 실행 필요)

**효과**: 반복 질문 비용 **0**

**TTL 5분 선정 이유**: 사용자가 같은 페이지에서 같은 질문 다시 묻는 시간 윈도우

**적용 코드**: `chat.js responseCache` (Map 기반)

---

### 2.7 도구 결과 캐시 (서버측, 5분 TTL)

**정의**: 동일 도구 + 동일 인자 호출이면 DB 조회 안 하고 캐시 반환.

**조건**:
- Read-only 도구만 (`_find`, `_list`, `_stats`, `_search`, `_get`)
- mutation 도구(`_update`, `_create`, `_delete`)는 항상 실행

**효과**: 같은 운영자 작업 반복 시 DB 부하 0 + 응답 속도 ↑

**캐시 키**: `<도구이름>::<정렬된_인자_JSON>`

**적용 코드**: `_lib/tools.js executeServerTool()`

---

### 2.8 Frozen Response (지식 베이스)

**정의**: 자주 묻는 질문에 대해 **PM이 직접 작성한 답변**을 키워드 매칭으로 즉시 반환.

**워크플로**:
1. AI 분석 페이지의 "상위 질문 TOP 10" 확인
2. PM이 어드민 [지식 베이스]에서 키워드 + 답변 작성
3. 사용자 질문이 키워드와 매칭(AND/OR)되면 AI 호출 0회로 즉시 응답

**효과**: 매칭 시 **비용 100% 절감** (Gemini 호출 안 함)

**ROI**: 매주 30분 투자 → 트래픽 30%+ 0원 처리

**적용 코드**: `chatbot.js tryFrozenResponse()`, `admin-views.js renderKnowledge()`

---

## 3. 안전망 표준 (안 막아두면 사고 남)

### 3.1 무한루프 방지 5중

| # | 한도 | 값 | 효과 |
|---|---|---|---|
| 1 | 세션당 도구 호출 | 10회 | 도구 무한 호출 차단 |
| 2 | 동일 도구·동일 인자 연속 | 3회 | 같은 동작 반복 차단 |
| 3 | 세션당 대화 턴 | 30턴 | 무한 대화 차단 |
| 4 | 분당 API 호출 | 12회 | 단발 봇 차단 |
| 5 | Agent Loop iteration | 5회 | 도구 사이클 폭주 차단 |

**적용 코드**: `chatbot.js LIMITS`, `chat.js AGENT_MAX_ITERATIONS`

---

### 3.2 세션 비용 하드캡

**정의**: 한 세션 누적 비용이 임계 도달 시 **AI 호출 중단** 후 PM 상담 유도.

| 임계 | 동작 |
|---|---|
| $0.03 | 콘솔 경고 (소프트) |
| $0.05 | 사용자에게 "PM 상담 권유" 자동 메시지 + AI 호출 차단 |

**효과**: 어뷰즈·실수로 한 사용자가 장시간 챗봇 사용해도 비용 폭주 0

**적용 코드**: `chatbot.js sessionCostUsd`

---

### 3.3 어뷰즈 감지 (자동)

**정의**: 최근 1시간 내 같은 세션에서 **30회+ 호출** 발생 시 어드민에 표시.

**효과**: 외부 봇·스크래퍼 조기 발견

**적용 코드**: `admin-views.js renderDashboard()` (어드민 대시보드 비용 카드)

---

### 3.4 Cold Start 회피

**정의**: GitHub Actions cron이 **5분마다** `/api/chat` GET 요청 → 서버리스 함수 warm 유지.

**효과**: 챗봇 첫 응답 시간 **3~7초 → ~1초**

**비용**: GitHub Actions 무료 한도 내 (월 0원)

**적용 파일**: `.github/workflows/keepalive.yml`

---

## 4. 모니터링 & 분석 표준

### 4.1 실시간 비용 대시보드 (필수)

어드민 메인 페이지에 **항상 표시**해야 할 카드:

| 항목 | 의미 |
|---|---|
| 이번 달 누적 비용 / 한도 | 막대 그래프 + % |
| Flash 호출 수 / Lite 호출 수 | 모델별 분포 |
| Input 토큰 / Output 토큰 | 사용량 |
| **캐시 적중 %** | Implicit Caching 효과 |
| 오늘 vs 어제 vs 7일 평균 | 추세 (이상치 감지) |

**적용 코드**: `admin-views.js renderDashboard()`

---

### 4.2 A/B 테스트 (선택, 트래픽 50건+ 시)

**정의**: 챗봇 응답 톤을 **변형 A vs B 50:50 무작위 배정**.

| Variant | 톤 |
|---|---|
| A | 친근 (기본) |
| B | 격식 (정중) |

**측정 지표**:
- 세션 수
- 평균 메시지 수
- 리드 전환율 (가장 중요)
- 세션당 비용

**의사결정**: 50개 세션+ 후 우세한 쪽으로 통일

**적용 코드**: `chatbot.js pickVariant()`, `admin-views.js renderAnalytics()`

---

### 4.3 캐시 적중률 추적

**정의**: 매 응답의 `cachedContentTokenCount`를 누적 → 어드민 카드에 표시.

**해석**:
- 0~10% : 캐시 미적용 (대부분 첫 호출)
- 10~40% : 트래픽 누적 중
- 40%+ : 안정 (정상 운영)

**효과**: 캐시 효과 가시화 → 시스템 프롬프트 변경 영향 즉시 확인 가능

---

### 4.4 도구 호출 로그

**정의**: 모든 도구 호출을 `tool_calls` 배열에 기록 (response의 done 이벤트).

**용도**:
- 어떤 질문에 어떤 도구가 선택됐는지 추적
- 시스템 프롬프트의 도구 매핑 개선 단서
- 장애 시 어디서 막혔는지 진단

---

## 5. 운영 정책

### 5.1 Spending Cap 설정 (필수)

**원칙**: Google AI Studio의 프로젝트별 spending cap을 **반드시** 설정.

**권장 값**:

| 규모 | Cap | 환산 |
|---|---|---|
| 단순 SI (월 5K 호출 이하) | ₩5,000 | ~$3.5 |
| 일반 SI (월 1~3만 호출) | **₩30,000** | ~$20 ⭐ |
| 활발한 SI (월 10만 호출+) | ₩70,000 | ~$50 |

**주의**: ₩(원화)와 $(달러) 단위 헷갈리기 쉬움. 화면 통화 기호 확인 필수.

**설정 경로**: https://aistudio.google.com/spend → 프로젝트 선택 → 지출 한도 수정

---

### 5.2 모델 선택 가이드

| 용도 | 권장 모델 | 이유 |
|---|---|---|
| 단순 정보 응답 (인사·가격·FAQ) | Gemini 2.5 Flash Lite | 저렴 ($0.10/M) |
| 복잡 추론·도구 호출 | Gemini 2.5 Flash | 캐싱 지원, 가성비 |
| 최고 품질 필요한 케이스 | Gemini 2.5 Pro | 비쌈 ($1.25/M), 신중히 |
| 이미지 생성 | ⚠️ 별도 검토 | 호출당 $0.04+ (텍스트의 40배) |

**금지**: 구독 버전(ChatGPT Plus 등)을 자동 챗봇에 사용 불가 (API 없음, ToS 위반)

---

### 5.3 새 도구 추가 표준 절차

새 데이터 도메인 추가 시 (예: `inquiries` 도메인 신설):

1. **데이터 구조 정의**: `store.js`에 컬렉션 추가
2. **Sync 화이트리스트 추가**: `sync.js`의 `ALLOWED_KEYS`에 추가
3. **도구 5종 정의**: `_lib/tools.js`에 `inquiries_find`, `_list`, `_update`, `_create`, `_stats` 추가
4. **시스템 프롬프트 매핑 추가**: `chat.js`의 admin tools static 섹션에 질문 패턴 매핑
5. **어드민 UI 추가** (선택): CRUD 뷰
6. **테스트**: 운영자 모드에서 도구 호출 수동 검증

**도구 schema 표준**:
```js
toolName: {
  adminOnly: true|false,
  declaration: {
    name: 'snake_case',
    description: 'Concise English action description.',
    parameters: {
      type: 'object',
      required: ['..'],
      properties: { ... }
    }
  },
  async handler(args) {
    // Read collection / Filter / Return narrow shape
  }
}
```

---

### 5.4 시스템 프롬프트 변경 절차

**정적 부분 변경 시**:
1. 변경 후 **2-3일 트래픽 안정화 대기** (Implicit Caching 워밍업)
2. 어드민 캐시 적중률 확인 → 30%+ 회복했는지 검증
3. 그 사이는 캐시 hit 0% → 비용 일시 증가 정상

**동적 부분 변경**: 즉시 적용. 캐시 영향 없음.

---

## 6. 측정 지표 (KPI) 표준

### 6.1 비용 KPI

| 지표 | 목표 | 측정 위치 |
|---|---|---|
| 월 누적 비용 | < cap의 50% | 어드민 비용 카드 |
| 호출당 평균 비용 (Lite) | < $0.0003 | usageLog |
| 호출당 평균 비용 (Flash + FC) | < $0.001 | usageLog |
| 캐시 적중률 | > 30% (월 후반) | 어드민 비용 카드 |
| 일일 비용 변동 | < 평균의 +50% | 어드민 추세 카드 |

### 6.2 품질 KPI

| 지표 | 목표 | 측정 위치 |
|---|---|---|
| 챗봇 → 리드 전환율 | > 5% | AI 분석 페이지 |
| AI 환각 발생 | 0건 | (Function Calling 시 구조적으로 0) |
| 평균 응답 시간 (TTFT) | < 1.5초 | (서버 로그) |
| 도구 호출 정확도 | > 95% | 도구 호출 로그 |

### 6.3 확장성 KPI

| 지표 | 목표 |
|---|---|
| 데이터 1만 건 → 비용 증가 | 0% (동일) |
| 트래픽 2배 → 호출당 비용 | 동일 또는 감소 (캐시 효과↑) |

---

## 7. 새 SI 프로젝트 시작 체크리스트

새 SI 프로젝트에 AI 챗봇 도입 시 **이 순서대로** 진행:

### Phase 1 — 인프라 (Day 1)
- [ ] Google AI Studio 프로젝트 생성 (이름: `{CLIENT_NAME}-CHATBOT`)
- [ ] **Spending Cap 설정** (₩30,000부터)
- [ ] Gemini API 키 발급
- [ ] Netlify 환경변수 등록 (`GEMINI_API_KEY`)
- [ ] GitHub Actions Keepalive 워크플로 복사
- [ ] Spending cap 모니터링 슬랙/이메일 알림 설정 (선택)

### Phase 2 — 코드 베이스라인 (Day 2~3)
- [ ] `chat.js` 함수 복사 (Function Calling + Agent Loop 표준)
- [ ] `_lib/tools.js` 도구 카탈로그 복사 → 클라이언트 도메인에 맞게 수정
- [ ] `sync.js` 복사 (Netlify Blobs 동기화)
- [ ] 안전장치 5중 적용 (`LIMITS`)
- [ ] 세션 비용 하드캡 적용
- [ ] LRU 캐시 + Frozen Response 적용

### Phase 3 — 콘텐츠 (Day 4~5)
- [ ] 회사 소개·가격·케이스·FAQ를 시스템 프롬프트 정적 부분에 정리 (2,000 토큰 내)
- [ ] 도구 매핑 가이드 작성 (운영자 도구 사용 패턴)
- [ ] 휴리스틱 폴백 (인사·감사 키워드) 작성

### Phase 4 — 어드민 UI (Day 6~7)
- [ ] 실시간 비용 대시보드
- [ ] AI 분석 (A/B + 히트맵 + 상위 질문)
- [ ] 지식 베이스 (Frozen Response CRUD)
- [ ] 챗봇 로그 검색

### Phase 5 — 운영 시작 (Day 8~)
- [ ] 1주차: 트래픽 50건 누적까지 모니터링 (캐시 워밍업)
- [ ] 2주차: 상위 질문 분석 → Frozen Response 5-10개 등록
- [ ] 4주차: A/B 결과 분석 → 우세 톤 결정
- [ ] 월말: spending cap 재조정

---

## 8. 부록

### 부록 A. 도구 카탈로그 표준 (도메인 1개당 5개 도구)

```
<domain>_find    : 단건 검색 (name|id|email)
<domain>_list    : 조건 목록 (status|since|limit)
<domain>_stats   : 집계 카운트
<domain>_update  : 부분 수정 (id, patch)
<domain>_create  : 신규 생성
```

### 부록 B. 시스템 프롬프트 구조 표준

```
[정적 — systemInstruction]
  1. 정체성 1줄 ("당신은 ○○의 AI 어시스턴트")
  2. 회사 정보 (브랜드, 연락처, PM)
  3. 가격표 (단위·범위)
  4. 레퍼런스 케이스 (Top 10, 한 줄씩)
  5. FAQ (Top 10, Q/A 한 줄씩)
  6. 5단계 프로세스 (요약)
  7. 도구 사용 정책 (간결)
  8. (운영자) 도구 매핑 (질문 패턴 → 도구)
  9. 응답 가이드 (톤·길이·금지)
  10. 닫는 지시

[동적 — contents 첫 user 메시지]
  - 운영자 이름
  - A/B variant 톤 지침
  - 관리자 추가 지침
```

### 부록 C. 비용 시뮬레이션 공식

```
호출당 비용 = (입력 토큰 × 입력 단가) + (출력 토큰 × 출력 단가)

Implicit Caching 적용 시:
  입력 비용 = (cached × 단가 × 0.25) + (non_cached × 단가)

Flash 단가 (2026 기준):
  Input  $0.30 / M tokens
  Output $2.50 / M tokens

Lite 단가:
  Input  $0.10 / M tokens
  Output $0.40 / M tokens

월 비용 예측:
  = (Lite 호출수 × 평균 토큰 × Lite 단가) + (Flash 호출수 × 평균 토큰 × Flash 단가)
```

### 부록 D. 트러블슈팅 표준

| 증상 | 가능한 원인 | 점검 |
|---|---|---|
| 챗봇 응답 없음 | 1) API 키 미설정<br>2) Spending cap 초과<br>3) Gemini 503 | `netlify env:get GEMINI_API_KEY` → AI Studio Spend → 잠시 후 재시도 |
| 비용 급증 | 1) 외부 봇 어뷰즈<br>2) Pro 모델 잘못 라우팅<br>3) 도구 무한 호출 | 어드민 비용 카드의 어뷰즈 의심 세션 확인 / GEMINI_MODEL 환경변수 확인 |
| 캐시 적중 0% | 1) 시스템 프롬프트 자주 변경<br>2) 매 호출 다른 동적 데이터 박아넣음 | systemInstruction 일정한지 확인 |
| AI가 엉뚱한 도구 호출 | 도구 매핑 부족·모호 | 시스템 프롬프트에 명시적 매핑 추가 |
| Iteration 5 도달 에러 | AI가 도구 호출 무한 반복 | 도구 description·결과 더 명확히 |

---

## 9. 영구 금지 사항

- ❌ 구독 버전(ChatGPT Plus 등)을 자동 챗봇에 쓰지 말 것 (API 미지원)
- ❌ 데이터를 시스템 프롬프트에 dump하지 말 것 (확장성·캐시 둘 다 망함)
- ❌ Spending cap 없이 운영하지 말 것 (사고 위험)
- ❌ API 키를 클라이언트 JS에 노출하지 말 것 (반드시 서버 함수 통해서)
- ❌ 한 함수에서 5회 이상 Gemini 재호출하지 말 것 (Agent loop 무한 방지)

---

## 10. 변경 이력

| 버전 | 날짜 | 변경 사항 |
|---|---|---|
| 1.0 | 2026-05-13 | 초안 — 함께워크_SI 실 운영 검증 정책 정리 |

**버전 관리 규칙**: 표준이 업데이트되면 버전 번호 +0.1. 큰 변경(아키텍처)은 +1.0.

---

## 11. 참고 구현 코드

**Repository**: github.com/endyd116-dot/Hamkkework_SI

**핵심 파일**:
- `netlify/functions/chat.js` — Function Calling + Agent Loop
- `netlify/functions/_lib/tools.js` — 도구 카탈로그
- `netlify/functions/sync.js` — Netlify Blobs 동기화
- `assets/js/chatbot.js` — 클라이언트 (스트리밍·캐시·안전장치)
- `assets/js/admin-views.js` — 어드민 (비용·A/B·지식베이스)

**라이브 URL**: https://hamkkework-si.netlify.app

---

**END OF DOCUMENT**
