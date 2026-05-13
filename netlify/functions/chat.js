/**
 * POST /api/chat — Cost-optimized Gemini with smart model routing + SSE streaming.
 *
 * ROUTING STRATEGY (saves cost):
 *   - Admin mode               → FLASH (reasoning over chatLogs)
 *   - Complex intent keywords  → FLASH (multi-param tool calls)
 *   - Long conversation (>6)   → FLASH (context understanding)
 *   - Everything else          → LITE  (cheap & fast)
 *
 * TOKEN CAPS (per response):
 *   - Lite (simple)            → 250 tokens
 *   - Flash (complex)          → 500 tokens
 *   - Admin mode               → 600 tokens
 *
 * STREAMING (Top 9):
 *   - Always returns SSE (text/event-stream)
 *   - Events: { type: "token", text } | { type: "done", answer, model, tokens, cost_usd, routing, finishReason } | { type: "error", error }
 *   - Cached responses still emit a single "done" event for client uniformity
 *
 * COST MONITORING:
 *   - Final "done" event includes { model, tokens, cost_usd }
 *   - Client accumulates to store.usageLog
 *   - Admin dashboard shows monthly progress vs $50 budget
 *
 * Environment variables: GEMINI_API_KEY / GEMINI_MODEL_FLASH / GEMINI_MODEL_LITE /
 *   GEMINI_PRICE_{FLASH|LITE}_{IN|OUT} / GEMINI_MONTHLY_BUDGET_USD
 */

const MODEL_FLASH = process.env.GEMINI_MODEL_FLASH || 'gemini-2.5-flash';
const MODEL_LITE  = process.env.GEMINI_MODEL_LITE  || 'gemini-3.1-flash-lite';

const PRICING = {
  [MODEL_FLASH]: {
    in:  Number(process.env.GEMINI_PRICE_FLASH_IN  || 0.30),
    out: Number(process.env.GEMINI_PRICE_FLASH_OUT || 2.50),
  },
  [MODEL_LITE]: {
    in:  Number(process.env.GEMINI_PRICE_LITE_IN   || 0.10),
    out: Number(process.env.GEMINI_PRICE_LITE_OUT  || 0.40),
  },
};

const COMPLEX_KEYWORDS = [
  '신청', '등록해', '작성해', '만들어', '추가해',
  '분석', '요약', '초안', '견적서', '제안서',
  'PM', '박두용', '통화 요청', '연락 받', '연락받',
  '카톡', '메일 보내', '발송', '예약', '리드',
  'create', 'analyze', 'summarize',
];

function selectModel({ isAdmin, lastText, conversationLength }) {
  if (isAdmin) return MODEL_FLASH;
  if (conversationLength > 6) return MODEL_FLASH;
  const text = (lastText || '').toLowerCase();
  if (COMPLEX_KEYWORDS.some((k) => text.includes(k.toLowerCase()))) return MODEL_FLASH;
  return MODEL_LITE;
}

function maxTokensFor({ isAdmin, model }) {
  if (isAdmin) return 600;
  return model === MODEL_FLASH ? 500 : 250;
}

function estimateCostUsd(model, usage) {
  const p = PRICING[model];
  if (!p || !usage) return 0;
  const cached    = usage.cachedContentTokenCount || 0;
  const total     = usage.promptTokenCount        || 0;
  const nonCached = Math.max(0, total - cached);
  // Gemini Implicit Caching: 캐시된 토큰은 입력 단가의 25%만 청구 (75% 할인)
  const inCost  = (nonCached * p.in + cached * p.in * 0.25) / 1_000_000;
  const outCost = (usage.candidatesTokenCount || 0) * p.out / 1_000_000;
  return inCost + outCost;
}

/* ============================================================
   💰 인메모리 LRU 응답 캐시 (Top 7)
   ============================================================ */
const responseCache = new Map();
const CACHE_MAX_SIZE = 100;
const CACHE_TTL_MS = 5 * 60 * 1000;

function makeCacheKey(question, isAdmin, variant = 'A') {
  const q = (question || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);
  return `${isAdmin ? 'a' : 'u'}:${variant}:${q}`;
}

