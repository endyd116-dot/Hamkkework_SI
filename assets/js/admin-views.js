/**
 * Admin views — one renderer per route key.
 * Each view exports a render function that returns the HTML and an optional `mount` hook.
 */

import { store, utils, ensureSeed } from './store.js';
import { $, $$, escapeHtml, fmt, toast, openDrawer, closeDrawer, downloadJson, downloadCsv, emptyState, md } from './admin-ui.js';

await ensureSeed();

/* ============================================================
   View metadata
   ============================================================ */
export const VIEWS = {
  dashboard: { title: '대시보드', sub: '이번 주 운영 현황' },
  leads: { title: '리드 관리', sub: '문의 → 상담 → 견적 → 계약' },
  quotes: { title: '견적 / 제안서', sub: '라인별 분리 견적, PDF 발행' },
  projects: { title: '프로젝트 진행', sub: '마일스톤 · 주간보고 · 검수' },
  invoices: { title: '결제 / 인보이스', sub: '선금 30 · 중도 40 · 잔금 30' },
  cases: { title: '케이스 관리', sub: '레퍼런스 CMS — 메인페이지 자동 반영' },
  blog: { title: '블로그 / 콘텐츠', sub: '인사이트 글 — SEO 메타 포함' },
  faqs: { title: 'FAQ 편집', sub: '메인페이지 FAQ 자동 동기화' },
  chatbot: { title: 'AI 챗봇 설정', sub: '인텐트 · 응답 · 메시지 로그' },
  automation: { title: '자동화 룰', sub: '이메일·카톡 트리거' },
  kpi: { title: 'KPI 분석', sub: '리드 전환 · 매출 추세 · 채널 분석' },
  portal: { title: '클라이언트 포털', sub: '고객 계정 · 권한' },
  settings: { title: '설정', sub: '가격표 · 브랜드 · 팀멤버' },
};

/* ============================================================
   1. Dashboard
   ============================================================ */
export function renderDashboard() {
  const leads = store.leads.all();
  const quotes = store.quotes.all();
  const projects = store.projects.all();
  const invoices = store.invoices.all();

  const thisWeek = (iso) => iso && Date.now() - new Date(iso).getTime() < 7 * 86400000;
  const newThisWeek = leads.filter((l) => thisWeek(l.createdAt)).length;
  const wonThisMonth = leads.filter((l) => l.status === 'won').length;
  const activeProjects = projects.filter((p) => p.status !== 'done').length;
  const pendingAmount = invoices
    .filter((i) => i.status !== 'paid')
    .reduce((s, i) => s + (Number(i.amount) || 0), 0);

  const STAGES = [
    { key: 'new', label: '신규' },
    { key: 'consult', label: '상담' },
    { key: 'quote', label: '견적' },
    { key: 'contract', label: '계약' },
    { key: 'won', label: '완료' },
    { key: 'lost', label: '실주' },
  ];
  const counts = STAGES.map((s) => ({ ...s, n: leads.filter((l) => l.status === s.key).length }));
  const maxCount = Math.max(...counts.map((c) => c.n), 1);

  const recent = [...leads].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 6);

  return `
    <div class="kpi-row">
      <div class="kpi"><div class="label">이번주 신규 리드</div><div class="value">${newThisWeek}</div><div class="delta up">${leads.length}건 누적</div></div>
      <div class="kpi"><div class="label">진행 중 프로젝트</div><div class="value">${activeProjects}</div><div class="delta">${projects.length}건 전체</div></div>
      <div class="kpi"><div class="label">이번달 수주</div><div class="value">${wonThisMonth}</div><div class="delta up">+${wonThisMonth}건</div></div>
      <div class="kpi"><div class="label">미수금</div><div class="value">${fmt.num(pendingAmount)}<small style="font-size:14px;color:var(--steel);font-weight:500"> 만원</small></div><div class="delta ${pendingAmount > 0 ? 'down' : ''}">${invoices.filter(i=>i.status!=='paid').length}건</div></div>
    </div>

    <div class="adm-card">
      <h3>리드 전환 퍼널 <span style="font-size:12px;color:var(--steel);font-weight:400">총 ${leads.length}건</span></h3>
      <div class="funnel">
        ${counts.map((c) => `
          <div class="funnel-step">
            <div class="funnel-bar" style="height:${Math.max(40, (c.n / maxCount) * 200)}px">${c.n}</div>
            <div class="label">${c.label}</div>
          </div>
        `).join('')}
      </div>
    </div>

    <div class="adm-card">
      <h3>주간 리드 추이</h3>
      <div class="chart-wrap"><canvas id="leadsTrendChart"></canvas></div>
    </div>

    <div class="adm-card">
      <h3>최근 리드 <a href="#leads" class="adm-btn ghost sm" data-nav="leads">전체 보기 →</a></h3>
      ${recent.length === 0
        ? emptyState('📭', '아직 들어온 리드가 없습니다. 메인페이지의 상담 폼이 연결되어 있는지 확인하세요.')
        : `<table class="adm-table">
            <thead><tr><th>이름</th><th>회사</th><th>필요한 일</th><th>예산</th><th>단계</th><th>접수</th></tr></thead>
            <tbody>${recent.map((l) => `
              <tr style="cursor:pointer" data-id="${l.id}" data-action="open-lead">
                <td><b>${escapeHtml(l.name || '')}</b></td>
                <td>${escapeHtml(l.company || '—')}</td>
                <td>${escapeHtml(l.type || '—')}</td>
                <td>${escapeHtml(l.budget || '—')}</td>
                <td>${stageTag(l.status)}</td>
                <td style="color:var(--steel);font-size:12px">${fmt.rel(l.createdAt)}</td>
              </tr>
            `).join('')}</tbody>
          </table>`
      }
    </div>
  `;
}

export function mountDashboard() {
  // chart
  const ctx = $('#leadsTrendChart');
  if (ctx && window.Chart) {
    const leads = store.leads.all();
    const days = 14;
    const buckets = new Array(days).fill(0);
    const labels = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      labels.push(`${d.getMonth() + 1}/${d.getDate()}`);
    }
    leads.forEach((l) => {
      const t = new Date(l.createdAt || l.updatedAt || Date.now());
      t.setHours(0, 0, 0, 0);
      const diff = Math.floor((today - t) / 86400000);
      if (diff >= 0 && diff < days) buckets[days - 1 - diff]++;
    });
    new window.Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: '신규 리드',
          data: buckets,
          borderColor: '#0866FF',
          backgroundColor: 'rgba(8,102,255,.1)',
          fill: true,
          tension: 0.35,
          pointRadius: 3,
          borderWidth: 2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
      },
    });
  }

  // row click → open lead drawer
  $$('tr[data-action="open-lead"]').forEach((row) => {
    row.addEventListener('click', () => {
      const id = row.dataset.id;
      window.openLead?.(id);
    });
  });

  $$('[data-nav]').forEach((b) => b.addEventListener('click', (e) => {
    e.preventDefault();
    window.navTo(b.dataset.nav);
  }));
}

const STAGE_LABELS = { new: '신규', consult: '상담', quote: '견적', contract: '계약', won: '완료', lost: '실주' };
const STAGE_TAGS = { new: 'info', consult: 'cobalt', quote: 'warning', contract: 'success', won: 'success', lost: 'critical' };
function stageTag(s) {
  return `<span class="tag ${STAGE_TAGS[s] || ''}">${STAGE_LABELS[s] || '신규'}</span>`;
}

/* ============================================================
   2. Leads — Kanban board + drawer
   ============================================================ */
export function renderLeads() {
  const STAGES = [
    { key: 'new', label: '신규' },
    { key: 'consult', label: '상담' },
    { key: 'quote', label: '견적' },
    { key: 'contract', label: '계약' },
    { key: 'won', label: '완료' },
    { key: 'lost', label: '실주' },
  ];
  const leads = store.leads.all();

  return `
    <div class="adm-card">
      <h3>리드 칸반보드
        <span>
          <button class="adm-btn sm secondary" id="exportLeadsBtn">CSV 내보내기</button>
          <button class="adm-btn sm" id="newLeadBtn">+ 리드 추가</button>
        </span>
      </h3>
      <div class="desc">카드를 드래그해 단계를 이동할 수 있습니다. 카드를 클릭하면 상세가 열립니다.</div>

      <div class="kanban">
        ${STAGES.map((s) => {
          const items = leads.filter((l) => (l.status || 'new') === s.key);
          return `
            <div class="kanban-col" data-stage="${s.key}">
              <h4>${s.label} <span class="count">${items.length}</span></h4>
              <div class="kanban-list" data-stage="${s.key}">
                ${items.map((l) => kanbanCard(l)).join('')}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

function kanbanCard(l) {
  return `
    <div class="kanban-card" draggable="true" data-id="${l.id}">
      <div class="who">${escapeHtml(l.name || '—')}</div>
      <div class="company">${escapeHtml(l.company || '')} ${l.email ? `· ${escapeHtml(l.email)}` : ''}</div>
      <div style="margin-top:8px;font-size:11px;color:var(--steel)">${escapeHtml(l.type || '')}</div>
      <div class="meta">
        <span class="amount">${escapeHtml(l.budget || '')}</span>
        <span>${fmt.rel(l.createdAt)}</span>
      </div>
    </div>
  `;
}

export function mountLeads() {
  // Drag & drop between columns
  let dragId = null;
  $$('.kanban-card').forEach((card) => {
    card.addEventListener('dragstart', (e) => {
      dragId = card.dataset.id;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    card.addEventListener('click', () => window.openLead?.(card.dataset.id));
  });

  $$('.kanban-list').forEach((col) => {
    col.addEventListener('dragover', (e) => e.preventDefault());
    col.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!dragId) return;
      const stage = col.dataset.stage;
      store.leads.update(dragId, { status: stage });
      toast(`단계를 [${STAGE_LABELS[stage]}]로 변경했습니다`, 'success');
      window.rerenderView?.();
    });
  });

  $('#exportLeadsBtn')?.addEventListener('click', () => {
    const leads = store.leads.all();
    downloadCsv(leads.map((l) => ({
      id: l.id,
      name: l.name,
      company: l.company,
      email: l.email,
      phone: l.phone,
      type: l.type,
      budget: l.budget,
      status: l.status,
      message: l.message,
      createdAt: l.createdAt,
    })), 'leads.csv');
    toast('리드 CSV가 다운로드되었습니다', 'success');
  });

  $('#newLeadBtn')?.addEventListener('click', () => openLeadDrawer(null));
  window.openLead = (id) => openLeadDrawer(id);
}

