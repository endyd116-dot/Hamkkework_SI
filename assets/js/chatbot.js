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
    if (leadCreatedInSession) return '이미 한 번 신청이 접수되었습니다 (세션당 1건 제한)';
    const since = Date.now() - lastLeadAt;
    if (since < 60 * 1000) return '60초 이내에 다시 신청할 수 없습니다';
  }
  if (tool === 'navigate') {
    const valid = ['hero', 'who', 'pain', 'promise', 'why', 'pricing', 'cases', 'process', 'team', 'faq', 'contact'];
    if (!valid.includes(data.target)) return '잘못된 섹션 이름입니다';
  }
  return null;
}

/** Execute a single tool call. Returns { ok, message, card? } */
async function executeAction(action) {
  const err = validateAction(action);
  if (err) return { ok: false, message: err };

  const { tool, data = {} } = action;

  switch (tool) {
    // ====================================================
    // 1. create_lead — DB CRUD: directly insert into admin
    // ====================================================
    case 'create_lead': {
      const lead = store.leads.add({
        name: data.name?.trim() || '',
        email: data.email?.trim() || '',
        company: data.company?.trim() || '',
        phone: data.phone?.trim() || '',
        type: data.type?.trim() || '아직 정해지지 않음',
        budget: data.budget?.trim() || '정해지지 않음 / 견적 받고 결정',
        message: (data.message?.trim() || '') + `\n\n[챗봇 AI 자동 등록 · 세션 ${sessionId}]`,
        status: 'new',
        source: 'chatbot-ai',
        aiSubmitted: true,
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
      window.dispatchEvent(new CustomEvent('calc:setState', {
        detail: {
          pages_simple: data.pages_simple ?? 0,
          pages_complex: data.pages_complex ?? 0,
          mod_basic: data.mod_basic ?? 0,
          mod_advanced: data.mod_advanced ?? 0,
          integrations: data.integrations ?? 0,
          ai: data.ai || {},
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

    default:
      return { ok: false, message: `알 수 없는 도구: ${tool}` };
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
   Gemini call via Netlify Function
   ============================================================ */
async function askGemini() {
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
  const messages = conversation.map((m) => ({ role: m.role, text: m.text }));

  const r = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, context, systemPromptExtra, sessionId }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    const e = new Error(`Chat API ${r.status}`);
    e.status = r.status;
    e.body = body;
    throw e;
  }
  return await r.json();
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
  sending = true;
  input.value = '';

  conversation.push({ role: 'user', text: q, at: utils.nowIso() });
  bubble(q, 'user');

  if (suggestionsEl) suggestionsEl.style.display = 'none';

  const typingEl = typingIndicator();
  let rawAnswer = '';
  let usedFallback = false;

  try {
    const res = await askGemini();
    rawAnswer = (res?.answer || '').trim();
    if (!rawAnswer) throw new Error('빈 응답');
  } catch (e) {
    console.warn('[chatbot] Gemini failed, using fallback', e);
    rawAnswer = fallbackReply(q);
    usedFallback = true;
  }

  // 🤖 Parse and execute agent actions
  const { actions, cleanText } = extractActions(rawAnswer);

  // First render the text bubble (cleaned)
  typingEl.classList.remove('typing');
  typingEl.innerHTML = '';
  await streamInto(typingEl, cleanText || rawAnswer);

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

  if (usedFallback) {
    const note = document.createElement('div');
    note.style.cssText = 'margin-top:6px;font-size:10px;color:var(--steel);font-style:italic';
    note.textContent = '※ 오프라인 응답 (Gemini 미연결)';
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
    const cfg = store.chatConfig.get();
    const greet = cfg.greeting ||
      '안녕하세요! 함께워크_SI AI 에이전트입니다. 질문도 좋고, "대신 상담 신청해줘" 식으로 부탁하셔도 됩니다.';
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
}

document.addEventListener('DOMContentLoaded', wire);
