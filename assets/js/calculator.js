/**
 * Pricing calculator
 * - Live total + range
 * - Sparkline for cumulative quotes (persisted in localStorage)
 * - Push quote → lead form hidden field
 */

import { store } from './store.js';

const fmt = (n) => Math.round(n).toLocaleString('ko-KR');

const state = {
  pages_simple: 5,
  pages_complex: 3,
  mod_basic: 2,
  mod_advanced: 1,
  integrations: 1,
  ai: { llm_simple: false, rag: false, agent: false, finetune: false },
};

let rates = {
  pages_simple: 30,
  pages_complex: 80,
  mod_basic: 200,
  mod_advanced: 500,
  integrations: 300,
  ai: { llm_simple: 200, rag: 1200, agent: 1800, finetune: 2500 },
  overhead_ratio: 0.25,
  range_ratio: 0.15,
};

function loadRates() {
  const r = store.pricing.get();
  if (r && Object.keys(r).length) {
    rates = { ...rates, ...r, ai: { ...rates.ai, ...(r.ai || {}) } };
  }
}

function calculate() {
  const pages = state.pages_simple * rates.pages_simple + state.pages_complex * rates.pages_complex;
  const modules = state.mod_basic * rates.mod_basic + state.mod_advanced * rates.mod_advanced;
  const integ = state.integrations * rates.integrations;
  const ai = Object.keys(state.ai).reduce(
    (sum, k) => sum + (state.ai[k] ? rates.ai[k] || 0 : 0),
    0
  );
  const sub = pages + modules + integ + ai;
  const overhead = sub * (rates.overhead_ratio ?? 0.25);
  const total = sub + overhead;
  const r = rates.range_ratio ?? 0.15;
  return { pages, modules, integ, ai, sub, overhead, total, lo: total * (1 - r), hi: total * (1 + r) };
}

function render() {
  const c = calculate();
  document.getElementById('bd_pages').textContent = `${fmt(c.pages)} 만`;
  document.getElementById('bd_modules').textContent = `${fmt(c.modules)} 만`;
  document.getElementById('bd_integ').textContent = `${fmt(c.integ)} 만`;
  document.getElementById('bd_ai').textContent = `${fmt(c.ai)} 만`;
  document.getElementById('bd_overhead').textContent = `${fmt(c.overhead)} 만`;
  document.getElementById('total_val').textContent = fmt(c.total);
  const pct = Math.round((rates.range_ratio ?? 0.15) * 100);
  document.getElementById('range_text').textContent =
    `실 견적 범위: ${fmt(c.lo)}만 ~ ${fmt(c.hi)}만 (±${pct}%)`;

  const quoteHidden = document.getElementById('lf_quote');
  if (quoteHidden) {
    quoteHidden.value = JSON.stringify({ ...state, total: Math.round(c.total) });
  }

  pushSparkPoint(c.total);
}

/* Sparkline trail of recent quote totals */
const sparkHistory = [];
function pushSparkPoint(total) {
  sparkHistory.push(total);
  if (sparkHistory.length > 40) sparkHistory.shift();
  drawSpark();
}

function drawSpark() {
  const line = document.getElementById('sparkLine');
  const fill = document.getElementById('sparkFill');
  if (!line || sparkHistory.length < 2) return;
  const W = 320,
    H = 36,
    PAD = 2;
  const lo = Math.min(...sparkHistory);
  const hi = Math.max(...sparkHistory);
  const range = hi - lo || 1;
  const pts = sparkHistory.map((v, i) => {
    const x = (i / (sparkHistory.length - 1)) * (W - PAD * 2) + PAD;
    const y = H - PAD - ((v - lo) / range) * (H - PAD * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  line.setAttribute('points', pts.join(' '));
  fill.setAttribute('points', `${PAD},${H} ${pts.join(' ')} ${W - PAD},${H}`);
}

/* ============================================================
   Wire up DOM
   ============================================================ */
function wireControls() {
  document.querySelectorAll('.calc-num').forEach((btn) => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.target;
      const act = btn.dataset.act;
      if (act === 'inc') state[t] = Math.min(99, (state[t] || 0) + 1);
      else state[t] = Math.max(0, (state[t] || 0) - 1);
      const el = document.getElementById('val_' + t);
      if (el) el.textContent = state[t];
      render();
    });
  });

  document.querySelectorAll('.calc-check').forEach((lab) => {
    const cb = lab.querySelector('input');
    const k = lab.dataset.ai;
    lab.addEventListener('click', (e) => {
      if (e.target.tagName !== 'INPUT') {
        cb.checked = !cb.checked;
      }
      state.ai[k] = cb.checked;
      lab.classList.toggle('on', cb.checked);
      render();
    });
  });

  const quoteBtn = document.getElementById('quoteToLeadBtn');
  if (quoteBtn) {
    quoteBtn.addEventListener('click', () => {
      // smooth scroll handled by browser; ensure quote is up-to-date
      render();
      // toast hint
      setTimeout(() => {
        if (window.showToast) window.showToast('견적이 상담 폼에 자동 첨부되었습니다');
      }, 350);
    });
  }
}

export function bootCalculator() {
  loadRates();
  wireControls();
  render();
}

document.addEventListener('DOMContentLoaded', bootCalculator);