function openLeadDrawer(id) {
  const lead = id ? store.leads.byId(id) : { name: '', company: '', email: '', phone: '', type: '플랫폼 신규 구축', budget: '', message: '', status: 'new' };
  const isEdit = !!id;
  openDrawer({
    title: isEdit ? `리드 상세 — ${escapeHtml(lead.name || '')}` : '+ 새 리드 추가',
    body: `
      <div class="adm-row">
        <div class="adm-field"><label>이름</label><input id="ld_name" value="${escapeHtml(lead.name||'')}"></div>
        <div class="adm-field"><label>회사</label><input id="ld_company" value="${escapeHtml(lead.company||'')}"></div>
      </div>
      <div class="adm-row">
        <div class="adm-field"><label>이메일</label><input id="ld_email" type="email" value="${escapeHtml(lead.email||'')}"></div>
        <div class="adm-field"><label>연락처</label><input id="ld_phone" value="${escapeHtml(lead.phone||'')}"></div>
      </div>
      <div class="adm-row">
        <div class="adm-field"><label>단계</label>
          <select id="ld_status">
            ${Object.entries(STAGE_LABELS).map(([k, v]) => `<option value="${k}" ${lead.status === k ? 'selected' : ''}>${v}</option>`).join('')}
          </select>
        </div>
        <div class="adm-field"><label>예산</label><input id="ld_budget" value="${escapeHtml(lead.budget||'')}"></div>
      </div>
      <div class="adm-field"><label>필요한 일</label><input id="ld_type" value="${escapeHtml(lead.type||'')}"></div>
      <div class="adm-field"><label>메시지</label><textarea id="ld_msg">${escapeHtml(lead.message||'')}</textarea></div>
      ${lead.quote ? `
        <div class="adm-card" style="background:var(--surface-soft);padding:16px;margin-top:12px">
          <h3 style="font-size:13px;margin-bottom:10px">첨부된 견적</h3>
          <pre style="font-family:var(--font-mono);font-size:11px;color:var(--slate);white-space:pre-wrap">${escapeHtml(JSON.stringify(lead.quote, null, 2))}</pre>
        </div>
      ` : ''}
      ${isEdit ? `<div class="adm-field" style="margin-top:14px"><label>접수 일시</label><div style="font-size:13px;color:var(--steel)">${fmt.dt(lead.createdAt)}</div></div>` : ''}
    `,
    footer: `
      ${isEdit ? '<button class="adm-btn danger" id="ld_delete">삭제</button>' : ''}
      <button class="adm-btn secondary" id="ld_cancel">취소</button>
      <button class="adm-btn" id="ld_save">${isEdit ? '저장' : '추가'}</button>
    `,
  });

  $('#ld_save').addEventListener('click', () => {
    const payload = {
      name: $('#ld_name').value.trim(),
      company: $('#ld_company').value.trim(),
      email: $('#ld_email').value.trim(),
      phone: $('#ld_phone').value.trim(),
      type: $('#ld_type').value.trim(),
      budget: $('#ld_budget').value.trim(),
      message: $('#ld_msg').value.trim(),
      status: $('#ld_status').value,
    };
    if (!payload.name) {
      toast('이름은 필수입니다', 'error');
      return;
    }
    if (isEdit) {
      store.leads.update(id, payload);
      toast('리드가 저장되었습니다', 'success');
    } else {
      store.leads.add({ ...payload, source: 'manual' });
      toast('새 리드가 추가되었습니다', 'success');
    }
    closeDrawer();
    window.rerenderView?.();
  });

  $('#ld_delete')?.addEventListener('click', () => {
    if (!window.confirm('정말 이 리드를 삭제하시겠습니까?')) return;
    store.leads.remove(id);
    toast('삭제되었습니다');
    closeDrawer();
    window.rerenderView?.();
  });
  $('#ld_cancel').addEventListener('click', closeDrawer);
}

/* ============================================================
   3. Quotes — quote builder + PDF preview
   ============================================================ */
export function renderQuotes() {
  const quotes = store.quotes.all();
  const leads = store.leads.all();
  return `
    <div class="adm-card">
      <h3>견적 / 제안서
        <button class="adm-btn sm" id="newQuoteBtn">+ 새 견적 작성</button>
      </h3>
      <div class="desc">라인별로 분리된 견적서를 생성하고 PDF로 발행합니다. 리드와 연결해 자동 발송 가능.</div>
      ${quotes.length === 0
        ? emptyState('📄', '아직 작성된 견적이 없습니다.')
        : `<table class="adm-table">
            <thead><tr><th>제목</th><th>클라이언트</th><th>금액</th><th>상태</th><th>작성</th><th></th></tr></thead>
            <tbody>${quotes.map((q) => `
              <tr>
                <td><b>${escapeHtml(q.title || '제목 없음')}</b></td>
                <td>${escapeHtml(q.clientName || '—')}</td>
                <td style="color:var(--cobalt-deep);font-weight:700">${fmt.num(q.total || 0)} 만원</td>
                <td>${stageTag(q.status === 'sent' ? 'consult' : (q.status === 'accepted' ? 'won' : 'new'))}</td>
                <td style="color:var(--steel);font-size:12px">${fmt.rel(q.createdAt)}</td>
                <td>
                  <button class="adm-btn sm secondary" data-action="edit-quote" data-id="${q.id}">편집</button>
                  <button class="adm-btn sm" data-action="pdf-quote" data-id="${q.id}">PDF</button>
                </td>
              </tr>
            `).join('')}</tbody>
          </table>`
      }
    </div>
  `;
}

export function mountQuotes() {
  $('#newQuoteBtn')?.addEventListener('click', () => openQuoteDrawer(null));
  $$('[data-action="edit-quote"]').forEach((b) => b.addEventListener('click', () => openQuoteDrawer(b.dataset.id)));
  $$('[data-action="pdf-quote"]').forEach((b) => b.addEventListener('click', () => generateQuotePdf(b.dataset.id)));
}

function openQuoteDrawer(id) {
  const isEdit = !!id;
  const q = id ? store.quotes.byId(id) : {
    title: '',
    clientName: '',
    items: [
      { label: '단순 페이지 × 5', amount: 150 },
      { label: '기능 모듈 × 2', amount: 400 },
    ],
    overhead: 25,
  };
  const total = (q.items?.reduce((s, x) => s + (Number(x.amount) || 0), 0) || 0);
  const overheadAmt = total * ((q.overhead || 25) / 100);
  const grand = total + overheadAmt;

  openDrawer({
    title: isEdit ? '견적 편집' : '+ 새 견적 작성',
    body: `
      <div class="adm-field"><label>제목</label><input id="q_title" value="${escapeHtml(q.title||'')}" placeholder="예: 함께워크_SI 견적서 - ${escapeHtml(q.clientName||'클라이언트')}"></div>
      <div class="adm-row">
        <div class="adm-field"><label>클라이언트</label><input id="q_client" value="${escapeHtml(q.clientName||'')}"></div>
        <div class="adm-field"><label>오버헤드(%)</label><input id="q_overhead" type="number" value="${q.overhead||25}"></div>
      </div>

      <div class="adm-card" style="background:var(--surface-soft);padding:14px;margin-top:8px">
        <h3 style="font-size:13px">견적 항목</h3>
        <div id="q_items"></div>
        <button class="adm-btn ghost sm" id="q_addItem" style="margin-top:8px">+ 항목 추가</button>
      </div>

      <div class="adm-card" style="background:var(--ink-deep);color:#fff;padding:18px;margin-top:14px">
        <div style="display:flex;justify-content:space-between"><span style="color:rgba(255,255,255,.6)">소계</span><span id="q_sub">${fmt.num(total)} 만</span></div>
        <div style="display:flex;justify-content:space-between;margin-top:6px"><span style="color:rgba(255,255,255,.6)">QA·PM</span><span id="q_oh">${fmt.num(overheadAmt)} 만</span></div>
        <hr style="border:0;border-top:1px solid rgba(255,255,255,.2);margin:10px 0">
        <div style="display:flex;justify-content:space-between;font-size:18px;font-weight:800"><span>합계</span><span id="q_total">${fmt.num(grand)} 만</span></div>
      </div>

      <div class="adm-field" style="margin-top:14px"><label>메모 / 특이사항</label><textarea id="q_notes">${escapeHtml(q.notes||'')}</textarea></div>
    `,
    footer: `
      ${isEdit ? '<button class="adm-btn danger" id="q_delete">삭제</button>' : ''}
      <button class="adm-btn secondary" id="q_cancel">취소</button>
      <button class="adm-btn" id="q_save">${isEdit ? '저장' : '생성'}</button>
    `,
  });

  const itemsEl = $('#q_items');
  let items = [...(q.items || [])];

  function renderItems() {
    itemsEl.innerHTML = items
      .map((it, idx) => `
        <div style="display:grid;grid-template-columns:1fr 100px 32px;gap:8px;margin-bottom:6px;align-items:center">
          <input data-idx="${idx}" data-k="label" value="${escapeHtml(it.label || '')}" placeholder="항목명" style="padding:8px;border:1px solid var(--hairline);border-radius:var(--r-md);font-size:13px">
          <input data-idx="${idx}" data-k="amount" type="number" value="${it.amount || 0}" placeholder="0" style="padding:8px;border:1px solid var(--hairline);border-radius:var(--r-md);font-size:13px;text-align:right">
          <button data-idx="${idx}" class="adm-btn ghost sm" data-action="q_remove">✕</button>
        </div>
      `).join('');
    itemsEl.querySelectorAll('input').forEach((inp) => {
      inp.addEventListener('input', (e) => {
        const i = +e.target.dataset.idx;
        const k = e.target.dataset.k;
        items[i][k] = k === 'amount' ? Number(e.target.value) : e.target.value;
        updateTotals();
      });
    });
    itemsEl.querySelectorAll('[data-action="q_remove"]').forEach((b) => {
      b.addEventListener('click', () => {
        items.splice(+b.dataset.idx, 1);
        renderItems();
        updateTotals();
      });
    });
  }
  function updateTotals() {
    const sub = items.reduce((s, x) => s + (Number(x.amount) || 0), 0);
    const overhead = Number($('#q_overhead').value) || 0;
    const oh = sub * (overhead / 100);
    const grand = sub + oh;
    $('#q_sub').textContent = `${fmt.num(sub)} 만`;
    $('#q_oh').textContent = `${fmt.num(oh)} 만`;
    $('#q_total').textContent = `${fmt.num(grand)} 만`;
  }
  $('#q_addItem').addEventListener('click', () => {
    items.push({ label: '', amount: 0 });
    renderItems();
    updateTotals();
  });
  $('#q_overhead').addEventListener('input', updateTotals);
  renderItems();

  $('#q_save').addEventListener('click', () => {
    const sub = items.reduce((s, x) => s + (Number(x.amount) || 0), 0);
    const overhead = Number($('#q_overhead').value) || 0;
    const total = Math.round(sub * (1 + overhead / 100));
    const payload = {
      title: $('#q_title').value.trim() || '제목 없음',
      clientName: $('#q_client').value.trim(),
      items,
      overhead,
      total,
      notes: $('#q_notes').value.trim(),
      status: q.status || 'draft',
    };
    if (isEdit) store.quotes.update(id, payload);
    else store.quotes.add(payload);
    toast('견적이 저장되었습니다', 'success');
    closeDrawer();
    window.rerenderView?.();
  });
  $('#q_cancel').addEventListener('click', closeDrawer);
  $('#q_delete')?.addEventListener('click', () => {
    if (!window.confirm('삭제하시겠습니까?')) return;
    store.quotes.remove(id);
    closeDrawer();
    window.rerenderView?.();
  });
}

/**
 * Generate Korean-safe PDF via HTML→Canvas→PDF.
 * jsPDF's built-in fonts don't support CJK, so we render an HTML template
 * using Pretendard and capture it with html2canvas, then paginate into A4.
 */
