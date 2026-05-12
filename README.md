# 함께워크_SI — 풀스택 비즈니스 플랫폼

대기업 SI 검증 기획자 + 보안·플랫폼 풀스택 개발자가 운영하는 SI/AI 컨설팅 비즈니스를 위한 메인 웹사이트 + 어드민 + 클라이언트 포털 + 블로그.

**Netlify + GitHub** 워크플로우로 배포되는 빌드스텝 없는 정적 사이트. localStorage 기반 데모로 즉시 동작하며, Supabase/Firebase 등으로 백엔드를 교체할 수 있도록 추상화되어 있습니다.

---

## 📦 구성

| 페이지 | 경로 | 설명 |
|--------|------|------|
| **메인 랜딩** | `/` | 11섹션 + 자동투어 + 도트네비 + 다크모드 + AI 챗봇 위젯 |
| **어드민** | `/admin` | 리드·견적·케이스·블로그·KPI·자동화·설정 (10대 기능) |
| **클라이언트 포털** | `/portal` | 고객 로그인 → 진행 중 프로젝트의 마일스톤·주간보고·결제 확인 |
| **블로그** | `/blog` | SEO 유입용 인사이트 글. `?p=slug`로 상세 |

---

## 🎯 AI 판단 — 비즈니스 운영 10대 기능 (어드민에 모두 구현)

| # | 기능 | 어드민 경로 | 핵심 가치 |
|---|------|------------|---------|
| 1 | **리드 관리 (CRM 칸반)** | `/admin#leads` | 신규→상담→견적→계약→완료/실주 6단계 드래그앤드롭. 메인폼 자동 등록 |
| 2 | **견적 PDF 자동발행** | `/admin#quotes` | 라인별 분리 견적 → jsPDF로 회사 로고가 박힌 PDF 즉시 생성 |
| 3 | **케이스 관리 (CMS)** | `/admin#cases` | 케이스 CRUD + 공개/비공개 토글. 메인페이지 캐러셀에 즉시 반영 |
| 4 | **블로그 / 콘텐츠** | `/admin#blog` | 마크다운 에디터 + 실시간 프리뷰 + SEO 메타 + 발행 토글 |
| 5 | **AI 챗봇 설정** | `/admin#chatbot` | 인텐트(키워드→응답) 규칙 편집 + 대화 로그 확인 |
| 6 | **프로젝트 진행 + 포털** | `/admin#projects` | 마일스톤·주간보고 관리. 클라이언트 포털에 자동 동기화 |
| 7 | **결제 / 인보이스** | `/admin#invoices` | 선금 30 / 중도 40 / 잔금 30 단계별 청구, 미수금 추적 |
| 8 | **클라이언트 포털 계정** | `/admin#portal` | 고객 계정 발급 + 프로젝트 접근권한 |
| 9 | **KPI 분석 대시보드** | `/admin#kpi` | 전환율·매출 추세·채널 분석. Chart.js 시각화 + CSV/JSON 익스포트 |
| 10 | **자동화 룰** | `/admin#automation` | 트리거(리드 접수/견적 발송/연체 등) → 템플릿 자동 발송 |

---

## 🎨 메인페이지 인터랙션

- **상단 진행률 바** — 스크롤 위치 실시간 표시
- **우측 도트 네비게이션** — 클릭으로 섹션 이동 + 호버 시 라벨
- **Auto Tour 모드** — 좌하단 버튼 클릭 시 8초마다 자동 다음 섹션 이동 (사용자 스크롤 시 자동 해제)
- **다크모드 토글** — 시스템 설정 자동 감지 + 수동 전환 가능 (localStorage 저장)
- **히어로 타이핑 애니메이션** — 4개 헤드라인을 6.5초마다 페이드 로테이션
- **카운터 애니메이션** — 38억+, 50%, 1순위 등 IntersectionObserver로 카운트업
- **블롭 그라데이션 배경** — 16초 주기 슬로우 모핑
- **로고 마퀴** — 트러스트 스트립이 28초 주기로 무한 가로 스크롤 (호버 시 일시정지)
- **카드 3D 틸트** — 마우스 위치 따라 미세하게 회전
- **케이스 캐러셀** — 6.5초 자동 슬라이드 + 좌우 화살표 + 드래그 + 도트 인디케이터
- **FAQ 검색** — 키워드/태그 실시간 필터
- **AI 챗봇 위젯** — 우하단 펄스 링 + RAG-lite 응답 + 대화 로그 자동 저장
- **토스트 알림** — 폼 제출·견적 첨부·상태 변경 등 액션 피드백
- **모션 감속 환경설정** — `prefers-reduced-motion` 자동 감지