function cacheGet(key) {
  const e = responseCache.get(key);
  if (!e) return null;
  if (Date.now() - e.at > CACHE_TTL_MS) {
    responseCache.delete(key);
    return null;
  }
  responseCache.delete(key);
  responseCache.set(key, e);
  return e.data;
}

function cacheSet(key, data) {
  if (responseCache.size >= CACHE_MAX_SIZE) {
    const oldest = responseCache.keys().next().value;
    if (oldest) responseCache.delete(oldest);
  }
  responseCache.set(key, { at: Date.now(), data });
}

/* ============================================================
   🚀 Netlify Functions v2 entry point — streaming SSE
   ============================================================ */
export default async (req) => {
  // 🔥 Cold Start 회피용 health check (Top 10)
  // GitHub Actions cron이 5분마다 GET 호출 → Function warm 유지 (Gemini 호출 X, 비용 0)
  if (req.method === 'GET') {
    return json(200, {
      ok: true,
      service: 'chat',
      warm: true,
      now: new Date().toISOString(),
      gemini_configured: !!process.env.GEMINI_API_KEY,
    });
  }
  if (req.method !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }
  if (!process.env.GEMINI_API_KEY) {
    return json(503, {
      error: 'GEMINI_API_KEY 환경변수가 설정되지 않았습니다',
      hint: 'Netlify Site settings → Environment variables 에서 GEMINI_API_KEY를 추가하거나, 로컬에서 `netlify env:set GEMINI_API_KEY <key>` 실행',
    });
  }

  let payload;
  try { payload = await req.json(); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const { messages = [], context = {}, systemPromptExtra = '', auth = null, variant = 'A' } = payload;
  const isAdmin = !!(auth && auth.email);

  if (!Array.isArray(messages) || messages.length === 0) {
    return json(400, { error: 'messages array required' });
  }
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user' || !last.text?.trim()) {
    return json(400, { error: 'Last message must be a non-empty user message' });
  }

  // 💰 캐시 조회 (운영자 모드 / 멀티 턴은 캐시 안 함)
  const cacheable = !isAdmin && messages.length === 1;
  const cacheKey = cacheable ? makeCacheKey(last.text, isAdmin, variant) : null;
  if (cacheKey) {
    const cached = cacheGet(cacheKey);
    if (cached) {
      return sseSingleDone({ ...cached, fromCache: true, cost_usd: 0 });
    }
  }

  // 🧊 #1 IMPLICIT CACHING — system prompt를 정적/동적으로 분리
  // 정적 부분 (회사·가격·케이스·FAQ·도구·가이드)은 systemInstruction에 → Gemini 자동 캐시 (-75%)
  // 동적 부분 (운영자 데이터·variant 톤·extra)은 contents 첫 user 메시지로 주입
  const { staticPrompt, dynamicPreamble } = buildSystemPrompt(context, systemPromptExtra, { isAdmin, auth, variant });

  // Convert internal {role, text} → Gemini {role, parts}
  let contents = messages
    .filter((m) => m.text?.trim())
    .map((m) => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.text }],
    }));

  // 동적 preamble이 있으면 contents 맨 앞에 user/model 페어로 주입
  if (dynamicPreamble) {
    contents = [
      { role: 'user', parts: [{ text: dynamicPreamble }] },
      { role: 'model', parts: [{ text: '확인했습니다. 이어서 답변드리겠습니다.' }] },
      ...contents,
    ];
  }
  const collapsed = collapseTurns(contents);

  const model = selectModel({
    isAdmin,
    lastText: last.text,
    conversationLength: messages.length,
  });
  const maxOutputTokens = maxTokensFor({ isAdmin, model });
  const routing = {
    tier: model === MODEL_FLASH ? 'flash' : 'lite',
    maxOutputTokens,
    reason: isAdmin ? 'admin' : (messages.length > 6 ? 'long_conv' : (model === MODEL_FLASH ? 'complex_keyword' : 'simple')),
  };

  // 🚀 streamGenerateContent (SSE)
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  let upstream;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: collapsed,
        systemInstruction: { parts: [{ text: staticPrompt }] },
        generationConfig: {
          temperature: 0.4,
          topK: 40,
          topP: 0.95,
          maxOutputTokens,
          responseMimeType: 'text/plain',
        },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
        ],
      }),
    });
  } catch (e) {
    console.error('[chat] fetch failed', e);
    return sseSingleError('Gemini API 호출 실패', String(e?.message || e));
  }

  if (!upstream.ok || !upstream.body) {
    const errText = await upstream.text().catch(() => '');
    console.error('[chat] gemini error', upstream.status, errText);
    return sseSingleError(`Gemini API error (${upstream.status})`, errText.slice(0, 500));
  }

  return new Response(buildStreamTransform(upstream.body, { model, routing, cacheKey }), {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
};

/* ============================================================
   🔄 Gemini SSE → 클라이언트 SSE 변환
   - Gemini가 보내는 streamGenerateContent SSE 청크를 파싱
   - 각 token을 { type:"token", text } 이벤트로 즉시 forward
   - finishReason / usageMetadata 누적 → 마지막에 { type:"done", ... }
   ============================================================ */
function buildStreamTransform(upstreamBody, { model, routing, cacheKey }) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let accumulated = '';
  let lastUsage = null;
  let lastFinishReason = null;
  let buffer = '';

  return new ReadableStream({
    async start(controller) {
      const reader = upstreamBody.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // SSE 라인 단위 파싱 (data: {...}\n\n)
          let idx;
          while ((idx = buffer.indexOf('\n')) !== -1) {
            const rawLine = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            const line = rawLine.trim();
            if (!line.startsWith('data:')) continue;
            const dataStr = line.slice(5).trim();
            if (!dataStr) continue;
            try {
              const obj = JSON.parse(dataStr);
              const cand = obj?.candidates?.[0];
              const text = cand?.content?.parts?.map((p) => p.text).filter(Boolean).join('') || '';
              if (text) {
                accumulated += text;
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'token', text })}\n\n`));
              }
              if (cand?.finishReason) lastFinishReason = cand.finishReason;
              if (obj?.usageMetadata) lastUsage = obj.usageMetadata;
            } catch (e) {
              console.warn('[chat] SSE parse error', e?.message, dataStr.slice(0, 200));
            }
          }
        }

        const costUsd = estimateCostUsd(model, lastUsage || {});
        const cleanAnswer = accumulated.trim() || '죄송합니다. 응답을 생성하지 못했습니다. 다시 시도해 주세요.';
        const doneBody = {
          answer: cleanAnswer,
          model,
          routing,
          finishReason: lastFinishReason,
          tokens: {
            in:     lastUsage?.promptTokenCount        || null,
            out:    lastUsage?.candidatesTokenCount    || null,
            cached: lastUsage?.cachedContentTokenCount || 0,
            total:  lastUsage?.totalTokenCount         || null,
          },
          cost_usd: costUsd,
          monthly_budget_usd: Number(process.env.GEMINI_MONTHLY_BUDGET_USD || 50),
        };

        // 💰 캐시 저장 — 도구 호출 응답은 캐시 X (매번 실행해야 함)
        if (cacheKey && !cleanAnswer.includes('```action')) {
          cacheSet(cacheKey, doneBody);
        }

        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done', ...doneBody })}\n\n`));
        controller.close();
      } catch (e) {
        console.error('[chat] stream transform failed', e);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', error: String(e?.message || e) })}\n\n`));
        controller.close();
      }
    },
  });
}