async function generateQuotePdf(id) {
  const q = store.quotes.byId(id);
  const s = store.settings.get();
  if (!q) {
    toast('견적을 찾을 수 없습니다', 'error');
    return;
  }
  if (!window.html2canvas || !window.jspdf) {
    toast('PDF 라이브러리가 로드되지 않았습니다. 새로고침 후 다시 시도해 주세요.', 'error');
    return;
  }

  toast('PDF 생성 중…');

  const sub = (q.items || []).reduce((acc, x) => acc + (Number(x.amount) || 0), 0);
  const overheadPct = Number(q.overhead) || 25;
  const oh = sub * (overheadPct / 100);
  const grand = sub + oh;
  const vat = grand * 0.1;
  const grandVat = grand + vat;

  const quoteNo = `Q-${(q.id || '').slice(-8).toUpperCase()}`;
  const today = new Date();
  const valid = new Date(today.getTime() + 30 * 86400000); // 30 days
  const dateStr = (d) => `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;

  // A4 width in pixels at 96dpi ≈ 794. We use 800 to leave some padding.
  const host = document.createElement('div');
  host.style.cssText = `
    position: fixed; left: -10000px; top: 0;
    width: 794px; padding: 0; margin: 0;
    background: #fff;
    font-family: 'Pretendard', -apple-system, BlinkMacSystemFont, sans-serif;
    color: #1C2B33;
    font-feature-settings: "ss06";
  `;
  host.innerHTML = `
    <div style="padding:56px 56px 48px;background:#fff">

      <!-- Header -->
      <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #0866FF;padding-bottom:24px;margin-bottom:36px">
        <div style="display:flex;align-items:center;gap:14px">
          <img src="/assets/images/logo.jpg" alt="" style="height:64px;width:auto;object-fit:contain" crossorigin="anonymous" onerror="this.style.display='none'">
          <div>
            <div style="font-size:22px;font-weight:800;color:#0A1317;letter-spacing:-0.02em">${escapeHtml(s.brand || '함께워크_SI')}</div>
            <div style="margin-top:6px;font-size:11px;font-weight:700;color:#0866FF;letter-spacing:0.1em;text-transform:uppercase">SI · AI Agent · Platform</div>
          </div>
        </div>
        <div style="text-align:right">
          <div style="font-size:36px;font-weight:700;color:#0A1317;letter-spacing:0.16em;line-height:1">견 적 서</div>
          <div style="margin-top:10px;font-size:12px;color:#6B7280;line-height:1.6">
            <div><b style="color:#0143B5">견적번호</b> · ${quoteNo}</div>
            <div><b style="color:#0143B5">발행일</b> · ${dateStr(today)}</div>
            <div><b style="color:#0143B5">유효기간</b> · ${dateStr(valid)}</div>
          </div>
        </div>
      </div>

      <!-- Client / Subject -->
      <table style="width:100%;border-collapse:collapse;margin-bottom:28px;font-size:13px">
        <tr>
          <td style="width:80px;padding:12px 14px;background:#F2F7FF;color:#0143B5;font-weight:700;border-radius:6px 0 0 6px">수 신</td>
          <td style="padding:12px 18px;background:#FAFBFC;font-weight:600;color:#1C2B33">${escapeHtml(q.clientName || '—')} 귀하</td>
        </tr>
        <tr><td colspan="2" style="height:6px"></td></tr>
        <tr>
          <td style="padding:12px 14px;background:#F2F7FF;color:#0143B5;font-weight:700;border-radius:6px 0 0 6px">제 목</td>
          <td style="padding:12px 18px;background:#FAFBFC;font-weight:600;color:#1C2B33">${escapeHtml(q.title || '제목 없음')}</td>
        </tr>
      </table>

      <!-- Items -->
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:24px">
        <thead>
          <tr>
            <th style="text-align:left;padding:12px 16px;background:#0A1317;color:#fff;font-weight:600;border-radius:6px 0 0 6px">항목</th>
            <th style="text-align:right;padding:12px 16px;background:#0A1317;color:#fff;font-weight:600;border-radius:0 6px 6px 0;width:140px">금액 (만원)</th>
          </tr>
        </thead>
        <tbody>
          ${(q.items || []).length === 0 ? `
            <tr><td colspan="2" style="padding:24px;text-align:center;color:#9CA3AF">항목 없음</td></tr>
          ` : (q.items || []).map((it) => `
            <tr>
              <td style="padding:13px 16px;border-bottom:1px solid #EBEDF0;color:#1C2B33">${escapeHtml(it.label || '—')}</td>
              <td style="padding:13px 16px;border-bottom:1px solid #EBEDF0;text-align:right;color:#1C2B33;font-variant-numeric:tabular-nums">${fmt.num(it.amount || 0)}</td>
            </tr>
          `).join('')}
        </tbody>
        <tfoot>
          <tr>
            <td style="padding:14px 16px;text-align:right;color:#4B5563">소계</td>
            <td style="padding:14px 16px;text-align:right;font-weight:600;color:#1C2B33">${fmt.num(sub)} 만원</td>
          </tr>
          <tr>
            <td style="padding:10px 16px;text-align:right;color:#4B5563">QA · PM (${overheadPct}%)</td>
            <td style="padding:10px 16px;text-align:right;font-weight:600;color:#1C2B33">${fmt.num(oh)} 만원</td>
          </tr>
          <tr>
            <td style="padding:10px 16px;text-align:right;color:#4B5563">VAT (10%)</td>
            <td style="padding:10px 16px;text-align:right;font-weight:600;color:#1C2B33">${fmt.num(vat)} 만원</td>
          </tr>
          <tr>
            <td style="padding:18px 16px;text-align:right;font-size:14px;color:#0143B5;font-weight:700;border-top:2px solid #0866FF">합계 (VAT 포함)</td>
            <td style="padding:18px 16px;text-align:right;font-size:20px;color:#0866FF;font-weight:800;letter-spacing:-0.02em;border-top:2px solid #0866FF;font-variant-numeric:tabular-nums">${fmt.num(grandVat)} 만원</td>
          </tr>
        </tfoot>
      </table>

      ${q.notes ? `
        <div style="margin-bottom:24px;padding:18px 20px;background:#FAFBFC;border-left:3px solid #0866FF;border-radius:0 6px 6px 0">
          <div style="font-size:11px;font-weight:700;color:#0866FF;letter-spacing:0.06em;text-transform:uppercase;margin-bottom:8px">특이사항</div>
          <div style="font-size:13px;color:#1C2B33;line-height:1.6;white-space:pre-wrap">${escapeHtml(q.notes)}</div>
        </div>
      ` : ''}

      <!-- Terms -->
      <div style="margin-top:32px;padding:20px 22px;background:linear-gradient(135deg,#F2F7FF,#FAFBFC);border-radius:8px;border:1px solid #E5F0FE">
        <div style="font-size:11px;font-weight:700;color:#0866FF;letter-spacing:0.06em;text-transform:uppercase;margin-bottom:12px">계약 및 정산 조건</div>
        <table style="width:100%;font-size:12px;color:#1C2B33;line-height:1.7">
          <tr>
            <td style="width:110px;color:#6B7280;padding:3px 0">결제 일정</td>
            <td style="padding:3px 0"><b>선금 30%</b> · 중도금 40% · <b>잔금 30%</b> (검수 합격일 정산)</td>
          </tr>
          <tr>
            <td style="color:#6B7280;padding:3px 0">하자보증</td>
            <td style="padding:3px 0">인도 후 <b>${s.warranty_months || 6}개월 무상</b> · 소스 100% 양도 · 운영 인계 매뉴얼 포함</td>
          </tr>
          <tr>
            <td style="color:#6B7280;padding:3px 0">검수 기준</td>
            <td style="padding:3px 0">사용자 검수 통과 시 = 인도 (단계별 마일스톤 검수 적용)</td>
          </tr>
          <tr>
            <td style="color:#6B7280;padding:3px 0">유효기간</td>
            <td style="padding:3px 0">발행일로부터 <b>30일</b></td>
          </tr>
          <tr>
            <td style="color:#6B7280;padding:3px 0">기타</td>
            <td style="padding:3px 0">AI 운영비(토큰·벡터DB·GPU), 인프라·도메인·SSL은 월 별도 정산</td>
          </tr>
        </table>
      </div>

      <!-- Footer / Issuer -->
      <div style="margin-top:36px;padding-top:24px;border-top:1px solid #EBEDF0;display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <div style="font-size:11px;font-weight:700;color:#0866FF;letter-spacing:0.06em;text-transform:uppercase">발행</div>
          <div style="margin-top:6px;font-size:14px;font-weight:700;color:#0A1317">${escapeHtml(s.brand || '함께워크_SI')}</div>
          <div style="margin-top:10px;font-size:12px;color:#4B5563;line-height:1.7">
            담당 · ${escapeHtml(s.pm || '박단용')}<br>
            E-MAIL · ${escapeHtml(s.email || 'endyd116@gmail.com')}<br>
            TEL · ${escapeHtml(s.phone || '010-2807-5242')}
          </div>
        </div>
        <div style="text-align:right;font-size:10px;color:#9CA3AF;line-height:1.5">
          본 견적서는 함께워크_SI 시스템에서 자동 발행되었습니다.<br>
          관련 문의는 위 담당자에게 연락 바랍니다.
        </div>
      </div>

    </div>
  `;
  document.body.appendChild(host);

  // Give the browser one frame to render
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  try {
    const canvas = await window.html2canvas(host, {
      scale: 2,
      backgroundColor: '#ffffff',
      useCORS: true,
      logging: false,
      windowWidth: 794,
    });

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'p' });

    const imgWidth = 210;  // A4 width in mm
    const pageHeight = 297;
    const imgHeight = (canvas.height * imgWidth) / canvas.width;

    const imgData = canvas.toDataURL('image/jpeg', 0.92);

    let heightLeft = imgHeight;
    let position = 0;

    pdf.addImage(imgData, 'JPEG', 0, position, imgWidth, imgHeight);
    heightLeft -= pageHeight;

    while (heightLeft > 0) {
      position = heightLeft - imgHeight;
      pdf.addPage();
      pdf.addImage(imgData, 'JPEG', 0, position, imgWidth, imgHeight);
      heightLeft -= pageHeight;
    }

    const safeName = (q.clientName || 'client').replace(/[\\/:*?"<>|]/g, '_').trim() || 'client';
    pdf.save(`견적서_${safeName}_${quoteNo}.pdf`);

    toast('PDF가 생성되었습니다', 'success');
  } catch (e) {
    console.error('[pdf] generation failed', e);
    toast('PDF 생성 중 오류가 발생했습니다: ' + (e?.message || e), 'error');
  } finally {
    host.remove();
  }
}

/* ============================================================
   4. Projects
   ============================================================ */
export function renderProjects() {
  const projects = store.projects.all();
  return `
    <div class="adm-card">
      <h3>프로젝트 진행
        <button class="adm-btn sm" id="newProjectBtn">+ 프로젝트 추가</button>
      </h3>
      <div class="desc">마일스톤별 검수, 주간보고, 결제 상태를 한 곳에서 관리합니다. 클라이언트는 [포털]에서 같은 정보를 조회합니다.</div>
      ${projects.length === 0
        ? emptyState('🛠', '진행 중인 프로젝트가 없습니다.')
        : `<div style="display:grid;gap:12px">
            ${projects.map((p) => projectCard(p)).join('')}
          </div>`
      }
    </div>
  `;
}
function projectCard(p) {
  const milestones = p.milestones || [];
  const done = milestones.filter((m) => m.done).length;
  const pct = milestones.length ? (done / milestones.length) * 100 : 0;
  return `
    <div class="adm-card" style="cursor:pointer" data-id="${p.id}" data-action="open-project">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <div style="font-size:11px;color:var(--steel);font-weight:700;text-transform:uppercase;letter-spacing:.04em">${escapeHtml(p.clientName || '—')}</div>
          <h3 style="margin-top:4px;margin-bottom:6px">${escapeHtml(p.name || '제목 없음')}</h3>
          <div style="font-size:13px;color:var(--slate)">${escapeHtml(p.summary || '')}</div>
        </div>
        <span class="tag ${p.status === 'done' ? 'success' : 'cobalt'}">${p.status === 'done' ? '완료' : (p.status || '진행중')}</span>
      </div>
      <div style="margin-top:14px">
        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--steel);margin-bottom:4px">
          <span>마일스톤 ${done}/${milestones.length}</span>
          <span>${pct.toFixed(0)}%</span>
        </div>
        <div style="height:6px;background:var(--hairline-soft);border-radius:999px;overflow:hidden">
          <div style="width:${pct}%;height:100%;background:linear-gradient(90deg,var(--cobalt),var(--cobalt-tint));transition:width 600ms ease"></div>
        </div>
      </div>
    </div>
  `;
}
export function mountProjects() {
  $('#newProjectBtn')?.addEventListener('click', () => openProjectDrawer(null));
  $$('[data-action="open-project"]').forEach((el) => el.addEventListener('click', () => openProjectDrawer(el.dataset.id)));
}
function openProjectDrawer(id) {
  const isEdit = !!id;
  const p = id ? store.projects.byId(id) : {
    name: '',
    clientName: '',
    summary: '',
    status: 'kickoff',
    milestones: [
      { label: '기획 · 계약', done: true },
      { label: '디자인 · IA', done: false },
      { label: '개발 1차', done: false },
      { label: '검수 · 인도', done: false },
    ],
    reports: [],
  };
  openDrawer({
    title: isEdit ? '프로젝트 상세' : '+ 새 프로젝트',
    body: `
      <div class="adm-field"><label>프로젝트명</label><input id="pj_name" value="${escapeHtml(p.name||'')}"></div>
      <div class="adm-row">
        <div class="adm-field"><label>클라이언트</label><input id="pj_client" value="${escapeHtml(p.clientName||'')}"></div>
        <div class="adm-field"><label>상태</label>
          <select id="pj_status">
            <option value="kickoff" ${p.status==='kickoff'?'selected':''}>킥오프</option>
            <option value="design" ${p.status==='design'?'selected':''}>설계</option>
            <option value="dev" ${p.status==='dev'?'selected':''}>개발</option>
            <option value="qa" ${p.status==='qa'?'selected':''}>검수</option>
            <option value="done" ${p.status==='done'?'selected':''}>완료</option>
          </select>
        </div>
      </div>
      <div class="adm-field"><label>요약</label><textarea id="pj_summary">${escapeHtml(p.summary||'')}</textarea></div>

      <div class="adm-card" style="background:var(--surface-soft);padding:14px;margin-top:8px">
        <h3 style="font-size:13px">마일스톤</h3>
        <div id="pj_ms"></div>
        <button class="adm-btn ghost sm" id="pj_addMs" style="margin-top:8px">+ 마일스톤 추가</button>
      </div>

      <div class="adm-card" style="background:var(--surface-soft);padding:14px;margin-top:8px">
        <h3 style="font-size:13px">주간 보고</h3>
        <textarea id="pj_newReport" placeholder="이번 주 진행 상황을 적어주세요…" style="min-height:60px;width:100%;padding:10px;border:1px solid var(--hairline);border-radius:var(--r-md);font-size:13px;font-family:inherit"></textarea>
        <button class="adm-btn sm" id="pj_addReport" style="margin-top:8px">+ 보고 추가</button>
        <div id="pj_reports" style="margin-top:12px;display:grid;gap:8px"></div>
      </div>
    `,
    footer: `
      ${isEdit ? '<button class="adm-btn danger" id="pj_delete">삭제</button>' : ''}
      <button class="adm-btn secondary" id="pj_cancel">취소</button>
      <button class="adm-btn" id="pj_save">${isEdit ? '저장' : '생성'}</button>
    `,
  });

  let milestones = [...(p.milestones || [])];
  let reports = [...(p.reports || [])];

  function renderMs() {
    $('#pj_ms').innerHTML = milestones.map((m, idx) => `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <input type="checkbox" ${m.done?'checked':''} data-idx="${idx}" class="pj_ms_check">
        <input value="${escapeHtml(m.label||'')}" data-idx="${idx}" class="pj_ms_lbl" style="flex:1;padding:8px;border:1px solid var(--hairline);border-radius:var(--r-md);font-size:13px">
        <button data-idx="${idx}" class="adm-btn ghost sm pj_ms_del">✕</button>
      </div>
    `).join('');
    $$('.pj_ms_check').forEach((c) => c.addEventListener('change', (e) => { milestones[+e.target.dataset.idx].done = e.target.checked; }));
    $$('.pj_ms_lbl').forEach((c) => c.addEventListener('input', (e) => { milestones[+e.target.dataset.idx].label = e.target.value; }));
    $$('.pj_ms_del').forEach((c) => c.addEventListener('click', (e) => { milestones.splice(+e.target.dataset.idx, 1); renderMs(); }));
  }
  function renderReports() {
    $('#pj_reports').innerHTML = reports.length === 0 ? '<div style="font-size:12px;color:var(--steel)">아직 보고가 없습니다.</div>' :
      reports.map((r, idx) => `
        <div style="background:var(--canvas);padding:10px 12px;border-radius:var(--r-md);border:1px solid var(--hairline-soft)">
          <div style="font-size:11px;color:var(--steel)">${fmt.dt(r.at)}</div>
          <div style="font-size:13px;color:var(--ink);margin-top:4px;white-space:pre-wrap">${escapeHtml(r.text)}</div>
          <button class="adm-btn ghost sm" data-idx="${idx}" data-action="rp_del" style="margin-top:6px">삭제</button>
        </div>
      `).join('');
    $$('[data-action="rp_del"]').forEach((b) => b.addEventListener('click', () => { reports.splice(+b.dataset.idx, 1); renderReports(); }));
  }
  $('#pj_addMs').addEventListener('click', () => { milestones.push({ label: '', done: false }); renderMs(); });
  $('#pj_addReport').addEventListener('click', () => {
    const txt = $('#pj_newReport').value.trim();
    if (!txt) return;
    reports.unshift({ at: utils.nowIso(), text: txt });
    $('#pj_newReport').value = '';
    renderReports();
  });
  renderMs();
  renderReports();

  $('#pj_save').addEventListener('click', () => {
    const payload = {
      name: $('#pj_name').value.trim() || '제목 없음',
      clientName: $('#pj_client').value.trim(),
      summary: $('#pj_summary').value.trim(),
      status: $('#pj_status').value,
      milestones,
      reports,
    };
    if (isEdit) store.projects.update(id, payload);
    else store.projects.add(payload);
    toast('프로젝트가 저장되었습니다', 'success');
    closeDrawer();
    window.rerenderView?.();
  });
  $('#pj_cancel').addEventListener('click', closeDrawer);
  $('#pj_delete')?.addEventListener('click', () => {
    if (!window.confirm('삭제하시겠습니까?')) return;
    store.projects.remove(id);
    closeDrawer();
    window.rerenderView?.();
  });
}

/* ============================================================
   5. Invoices
   ============================================================ */
export function renderInvoices() {
  const invoices = store.invoices.all();
  return `
    <div class="adm-card">
      <h3>결제 / 인보이스
        <button class="adm-btn sm" id="newInvoiceBtn">+ 인보이스 발행</button>
      </h3>
      <div class="desc">표준 결제는 선금 30% · 중도금 40% · 잔금 30%. 미수금 추적과 세금계산서 발행 메모를 관리합니다.</div>
      ${invoices.length === 0
        ? emptyState('💳', '발행된 인보이스가 없습니다.')
        : `<table class="adm-table">
            <thead><tr><th>번호</th><th>클라이언트</th><th>단계</th><th>금액</th><th>발행일</th><th>상태</th><th></th></tr></thead>
            <tbody>${invoices.map((i) => `
              <tr>
                <td><b>INV-${escapeHtml(i.id?.slice(-6).toUpperCase() || '—')}</b></td>
                <td>${escapeHtml(i.clientName || '—')}</td>
                <td>${escapeHtml(i.phase || '—')}</td>
                <td style="font-weight:700;color:var(--cobalt-deep)">${fmt.num(i.amount || 0)} 만원</td>
                <td style="font-size:12px;color:var(--steel)">${fmt.date(i.createdAt)}</td>
                <td><span class="tag ${i.status==='paid'?'success':(i.status==='overdue'?'critical':'warning')}">${i.status==='paid'?'입금':(i.status==='overdue'?'연체':'미입금')}</span></td>
                <td>
                  <button class="adm-btn sm secondary" data-action="edit-inv" data-id="${i.id}">편집</button>
                  ${i.status !== 'paid' ? `<button class="adm-btn sm" data-action="mark-paid" data-id="${i.id}">입금처리</button>` : ''}
                </td>
              </tr>
            `).join('')}</tbody>
          </table>`
      }
    </div>
  `;
}
export function mountInvoices() {
  $('#newInvoiceBtn')?.addEventListener('click', () => openInvoiceDrawer(null));
  $$('[data-action="edit-inv"]').forEach((b) => b.addEventListener('click', () => openInvoiceDrawer(b.dataset.id)));
  $$('[data-action="mark-paid"]').forEach((b) => b.addEventListener('click', () => {
    store.invoices.update(b.dataset.id, { status: 'paid', paidAt: utils.nowIso() });
    toast('입금 처리되었습니다', 'success');
    window.rerenderView?.();
  }));
}
function openInvoiceDrawer(id) {
  const isEdit = !!id;
  const inv = id ? store.invoices.byId(id) : { clientName: '', phase: '선금 30%', amount: 0, status: 'unpaid', dueAt: '' };
  openDrawer({
    title: isEdit ? '인보이스 편집' : '+ 새 인보이스',
    body: `
      <div class="adm-field"><label>클라이언트</label><input id="iv_client" value="${escapeHtml(inv.clientName||'')}"></div>
      <div class="adm-row">
        <div class="adm-field"><label>단계</label>
          <select id="iv_phase">
            <option ${inv.phase==='선금 30%'?'selected':''}>선금 30%</option>
            <option ${inv.phase==='중도금 40%'?'selected':''}>중도금 40%</option>
            <option ${inv.phase==='잔금 30%'?'selected':''}>잔금 30%</option>
            <option ${inv.phase==='유지보수'?'selected':''}>유지보수</option>
          </select>
        </div>
        <div class="adm-field"><label>금액 (만원)</label><input id="iv_amount" type="number" value="${inv.amount||0}"></div>
      </div>
      <div class="adm-row">
        <div class="adm-field"><label>마감일</label><input id="iv_due" type="date" value="${inv.dueAt||''}"></div>
        <div class="adm-field"><label>상태</label>
          <select id="iv_status">
            <option value="unpaid" ${inv.status==='unpaid'?'selected':''}>미입금</option>
            <option value="paid" ${inv.status==='paid'?'selected':''}>입금</option>
            <option value="overdue" ${inv.status==='overdue'?'selected':''}>연체</option>
          </select>
        </div>
      </div>
      <div class="adm-field"><label>세금계산서 메모</label><textarea id="iv_memo">${escapeHtml(inv.memo||'')}</textarea></div>
    `,
    footer: `
      ${isEdit ? '<button class="adm-btn danger" id="iv_delete">삭제</button>' : ''}
      <button class="adm-btn secondary" id="iv_cancel">취소</button>
      <button class="adm-btn" id="iv_save">${isEdit ? '저장' : '발행'}</button>
    `,
  });
  $('#iv_save').addEventListener('click', () => {
    const payload = {
      clientName: $('#iv_client').value.trim(),
      phase: $('#iv_phase').value,
      amount: Number($('#iv_amount').value) || 0,
      dueAt: $('#iv_due').value,
      status: $('#iv_status').value,
      memo: $('#iv_memo').value.trim(),
    };
    if (isEdit) store.invoices.update(id, payload);
    else store.invoices.add(payload);
    toast('인보이스가 저장되었습니다', 'success');
    closeDrawer();
    window.rerenderView?.();
  });
  $('#iv_cancel').addEventListener('click', closeDrawer);
  $('#iv_delete')?.addEventListener('click', () => {
    if (!window.confirm('삭제하시겠습니까?')) return;
    store.invoices.remove(id);
    closeDrawer();
    window.rerenderView?.();
  });
}

/* ============================================================
   6. Cases
   ============================================================ */
export function renderCases() {
  const cases = store.cases.all();
  return `
    <div class="adm-card">
      <h3>케이스 관리
        <button class="adm-btn sm" id="newCaseBtn">+ 케이스 추가</button>
      </h3>
      <div class="desc">메인페이지의 [레퍼런스] 캐러셀에 자동 반영됩니다. NDA 케이스는 [공개 OFF]로 처리하세요.</div>
      ${cases.length === 0 ? emptyState('💼', '아직 케이스가 없습니다.') :
        `<table class="adm-table">
          <thead><tr><th>라벨</th><th>클라이언트</th><th>제목</th><th>금액</th><th>공개</th><th></th></tr></thead>
          <tbody>${cases.map((c) => `
            <tr>
              <td><span class="tag cobalt">${escapeHtml(c.label||'')}</span></td>
              <td>${escapeHtml(c.client||'')}</td>
              <td><b>${escapeHtml(c.title||'')}</b></td>
              <td style="color:var(--cobalt-deep);font-weight:700">${escapeHtml(c.amount||'')}</td>
              <td><label class="switch"><input type="checkbox" ${c.published!==false?'checked':''} data-id="${c.id}" data-action="toggle-case"><span class="slider"></span></label></td>
              <td>
                <button class="adm-btn sm secondary" data-action="edit-case" data-id="${c.id}">편집</button>
                <button class="adm-btn sm ghost" data-action="del-case" data-id="${c.id}">삭제</button>
              </td>
            </tr>
          `).join('')}</tbody>
        </table>`
      }
    </div>
  `;
}
export function mountCases() {
  $('#newCaseBtn')?.addEventListener('click', () => openCaseDrawer(null));
  $$('[data-action="edit-case"]').forEach((b) => b.addEventListener('click', () => openCaseDrawer(b.dataset.id)));
  $$('[data-action="del-case"]').forEach((b) => b.addEventListener('click', () => {
    if (!window.confirm('삭제하시겠습니까?')) return;
    store.cases.remove(b.dataset.id);
    toast('삭제되었습니다');
    window.rerenderView?.();
  }));
  $$('[data-action="toggle-case"]').forEach((c) => c.addEventListener('change', (e) => {
    store.cases.update(e.target.dataset.id, { published: e.target.checked });
    toast(e.target.checked ? '공개로 전환되었습니다' : '비공개로 전환되었습니다', 'success');
  }));
}
function openCaseDrawer(id) {
  const isEdit = !!id;
  const c = id ? store.cases.byId(id) : { label: '', client: '', title: '', description: '', tags: [], amount: '', status: '', year: new Date().getFullYear(), published: true };
  openDrawer({
    title: isEdit ? '케이스 편집' : '+ 새 케이스',
    body: `
      <div class="adm-row">
        <div class="adm-field"><label>라벨 (이미지 대체)</label><input id="cs_label" value="${escapeHtml(c.label||'')}"></div>
        <div class="adm-field"><label>연도</label><input id="cs_year" type="number" value="${c.year||new Date().getFullYear()}"></div>
      </div>
      <div class="adm-field"><label>클라이언트</label><input id="cs_client" value="${escapeHtml(c.client||'')}"></div>
      <div class="adm-field"><label>제목</label><input id="cs_title" value="${escapeHtml(c.title||'')}"></div>
      <div class="adm-field"><label>설명</label><textarea id="cs_desc">${escapeHtml(c.description||'')}</textarea></div>
      <div class="adm-row">
        <div class="adm-field"><label>금액 / 표시</label><input id="cs_amount" value="${escapeHtml(c.amount||'')}" placeholder="10억 · 1순위"></div>
        <div class="adm-field"><label>상태</label><input id="cs_status" value="${escapeHtml(c.status||'')}" placeholder="경쟁입찰 수주"></div>
      </div>
      <div class="adm-field"><label>기술 태그 (쉼표로 구분)</label><input id="cs_tags" value="${escapeHtml((c.tags||[]).join(', '))}"></div>
      <div class="adm-field">
        <label>공개 여부</label>
        <label class="switch"><input id="cs_published" type="checkbox" ${c.published!==false?'checked':''}><span class="slider"></span></label>
      </div>
    `,
    footer: `
      ${isEdit ? '<button class="adm-btn danger" id="cs_delete">삭제</button>' : ''}
      <button class="adm-btn secondary" id="cs_cancel">취소</button>
      <button class="adm-btn" id="cs_save">${isEdit ? '저장' : '추가'}</button>
    `,
  });
  $('#cs_save').addEventListener('click', () => {
    const payload = {
      label: $('#cs_label').value.trim(),
      year: Number($('#cs_year').value) || new Date().getFullYear(),
      client: $('#cs_client').value.trim(),
      title: $('#cs_title').value.trim(),
      description: $('#cs_desc').value.trim(),
      amount: $('#cs_amount').value.trim(),
      status: $('#cs_status').value.trim(),
      tags: $('#cs_tags').value.split(',').map((t) => t.trim()).filter(Boolean),
      published: $('#cs_published').checked,
    };
    if (isEdit) store.cases.update(id, payload);
    else store.cases.add(payload);
    toast('저장되었습니다', 'success');
    closeDrawer();
    window.rerenderView?.();
  });
  $('#cs_cancel').addEventListener('click', closeDrawer);
  $('#cs_delete')?.addEventListener('click', () => {
    if (!window.confirm('삭제하시겠습니까?')) return;
    store.cases.remove(id);
    closeDrawer();
    window.rerenderView?.();
  });
}

/* ============================================================
   7. Blog / Content
   ============================================================ */
export function renderBlog() {
  const posts = store.posts.all();
  return `
    <div class="adm-card">
      <h3>블로그 / 콘텐츠
        <button class="adm-btn sm" id="newPostBtn">+ 새 글 작성</button>
      </h3>
      <div class="desc">"SI 견적", "AI 에이전트" 같은 키워드로 검색 유입을 늘립니다. 마크다운 에디터로 작성합니다.</div>
      ${posts.length === 0 ? emptyState('📝', '아직 작성된 글이 없습니다.') :
        `<table class="adm-table">
          <thead><tr><th>제목</th><th>저자</th><th>발행일</th><th>태그</th><th>공개</th><th></th></tr></thead>
          <tbody>${posts.map((p) => `
            <tr>
              <td><b>${escapeHtml(p.title||'')}</b><div style="font-size:11px;color:var(--steel);margin-top:2px">${escapeHtml(p.excerpt||'')}</div></td>
              <td>${escapeHtml(p.author||'—')}</td>
              <td style="font-size:12px;color:var(--steel)">${fmt.date(p.published_at)}</td>
              <td>${(p.tags||[]).map((t)=>`<span class="tag">${escapeHtml(t)}</span>`).join(' ')}</td>
              <td><label class="switch"><input type="checkbox" ${p.published!==false?'checked':''} data-id="${p.id}" data-action="toggle-post"><span class="slider"></span></label></td>
              <td>
                <button class="adm-btn sm secondary" data-action="edit-post" data-id="${p.id}">편집</button>
                <button class="adm-btn sm ghost" data-action="del-post" data-id="${p.id}">삭제</button>
              </td>
            </tr>
          `).join('')}</tbody>
        </table>`
      }
    </div>
  `;
}
export function mountBlog() {
  $('#newPostBtn')?.addEventListener('click', () => openPostDrawer(null));
  $$('[data-action="edit-post"]').forEach((b) => b.addEventListener('click', () => openPostDrawer(b.dataset.id)));
  $$('[data-action="del-post"]').forEach((b) => b.addEventListener('click', () => {
    if (!window.confirm('삭제하시겠습니까?')) return;
    store.posts.remove(b.dataset.id);
    toast('삭제되었습니다');
    window.rerenderView?.();
  }));
  $$('[data-action="toggle-post"]').forEach((c) => c.addEventListener('change', (e) => {
    store.posts.update(e.target.dataset.id, { published: e.target.checked });
  }));
}
function openPostDrawer(id) {
  const isEdit = !!id;
  const p = id ? store.posts.byId(id) : {
    title: '', slug: '', excerpt: '', author: '박단용',
    tags: [], published_at: new Date().toISOString().slice(0,10),
    content: '## 새 글\n\n여기에 내용을 작성하세요.', read_min: 5, published: false,
  };
  openDrawer({
    title: isEdit ? '글 편집' : '+ 새 글 작성',
    body: `
      <div class="adm-field"><label>제목</label><input id="bg_title" value="${escapeHtml(p.title||'')}"></div>
      <div class="adm-row">
        <div class="adm-field"><label>슬러그 (URL)</label><input id="bg_slug" value="${escapeHtml(p.slug||'')}"></div>
        <div class="adm-field"><label>저자</label><input id="bg_author" value="${escapeHtml(p.author||'')}"></div>
      </div>
      <div class="adm-field"><label>요약 (SEO 메타)</label><textarea id="bg_excerpt" style="min-height:60px">${escapeHtml(p.excerpt||'')}</textarea></div>
      <div class="adm-row">
        <div class="adm-field"><label>발행일</label><input id="bg_date" type="date" value="${p.published_at||''}"></div>
        <div class="adm-field"><label>읽는 시간 (분)</label><input id="bg_read" type="number" value="${p.read_min||5}"></div>
      </div>
      <div class="adm-field"><label>태그 (쉼표)</label><input id="bg_tags" value="${escapeHtml((p.tags||[]).join(', '))}"></div>
      <div class="adm-field">
        <label>본문 (Markdown)</label>
        <div class="md-editor">
          <textarea id="bg_content">${escapeHtml(p.content||'')}</textarea>
          <div class="md-preview" id="bg_preview"></div>
        </div>
      </div>
    `,
    footer: `
      ${isEdit ? '<button class="adm-btn danger" id="bg_delete">삭제</button>' : ''}
      <button class="adm-btn secondary" id="bg_cancel">취소</button>
      <button class="adm-btn" id="bg_save">저장</button>
    `,
  });
  function updatePreview() { $('#bg_preview').innerHTML = md($('#bg_content').value); }
  $('#bg_content').addEventListener('input', updatePreview);
  updatePreview();
  // auto-slug from title
  $('#bg_title').addEventListener('input', (e) => {
    if (!isEdit && !$('#bg_slug').value) {
      $('#bg_slug').value = e.target.value.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\w가-힣-]/g, '').slice(0, 60);
    }
  });
  $('#bg_save').addEventListener('click', () => {
    const payload = {
      title: $('#bg_title').value.trim(),
      slug: $('#bg_slug').value.trim(),
      excerpt: $('#bg_excerpt').value.trim(),
      author: $('#bg_author').value.trim(),
      published_at: $('#bg_date').value,
      read_min: Number($('#bg_read').value) || 5,
      tags: $('#bg_tags').value.split(',').map((t) => t.trim()).filter(Boolean),
      content: $('#bg_content').value,
      published: p.published !== false,
    };
    if (isEdit) store.posts.update(id, payload);
    else store.posts.add(payload);
    toast('저장되었습니다', 'success');
    closeDrawer();
    window.rerenderView?.();
  });
  $('#bg_cancel').addEventListener('click', closeDrawer);
  $('#bg_delete')?.addEventListener('click', () => {
    if (!window.confirm('삭제하시겠습니까?')) return;
    store.posts.remove(id);
    closeDrawer();
    window.rerenderView?.();
  });
}

/* ============================================================
   8. FAQs
   ============================================================ */
export function renderFaqs() {
  const faqs = store.faqs.all();
  return `
    <div class="adm-card">
      <h3>FAQ 편집
        <button class="adm-btn sm" id="newFaqBtn">+ FAQ 추가</button>
      </h3>
      <div class="desc">메인페이지의 FAQ 섹션에 자동 반영됩니다. 검색 키워드를 태그로 등록하세요.</div>
      ${faqs.length === 0 ? emptyState('❓', 'FAQ가 없습니다.') :
        `<div style="display:grid;gap:8px">${faqs.map((f) => `
          <div class="adm-card" style="padding:16px;cursor:pointer" data-id="${f.id}" data-action="edit-faq">
            <div style="font-size:14px;font-weight:600;color:var(--ink-deep)">${escapeHtml(f.q)}</div>
            <div style="font-size:13px;color:var(--slate);margin-top:6px;line-height:1.5">${escapeHtml(f.a)}</div>
            <div style="margin-top:8px">${(f.tags||[]).map((t)=>`<span class="tag">${escapeHtml(t)}</span>`).join(' ')}</div>
          </div>
        `).join('')}</div>`
      }
    </div>
  `;
}
export function mountFaqs() {
  $('#newFaqBtn')?.addEventListener('click', () => openFaqDrawer(null));
  $$('[data-action="edit-faq"]').forEach((c) => c.addEventListener('click', () => openFaqDrawer(c.dataset.id)));
}
function openFaqDrawer(id) {
  const isEdit = !!id;
  const f = id ? store.faqs.byId(id) : { q: '', a: '', tags: [] };
  openDrawer({
    title: isEdit ? 'FAQ 편집' : '+ 새 FAQ',
    body: `
      <div class="adm-field"><label>질문</label><input id="fa_q" value="${escapeHtml(f.q||'')}"></div>
      <div class="adm-field"><label>답변</label><textarea id="fa_a" style="min-height:140px">${escapeHtml(f.a||'')}</textarea></div>
      <div class="adm-field"><label>검색 태그 (쉼표)</label><input id="fa_tags" value="${escapeHtml((f.tags||[]).join(', '))}"></div>
    `,
    footer: `
      ${isEdit ? '<button class="adm-btn danger" id="fa_delete">삭제</button>' : ''}
      <button class="adm-btn secondary" id="fa_cancel">취소</button>
      <button class="adm-btn" id="fa_save">저장</button>
    `,
  });
  $('#fa_save').addEventListener('click', () => {
    const payload = {
      q: $('#fa_q').value.trim(),
      a: $('#fa_a').value.trim(),
      tags: $('#fa_tags').value.split(',').map((t)=>t.trim()).filter(Boolean),
    };
    if (!payload.q || !payload.a) { toast('질문과 답변은 필수입니다', 'error'); return; }
    if (isEdit) store.faqs.update(id, payload);
    else store.faqs.add(payload);
    closeDrawer();
    window.rerenderView?.();
  });
  $('#fa_cancel').addEventListener('click', closeDrawer);
  $('#fa_delete')?.addEventListener('click', () => {
    if (!window.confirm('삭제?')) return;
    store.faqs.remove(id);
    closeDrawer();
    window.rerenderView?.();
  });
}

/* ============================================================
   9. Chatbot config
   ============================================================ */
export function renderChatbot() {
  const cfg = store.chatConfig.get();
  const logs = store.chatLogs.all();
  return `
    <div class="adm-card">
      <h3>🤖 Gemini AI 챗봇 — 연결 상태
        <button class="adm-btn sm secondary" id="cb_testApi">API 테스트</button>
      </h3>
      <div class="desc">
        메인페이지 우하단의 챗봇이 <b>Gemini 3.0 Flash</b>에 연결되어 플랫폼의 모든 정보(가격표·케이스·FAQ·약속·프로세스)를 컨텍스트로 답변합니다.
        Gemini API 호출이 실패할 경우 자동으로 아래 규칙 기반(인텐트)으로 폴백합니다.
      </div>
      <div id="cb_status" style="padding:14px;border-radius:var(--r-md);background:var(--surface-soft);font-size:13px;line-height:1.6">
        <div style="color:var(--steel)">API 상태 확인 중…</div>
      </div>
      <div style="margin-top:14px;padding:14px;background:var(--cobalt-soft);border-radius:var(--r-md);font-size:12px;color:var(--cobalt-deep);line-height:1.6">
        <b>환경변수 설정 (Netlify Dashboard → Site settings → Environment variables)</b><br>
        <code style="font-family:var(--font-mono);background:rgba(0,0,0,.05);padding:1px 6px;border-radius:4px">GEMINI_API_KEY</code> = Google AI Studio에서 발급받은 키 (<b>필수</b>)<br>
        <code style="font-family:var(--font-mono);background:rgba(0,0,0,.05);padding:1px 6px;border-radius:4px">GEMINI_MODEL</code> = gemini-3.0-flash (선택, 기본값)
      </div>
    </div>

    <div class="adm-card">
      <h3>응답 가이드 / 시스템 프롬프트 추가 지침</h3>
      <div class="desc">이 텍스트는 Gemini의 시스템 프롬프트 끝에 추가됩니다. 회사 정보·가격·케이스는 자동으로 주입되니, 여기에는 <b>응답 톤·금지 사항·특별 안내</b>만 적어주세요.</div>
      <div class="adm-field">
        <label>추가 지침 (선택)</label>
        <textarea id="cb_systemExtra" style="min-height:120px" placeholder="예: 답변은 항상 친근한 반말로 한다 / 5월 한정 이벤트가 있을 경우 안내한다 / 특정 기술 스택은 권하지 않는다 등">${escapeHtml(cfg.systemPromptExtra||'')}</textarea>
      </div>
      <div class="adm-row">
        <div class="adm-field"><label>인사 메시지</label><textarea id="cb_greeting">${escapeHtml(cfg.greeting||'')}</textarea></div>
        <div class="adm-field"><label>매칭 실패 시 폴백 응답</label><textarea id="cb_fallback">${escapeHtml(cfg.fallback||'')}</textarea></div>
      </div>
    </div>

    <div class="adm-card">
      <h3>폴백 인텐트 (Gemini 미연결 시 사용)
        <button class="adm-btn ghost sm" id="cb_addIntent">+ 인텐트 추가</button>
      </h3>
      <div class="desc">API 호출이 실패할 경우에만 사용됩니다. 평소엔 Gemini가 모든 응답을 처리합니다.</div>
      <div id="cb_intents" style="display:grid;gap:8px"></div>

      <div style="margin-top:16px;display:flex;gap:8px">
        <button class="adm-btn" id="cb_save">전체 저장</button>
      </div>
    </div>

    <div class="adm-card">
      <h3>대화 로그 (${logs.length}건)</h3>
      ${logs.length === 0 ? emptyState('💬', '아직 대화 로그가 없습니다.') :
        `<div style="display:grid;gap:8px;max-height:480px;overflow-y:auto">
          ${[...logs].sort((a,b)=>(b.updatedAt||'').localeCompare(a.updatedAt||'')).slice(0, 20).map((l) => `
            <details class="adm-card" style="padding:14px">
              <summary style="cursor:pointer;font-size:13px;color:var(--ink-deep)">
                ${l.sessionId} <span style="color:var(--steel);margin-left:8px">${fmt.rel(l.updatedAt)}</span> · ${l.messages?.length||0} msg
              </summary>
              <div style="margin-top:12px;display:grid;gap:6px">
                ${(l.messages||[]).map((m) => `
                  <div style="font-size:12px;${m.role==='user'?'text-align:right':''}">
                    <span style="background:${m.role==='user'?'var(--cobalt)':'var(--surface-soft)'};color:${m.role==='user'?'#fff':'var(--ink)'};padding:6px 10px;border-radius:12px;display:inline-block;max-width:80%">${escapeHtml(m.text||'')}</span>
                  </div>
                `).join('')}
              </div>
            </details>
          `).join('')}
        </div>`
      }
    </div>
  `;
}
export function mountChatbot() {
  const cfg = store.chatConfig.get();
  let intents = [...(cfg.intents || [])];

  function renderIntents() {
    $('#cb_intents').innerHTML = intents.map((it, idx) => `
      <div class="adm-card" style="padding:14px;background:var(--surface-softer)">
        <div class="adm-row">
          <div class="adm-field" style="margin:0">
            <label>키워드 (쉼표)</label>
            <input data-idx="${idx}" data-k="patterns" value="${escapeHtml((it.patterns||[]).join(', '))}">
          </div>
          <div class="adm-field" style="margin:0">
            <label>링크 (선택, label|href, 쉼표)</label>
            <input data-idx="${idx}" data-k="links" value="${escapeHtml((it.links||[]).map(l=>`${l.label}|${l.href}`).join(', '))}">
          </div>
        </div>
        <div class="adm-field" style="margin-top:10px;margin-bottom:0">
          <label>응답</label>
          <textarea data-idx="${idx}" data-k="answer">${escapeHtml(it.answer||'')}</textarea>
        </div>
        <button class="adm-btn ghost sm" data-idx="${idx}" data-action="cb_del" style="margin-top:8px">삭제</button>
      </div>
    `).join('');

    $$('#cb_intents [data-k]').forEach((inp) => {
      inp.addEventListener('input', (e) => {
        const i = +e.target.dataset.idx;
        const k = e.target.dataset.k;
        if (k === 'patterns') intents[i].patterns = e.target.value.split(',').map(t=>t.trim()).filter(Boolean);
        else if (k === 'links') intents[i].links = e.target.value.split(',').map(t => {
          const [label, href] = t.split('|').map(x=>x.trim());
          return label && href ? { label, href } : null;
        }).filter(Boolean);
        else intents[i][k] = e.target.value;
      });
    });
    $$('[data-action="cb_del"]').forEach((b) => b.addEventListener('click', () => {
      intents.splice(+b.dataset.idx, 1);
      renderIntents();
    }));
  }
  $('#cb_addIntent').addEventListener('click', () => {
    intents.push({ patterns: [], answer: '', links: [] });
    renderIntents();
  });
  renderIntents();

  $('#cb_save').addEventListener('click', () => {
    store.chatConfig.set({
      greeting: $('#cb_greeting').value.trim(),
      fallback: $('#cb_fallback').value.trim(),
      systemPromptExtra: $('#cb_systemExtra')?.value || '',
      intents,
    });
    toast('챗봇 설정이 저장되었습니다', 'success');
  });

  // ============================================================
  // Live API status check
  // ============================================================
  async function checkApi() {
    const el = $('#cb_status');
    if (!el) return;
    el.innerHTML = '<div style="color:var(--steel)">API 상태 확인 중…</div>';
    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', text: '안녕하세요' }],
          context: {
            cases: store.cases.all(),
            faqs: store.faqs.all(),
            pricing: store.pricing.get(),
            settings: store.settings.get(),
          },
        }),
      });
      if (r.ok) {
        const data = await r.json();
        el.innerHTML = `
          <div style="display:flex;align-items:center;gap:10px;font-weight:600;color:var(--success)">
            <span style="width:10px;height:10px;border-radius:50%;background:var(--success);box-shadow:0 0 0 3px rgba(49,162,76,.2)"></span>
            정상 연결됨
          </div>
          <div style="margin-top:8px;font-size:12px;color:var(--steel)">
            <b>모델:</b> ${escapeHtml(data.model || '—')}<br>
            <b>토큰 사용:</b> 입력 ${data.tokens?.in ?? '?'} / 출력 ${data.tokens?.out ?? '?'} / 합계 ${data.tokens?.total ?? '?'}<br>
            <b>샘플 응답:</b> ${escapeHtml((data.answer || '').slice(0, 120))}…
          </div>
        `;
      } else if (r.status === 503) {
        const data = await r.json().catch(() => ({}));
        el.innerHTML = `
          <div style="display:flex;align-items:center;gap:10px;font-weight:600;color:var(--warning)">
            <span style="width:10px;height:10px;border-radius:50%;background:var(--warning)"></span>
            GEMINI_API_KEY 미설정
          </div>
          <div style="margin-top:8px;font-size:12px;color:var(--steel)">
            ${escapeHtml(data.hint || 'Netlify Site settings → Environment variables 에 키를 추가하고 재배포하세요.')}
          </div>
        `;
      } else {
        const txt = await r.text();
        el.innerHTML = `
          <div style="display:flex;align-items:center;gap:10px;font-weight:600;color:var(--critical)">
            <span style="width:10px;height:10px;border-radius:50%;background:var(--critical)"></span>
            오류 ${r.status}
          </div>
          <div style="margin-top:8px;font-size:11px;color:var(--steel);font-family:var(--font-mono);word-break:break-all">
            ${escapeHtml(txt.slice(0, 300))}
          </div>
        `;
      }
    } catch (e) {
      el.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;font-weight:600;color:var(--critical)">
          <span style="width:10px;height:10px;border-radius:50%;background:var(--critical)"></span>
          네트워크 오류
        </div>
        <div style="margin-top:8px;font-size:12px;color:var(--steel)">
          ${escapeHtml(String(e?.message || e))}
        </div>
      `;
    }
  }
  $('#cb_testApi')?.addEventListener('click', checkApi);
  checkApi();
}

