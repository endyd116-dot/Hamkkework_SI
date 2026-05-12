# 📦 함께워크_SI 프로젝트 인수인계 (Handoff)

> **다음 세션의 AI 또는 개발자**: 이 문서 한 장만 읽으면 프로젝트 상태를 완전히 파악할 수 있습니다.

---

## 🎯 프로젝트 개요

- **무엇**: SI/AI 컨설팅 비즈니스 (함께워크_SI)의 **메인 사이트 + 어드민 + 클라이언트 포털 + 블로그 + AI 챗봇 에이전트**
- **운영자**: 박두용 PM (前 액트베이스 전략기획부 부장, 14년) + 장석주 풀스택 개발자
- **연락처**: endy116@naver.com / 010-2807-5242
- **사업 모델**: 대기업 SI 검증 × 풀스택 자체 개발 × AI Core 내장 → 시장가 50% 가격

## 🌐 라이브 URL

| 페이지 | URL | 비고 |
|---|---|---|
| 메인 | https://hamkkework-si.netlify.app | 메인 랜딩 + 챗봇 위젯 |
| 어드민 | https://hamkkework-si.netlify.app/admin | `endyd116@gmail.com` / `hamkke2026` (데모 계정) |
| 클라이언트 포털 | https://hamkkework-si.netlify.app/portal | 어드민에서 계정 발급 |
| 블로그 | https://hamkkework-si.netlify.app/blog | 검색 SEO |
| GitHub | https://github.com/endyd116-dot/Hamkkework_SI | private |
| Netlify | https://app.netlify.com/projects/hamkkework-si | Swaing 팀 |

## 🛠 기술 스택

- **빌드 시스템**: 없음 (순수 정적 HTML/CSS/JS, ES modules)
- **호스팅**: Netlify (Functions 포함)
- **CDN 라이브러리**: Pretendard 폰트, Chart.js, jsPDF, html2canvas, marked
- **백엔드**: Netlify Functions (`netlify/functions/`)
- **AI**: Gemini API (스마트 라우팅 — Flash + Lite)
- **데이터 저장**: localStorage 기반 store (어드민에서 가르치는 시드 데이터 + 사용자 행위)
- **인증**: 데모 모드 (실서비스 전 Netlify Identity/Supabase Auth 교체 필요)

## 📁 파일 구조 (핵심만)

```
HamkkeWorkSi/
├── index.html              # 메인 랜딩 (11섹션 + 챗봇 위젯)
├── admin.html              # 어드민 SPA (13개 뷰 + 챗봇 위젯)
├── portal.html             # 클라이언트 포털
├── blog.html               # 블로그
├── netlify.toml            # 라우팅 + Functions 설정
│
├── assets/
│   ├── images/logo.jpg     # 고래 로고 (1.5MB)
│   ├── css/
│   │   ├── tokens.css      # 디자인 토큰
│   │   ├── main.css        # 메인페이지 + 챗봇
│   │   ├── admin.css       # 어드민
│   │   └── animations.css  # 애니메이션
│   ├── data/
│   │   └── seed.json       # 초기 시드 (14 cases, 7 FAQ, 3 blog, 가격표, chat intents)
│   └── js/
│       ├── store.js        # 통합 localStorage 추상화 (모든 페이지 공유)
│       ├── main.js         # 메인페이지 오케스트레이션
│       ├── animations.js   # 스크롤 리빌·카운터
│       ├── calculator.js   # 견적 계산기 (챗봇이 prefill_quote로 제어 가능)
│       ├── chatbot.js      # AI 에이전트 (도구 9 + 운영자 도구 4)
│       ├── admin.js        # 어드민 라우터 + 인증
│       ├── admin-ui.js     # 공용 헬퍼 (토스트·드로어·CSV)
│       └── admin-views.js  # 13개 뷰 렌더러 + 챗봇 도구 결과 카드
│
└── netlify/functions/
    ├── send-lead.js        # 리드 폼 → 이메일/Slack (스텁)
    ├── chat.js             # Gemini API 프록시 + 스마트 라우팅 + LRU 캐시 ⭐
    └── webhook.js          # 범용 웹훅
```

## 🔑 환경변수 (Netlify Site settings → Environment variables)

