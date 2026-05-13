/**
 * AI chatbot widget — Gemini-powered with platform RAG + Agent tool calls.
 *
 * Flow:
 *  1. User asks a question
 *  2. Frontend collects: full conversation + current platform state (cases/FAQs/pricing) from store
 *  3. POSTs to /api/chat (Netlify Function → Gemini 3.0 Flash)
 *  4. Parses ```action ... ``` blocks → executes tools (create_lead, navigate, prefill_quote, prefill_contact)
 *  5. Renders cleaned answer with typing animation + tool result cards
 *  6. Falls back to admin-configured intent rules if API fails
 *  7. Logs conversation to store.chatLogs (admin can review)
 */

import { store, utils } from './store.js';

const fab = document.getElementById('chatbotFab');
const panel = document.getElementById('chatbotPanel');
const closeBtn = document.getElementById('chatbotClose');
const body = document.getElementById('chatbotBody');
const input = document.getElementById('chatInput');
const sendBtn = document.getElementById('chatSend');
const suggestionsEl = document.getElementById('chatSuggestions');

let conversation = [];   // [{ role: 'user'|'bot', text, at }]
let sessionId = utils.uid('s');
let isOpen = false;
let sending = false;
let leadCreatedInSession = false;  // session-level rate limit
let lastLeadAt = 0;

// 🧪 A/B 테스트 — 세션별 variant 할당 (Top 12)
// A: 친근 톤 (기본) / B: 격식 톤
// 운영자 모드는 항상 A (실험 대상 아님)
function pickVariant() {
  const auth = store.auth.get();
  if (auth && auth.email) return 'A';
  return Math.random() < 0.5 ? 'A' : 'B';
}
const variant = pickVariant();

// 🛡 무한루프 방지 5중 안전장치
const LIMITS = {
  toolsPerSession: 10,         // 한 세션에서 도구 호출 최대 횟수
  sameToolConsecutive: 3,      // 동일 도구·동일 인자 연속 호출 최대
  conversationTurns: 30,       // 한 세션 최대 메시지 수 (user+bot 합)
  apiCallsPerMinute: 12,       // 분당 API 호출 최대
  monthlyBudgetUsd: 50,        // 월 비용 한도 (정보 표시용)
  historyToSend: 12,           // Gemini에 보낼 최근 메시지 수 (6 turn)
  historyKeepRecent: 4,        // 압축 시 최근 N개는 원본 유지 (#2)
  historyCompressFrom: 6,      // N+ 메시지 쌓이면 오래된 것 압축
  sessionCostSoftUsd: 0.03,    // #5(a) 세션 누적 비용 경고 임계
  sessionCostHardUsd: 0.05,    // #5(a) 세션 누적 비용 차단 임계
};

// 💰 #5(a) 세션 누적 비용 추적
let sessionCostUsd = 0;
let sessionCostWarned = false;

// 💰 비용 절감: 단순 인사/감사는 Gemini 호출 없이 즉시 응답
const SHORT_FALLBACKS = {
  '안녕': '안녕하세요! 함께워크_SI AI 상담입니다. 견적·레퍼런스·AI 도입 등 무엇이든 물어보세요.',
  '안녕하세요': '안녕하세요! 무엇을 도와드릴까요?',
  '하이': '안녕하세요! 무엇이 궁금하신가요?',
  'hi': '안녕하세요! 무엇이 궁금하신가요?',
  'hello': '안녕하세요! 무엇이 궁금하신가요?',
  'ㅎㅇ': '안녕하세요!',
  '감사': '도움 되었으면 좋겠어요. 더 궁금한 거 있으시면 편하게 물어보세요.',
  '감사합니다': '네 도움 필요하시면 또 말씀해 주세요!',
  '감사해요': '도움 되었길 바라요!',
  'ㄳ': '도움 되었길 바라요!',
  '고마워': '도움 되었길 바라요!',
  '고마워요': '도움 되었길 바라요!',
  '고맙습니다': '도움 되었길 바라요!',
  '잘가': '안녕히 가세요! 언제든 다시 찾아주세요.',
  '안녕히': '네 안녕히 가세요!',
  '바이': '안녕히 가세요!',
  'bye': '안녕히 가세요!',
  '굿바이': '안녕히 가세요!',
  'ㅂㅇ': '안녕히 가세요!',
  '네': '네! 더 궁금한 점 있으세요?',
  '응': '네! 더 궁금한 점 있으세요?',
  'ㅇㅇ': '네! 더 궁금한 점 있으세요?',
  '아니요': '알겠습니다. 다른 질문 있으시면 언제든 편하게 물어보세요.',
  'no': '알겠습니다. 다른 질문 있으시면 편하게 물어보세요.',
  'ㄴㄴ': '알겠습니다. 다른 질문 있으시면 편하게 물어보세요.',
};

/**
 * 💰 #4 Frozen Response — 사전 정의된 응답에 키워드 매칭 시 Gemini 호출 0
 * 어드민 [지식 베이스]에서 PM이 작성한 응답을 매칭 → 즉시 응답
 */
function tryFrozenResponse(q) {
  const frozen = store.frozenResponses.all();
  if (!frozen.length) return null;
  const text = q.toLowerCase();
  for (const fr of frozen) {
    if (fr.disabled) continue;
    const kws = (fr.keywords || []).map((k) => (k || '').toLowerCase().trim()).filter(Boolean);
    if (!kws.length) continue;
    const mode = fr.matchMode || 'all';  // all = AND, any = OR
    const hits = kws.filter((k) => text.includes(k));
    const matched = mode === 'any' ? hits.length > 0 : hits.length === kws.length;
    if (matched) {
      // 히트 카운트 증가 (분석용)
      store.frozenResponses.update(fr.id, { hits: (fr.hits || 0) + 1, lastHitAt: utils.nowIso() });
      return fr.answer;
    }
  }
  return null;
}

function tryShortFallback(q) {
  const normalized = q.trim().toLowerCase().replace(/[!?.,~^ ]/g, '');
  if (SHORT_FALLBACKS[normalized]) return SHORT_FALLBACKS[normalized];
  // 매우 짧고 단순한 입력은 친절히 다시 물음 (Gemini 안 부름)
  if (normalized.length > 0 && normalized.length <= 2) {
    return '조금 더 구체적으로 말씀해 주시면 정확히 도와드릴게요. 예: "쇼핑몰 견적 얼마야?", "AI 에이전트가 뭐예요?"';
  }
  return null;
}
let sessionToolCalls = 0;
let lastToolSignature = '';
let sameToolStreak = 0;
const apiCallTimes = [];        // 최근 60초 동안의 호출 시각