/* ============================================================
   10. Automation
   ============================================================ */
export function renderAutomation() {
  const rules = store.automations.all();
  return `
    <div class="adm-card">
      <h3>자동화 룰
        <button class="adm-btn sm" id="newAutoBtn">+ 룰 추가</button>
      </h3>
      <div class="desc">트리거 발생 시 이메일·카톡 템플릿이 자동 발송됩니다. (실서비스 연결 전에는 자동화 로그만 남습니다)</div>
      ${rules.length === 0 ? emptyState('⚡', '자동화 룰이 없습니다.') :
        `<table class="adm-table">
          <thead><tr><th>이름</th><th>트리거</th><th>활성</th><th></th></tr></thead>
          <tbody>${rules.map((r) => `
            <tr>
              <td><b>${escapeHtml(r.name||'')}</b><div style="font-size:12px;color:var(--steel);margin-top:2px">${escapeHtml((r.template||'').slice(0,80))}…</div></td>
              <td><span class="tag cobalt">${escapeHtml(r.trigger||'')}</span></td>
              <td><label class="switch"><input type="checkbox" ${r.enabled?'checked':''} data-id="${r.id}" data-action="toggle-auto"><span class="slider"></span></label></td>
              <td>
                <button class="adm-btn sm secondary" data-action="edit-auto" data-id="${r.id}">편집</button>
                <button class="adm-btn sm ghost" data-action="del-auto" data-id="${r.id}">삭제</button>
              </td>
            </tr>
          `).join('')}</tbody>
        </table>`
      }
    </div>
  `;
}
export function mountAutomation() {
  $('#newAutoBtn')?.addEventListener('click', () => openAutoDrawer(null));
  $$('[data-action="edit-auto"]').forEach((b) => b.addEventListener('click', () => openAutoDrawer(b.dataset.id)));
  $$('[data-action="del-auto"]').forEach((b) => b.addEventListener('click', () => {
    if (!window.confirm('삭제?')) return;
    store.automations.remove(b.dataset.id);
    window.rerenderView?.();
  }));
  $$('[data-action="toggle-auto"]').forEach((c) => c.addEventListener('change', (e) => {
    store.automations.update(e.target.dataset.id, { enabled: e.target.checked });
  }));
}
function openAutoDrawer(id) {
  const isEdit = !!id;
  const r = id ? store.automations.byId(id) : { name: '', trigger: 'lead.new', template: '', enabled: true };
  openDrawer({
    title: isEdit ? '룰 편집' : '+ 새 룰',
    body: `
      <div class="adm-field"><label>이름</label><input id="au_name" value="${escapeHtml(r.name||'')}"></div>
      <div class="adm-field"><label>트리거</label>
        <select id="au_trigger">
          <option value="lead.new" ${r.trigger==='lead.new'?'selected':''}>신규 리드 접수</option>
          <option value="quote.sent" ${r.trigger==='quote.sent'?'selected':''}>견적 발송</option>
          <option value="quote.expired" ${r.trigger==='quote.expired'?'selected':''}>견적 만료 임박</option>
          <option value="project.weekly" ${r.trigger==='project.weekly'?'selected':''}>프로젝트 주간 보고</option>
          <option value="invoice.overdue" ${r.trigger==='invoice.overdue'?'selected':''}>인보이스 연체</option>
          <option value="warranty.ending" ${r.trigger==='warranty.ending'?'selected':''}>하자보증 만료 임박</option>
        </select>
      </div>
      <div class="adm-field"><label>템플릿 ({{name}}, {{company}}, {{client}} 등 변수 사용 가능)</label>
        <textarea id="au_template" style="min-height:140px">${escapeHtml(r.template||'')}</textarea>
      </div>
    `,
    footer: `
      ${isEdit ? '<button class="adm-btn danger" id="au_delete">삭제</button>' : ''}
      <button class="adm-btn secondary" id="au_cancel">취소</button>
      <button class="adm-btn" id="au_save">저장</button>
    `,
  });
  $('#au_save').addEventListener('click', () => {
    const payload = {
      name: $('#au_name').value.trim(),
      trigger: $('#au_trigger').value,
      template: $('#au_template').value,
      enabled: r.enabled,
    };
    if (isEdit) store.automations.update(id, payload);
    else store.automations.add(payload);
    toast('저장되었습니다', 'success');
    closeDrawer();
    window.rerenderView?.();
  });
  $('#au_cancel').addEventListener('click', closeDrawer);
  $('#au_delete')?.addEventListener('click', () => {
    store.automations.remove(id);
    closeDrawer();
    window.rerenderView?.();
  });
}

