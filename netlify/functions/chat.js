/**
 * POST /api/chat — Cost-optimized Gemini with smart model routing + SSE streaming
 *                  + Native Function Calling (Agent Loop)
 *
 * ROUTING STRATEGY (saves cost):
 *   - Admin mode               → FLASH (reasoning + tools)
 *   - Complex intent keywords  → FLASH (multi-param tool calls)
 *   - Long conversation (>6)   → FLASH (context understanding)
 *   - Everything else          → LITE  (cheap & fast, no tools)
 *
 * TOOLS (server-side execution via _lib/tools.js):
 *   - When Flash is selected, tools catalog is attached to Gemini request
 *   - Gemini may emit functionCall → server executes → result fed back → Gemini generates final response
 *   - Max 5 agent iterations per turn
 *
 * STREAMING:
 *   - SSE events: token | tool_call | tool_result | done | error
 *
 * Environment variables: GEMINI_API_KEY / GEMINI_MODEL_FLASH / GEMINI_MODEL_LITE /
 *   GEMINI_PRICE_{FLASH|LITE}_{IN|OUT} / GEMINI_MONTHLY_BUDGET_USD
 */

import { getToolDeclarations, executeServerTool, getToolSummary } from './_lib/tools.js';

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

  // 🛠 Function Calling — Flash로 라우팅된 경우만 도구 첨부 (Lite는 FC 미지원 가능성)
  const tools = (model === MODEL_FLASH)
    ? [{ functionDeclarations: getToolDeclarations({ isAdmin }) }]
    : undefined;

  // 🤖 Agent Loop으로 스트림 반환 (functionCall 발생 시 자동 실행 + 재호출)
  return new Response(
    runAgentStream({
      initialContents: collapsed,
      systemInstruction: { parts: [{ text: staticPrompt }] },
      tools,
      model,
      maxOutputTokens,
      routing,
      cacheKey,
      isAdmin,
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    }
  );
};

/* ============================================================
   🤖 Agent Loop — Gemini Function Calling 사이클
   - Gemini가 functionCall을 반환하면 서버에서 실행 → 결과 다시 보내고 응답 받음
   - 최대 5회 반복 (안전장치)
   - text는 즉시 클라이언트로 스트림, tool_call/tool_result는 별도 SSE 이벤트
   ============================================================ */
const AGENT_MAX_ITERATIONS = 5;

