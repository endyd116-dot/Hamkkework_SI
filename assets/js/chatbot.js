/**
 * AI chatbot widget — Gemini-powered with platform RAG context.
 *
 * Flow:
 *  1. User asks a question
 *  2. Frontend collects: full conversation + current platform state (cases/FAQs/pricing) from store
 *  3. POSTs to /api/chat (Netlify Function → Gemini 3.0 Flash)
 *  4. Renders answer with typing animation
 *  5. Falls back to admin-configured intent rules if API fails
 *  6. Logs conversation to store.chatLogs (admin can review)
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
  // Bold **text**
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  // Inline links [label](url)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
    const safeHref = href.replace(/"/g, '&quot;');
    return `<a href="${safeHref}" style="color:var(--cobalt);text-decoration:underline;font-weight:600">${escapeHtml(label)}</a>`;
  });
  // Line breaks
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

/** Stream the text into the bubble for nicer UX (perceived streaming) */
function streamInto(el, fullText, speed = 14) {
  return new Promise((resolve) => {
    const html = fmtAnswer(fullText);
    // For mixed HTML, we can't naively cut characters. Strategy:
    //  - Render incrementally by character on plain text, then swap to HTML at end
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
   Gemini call via Netlify Function
   ============================================================ */
async function askGemini() {
  // Build platform context snapshot from store
  const context = {
    cases: store.cases.all(),
    faqs: store.faqs.all(),
    pricing: store.pricing.get(),
    settings: store.settings.get(),
    posts: store.posts.all().filter((p) => p.published !== false).map((p) => ({
      title: p.title, excerpt: p.excerpt, published_at: p.published_at,
    })),
  };

  // Admin-customizable system prompt addendum (optional)
  const cfg = store.chatConfig.get();
  const systemPromptExtra = cfg.systemPromptExtra || '';

  // Send full conversation history
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

  // Hide suggestions after first message
  if (suggestionsEl) suggestionsEl.style.display = 'none';

  const typingEl = typingIndicator();
  let answer = '';
  let usedFallback = false;

  try {
    const res = await askGemini();
    answer = (res?.answer || '').trim();
    if (!answer) throw new Error('빈 응답');
  } catch (e) {
    console.warn('[chatbot] Gemini failed, using fallback', e);
    answer = fallbackReply(q);
    usedFallback = true;
  }

  // swap typing → empty bubble → stream text in
  typingEl.classList.remove('typing');
  typingEl.innerHTML = '';
  await streamInto(typingEl, answer);

  if (usedFallback) {
    const note = document.createElement('div');
    note.style.cssText = 'margin-top:6px;font-size:10px;color:var(--steel);font-style:italic';
    note.textContent = '※ 오프라인 응답 (Gemini 미연결)';
    typingEl.appendChild(note);
  }

  conversation.push({ role: 'bot', text: answer, at: utils.nowIso() });
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
    const greet = cfg.greeting || '안녕하세요! 함께워크_SI AI 상담입니다. 무엇이 궁금하신가요?';
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