/* ============================================================
   11. KPI Analytics
   ============================================================ */
export function renderKpi() {
  const leads = store.leads.all();
  const quotes = store.quotes.all();
  const invoices = store.invoices.all();
  const totalRevenue = invoices.filter(i=>i.status==='paid').reduce((s, i) => s + (Number(i.amount)||0), 0);
  const conversion = leads.length > 0 ? leads.filter(l=>l.status==='won').length / leads.length : 0;
  const avgQuote = quotes.length > 0 ? quotes.reduce((s, q) => s + (Number(q.total)||0), 0) / quotes.length : 0;

  // source distribution
  const sources = {};
  leads.forEach((l) => { sources[l.source || 'website'] = (sources[l.source || 'website'] || 0) + 1; });

  return `
    <div class="kpi-row">
      <div class="kpi"><div class="label">누적 수주 매출</div><div class="value">${fmt.num(totalRevenue)}<small style="font-size:14px;color:var(--steel);font-weight:500"> 만원</small></div></div>
      <div class="kpi"><div class="label">리드 → 계약 전환율</div><div class="value">${(conversion*100).toFixed(1)}%</div></div>
      <div class="kpi"><div class="label">평균 견적 단가</div><div class="value">${fmt.num(avgQuote)}<small style="font-size:14px;color:var(--steel);font-weight:500"> 만원</small></div></div>
      <div class="kpi"><div class="label">활성 리드</div><div class="value">${leads.filter(l => !['won','lost'].includes(l.status)).length}</div></div>
    </div>

    <div class="adm-card">
      <h3>채널별 리드 유입</h3>
      <div class="chart-wrap"><canvas id="sourceChart"></canvas></div>
    </div>

    <div class="adm-card">
      <h3>월별 매출 추세 (12개월)</h3>
      <div class="chart-wrap tall"><canvas id="revenueChart"></canvas></div>
    </div>

    <div class="adm-card">
      <h3>예산대별 리드 분포</h3>
      <div class="chart-wrap"><canvas id="budgetChart"></canvas></div>
    </div>

    <div style="display:flex;gap:8px;margin-top:16px">
      <button class="adm-btn secondary" id="exportAllBtn">전체 데이터 백업 (JSON)</button>
      <button class="adm-btn secondary" id="exportLeadsCsv">리드 CSV</button>
      <button class="adm-btn secondary" id="exportInvCsv">인보이스 CSV</button>
    </div>
  `;
}
export function mountKpi() {
  const leads = store.leads.all();
  const invoices = store.invoices.all();

  if (window.Chart) {
    // Source chart
    const sources = {};
    leads.forEach((l) => { sources[l.source || 'website'] = (sources[l.source || 'website'] || 0) + 1; });
    const sCtx = $('#sourceChart');
    if (sCtx) new window.Chart(sCtx, {
      type: 'doughnut',
      data: {
        labels: Object.keys(sources),
        datasets: [{ data: Object.values(sources), backgroundColor: ['#0866FF', '#7AA8FF', '#0143B5', '#E5F0FE', '#9CA3AF'] }],
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right' } } },
    });

    // Revenue chart
    const rCtx = $('#revenueChart');
    if (rCtx) {
      const months = [];
      const sums = new Array(12).fill(0);
      const now = new Date();
      for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        months.push(`${d.getMonth()+1}월`);
      }
      invoices.filter(i => i.status === 'paid').forEach((i) => {
        const d = new Date(i.paidAt || i.createdAt);
        const diff = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
        if (diff >= 0 && diff < 12) sums[11 - diff] += Number(i.amount) || 0;
      });
      new window.Chart(rCtx, {
        type: 'bar',
        data: { labels: months, datasets: [{ label: '매출 (만원)', data: sums, backgroundColor: '#0866FF', borderRadius: 6 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } },
      });
    }

    // Budget chart
    const bCtx = $('#budgetChart');
    if (bCtx) {
      const buckets = {};
      leads.forEach((l) => { buckets[l.budget || '미정'] = (buckets[l.budget || '미정'] || 0) + 1; });
      new window.Chart(bCtx, {
        type: 'bar',
        data: { labels: Object.keys(buckets), datasets: [{ data: Object.values(buckets), backgroundColor: '#7AA8FF', borderRadius: 6 }] },
        options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } },
      });
    }
  }

  $('#exportAllBtn')?.addEventListener('click', () => {
    const dump = {
      cases: store.cases.all(),
      faqs: store.faqs.all(),
      posts: store.posts.all(),
      leads: store.leads.all(),
      quotes: store.quotes.all(),
      projects: store.projects.all(),
      invoices: store.invoices.all(),
      automations: store.automations.all(),
      chatConfig: store.chatConfig.get(),
      settings: store.settings.get(),
      exportedAt: utils.nowIso(),
    };
    downloadJson(dump, `hamkkework-backup-${new Date().toISOString().slice(0,10)}.json`);
    toast('전체 백업이 다운로드되었습니다', 'success');
  });
  $('#exportLeadsCsv')?.addEventListener('click', () => downloadCsv(leads.map(l=>({id:l.id,name:l.name,company:l.company,email:l.email,phone:l.phone,type:l.type,budget:l.budget,status:l.status,createdAt:l.createdAt})), 'leads.csv'));
  $('#exportInvCsv')?.addEventListener('click', () => downloadCsv(invoices.map(i=>({id:i.id,client:i.clientName,phase:i.phase,amount:i.amount,status:i.status,createdAt:i.createdAt,paidAt:i.paidAt})), 'invoices.csv'));
}