function sseEnqueue(controller, type, data) {
  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, ...data })}\n\n`));
}

async function callGemini({ model, contents, systemInstruction, tools, maxOutputTokens }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': process.env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      contents,
      systemInstruction,
      ...(tools ? { tools, toolConfig: { functionCallingConfig: { mode: 'AUTO' } } } : {}),
      generationConfig: {
        temperature: 0.4,
        topK: 40,
        topP: 0.95,
        maxOutputTokens,
        ...(tools ? {} : { responseMimeType: 'text/plain' }),
      },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
      ],
    }),
  });
}

/** Upstream Gemini SSE 스트림을 파싱하면서 text는 즉시 controller로 전달, functionCalls는 모음 */
async function pipeGeminiStream(upstreamBody, controller) {
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const textParts = [];
  const functionCalls = [];
  let usage = null;
  let finishReason = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
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
        for (const part of cand?.content?.parts || []) {
          if (part.text) {
            textParts.push(part.text);
            sseEnqueue(controller, 'token', { text: part.text });
          } else if (part.functionCall) {
            functionCalls.push(part.functionCall);
          }
        }
        if (cand?.finishReason) finishReason = cand.finishReason;
        if (obj?.usageMetadata) usage = obj.usageMetadata;
      } catch (e) {
        console.warn('[chat] SSE parse', e?.message);
      }
    }
  }
  return { textParts, functionCalls, usage, finishReason };
}

function summarizeToolResult(result) {
  if (!result || typeof result !== 'object') return '';
  if (result.error) return `❌ ${result.error}`;
  if (typeof result.total === 'number' && typeof result.returned === 'number') return `${result.returned}/${result.total}건`;
  if (result.found === true) return '1건 찾음';
  if (result.found === false) return '찾지 못함';
  if (result.ok) return 'OK';
  return '완료';
}

function runAgentStream({ initialContents, systemInstruction, tools, model, maxOutputTokens, routing, cacheKey, isAdmin }) {
  let contents = initialContents;
  const allTextParts = [];
  const allToolCalls = [];
  const totalUsage = { in: 0, out: 0, cached: 0 };
  let lastFinishReason = null;

  return new ReadableStream({
    async start(controller) {
      try {
        for (let iter = 0; iter < AGENT_MAX_ITERATIONS; iter++) {
          let upstream;
          try {
            upstream = await callGemini({ model, contents, systemInstruction, tools, maxOutputTokens });
          } catch (e) {
            sseEnqueue(controller, 'error', { error: 'Gemini API 호출 실패', detail: String(e?.message || e) });
            controller.close();
            return;
          }
          if (!upstream.ok || !upstream.body) {
            const errText = await upstream.text().catch(() => '');
            sseEnqueue(controller, 'error', { error: `Gemini API error (${upstream.status})`, detail: errText.slice(0, 500) });
            controller.close();
            return;
          }

          const { textParts, functionCalls, usage, finishReason } = await pipeGeminiStream(upstream.body, controller);
          allTextParts.push(...textParts);
          if (usage) {
            totalUsage.in     += usage.promptTokenCount        || 0;
            totalUsage.out    += usage.candidatesTokenCount    || 0;
            totalUsage.cached += usage.cachedContentTokenCount || 0;
          }
          if (finishReason) lastFinishReason = finishReason;

          // function call 없음 → 응답 완료
          if (functionCalls.length === 0) {
            const accumulated = allTextParts.join('').trim() || '죄송합니다. 응답을 생성하지 못했습니다.';
            const costUsd = estimateCostUsd(model, {
              promptTokenCount: totalUsage.in,
              candidatesTokenCount: totalUsage.out,
              cachedContentTokenCount: totalUsage.cached,
            });
            const doneBody = {
              answer: accumulated,
              model,
              routing: { ...routing, iterations: iter + 1, toolCallCount: allToolCalls.length },
              finishReason: lastFinishReason,
              tokens: {
                in:     totalUsage.in     || null,
                out:    totalUsage.out    || null,
                cached: totalUsage.cached || 0,
                total:  totalUsage.in + totalUsage.out || null,
              },
              cost_usd: costUsd,
              tool_calls: allToolCalls,
              monthly_budget_usd: Number(process.env.GEMINI_MONTHLY_BUDGET_USD || 50),
            };
            // 도구 호출이 있었던 응답은 캐시 X (다음에도 도구 실행 필요)
            if (cacheKey && allToolCalls.length === 0 && !accumulated.includes('```action')) {
              cacheSet(cacheKey, doneBody);
            }
            sseEnqueue(controller, 'done', doneBody);
            controller.close();
            return;
          }

          // 도구 실행 (병렬)
          const callResults = await Promise.all(functionCalls.map(async (call) => {
            sseEnqueue(controller, 'tool_call', { name: call.name, args: call.args });
            allToolCalls.push({ name: call.name, args: call.args, iteration: iter + 1 });
            const result = await executeServerTool(call.name, call.args, { isAdmin });
            sseEnqueue(controller, 'tool_result', { name: call.name, summary: summarizeToolResult(result) });
            return { call, result };
          }));

          // 다음 contents 구성: 이전 model turn (text + functionCall) + user turn (functionResponse[])
          contents = [
            ...contents,
            {
              role: 'model',
              parts: [
                ...textParts.map((t) => ({ text: t })),
                ...functionCalls.map((c) => ({ functionCall: c })),
              ],
            },
            {
              role: 'user',
              parts: callResults.map(({ call, result }) => ({
                functionResponse: { name: call.name, response: result },
              })),
            },
          ];
        }

        sseEnqueue(controller, 'error', { error: 'Agent loop max iterations reached', iterations: AGENT_MAX_ITERATIONS });
        controller.close();
      } catch (e) {
        console.error('[agent]', e);
        sseEnqueue(controller, 'error', { error: String(e?.message || e) });
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

  // ─── 운영자 모드 안내 (도구 시그니처는 Gemini의 tools 필드로 별도 전달, 여기엔 사용 지침만) ───
  const adminToolsStatic = !isAdmin ? '' : `
---
# 🔑 운영자 모드
- 톤: 동료처럼 짧고 명확 (예: "OK, 처리했어요" / "핫리드 3건")
- 권한 확장: 모든 Function Calling 도구 사용 / 모든 액션 도구(create_lead 등) 사용
- 회사 소개·영업 톤 불필요 (운영자는 이미 다 앎)

## ⚙️ 도구 사용 규칙 (운영자가 데이터 질문 시)
- "○○ 누구야" / "○○ 정보" → \`leads_find\` 호출
- "이번주/오늘 신규 리드" / "○○ 단계 리드 목록" → \`leads_list\` 호출
- "○○ 단계 won/lost로 바꿔" → \`leads_update\` 호출
- "리드 통계" / "이번달 몇 건" → \`leads_stats\` 호출
- "통화 요청 보여줘" / "발송 가능 follow-up" → \`tasks_list\` 호출
- "○○ 작업 처리완료/취소" → \`tasks_update\` 호출
- "○○ 키워드 대화 검색" → \`chatlogs_search\` 호출
- "○○ 세션 요약/내용" → \`chatlogs_get\` 호출
- "케이스 목록" → \`cases_list\` 호출
- "견적서 목록" → \`quotes_list\` 호출
- **절대 데이터를 추측하지 말 것**. 데이터 질문은 무조건 도구 호출.
- 도구 결과를 받으면 자연어로 요약·정리해서 답변. 원본 JSON 노출 금지.
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
  // 🛠 운영 데이터(chatLogs/leads/scheduledTasks)는 더 이상 dump하지 않음 — AI가 도구 호출로 직접 조회
  const dynamicParts = [];

  // 운영자 이름 (auth.name이 콜마다 다를 수 있음)
  if (isAdmin && auth?.name) {
    dynamicParts.push(`[운영자: ${auth.name}님 (${auth.email})]`);
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