| 변수 | 설명 | 기본값 |
|---|---|---|
| `GEMINI_API_KEY` | **필수** — Google AI Studio 키 | — |
| `GEMINI_MODEL_FLASH` | 추론 모델 | `gemini-2.5-flash` |
| `GEMINI_MODEL_LITE` | 단순 응대 모델 | `gemini-3.1-flash-lite` |
| `GEMINI_PRICE_FLASH_IN` | input $/M tokens | `0.30` |
| `GEMINI_PRICE_FLASH_OUT` | output $/M tokens | `2.50` |
| `GEMINI_PRICE_LITE_IN` | input $/M tokens | `0.10` |
| `GEMINI_PRICE_LITE_OUT` | output $/M tokens | `0.40` |
| `GEMINI_MONTHLY_BUDGET_USD` | 월 한도 (정보 표시) | `50` |
| `RESEND_API_KEY` | (선택) 이메일 발송 | — |
| `EMAIL_TO` | (선택) 알림 수신 | `endy116@naver.com` |

설정 변경:
```bash
netlify env:set GEMINI_API_KEY "AIza..."
netlify deploy --prod --dir .
```

## 🤖 AI 챗봇 아키텍처

### 두 가지 모드
1. **고객 모드** (메인페이지): 폴백 우선 → Lite 우선 → Flash (복잡 키워드 시)
2. **운영자 모드** (어드민): Flash 항상 + 추가 데이터 컨텍스트 (chatLogs/leads/tasks)

### 13개 도구
**고객용 (9개)**:
- `create_lead` — 상담 신청 DB 등록 (가장 중요)
- `prefill_contact` — 폼 미리 채우기
- `navigate` — 섹션 스크롤
- `prefill_quote` — 견적 계산기 자동 입력
- `draft_quote` — 견적서 초안 (PM 검토 후 PDF 발행)
- `create_case_draft` — 케이스 비공개 추가
- `draft_blog_post` — 블로그 마크다운 초안
- `schedule_followup` — Follow-up 메일 예약
- `request_pm_callback` — PM 직접 통화 요청

**운영자용 (4개)**:
- `list_callback_requests` — 통화 요청 조회
- `mark_task_done` — 작업 완료 표시
- `summarize_chat` — 대화 요약
- `update_lead_stage` — 리드 단계 이동

### 동작 흐름
```
사용자 메시지 → chatbot.js send()
              ↓
1. 폴백 체크 (인사·감사 등) → 비용 0 응답
2. Rate limit 체크 (분당 12회, 세션 30턴, 도구 10회, 동일 도구 3회)
3. POST /api/chat → chat.js
              ↓
4. LRU 캐시 확인 (5분 TTL, 비운영자·첫 질문만) → hit이면 비용 0
5. selectModel() — 휴리스틱 라우팅 (Flash/Lite)
6. buildSystemPrompt() — 압축된 RAG 컨텍스트 (어드민이면 chatLogs/leads/tasks 동적 포함)
7. Gemini API 호출 (maxOutputTokens 보수적: Lite 250 / Flash 500 / Admin 600)
8. 응답에 cost_usd 포함
              ↓
9. chatbot.js — ```action``` 블록 파싱 → store CRUD 실행
10. store.usageLog에 누적 → 어드민 비용 카드에 자동 표시
```

## ✅ 적용된 비용 최적화 7개

| # | 항목 | 효과 |
|---|---|---|
| 1 | 스마트 모델 라우팅 (Flash/Lite) | -45% |
| 2 | 무한루프 5중 방지 (도구 10회·동일 3회·턴 30·분당 12·토큰 캡) | 사고 보호 |
| 3 | 휴리스틱 폴백 (인사·감사 등) | -20% (트래픽 의존) |
| 4 | **Top 4** 시스템 프롬프트 압축 (5,500 → 2,100 토큰) | -40% 입력 |
| 5 | 운영자 컨텍스트 동적 (키워드 매칭 시만 chatLogs/leads/tasks 포함) | 운영자 -50% |
| 6 | 대화 히스토리 12개 제한 | 긴 대화 -60% |
| 7 | **Top 7** 인메모리 LRU 응답 캐시 (5분 TTL) | -15-30% (반복 질문 시) |
| 8 | 출력 토큰 캡 강화 (Lite 250 / Flash 500 / Admin 600) | -40% 출력 |
| 9 | **Top 11** 일일 비용 추세 + 어뷰즈 감지 | 사고 조기 발견 |

**현재 예상 비용**: 월 1만 건 트래픽 시 **~$2~3 / 월** ($50 한도의 4~6%)

## 🔮 미적용 5개 (필요 시 적용 가능)