function escapeHtml(s) {
  return (s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Lightweight markdown-ish formatting for bot bubbles */
function fmtAnswer(text) {
  let s = escapeHtml(text);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
    const safeHref = href.replace(/"/g, '&quot;');
    return `<a href="${safeHref}" style="color:var(--cobalt);text-decoration:underline;font-weight:600">${escapeHtml(label)}</a>`;
  });
  s = s.replace(/\n/g, '<br>');
  return s;
}

function bubble(text, who = 'bot', html = false) {
  const el = document.createElement('div');
  el.className = `chat-bubble ${who}`;
  el.innerHTML = html ? text : escapeHtml(text).replace(/\n/g, '<br>');
  body.appendChild(el);
  body.scrollTop = body.scrollHeight;
  return el;
}

function typingIndicator() {
  const el = document.createElement('div');
  el.className = 'chat-bubble bot typing';
  el.innerHTML = '<span></span><span></span><span></span>';
  body.appendChild(el);
  body.scrollTop = body.scrollHeight;
  return el;
}

function streamInto(el, fullText, speed = 14) {
  return new Promise((resolve) => {
    const html = fmtAnswer(fullText);
    let i = 0;
    const plain = fullText;
    el.innerHTML = '';
    el.classList.remove('typing');
    function tick() {
      if (i >= plain.length) {
        el.innerHTML = html;
        body.scrollTop = body.scrollHeight;
        return resolve();
      }
      el.textContent = plain.slice(0, i + 1);
      body.scrollTop = body.scrollHeight;
      i += Math.max(1, Math.floor(2 + Math.random() * 2));
      setTimeout(tick, speed);
    }
    tick();
  });
}

/**
 * 🚀 SSE 스트리밍 토큰을 실시간으로 버블에 그린다.
 * - 누적 텍스트에서 ```action ... ``` 블록은 사용자에게 숨김
 * - 아직 닫히지 않은 ```action 도 숨김 (블록 시작 즉시 사라짐)
 */
function stripActionsLive(text) {
  let s = text.replace(/```action\s*\n?[\s\S]*?```/g, '');
  const idx = s.indexOf('```action');
  if (idx >= 0) s = s.slice(0, idx);
  return s.replace(/\n{3,}/g, '\n\n').trimEnd();
}

function paintStreamingBubble(el, accumulated, lastRenderedRef) {
  const visible = stripActionsLive(accumulated);
  if (visible === lastRenderedRef.value) return;
  lastRenderedRef.value = visible;
  el.classList.remove('typing');
  el.innerHTML = fmtAnswer(visible);
  body.scrollTop = body.scrollHeight;
}

/* ============================================================
   🤖 Agent: action block parser + tool executors
   ============================================================ */

/** Extract ```action ... ``` blocks from the AI response */
function extractActions(text) {
  const actions = [];
  const cleaned = [];
  const regex = /```action\s*\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let m;
  while ((m = regex.exec(text)) !== null) {
    cleaned.push(text.slice(lastIndex, m.index));
    try {
      const obj = JSON.parse(m[1].trim());
      if (obj && obj.tool) actions.push(obj);
    } catch (e) {
      console.warn('[agent] failed to parse action JSON', e, m[1]);
    }
    lastIndex = m.index + m[0].length;
  }
  cleaned.push(text.slice(lastIndex));
  return {
    actions,
    cleanText: cleaned.join('').replace(/\n{3,}/g, '\n\n').trim(),
  };
}

/** Validate before executing — returns null if OK, error message if bad */
function validateAction(action) {
  const { tool, data = {} } = action;
  if (tool === 'create_lead') {
    if (!data.name || !data.name.trim()) return '이름이 누락되었습니다';
    if (!data.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email))
      return '이메일 형식이 올바르지 않습니다';
    // 운영자 모드에서는 rate limit 해제 (대량 리드 입력 가능)
    const auth = store.auth.get();
    const isAdmin = !!(auth && auth.email);
    if (!isAdmin) {
      if (leadCreatedInSession) return '이미 한 번 신청이 접수되었습니다 (세션당 1건 제한)';
      const since = Date.now() - lastLeadAt;
      if (since < 60 * 1000) return '60초 이내에 다시 신청할 수 없습니다';
    }
  }
  if (tool === 'navigate') {
    const valid = ['hero', 'who', 'pain', 'promise', 'why', 'pricing', 'cases', 'process', 'team', 'faq', 'contact'];
    if (!valid.includes(data.target)) return '잘못된 섹션 이름입니다';
  }
  return null;
}

/** Execute a single tool call. Returns { ok, message, card? } */
async function executeAction(action) {
  // 🛡 안전장치 3: 세션당 도구 호출 한도
  sessionToolCalls++;
  if (sessionToolCalls > LIMITS.toolsPerSession) {
    return { ok: false, message: `세션당 도구 호출 한도(${LIMITS.toolsPerSession}회)에 도달했습니다. 새 세션을 시작해 주세요.` };
  }

  // 🛡 안전장치 4: 동일 도구·동일 인자 연속 호출 차단
  const signature = `${action.tool}::${JSON.stringify(action.data || {})}`;
  if (signature === lastToolSignature) {
    sameToolStreak++;
    if (sameToolStreak >= LIMITS.sameToolConsecutive) {
      console.warn('[agent] same tool called', sameToolStreak, 'times → blocked');
      return { ok: false, message: '동일 작업이 반복되어 차단했습니다 (무한루프 방지).' };
    }
  } else {
    lastToolSignature = signature;
    sameToolStreak = 1;
  }

  const err = validateAction(action);
  if (err) return { ok: false, message: err };

  const { tool, data = {} } = action;

  switch (tool) {
    // ====================================================
    // 1. create_lead — DB CRUD: directly insert into admin
    // ====================================================
    case 'create_lead': {
      // 🛡 예시/placeholder 데이터 거절 — AI가 시스템 프롬프트 예시값으로 호출하는 케이스
      const fakeNames = [/^김민수$/, /^홍길동$/, /^고객님?$/i, /^<.*>$/];
      const fakeEmails = [/^a@b\.com$/i, /^test@/i, /^<.*>$/, /^이메일/i];
      const fakePhones = [/^010-?1234-?5678$/, /^<.*>$/, /^전화/];
      const isFakeName = fakeNames.some((re) => re.test(String(data.name || '').trim()));
      const isFakeEmail = data.email && fakeEmails.some((re) => re.test(String(data.email).trim()));
      const isFakePhone = data.phone && fakePhones.some((re) => re.test(String(data.phone).trim()));
      if (!data.name || isFakeName || isFakeEmail || isFakePhone) {
        return {
          ok: false,
          message: '실제로 알려주신 이름과 연락처가 필요해요. 다시 한 번 말씀해 주시겠어요?',
        };
      }
      // 이메일 형식 최소 검증 (@ 있어야)
      if (data.email && !/@.+\..+/.test(String(data.email).trim())) {
        return { ok: false, message: '이메일 형식을 다시 확인해 주세요 (예: name@domain.com)' };
      }

      const lead = store.leads.add({
        name: data.name?.trim() || '',
        email: data.email?.trim() || '',
        company: data.company?.trim() || '',
        phone: data.phone?.trim() || '',
        type: data.type?.trim() || '아직 정해지지 않음',
        budget: data.budget?.trim() || '정해지지 않음 / 견적 받고 결정',
        message: (data.message?.trim() || '') + `\n\n[챗봇 AI 자동 등록 · 세션 ${sessionId} · variant ${variant}]`,
        status: 'new',
        source: 'chatbot-ai',
        aiSubmitted: true,
        sessionId,
        variant,
      });

      leadCreatedInSession = true;
      lastLeadAt = Date.now();

      // Fire-and-forget server notify (email/Slack)
      try {
        await fetch('/api/send-lead', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(lead),
        });
      } catch {}

      return {
        ok: true,
        message: `${lead.name}님 상담 신청 등록 완료`,
        card: {
          icon: '✅',
          title: '상담 신청이 접수되었습니다',
          rows: [
            ['이름', lead.name],
            ['이메일', lead.email],
            lead.company && ['회사', lead.company],
            lead.phone && ['연락처', lead.phone],
            ['필요한 일', lead.type],
            ['예상 예산', lead.budget],
          ].filter(Boolean),
          footer: '24시간 이내 박두용 PM이 회신드릴게요.',
          tone: 'success',
        },
      };
    }

    // ====================================================
    // 2. prefill_contact — fill the form (no DB write)
    // ====================================================
    case 'prefill_contact': {
      const fields = {
        lf_name: data.name,
        lf_company: data.company,
        lf_email: data.email,
        lf_phone: data.phone,
        lf_type: data.type,
        lf_budget: data.budget,
        lf_msg: data.message,
      };
      Object.entries(fields).forEach(([id, value]) => {
        if (!value) return;
        const el = document.getElementById(id);
        if (!el) return;
        if (el.tagName === 'SELECT') {
          // pick closest matching option
          const opt = Array.from(el.options).find((o) => o.text === value || o.value === value);
          if (opt) el.value = opt.value;
        } else {
          el.value = value;
        }
      });
      // scroll to contact form
      document.getElementById('contact')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return {
        ok: true,
        message: '상담 폼이 미리 채워졌습니다',
        card: {
          icon: '📝',
          title: '상담 폼을 미리 채워드렸어요',
          rows: Object.entries(fields).filter(([, v]) => v).map(([k, v]) => [k.replace('lf_', ''), v]),
          footer: '내용을 확인하시고 [상담 요청 보내기] 버튼을 눌러주세요.',
          tone: 'info',
        },
      };
    }

    // ====================================================
    // 3. navigate — smooth scroll to a section
    // ====================================================
    case 'navigate': {
      const labels = {
        hero: '홈', who: '필요한 분', pain: '시장 문제', promise: '약속',
        why: 'Why us', pricing: '견적 계산기', cases: '레퍼런스',
        process: '프로세스', team: '팀', faq: 'FAQ', contact: '상담 폼',
      };
      document.getElementById(data.target)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      closePanel();  // close chatbot so user sees the section
      return {
        ok: true,
        message: `${labels[data.target] || data.target}로 이동했습니다`,
      };
    }

    // ====================================================
    // 4. prefill_quote — fill calc + scroll + read result
    // ====================================================
    case 'prefill_quote': {
      const setVal = (id, val) => {
        const el = document.getElementById(id);
        if (el && val != null) el.textContent = String(val);
      };
      // Update visual values
      setVal('val_pages_simple', data.pages_simple ?? 0);
      setVal('val_pages_complex', data.pages_complex ?? 0);
      setVal('val_mod_basic', data.mod_basic ?? 0);
      setVal('val_mod_advanced', data.mod_advanced ?? 0);
      setVal('val_integrations', data.integrations ?? 0);

      // Update AI checkboxes
      const aiKeys = ['llm_simple', 'rag', 'agent', 'finetune'];
      aiKeys.forEach((k) => {
        const wantedChecked = !!data.ai?.[k];
        const label = document.querySelector(`.calc-check[data-ai="${k}"]`);
        const cb = label?.querySelector('input[type=checkbox]');
        if (cb && cb.checked !== wantedChecked) {
          cb.checked = wantedChecked;
          label.classList.toggle('on', wantedChecked);
        }
      });

      // Update calculator state by dispatching a custom event handled in calculator.js
      const VALID_TIERS = new Set(['mvp', 'small', 'medium', 'large']);
      window.dispatchEvent(new CustomEvent('calc:setState', {
        detail: {
          pages_simple: data.pages_simple ?? 0,
          pages_complex: data.pages_complex ?? 0,
          mod_basic: data.mod_basic ?? 0,
          mod_advanced: data.mod_advanced ?? 0,
          integrations: data.integrations ?? 0,
          ai: data.ai || {},
          ...(VALID_TIERS.has(data.tier) ? { tier: data.tier } : {}),
        },
      }));

      document.getElementById('pricing')?.scrollIntoView({ behavior: 'smooth', block: 'start' });

      // Read total after re-render
      await new Promise((r) => setTimeout(r, 250));
      const total = document.getElementById('total_val')?.textContent || '?';
      const range = document.getElementById('range_text')?.textContent || '';

      return {
        ok: true,
        message: `견적 계산기에 값을 채웠습니다 (${total} 만원)`,
        card: {
          icon: '💰',
          title: `예상 견적: ${total} 만원`,
          rows: [
            data.pages_simple && ['단순 페이지', `${data.pages_simple}개`],
            data.pages_complex && ['복잡 페이지', `${data.pages_complex}개`],
            data.mod_basic && ['기본 모듈', `${data.mod_basic}개`],
            data.mod_advanced && ['고급 모듈', `${data.mod_advanced}개`],
            data.integrations && ['외부 연동', `${data.integrations}건`],
            ['AI 라인', aiKeys.filter((k) => data.ai?.[k]).map((k) => k.replace('_', ' ')).join(', ') || '없음'],
          ].filter(Boolean),
          footer: range,
          tone: 'info',
        },
      };
    }

    // ====================================================
    // 5. draft_quote — 견적서 초안 자동 작성 (PM 검토 후 발송)
    // ====================================================
    case 'draft_quote': {
      if (!data.clientName) return { ok: false, message: '클라이언트명이 누락되었습니다' };
      if (!Array.isArray(data.items) || !data.items.length) {
        return { ok: false, message: '견적 항목이 비어있습니다' };
      }
      const sub = data.items.reduce((s, x) => s + (Number(x.amount) || 0), 0);
      const overhead = Number(data.overhead) || 25;
      const total = Math.round(sub * (1 + overhead / 100));
      const q = store.quotes.add({
        title: data.title || `${data.clientName} 견적서`,
        clientName: data.clientName,
        items: data.items,
        overhead,
        total,
        notes: (data.notes || '') + `\n\n[챗봇 AI 자동 작성 · 세션 ${sessionId} · PM 검토 필요]`,
        status: 'ai-draft',
        aiSubmitted: true,
      });
      return {
        ok: true,
        message: `견적 초안 작성 완료 (${total.toLocaleString('ko-KR')} 만원)`,
        card: {
          icon: '📄',
          title: `견적 초안: ${q.title}`,
          rows: [
            ['클라이언트', q.clientName],
            ['항목 수', `${q.items.length}건`],
            ['소계', `${sub.toLocaleString('ko-KR')} 만원`],
            ['QA·PM', `${overhead}%`],
            ['총액', `${total.toLocaleString('ko-KR')} 만원`],
          ],
          footer: '✓ 어드민 [견적/제안서]에 AI 초안으로 저장. 박두용 PM이 검토 후 정식 PDF 발행.',
          tone: 'success',
        },
      };
    }

    // ====================================================
    // 6. create_case_draft — 케이스 비공개 추가
    // ====================================================
    case 'create_case_draft': {
      if (!data.title || !data.client) {
        return { ok: false, message: '케이스 제목과 클라이언트가 필요합니다' };
      }
      const c = store.cases.add({
        label: data.label || 'Case',
        client: data.client,
        title: data.title,
        description: data.description || '',
        features: data.features || [],
        tags: data.tags || [],
        amount: data.amount || '',
        status: data.status || '',
        year: data.year || new Date().getFullYear(),
        theme: data.theme || 'blue',
        icon: data.icon || '📦',
        published: false,  // 비공개로 추가
        aiDraft: true,
      });
      return {
        ok: true,
        message: `케이스 초안 추가 (${c.title})`,
        card: {
          icon: '💼',
          title: `케이스 초안: ${c.label}`,
          rows: [
            ['클라이언트', c.client],
            ['제목', c.title],
            ['태그', (c.tags || []).join(', ') || '—'],
            ['상태', '🔒 비공개'],
          ],
          footer: '✓ 어드민 [케이스 관리]에 비공개로 저장. 박두용 PM이 검토 후 공개 토글 ON.',
          tone: 'info',
        },
      };
    }

    // ====================================================
    // 7. draft_blog_post — 블로그 초안 자동 작성
    // ====================================================
    case 'draft_blog_post': {
      if (!data.title || !data.content) {
        return { ok: false, message: '블로그 제목과 본문이 필요합니다' };
      }
      const slug = data.slug || data.title.toLowerCase().replace(/\s+/g, '-').replace(/[^\w가-힣-]/g, '').slice(0, 60);
      const p = store.posts.add({
        title: data.title,
        slug,
        excerpt: data.excerpt || '',
        content: data.content,
        author: 'AI 초안',
        tags: data.tags || [],
        read_min: data.read_min || 5,
        published_at: new Date().toISOString().slice(0, 10),
        published: false,
        aiDraft: true,
      });
      return {
        ok: true,
        message: `블로그 초안 작성 (${p.title})`,
        card: {
          icon: '📝',
          title: `블로그 초안: ${p.title}`,
          rows: [
            ['요약', p.excerpt],
            ['태그', (p.tags || []).join(', ') || '—'],
            ['길이', `${(p.content || '').length}자`],
            ['상태', '🔒 비공개 (미발행)'],
          ],
          footer: '✓ 어드민 [블로그/콘텐츠]에 AI 초안으로 저장. 박두용 PM이 편집·검토 후 [공개] 토글.',
          tone: 'info',
        },
      };
    }

    // ====================================================
    // 8. schedule_followup — 리드 follow-up 메일 예약
    // ====================================================
    case 'schedule_followup': {
      if (!data.leadEmail || !data.subject || !data.body) {
        return { ok: false, message: '이메일·제목·본문이 모두 필요합니다' };
      }
      const days = Number(data.daysFromNow) || 3;
      const scheduledAt = new Date(Date.now() + days * 86400000).toISOString();
      const t = store.scheduledTasks.add({
        type: 'followup_email',
        leadEmail: data.leadEmail,
        leadName: data.leadName || '',
        subject: data.subject,
        body: data.body,
        scheduledAt,
        status: 'pending',
        aiSubmitted: true,
      });
      return {
        ok: true,
        message: `Follow-up ${days}일 후 예약 완료`,
        card: {
          icon: '📨',
          title: `Follow-up 예약: ${data.leadName || data.leadEmail}`,
          rows: [
            ['수신', data.leadEmail],
            ['예약일', new Date(scheduledAt).toLocaleDateString('ko-KR')],
            ['제목', data.subject],
            ['상태', '⏰ 발송 대기'],
          ],
          footer: '✓ 어드민 [대시보드]에서 시간 도래 시 [지금 발송] 버튼으로 발송.',
          tone: 'info',
        },
      };
    }

    // ====================================================
    // 9. request_pm_callback — PM 직접 연락 요청
    // ====================================================
    case 'request_pm_callback': {
      if (!data.name || !data.contact || !data.method) {
        return { ok: false, message: '이름·연락처·방법(phone/email/kakao)이 필요합니다' };
      }
      // 🛡 placeholder/예시 데이터 거절 — AI가 정보 없이 또는 시스템 프롬프트 예시값으로 호출하는 케이스
      const placeholderPatterns = [
        /^고객님?$/i, /^이름$/i, /^이메일/i, /^전화번호/i, /^연락처/i,
        /이메일.*또는.*전화/, /전화.*또는.*이메일/,
        /^placeholder/i, /^example/i, /TBD/i,
        /^<.*>$/, // <사용자가 말한 이름> 같은 placeholder
        /^김민수$/, /^홍길동$/, /^a@b\.com$/i, /^test@/i, /^010-?1234-?5678$/, // 예시값
      ];
      const isPlaceholder = (s) => placeholderPatterns.some((re) => re.test(String(s).trim()));
      if (isPlaceholder(data.name) || isPlaceholder(data.contact)) {
        return { ok: false, message: '실제 이름과 연락처가 필요해요. 다시 말씀해 주시겠어요?' };
      }
      // 연락처 형식 검증 (전화면 숫자 7자리+, 이메일이면 @ 필수)
      const contactStr = String(data.contact).trim();
      const hasDigits = (contactStr.match(/\d/g) || []).length;
      const isEmail = /@/.test(contactStr);
      if (!isEmail && hasDigits < 7) {
        return { ok: false, message: '연락처를 다시 확인해 주세요. 전화번호(010-1234-5678)나 이메일이 필요해요.' };
      }
      const methodKr = { phone: '📞 전화', email: '📨 이메일', kakao: '💬 카카오톡' }[data.method] || data.method;
      const urgent = data.urgency === 'urgent';
      const t = store.scheduledTasks.add({
        type: 'callback_request',
        leadName: data.name,
        contact: data.contact,
        method: data.method,
        preferredTime: data.preferredTime || '',
        topic: data.topic || '',
        urgency: data.urgency || 'normal',
        status: 'pending',
        scheduledAt: urgent ? new Date(Date.now() + 30 * 60000).toISOString() : new Date().toISOString(),
        sessionId,
        aiSubmitted: true,
      });
      return {
        ok: true,
        message: `${data.name}님 PM 연락 요청 등록`,
        card: {
          icon: urgent ? '🚨' : '📞',
          title: `PM 연락 요청 (${urgent ? 'URGENT' : 'NORMAL'})`,
          rows: [
            ['이름', data.name],
            ['방법', methodKr],
            ['연락처', data.contact],
            data.preferredTime && ['선호 시간', data.preferredTime],
            data.topic && ['주제', data.topic],
          ].filter(Boolean),
          footer: urgent ? '🚨 30분 이내 박두용 PM이 직접 연락드립니다.' : '✓ 박두용 PM에게 전달했습니다. 가능한 시간대에 연락드리겠습니다.',
          tone: 'success',
        },
      };
    }

    // ====================================================
    // 운영자 전용 도구 (어드민 모드에서만 의미 있음)
    // ====================================================

    case 'list_callback_requests': {
      const status = data.status || 'pending';
      const tasks = store.scheduledTasks.all()
        .filter((t) => t.type === 'callback_request' && t.status === status);
      return {
        ok: true,
        message: `${tasks.length}건의 ${status === 'pending' ? '처리 대기' : '완료된'} 연락 요청`,
        card: {
          icon: '📋',
          title: `${status === 'pending' ? '처리 대기' : '완료'} 연락 요청 (${tasks.length}건)`,
          rows: tasks.length === 0
            ? [['상태', '없음']]
            : tasks.slice(0, 10).map((t) => [
                `${t.leadName} (${t.urgency === 'urgent' ? '🚨' : '·'})`,
                `${t.method === 'phone' ? '📞' : t.method === 'email' ? '📨' : '💬'} ${t.contact} · ${t.topic || '주제 없음'}`,
              ]),
          footer: '어드민 대시보드에서 [지금 발송] 또는 [취소] 클릭 가능',
          tone: 'info',
        },
      };
    }

    case 'mark_task_done': {
      const t = store.scheduledTasks.byId(data.taskId);
      if (!t) return { ok: false, message: '해당 작업을 찾을 수 없습니다' };
      store.scheduledTasks.update(data.taskId, {
        status: 'done',
        resolvedAt: utils.nowIso(),
        resolveNote: data.note || '',
      });
      return {
        ok: true,
        message: `작업 처리 완료 (${t.leadName || t.subject || data.taskId})`,
        card: {
          icon: '✅',
          title: '처리 완료',
          rows: [
            ['작업', t.type],
            ['대상', t.leadName || t.leadEmail || '-'],
            data.note && ['메모', data.note],
          ].filter(Boolean),
          tone: 'success',
        },
      };
    }

    case 'summarize_chat': {
      const log = store.chatLogs.all().find((l) => l.sessionId === data.sessionId);
      if (!log) return { ok: false, message: `세션 ${data.sessionId}를 찾을 수 없습니다` };
      return {
        ok: true,
        message: `세션 ${data.sessionId} 요약`,
        card: {
          icon: '💬',
          title: `대화 요약: ${data.sessionId}`,
          rows: [
            ['시작', fmtDate(log.messages?.[0]?.at)],
            ['메시지 수', `${log.messages?.length || 0}건`],
            ['최근 사용자 메시지', (log.messages || []).filter((m) => m.role === 'user').slice(-1)[0]?.text?.slice(0, 120) || '-'],
          ],
          footer: '※ AI가 위 데이터를 기반으로 요약을 답변 본문에 작성합니다.',
          tone: 'info',
        },
      };
    }

    case 'update_lead_stage': {
      const lead = store.leads.byId(data.leadId);
      if (!lead) return { ok: false, message: '리드를 찾을 수 없습니다' };
      const valid = ['new', 'consult', 'quote', 'contract', 'won', 'lost'];
      if (!valid.includes(data.stage)) return { ok: false, message: '잘못된 단계 값' };
      store.leads.update(data.leadId, { status: data.stage });
      return {
        ok: true,
        message: `${lead.name} → ${data.stage}로 이동`,
        card: {
          icon: '🔀',
          title: '리드 단계 변경',
          rows: [
            ['리드', lead.name],
            ['이전', lead.status],
            ['변경', data.stage],
          ],
          tone: 'success',
        },
      };
    }

    default:
      return { ok: false, message: `알 수 없는 도구: ${tool}` };
  }
}

function fmtDate(iso) {
  if (!iso) return '-';
  try { return new Date(iso).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  catch { return iso; }
}

/* ============================================================
   💰 월 예산 모니터링 (정보 표시만, 차단은 안 함)
   ============================================================ */
let lastWarningAt = 0;
function checkBudgetWarning() {
  const log = store.usageLog.all();
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const monthlyCost = log
    .filter((e) => new Date(e.createdAt).getTime() >= monthStart)
    .reduce((s, e) => s + (e.cost_usd || 0), 0);

  // 한 달에 한 번씩 경고 (스팸 방지)
  const sinceLastWarn = Date.now() - lastWarningAt;
  if (sinceLastWarn < 30 * 60_000) return;

  if (monthlyCost >= LIMITS.monthlyBudgetUsd) {
    lastWarningAt = Date.now();
    if (window.showToast) window.showToast(`🚨 월 AI 비용 한도($${LIMITS.monthlyBudgetUsd}) 초과 — 현재 $${monthlyCost.toFixed(2)}`, 'error');
  } else if (monthlyCost >= LIMITS.monthlyBudgetUsd * 0.8) {
    lastWarningAt = Date.now();
    if (window.showToast) window.showToast(`⚠️ 월 AI 비용 80% 도달 — $${monthlyCost.toFixed(2)} / $${LIMITS.monthlyBudgetUsd}`, 'warning');
  }
}

/** Render a tool-result card in the chatbot panel */
function renderActionCard(card) {
  const tone = card.tone || 'info';
  const border = tone === 'success' ? 'var(--success)' : 'var(--cobalt)';
  const bg = tone === 'success' ? 'var(--success-soft)' : 'var(--cobalt-softer)';
  const el = document.createElement('div');
  el.className = 'chat-action-card';
  el.style.cssText = `
    background: ${bg};
    border-left: 3px solid ${border};
    border-radius: 10px;
    padding: 14px 16px;
    margin: 6px 0;
    font-size: 13px;
    align-self: stretch;
    animation: fade-in 240ms ease-out;
  `;
  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;font-weight:700;color:var(--ink-deep)">
      <span style="font-size:18px">${card.icon || '✓'}</span>
      <span>${escapeHtml(card.title || '')}</span>
    </div>
    ${card.rows?.length ? `
      <div style="margin-top:10px;display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12px">
        ${card.rows.map(([k, v]) => `
          <div style="color:var(--steel);font-weight:600">${escapeHtml(k)}</div>
          <div style="color:var(--ink)">${escapeHtml(v)}</div>
        `).join('')}
      </div>
    ` : ''}
    ${card.footer ? `<div style="margin-top:10px;font-size:11px;color:var(--steel);font-style:italic">${escapeHtml(card.footer)}</div>` : ''}
  `;
  body.appendChild(el);
  body.scrollTop = body.scrollHeight;
}

/* ============================================================
   💰 #2 대화 압축 — 6개 이상 메시지 쌓이면 오래된 것들 1줄로 요약
   ============================================================ */
const TOPIC_KEYWORDS = [
  '견적', '가격', '비용', '단가', '예산',
  '일정', '기간', '몇 주', '몇 개월',
  '계약', '결제', '인보이스', '잔금',
  'AI', '챗봇', 'RAG', '에이전트', '파인튜닝',
  '쇼핑몰', '플랫폼', '관리자', '대시보드',
  '레퍼런스', '케이스', '실적',
  '상담', '미팅', '문의',
];

function extractTopics(msgs) {
  const text = msgs.map((m) => m.text || '').join(' ').toLowerCase();
  const found = TOPIC_KEYWORDS.filter((k) => text.toLowerCase().includes(k.toLowerCase()));
  return found.slice(0, 5);
}

function compressHistory(messages) {
  if (messages.length < LIMITS.historyCompressFrom) return messages;
  const keep = LIMITS.historyKeepRecent;
  if (messages.length <= keep) return messages;
  const oldMsgs = messages.slice(0, messages.length - keep);
  const recent = messages.slice(-keep);
  const topics = extractTopics(oldMsgs);
  const summary = {
    role: 'user',
    text: `[이전 대화 ${oldMsgs.length}개 메시지 요약${topics.length ? ' — 다룬 주제: ' + topics.join(', ') : ''}]`,
  };
  return [summary, ...recent];
}

/* ============================================================
   🎯 #3 질문별 관련 케이스 힌트 — 키워드 매칭 Top 3 ID
   ============================================================ */
function pickRelevantCases(query, cases) {
  if (!query || !Array.isArray(cases) || cases.length === 0) return [];
  const q = query.toLowerCase();
  const words = q.split(/[\s,.!?·~()\[\]]+/).filter((w) => w.length >= 2);
  if (words.length === 0) return [];

  const scored = cases.map((c) => {
    const hay = [
      c.label, c.client, c.title, c.description,
      ...(c.tags || []), ...(c.features || []),
    ].filter(Boolean).join(' ').toLowerCase();
    let score = 0;
    for (const w of words) {
      if (hay.includes(w)) score += w.length;
    }
    return { c, score };
  });

  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => x.c.label || x.c.title || x.c.id)
    .filter(Boolean);
}

