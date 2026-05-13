/**
 * Pricing calculator
 * - Live total + range
 * - Sparkline for cumulative quotes (persisted in localStorage)
 * - Push quote → lead form hidden field
 */

import { store, DEFAULT_QUALITY_TIERS } from './store.js';

const fmt = (n) => Math.round(n).toLocaleString('ko-KR');

const state = {
  pages_simple: 5,
  pages_complex: 3,
  mod_basic: 2,
  mod_advanced: 1,
  integrations: 1,
  ai: { llm_simple: false, rag: false, agent: false, finetune: false },
  tier: 'medium', // 개발 수준 (mvp / small / medium / large)
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
  tiers: DEFAULT_QUALITY_TIERS,
};

function loadRates() {
  const r = store.pricing.get();
  if (r && Object.keys(r).length) {
    rates = {
      ...rates,
      ...r,
      ai: { ...rates.ai, ...(r.ai || {}) },
      tiers: Array.isArray(r.tiers) && r.tiers.length ? r.tiers : DEFAULT_QUALITY_TIERS,
    };
  }
  if (r && r.activeTier) state.tier = r.activeTier;
}

function getActiveTier() {
  return rates.tiers.find((t) => t.id === state.tier) || rates.tiers[2] || DEFAULT_QUALITY_TIERS[2];
}

function calculate() {
  const pages = state.pages_simple * rates.pages_simple + state.pages_complex * rates.pages_complex;
  const modules = state.mod_basic * rates.mod_basic + state.mod_advanced * rates.mod_advanced;
  const integ = state.integrations * rates.integrations;
  const ai = Object.keys(state.ai).reduce(
    (sum, k) => sum + (state.ai[k] ? rates.ai[k] || 0 : 0),
    0
  );
  // 가중치는 페이지·모듈·외부연동 합계에만 적용 (AI 라인은 미적용)
  const tier = getActiveTier();
  const mult = tier.multiplier ?? 1;
  const baseNonAi = pages + modules + integ;
  const adjustedNonAi = baseNonAi * mult;
  const tierAdj = adjustedNonAi - baseNonAi; // 가중치로 인한 가감(±)
  const sub = adjustedNonAi + ai;
  const overhead = sub * (rates.overhead_ratio ?? 0.25);
  const total = sub + overhead;
  const r = rates.range_ratio ?? 0.15;
  return {
    pages, modules, integ, ai, sub, overhead, total,
    lo: total * (1 - r), hi: total * (1 + r),
    tier, mult, tierAdj,
  };
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

  // 가중치 표시
  const tierLabel = document.getElementById('bd_tier_label');
  const tierAdj = document.getElementById('bd_tier_adj');
  if (tierLabel) tierLabel.textContent = `${c.tier.name} ×${c.mult}`;
  if (tierAdj) {
    const sign = c.tierAdj > 0 ? '+' : c.tierAdj < 0 ? '−' : '';
    tierAdj.textContent = c.tierAdj === 0 ? '0 만' : `${sign}${fmt(Math.abs(c.tierAdj))} 만`;
    tierAdj.style.color = c.tierAdj > 0 ? 'var(--cobalt-deep)' : c.tierAdj < 0 ? 'var(--steel)' : '';
  }

  const quoteHidden = document.getElementById('lf_quote');
  if (quoteHidden) {
    quoteHidden.value = JSON.stringify({ ...state, total: Math.round(c.total), tierMultiplier: c.mult });
  }

  pushSparkPoint(c.total);
}

function renderTierUI() {
  const grid = document.getElementById('tier_grid');
  const detail = document.getElementById('tier_detail');
  if (!grid) return;

  grid.innerHTML = rates.tiers.map((t) => `
    <button type="button" class="calc-tier-btn ${t.id === state.tier ? 'on' : ''}" data-tier="${t.id}">
      <span class="tn">${t.name}</span>
      <span class="tm">×${t.multiplier}</span>
    </button>
  `).join('');

  grid.querySelectorAll('.calc-tier-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.tier = btn.dataset.tier;
      renderTierUI();
      render();
    });
  });

  if (detail) {
    const t = getActiveTier();
    detail.innerHTML = `
      <div class="tier-desc">${t.description || ''}</div>
      <ul>${(t.includes || []).map((x) => `<li>${x}</li>`).join('')}</ul>
    `;
  }
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
  renderTierUI();
  render();

  // 어드민에서 가격/가중치 변경 시 즉시 재반영
  window.addEventListener('store:change', (e) => {
    if (e.detail?.key?.endsWith('.pricing')) {
      loadRates();
      renderTierUI();
      render();
    }
  });

  // 🤖 Allow chatbot agent to fill the calculator via custom event
  window.addEventListener('calc:setState', (e) => {
    const next = e.detail || {};
    if (next.pages_simple != null) state.pages_simple = Number(next.pages_simple) || 0;
    if (next.pages_complex != null) state.pages_complex = Number(next.pages_complex) || 0;
    if (next.mod_basic != null) state.mod_basic = Number(next.mod_basic) || 0;
    if (next.mod_advanced != null) state.mod_advanced = Number(next.mod_advanced) || 0;
    if (next.integrations != null) state.integrations = Number(next.integrations) || 0;
    if (next.ai) {
      state.ai = { ...state.ai, ...next.ai };
    }
    if (next.tier && rates.tiers.some((t) => t.id === next.tier)) {
      state.tier = next.tier;
      renderTierUI();
    }
    // sync visible values
    ['pages_simple', 'pages_complex', 'mod_basic', 'mod_advanced', 'integrations'].forEach((k) => {
      const el = document.getElementById('val_' + k);
      if (el) el.textContent = state[k];
    });
    render();
  });
}

document.addEventListener('DOMContentLoaded', bootCalculator);