| # | 항목 | 트리거 시점 |
|---|---|---|
| Top 1 | Gemini Context Caching | corpus가 32K 토큰 넘을 때 (RAG 구축 후) |
| Top 8 | 진짜 벡터 RAG (Option A 권장) | 케이스 50건+ 또는 사업소개서 PDF 통합 |
| Top 9 | 응답 스트리밍 (Functions v2) | 사용자가 응답 속도 호소 |
| Top 10 | Cold start 회피 (Keepalive ping) | 챗봇 첫 호출 느림 피드백 |
| Top 12 | A/B 테스트 + 분석 대시보드 | 한 달 사용량 데이터 축적 후 |

각각의 구현 방법은 다음 세션에서 "Top X 적용해줘" 한 마디로 진행 가능.

## ⚙️ 자주 쓰는 명령어

```powershell
# 배포 (Netlify CLI)
cd "c:\Users\Administrator\Desktop\작업\dev\HamkkeWorkSi"
netlify deploy --prod --dir .

# Git 푸시 (Netlify에 GitHub 연결 안 했으면 deploy 따로 필요)
git add -A
git commit -m "..."
git push origin main

# 환경변수 설정
netlify env:set KEY "value"
netlify env:list

# 로컬 테스트
npx serve .

# 어드민 로그인 (데모)
# ID: endyd116@gmail.com
# PW: hamkke2026
# ⚠ 실서비스 전 반드시 교체
```

## ⚠️ 알려진 이슈 및 주의사항

1. **로고 파일 크기**: `assets/images/logo.jpg`가 1.5MB. 리사이즈 권장 (512x512로 줄이면 ~100KB).
2. **데모 인증**: 어드민 비밀번호가 코드에 하드코딩됨 (`assets/js/admin.js`). 실서비스 전 Netlify Identity로 교체.
3. **데이터 저장**: localStorage 기반 — 브라우저별 분리. 백업은 어드민 → 설정 → 백업 (JSON).
4. **GitHub 자동배포**: 현재 미설정. `git push` 후 `netlify deploy` 수동 실행 필요.
   - 설정 방법: https://app.netlify.com/projects/hamkkework-si/configuration/deploys → Continuous deployment → Link repository → GitHub
5. **`gemini-3.1-flash-lite` 모델명**: 실제 존재 여부 확인 필요. 안 되면 `gemini-2.5-flash-lite`로 fallback.
6. **무한루프 한도**: 세션당 10회 / 동일 도구 3회 / 분당 12회 / 30턴 — 운영 중 한도 초과 신호 보이면 LIMITS 조정.

## 🗂 백업 브랜치

- `backup/v5-pdf-content-attempt` — PDF v1.0 첫 시도 (롤백 전 상태). 필요 시 `git checkout backup/v5-pdf-content-attempt`로 복원.

## 🎯 다음 작업 후보 (우선순위 추정)

1. **GitHub 자동배포 연결** (1분, UI 클릭만) — 매번 `netlify deploy` 안 해도 됨
2. **로고 리사이즈** (이미지 도구 사용, 5분) — 페이지 로딩 속도 ↑
3. **이메일 발송 실연결** (Resend API 키 발급 + env 설정, 30분) — 리드 등록 시 박두용 PM에게 메일
4. **어드민 인증 교체** (Netlify Identity, 1시간) — 데모 비밀번호 제거
5. **Top 12 분석 대시보드** — 한 달 후 데이터 축적되면 의미 있음
6. **케이스 추가** (어드민 → 케이스 관리에서 직접) — 신규 프로젝트 완료 시
7. **블로그 글 작성** (어드민 → 블로그) — SEO 유입용

## 💬 새 세션 시작 가이드

새 Claude/Codex 세션을 열면:

1. 이 파일(`HANDOFF.md`)을 먼저 읽혀주세요:
   > "프로젝트 인수인계 파일을 읽어줘: c:\Users\Administrator\Desktop\작업\dev\HamkkeWorkSi\HANDOFF.md"

2. 그러면 새 세션이 즉시 컨텍스트 복원되어 작업 이어갈 수 있습니다.

3. 자주 쓰는 시작 프롬프트 예시:
   - "Top 10 (Cold start 회피) 적용해줘"
   - "케이스 관리에 새 프로젝트 추가하고 싶어"
   - "어드민 챗봇 새 도구 만들어줘 — ○○ 기능"
   - "비용이 갑자기 늘었어. 원인 분석해줘"

---

**마지막 업데이트**: 2026-05-13
**총 커밋**: 12개
**현재 코드 라인 수**: ~10,500줄 (HTML+CSS+JS)
**현재 시스템 프롬프트 토큰**: 비운영자 ~1,650 / 운영자 ~2,100