/* ============================================================
   Gemini call via Netlify Function — SSE streaming (Top 9)
   ============================================================ */
async function askGemini({ onToken, onToolCall, onToolResult } = {}) {
  const auth = store.auth.get();  // 어드민 로그인 상태면 운영자 모드
  const isAdmin = !!(auth && auth.email);

  // 💡 운영자 데이터(chatLogs/leads/scheduledTasks)는 더 이상 전송하지 않음 —
  //   서버가 Function Calling으로 직접 Netlify Blobs에서 조회 (토큰 -60%)
  const context = {
    cases: store.cases.all(),
    faqs: store.faqs.all(),
    pricing: store.pricing.get(),
    settings: store.settings.get(),
    posts: store.posts.all().filter((p) => p.published !== false).map((p) => ({
      title: p.title, excerpt: p.excerpt, published_at: p.published_at,
    })),
  };

  const cfg = store.chatConfig.get();
  const systemPromptExtra = cfg.systemPromptExtra || '';
  // 💰 대화 히스토리 — slice(12) 후 추가 압축 (#2)
  let messages = conversation.slice(-LIMITS.historyToSend).map((m) => ({ role: m.role, text: m.text }));
  messages = compressHistory(messages);

  // 🎯 #3 관련 케이스 힌트 — 사용자 마지막 질문 기준 Top 3 ID 추출
  // 시스템 프롬프트엔 전체 케이스가 있지만, 힌트로 AI 주의를 집중
  const userLast = messages.filter((m) => m.role === 'user').slice(-1)[0]?.text || '';
  const hints = pickRelevantCases(userLast, context.cases);
  if (hints.length && messages.length) {
    // 마지막 user 메시지 앞에 힌트 주입 (시스템 프롬프트 캐시 깨지 않음)
    const lastIdx = messages.length - 1;
    if (messages[lastIdx].role === 'user') {
      messages[lastIdx] = {
        role: 'user',
        text: `[관련 케이스 힌트: ${hints.join(', ')}]\n${messages[lastIdx].text}`,
      };
    }
  }

  const r = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
    body: JSON.stringify({ messages, context, systemPromptExtra, sessionId, auth, variant }),
  });
  if (!r.ok || !r.body) {
    const body = await r.text().catch(() => '');
    const e = new Error(`Chat API ${r.status}`);
    e.status = r.status;
    e.body = body;
    throw e;
  }

  // 🚀 SSE 파서
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let accumulated = '';
  let done = null;
  let errEvent = null;

  while (true) {
    const { done: readerDone, value } = await reader.read();
    if (readerDone) break;
    buffer += decoder.decode(value, { stream: true });

    // 이벤트 단위(\n\n) 파싱
    let sep;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const event = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const line = event.trim();
      if (!line.startsWith('data:')) continue;
      const dataStr = line.slice(5).trim();
      if (!dataStr) continue;
      try {
        const obj = JSON.parse(dataStr);
        if (obj.type === 'token') {
          accumulated += obj.text || '';
          onToken?.(obj.text || '', accumulated);
        } else if (obj.type === 'tool_call') {
          // 🛠 서버측 도구 호출 시작 — UX 인디케이터 (예: "[리드 검색 중...]")
          onToolCall?.(obj.name, obj.args);
        } else if (obj.type === 'tool_result') {
          // 🛠 도구 실행 결과 요약 (UI는 굳이 표시 안 해도 OK)
          onToolResult?.(obj.name, obj.summary);
        } else if (obj.type === 'done') {
          done = obj;
          if (obj.answer) accumulated = obj.answer;
        } else if (obj.type === 'error') {
          errEvent = obj;
        }
      } catch (e) {
        console.warn('[chatbot] SSE parse failed', e?.message);
      }
    }
  }

  if (errEvent) {
    const e = new Error(errEvent.error || 'stream error');
    e.detail = errEvent.detail;
    throw e;
  }
  // done이 누락된 경우(미정상 종료)에도 누적 텍스트는 반환
  return done || { answer: accumulated };
}

