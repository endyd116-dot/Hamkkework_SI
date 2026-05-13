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
 * Environment variables: GEMINI_API_KEY / GEMINI_CHAIN_HIGH / GEMINI_CHAIN_LOW /
 *   GEMINI_PRICE_{FLASH|LITE}_{IN|OUT} / GEMINI_MONTHLY_BUDGET_USD
 */

import { getToolDeclarations, executeServerTool, getToolSummary, readChatConfigForServer } from './_lib/tools.js';

/* ============================================================
   모델 체인 — 사용자 정의 폴백 순서
   - HIGH: 어려운 질문(견적/도구/긴 대화/운영자)용 고출력 체인
   - LOW:  단순 안내용 저출력 체인
   - 각 체인 첫 모델로 시도 → 5xx/429면 다음 모델로 자동 폴백
   ============================================================ */
const MODEL_CHAIN_HIGH = (process.env.GEMINI_CHAIN_HIGH ||
  'gemini-3-flash-preview,gemini-3.1-flash-lite,gemini-2.5-flash,gemini-2.5-flash-lite'
).split(',').map((s) => s.trim()).filter(Boolean);

const MODEL_CHAIN_LOW = (process.env.GEMINI_CHAIN_LOW ||
  'gemini-3.1-flash-lite,gemini-2.5-flash-lite'
).split(',').map((s) => s.trim()).filter(Boolean);

// 모델별 단가 (USD per 1M tokens) — 미공개 모델은 env로 override 가능
const PRICING = {
  'gemini-3-flash-preview':   { in: Number(process.env.GEMINI_PRICE_3FLASH_IN   || 0.30), out: Number(process.env.GEMINI_PRICE_3FLASH_OUT   || 2.50) },
  'gemini-3.1-flash-lite':    { in: Number(process.env.GEMINI_PRICE_31LITE_IN   || 0.10), out: Number(process.env.GEMINI_PRICE_31LITE_OUT   || 0.40) },
  'gemini-2.5-flash':         { in: Number(process.env.GEMINI_PRICE_25FLASH_IN  || 0.30), out: Number(process.env.GEMINI_PRICE_25FLASH_OUT  || 2.50) },
  'gemini-2.5-flash-lite':    { in: Number(process.env.GEMINI_PRICE_25LITE_IN   || 0.10), out: Number(process.env.GEMINI_PRICE_25LITE_OUT   || 0.40) },
};

const COMPLEX_KEYWORDS = [
  '신청', '등록해', '작성해', '만들어', '추가해',
  '분석', '요약', '초안', '견적서', '제안서',
  'PM', '박두용', '통화 요청', '연락 받', '연락받',
  '카톡', '메일 보내', '발송', '예약', '리드',
  '견적', '얼마', '비용', '예산', '얼만큼', '얼마나',
  'create', 'analyze', 'summarize',
];

const QUOTE_KEYWORDS = ['견적', '얼마', '예산', '얼만큼', '비용'];

// 1초 내 즉시 판단 — 어려운 질문이면 HIGH 체인, 단순 안내면 LOW 체인
function selectChain({ isAdmin, lastText, conversationLength }) {
  if (isAdmin) return { chain: MODEL_CHAIN_HIGH, level: 'high', reason: 'admin' };
  if (conversationLength > 6) return { chain: MODEL_CHAIN_HIGH, level: 'high', reason: 'long_conv' };
  const text = (lastText || '').toLowerCase();
  if (COMPLEX_KEYWORDS.some((k) => text.includes(k.toLowerCase()))) {
    return { chain: MODEL_CHAIN_HIGH, level: 'high', reason: 'complex_keyword' };
  }
  return { chain: MODEL_CHAIN_LOW, level: 'low', reason: 'simple' };
}

function maxTokensFor({ isAdmin, level, lastText }) {
  if (isAdmin) return 1000;
  // 견적 요청은 라인별 계산이 잘리지 않도록 상향
  const isQuote = QUOTE_KEYWORDS.some((k) => (lastText || '').includes(k));
  if (isQuote) return 800;
  return level === 'high' ? 600 : 350;
}