---

## 🗂 파일 구조

```
HamkkeWorkSi/
├── index.html              # 메인 랜딩 페이지
├── admin.html              # 어드민 SPA
├── portal.html             # 클라이언트 포털
├── blog.html               # 블로그 리스트 + 상세
├── netlify.toml            # Netlify 설정 + 리다이렉트
├── robots.txt
├── .gitignore
│
├── assets/
│   ├── css/
│   │   ├── tokens.css      # 디자인 토큰 (색·여백·radius·shadow·다크모드)
│   │   ├── main.css        # 메인페이지 스타일
│   │   ├── admin.css       # 어드민 스타일
│   │   └── animations.css  # 리빌·마퀴·블롭·틸트·펄스 등
│   ├── js/
│   │   ├── store.js        # 통합 데이터 스토어 (localStorage 어드민↔메인 공유)
│   │   ├── admin-ui.js     # 어드민 공용 헬퍼 (토스트·드로어·CSV)
│   │   ├── admin-views.js  # 어드민 13개 뷰 렌더러
│   │   ├── admin.js        # 어드민 라우터 + 인증
│   │   ├── animations.js   # 메인페이지 IntersectionObserver 모션
│   │   ├── calculator.js   # 견적 계산기
│   │   ├── chatbot.js      # AI 챗봇 위젯
│   │   └── main.js         # 메인페이지 오케스트레이션
│   └── data/
│       └── seed.json       # 초기 시드 (케이스/FAQ/블로그/가격표/챗봇 인텐트)
│
├── netlify/functions/
│   ├── send-lead.js        # 리드 폼 → 이메일/Slack
│   ├── chat.js             # AI 챗봇 백엔드 스텁 (Anthropic API 연결 가이드)
│   └── webhook.js          # 범용 웹훅 수신기
│
└── _legacy/
    └── index.original.html # 원본 백업
```

---

## 🚀 빠른 시작

### 1. 로컬에서 열기

```powershell
# 인덱스를 더블클릭하거나 정적 서버 실행
npx serve .
# → http://localhost:3000
```

### 2. Netlify + GitHub 배포

```bash
# 1) Git 초기화
git init
git add .
git commit -m "init: 함께워크_SI 풀스택"

# 2) GitHub 저장소 생성 후 push
git remote add origin https://github.com/[USER]/hamkkework-si.git
git branch -M main
git push -u origin main

# 3) Netlify에서 GitHub 저장소 연결
# - Site settings > Build & deploy
# - Branch: main
# - Build command: (비워둠)
# - Publish directory: .
```

3분 뒤 자동 배포됩니다. 이후 GitHub `main` push → 자동 재배포.

### 3. 어드민 로그인 (데모)

- URL: `https://your-site.netlify.app/admin`
- ID: `endyd116@gmail.com`
- PW: `hamkke2026`

**⚠ 실서비스 전 반드시 인증을 교체하세요.** 데모 코드는 `assets/js/admin.js` 상단 `DEMO_ACCOUNT`에 하드코딩되어 있습니다.

---

## 🔌 백엔드 / 외부 서비스 연결 가이드

현재 모든 데이터는 브라우저 `localStorage`에 저장됩니다. 실서비스 운영 시 권장 마이그레이션 경로:

### Option A. Supabase (최단 경로, 무료 시작)

```bash
# 1. 프로젝트 생성: https://supabase.com
# 2. 테이블 생성 (leads, quotes, cases, posts, projects, invoices, clients, automations)
# 3. assets/js/store.js 의 collection() 함수를 Supabase 클라이언트 호출로 교체
```

`store.js`의 `read()`/`write()` 함수만 교체하면 모든 뷰가 그대로 동작합니다.

### Option B. Netlify Identity + Functions + Postgres

- 인증: Netlify Identity (무료, JWT 자동 발급)
- DB: Neon/Supabase Postgres
- 비즈니스 로직: `netlify/functions/*.js`