/* ============================================================
   🛡 클라이언트 안전망 — 사용자 메시지에서 직접 정보 추출
   Gemini가 503/끊김으로 응답 실패해도 PM에게 연락처가 손실되지 않도록
   ============================================================ */
function extractContactInfo(text) {
  if (!text || typeof text !== 'string') return {};
  const t = ' ' + text.replace(/[ ]/g, ' ') + ' ';

  // 전화번호: 010-XXXX-XXXX / 010 XXXX XXXX / 010XXXXXXXX
  const phoneRe = /(?:^|[^\d])(01[016789](?:[-\s]?\d{3,4})[-\s]?\d{4})(?:$|[^\d])/;
  const phoneMatch = t.match(phoneRe);
  const phone = phoneMatch ? phoneMatch[1].replace(/[-\s]/g, '') : null;

  // 이메일
  const emailMatch = t.match(/([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
  const email = emailMatch ? emailMatch[1] : null;

  // 이름 추출 — 우선순위 패턴
  // 흔한 어절·문장끝 표현 제외 (이름으로 오해하지 않게)
  const NAME_BLACKLIST = new Set([
    '이거', '저거', '그거', '이거야', '저거야',
    '내가', '제가', '저는', '나는', '우리',
    '네요', '해요', '됩니다', '입니다', '있어요',
    '안녕', '안녕하세요', '감사합니다', '고객님', '운영자',
    '미용실', '예약', '시스템', '견적', '상담', '연락', '전화',
  ]);
  const isValidName = (n) => n && n.length >= 2 && n.length <= 5 && !NAME_BLACKLIST.has(n);

  let name = null;
  const namePatterns = [
    /(?:^|\s)이름은\s*([가-힣]{2,5})/,
    /(?:^|\s)저는\s*([가-힣]{2,5})\s*(?:이고|이에요|입니다|이야|예요|이라고|라고)/,
    /(?:^|\s)제\s*이름은\s*([가-힣]{2,5})/,
    /(?:^|\s)([가-힣]{2,5})\s*(?:입니다|이에요|예요|입니당)(?:\s|\.|,|$)/,
    /(?:^|\s)([가-힣]{2,5})\s*(?:이라고|라고)\s*(?:해요|합니다|불러|불러주세요)/,
    /(?:^|\s)([가-힣]{2,5})\s+01[016789](?:[-\s]?\d{3,4})[-\s]?\d{4}/,
    /01[016789](?:[-\s]?\d{3,4})[-\s]?\d{4}\s+([가-힣]{2,5})(?:\s|$|[^가-힣])/,
  ];
  // 한국어 조사 후처리 — '박두용이고'/'박두용이야'/'박두용이에요' → '박두용'
  const stripJosa = (s) => s.replace(/(?:이고|이에요|입니다|입니당|이야|이라고|라고|이가|이를|에게|한테)$/, '');
  for (const re of namePatterns) {
    const m = t.match(re);
    if (!m) continue;
    const stripped = stripJosa(m[1]);
    if (isValidName(stripped)) { name = stripped; break; }
  }

  // 시간 표현 (preferredTime용) — "내일 오후 4시", "4시", "오전 10시 30분" 등
  const timeRe = /((?:오늘|내일|모레)?\s*(?:오전|오후|아침|점심|저녁|밤)?\s*\d{1,2}\s*시(?:\s*\d{1,2}\s*분)?)/;
  const timeMatch = text.match(timeRe);
  const time = timeMatch ? timeMatch[1].replace(/\s+/g, ' ').trim() : null;

  return { name, phone, email, time };
}

/* ============================================================
   Rule-based fallback (uses admin intents)
   ============================================================ */
function fallbackReply(question) {
  const cfg = store.chatConfig.get();
  const intents = cfg.intents || [];
  const lower = question.toLowerCase();

  let best = null;
  let bestScore = 0;
  for (const intent of intents) {
    let score = 0;
    for (const p of intent.patterns || []) {
      if (lower.includes(p.toLowerCase())) score += p.length;
    }
    if (score > bestScore) { bestScore = score; best = intent; }
  }
  if (best) {
    let answer = best.answer;
    if (best.links?.length) {
      const linkHints = best.links.map((l) => `[${l.label}](${l.href})`).join(' · ');
      answer += `\n\n${linkHints}`;
    }
    return answer;
  }
  return cfg.fallback || '죄송합니다. 다시 한 번 질문해 주시겠어요?';
}

/* ============================================================
   Send flow
   ============================================================ */
async function send(question) {
  const q = (question ?? input.value).trim();
  if (!q || sending) return;

  // 🛡 안전장치 1: 대화 턴 수 제한
  if (conversation.length >= LIMITS.conversationTurns * 2) {
    bubble(`⚠️ 대화가 너무 길어졌습니다 (${LIMITS.conversationTurns}턴 초과). 페이지를 새로고침해 새 세션을 시작해 주세요.`, 'bot');
    return;
  }

  // 🛡 안전장치 2: 분당 API 호출 제한 (rate limit)
  const oneMinuteAgo = Date.now() - 60_000;
  while (apiCallTimes.length && apiCallTimes[0] < oneMinuteAgo) apiCallTimes.shift();
  if (apiCallTimes.length >= LIMITS.apiCallsPerMinute) {
    bubble(`⚠️ 분당 호출 한도(${LIMITS.apiCallsPerMinute}회)에 도달했습니다. 잠시 후 다시 시도해 주세요.`, 'bot');
    return;
  }

  // 💰 #5(a) 세션 비용 하드캡 — 누적 비용이 임계 넘으면 자동 PM 상담 유도
  // 운영자는 면제 (어드민 작업 비용 정상)
  const _auth = store.auth.get();
  const _isAdmin = !!(_auth && _auth.email);
  if (!_isAdmin && sessionCostUsd >= LIMITS.sessionCostHardUsd) {
    conversation.push({ role: 'user', text: question ?? input.value, at: utils.nowIso() });
    bubble(question ?? input.value, 'user');
    const msg = `이 세션의 AI 응답이 충분히 길어졌습니다 😊\n\n` +
      `더 정확한 답변을 위해 박두용 PM이 직접 안내드리는 게 좋을 것 같아요. ` +
      `[30분 무료 상담 신청](/#contact) 부탁드립니다. ` +
      `또는 010-2807-5242로 직접 연락주셔도 됩니다.`;
    const el = bubble('', 'bot', true);
    streamInto(el, msg, 14);
    conversation.push({ role: 'bot', text: msg, at: utils.nowIso() });
    persistLog();
    input.value = '';
    return;
  }

  sending = true;
  input.value = '';

  conversation.push({ role: 'user', text: q, at: utils.nowIso() });
  bubble(q, 'user');

  if (suggestionsEl) suggestionsEl.style.display = 'none';

  // 💰 비용 절감 #1 — 단순 인사/감사는 Gemini 호출 없이 즉시 응답
  const auth = store.auth.get();
  const isAdmin = !!(auth && auth.email);
  if (!isAdmin) {  // 운영자 모드에서는 폴백 사용 안 함 (도구 호출 가능성 있음)
    const shortReply = tryShortFallback(q);
    if (shortReply) {
      const el = bubble('', 'bot');
      await streamInto(el, shortReply, 12);
      conversation.push({ role: 'bot', text: shortReply, at: utils.nowIso() });
      persistLog();
      sending = false;
      return;
    }
    // 💰 #4 Frozen Response 매칭 — Gemini 호출 0
    const frozenReply = tryFrozenResponse(q);
    if (frozenReply) {
      const el = bubble('', 'bot');
      await streamInto(el, frozenReply, 14);
      conversation.push({ role: 'bot', text: frozenReply, at: utils.nowIso() });
      persistLog();
      sending = false;
      return;
    }
  }

  const typingEl = typingIndicator();
  let rawAnswer = '';
  let usedFallback = false;
  let autoExtractedFallback = null; // 안전망 자동 추출 성공 시 정보 보관

  let geminiRes = null;
  const lastRendered = { value: '' };
  try {
    apiCallTimes.push(Date.now());
    geminiRes = await askGemini({
      onToken: (_chunk, accumulated) => {
        // 🚀 실시간 토큰 페인팅 (action 블록은 자동 숨김)
        paintStreamingBubble(typingEl, accumulated, lastRendered);
      },
      onToolCall: (name) => {
        // 🛠 도구 실행 중 UX 인디케이터
        const labels = {
          leads_find: '🔍 리드 검색 중',
          leads_list: '📋 리드 목록 조회 중',
          leads_update: '✏️ 리드 정보 수정 중',
          leads_stats: '📊 리드 통계 계산 중',
          tasks_list: '📋 작업 큐 조회 중',
          tasks_update: '✏️ 작업 상태 변경 중',
          chatlogs_search: '🔍 대화 로그 검색 중',
          chatlogs_get: '💬 대화 세션 조회 중',
          cases_find: '📚 레퍼런스 검색 중',
          cases_list: '📚 케이스 목록 조회 중',
          faqs_find: '❓ FAQ 검색 중',
          quotes_list: '📄 견적 목록 조회 중',
        };
        const label = labels[name] || `🛠 ${name} 실행 중`;
        typingEl.innerHTML = `<span style="color:var(--steel);font-style:italic;font-size:12px">${label}…</span>`;
        body.scrollTop = body.scrollHeight;
      },
    });
    rawAnswer = (geminiRes?.answer || '').trim();
    if (!rawAnswer) throw new Error('빈 응답');

    // 📊 사용량 누적
    if (geminiRes.tokens || geminiRes.cost_usd != null) {
      store.usageLog.add({
        model: geminiRes.model,
        tier: geminiRes.routing?.tier,
        reason: geminiRes.routing?.reason,
        tokens_in: geminiRes.tokens?.in || 0,
        tokens_out: geminiRes.tokens?.out || 0,
        tokens_cached: geminiRes.tokens?.cached || 0,  // #1 Implicit Cache 적중 추적
        cost_usd: geminiRes.cost_usd || 0,
        sessionId,
        variant,
      });
      // 한도 임박 경고
      checkBudgetWarning();
      // 💰 #5(a) 세션 비용 누적
      sessionCostUsd += geminiRes.cost_usd || 0;
      if (!sessionCostWarned && sessionCostUsd >= LIMITS.sessionCostSoftUsd) {
        sessionCostWarned = true;
        console.warn(`[chatbot] 세션 비용 ${sessionCostUsd.toFixed(4)}USD — 소프트 캡(${LIMITS.sessionCostSoftUsd}) 도달`);
      }
    }
  } catch (e) {
    console.warn('[chatbot] Gemini failed, using fallback', e);
    rawAnswer = fallbackReply(q);
    usedFallback = true;

    // 🛡 안전망: 사용자 마지막 3개 메시지에서 직접 정보 추출
    // contact(전화/이메일)만 있어도 콜백 요청 등록 (이름은 후속 1턴 요청)
    try {
      const recentUserText = conversation
        .filter((m) => m.role === 'user')
        .slice(-3)
        .map((m) => m.text)
        .join(' ') + ' ' + q;
      const info = extractContactInfo(recentUserText);
      const contact = info.phone || info.email;

      if (contact) {
        const method = info.phone ? 'phone' : 'email';
        const leadName = info.name || '(이름 미기재)';
        store.scheduledTasks.add({
          type: 'callback_request',
          leadName,
          contact,
          method,
          preferredTime: info.time || '',
          topic: info.name
            ? '챗봇 상담 (AI 응답 실패 시 자동 추출)'
            : '챗봇 상담 (이름 미기재 — 추가 확인 필요)',
          urgency: 'normal',
          status: 'pending',
          scheduledAt: new Date().toISOString(),
          sessionId,
          aiSubmitted: true,
          autoExtracted: true,
          needsNameFollowup: !info.name, // 어드민이 식별 — 이름 후속 확인 필요
        });
        autoExtractedFallback = {
          name: info.name || null,
          contact,
          method,
          preferredTime: info.time,
        };
        // 이름이 있으면 완전한 확인, 없으면 이름 추가 요청
        rawAnswer = info.name
          ? `✅ ${info.name}님, 박두용 PM에게 정확히 전달했습니다 (${contact}${info.time ? ` · ${info.time} 연락 요청` : ''}). 곧 직접 연락드릴게요!`
          : `✅ 연락처 받았습니다 (${contact}${info.time ? ` · ${info.time} 연락 요청` : ''}). PM이 연락드릴 때 호칭하기 좋게 **성함**도 알려주시겠어요?`;
      }
    } catch (extractErr) {
      console.warn('[chatbot] auto-extract failed', extractErr);
    }
  }

  // 🤖 Parse and execute agent actions
  const { actions, cleanText } = extractActions(rawAnswer);

  // 최종 본문 렌더 — 스트림 완료 후 정리된 텍스트로 덮어씀
  // (fallback 시에는 simulated typing, 정상 스트림 시에는 이미 그려져 있음)
  typingEl.classList.remove('typing');
  if (usedFallback) {
    typingEl.innerHTML = '';
    await streamInto(typingEl, cleanText || rawAnswer);
  } else {
    typingEl.innerHTML = fmtAnswer(cleanText || rawAnswer);
    body.scrollTop = body.scrollHeight;
  }

  // Then execute each tool and render result card
  for (const action of actions) {
    try {
      const result = await executeAction(action);
      if (result.card) renderActionCard(result.card);
      if (!result.ok) {
        bubble(`⚠️ ${result.message}`, 'bot');
        conversation.push({ role: 'bot', text: `⚠️ ${result.message}`, at: utils.nowIso() });
      }
    } catch (e) {
      console.error('[agent] execution failed', e);
      bubble(`⚠️ 작업 실행 중 오류: ${e.message}`, 'bot');
    }
  }

  // 🛡 안전망 자동 추출 성공 → 결과 카드 렌더 (AI가 도구 호출한 것처럼)
  if (autoExtractedFallback) {
    const methodKr = { phone: '📞 전화', email: '📨 이메일' }[autoExtractedFallback.method] || autoExtractedFallback.method;
    renderActionCard({
      icon: '✅',
      title: 'PM 연락 요청 (자동 등록)',
      rows: [
        ['이름', autoExtractedFallback.name],
        ['방법', methodKr],
        ['연락처', autoExtractedFallback.contact],
        autoExtractedFallback.preferredTime && ['선호 시간', autoExtractedFallback.preferredTime],
      ].filter(Boolean),
      footer: '✓ 박두용 PM에게 전달했습니다. 가능한 시간대에 연락드리겠습니다.',
      tone: 'success',
    });
  } else if (usedFallback) {
    // 안전망도 실패한 진짜 fallback — 사용자에게 친화 안내
    const note = document.createElement('div');
    note.style.cssText = 'margin-top:6px;font-size:10px;color:var(--steel);font-style:italic';
    note.textContent = '※ AI 응답이 잠시 지연됐어요. 1분 뒤 다시 질문해주시면 정확하게 안내드릴게요.';
    typingEl.appendChild(note);
  }

  conversation.push({ role: 'bot', text: rawAnswer, at: utils.nowIso() });
  persistLog();
  sending = false;
}

function persistLog() {
  const all = store.chatLogs.all();
  const idx = all.findIndex((l) => l.sessionId === sessionId);
  const entry = {
    sessionId,
    messages: conversation,
    variant,
    updatedAt: utils.nowIso(),
  };
  if (idx >= 0) store.chatLogs.update(all[idx].id, entry);
  else store.chatLogs.add({ ...entry, id: utils.uid('chat') });
}

/* ============================================================
   Open/close
   ============================================================ */
function openPanel() {
  if (isOpen) return;
  panel.classList.add('open');
  fab.style.display = 'none';
  isOpen = true;
  if (body.children.length === 0) {
    const auth = store.auth.get();
    const isAdmin = !!(auth && auth.email);
    let greet;

    if (isAdmin) {
      // 🔑 운영자 모드 인사 — 처리 필요 항목 자동 요약
      const tasks = store.scheduledTasks.all();
      const callbacks = tasks.filter((t) => t.type === 'callback_request' && t.status === 'pending');
      const urgentCallbacks = callbacks.filter((t) => t.urgency === 'urgent').length;
      const followups = tasks.filter((t) => t.type === 'followup_email' && t.status === 'pending');
      const dueFollowups = followups.filter((t) => new Date(t.scheduledAt).getTime() <= Date.now()).length;
      const newLeads = store.leads.all().filter((l) => l.status === 'new').length;

      greet = `안녕하세요 ${auth.name || auth.email} 님 👋\n\n오늘 처리 필요 항목:\n` +
        `📞 PM 통화 요청 **${callbacks.length}건** ${urgentCallbacks ? `(🚨 긴급 ${urgentCallbacks}건)` : ''}\n` +
        `📨 발송 가능 follow-up **${dueFollowups}건** (대기 ${followups.length - dueFollowups}건)\n` +
        `🔔 신규 리드 **${newLeads}건**\n\n` +
        `"오늘 통화 요청 보여줘", "김민수 대화 요약해줘", "신규 리드 모두 상담 단계로 이동해줘" 같이 요청하세요.`;

      // 챗봇 헤더에 운영자 모드 표시
      const statusEl = panel.querySelector('.chatbot-header .status');
      if (statusEl) statusEl.textContent = '🔑 운영자 모드 · Gemini 3.0 Flash';
      const nameEl = panel.querySelector('.chatbot-header .name');
      if (nameEl) nameEl.textContent = `${auth.name || '운영자'} 어시스턴트`;
    } else {
      const cfg = store.chatConfig.get();
      greet = cfg.greeting ||
        '안녕하세요! 함께워크_SI AI 에이전트입니다. 질문도 좋고, "대신 상담 신청해줘" 식으로 부탁하셔도 됩니다.';
    }

    bubble(greet, 'bot');
    conversation.push({ role: 'bot', text: greet, at: utils.nowIso() });
  }
  setTimeout(() => input?.focus(), 350);
}
function closePanel() {
  panel.classList.remove('open');
  fab.style.display = 'inline-flex';
  isOpen = false;
}

/* ============================================================
   💾 대화 저장 기능 — 사용자가 상담 내역을 보관할 수 있게
   - 파일 다운로드 (.txt)
   - 클립보드 복사
   - 이메일로 받기 (mailto:)
   ============================================================ */
function formatConversationAsText() {
  const lines = [];
  const settings = store.settings.get() || {};
  const brand = settings.brand || '함께워크_SI';
  const phone = settings.phone || '';
  const email = settings.email || '';
  const pm = settings.pm || '박두용';
  const dateStr = new Date().toLocaleString('ko-KR');

  lines.push('──────────────────────────────');
  lines.push(`${brand} AI 상담 내역`);
  lines.push(`저장 시각: ${dateStr}`);
  lines.push(`세션 ID: ${sessionId}`);
  lines.push('──────────────────────────────');
  lines.push('');

  for (const m of conversation) {
    const role = m.role === 'user' ? '👤 본인' : '🤖 함께워크 AI';
    const time = m.at
      ? new Date(m.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
      : '';
    // ```action JSON 블록은 내부 도구 호출이라 사용자 저장본에선 제거
    const cleaned = String(m.text || '')
      .replace(/```action[\s\S]*?```/g, '')
      .trim();
    if (!cleaned) continue;
    lines.push(`[${time}] ${role}`);
    lines.push(cleaned);
    lines.push('');
  }

  lines.push('──────────────────────────────');
  lines.push(`추가 상담 — ${pm} PM`);
  if (phone) lines.push(`📞 ${phone}`);
  if (email) lines.push(`📧 ${email}`);
  lines.push(`🌐 ${location.origin}/#contact`);
  lines.push('──────────────────────────────');
  return lines.join('\n');
}

function downloadConversation() {
  const text = formatConversationAsText();
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const dateStr = new Date().toISOString().slice(0, 10);
  a.download = `함께워크_SI_상담내역_${dateStr}.txt`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 100);
  window.showToast?.('상담 내역 파일이 저장되었습니다');
}

async function copyConversation() {
  const text = formatConversationAsText();
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    // fallback: textarea select + execCommand
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
  }
  window.showToast?.(ok ? '클립보드에 복사되었습니다' : '복사에 실패했어요');
}

function emailConversation() {
  const text = formatConversationAsText();
  const subject = encodeURIComponent(`${store.settings.get()?.brand || '함께워크_SI'} AI 상담 내역`);
  // mailto body는 URL encoding 길이 제한이 있어 본문이 너무 길면 잘릴 수 있음. 대화 30턴 정도면 OK.
  const body = encodeURIComponent(text.slice(0, 8000));
  window.location.href = `mailto:?subject=${subject}&body=${body}`;
}

function initSaveMenu() {
  const closeBtnEl = document.getElementById('chatbotClose');
  if (!closeBtnEl || document.getElementById('chatbotSaveBtn')) return;

  const saveBtn = document.createElement('button');
  saveBtn.id = 'chatbotSaveBtn';
  saveBtn.className = 'chatbot-save';
  saveBtn.setAttribute('aria-label', '상담 내역 저장');
  saveBtn.title = '상담 내역 저장';
  saveBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>`;
  closeBtnEl.parentNode.insertBefore(saveBtn, closeBtnEl);

  const menu = document.createElement('div');
  menu.id = 'chatbotSaveMenu';
  menu.className = 'chatbot-save-menu';
  menu.innerHTML = `
    <button type="button" data-act="download"><span>📄</span> 파일로 저장 (.txt)</button>
    <button type="button" data-act="copy"><span>📋</span> 클립보드에 복사</button>
    <button type="button" data-act="email"><span>📧</span> 이메일로 받기</button>
  `;
  panel.appendChild(menu);

  saveBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (conversation.length === 0) {
      window.showToast?.('저장할 대화가 없습니다');
      return;
    }
    menu.classList.toggle('open');
  });

  menu.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    menu.classList.remove('open');
    if (act === 'download') downloadConversation();
    else if (act === 'copy') copyConversation();
    else if (act === 'email') emailConversation();
  });

  // 패널 밖 클릭 시 메뉴 닫기
  document.addEventListener('click', (e) => {
    if (!menu.classList.contains('open')) return;
    if (e.target.closest('#chatbotSaveBtn') || e.target.closest('#chatbotSaveMenu')) return;
    menu.classList.remove('open');
  });
}

function wire() {
  if (!fab) return;
  fab.addEventListener('click', openPanel);
  closeBtn?.addEventListener('click', closePanel);
  sendBtn?.addEventListener('click', () => send());
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
    if (e.key === 'Escape') closePanel();
  });
  suggestionsEl?.querySelectorAll('.chat-suggestion').forEach((btn) => {
    btn.addEventListener('click', () => send(btn.textContent.trim()));
  });
  initSaveMenu();
}

document.addEventListener('DOMContentLoaded', wire);