/* ============================================================
   12. Client portal admin
   ============================================================ */
export function renderPortal() {
  const clients = store.clients.all();
  return `
    <div class="adm-card">
      <h3>클라이언트 계정
        <button class="adm-btn sm" id="newClientBtn">+ 계정 생성</button>
      </h3>
      <div class="desc"><b>/portal</b> 페이지에서 로그인할 수 있는 계정입니다. 프로젝트 진행상황을 클라이언트가 직접 확인할 수 있습니다.</div>
      ${clients.length === 0 ? emptyState('👤', '발급된 계정이 없습니다.') :
        `<table class="adm-table">
          <thead><tr><th>이름</th><th>이메일</th><th>회사</th><th>접근권한</th><th></th></tr></thead>
          <tbody>${clients.map((c) => `
            <tr>
              <td><b>${escapeHtml(c.name||'')}</b></td>
              <td>${escapeHtml(c.email||'')}</td>
              <td>${escapeHtml(c.company||'—')}</td>
              <td>${(c.projects||[]).length}개 프로젝트</td>
              <td>
                <button class="adm-btn sm secondary" data-action="edit-client" data-id="${c.id}">편집</button>
                <button class="adm-btn sm ghost" data-action="del-client" data-id="${c.id}">삭제</button>
              </td>
            </tr>
          `).join('')}</tbody>
        </table>`
      }
    </div>
  `;
}
export function mountPortal() {
  $('#newClientBtn')?.addEventListener('click', () => openClientDrawer(null));
  $$('[data-action="edit-client"]').forEach((b) => b.addEventListener('click', () => openClientDrawer(b.dataset.id)));
  $$('[data-action="del-client"]').forEach((b) => b.addEventListener('click', () => {
    if (!window.confirm('삭제?')) return;
    store.clients.remove(b.dataset.id);
    window.rerenderView?.();
  }));
}
function openClientDrawer(id) {
  const isEdit = !!id;
  const c = id ? store.clients.byId(id) : { name: '', email: '', company: '', password: '', projects: [] };
  const allProjects = store.projects.all();
  openDrawer({
    title: isEdit ? '클라이언트 편집' : '+ 새 클라이언트',
    body: `
      <div class="adm-field"><label>이름</label><input id="cl_name" value="${escapeHtml(c.name||'')}"></div>
      <div class="adm-row">
        <div class="adm-field"><label>이메일 (로그인 ID)</label><input id="cl_email" type="email" value="${escapeHtml(c.email||'')}"></div>
        <div class="adm-field"><label>비밀번호</label><input id="cl_pwd" type="text" value="${escapeHtml(c.password||'')}" placeholder="발급할 비밀번호"></div>
      </div>
      <div class="adm-field"><label>회사</label><input id="cl_company" value="${escapeHtml(c.company||'')}"></div>
      <div class="adm-field">
        <label>접근 가능 프로젝트</label>
        ${allProjects.length === 0 ? '<div style="font-size:12px;color:var(--steel)">먼저 [프로젝트 진행]에서 프로젝트를 추가하세요.</div>' :
          allProjects.map((p) => `
            <label style="display:flex;align-items:center;gap:8px;padding:6px;cursor:pointer">
              <input type="checkbox" data-pid="${p.id}" ${(c.projects||[]).includes(p.id)?'checked':''}>
              <span>${escapeHtml(p.name||'—')} <span style="color:var(--steel);font-size:11px">${escapeHtml(p.clientName||'')}</span></span>
            </label>
          `).join('')
        }
      </div>
    `,
    footer: `
      ${isEdit ? '<button class="adm-btn danger" id="cl_delete">삭제</button>' : ''}
      <button class="adm-btn secondary" id="cl_cancel">취소</button>
      <button class="adm-btn" id="cl_save">저장</button>
    `,
  });
  $('#cl_save').addEventListener('click', () => {
    const projects = Array.from(document.querySelectorAll('[data-pid]:checked')).map(c => c.dataset.pid);
    const payload = {
      name: $('#cl_name').value.trim(),
      email: $('#cl_email').value.trim(),
      password: $('#cl_pwd').value,
      company: $('#cl_company').value.trim(),
      projects,
    };
    if (!payload.email || !payload.password) { toast('이메일과 비밀번호는 필수입니다', 'error'); return; }
    if (isEdit) store.clients.update(id, payload);
    else store.clients.add(payload);
    toast('저장되었습니다', 'success');
    closeDrawer();
    window.rerenderView?.();
  });
  $('#cl_cancel').addEventListener('click', closeDrawer);
  $('#cl_delete')?.addEventListener('click', () => {
    store.clients.remove(id);
    closeDrawer();
    window.rerenderView?.();
  });
}