### 이메일 발송 (`send-lead.js`)

- **Resend** (https://resend.com) — 월 3,000건 무료, API 1줄
- **SendGrid** — 월 100건/일 무료
- **AWS SES** — 가장 저렴

`netlify/functions/send-lead.js` 상단의 주석에 통합 코드 템플릿이 포함되어 있습니다. 환경변수만 설정하면 즉시 동작:

```
RESEND_API_KEY=...
EMAIL_TO=endyd116@gmail.com
SLACK_WEBHOOK_URL=https://hooks.slack.com/...  (선택)
```

### AI 챗봇 → 진짜 RAG (`chat.js`)

```bash
# 환경변수
ANTHROPIC_API_KEY=sk-ant-...

# 그리고 Supabase pgvector 또는 Pinecone에
# - 사업소개서 텍스트
# - 케이스 설명
# - 가격표
# - FAQ
# 를 임베딩해 저장. 질문 들어오면 top-5 검색 + Claude로 응답 생성.
```

`chat.js` 하단에 Anthropic SDK 호출 스캐폴드가 포함되어 있습니다.

---

## 🎨 디자인 토큰 요약

```css
Cobalt        #0866FF  → 핵심 액센트
Cobalt Deep   #0143B5  → 강조 텍스트
Cobalt Soft   #E5F0FE  → Takeaway 배너 배경
Ink Deep      #0A1317  → 본문 진한 텍스트
Slate         #4B5563  → 카드 본문
Critical      #E41E3F  → Industry Pain 섹션 스탯
```

타이포그래피: **Pretendard 9 weights**.
사이즈: Hero 64 / Section 44 / KPI 28 / Body 14.

`assets/css/tokens.css`에서 한 곳에서 관리됩니다.

---

## 📊 어드민 사용 시나리오

### 1. 새 리드가 들어오면
- 메인페이지 폼 제출 → 어드민 `/admin#leads`에 자동으로 카드 추가
- 신규 → 상담 → 견적 → 계약 단계를 드래그로 이동
- 카드 클릭하면 상세·메모·견적 첨부 확인

### 2. 견적 발행
- `/admin#quotes` → [+ 새 견적 작성]
- 항목별 라인 추가 → 오버헤드 % 입력 → 총액 자동 계산
- [PDF] 버튼으로 회사 로고 박힌 견적서 즉시 다운로드

### 3. 프로젝트 시작
- `/admin#projects` → [+ 프로젝트 추가] → 마일스톤 등록
- `/admin#portal` → [+ 계정 생성] → 클라이언트 이메일·비밀번호 발급
- 클라이언트는 `/portal` 로그인해 진행상황 직접 확인

### 4. 콘텐츠 운영
- `/admin#blog` → 마크다운으로 글 작성 → [공개 토글] ON
- 메인페이지 상단 [인사이트] 메뉴에서 즉시 노출

### 5. 백업
- `/admin#settings` → [전체 백업 (JSON)]
- 정기적으로 다운로드해 두면 데이터 손실 방지

---

## 🔧 커스터마이즈 가이드

| 작업 | 위치 |
|------|------|
| 단가 변경 | 어드민 → 설정 → 가격표 (즉시 메인 반영) |
| 케이스 추가 | 어드민 → 케이스 관리 |
| FAQ 추가 | 어드민 → FAQ 편집 |
| 색·여백 | `assets/css/tokens.css` |
| 회사 정보 | 어드민 → 설정 → 브랜드 |
| 챗봇 응답 | 어드민 → AI 챗봇 설정 |

---

## ⚠️ 보안 체크리스트 (실서비스 배포 전)

- [ ] 어드민 비밀번호를 환경변수/Identity 인증으로 교체
- [ ] `/admin`, `/portal` 경로에 Netlify Identity 또는 Basic Auth 추가
- [ ] CORS / CSRF 검토
- [ ] 이메일/슬랙 환경변수 설정 (`RESEND_API_KEY` 등)
- [ ] 로그인 BFA 방어 (rate limit)
- [ ] 개인정보 처리방침 + 쿠키 동의 배너 (한국 PIPA)

---

## 📞 연락

- PM 박단용 — endyd116@gmail.com / 010-2807-5242
- 풀스택 장영주

2026 © 함께워크_SI