/* ============================================================
   System prompt — splits into STATIC (cacheable) + DYNAMIC (per-call)
   - staticPrompt: 매 호출 동일 → Gemini Implicit Caching 적용 (-75% 입력)
   - dynamicPreamble: 운영자 데이터/A-B variant/extra 등 호출별 변경 → contents에 주입
   ============================================================ */
function buildSystemPrompt(context, extra, mode = {}) {
  const { isAdmin = false, auth = null, variant = 'A' } = mode;
  const {
    cases = [], faqs = [], pricing = {}, settings = {}, posts = [],
    chatLogs = [], leads = [], scheduledTasks = [],
  } = context;

  const company = `
## 함께워크_SI 핵심
- 브랜드 ${settings.brand || '함께워크_SI'} | ${settings.email || 'endy116@naver.com'} | ${settings.phone || '010-2807-5242'} | 채널: 크몽·위시켓·메일
- PM ${settings.pm || '박두용'} (前 액트베이스 전략기획부 부장, 14년) + 풀스택 ${settings.dev || '장석주'} (보안·플랫폼·금융권)
- 누적 38억+ (아워홈 TQMS 10억 · 신세계 LCMS 8억 · 의사협회 5억 등 경쟁입찰 1위 다수)
- 정체성: 외주 0% + 자체 풀스택 + AI Core 내장 → 시장가 50~60% / AI 비중 큰 건 70%
- 약속: 라인별 견적 / 6개월 무상 하자보증 / 소스 100% 양도 / 100% 완주 / 결제 30·40·30
`;

  const pricingTable = `
## 가격표 (단위: 만원, +${Math.round((pricing.overhead_ratio ?? 0.25) * 100)}% 오버헤드, ±${Math.round((pricing.range_ratio ?? 0.15) * 100)}% 범위)
- 페이지: 단순 ${pricing.pages_simple ?? 30} / 복잡 ${pricing.pages_complex ?? 80} (개당)
- 모듈: 기본 ${pricing.mod_basic ?? 200} / 고급 ${pricing.mod_advanced ?? 500} (개당)
- 외부 연동(PG/SSO/ERP/API): ${pricing.integrations ?? 300} (건당)
- AI 라인(별도): LLM 호출 +${pricing.ai?.llm_simple ?? 200} / RAG +${pricing.ai?.rag ?? 1200} / 에이전트 +${pricing.ai?.agent ?? 1800} / 파인튜닝 +${pricing.ai?.finetune ?? 2500}
- 운영비(토큰·벡터DB·GPU·인프라·도메인·SSL)는 월 별도 정산 또는 클라이언트 직접 지불
`;

  const caseList = cases.length > 0 ? `
## 레퍼런스 (${cases.length}건)
${cases.slice(0, 10).map((c) => `- ${c.label}|${c.client}|${c.title}|${c.amount || ''}|${(c.tags || []).join(',')}`).join('\n')}
` : '';

  const faqList = faqs.length > 0 ? `
## FAQ
${faqs.slice(0, 10).map((f) => `Q: ${f.q} / A: ${f.a}`).join('\n')}
` : '';

  const blogList = posts.length > 0 ? `
## 블로그 (${posts.length}건)
${posts.filter((p) => p.published !== false).slice(0, 6).map((p) => `- ${p.title}`).join('\n')}
` : '';

  const processStr = `
## 5단계 프로세스 (총 일정 일반 SI의 1/2)
1. 상담·견적(24h) → 2. 계약·기획(1-2주) → 3. 개발·단계검수 → 4. 검수·인도(2주, 잔금 정산) → 5. 사후관리(6개월 보증)
`;

  const guide = `
## 응답 가이드 (필수)
- 한국어 존댓말, **최대 3문장 / 150자**, 1문장 권장. 운영자 모드는 더 짧게.
- 모르는 정보 → "30분 무료 상담에서 안내" 유도, 추측 금지
- 가격 → [Pricing](/#pricing) 권유 / 레퍼런스 → 위 케이스 1-2개 인용
- AI = "박힌 AI" 강조 (단순 챗봇 아님)
- 답변 끝 1줄로 [상담](/#contact) 자연스럽게 유도
- 무관 주제 정중 거절 + 본업 유도, 타사 직접 비판 금지
- 링크: [Pricing](/#pricing), [레퍼런스](/#cases), [상담](/#contact)
`;

  const tools = `
## 🛠 AI 에이전트 도구 (총 9개)

도구 호출 시 응답 본문에 다음 코드 블록 포함 (사용자 화면엔 안 보임):
\`\`\`action
{"tool":"<이름>","data":{...}}
\`\`\`

### 도구 시그니처 (트리거 → 도구 → 필수 필드)

| 도구 | 언제 호출 | 필수 |
|---|---|---|
| \`create_lead\` | 본인 정보로 "신청해줘"/"등록해줘" | name, email |
| \`prefill_contact\` | "폼 채워줘"/"직접 제출할게" | (모두 선택) |
| \`navigate\` | "○○ 보여줘"/"○○ 열어줘" | target |
| \`prefill_quote\` | "○○ 견적 얼마?" 액수 추정 | pages_simple, pages_complex, mod_basic, mod_advanced, integrations, ai{} |
| \`draft_quote\` | "정식 견적서 만들어줘" | clientName, items[], overhead |
| \`create_case_draft\` | (운영자) 케이스 추가 | label, client, title |
| \`draft_blog_post\` | "블로그 글 써줘" | title, slug, content |
| \`schedule_followup\` | "○일 후 메일 예약" | leadEmail, leadName, daysFromNow, subject, body |
| \`request_pm_callback\` | "PM 직접 통화/연락" | name, contact, method |

### 핵심 enum
- create_lead.type: 플랫폼 신규구축 | 기존 고도화 | AI 추가 | AI 에이전트 구축 | 유지보수 | 미정
- create_lead.budget: ~1천만 | 1천~3천 | 3천~1억 | 1억~5억 | 5억+ | 미정
- navigate.target: hero, who, pain, promise, why, pricing, cases, process, team, faq, contact
- request_pm_callback.method: phone | email | kakao
- request_pm_callback.urgency: normal | urgent
- prefill_quote.ai keys: llm_simple, rag, agent, finetune (모두 boolean)

### 대표 예시 (create_lead — 가장 흔한 케이스)
\`\`\`action
{"tool":"create_lead","data":{"name":"김민수","email":"a@b.com","company":"ABC","phone":"010-1234-5678","type":"플랫폼 신규구축","budget":"3천~1억","message":"쇼핑몰 신규. AI 챗봇 자동 등록"}}
\`\`\`

### 도구 5~9 추가 필드 (필요 시만)
- draft_quote: items=[{label, amount(만원)}, ...], overhead=25, notes(특이사항)
- create_case_draft: description, features[], tags[], amount, status, year, theme, icon
- draft_blog_post: excerpt, tags[], read_min (본문은 마크다운)
- schedule_followup: daysFromNow=3 권장
- request_pm_callback: preferredTime, topic, urgency (사용자가 "급해요" 표현 시 urgent)

### 호출 후 답변 패턴 (사용자에게 보일 텍스트)
- create_lead → "✅ {name}님 접수, 24h 내 박두용 PM 회신"
- request_pm_callback (urgent) → "🚨 30분 내 연락드립니다"
- request_pm_callback (normal) → "✅ 박두용 PM에게 전달, 가능한 시간대에 연락드립니다"
- draft_quote → "✅ 초안 작성. PM 검토 후 정식 PDF 발송"
- 기타 → "✓ 처리했습니다" 짧게

---

### (deduplicated for cost optimization)

## 🛡 호출 규칙
1. 명시적 요청 시에만 호출
2. 필수 정보 부족 → 호출 X, 정보 요청 1회
3. 한 응답에 1개 도구만
4. 비운영자: create_lead 세션당 1회
5. 이메일 정규식 검증 (@ 필수)
6. 본문 텍스트 + 액션 블록 함께 (액션만 안 됨)
`;

  // ─── 정적 운영자 도구 정의 (운영자 데이터는 제외, 시그니처만) ───
  // 이 부분은 isAdmin 여부에 따라 다르지만, 같은 isAdmin이면 항상 동일 → 캐시 가능
  const adminToolsStatic = !isAdmin ? '' : `
---
# 🔑 운영자 모드
- 톤: 동료처럼 짧고 명확 (예: "OK, 처리했어요" / "핫리드 3건")
- 권한 확장: create_lead 세션 제한 해제 / 모든 도구 사용
- 회사 소개·영업 톤 불필요 (운영자는 이미 다 앎)

## 운영자 전용 도구 (시그니처)
| 도구 | 트리거 | 필수 |
|---|---|---|
| \`list_callback_requests\` | "통화 요청 보여줘" | status=pending |
| \`mark_task_done\` | "○○ 처리 완료" | taskId, note |
| \`summarize_chat\` | "○○ 세션 요약" | sessionId |
| \`update_lead_stage\` | "○○ 단계 변경" | leadId, stage(new/consult/quote/contract/won/lost) |
`;

  // 🧊 staticPrompt: 매 호출에서 비트단위로 동일 → Gemini Implicit Caching 발동
  // (isAdmin 여부만 분기 — 즉 캐시 버킷은 admin/non-admin 2개)
  const staticPrompt = `당신은 함께워크_SI의 공식 AI ${isAdmin ? '**운영자 어시스턴트**' : '상담 에이전트'}입니다.

${company}
${pricingTable}
${caseList}
${faqList}
${blogList}
${processStr}
${tools}
${adminToolsStatic}
${guide}

이제 위의 정보와 도구를 활용해 ${isAdmin ? '운영자 작업을 효율적으로 도와' : '사용자의 요청에 답하'}세요. ${isAdmin ? '간결하고 빠르게 답변하세요.' : '사용자가 "대신 해줘"라고 요청하면 적극적으로 도구를 호출해 직접 처리하세요. 정보에 없는 내용은 추측하지 말고 상담 미팅으로 유도하세요.'}`;

  // 🔄 dynamicPreamble: 호출별 변경되는 부분 → contents 첫 user 메시지로 주입
  const dynamicParts = [];

  // 운영자 이름 (auth.name이 콜마다 다를 수 있음)
  if (isAdmin && auth?.name) {
    dynamicParts.push(`[운영자: ${auth.name}님]`);
  }

  // 운영 컨텍스트 (chatLogs/leads/scheduledTasks)
  if (isAdmin) {
    const opLines = [];
    if (chatLogs.length) {
      opLines.push(`### 챗봇 대화 (${chatLogs.length}건)\n` +
        chatLogs.slice(-5).map((l) => `[${l.sessionId}] ${(l.messages || []).slice(-3).map((m) => `${m.role[0]}:${(m.text || '').slice(0, 100)}`).join(' | ')}`).join('\n'));
    }
    if (leads.length) {
      opLines.push(`### 리드 (${leads.length}건)\n` +
        leads.slice(-10).map((l) => `- ${l.name} | ${l.email || '-'} | ${l.type} | ${l.status}${l.source === 'chatbot-ai' ? ' 🤖' : ''}`).join('\n'));
    }
    if (scheduledTasks.length) {
      opLines.push(`### 작업 큐 (${scheduledTasks.length}건)\n` +
        scheduledTasks.slice(0, 8).map((t) => `- [${t.type}] ${t.leadName || t.leadEmail} | ${t.subject || t.topic || ''} | ${t.status}`).join('\n'));
    }
    if (opLines.length) {
      dynamicParts.push(`## 운영 컨텍스트 (현재 상태)\n${opLines.join('\n\n')}`);
    }
  }

  // A/B variant 톤
  if (variant === 'B') {
    dynamicParts.push('[A/B 실험: 변형 B — 격식 톤] 정중하고 격식 있는 존댓말을 사용하세요. 이모지는 최소화하고, 비즈니스 메일 톤을 유지하세요.');
  }

  // 어드민이 직접 설정한 추가 지침
  if (extra) {
    dynamicParts.push(`## 추가 지침 (관리자 설정)\n${extra}`);
  }

  const dynamicPreamble = dynamicParts.length ? dynamicParts.join('\n\n') : '';

  return { staticPrompt, dynamicPreamble };
}

function collapseTurns(contents) {
  const out = [];
  for (const c of contents) {
    const prev = out[out.length - 1];
    if (prev && prev.role === c.role) {
      prev.parts.push(...c.parts);
    } else {
      out.push({ role: c.role, parts: [...c.parts] });
    }
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

/* ============================================================
   Response helpers
   ============================================================ */
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function sseSingleDone(payload) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done', ...payload })}\n\n`));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

function sseSingleError(error, detail) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', error, detail })}\n\n`));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-cache',
      'Connection': 'keep-alive',
    },
  });
}