/* ============================================================
   13. Settings
   ============================================================ */
export function renderSettings() {
  const s = store.settings.get();
  const p = store.pricing.get();
  return `
    <div class="adm-card">
      <h3>브랜드 / 회사 정보</h3>
      <div class="adm-row">
        <div class="adm-field"><label>브랜드명</label><input id="st_brand" value="${escapeHtml(s.brand||'')}"></div>
        <div class="adm-field"><label>대표 이메일</label><input id="st_email" value="${escapeHtml(s.email||'')}"></div>
      </div>
      <div class="adm-row">
        <div class="adm-field"><label>연락처</label><input id="st_phone" value="${escapeHtml(s.phone||'')}"></div>
        <div class="adm-field"><label>대표 PM</label><input id="st_pm" value="${escapeHtml(s.pm||'')}"></div>
      </div>
      <div class="adm-row">
        <div class="adm-field"><label>결제 일정 표기</label><input id="st_terms" value="${escapeHtml(s.invoice_terms||'')}"></div>
        <div class="adm-field"><label>하자보증 기간 (개월)</label><input id="st_warranty" type="number" value="${s.warranty_months||6}"></div>
      </div>
      <button class="adm-btn" id="st_save">저장</button>
    </div>

    <div class="adm-card">
      <h3>가격표 (견적 계산기 단가)</h3>
      <div class="desc">메인페이지의 [Pricing] 계산기와 어드민 견적서에 즉시 반영됩니다. 단위는 만원입니다.</div>
      <div class="adm-row">
        <div class="adm-field"><label>단순 페이지</label><input id="pr_ps" type="number" value="${p.pages_simple||30}"></div>
        <div class="adm-field"><label>복잡 페이지</label><input id="pr_pc" type="number" value="${p.pages_complex||80}"></div>
      </div>
      <div class="adm-row">
        <div class="adm-field"><label>기본 모듈</label><input id="pr_mb" type="number" value="${p.mod_basic||200}"></div>
        <div class="adm-field"><label>고급 모듈</label><input id="pr_ma" type="number" value="${p.mod_advanced||500}"></div>
      </div>
      <div class="adm-row">
        <div class="adm-field"><label>외부 연동</label><input id="pr_int" type="number" value="${p.integrations||300}"></div>
        <div class="adm-field"><label>오버헤드 비율 (%)</label><input id="pr_oh" type="number" value="${(p.overhead_ratio||0.25)*100}"></div>
      </div>
      <h3 style="margin-top:24px">AI 라인 단가</h3>
      <div class="adm-row">
        <div class="adm-field"><label>단순 LLM</label><input id="pr_llm" type="number" value="${p.ai?.llm_simple||200}"></div>
        <div class="adm-field"><label>RAG 구축</label><input id="pr_rag" type="number" value="${p.ai?.rag||1200}"></div>
      </div>
      <div class="adm-row">
        <div class="adm-field"><label>AI 에이전트</label><input id="pr_ag" type="number" value="${p.ai?.agent||1800}"></div>
        <div class="adm-field"><label>파인튜닝</label><input id="pr_ft" type="number" value="${p.ai?.finetune||2500}"></div>
      </div>
      <button class="adm-btn" id="pr_save">가격표 저장</button>
    </div>

    <div class="adm-card">
      <h3>데이터 관리</h3>
      <div class="desc">현재 데이터는 브라우저 localStorage에 저장됩니다. 정기적으로 백업하세요.</div>
      <button class="adm-btn secondary" id="bkBtn">전체 백업 (JSON)</button>
      <button class="adm-btn secondary" id="rsBtn">백업에서 복원</button>
      <button class="adm-btn danger" id="clearBtn" style="float:right">모든 데이터 초기화</button>
      <input id="bkFile" type="file" accept=".json" style="display:none">
    </div>
  `;
}
export function mountSettings() {
  $('#st_save')?.addEventListener('click', () => {
    store.settings.set({
      brand: $('#st_brand').value.trim(),
      email: $('#st_email').value.trim(),
      phone: $('#st_phone').value.trim(),
      pm: $('#st_pm').value.trim(),
      invoice_terms: $('#st_terms').value.trim(),
      warranty_months: Number($('#st_warranty').value) || 6,
    });
    toast('설정이 저장되었습니다', 'success');
  });
  $('#pr_save')?.addEventListener('click', () => {
    store.pricing.set({
      pages_simple: Number($('#pr_ps').value) || 30,
      pages_complex: Number($('#pr_pc').value) || 80,
      mod_basic: Number($('#pr_mb').value) || 200,
      mod_advanced: Number($('#pr_ma').value) || 500,
      integrations: Number($('#pr_int').value) || 300,
      overhead_ratio: (Number($('#pr_oh').value) || 25) / 100,
      range_ratio: 0.15,
      ai: {
        llm_simple: Number($('#pr_llm').value) || 200,
        rag: Number($('#pr_rag').value) || 1200,
        agent: Number($('#pr_ag').value) || 1800,
        finetune: Number($('#pr_ft').value) || 2500,
      },
    });
    toast('가격표가 저장되었습니다. 메인페이지에 즉시 반영됩니다.', 'success');
  });
  $('#bkBtn')?.addEventListener('click', () => {
    const dump = {
      cases: store.cases.all(),
      faqs: store.faqs.all(),
      posts: store.posts.all(),
      leads: store.leads.all(),
      quotes: store.quotes.all(),
      projects: store.projects.all(),
      invoices: store.invoices.all(),
      clients: store.clients.all(),
      automations: store.automations.all(),
      chatConfig: store.chatConfig.get(),
      pricing: store.pricing.get(),
      settings: store.settings.get(),
      exportedAt: utils.nowIso(),
    };
    downloadJson(dump, `hamkkework-${new Date().toISOString().slice(0,10)}.json`);
  });
  $('#rsBtn')?.addEventListener('click', () => $('#bkFile').click());
  $('#bkFile')?.addEventListener('change', async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!window.confirm('현재 데이터를 백업으로 덮어쓸까요? (계속하려면 OK)')) return;
      if (data.cases) store.cases.setAll(data.cases);
      if (data.faqs) store.faqs.setAll(data.faqs);
      if (data.posts) store.posts.setAll(data.posts);
      if (data.leads) store.leads.setAll(data.leads);
      if (data.quotes) store.quotes.setAll(data.quotes);
      if (data.projects) store.projects.setAll(data.projects);
      if (data.invoices) store.invoices.setAll(data.invoices);
      if (data.clients) store.clients.setAll(data.clients);
      if (data.automations) store.automations.setAll(data.automations);
      if (data.chatConfig) store.chatConfig.set(data.chatConfig);
      if (data.pricing) store.pricing.set(data.pricing);
      if (data.settings) store.settings.set(data.settings);
      toast('복원 완료', 'success');
      setTimeout(() => location.reload(), 800);
    } catch (err) {
      toast('백업 파일 형식이 잘못되었습니다', 'error');
    }
  });
  $('#clearBtn')?.addEventListener('click', () => {
    if (!window.confirm('정말 모든 데이터를 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.')) return;
    if (!window.confirm('한 번 더 확인합니다. 삭제하시겠습니까?')) return;
    localStorage.clear();
    location.reload();
  });
}
