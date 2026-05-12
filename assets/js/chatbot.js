/**
 * AI chatbot widget (rule-based RAG-lite for demo)
 * - Reads chatConfig from store (admin can edit intents)
 * - Falls back gracefully when no intent matches
 * - Logs conversations to store.chatLogs (admin can review)
 */

import { store, utils } from './store.js';

const fab = document.getElementById('chatbotFab');
const panel = document.getElementById('chatbotPanel');
const closeBtn = document.getElementById('chatbotClose');
const body = document.getElementById('chatbotBody');
const input = document.getElementById('chatInput');
const sendBtn = document.getElementById('chatSend');
const suggestionsEl = document.getElementById('chatSuggestions');

let conversation = [];
let sessionId = utils.uid('s');
let isOpen = false;

function escapeHtml(s) {
  return (s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function bubble(text, who = 'bot', links = []) {
  const el = document.createElement('div');
  el.className = `chat-bubble ${who}`;
  el.innerHTML = escapeHtml(text).replace(/\n/g, '<br>');
  if (links?.length) {
    const linkRow = document.createElement('div');
    linkRow.style.cssText = 'margin-top:8px;display:flex;gap:6px;flex-wrap:wrap';
    links.forEach((l) => {
      const a = document.createElement('a');
      a.href = l.href;
      a.textContent = l.label;
      a.className = 'chat-suggestion';
      a.style.cssText = 'font-size:11px;padding:4px 10px;';
      a.addEventListener('click', () => closePanel());
      linkRow.appendChild(a);
    });
    el.appendChild(linkRow);
  }
  body.appendChild(el);
  body.scrollTop = body.scrollHeight;
  return el;
}

function typing() {
  const el = document.createElement('div');
  el.className = 'chat-bubble bot typing';
  el.innerHTML = '<span></span><span></span><span></span>';
  body.appendChild(el);
  body.scrollTop = body.scrollHeight;
  return el;
}

function matchIntent(q) {
  const cfg = store.chatConfig.get();
  const intents = cfg.intents || [];
  const lower = q.toLowerCase();

  let best = null;
  let bestScore = 0;
  for (const intent of intents) {
    let score = 0;
    for (const p of intent.patterns || []) {
      if (lower.includes(p.toLowerCase())) score += p.length;
    }
    if (score > bestScore) {
      bestScore = score;
      best = intent;
    }
  }
  return best;
}

function reply(question) {
  conversation.push({ role: 'user', text: question, at: utils.nowIso() });
  bubble(question, 'user');

  const t = typing();
  setTimeout(() => {
    t.remove();
    const intent = matchIntent(question);
    let answer, links = [];
    if (intent) {
      answer = intent.answer;
      links = intent.links || [];
    } else {
      const cfg = store.chatConfig.get();
      answer = cfg.fallback || '죄송합니다. 다시 한 번 질문해 주시겠어요?';
    }
    bubble(answer, 'bot', links);
    conversation.push({ role: 'bot', text: answer, at: utils.nowIso() });
    persistLog();
  }, 600 + Math.random() * 500);
}

function persistLog() {
  // upsert by sessionId
  const all = store.chatLogs.all();
  const idx = all.findIndex((l) => l.sessionId === sessionId);
  const entry = {
    id: idx >= 0 ? all[idx].id : utils.uid('chat'),
    sessionId,
    messages: conversation,
    updatedAt: utils.nowIso(),
  };
  if (idx >= 0) store.chatLogs.update(all[idx].id, entry);
  else store.chatLogs.add(entry);
}

function send() {
  const v = input.value.trim();
  if (!v) return;
  input.value = '';
  reply(v);
}

function openPanel() {
  if (isOpen) return;
  panel.classList.add('open');
  fab.style.display = 'none';
  isOpen = true;
  if (body.children.length === 0) {
    const cfg = store.chatConfig.get();
    bubble(cfg.greeting || '안녕하세요! 무엇이 궁금하신가요?', 'bot');
    conversation.push({ role: 'bot', text: cfg.greeting, at: utils.nowIso() });
  }
  setTimeout(() => input.focus(), 350);
}
function closePanel() {
  panel.classList.remove('open');
  fab.style.display = 'inline-flex';
  isOpen = false;
}

function wire() {
  if (!fab) return;
  fab.addEventListener('click', openPanel);
  closeBtn.addEventListener('click', closePanel);
  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') send();
    if (e.key === 'Escape') closePanel();
  });
  suggestionsEl?.querySelectorAll('.chat-suggestion').forEach((btn) => {
    btn.addEventListener('click', () => {
      input.value = btn.textContent.trim();
      send();
    });
  });
}

document.addEventListener('DOMContentLoaded', wire);