function estimateCostUsd(model, usage) {
  const p = PRICING[model] || PRICING['gemini-2.5-flash-lite']; // 미등록 모델은 lite 단가로 추정
  if (!usage) return 0;
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

  // 🔄 어드민이 update_bot_instruction으로 변경한 botRules는 Blobs에 있음.
  // 클라 polling이 30초 걸리므로 서버에서 직접 읽어 즉시 반영.
  // 우선순위: 서버 botRules → 서버 systemPromptExtra(legacy) → 클라 systemPromptExtra
  let effectiveExtra = systemPromptExtra || '';
  try {
    const serverCfg = await readChatConfigForServer();
    if (Array.isArray(serverCfg?.botRules) && serverCfg.botRules.length > 0) {
      effectiveExtra = serverCfg.botRules.map((r) => `- ${r.text}`).join('\n');
    } else if (typeof serverCfg?.systemPromptExtra === 'string') {
      effectiveExtra = serverCfg.systemPromptExtra;
    }
  } catch (e) {
    console.warn('[chat] chatConfig 서버 조회 실패, 클라 값 사용:', e?.message);
  }

  // 🧊 #1 IMPLICIT CACHING — system prompt를 정적/동적으로 분리
  // 정적 부분 (회사·가격·케이스·FAQ·도구·가이드)은 systemInstruction에 → Gemini 자동 캐시 (-75%)
  // 동적 부분 (운영자 데이터·variant 톤·extra)은 contents 첫 user 메시지로 주입
  const { staticPrompt, dynamicPreamble } = buildSystemPrompt(context, effectiveExtra, { isAdmin, auth, variant });

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

  const { chain, level, reason } = selectChain({
    isAdmin,
    lastText: last.text,
    conversationLength: messages.length,
  });
  const model = chain[0]; // 체인의 1차 모델 — 실패 시 callGeminiWithChain이 다음으로 폴백
  const maxOutputTokens = maxTokensFor({ isAdmin, level, lastText: last.text });
  const routing = {
    tier: level,
    chain,
    maxOutputTokens,
    reason,
  };

  // 🛠 Function Calling — HIGH 체인(어려운 질문)에만 도구 첨부 (LOW는 단순 안내라 도구 불필요)
  const tools = (level === 'high')
    ? [{ functionDeclarations: getToolDeclarations({ isAdmin }) }]
    : undefined;

  // 🤖 Agent Loop으로 스트림 반환 (functionCall 발생 시 자동 실행 + 재호출)
  return new Response(
    runAgentStream({
      initialContents: collapsed,
      systemInstruction: { parts: [{ text: staticPrompt }] },
      tools,
      model,
      chain,
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
   - Iter 1: full systemInstruction(2.1K) + tools(~300)        → AI가 도구 선택
   - Iter 2+: SUMMARIZER_INSTRUCTION (~50 tokens), tools 없음   → AI가 결과 요약만
   - text는 즉시 클라이언트로 스트림, tool_call/tool_result는 별도 SSE 이벤트
   ============================================================ */
// 🛡 Agent loop 한도 — Pro 플랜 함수 타임아웃(26초) 안에 들어와야 함
// Iter 0(도구 호출) + 도구 실행 + Iter 1(요약 답변)이 일반 흐름. 안전 마진으로 3까지만 허용.
const AGENT_MAX_ITERATIONS = 3;
// 18초 넘기면 다음 iter 진입 차단(강제 종료) — 26초 한도 - 8초(클라이언트 fetch 안전마진)
const AGENT_BUDGET_MS = 18_000;

// 🪶 Iter 2+ 전용 경량 요약 프롬프트 — 시스템 프롬프트 2,100 → 60 토큰으로 축소
const SUMMARIZER_INSTRUCTION = `You are 함께워크_SI assistant. Summarize the tool result above for the user in concise Korean (존댓말, max 3 sentences, highlight key numbers/names). Do NOT call any more tools. If admin user, use peer tone; if customer, use friendly polite tone.`;

function sseEnqueue(controller, type, data) {
  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, ...data })}\n\n`));
}

// 🛡 일시적 upstream 장애 (503/429/5xx) 흡수 — 체인 순서대로 모델 폴백
// 첫 모델 실패 → 200ms backoff → 다음 모델 시도 → 반복
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRY_BACKOFF_MS = 200;

async function callGeminiWithChain(args, chain) {
  if (!Array.isArray(chain) || !chain.length) {
    // 체인 비어있으면 단발 호출
    const resp = await callGemini(args);
    return { response: resp, usedModel: args.model, attemptedModels: [args.model], degraded: false };
  }

  const attempted = [];
  let lastResp = null;
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    attempted.push(model);
    if (i > 0) await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));

    let resp;
    try {
      resp = await callGemini({ ...args, model });
    } catch (e) {
      console.warn(`[gemini-chain] ${model} threw: ${e?.message}`);
      lastResp = null;
      continue; // 네트워크 에러도 다음 모델로
    }

    if (resp.ok) {
      return { response: resp, usedModel: model, attemptedModels: attempted, degraded: i > 0 };
    }
    // 재시도 가능한 상태면 다음 모델로, 아니면 즉시 반환 (4xx 등은 다음 모델도 동일 결과)
    if (!RETRYABLE_STATUSES.has(resp.status)) {
      console.warn(`[gemini-chain] ${model} ${resp.status} non-retryable, stopping chain`);
      return { response: resp, usedModel: model, attemptedModels: attempted, degraded: i > 0 };
    }
    try { await resp.text(); } catch {}
    console.warn(`[gemini-chain] ${model} ${resp.status} → 다음 모델로`);
    lastResp = resp;
  }
  // 체인 모두 실패 — 마지막 응답 반환
  return { response: lastResp, usedModel: attempted[attempted.length - 1], attemptedModels: attempted, degraded: true };
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
        // Gemini 2.5 Flash thinking 모드를 끔 — 견적/일반 답변에서 reasoning 토큰이 maxOutputTokens를 잡아먹는 문제 방지
        thinkingConfig: { thinkingBudget: 0 },
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

/** Upstream Gemini SSE 스트림을 파싱.
 *  - text는 즉시 controller로 전달
 *  - functionCall part는 thoughtSignature 등 메타 포함해서 part 전체를 보관 (Gemini 3.x 요구사항)
 *  - 다음 turn에 model role parts로 그대로 echo back해야 400 방지됨
 */
async function pipeGeminiStream(upstreamBody, controller) {
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const textParts = [];
  const modelParts = []; // 다음 turn에 echo back할 model parts (text/functionCall/thoughtSignature 보존)
  const functionCalls = []; // 도구 실행용 (편의)
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
            modelParts.push(part); // text part도 part 그대로 보존
          } else if (part.functionCall) {
            functionCalls.push(part.functionCall);
            modelParts.push(part); // thoughtSignature 등 메타 포함된 part 전체 보존
          } else {
            // thought 등 기타 part도 echo back (alone thoughtSignature part가 별도로 오는 케이스 대비)
            modelParts.push(part);
          }
        }
        if (cand?.finishReason) finishReason = cand.finishReason;
        if (obj?.usageMetadata) usage = obj.usageMetadata;
      } catch (e) {
        console.warn('[chat] SSE parse', e?.message);
      }
    }
  }
  return { textParts, modelParts, functionCalls, usage, finishReason };
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

function runAgentStream({ initialContents, systemInstruction, tools, model, chain, maxOutputTokens, routing, cacheKey, isAdmin }) {
  let contents = initialContents;
  const allTextParts = [];
  const allToolCalls = [];
  const totalUsage = { in: 0, out: 0, cached: 0 };
  let lastFinishReason = null;
  const startedAt = Date.now();
  let activeModel = model;
  let degradedFromChain = false;
  const attemptedModels = new Set();

  return new ReadableStream({
    async start(controller) {
      try {
        for (let iter = 0; iter < AGENT_MAX_ITERATIONS; iter++) {
          const elapsed = Date.now() - startedAt;
          // ⏱ 시간 가드: 다음 iter 진입 전 시간 예산 초과면 도구 끄고 즉시 답변만 받음
          const timeExceeded = iter > 0 && elapsed > AGENT_BUDGET_MS;
          // 🪶 옵션 3: Iter 1은 full system + tools, Iter 2+는 경량 요약 프롬프트(60 토큰) + tools 없음
          // → Iter 2+의 입력에서 (시스템 2,100 + 도구 ~300) - 60 = ~2,300 토큰 절감
          const isFirstIter = iter === 0;
          const iterSystem = isFirstIter
            ? systemInstruction
            : { parts: [{ text: SUMMARIZER_INSTRUCTION }] };
          const iterTools = isFirstIter ? tools : undefined;
          console.log(`[agent] iter=${iter} elapsed=${elapsed}ms tools=${iterTools ? 'yes' : 'no'}${timeExceeded ? ' timeExceeded' : ''}`);
          if (timeExceeded) {
            sseEnqueue(controller, 'tool_result', { name: '_timeout_guard', summary: `시간 가드 발동(${elapsed}ms) — 누적 결과로 답변 생성` });
          }

          let upstream;
          try {
            // Iter 2+에선 첫 모델만 사용 (이미 도구 결과 받았으니 빨리 마무리)
            // Iter 0(도구 호출)에선 전체 체인 폴백 활성
            const iterChain = isFirstIter ? chain : [activeModel];
            const wrapped = await callGeminiWithChain(
              { contents, systemInstruction: iterSystem, tools: iterTools, maxOutputTokens },
              iterChain
            );
            upstream = wrapped.response;
            wrapped.attemptedModels?.forEach((m) => attemptedModels.add(m));
            if (wrapped.degraded && wrapped.usedModel !== model && !degradedFromChain) {
              degradedFromChain = true;
              sseEnqueue(controller, 'tool_result', { name: '_model_fallback', summary: `${model} 실패 → ${wrapped.usedModel}로 폴백` });
            }
            activeModel = wrapped.usedModel || activeModel;
          } catch (e) {
            sseEnqueue(controller, 'error', { error: 'Gemini API 호출 실패', detail: String(e?.message || e) });
            controller.close();
            return;
          }
          if (!upstream) {
            sseEnqueue(controller, 'error', { error: '모델 체인 전체 실패', detail: `attempted: ${[...attemptedModels].join(', ')}` });
            controller.close();
            return;
          }
          if (!upstream.ok || !upstream.body) {
            const errText = await upstream.text().catch(() => '');
            sseEnqueue(controller, 'error', { error: `Gemini API error (${upstream.status})`, detail: errText.slice(0, 500) });
            controller.close();
            return;
          }

          const { textParts, modelParts, functionCalls, usage, finishReason } = await pipeGeminiStream(upstream.body, controller);
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
            const costUsd = estimateCostUsd(activeModel, {
              promptTokenCount: totalUsage.in,
              candidatesTokenCount: totalUsage.out,
              cachedContentTokenCount: totalUsage.cached,
            });
            const doneBody = {
              answer: accumulated,
              model: activeModel,
              routing: {
                ...routing,
                iterations: iter + 1,
                toolCallCount: allToolCalls.length,
                degraded: degradedFromChain || undefined,
                attemptedModels: attemptedModels.size > 1 ? [...attemptedModels] : undefined,
              },
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

          // 도구 실행 (병렬, 각 도구 5초 타임아웃)
          const TOOL_TIMEOUT_MS = 5_000;
          const callResults = await Promise.all(functionCalls.map(async (call) => {
            sseEnqueue(controller, 'tool_call', { name: call.name, args: call.args });
            allToolCalls.push({ name: call.name, args: call.args, iteration: iter + 1 });
            const toolStart = Date.now();
            let result;
            try {
              result = await Promise.race([
                executeServerTool(call.name, call.args, { isAdmin }),
                new Promise((_, rej) => setTimeout(() => rej(new Error('tool_timeout')), TOOL_TIMEOUT_MS)),
              ]);
            } catch (e) {
              result = { error: `도구 실행 실패: ${e?.message || e}`, name: call.name };
            }
            const toolMs = Date.now() - toolStart;
            console.log(`[tool] ${call.name} ${toolMs}ms`);
            sseEnqueue(controller, 'tool_result', { name: call.name, summary: summarizeToolResult(result), elapsed_ms: toolMs });
            return { call, result };
          }));

          // 다음 contents 구성: 이전 model turn의 parts를 그대로 echo back
          // (Gemini 3.x는 functionCall part의 thoughtSignature까지 같이 보내야 400 방지)
          contents = [
            ...contents,
            {
              role: 'model',
              parts: modelParts && modelParts.length
                ? modelParts
                : [
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

  const tiers = Array.isArray(pricing.tiers) && pricing.tiers.length ? pricing.tiers : [
    { id: 'mvp', name: 'MVP 개발', multiplier: 0.5 },
    { id: 'small', name: '소규모 프로젝트', multiplier: 0.75 },
    { id: 'medium', name: '중규모 프로젝트', multiplier: 1.0 },
    { id: 'large', name: '대규모 프로젝트', multiplier: 2.0 },
  ];
  const tiersBlock = tiers.map((t) => {
    const inc = (t.includes || []).slice(0, 6).join(' · ');
    return `- **${t.name}** (id=${t.id}, ×${t.multiplier}): ${t.description || ''}${inc ? ` [포함: ${inc}]` : ''}`;
  }).join('\n');

  const pricingTable = `
## 가격표 (단위: 만원, +${Math.round((pricing.overhead_ratio ?? 0.25) * 100)}% 오버헤드, ±${Math.round((pricing.range_ratio ?? 0.15) * 100)}% 범위)
- 페이지: 단순 ${pricing.pages_simple ?? 30} / 복잡 ${pricing.pages_complex ?? 80} (개당)
- 모듈: 기본 ${pricing.mod_basic ?? 200} / 고급 ${pricing.mod_advanced ?? 500} (개당)
- 외부 연동(PG/SSO/ERP/API): ${pricing.integrations ?? 300} (건당)
- AI 라인(별도, **가중치 미적용**): LLM 호출 +${pricing.ai?.llm_simple ?? 200} / RAG +${pricing.ai?.rag ?? 1200} / 에이전트 +${pricing.ai?.agent ?? 1800} / 파인튜닝 +${pricing.ai?.finetune ?? 2500}
- 운영비(토큰·벡터DB·GPU·인프라·도메인·SSL)는 월 별도 정산 또는 클라이언트 직접 지불

## 개발 수준 (가중치) — 페이지·모듈·외부연동 합계에만 적용
${tiersBlock}

## 견적 산출 규칙 (필수)
견적/얼마/예산/얼만큼 등 가격 관련 질문이면:
1. 사용자 발화에서 페이지 수, 모듈 종류, 외부연동, AI 라인, **개발 수준(MVP/소/중/대)**을 추출
2. 누락된 정보는 **합리적 가정**으로 보충 (예: "10페이지" → 단순 10, 복잡 0 가정 / "예약 시스템" → 회원·예약·결제 3개 모듈 가정)
3. 개발 수준이 명시 안 됐으면 사용자 표현에서 추론:
   - "MVP/검증/데모/투자/베타" → mvp (×0.5)
   - "스타트업/사내/간단/빠르게" → small (×0.75)
   - "정식/표준/일반 운영" → medium (×1.0)
   - "대기업/금융/공공/엔터프라이즈/SLA/보안감사" → large (×2.0)
4. **계산을 직접 보여줄 것** — 라인별 금액, 가중치 적용, 오버헤드, 범위까지
5. 가정·근거를 명시 후 "정확한 견적은 30분 무료 상담에서 RFP 확인 후 ±15% 조정" 추가
6. \`prefill_quote\` 도구 호출로 견적 계산기 자동 채움 (tier 포함)

### 견적 답변 예시 (이 형식을 따를 것)
사용자: "10페이지 + AI 에이전트로 견적, 스타트업이라 빠르게 가야 해"
답:
"라인별 견적 초안입니다 (가중치: 소규모 프로젝트 ×0.75):
- 페이지 단순 10개 × 30만원 = 300만원
- 외부 연동·모듈 없음 가정
- 위 합계 × 0.75(소규모 가중치) = 225만원
- AI 에이전트 라인 = 1,800만원 (가중치 미적용)
- 소계 = 2,025만원 / 오버헤드 25% = 506만원
- **총 2,531만원** (±15% 범위: 2,151만~2,911만)

가정: 모든 페이지 단순 UI, 외부 연동 0건, 기능 모듈 0개. RFP/요건 확인 후 ±15% 범위에서 조정됩니다. 30분 무료 상담에서 정식 견적 드릴게요. [상담](/#contact) · [Pricing](/#pricing)"
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
- 한국어 존댓말. **일반 답변은 최대 3문장 / 150자**, 1문장 권장. 운영자 모드는 더 짧게.
- **견적 답변은 글자 제한 면제** — 위 "견적 산출 규칙"의 형식대로 계산을 모두 보여줄 것
- 모르는 정보 → "30분 무료 상담에서 안내" 유도, 추측 금지 (단 견적은 합리적 가정으로 산출)
- 레퍼런스 → 위 케이스 1-2개 인용
- AI = "박힌 AI" 강조 (단순 챗봇 아님)
- 답변 끝 1줄로 [상담](/#contact) 자연스럽게 유도
- 무관 주제 정중 거절 + 본업 유도, 타사 직접 비판 금지
- 링크: [Pricing](/#pricing), [레퍼런스](/#cases), [상담](/#contact)
`;

  const tools = `
## 🛠 AI 에이전트 도구 — 2 종류 (혼동 금지)

### A. 클라이언트 액션 도구 (\`\`\`action JSON 블록으로 호출)
브라우저에서 실행되는 UI 액션 — 페이지 이동·폼 채우기·시각 효과 등.
응답 본문에 다음 코드 블록 포함 (사용자 화면엔 안 보임):
\`\`\`action
{"tool":"<이름>","data":{...}}
\`\`\`
**이 형식으로 호출할 도구**: create_lead, prefill_contact, navigate, prefill_quote, draft_quote, create_case_draft, draft_blog_post, schedule_followup, request_pm_callback

### B. 서버 데이터 도구 (Native Function Calling으로 자동 호출)
Netlify Blobs DB의 실제 데이터 조회/변경. AI가 functionCall로 호출하면 서버가 즉시 실행.
**절대로 \`\`\`action 형식으로 출력하지 말 것** — 형식 다르면 무시되고 저장 안 됨.
**이 형식으로 호출할 도구 (운영자 전용)**: leads_find/list/update/stats, tasks_list/update, chatlogs_search/get, cases_find/list, faqs_find, quotes_list, **get_bot_instruction, update_bot_instruction**

### 도구 시그니처 (트리거 → 도구 → 필수 필드)

| 도구 | 언제 호출 | 필수 |
|---|---|---|
| \`create_lead\` | 본인 정보로 "신청해줘"/"등록해줘"/"상담 접수" | name, **email** (필수) |
| \`prefill_contact\` | "폼 채워줘"/"직접 제출할게" | (모두 선택) |
| \`navigate\` | "○○ 보여줘"/"○○ 열어줘" | target |
| \`prefill_quote\` | "○○ 견적 얼마?" 액수 추정 | pages_simple, pages_complex, mod_basic, mod_advanced, integrations, ai{}, **tier** |
| \`draft_quote\` | "정식 견적서 만들어줘" | clientName, items[], overhead |
| \`create_case_draft\` | (운영자) 케이스 추가 | label, client, title |
| \`draft_blog_post\` | "블로그 글 써줘" | title, slug, content |
| \`schedule_followup\` | "○일 후 메일 예약" | leadEmail, leadName, daysFromNow, subject, body |
| \`request_pm_callback\` | **"연락 줘"/"전화 줘"/"통화 요청"/"콜백"** | name, contact(전화 또는 이메일), method |

### 🚨 create_lead vs request_pm_callback 구분 (자주 헷갈림)
**"연락 달라"/"전화 줘"/"○시에 통화"** → **반드시 \`request_pm_callback\`** (이메일 불필요, 전화번호만 있어도 OK)
**"상담 접수"/"신청해줘"/"등록해줘"** → \`create_lead\` (이메일 필수)
→ 사용자가 전화번호만 줬는데 \`create_lead\` 호출하면 이메일 검증 실패로 거절됨. 절대 잘못 선택 X.

### 핵심 enum
- create_lead.type: 플랫폼 신규구축 | 기존 고도화 | AI 추가 | AI 에이전트 구축 | 유지보수 | 미정
- create_lead.budget: ~1천만 | 1천~3천 | 3천~1억 | 1억~5억 | 5억+ | 미정
- navigate.target: hero, who, pain, promise, why, pricing, cases, process, team, faq, contact
- request_pm_callback.method: phone | email | kakao
- request_pm_callback.urgency: normal | urgent
- prefill_quote.ai keys: llm_simple, rag, agent, finetune (모두 boolean)
- prefill_quote.tier: mvp | small | medium | large (생략 시 현재 선택 유지)

### 대표 예시 (create_lead — 가장 흔한 케이스)
※ 아래 값은 **자리표시 예시**입니다. 실제 호출 시 사용자가 직접 제공한 값으로만 채우세요.
\`\`\`action
{"tool":"create_lead","data":{"name":"<사용자가 말한 이름>","email":"<사용자가 말한 이메일>","company":"<선택>","phone":"<선택>","type":"플랫폼 신규구축","budget":"3천~1억","message":"<요구사항 요약>"}}
\`\`\`

### 🚨 사용자 식별 정보 사용 규칙 (절대 위반 금지)
1. **사용자가 명시적으로 알려주지 않은 이름·연락처·회사명을 절대 추측·생성하지 말 것**
2. 시스템 프롬프트에 보이는 예시값(예: "김민수", "a@b.com", "010-1234-5678")은 **자리표시**일 뿐, 실제 사용자 정보가 아님
3. 사용자가 자기 이름을 말하기 전에는 **"고객님"** 같은 일반 호칭만 사용 (예: "고객님, 24시간 내 연락드리겠습니다")
4. **이름·연락처가 필요한 도구(create_lead, request_pm_callback)는 사용자가 정보 제공 전엔 호출 X** — 정보를 1회 요청 후 받으면 그때 호출
5. 사용자 메시지에서 이름·연락처를 추출할 때는 **정확히 그 메시지에 적힌 단어만** 사용. 추론 X, 보강 X

### 도구 5~9 추가 필드 (필요 시만)
- draft_quote: items=[{label, amount(만원)}, ...], overhead=25, notes(특이사항)
- create_case_draft: description, features[], tags[], amount, status, year, theme, icon
- draft_blog_post: excerpt, tags[], read_min (본문은 마크다운)
- schedule_followup: daysFromNow=3 권장
- request_pm_callback: preferredTime, topic, urgency
  - **preferredTime은 사용자 표현 그대로 채울 것**: "3시" → "오늘 15시" / "내일 오전" → "내일 오전" / "급해" → "" + urgency=urgent
  - **placeholder 금지**: name="고객님", contact="이메일 또는 전화번호" 같이 변수 치환 못한 값으로 호출 X
  - 정보 부족하면 도구 호출 **하지 말고** 1회만 짧게 질문 ("성함과 전화번호 또는 이메일 알려주시겠어요?")

### 호출 후 답변 패턴 (사용자에게 보일 텍스트)
**중요: 도구 호출 시 본문 텍스트는 1-2문장으로 짧게. \`\`\`action 블록이 답변 끝까지 잘리지 않게.**
- create_lead → "✅ {name}님 접수, 24h 내 박두용 PM 회신"
- request_pm_callback (urgent) → "🚨 {name}님 30분 내 연락드립니다 ({preferredTime})"
- request_pm_callback (normal) → "✅ {name}님 박두용 PM에게 전달했습니다 ({preferredTime} 연락 예정)"
- draft_quote → "✅ 초안 작성. PM 검토 후 정식 PDF 발송"
- 기타 → "✓ 처리했습니다" 짧게

---

### (deduplicated for cost optimization)

## 🛡 호출 규칙
1. 명시적 요청 시에만 호출
2. 필수 정보 부족 → 호출 X, 정보 요청 1회
3. **한 응답에 1개 도구만** — 절대 2개 이상 X (둘 다 거절·중복 등록 위험)
4. 비운영자: create_lead 세션당 1회
5. 이메일 정규식 검증 (@ 필수)
6. 본문 텍스트 + 액션 블록 함께 (액션만 안 됨)
7. **본문 텍스트와 액션의 도구가 동일해야** — 본문에 "PM에게 전달했다" 라고 했으면 액션도 request_pm_callback. create_lead 액션 X.
8. **도구 호출 안 할 거면 '전달했다'/'접수했다'/'예정입니다' 표현 금지** — 사용자가 보면 등록된 줄 알지만 실제론 X (UX 불일치)
   → 정보 부족 시: "성함도 알려주시겠어요?" / "전화번호 또는 이메일도 함께 알려주시면 PM에게 정확히 전달드리겠습니다" 같이 **정보 요청만** 하기
`;

  // ─── 운영자 모드 안내 — 도구 카탈로그는 tools 필드로 별도 전달, 여기엔 짧은 사용 정책 + 선택 매핑 ───
  const adminToolsStatic = !isAdmin ? '' : `
---
# 🔑 운영자 모드
톤: 동료처럼 짧고 명확. 영업 톤 X.
데이터 질문은 반드시 도구 호출, 추측·암기 금지. JSON 원본 노출 X, 자연어 요약.

## 도구 매핑 (질문 패턴 → 정확한 도구)
- "몇 건/카운트/통계" → leads_stats (since: 7d|30d|month)
- "특정 인물/이메일/누구야" → leads_find (name|email|phone)
- "목록/이번주/신규/단계별" → leads_list (status|since|limit)
- "단계 변경/won/lost/메모 추가" → leads_update (id, status|note)
- "통화 요청/follow-up 대기" → tasks_list (type|status|urgency)
- "작업 완료/취소" → tasks_update (id, status)
- "대화 검색/키워드" → chatlogs_search (keyword|since)
- "특정 세션 내용" → chatlogs_get (sessionId)
- "케이스/레퍼런스" → cases_find or cases_list
- "견적서 목록" → quotes_list
- "지금 챗봇 행동 지침 뭐야/현재 설정/확인" → get_bot_instruction
- "다음부터 ㅇㅇ해줘/고객한테 ㅇㅇ 받아라/지침 추가/규칙 변경" → update_bot_instruction (mode='append' 기본, "전체 교체" 명시 시 'replace_all')
- "분석해줘/패턴 찾아줘/자주 묻는 질문/개선할 부분/챗봇 학습" → analyze_chat_patterns (since=7d|30d, min_count=2)
- "메일 보내줘/이메일 발송/회신 보내줘/안내문 보내줘" → send_email (to/subject/body 필수, leadName/purpose 권장)
- "오늘 요약/일간 보고/어제 어땠어/운영 현황/오늘 핵심" → daily_briefing (date 생략 시 오늘)
- "예상 매출/파이프라인 분석/이번달 매출 예측/수주 예상" → revenue_forecast (horizon=month|quarter)
- "자주 묻는 질문 캐싱/AI 비용 줄여줘/frozen 후보 찾아줘" → frozen_response_suggest (since=30d 기본)
- "그 후보 추가해줘/frozen으로 저장해줘" → frozen_response_create (PM 동의 후 호출)
- "○○ 견적서 만들어줘/견적서 등록해줘" → create_quote (clientName/items/total 필수)
- "○○ 메일 발송 완료 표시/방금 보냈어" → mark_email_sent (emailDrafts.id 필요)
- "○○ 콜백 취소/작업 삭제/취소해줘" → tasks_delete (status 변경이 아니라 완전 삭제 시. id 1개씩 호출, 여러 건이면 한 번에 1건씩 순차)
- "오늘 일정/내일 뭐 있어/이번주 콜백/5월 15일 뭐 있어" → calendar_events_list (date 또는 start_date/end_date)
- "내일 ○○ 메모/○월 ○일에 ○○ 일정 적어줘" → add_calendar_note (date 절대 형식, color 옵션)

## 📅 캘린더 도구 사용 — 날짜 변환 규칙 (중요)
- 시스템 프롬프트 끝에 "오늘 날짜 = YYYY-MM-DD" 컨텍스트가 주입됨. 그 값을 기준으로 상대 날짜 변환:
  - "오늘" → today
  - "내일" → today + 1일
  - "모레" → today + 2일
  - "이번주" → date 범위 start_date=오늘, end_date=오늘+6
  - "다음주" → start_date=오늘+7, end_date=오늘+13
  - "이번달" → start_date=YYYY-MM-01, end_date=YYYY-MM-마지막날
  - "5월 15일" / "다음주 월요일" → 절대 날짜로 변환 후 호출
- 날짜 자체가 모호하면 호출 X, 1회 짧게 확인 ("오늘 일정이요?")

## 📧 이메일 발송 (send_email) 사용 가이드
- 이메일 본문은 운영자가 별도 검수 없이 그대로 발송될 수 있으므로 **공손한 한국어 + 회사 시그니처** 포함:
  \`안녕하세요 {leadName}님,\\n\\n{본문}\\n\\n감사합니다.\\n박두용 PM | 함께워크_SI\\n010-2807-5242 | endy116@naver.com\`
- 콜백 확인 메일: purpose='callback_confirm', subject='박두용 PM 회신 안내'
- 견적 발송: purpose='quote_send', subject 예 '함께워크_SI 견적 안내 - {프로젝트명}'
- 팔로업: purpose='followup'
- 환경에 RESEND_API_KEY 있으면 즉시 발송, 없으면 drafts 저장 → 도구 결과의 status/note 확인 후 사용자에게 정확히 안내

## 챗봇 행동 지침 변경 절차 (중요)
운영자가 "다음부터 사용자한테 이름·연락처 받으라고 해" 같은 영구 행동 변경을 요청하면:
1. **update_bot_instruction을 Native Function Calling으로 호출** (instruction에 새 규칙을 짧고 명확하게)
   → 절대로 \`\`\`action JSON 블록으로 출력하지 말 것 (서버 데이터 도구이므로 형식 다르면 무시됨)
2. 도구 결과의 note를 답변에 자연어로 풀어서 포함 — "다음 사용자 응답부터 적용됩니다"
3. **절대로 도구 호출 없이 "알겠습니다"라고만 답하지 말 것** (실제 저장 안 되면 무의미)
4. 모호하면 1회만 짧게 확인 ("새 규칙으로 추가할까요, 기존 규칙 전부 교체할까요?")

## 반자동 학습 사이클 (analyze_chat_patterns)
운영자가 "분석해줘"/"개선할 부분"/"자주 묻는 질문" 등 요청 시:
1. **analyze_chat_patterns 호출** (since 기본 7d, 명시되면 그대로)
2. 결과를 자연어로 요약 — top_keywords Top 3-5개, weak_samples 1-2개 인용
3. **1-3개 새 행동 지침 제안** — 패턴 기반으로 구체적 텍스트로 (예: "고객이 '예약 시스템'을 자주 묻습니다. '미용실·병원 등 업종별 예약 시스템 레퍼런스가 있다고 안내하세요' 같은 규칙 추가 어떠세요?")
4. **PM 동의 받기 전엔 update_bot_instruction 호출 금지** — 자동 채택 X
5. PM이 "추가해줘"/"좋아"/"적용해" 등 명시 동의하면 그제서야 update_bot_instruction 호출 (제안한 텍스트 그대로)
6. PM이 거절/수정 요구하면 의견 반영해 재제안

질문이 모호하면 한 번만 되묻기. 절대 leads_find로 카운트하지 말 것 (전체 통계는 leads_stats).
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

  // 📅 오늘 날짜 — Asia/Seoul 기준 (KST = UTC+9)
  // toISOString()은 UTC라서 한국 자정 근처에 날짜가 어긋남
  const _kstNow = new Date(Date.now() + 9 * 3600 * 1000);
  const todayIso = _kstNow.toISOString().slice(0, 10); // YYYY-MM-DD KST
  const todayWeekday = ['일','월','화','수','목','금','토'][_kstNow.getUTCDay()];
  dynamicParts.push(`[오늘 = ${todayIso} (${todayWeekday}요일) · 시간대 Asia/Seoul (KST = UTC+9)]`);

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
