/**
 * Admin views — one renderer per route key.
 * Each view exports a render function that returns the HTML and an optional `mount` hook.
 */

import { store, utils, ensureSeed, DEFAULT_QUALITY_TIERS, hashPassword, verifyPassword } from './store.js';
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
  quoteResponder: { title: '고객요청 답변생성', sub: '크몽·위시켓·프리모아 등 견적요청 → 사람 톤 답변문 자동 작성' },
  kpi: { title: 'KPI 분석', sub: '리드 전환 · 매출 추세 · 채널 분석' },
  analytics: { title: 'AI 분석', sub: 'A/B 변형 비교 · 시간대 히트맵 · 상위 질문' },
  knowledge: { title: '지식 베이스 (사전 응답)', sub: 'Gemini 호출 없이 즉시 응답 — 비용 0' },
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

  // 💰 AI 비용 계산 (이번 달 + 일일 추세 + 어뷰즈 감지)
  const usageLog = store.usageLog.all();
  const now = Date.now();
  const today0 = new Date(); today0.setHours(0, 0, 0, 0);
  const yesterday0 = new Date(today0); yesterday0.setDate(yesterday0.getDate() - 1);
  const weekAgo = new Date(today0); weekAgo.setDate(weekAgo.getDate() - 7);
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();

  const at = (e) => new Date(e.createdAt).getTime();
  const monthLog = usageLog.filter((e) => at(e) >= monthStart);
  const todayLog = usageLog.filter((e) => at(e) >= today0.getTime());
  const yesterdayLog = usageLog.filter((e) => at(e) >= yesterday0.getTime() && at(e) < today0.getTime());
  const weekLog = usageLog.filter((e) => at(e) >= weekAgo.getTime() && at(e) < today0.getTime());

  const sumCost = (arr) => arr.reduce((s, e) => s + (e.cost_usd || 0), 0);
  const monthCost = sumCost(monthLog);
  const todayCost = sumCost(todayLog);
  const yesterdayCost = sumCost(yesterdayLog);
  const weekAvgCost = sumCost(weekLog) / 7;
  const monthTokensIn = monthLog.reduce((s, e) => s + (e.tokens_in || 0), 0);
  const monthTokensOut = monthLog.reduce((s, e) => s + (e.tokens_out || 0), 0);
  const monthTokensCached = monthLog.reduce((s, e) => s + (e.tokens_cached || 0), 0);
  const cacheHitPct = monthTokensIn > 0 ? (monthTokensCached / monthTokensIn) * 100 : 0;
  const flashCalls = monthLog.filter((e) => e.tier === 'flash').length;
  const liteCalls = monthLog.filter((e) => e.tier === 'lite').length;
  const BUDGET = 50;
  const usagePct = Math.min(100, (monthCost / BUDGET) * 100);
  const usageColor = usagePct >= 100 ? 'var(--critical)' : usagePct >= 80 ? 'var(--warning)' : 'var(--cobalt)';

  // 일일 추세 — 어제 대비 +30% 또는 7일평균 대비 +50% 증가 시 경고
  const yesterdayDelta = yesterdayCost > 0 ? ((todayCost - yesterdayCost) / yesterdayCost) * 100 : 0;
  const weekDelta = weekAvgCost > 0 ? ((todayCost - weekAvgCost) / weekAvgCost) * 100 : 0;
  const trendAlert = todayCost > 0 && (yesterdayDelta > 30 || weekDelta > 50);

  // 🚨 어뷰즈 감지 — 최근 1시간 내 같은 세션이 30회+ 호출
  const oneHourAgo = now - 60 * 60 * 1000;
  const recentLog = usageLog.filter((e) => at(e) >= oneHourAgo);
  const sessionCounts = {};
  recentLog.forEach((e) => {
    const sid = e.sessionId || 'unknown';
    sessionCounts[sid] = (sessionCounts[sid] || 0) + 1;
  });
  const suspiciousSessions = Object.entries(sessionCounts)
    .filter(([_, n]) => n >= 30)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  return `
    <div class="kpi-row">
      <div class="kpi"><div class="label">이번주 신규 리드</div><div class="value">${newThisWeek}</div><div class="delta up">${leads.length}건 누적</div></div>
      <div class="kpi"><div class="label">진행 중 프로젝트</div><div class="value">${activeProjects}</div><div class="delta">${projects.length}건 전체</div></div>
      <div class="kpi"><div class="label">이번달 수주</div><div class="value">${wonThisMonth}</div><div class="delta up">+${wonThisMonth}건</div></div>
      <div class="kpi"><div class="label">미수금</div><div class="value">${fmt.num(pendingAmount)}<small style="font-size:14px;color:var(--steel);font-weight:500"> 만원</small></div><div class="delta ${pendingAmount > 0 ? 'down' : ''}">${invoices.filter(i=>i.status!=='paid').length}건</div></div>
    </div>

    <!-- 💰 AI 비용 모니터링 카드 -->
    <div class="adm-card" style="border-left:4px solid ${usageColor}">
      <h3>💰 AI 비용 모니터링 (이번 달)
        <span style="font-size:12px;font-weight:400;color:var(--steel)">예산 $${BUDGET} / 월</span>
      </h3>
      <div class="desc">스마트 라우팅으로 단순 응대는 Lite, 복잡한 추론은 Flash로 자동 분기. 한도 80% 도달 시 챗봇이 사용자에게 경고합니다.</div>

      <div style="display:flex;align-items:baseline;gap:14px;margin-bottom:10px">
        <div style="font-size:36px;font-weight:800;color:${usageColor};letter-spacing:-0.03em;line-height:1">$${monthCost.toFixed(2)}</div>
        <div style="font-size:14px;color:var(--steel)">/ $${BUDGET}</div>
        <div style="font-size:13px;color:${usageColor};font-weight:700">${usagePct.toFixed(1)}%</div>
      </div>

      <div style="height:10px;background:var(--hairline-soft);border-radius:999px;overflow:hidden;margin-bottom:18px">
        <div style="width:${usagePct}%;height:100%;background:${usageColor};transition:width 800ms ease"></div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:14px">
        <div style="padding:12px 14px;background:var(--surface-softer);border-radius:var(--r-md)">
          <div style="font-size:10px;font-weight:700;color:var(--steel);text-transform:uppercase;letter-spacing:.06em">Flash 호출</div>
          <div style="font-size:18px;font-weight:700;color:var(--ink-deep);margin-top:4px">${flashCalls}건</div>
          <div style="font-size:11px;color:var(--cobalt-deep)">복잡 추론</div>
        </div>
        <div style="padding:12px 14px;background:var(--surface-softer);border-radius:var(--r-md)">
          <div style="font-size:10px;font-weight:700;color:var(--steel);text-transform:uppercase;letter-spacing:.06em">Lite 호출</div>
          <div style="font-size:18px;font-weight:700;color:var(--ink-deep);margin-top:4px">${liteCalls}건</div>
          <div style="font-size:11px;color:var(--success)">저렴·빠름</div>
        </div>
        <div style="padding:12px 14px;background:var(--surface-softer);border-radius:var(--r-md)">
          <div style="font-size:10px;font-weight:700;color:var(--steel);text-transform:uppercase;letter-spacing:.06em">Input 토큰</div>
          <div style="font-size:18px;font-weight:700;color:var(--ink-deep);margin-top:4px">${fmt.num(monthTokensIn)}</div>
        </div>
        <div style="padding:12px 14px;background:var(--surface-softer);border-radius:var(--r-md)">
          <div style="font-size:10px;font-weight:700;color:var(--steel);text-transform:uppercase;letter-spacing:.06em">Output 토큰</div>
          <div style="font-size:18px;font-weight:700;color:var(--ink-deep);margin-top:4px">${fmt.num(monthTokensOut)}</div>
        </div>
        <div style="padding:12px 14px;background:var(--success-soft);border-radius:var(--r-md);border-left:3px solid var(--success)">
          <div style="font-size:10px;font-weight:700;color:var(--steel);text-transform:uppercase;letter-spacing:.06em">캐시 적중</div>
          <div style="font-size:18px;font-weight:800;color:var(--success);margin-top:4px">${cacheHitPct.toFixed(0)}%</div>
          <div style="font-size:11px;color:var(--steel)">${fmt.num(monthTokensCached)} 토큰 -75%</div>
        </div>
      </div>

      ${usagePct >= 80 ? `
        <div style="margin-top:14px;padding:10px 14px;background:var(--warning-soft);border-radius:var(--r-md);font-size:12px;color:#92400E">
          ⚠️ <b>예산 80% 도달.</b> 트래픽이 계속되면 곧 한도 초과합니다. 시스템 프롬프트를 압축하거나 모든 호출을 Lite로 전환하세요.
        </div>
      ` : ''}
    </div>

    <!-- 📊 일일 추세 카드 (Top 11) -->
    <div class="adm-card">
      <h3>📊 일일 비용 추세
        <span style="font-size:12px;font-weight:400;color:var(--steel)">오늘 vs 어제 vs 7일 평균</span>
      </h3>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px">
        <div style="padding:14px 16px;background:var(--surface-softer);border-radius:var(--r-md);border-left:3px solid var(--cobalt)">
          <div style="font-size:10px;font-weight:700;color:var(--steel);text-transform:uppercase;letter-spacing:.06em">오늘</div>
          <div style="font-size:22px;font-weight:800;color:var(--ink-deep);margin-top:4px">$${todayCost.toFixed(4)}</div>
          <div style="font-size:11px;color:var(--steel);margin-top:2px">${todayLog.length}회 호출</div>
        </div>
        <div style="padding:14px 16px;background:var(--surface-softer);border-radius:var(--r-md)">
          <div style="font-size:10px;font-weight:700;color:var(--steel);text-transform:uppercase;letter-spacing:.06em">어제</div>
          <div style="font-size:22px;font-weight:800;color:var(--ink);margin-top:4px">$${yesterdayCost.toFixed(4)}</div>
          <div style="font-size:11px;color:${yesterdayDelta > 30 ? 'var(--critical)' : (yesterdayDelta < -10 ? 'var(--success)' : 'var(--steel)')};margin-top:2px">
            ${yesterdayDelta > 0 ? '+' : ''}${yesterdayDelta.toFixed(0)}% 대비
          </div>
        </div>
        <div style="padding:14px 16px;background:var(--surface-softer);border-radius:var(--r-md)">
          <div style="font-size:10px;font-weight:700;color:var(--steel);text-transform:uppercase;letter-spacing:.06em">7일 평균</div>
          <div style="font-size:22px;font-weight:800;color:var(--ink);margin-top:4px">$${weekAvgCost.toFixed(4)}</div>
          <div style="font-size:11px;color:${weekDelta > 50 ? 'var(--critical)' : 'var(--steel)'};margin-top:2px">
            ${weekDelta > 0 ? '+' : ''}${weekDelta.toFixed(0)}% 대비
          </div>
        </div>
      </div>
      ${trendAlert ? `
        <div style="margin-top:12px;padding:10px 14px;background:var(--warning-soft);border-radius:var(--r-md);font-size:12px;color:#92400E">
          ⚠️ <b>오늘 비용이 평소보다 ${yesterdayDelta > weekDelta ? `어제 대비 +${yesterdayDelta.toFixed(0)}%` : `평균 대비 +${weekDelta.toFixed(0)}%`} 높습니다.</b> 트래픽 급증이나 어뷰즈 가능성 확인 권장.
        </div>
      ` : ''}
      ${suspiciousSessions.length > 0 ? `
        <div style="margin-top:12px;padding:12px 14px;background:var(--critical-soft);border-radius:var(--r-md);font-size:12px;color:var(--critical)">
          🚨 <b>어뷰즈 의심 세션 ${suspiciousSessions.length}건</b> (최근 1시간 내 30회+ 호출)
          <div style="margin-top:8px;font-family:var(--font-mono);font-size:11px;color:var(--ink)">
            ${suspiciousSessions.map(([s, n]) => `${s.slice(-8)}: ${n}회`).join(' · ')}
          </div>
          <div style="margin-top:6px;font-size:11px;color:var(--steel)">대처: Netlify 대시보드에서 해당 세션의 IP 차단 또는 챗봇 임시 비활성화 검토</div>
        </div>
      ` : ''}
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

    ${(() => {
      const allTasks = store.scheduledTasks.all().filter(t => t.status === 'pending');
      const callbacks = allTasks.filter(t => t.type === 'callback_request');
      const followups = allTasks.filter(t => t.type === 'followup_email');
      const now = Date.now();

      // 🔔 PM 통화 요청 (가장 중요 — 챗봇이 자동 등록)
      let html = '';
      if (callbacks.length > 0) {
        const urgent = callbacks.filter(t => t.urgency === 'urgent');
        html += `
          <div class="adm-card" style="border-left:4px solid var(--cobalt);background:linear-gradient(90deg,var(--cobalt-softer),var(--canvas) 30%)">
            <h3>🔔 PM 직접 연락 요청 <span style="font-size:11px;font-weight:400;color:var(--steel)">${callbacks.length}건 · 🚨 긴급 ${urgent.length}건</span></h3>
            <div class="desc">메인페이지 챗봇 대화 중 고객이 박두용 PM의 직접 연락을 요청한 건입니다. AI가 자동 등록.</div>
            <table class="adm-table">
              <thead><tr><th>요청자</th><th>연락 방법</th><th>주제</th><th>긴급도</th><th>요청 시각</th><th></th></tr></thead>
              <tbody>${callbacks.map(t => {
                const method = t.method === 'phone' ? '📞 전화' : t.method === 'email' ? '📨 이메일' : t.method === 'kakao' ? '💬 카톡' : t.method;
                const urg = t.urgency === 'urgent';
                return `
                  <tr ${urg ? 'style="background:var(--critical-soft)"' : ''}>
                    <td>
                      <b>${escapeHtml(t.leadName || '—')}</b>
                      <div style="font-size:11px;color:var(--steel)">세션: ${escapeHtml((t.sessionId || '').slice(-8))}</div>
                    </td>
                    <td style="font-size:13px">${method}<br><span style="color:var(--cobalt-deep);font-weight:600">${escapeHtml(t.contact || '')}</span></td>
                    <td style="font-size:13px">${escapeHtml(t.topic || '주제 미명시')}<div style="font-size:11px;color:var(--steel);margin-top:2px">선호 시간: ${escapeHtml(t.preferredTime || '-')}</div></td>
                    <td>${urg ? '<span class="tag critical">🚨 URGENT</span>' : '<span class="tag info">일반</span>'}</td>
                    <td style="font-size:12px;color:var(--steel)">${fmt.rel(t.createdAt)}</td>
                    <td>
                      ${t.method === 'phone' ? `<a class="adm-btn sm" href="tel:${escapeHtml(t.contact)}">📞 전화</a>` : ''}
                      ${t.method === 'email' ? `<a class="adm-btn sm" href="mailto:${escapeHtml(t.contact)}?subject=${encodeURIComponent('[함께워크_SI] ' + (t.topic || '연락드립니다'))}">📨 메일</a>` : ''}
                      <button class="adm-btn sm secondary" data-action="resolve-callback" data-id="${t.id}">처리완료</button>
                      <button class="adm-btn sm ghost" data-action="cancel-task" data-id="${t.id}">삭제</button>
                    </td>
                  </tr>
                `;
              }).join('')}</tbody>
            </table>
          </div>
        `;
      }

      // 📨 Follow-up 큐 (별도 카드)
      if (followups.length > 0) {
        const due = followups.filter(t => new Date(t.scheduledAt).getTime() <= now);
        html += `
          <div class="adm-card">
            <h3>📨 AI 예약 follow-up 메일
              <span style="font-size:11px;font-weight:400;color:var(--steel)">${due.length}건 발송 가능 · ${followups.length - due.length}건 대기</span>
            </h3>
            <div class="desc">AI 챗봇이 예약한 follow-up 메일입니다. 시간 도래 시 [지금 발송] 클릭.</div>
            <table class="adm-table">
              <thead><tr><th>수신</th><th>제목</th><th>예약일</th><th>상태</th><th></th></tr></thead>
              <tbody>${followups.map(t => {
                const isDue = new Date(t.scheduledAt).getTime() <= now;
                return `
                  <tr ${isDue ? 'style="background:var(--warning-soft)"' : ''}>
                    <td><b>${escapeHtml(t.leadName || '—')}</b><div style="font-size:11px;color:var(--steel)">${escapeHtml(t.leadEmail || '')}</div></td>
                    <td style="font-size:13px">${escapeHtml(t.subject || '')}</td>
                    <td style="font-size:12px;color:var(--steel)">${fmt.date(t.scheduledAt)}</td>
                    <td>${isDue ? '<span class="tag warning">발송 가능</span>' : '<span class="tag info">⏰ 대기</span>'}</td>
                    <td>
                      ${isDue ? `<button class="adm-btn sm" data-action="send-task" data-id="${t.id}">지금 발송</button>` : ''}
                      <button class="adm-btn sm ghost" data-action="cancel-task" data-id="${t.id}">취소</button>
                    </td>
                  </tr>
                `;
              }).join('')}</tbody>
            </table>
          </div>
        `;
      }
      return html;
    })()}

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

    ${(() => {
      const drafts = (store.emailDrafts.all() || []).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      const pending = drafts.filter((d) => d.status === 'draft');
      const failed = drafts.filter((d) => d.status === 'failed').slice(0, 3);
      const sent = drafts.filter((d) => d.status === 'sent').slice(0, 3);
      if (drafts.length === 0) return '';
      return `
        <div class="adm-card" style="border-left:4px solid var(--cobalt-deep)">
          <h3>📧 AI 작성 이메일
            <span style="font-size:11px;font-weight:400;color:var(--steel)">미발송 ${pending.length} · 실패 ${failed.length} · 발송 ${sent.length}</span>
          </h3>
          <div class="desc">
            AI가 챗봇 대화 중 작성한 이메일입니다. <code>RESEND_API_KEY</code> 환경변수가 있으면 자동 발송되고, 없으면 여기서 검토 후 수동 발송(📨 mailto) 가능합니다.
          </div>
          ${pending.length > 0 ? `
            <table class="adm-table" style="margin-top:8px">
              <thead><tr><th>수신</th><th>제목</th><th>관련</th><th>작성</th><th></th></tr></thead>
              <tbody>${pending.slice(0, 8).map((d) => `
                <tr>
                  <td><span style="color:var(--cobalt-deep);font-weight:600">${escapeHtml(d.to)}</span></td>
                  <td style="font-size:13px">${escapeHtml(d.subject)}</td>
                  <td style="font-size:12px">${escapeHtml(d.leadName || '—')}<div style="font-size:11px;color:var(--steel)">${escapeHtml(d.purpose || 'general')}</div></td>
                  <td style="font-size:12px;color:var(--steel)">${fmt.rel(d.createdAt)}</td>
                  <td>
                    <a class="adm-btn sm" href="mailto:${escapeHtml(d.to)}?subject=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(d.body)}">📨 발송 (메일러)</a>
                    <button class="adm-btn sm secondary" data-action="mark-email-sent" data-id="${d.id}">발송 완료 표시</button>
                    <button class="adm-btn sm ghost" data-action="view-email-body" data-id="${d.id}">본문 보기</button>
                    <button class="adm-btn sm ghost" data-action="delete-email" data-id="${d.id}" style="color:#dc2626">삭제</button>
                  </td>
                </tr>
              `).join('')}</tbody>
            </table>
          ` : `<div style="padding:12px;color:var(--steel);font-size:13px">미발송 드래프트가 없습니다.</div>`}
          ${failed.length > 0 ? `
            <details style="margin-top:8px"><summary style="cursor:pointer;font-size:12px;color:#dc2626">❌ 발송 실패 ${failed.length}건</summary>
              ${failed.map((d) => `<div style="font-size:12px;padding:6px;border:1px solid var(--line);border-radius:6px;margin-top:6px"><b>${escapeHtml(d.to)}</b> · ${escapeHtml(d.subject)}<br><code style="font-size:11px;color:#dc2626">${escapeHtml(d.error || '')}</code></div>`).join('')}
            </details>
          ` : ''}
          ${sent.length > 0 ? `
            <details style="margin-top:8px"><summary style="cursor:pointer;font-size:12px;color:var(--steel)">✅ 최근 발송 ${sent.length}건</summary>
              ${sent.map((d) => `<div style="font-size:12px;padding:6px;color:var(--steel)">📨 ${escapeHtml(d.to)} · ${escapeHtml(d.subject)} · ${fmt.rel(d.sentAt || d.createdAt)}</div>`).join('')}
            </details>
          ` : ''}
        </div>
      `;
    })()}
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

  // 📧 이메일 드래프트 액션 핸들러
  $$('[data-action="mark-email-sent"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      store.emailDrafts.update(id, { status: 'sent', sentAt: utils.nowIso(), sentBy: 'pm-manual' });
      toast('발송 완료로 표시했습니다', 'success');
      window.rerenderView?.();
    });
  });
  $$('[data-action="view-email-body"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const d = store.emailDrafts.byId(btn.dataset.id);
      if (!d) return;
      const win = window.open('', '_blank', 'width=600,height=500');
      win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(d.subject)}</title><style>body{font-family:system-ui;padding:24px;max-width:600px;margin:0 auto;line-height:1.6}h1{font-size:18px;margin:0 0 6px}.meta{font-size:12px;color:#666;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid #eee}.body{white-space:pre-wrap;background:#fafafa;padding:16px;border-radius:8px}</style></head><body><h1>${escapeHtml(d.subject)}</h1><div class="meta">To: <b>${escapeHtml(d.to)}</b> · ${escapeHtml(d.purpose||'general')} · ${escapeHtml(d.createdAt)}</div><div class="body">${escapeHtml(d.body)}</div></body></html>`);
    });
  });
  $$('[data-action="delete-email"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!confirm('이 이메일 드래프트를 삭제하시겠어요?')) return;
      store.emailDrafts.remove(btn.dataset.id);
      toast('삭제되었습니다', 'success');
      window.rerenderView?.();
    });
  });

  // 🤖 AI scheduled task — send-now / cancel
  $$('[data-action="send-task"]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const t = store.scheduledTasks.byId(btn.dataset.id);
      if (!t) return;
      if (!window.confirm(`${t.leadName || t.leadEmail}님께 follow-up 메일을 지금 발송할까요?`)) return;
      // open user mail client as fallback OR try server endpoint
      let serverOk = false;
      try {
        const r = await fetch('/api/send-lead', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: t.leadName || t.leadEmail,
            email: t.leadEmail,
            type: 'follow-up',
            message: `[자동 발송] ${t.subject}\n\n${t.body}`,
          }),
        });
        serverOk = r.ok;
      } catch {}
      if (!serverOk) {
        const mailto = `mailto:${encodeURIComponent(t.leadEmail)}?subject=${encodeURIComponent(t.subject)}&body=${encodeURIComponent(t.body)}`;
        window.open(mailto, '_blank');
      }
      store.scheduledTasks.update(t.id, { status: 'sent', sentAt: utils.nowIso() });
      toast(serverOk ? '서버를 통해 발송했습니다' : '메일 클라이언트를 열었습니다', 'success');
      window.rerenderView?.();
    });
  });
  $$('[data-action="cancel-task"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!window.confirm('해당 작업을 취소할까요?')) return;
      store.scheduledTasks.remove(btn.dataset.id);
      toast('취소되었습니다');
      window.rerenderView?.();
    });
  });

  // 🔔 PM 통화 요청 처리 완료
  $$('[data-action="resolve-callback"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const note = window.prompt('처리 메모를 입력하세요 (선택):', '');
      store.scheduledTasks.update(btn.dataset.id, {
        status: 'done',
        resolvedAt: utils.nowIso(),
        resolveNote: note || '',
      });
      toast('처리 완료로 표시했습니다', 'success');
      window.rerenderView?.();
    });
  });
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
  const aiBadge = l.aiSubmitted || l.source === 'chatbot-ai'
    ? `<span style="display:inline-block;font-size:9px;font-weight:800;background:linear-gradient(135deg,#0866FF,#7AA8FF);color:#fff;padding:2px 6px;border-radius:999px;margin-left:6px;letter-spacing:0.04em" title="AI 챗봇이 자동 등록한 리드">🤖 AI</span>`
    : '';
  return `
    <div class="kanban-card" draggable="true" data-id="${l.id}">
      <div class="who">${escapeHtml(l.name || '—')}${aiBadge}</div>
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
              <tr ${q.status === 'ai-draft' ? 'style="background:var(--cobalt-softer)"' : ''}>
                <td>
                  <b>${escapeHtml(q.title || '제목 없음')}</b>
                  ${q.aiSubmitted || q.status === 'ai-draft'
                    ? '<span style="display:inline-block;font-size:9px;font-weight:800;background:linear-gradient(135deg,#0866FF,#7AA8FF);color:#fff;padding:2px 6px;border-radius:999px;margin-left:6px;letter-spacing:0.04em" title="AI 챗봇이 작성한 초안">🤖 AI 초안</span>'
                    : ''}
                </td>
                <td>${escapeHtml(q.clientName || '—')}</td>
                <td style="color:var(--cobalt-deep);font-weight:700">${fmt.num(q.total || 0)} 만원</td>
                <td>${q.status === 'ai-draft'
                  ? '<span class="tag warning">검토 필요</span>'
                  : stageTag(q.status === 'sent' ? 'consult' : (q.status === 'accepted' ? 'won' : 'new'))}</td>
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
            <tr ${c.aiDraft ? 'style="background:var(--cobalt-softer)"' : ''}>
              <td><span class="tag cobalt">${escapeHtml(c.label||'')}</span></td>
              <td>${escapeHtml(c.client||'')}</td>
              <td>
                <b>${escapeHtml(c.title||'')}</b>
                ${c.aiDraft ? '<span style="display:inline-block;font-size:9px;font-weight:800;background:linear-gradient(135deg,#0866FF,#7AA8FF);color:#fff;padding:2px 6px;border-radius:999px;margin-left:6px" title="AI 챗봇이 작성한 초안">🤖 AI 초안</span>' : ''}
              </td>
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
            <tr ${p.aiDraft ? 'style="background:var(--cobalt-softer)"' : ''}>
              <td>
                <b>${escapeHtml(p.title||'')}</b>
                ${p.aiDraft ? '<span style="display:inline-block;font-size:9px;font-weight:800;background:linear-gradient(135deg,#0866FF,#7AA8FF);color:#fff;padding:2px 6px;border-radius:999px;margin-left:6px" title="AI 챗봇이 작성한 초안">🤖 AI 초안</span>' : ''}
                <div style="font-size:11px;color:var(--steel);margin-top:2px">${escapeHtml(p.excerpt||'')}</div>
              </td>
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
      <h3>🤖 챗봇 행동 지침 (Behavior Rules)
        <button class="adm-btn ghost sm" id="cb_addRule">+ 규칙 추가</button>
      </h3>
      <div class="desc">
        모든 사용자 응답에 자동 적용되는 행동 규칙입니다. <b>AI가 추가한 규칙도 여기서 편집·삭제 가능</b>합니다.<br>
        어드민 챗봇에 <code>"다음부터 ㅇㅇ해줘"</code>라고 말하면 AI가 자동으로 여기에 한 줄 추가합니다.
      </div>
      <div id="cb_rules" style="display:grid;gap:8px;margin-top:12px"></div>
      <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="adm-btn" id="cb_rulesSave">규칙 저장</button>
        <button class="adm-btn ghost sm" id="cb_rulesClear" style="margin-left:auto">전체 삭제</button>
      </div>
    </div>

    <div class="adm-card">
      <h3>인사 / 폴백 메시지</h3>
      <div class="adm-row">
        <div class="adm-field"><label>인사 메시지 (챗봇 열 때 첫 인사)</label><textarea id="cb_greeting">${escapeHtml(cfg.greeting||'')}</textarea></div>
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

  // ── botRules: 챗봇 행동 지침 CRUD ──
  // legacy systemPromptExtra(string) 마이그레이션: botRules 없으면 한 줄씩 split
  function migrateLegacyRules() {
    if (Array.isArray(cfg.botRules)) return [...cfg.botRules];
    const legacy = (cfg.systemPromptExtra || '').trim();
    if (!legacy) return [];
    return legacy.split('\n')
      .map((l) => l.replace(/^[-•*]\s*/, '').trim())
      .filter(Boolean)
      .map((text, i) => ({
        id: 'legacy_' + i + '_' + Date.now().toString(36),
        text,
        source: 'pm',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      }));
  }
  let botRules = migrateLegacyRules();

  function fmtRelDate(iso) {
    if (!iso || iso.startsWith('1970')) return '';
    try {
      const d = new Date(iso);
      const diff = Date.now() - d.getTime();
      const days = Math.floor(diff / 86400000);
      if (days === 0) return '오늘';
      if (days === 1) return '어제';
      if (days < 7) return `${days}일 전`;
      return d.toISOString().slice(0, 10);
    } catch { return ''; }
  }

  function renderRules() {
    const host = $('#cb_rules');
    if (!host) return;
    if (botRules.length === 0) {
      host.innerHTML = `<div style="padding:24px;text-align:center;color:var(--steel);background:var(--surface-soft);border-radius:8px;font-size:13px">행동 지침이 없습니다. "+ 규칙 추가" 또는 어드민 챗봇에 "다음부터 ㅇㅇ해줘"라고 말해보세요.</div>`;
      return;
    }
    host.innerHTML = botRules.map((r, idx) => {
      const badge = r.source === 'ai'
        ? `<span style="background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600">🤖 AI 추가</span>`
        : `<span style="background:#dbeafe;color:#1e40af;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600">✍️ PM 작성</span>`;
      const rel = fmtRelDate(r.createdAt);
      return `
        <div class="adm-card" style="padding:12px 14px;background:var(--surface-softer);display:flex;gap:10px;align-items:flex-start">
          <div style="flex-shrink:0;font-weight:700;color:var(--steel);font-size:12px;padding-top:8px;min-width:24px">${idx + 1}.</div>
          <div style="flex:1;display:flex;flex-direction:column;gap:6px">
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              ${badge}
              ${rel ? `<span style="font-size:11px;color:var(--steel)">${rel}</span>` : ''}
            </div>
            <textarea data-rule-idx="${idx}" data-rule-k="text" rows="2" style="width:100%;padding:6px 10px;border-radius:6px;border:1px solid var(--line,#ddd);font-family:inherit;resize:vertical;font-size:13.5px">${escapeHtml(r.text || '')}</textarea>
          </div>
          <button class="adm-btn ghost sm" data-rule-action="del" data-rule-idx="${idx}" style="flex-shrink:0;color:#dc2626" title="삭제">✕</button>
        </div>
      `;
    }).join('');

    host.querySelectorAll('[data-rule-k="text"]').forEach((ta) => {
      ta.addEventListener('input', (e) => {
        const i = +e.target.dataset.ruleIdx;
        botRules[i].text = e.target.value;
        botRules[i].updatedAt = new Date().toISOString();
      });
    });
    host.querySelectorAll('[data-rule-action="del"]').forEach((b) => {
      b.addEventListener('click', () => {
        botRules.splice(+b.dataset.ruleIdx, 1);
        renderRules();
      });
    });
  }

  $('#cb_addRule')?.addEventListener('click', () => {
    botRules.push({
      id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      text: '',
      source: 'pm',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    renderRules();
  });

  $('#cb_rulesClear')?.addEventListener('click', () => {
    if (!confirm('모든 행동 지침을 삭제하시겠어요? AI가 추가한 규칙도 함께 삭제됩니다.')) return;
    botRules = [];
    renderRules();
  });

  $('#cb_rulesSave')?.addEventListener('click', () => {
    const cleaned = botRules.filter((r) => r.text && r.text.trim());
    const existing = store.chatConfig.get();
    store.chatConfig.set({
      ...existing,
      botRules: cleaned,
      // legacy systemPromptExtra도 동기화 (구버전 클라이언트 호환)
      systemPromptExtra: cleaned.map((r) => `- ${r.text.trim()}`).join('\n'),
    });
    botRules = cleaned;
    renderRules();
    toast(`행동 지침 ${cleaned.length}개가 저장되었습니다. 다음 사용자 응답부터 적용됩니다.`, 'success');
  });

  renderRules();

  // 30초 polling으로 다른 기기/AI 도구가 변경한 botRules를 자동 반영
  const ruleSyncHandler = (e) => {
    if (e.detail?.key?.endsWith('.chatConfig')) {
      const latest = store.chatConfig.get();
      botRules = Array.isArray(latest.botRules) ? [...latest.botRules] : migrateLegacyRules();
      renderRules();
    }
  };
  window.addEventListener('store:change', ruleSyncHandler);
  // cleanup은 admin-views가 보통 unmount할 때 처리하지만 명시적 cleanup hook이 없으므로 기록만

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
    const existing = store.chatConfig.get();
    store.chatConfig.set({
      ...existing, // botRules / systemPromptExtra 보존 (행동 지침은 cb_rulesSave에서 별도 저장)
      greeting: $('#cb_greeting').value.trim(),
      fallback: $('#cb_fallback').value.trim(),
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
   11.5  AI Analytics — A/B + 히트맵 + 상위 질문 (Top 12)
   ============================================================ */
export function renderAnalytics() {
  const chatLogs = store.chatLogs.all();
  const usageLog = store.usageLog.all();
  const leads = store.leads.all();

  // ─── A/B 변형 비교 ──────────────────────────────────────
  const variantStats = (v) => {
    const sessions = chatLogs.filter((l) => l.variant === v);
    const sessionIds = new Set(sessions.map((s) => s.sessionId));
    const usage = usageLog.filter((u) => u.variant === v || sessionIds.has(u.sessionId));
    const variantLeads = leads.filter((l) => l.variant === v && l.source === 'chatbot-ai');
    const totalMsgs = sessions.reduce((s, l) => s + (l.messages?.length || 0), 0);
    const cost = usage.reduce((s, u) => s + (u.cost_usd || 0), 0);
    return {
      sessions: sessions.length,
      avgMsgs: sessions.length ? (totalMsgs / sessions.length).toFixed(1) : '0',
      leads: variantLeads.length,
      conversion: sessions.length ? ((variantLeads.length / sessions.length) * 100).toFixed(1) : '0',
      cost: cost.toFixed(4),
      avgCostPerSession: sessions.length ? (cost / sessions.length).toFixed(5) : '0',
    };
  };
  const aStats = variantStats('A');
  const bStats = variantStats('B');
  const totalSessions = aStats.sessions + bStats.sessions;
  const hasData = totalSessions >= 4;
  // 통계적 유의성 — 단순 휴리스틱 (세션 50건+ & 전환율 차이 30%+)
  const sigA = parseFloat(aStats.conversion);
  const sigB = parseFloat(bStats.conversion);
  const lift = sigA > 0 ? ((sigB - sigA) / sigA) * 100 : 0;
  const reliable = totalSessions >= 50;
  const winner = !hasData ? null : sigB > sigA * 1.1 ? 'B' : sigA > sigB * 1.1 ? 'A' : null;

  // ─── 시간대 히트맵 (24h x 7day) ─────────────────────
  const heatmap = Array.from({ length: 7 }, () => new Array(24).fill(0));
  chatLogs.forEach((l) => {
    (l.messages || []).filter((m) => m.role === 'user').forEach((m) => {
      const d = new Date(m.at);
      if (isNaN(d)) return;
      heatmap[d.getDay()][d.getHours()]++;
    });
  });
  const maxHeat = Math.max(1, ...heatmap.flat());

  // ─── 상위 질문 TOP 10 ───────────────────────────────
  const questionFreq = {};
  chatLogs.forEach((l) => {
    const firstUser = (l.messages || []).find((m) => m.role === 'user');
    if (!firstUser?.text) return;
    const key = firstUser.text.trim().slice(0, 60).toLowerCase();
    questionFreq[key] = (questionFreq[key] || 0) + 1;
  });
  const topQuestions = Object.entries(questionFreq).sort((a, b) => b[1] - a[1]).slice(0, 10);

  // ─── 키워드 빈도 (단순 토큰화) ─────────────────────
  const stopwords = new Set(['있나요', '있어요', '어떻게', '무엇', '어떤', '뭐', '왜', '얼마', '있습니까', '있을까요', '하나요', '인가요', '입니다', '습니다', '있는', '같은', '되나요', '될까요']);
  const wordFreq = {};
  chatLogs.forEach((l) => {
    (l.messages || []).filter((m) => m.role === 'user').forEach((m) => {
      (m.text || '').toLowerCase().split(/[\s,.!?·~（）()\[\]]+/).forEach((w) => {
        const t = w.trim();
        if (t.length < 2 || stopwords.has(t) || /^\d+$/.test(t)) return;
        wordFreq[t] = (wordFreq[t] || 0) + 1;
      });
    });
  });
  const topWords = Object.entries(wordFreq).sort((a, b) => b[1] - a[1]).slice(0, 20);
  const maxWord = topWords[0]?.[1] || 1;

  // ─── 챗봇 퍼널 ──────────────────────────────────────
  const opens = chatLogs.length;
  const withUserMsg = chatLogs.filter((l) => (l.messages || []).some((m) => m.role === 'user')).length;
  const withToolCall = leads.filter((l) => l.source === 'chatbot-ai').length;
  const aiLeads = withToolCall;
  const stages = [
    { label: '챗봇 오픈', n: opens, color: 'var(--cobalt)' },
    { label: '첫 메시지', n: withUserMsg, color: 'var(--cobalt-deep)' },
    { label: '리드 등록', n: aiLeads, color: 'var(--success)' },
  ];
  const maxStage = Math.max(1, ...stages.map((s) => s.n));

  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
  const heatColor = (v) => {
    if (v === 0) return 'var(--surface-softer)';
    const intensity = v / maxHeat;
    if (intensity < 0.25) return 'rgba(8, 102, 255, 0.15)';
    if (intensity < 0.5) return 'rgba(8, 102, 255, 0.35)';
    if (intensity < 0.75) return 'rgba(8, 102, 255, 0.6)';
    return 'rgba(8, 102, 255, 0.9)';
  };

  return `
    <div class="adm-card">
      <h3>🧪 A/B 변형 비교
        <span style="font-size:12px;font-weight:400;color:var(--steel)">
          ${hasData ? `${totalSessions}개 세션` : `데이터 수집 중 (${totalSessions}/4)`}
          ${reliable ? ` · 신뢰 가능 (50+ 세션)` : ` · 신뢰 부족`}
        </span>
      </h3>
      <div class="desc">
        고객 챗봇 응답 톤을 A(친근)와 B(격식) 두 변형으로 무작위 배포해서 어느 쪽이 더 잘 전환되는지 측정합니다.
        ${winner ? `현재 우세: <b style="color:var(--success)">변형 ${winner}</b> (Lift ${lift > 0 ? '+' : ''}${lift.toFixed(1)}%)` : ''}
      </div>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:14px">
        ${[['A', '친근 톤', aStats, 'var(--cobalt)'], ['B', '격식 톤', bStats, 'var(--ink-deep)']].map(([v, label, s, color]) => `
          <div style="padding:18px 20px;background:var(--surface-softer);border-radius:var(--r-md);border-left:4px solid ${color}${winner === v ? ';outline:2px solid var(--success);outline-offset:-2px' : ''}">
            <div style="font-size:14px;font-weight:700;color:${color};margin-bottom:4px">변형 ${v} ${winner === v ? '🏆' : ''}</div>
            <div style="font-size:11px;color:var(--steel);margin-bottom:14px">${label}</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:12px">
              <div><div style="color:var(--steel)">세션</div><div style="font-size:18px;font-weight:700;color:var(--ink-deep)">${s.sessions}</div></div>
              <div><div style="color:var(--steel)">평균 메시지</div><div style="font-size:18px;font-weight:700;color:var(--ink-deep)">${s.avgMsgs}</div></div>
              <div><div style="color:var(--steel)">리드 전환</div><div style="font-size:18px;font-weight:700;color:${color}">${s.conversion}%</div><div style="font-size:10px;color:var(--steel)">${s.leads}건</div></div>
              <div><div style="color:var(--steel)">세션당 비용</div><div style="font-size:18px;font-weight:700;color:var(--ink-deep)">$${s.avgCostPerSession}</div></div>
            </div>
          </div>
        `).join('')}
      </div>
      ${!reliable && hasData ? `<div style="margin-top:12px;padding:10px 14px;background:var(--cobalt-softer);border-radius:var(--r-md);font-size:12px;color:var(--cobalt-deep)">⏳ 50개 세션 이상 수집 시 결과가 통계적으로 의미 있어집니다. 현재 ${totalSessions}건.</div>` : ''}
    </div>

    <div class="adm-card">
      <h3>📊 챗봇 전환 퍼널
        <span style="font-size:12px;font-weight:400;color:var(--steel)">전체 ${opens}개 세션 기준</span>
      </h3>
      <div class="desc">챗봇 오픈 → 메시지 입력 → 리드 등록까지 각 단계 전환율.</div>
      <div class="funnel" style="margin-top:14px">
        ${stages.map((s, i) => {
          const pct = stages[0].n > 0 ? (s.n / stages[0].n) * 100 : 0;
          return `
            <div class="funnel-step">
              <div class="funnel-bar" style="height:${Math.max(40, (s.n / maxStage) * 200)}px;background:${s.color}">${s.n}</div>
              <div class="label">${s.label}<br><small style="color:var(--steel);font-weight:400">${pct.toFixed(0)}%</small></div>
            </div>
          `;
        }).join('')}
      </div>
    </div>

    <div class="adm-card">
      <h3>🕐 시간대별 트래픽 히트맵
        <span style="font-size:12px;font-weight:400;color:var(--steel)">사용자 메시지 발생 빈도</span>
      </h3>
      <div class="desc">언제 응대 준비가 필요한지 한눈에. 진한 셀이 트래픽이 많은 시간대입니다.</div>
      <div style="overflow-x:auto;margin-top:10px">
        <table style="border-collapse:separate;border-spacing:2px;font-size:10px">
          <thead>
            <tr><th style="width:30px"></th>${Array.from({length:24},(_,h)=>`<th style="width:24px;color:var(--steel);font-weight:500;font-size:9px">${h}</th>`).join('')}</tr>
          </thead>
          <tbody>
            ${heatmap.map((row, day) => `
              <tr>
                <td style="color:var(--steel);font-weight:600;text-align:right;padding-right:4px">${dayNames[day]}</td>
                ${row.map((v, h) => `<td style="width:24px;height:24px;background:${heatColor(v)};border-radius:3px;text-align:center;color:${v>maxHeat*0.5?'#fff':'var(--ink)'};font-weight:600" title="${dayNames[day]}요일 ${h}시 - ${v}건">${v||''}</td>`).join('')}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:10px;font-size:11px;color:var(--steel)">
        <span>적음</span>
        <div style="width:18px;height:14px;background:rgba(8,102,255,0.15);border-radius:2px"></div>
        <div style="width:18px;height:14px;background:rgba(8,102,255,0.35);border-radius:2px"></div>
        <div style="width:18px;height:14px;background:rgba(8,102,255,0.6);border-radius:2px"></div>
        <div style="width:18px;height:14px;background:rgba(8,102,255,0.9);border-radius:2px"></div>
        <span>많음 (최대 ${maxHeat}건)</span>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
      <div class="adm-card">
        <h3>❓ 상위 첫 질문 TOP 10</h3>
        <div class="desc">사용자가 챗봇 열고 처음 던지는 질문 — FAQ 후보로 좋습니다.</div>
        ${topQuestions.length === 0 ? emptyState('💬', '아직 데이터가 없습니다.') :
          `<ol style="margin:10px 0 0;padding-left:24px;font-size:13px;line-height:1.8">
            ${topQuestions.map(([q, n]) => `<li><span style="color:var(--ink)">${escapeHtml(q)}</span> <span style="color:var(--cobalt-deep);font-weight:700">${n}회</span></li>`).join('')}
          </ol>`
        }
      </div>
      <div class="adm-card">
        <h3>🔤 키워드 빈도 TOP 20</h3>
        <div class="desc">사용자 메시지에 자주 등장하는 단어 — 콘텐츠 우선순위 참고.</div>
        ${topWords.length === 0 ? emptyState('🔤', '아직 데이터가 없습니다.') :
          `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px">
            ${topWords.map(([w, n]) => {
              const size = 11 + Math.round((n / maxWord) * 9);
              const opacity = 0.5 + (n / maxWord) * 0.5;
              return `<span style="display:inline-block;padding:4px 10px;background:rgba(8,102,255,${opacity * 0.15});color:var(--cobalt-deep);border-radius:999px;font-size:${size}px;font-weight:600">${escapeHtml(w)} <small style="color:var(--steel)">${n}</small></span>`;
            }).join('')}
          </div>`
        }
      </div>
    </div>

    <div class="adm-card" style="background:var(--surface-softer)">
      <h3>📌 이 페이지 활용법</h3>
      <ul style="margin:8px 0 0;padding-left:20px;font-size:13px;line-height:1.8;color:var(--ink)">
        <li><b>A/B 비교</b> — 변형 A(친근) vs B(격식) 중 어느 쪽이 더 많이 리드로 전환되는지 추적. 50+ 세션 이상이면 신뢰 가능. 우세한 쪽으로 통일하려면 <code>chatbot.js</code>의 <code>pickVariant()</code> 함수를 수정하거나, 기본 톤을 시스템 프롬프트에 박으세요.</li>
        <li><b>퍼널</b> — 오픈 대비 메시지 입력률이 낮으면 첫 인사 매력도가 부족, 메시지 입력 대비 리드 등록률이 낮으면 도구 호출 트리거가 약함.</li>
        <li><b>히트맵</b> — 트래픽이 몰리는 시간대에 박두용 PM이 즉시 응대 가능하도록 알림 채널을 강화하거나, 한산한 시간대를 활용해 follow-up을 보낼 수 있습니다.</li>
        <li><b>상위 질문</b> — 자주 묻는 첫 질문은 FAQ로 등록하면 챗봇 호출 비용을 절감할 수 있습니다. <a href="#faqs" data-nav="faqs">FAQ 편집 →</a></li>
      </ul>
    </div>
  `;
}
export function mountAnalytics() {
  // 하위 네비게이션 처리 (FAQ 링크 등)
  $$('[data-nav]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      window.navTo?.(a.dataset.nav);
    });
  });
}

/* ============================================================
   11.6  Knowledge Base — Frozen Responses (Top-N 사전 응답) #4
   - 키워드 매칭 → Gemini 호출 0, 즉시 응답
   - 분석 페이지의 "상위 질문 TOP 10"에서 추출 가능
   ============================================================ */
export function renderKnowledge() {
  const items = store.frozenResponses.all();
  const chatLogs = store.chatLogs.all();
  const usageLog = store.usageLog.all();

  // 절감 효과 추정: hits × 평균 호출 비용
  const totalHits = items.reduce((s, x) => s + (x.hits || 0), 0);
  const recentLog = usageLog.slice(-50);
  const avgCost = recentLog.length
    ? recentLog.reduce((s, e) => s + (e.cost_usd || 0), 0) / recentLog.length
    : 0.00025;
  const savedUsd = (totalHits * avgCost).toFixed(4);

  // 상위 첫 질문 (자동 제안용)
  const firstQs = {};
  chatLogs.forEach((l) => {
    const firstUser = (l.messages || []).find((m) => m.role === 'user');
    if (!firstUser?.text) return;
    const key = firstUser.text.trim().slice(0, 80);
    firstQs[key] = (firstQs[key] || 0) + 1;
  });
  const suggestions = Object.entries(firstQs)
    .filter(([q]) => !items.some((x) => (x.keywords || []).some((k) => q.toLowerCase().includes((k || '').toLowerCase()))))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  return `
    <div class="adm-card" style="border-left:4px solid var(--success);background:linear-gradient(90deg,var(--success-soft),var(--canvas) 30%)">
      <h3>💰 사전 응답 캐시 효과
        <span style="font-size:12px;font-weight:400;color:var(--steel)">${items.length}개 등록 · 누적 적중 ${totalHits}회</span>
      </h3>
      <div class="desc">PM이 직접 작성한 "표준 답변"을 키워드와 매칭. 매칭되면 Gemini API 호출 없이 즉시 답변 → <b>비용 0</b>.</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:10px">
        <div style="padding:14px 16px;background:var(--surface-softer);border-radius:var(--r-md)">
          <div style="font-size:10px;font-weight:700;color:var(--steel);text-transform:uppercase">등록 응답</div>
          <div style="font-size:22px;font-weight:800;color:var(--ink-deep);margin-top:4px">${items.length}건</div>
        </div>
        <div style="padding:14px 16px;background:var(--surface-softer);border-radius:var(--r-md)">
          <div style="font-size:10px;font-weight:700;color:var(--steel);text-transform:uppercase">누적 적중</div>
          <div style="font-size:22px;font-weight:800;color:var(--success);margin-top:4px">${totalHits}회</div>
        </div>
        <div style="padding:14px 16px;background:var(--surface-softer);border-radius:var(--r-md)">
          <div style="font-size:10px;font-weight:700;color:var(--steel);text-transform:uppercase">예상 절감</div>
          <div style="font-size:22px;font-weight:800;color:var(--success);margin-top:4px">$${savedUsd}</div>
        </div>
      </div>
    </div>

    ${suggestions.length > 0 ? `
      <div class="adm-card" style="border-left:4px solid var(--cobalt)">
        <h3>💡 추천 — 사용자가 자주 묻는 질문 ${suggestions.length}개</h3>
        <div class="desc">아직 표준 답변이 없는 질문입니다. 클릭하면 키워드와 답변 초안이 자동으로 채워집니다.</div>
        <div style="display:flex;flex-direction:column;gap:6px;margin-top:10px">
          ${suggestions.map(([q, n]) => `
            <button class="adm-btn ghost" style="text-align:left;justify-content:space-between;padding:10px 14px" data-suggest="${escapeHtml(q)}">
              <span style="font-size:13px;color:var(--ink)">${escapeHtml(q)}</span>
              <span style="font-size:11px;color:var(--cobalt-deep);font-weight:700">${n}회 · 클릭하면 추가 →</span>
            </button>
          `).join('')}
        </div>
      </div>
    ` : ''}

    <div class="adm-card">
      <h3>📚 등록된 사전 응답
        <button class="adm-btn sm" id="newFrozenBtn">+ 새 응답 추가</button>
      </h3>
      <div class="desc">키워드(AND/OR)와 답변을 작성. 사용자 질문에 모든(또는 일부) 키워드가 포함되면 즉시 응답.</div>
      ${items.length === 0 ? emptyState('🧊', '아직 등록된 사전 응답이 없습니다. 위 추천에서 클릭하거나 + 버튼으로 시작하세요.') : `
        <table class="adm-table">
          <thead>
            <tr>
              <th style="width:18%">제목</th>
              <th style="width:24%">키워드</th>
              <th style="width:36%">답변 (앞 80자)</th>
              <th style="width:8%">매칭</th>
              <th style="width:6%">적중</th>
              <th style="width:8%">상태</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${items.map((x) => `
              <tr>
                <td><b>${escapeHtml(x.title || '제목 없음')}</b></td>
                <td style="font-size:12px">
                  ${(x.keywords || []).map((k) => `<span class="tag info" style="margin:1px 2px">${escapeHtml(k)}</span>`).join('')}
                </td>
                <td style="font-size:13px;color:var(--ink)">${escapeHtml((x.answer || '').slice(0, 80))}${(x.answer || '').length > 80 ? '…' : ''}</td>
                <td style="font-size:11px;color:var(--steel)">${x.matchMode === 'any' ? 'OR' : 'AND (전부)'}</td>
                <td style="text-align:center;font-weight:700;color:var(--cobalt-deep)">${x.hits || 0}</td>
                <td>${x.disabled ? '<span class="tag warning">비활성</span>' : '<span class="tag success">활성</span>'}</td>
                <td>
                  <button class="adm-btn sm secondary" data-edit-frozen="${x.id}">편집</button>
                  <button class="adm-btn sm ghost" data-del-frozen="${x.id}">삭제</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `}
    </div>

    <div class="adm-card" style="background:var(--surface-softer)">
      <h3>📌 사용 팁</h3>
      <ul style="margin:8px 0 0;padding-left:20px;font-size:13px;line-height:1.8;color:var(--ink)">
        <li><b>키워드 매칭 (AND)</b>: "쇼핑몰 견적" 등록 시, 사용자 질문에 <code>쇼핑몰</code>과 <code>견적</code>이 <b>둘 다</b> 포함돼야 매칭</li>
        <li><b>키워드 매칭 (OR)</b>: 키워드 중 하나만 포함돼도 매칭 — 폭넓은 질문에 적합 (단 정확도↓)</li>
        <li><b>우선순위</b>: 폴백(인사) > Frozen Response > Gemini API. 즉 인사말은 frozen 안 거치고 즉시 응답</li>
        <li><b>편집 빈도</b>: 분석 페이지의 "상위 질문 TOP 10"을 보고 매주/매월 추가하세요</li>
        <li><b>비용</b>: Frozen 매칭당 비용 $0. AI 호출 대비 100% 절감</li>
      </ul>
    </div>
  `;
}

export function mountKnowledge() {
  $('#newFrozenBtn')?.addEventListener('click', () => openFrozenDrawer(null));
  $$('[data-edit-frozen]').forEach((b) => b.addEventListener('click', () => openFrozenDrawer(b.dataset.editFrozen)));
  $$('[data-del-frozen]').forEach((b) => b.addEventListener('click', () => {
    if (!window.confirm('이 사전 응답을 삭제하시겠습니까?')) return;
    store.frozenResponses.remove(b.dataset.delFrozen);
    toast('삭제되었습니다', 'success');
    window.rerenderView?.();
  }));
  $$('[data-suggest]').forEach((b) => b.addEventListener('click', () => {
    const q = b.dataset.suggest;
    // 자주 묻는 질문에서 자동으로 키워드 추출 (1~3음절 의미 단어)
    const words = q.split(/[\s,.!?·~()\[\]]+/).filter((w) => w.length >= 2 && w.length <= 10);
    const keywords = words.slice(0, 3);
    openFrozenDrawer(null, { title: q.slice(0, 30), keywords });
  }));
}

function openFrozenDrawer(id, prefill = null) {
  const isEdit = !!id;
  const x = id ? store.frozenResponses.byId(id) : (prefill || {
    title: '', keywords: [], answer: '', matchMode: 'all', disabled: false,
  });
  const kwStr = (x.keywords || []).join(', ');
  openDrawer({
    title: isEdit ? '사전 응답 편집' : '+ 새 사전 응답',
    body: `
      <div class="adm-field">
        <label>제목 (관리용)</label>
        <input id="fr_title" value="${escapeHtml(x.title || '')}" placeholder="예: 쇼핑몰 견적 문의">
      </div>
      <div class="adm-field">
        <label>키워드 (쉼표로 구분, 소문자 권장)</label>
        <input id="fr_kw" value="${escapeHtml(kwStr)}" placeholder="예: 쇼핑몰, 견적">
        <div style="font-size:11px;color:var(--steel);margin-top:4px">예: <code>쇼핑몰, 견적</code> → 사용자 질문에 "쇼핑몰"과 "견적" 모두 포함 시 매칭</div>
      </div>
      <div class="adm-field">
        <label>매칭 모드</label>
        <select id="fr_mode">
          <option value="all" ${x.matchMode !== 'any' ? 'selected' : ''}>AND (모든 키워드 포함 — 권장, 정확도↑)</option>
          <option value="any" ${x.matchMode === 'any' ? 'selected' : ''}>OR (키워드 중 하나만 포함)</option>
        </select>
      </div>
      <div class="adm-field">
        <label>답변 (마크다운 지원)</label>
        <textarea id="fr_answer" rows="8" placeholder="답변 내용을 작성하세요. **굵게**, [링크](/#pricing) 사용 가능">${escapeHtml(x.answer || '')}</textarea>
        <div style="font-size:11px;color:var(--steel);margin-top:4px">팁: 답변 끝에 [상담 신청](/#contact) 같은 액션 링크를 넣으면 전환율↑</div>
      </div>
      <div class="adm-field">
        <label><input type="checkbox" id="fr_disabled" ${x.disabled ? 'checked' : ''}> 일시 비활성화</label>
      </div>
      ${isEdit ? `<div style="padding:10px 14px;background:var(--surface-softer);border-radius:var(--r-md);font-size:12px;color:var(--steel);margin-top:14px">누적 적중: <b style="color:var(--cobalt-deep)">${x.hits || 0}회</b>${x.lastHitAt ? ` · 최근: ${fmt.rel(x.lastHitAt)}` : ''}</div>` : ''}
    `,
    footer: `
      <button class="adm-btn ghost" id="frCancel">취소</button>
      <button class="adm-btn" id="frSave">${isEdit ? '저장' : '추가'}</button>
    `,
  });

  $('#frCancel')?.addEventListener('click', () => closeDrawer());
  $('#frSave')?.addEventListener('click', () => {
    const title = $('#fr_title').value.trim();
    const keywords = $('#fr_kw').value.split(',').map((k) => k.trim()).filter(Boolean);
    const answer = $('#fr_answer').value.trim();
    const matchMode = $('#fr_mode').value;
    const disabled = $('#fr_disabled').checked;
    if (!keywords.length) { toast('키워드를 1개 이상 입력해주세요', 'error'); return; }
    if (!answer) { toast('답변을 입력해주세요', 'error'); return; }
    if (isEdit) {
      store.frozenResponses.update(id, { title, keywords, answer, matchMode, disabled });
      toast('저장되었습니다', 'success');
    } else {
      store.frozenResponses.add({ title, keywords, answer, matchMode, disabled, hits: 0 });
      toast('추가되었습니다', 'success');
    }
    closeDrawer();
    window.rerenderView?.();
  });
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

/* ============================================================
   12.5 Calendar — 통합 일정 뷰 + 개인 메모 + Google Calendar 연동
   ============================================================ */
const _calState = { year: null, month: null, view: 'month' }; // month: 0-11, view: 'month'|'week'

// 캘린더 토큰은 localStorage에만 (sync X — 보안)
const CAL_TOKEN_LS_KEY = 'hamkkework.calendarToken';
function _getCalToken() { return localStorage.getItem(CAL_TOKEN_LS_KEY) || ''; }
function _setCalToken(t) {
  if (t) localStorage.setItem(CAL_TOKEN_LS_KEY, t);
  else localStorage.removeItem(CAL_TOKEN_LS_KEY);
}
function _buildCalUrl() {
  const t = _getCalToken();
  const base = `${location.origin}/api/calendar.ics`;
  return t ? `${base}?token=${encodeURIComponent(t)}` : base;
}

function _ymd(d) {
  return d.toISOString().slice(0, 10);
}
function _parseYmd(s) {
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// 한 날의 모든 이벤트 수집
function _collectEvents(dateKey) {
  const events = [];
  const sameDay = (iso) => {
    if (!iso) return false;
    try { return new Date(iso).toISOString().slice(0, 10) === dateKey; } catch { return false; }
  };

  // 콜백 요청 (preferredTime 자유 텍스트지만 createdAt 기준)
  for (const t of store.scheduledTasks.all()) {
    if (t.type !== 'callback_request') continue;
    if (sameDay(t.createdAt || t.scheduledAt)) {
      events.push({
        type: 'callback',
        icon: '📞',
        color: t.urgency === 'urgent' ? '#dc2626' : '#0866ff',
        title: `${t.leadName || '고객'} 콜백`,
        sub: t.preferredTime || t.contact,
        urgent: t.urgency === 'urgent',
        id: t.id,
      });
    }
  }
  // 프로젝트 시작
  for (const p of store.projects.all()) {
    if (sameDay(p.startDate)) {
      events.push({ type: 'project_start', icon: '🚀', color: '#7c3aed', title: `${p.title || p.clientName} 시작`, id: p.id });
    }
    if (sameDay(p.deadline || p.endDate)) {
      events.push({ type: 'project_due', icon: '⏰', color: '#f59e0b', title: `${p.title || p.clientName} 마감`, id: p.id });
    }
  }
  // 견적서 생성
  for (const q of store.quotes.all()) {
    if (sameDay(q.createdAt)) {
      events.push({ type: 'quote', icon: '📄', color: '#facc15', title: `${q.clientName} 견적 ${Math.round(q.total)}만원`, id: q.id });
    }
  }
  // 신규 리드
  for (const l of store.leads.all()) {
    if (sameDay(l.createdAt)) {
      events.push({ type: 'lead', icon: '✨', color: '#64748b', title: `${l.name} ${l.company ? '('+l.company+')' : ''}`, id: l.id });
    }
  }
  // 인보이스 마감
  for (const inv of store.invoices.all()) {
    if (sameDay(inv.dueDate)) {
      events.push({ type: 'invoice_due', icon: '💰', color: '#ef4444', title: `${inv.clientName||'인보이스'} ${inv.amount?'('+inv.amount+'만원)':''} 마감`, id: inv.id });
    }
  }
  // 개인 메모
  for (const n of store.calendarNotes.all()) {
    if (n.date === dateKey) {
      events.push({ type: 'note', icon: '📝', color: n.color || '#10b981', title: n.text, id: n.id, editable: true });
    }
  }
  return events;
}

export function renderCalendar() {
  // state 초기화
  const now = new Date();
  if (_calState.year == null) {
    _calState.year = now.getFullYear();
    _calState.month = now.getMonth();
    _calState.weekStart = _ymd(_startOfWeek(now));
  }
  if (_calState.view === 'week') return renderCalendarWeek();
  return renderCalendarMonth();
}

function _startOfWeek(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - x.getDay()); // 일요일 시작
  return x;
}

function _viewToggleHtml() {
  return `
    <div style="display:inline-flex;border:1px solid var(--line,#ddd);border-radius:8px;overflow:hidden">
      <button class="cal-view-btn ${_calState.view==='month'?'active':''}" data-view="month" style="padding:6px 12px;border:none;background:${_calState.view==='month'?'var(--cobalt,#0866ff)':'transparent'};color:${_calState.view==='month'?'#fff':'var(--ink)'};cursor:pointer;font-size:12px;font-weight:600">월</button>
      <button class="cal-view-btn ${_calState.view==='week'?'active':''}" data-view="week" style="padding:6px 12px;border:none;background:${_calState.view==='week'?'var(--cobalt,#0866ff)':'transparent'};color:${_calState.view==='week'?'#fff':'var(--ink)'};cursor:pointer;font-size:12px;font-weight:600">주</button>
    </div>
  `;
}

function renderCalendarMonth() {
  const year = _calState.year;
  const month = _calState.month;
  const monthName = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'][month];

  // 월 1일의 요일 (0=일)
  const firstDay = new Date(year, month, 1);
  const startWeekday = firstDay.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();

  // 6주 × 7일 = 42 셀
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const dayOffset = i - startWeekday;
    let cellDate, isThisMonth = true;
    if (dayOffset < 0) {
      cellDate = new Date(year, month - 1, daysInPrevMonth + dayOffset + 1);
      isThisMonth = false;
    } else if (dayOffset >= daysInMonth) {
      cellDate = new Date(year, month + 1, dayOffset - daysInMonth + 1);
      isThisMonth = false;
    } else {
      cellDate = new Date(year, month, dayOffset + 1);
    }
    cells.push({ date: cellDate, isThisMonth });
  }

  const today = _ymd(new Date());

  // Subscribe URL — 어드민 페이지의 origin
  const subscribeUrl = _buildCalUrl();

  return `
    <div class="adm-card" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <button class="adm-btn ghost sm" id="cal_prev" title="이전 달">◀</button>
        <h3 style="margin:0">${year}년 ${monthName}</h3>
        <button class="adm-btn ghost sm" id="cal_next" title="다음 달">▶</button>
        <button class="adm-btn secondary sm" id="cal_today">오늘</button>
        ${_viewToggleHtml()}
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="adm-btn sm" id="cal_addNote">+ 오늘 메모</button>
        <a class="adm-btn secondary sm" href="${subscribeUrl}" download="hamkkework-calendar.ics" title="iCal 파일 다운로드">📥 .ics 다운로드</a>
        <button class="adm-btn ghost sm" id="cal_gcalGuide" title="Google Calendar 구독 안내">🗓 Google Calendar 연결</button>
      </div>
    </div>

    <div class="adm-card cal-grid-wrap">
      <div class="cal-weekdays">
        ${['일','월','화','수','목','금','토'].map((w, i) => `<div class="cal-weekday ${i===0?'sun':''} ${i===6?'sat':''}">${w}</div>`).join('')}
      </div>
      <div class="cal-grid">
        ${cells.map((cell) => {
          const key = _ymd(cell.date);
          const events = _collectEvents(key);
          const visible = events.slice(0, 3);
          const more = events.length - visible.length;
          const isToday = key === today;
          const weekday = cell.date.getDay();
          const cls = [
            'cal-cell',
            cell.isThisMonth ? '' : 'cal-cell-out',
            isToday ? 'cal-cell-today' : '',
            weekday === 0 ? 'cal-cell-sun' : '',
            weekday === 6 ? 'cal-cell-sat' : '',
          ].filter(Boolean).join(' ');
          return `
            <div class="${cls}" data-date="${key}" data-drop="1">
              <div class="cal-cell-day">${cell.date.getDate()}</div>
              <div class="cal-events">
                ${visible.map((e) => `
                  <div class="cal-event${e.type==='note'?' cal-event-draggable':''}"
                       style="background:${e.color}22;color:${e.color};border-left:3px solid ${e.color}"
                       title="${escapeHtml(e.title)}"
                       ${e.type==='note' ? `draggable="true" data-drag-note-id="${e.id}"` : ''}>
                    ${e.icon} ${escapeHtml(e.title.slice(0, 14))}${e.title.length>14?'…':''}
                  </div>
                `).join('')}
                ${more > 0 ? `<div class="cal-event-more">+ ${more}건 더</div>` : ''}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>

    <div class="adm-card">
      <h3>범례</h3>
      <div style="display:flex;flex-wrap:wrap;gap:12px;font-size:13px">
        <span><span style="display:inline-block;width:12px;height:12px;background:#0866ff;border-radius:3px;margin-right:6px;vertical-align:middle"></span>📞 콜백 (긴급은 빨강)</span>
        <span><span style="display:inline-block;width:12px;height:12px;background:#7c3aed;border-radius:3px;margin-right:6px;vertical-align:middle"></span>🚀 프로젝트 시작</span>
        <span><span style="display:inline-block;width:12px;height:12px;background:#f59e0b;border-radius:3px;margin-right:6px;vertical-align:middle"></span>⏰ 프로젝트 마감</span>
        <span><span style="display:inline-block;width:12px;height:12px;background:#facc15;border-radius:3px;margin-right:6px;vertical-align:middle"></span>📄 견적서</span>
        <span><span style="display:inline-block;width:12px;height:12px;background:#64748b;border-radius:3px;margin-right:6px;vertical-align:middle"></span>✨ 신규 리드</span>
        <span><span style="display:inline-block;width:12px;height:12px;background:#ef4444;border-radius:3px;margin-right:6px;vertical-align:middle"></span>💰 인보이스 마감</span>
        <span><span style="display:inline-block;width:12px;height:12px;background:#10b981;border-radius:3px;margin-right:6px;vertical-align:middle"></span>📝 메모</span>
      </div>
    </div>
  `;
}

export function mountCalendar() {
  // 뷰 토글
  $$('.cal-view-btn').forEach((b) => b.addEventListener('click', () => {
    _calState.view = b.dataset.view;
    if (_calState.view === 'week' && !_calState.weekStart) {
      _calState.weekStart = _ymd(_startOfWeek(new Date()));
    }
    window.rerenderView?.();
  }));

  // 월간 뷰 이전/다음
  $('#cal_prev')?.addEventListener('click', () => {
    if (_calState.view === 'week') {
      const ws = _parseYmd(_calState.weekStart);
      ws.setDate(ws.getDate() - 7);
      _calState.weekStart = _ymd(ws);
    } else {
      _calState.month--;
      if (_calState.month < 0) { _calState.month = 11; _calState.year--; }
    }
    window.rerenderView?.();
  });
  $('#cal_next')?.addEventListener('click', () => {
    if (_calState.view === 'week') {
      const ws = _parseYmd(_calState.weekStart);
      ws.setDate(ws.getDate() + 7);
      _calState.weekStart = _ymd(ws);
    } else {
      _calState.month++;
      if (_calState.month > 11) { _calState.month = 0; _calState.year++; }
    }
    window.rerenderView?.();
  });
  $('#cal_today')?.addEventListener('click', () => {
    const n = new Date();
    _calState.year = n.getFullYear();
    _calState.month = n.getMonth();
    _calState.weekStart = _ymd(_startOfWeek(n));
    window.rerenderView?.();
  });
  $('#cal_addNote')?.addEventListener('click', () => openDayDrawer(_ymd(new Date())));
  $('#cal_gcalGuide')?.addEventListener('click', () => openGcalGuide());

  // 셀 클릭 → 그 날 드로어 (단, 드래그 직후엔 클릭 무시)
  let suppressClickUntil = 0;
  $$('.cal-cell').forEach((cell) => {
    cell.addEventListener('click', (e) => {
      if (Date.now() < suppressClickUntil) return;
      // 드래그 핸들 클릭은 무시
      if (e.target.closest('[data-drag-note-id]')) return;
      openDayDrawer(cell.dataset.date);
    });
  });

  // 🖐 메모 드래그·드롭 — 메모만 다른 날짜로 이동 (자동 이벤트는 read-only)
  let draggedNoteId = null;
  $$('[data-drag-note-id]').forEach((el) => {
    el.addEventListener('dragstart', (e) => {
      draggedNoteId = el.dataset.dragNoteId;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', draggedNoteId);
      el.style.opacity = '0.4';
    });
    el.addEventListener('dragend', () => {
      el.style.opacity = '';
      suppressClickUntil = Date.now() + 200;
    });
  });
  $$('[data-drop="1"]').forEach((cell) => {
    cell.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      cell.classList.add('cal-cell-dropover');
    });
    cell.addEventListener('dragleave', () => cell.classList.remove('cal-cell-dropover'));
    cell.addEventListener('drop', (e) => {
      e.preventDefault();
      cell.classList.remove('cal-cell-dropover');
      const noteId = draggedNoteId || e.dataTransfer.getData('text/plain');
      if (!noteId) return;
      const newDate = cell.dataset.date;
      const note = store.calendarNotes.byId(noteId);
      if (!note || note.date === newDate) return;
      store.calendarNotes.update(noteId, { date: newDate });
      toast(`메모를 ${newDate}로 이동했습니다`, 'success');
      draggedNoteId = null;
      window.rerenderView?.();
    });
  });
}

/* 주간 뷰 — 7일 컬럼, 각 날짜별 이벤트 리스트 (드래그·드롭 가능) */
function renderCalendarWeek() {
  const subscribeUrl = _buildCalUrl();
  const weekStart = _parseYmd(_calState.weekStart);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    days.push(d);
  }
  const weekEnd = days[6];
  const sameMonth = weekStart.getMonth() === weekEnd.getMonth();
  const rangeLabel = sameMonth
    ? `${weekStart.getFullYear()}년 ${weekStart.getMonth()+1}월 ${weekStart.getDate()}일 - ${weekEnd.getDate()}일`
    : `${weekStart.getFullYear()}년 ${weekStart.getMonth()+1}월 ${weekStart.getDate()}일 - ${weekEnd.getMonth()+1}월 ${weekEnd.getDate()}일`;
  const today = _ymd(new Date());

  return `
    <div class="adm-card" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <button class="adm-btn ghost sm" id="cal_prev" title="이전 주">◀</button>
        <h3 style="margin:0">${rangeLabel}</h3>
        <button class="adm-btn ghost sm" id="cal_next" title="다음 주">▶</button>
        <button class="adm-btn secondary sm" id="cal_today">이번 주</button>
        ${_viewToggleHtml()}
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="adm-btn sm" id="cal_addNote">+ 오늘 메모</button>
        <a class="adm-btn secondary sm" href="${subscribeUrl}" download="hamkkework-calendar.ics" title="iCal 파일 다운로드">📥 .ics 다운로드</a>
        <button class="adm-btn ghost sm" id="cal_gcalGuide" title="Google Calendar 구독 안내">🗓 Google Calendar 연결</button>
      </div>
    </div>

    <div class="adm-card" style="padding:0">
      <div class="cal-week-grid">
        ${days.map((d) => {
          const key = _ymd(d);
          const events = _collectEvents(key);
          const isToday = key === today;
          const weekday = d.getDay();
          const wname = ['일','월','화','수','목','금','토'][weekday];
          const cls = [
            'cal-week-col',
            isToday ? 'cal-week-col-today' : '',
            weekday === 0 ? 'cal-week-col-sun' : '',
            weekday === 6 ? 'cal-week-col-sat' : '',
          ].filter(Boolean).join(' ');
          return `
            <div class="${cls}" data-date="${key}" data-drop="1">
              <div class="cal-week-head">
                <div class="cal-week-weekday">${wname}</div>
                <div class="cal-week-day">${d.getDate()}</div>
              </div>
              <div class="cal-week-events">
                ${events.length === 0 ? '<div class="cal-week-empty">—</div>' : ''}
                ${events.map((e) => `
                  <div class="cal-week-event${e.type==='note'?' cal-event-draggable':''}"
                       style="background:${e.color}22;color:${e.color};border-left:3px solid ${e.color}"
                       title="${escapeHtml(e.title)}"
                       ${e.type==='note' ? `draggable="true" data-drag-note-id="${e.id}"` : ''}>
                    <div style="font-size:11px;font-weight:600">${e.icon} ${escapeHtml(e.title.slice(0, 24))}${e.title.length>24?'…':''}</div>
                    ${e.sub ? `<div style="font-size:10px;color:var(--steel);margin-top:2px">${escapeHtml(e.sub)}</div>` : ''}
                  </div>
                `).join('')}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>

    <div class="adm-card">
      <h3>범례</h3>
      <div style="display:flex;flex-wrap:wrap;gap:12px;font-size:13px">
        <span><span style="display:inline-block;width:12px;height:12px;background:#0866ff;border-radius:3px;margin-right:6px;vertical-align:middle"></span>📞 콜백</span>
        <span><span style="display:inline-block;width:12px;height:12px;background:#7c3aed;border-radius:3px;margin-right:6px;vertical-align:middle"></span>🚀 프로젝트</span>
        <span><span style="display:inline-block;width:12px;height:12px;background:#facc15;border-radius:3px;margin-right:6px;vertical-align:middle"></span>📄 견적</span>
        <span><span style="display:inline-block;width:12px;height:12px;background:#64748b;border-radius:3px;margin-right:6px;vertical-align:middle"></span>✨ 리드</span>
        <span><span style="display:inline-block;width:12px;height:12px;background:#10b981;border-radius:3px;margin-right:6px;vertical-align:middle"></span>📝 메모 (드래그·드롭으로 날짜 이동)</span>
      </div>
    </div>
  `;
}

function openDayDrawer(dateKey) {
  const d = _parseYmd(dateKey);
  const dateLabel = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} (${['일','월','화','수','목','금','토'][d.getDay()]})`;
  const events = _collectEvents(dateKey).filter((e) => e.type !== 'note');
  const notes = store.calendarNotes.all().filter((n) => n.date === dateKey);

  openDrawer({
    title: `📅 ${dateLabel}`,
    body: `
      <div style="margin-bottom:16px">
        <h4 style="margin:0 0 8px;font-size:14px;color:var(--ink-deep)">자동 이벤트 (${events.length})</h4>
        ${events.length === 0 ? `<div style="color:var(--steel);font-size:13px">예약된 이벤트가 없습니다.</div>` : `
          <div style="display:grid;gap:6px">
            ${events.map((e) => `
              <div style="display:flex;gap:8px;align-items:center;padding:8px 10px;background:${e.color}11;border-left:3px solid ${e.color};border-radius:6px;font-size:13px">
                <span>${e.icon}</span>
                <div style="flex:1">
                  <div style="font-weight:600">${escapeHtml(e.title)}</div>
                  ${e.sub ? `<div style="font-size:11px;color:var(--steel);margin-top:2px">${escapeHtml(e.sub)}</div>` : ''}
                </div>
              </div>
            `).join('')}
          </div>
        `}
      </div>

      <div>
        <h4 style="margin:0 0 8px;font-size:14px;color:var(--ink-deep)">📝 개인 메모 (${notes.length})</h4>
        <div id="cal_notesList" style="display:grid;gap:6px;margin-bottom:10px">
          ${notes.map((n) => `
            <div data-note-id="${n.id}" style="display:flex;gap:8px;padding:8px 10px;background:${n.color || '#10b981'}11;border-left:3px solid ${n.color || '#10b981'};border-radius:6px">
              <textarea data-note-edit="${n.id}" rows="2" style="flex:1;border:none;background:transparent;font-family:inherit;font-size:13px;resize:vertical;outline:none">${escapeHtml(n.text)}</textarea>
              <button class="adm-btn ghost sm" data-note-del="${n.id}" style="color:#dc2626;align-self:flex-start" title="삭제">✕</button>
            </div>
          `).join('')}
        </div>
        <div class="adm-field" style="margin:0">
          <label>새 메모 추가</label>
          <textarea id="cal_newNote" rows="2" placeholder="이 날의 메모를 입력하세요…"></textarea>
        </div>
        <div style="display:flex;gap:6px;margin-top:8px;align-items:center">
          <select id="cal_newNoteColor" style="padding:6px;border-radius:6px;border:1px solid var(--line, #ddd);font-size:12px">
            <option value="#10b981">🟢 초록</option>
            <option value="#0866ff">🔵 파랑</option>
            <option value="#f59e0b">🟡 노랑</option>
            <option value="#dc2626">🔴 빨강</option>
            <option value="#7c3aed">🟣 보라</option>
          </select>
          <button class="adm-btn sm" id="cal_saveNote">+ 메모 추가</button>
        </div>
      </div>
    `,
    onMount: () => {
      $('#cal_saveNote')?.addEventListener('click', () => {
        const text = $('#cal_newNote').value.trim();
        if (!text) return;
        const color = $('#cal_newNoteColor').value;
        store.calendarNotes.add({ date: dateKey, text, color });
        toast('메모 추가됨', 'success');
        closeDrawer();
        window.rerenderView?.();
      });
      $$('[data-note-edit]').forEach((ta) => {
        ta.addEventListener('blur', () => {
          const id = ta.dataset.noteEdit;
          const text = ta.value.trim();
          if (!text) { store.calendarNotes.remove(id); return; }
          store.calendarNotes.update(id, { text });
        });
      });
      $$('[data-note-del]').forEach((b) => {
        b.addEventListener('click', () => {
          store.calendarNotes.remove(b.dataset.noteDel);
          toast('메모 삭제됨', 'success');
          closeDrawer();
          window.rerenderView?.();
        });
      });
    },
  });
}

function openGcalGuide() {
  const subscribeUrl = _buildCalUrl();
  const currentToken = _getCalToken();
  openDrawer({
    title: '🗓 Google Calendar 연결',
    body: `
      <div style="font-size:14px;line-height:1.7;color:var(--ink)">
        <p>아래 URL을 <b>Google Calendar의 "다른 캘린더 추가 → URL로 추가"</b>에 입력하면 함께워크_SI의 모든 일정이 자동 동기화됩니다.</p>
        <div style="background:var(--surface-soft, #f5f5f5);padding:12px 14px;border-radius:8px;margin:14px 0;font-family:var(--font-mono, monospace);font-size:13px;word-break:break-all;border:1px solid var(--line, #ddd)">
          ${escapeHtml(subscribeUrl)}
        </div>
        <button class="adm-btn sm" id="cal_copyUrl">📋 URL 복사</button>

        <h4 style="margin:24px 0 8px;font-size:14px">단계별 안내</h4>
        <ol style="padding-left:20px;font-size:13px;line-height:1.8;color:var(--steel)">
          <li><a href="https://calendar.google.com" target="_blank" style="color:var(--cobalt, #0866ff)">Google Calendar</a> 접속</li>
          <li>좌측 사이드바 <b>"다른 캘린더"</b> 옆 <b>+</b> → <b>"URL로 추가"</b></li>
          <li>위 URL을 붙여넣기 → <b>"캘린더 추가"</b></li>
          <li>약 6~12시간마다 자동 새로고침 (즉시 반영은 어려움)</li>
        </ol>

        <h4 style="margin:24px 0 8px;font-size:14px">단발성 가져오기</h4>
        <p style="font-size:13px;color:var(--steel)">Google Calendar 설정 → <b>가져오기/내보내기</b>에서 다운로드한 <code>.ics</code> 파일을 업로드하면 1회만 import됩니다.</p>

        <h4 style="margin:24px 0 8px;font-size:14px">🔒 토큰 인증 (선택)</h4>
        <p style="font-size:12px;color:var(--steel);margin-bottom:10px">URL을 비공개로 만들려면 토큰 인증을 활성화하세요. <b>2단계 설정 필요</b>:</p>
        <ol style="padding-left:20px;font-size:12.5px;line-height:1.7;color:var(--steel)">
          <li><b>Netlify 환경변수 등록</b>: Site settings → Environment variables → <code>CALENDAR_TOKEN</code> = (임의 32자 문자열, 예: <code id="cal_genToken">${_randToken()}</code> <button class="adm-btn ghost sm" id="cal_regen" style="padding:1px 6px;font-size:10px">🔄</button>)</li>
          <li><b>이 페이지에 같은 토큰 입력</b>:
            <div style="display:flex;gap:6px;margin-top:6px">
              <input id="cal_tokenInput" type="text" value="${escapeHtml(currentToken)}" placeholder="Netlify에 등록한 토큰" style="flex:1;padding:6px 10px;border-radius:6px;border:1px solid var(--line,#ddd);font-family:var(--font-mono,monospace);font-size:12px">
              <button class="adm-btn sm" id="cal_tokenSave">저장</button>
              ${currentToken ? '<button class="adm-btn ghost sm" id="cal_tokenClear" style="color:#dc2626">제거</button>' : ''}
            </div>
            <div style="font-size:11px;color:var(--steel);margin-top:4px">${currentToken ? '✅ 토큰 활성: URL에 자동 추가됨' : '⚠️ 토큰 미설정: URL 공개 접근 가능'}</div>
          </li>
          <li>Netlify Redeploy (또는 새 빌드)</li>
        </ol>
        <p style="font-size:11px;color:var(--steel);margin-top:10px">※ 토큰은 이 브라우저에만 저장됩니다 (sync X). 다른 기기에선 다시 입력 필요.</p>
      </div>
    `,
    onMount: () => {
      $('#cal_copyUrl')?.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(subscribeUrl); toast('URL 복사됨', 'success'); }
        catch { toast('복사 실패', 'error'); }
      });
      $('#cal_regen')?.addEventListener('click', () => {
        $('#cal_genToken').textContent = _randToken();
      });
      $('#cal_tokenSave')?.addEventListener('click', () => {
        const t = $('#cal_tokenInput').value.trim();
        _setCalToken(t);
        toast(t ? '토큰 저장됨. URL이 갱신됩니다.' : '토큰 제거됨', 'success');
        closeDrawer();
        setTimeout(() => openGcalGuide(), 100);
      });
      $('#cal_tokenClear')?.addEventListener('click', () => {
        _setCalToken('');
        toast('토큰 제거됨', 'success');
        closeDrawer();
        setTimeout(() => openGcalGuide(), 100);
      });
    },
  });
}

function _randToken() {
  const a = new Uint8Array(24);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(a);
  return Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join('');
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
function renderTierEditor(tiers, activeId) {
  return `
    <div class="adm-row" style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
      <label style="font-weight:600">메인페이지 기본 선택:</label>
      <select id="tier_active" style="padding:6px 10px;border-radius:6px;border:1px solid var(--line, #ddd)">
        ${tiers.map((t) => `<option value="${t.id}" ${t.id === activeId ? 'selected' : ''}>${escapeHtml(t.name)} (×${t.multiplier})</option>`).join('')}
      </select>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px">
      ${tiers.map((t, i) => `
        <div class="adm-tier-card" data-idx="${i}" style="border:1.5px solid var(--line,#e5e7eb);border-radius:10px;padding:14px;background:var(--bg-soft,#fafafa)">
          <div class="adm-row" style="display:flex;gap:8px;margin-bottom:8px">
            <input class="tf-name" placeholder="단계명" value="${escapeHtml(t.name||'')}" style="flex:2;padding:6px 10px;border-radius:6px;border:1px solid var(--line,#ddd);font-weight:600">
            <input class="tf-mult" type="number" step="0.05" min="0" placeholder="×" value="${t.multiplier ?? 1}" style="flex:1;padding:6px 10px;border-radius:6px;border:1px solid var(--line,#ddd);text-align:right">
          </div>
          <input type="hidden" class="tf-id" value="${escapeHtml(t.id||'')}">
          <textarea class="tf-desc" placeholder="짧은 정의 (한 줄)" rows="2" style="width:100%;padding:6px 10px;border-radius:6px;border:1px solid var(--line,#ddd);margin-bottom:8px;font-family:inherit;resize:vertical">${escapeHtml(t.description||'')}</textarea>
          <label style="font-size:12px;color:var(--steel,#666);display:block;margin-bottom:4px">포함 작업 (한 줄에 하나씩)</label>
          <textarea class="tf-inc" rows="6" style="width:100%;padding:6px 10px;border-radius:6px;border:1px solid var(--line,#ddd);font-family:inherit;font-size:12.5px;resize:vertical">${escapeHtml((t.includes||[]).join('\n'))}</textarea>
        </div>
      `).join('')}
    </div>
  `;
}

export function renderSettings() {
  const s = store.settings.get();
  const p = store.pricing.get();
  const cred = store.adminCredentials.get() || {};
  return `
    <div class="adm-card" style="border-left:4px solid var(--cobalt)">
      <h3>🔑 내 계정 (어드민)</h3>
      <div class="desc">
        어드민 로그인에 사용되는 계정 정보입니다. 비밀번호는 SHA-256 + 솔트로 해시되어 저장됩니다.<br>
        <b style="color:#dc2626">⚠️ 이메일·비밀번호 변경 후엔 자동 로그아웃되니 새 정보로 다시 로그인하세요.</b>
      </div>
      <div class="adm-row">
        <div class="adm-field"><label>이메일 (로그인 ID)</label><input id="ac_email" type="email" value="${escapeHtml(cred.email||'')}"></div>
        <div class="adm-field"><label>이름</label><input id="ac_name" value="${escapeHtml(cred.name||'')}"></div>
      </div>
      <div class="adm-row">
        <div class="adm-field"><label>휴대폰</label><input id="ac_phone" value="${escapeHtml(cred.phone||'')}"></div>
        <div class="adm-field"><label>역할 (예: 대표 PM)</label><input id="ac_role" value="${escapeHtml(cred.role||'')}"></div>
      </div>
      <button class="adm-btn" id="ac_saveProfile">프로필 저장 (비밀번호 변경 X)</button>

      <h4 style="margin-top:24px;font-size:14px;color:var(--ink-deep,#1a1a1a)">비밀번호 변경</h4>
      <div class="desc">현재 비밀번호 확인 후 새 비밀번호로 변경됩니다.</div>
      <div class="adm-row">
        <div class="adm-field"><label>현재 비밀번호</label><input id="ac_pwdNow" type="password" autocomplete="current-password"></div>
        <div class="adm-field"><label>새 비밀번호 (8자+)</label><input id="ac_pwdNew" type="password" autocomplete="new-password"></div>
        <div class="adm-field"><label>새 비밀번호 확인</label><input id="ac_pwdNew2" type="password" autocomplete="new-password"></div>
      </div>
      <button class="adm-btn" id="ac_savePwd">비밀번호 변경</button>
      <div style="margin-top:12px;font-size:11px;color:var(--steel);line-height:1.6">
        ※ 데모급 인증입니다. 실서비스 전엔 Netlify Identity / Supabase Auth / Auth0 등 별도 인증 서비스를 권장합니다.<br>
        ※ 비밀번호 분실 시 다른 기기·브라우저에서 어드민 계정을 직접 편집해 복구하거나 PC의 localStorage를 초기화하세요.
      </div>
    </div>

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
      <h4 style="margin-top:20px;font-size:13px;color:var(--ink-deep,#1a1a1a)">외부 링크 (답변문에 자동 노출)</h4>
      <div class="desc">[고객요청 답변생성] 기능에서 답변 말미에 자연스럽게 삽입됩니다. 비워두면 해당 링크는 노출되지 않습니다.</div>
      <div class="adm-row">
        <div class="adm-field"><label>홈페이지 URL</label><input id="st_homepage" placeholder="https://hamkkework-si.netlify.app" value="${escapeHtml(s.homepage_url||'')}"></div>
        <div class="adm-field"><label>회사소개 URL</label><input id="st_about" placeholder="https://… (회사소개·연혁 페이지)" value="${escapeHtml(s.about_url||'')}"></div>
      </div>
      <div class="adm-row">
        <div class="adm-field"><label>포트폴리오 URL</label><input id="st_portfolio" placeholder="https://… (포트폴리오·사례집)" value="${escapeHtml(s.portfolio_url||'')}"></div>
        <div class="adm-field"><label>대표 경력/연혁 한 줄</label><input id="st_history" placeholder="예: 14년 SI 기획 + 풀스택 자체팀, 누적 50건+ 구축" value="${escapeHtml(s.company_history||'')}"></div>
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
      <h3>개발 수준 (가중치)</h3>
      <div class="desc">
        프로젝트 규모·품질 수준에 따른 가중치입니다. <b>페이지·모듈·외부연동</b> 합계에 곱해지며, <b>AI 라인은 가중치 미적용</b>입니다.<br>
        AI 챗봇이 사용자 요구를 듣고 자동으로 단계를 판단해 견적을 산출하며, 포함 작업 목록은 응답의 근거로 사용됩니다.
      </div>
      <div id="tier_editor">
        ${renderTierEditor(p.tiers || DEFAULT_QUALITY_TIERS, p.activeTier || 'medium')}
      </div>
      <button class="adm-btn" id="tier_save">개발 수준 저장</button>
      <button class="adm-btn secondary" id="tier_reset" style="margin-left:8px">기본값으로 초기화</button>
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
  // ─── 어드민 계정 — 프로필 (비밀번호 제외) ───
  $('#ac_saveProfile')?.addEventListener('click', () => {
    const cred = store.adminCredentials.get() || {};
    const email = $('#ac_email').value.trim();
    const name = $('#ac_name').value.trim();
    const phone = $('#ac_phone').value.trim();
    const role = $('#ac_role').value.trim();
    if (!email || !/.+@.+\..+/.test(email)) { toast('유효한 이메일을 입력해 주세요', 'error'); return; }
    if (!name) { toast('이름을 입력해 주세요', 'error'); return; }
    const emailChanged = email.toLowerCase() !== (cred.email || '').toLowerCase();
    store.adminCredentials.set({
      ...cred,
      email, name, phone, role,
      updatedAt: utils.nowIso(),
    });
    // 현재 로그인 세션도 즉시 동기화 (이메일은 다음 로그인 때 검증되니 세션은 옛 이메일도 OK)
    const auth = store.auth.get();
    if (auth) store.auth.set({ ...auth, email, name, role });
    if (emailChanged) {
      toast('이메일이 변경되었습니다. 다시 로그인해 주세요.', 'success');
      setTimeout(() => { store.auth.clear(); location.reload(); }, 1500);
    } else {
      toast('프로필이 저장되었습니다', 'success');
      // 헤더 표시 즉시 갱신
      const userName = document.getElementById('userName');
      const userEmail = document.getElementById('userEmail');
      const userAvatar = document.getElementById('userAvatar');
      if (userName) userName.textContent = name;
      if (userEmail) userEmail.textContent = email;
      if (userAvatar) userAvatar.textContent = (name || email).charAt(0).toUpperCase();
    }
  });

  // ─── 어드민 계정 — 비밀번호 변경 ───
  $('#ac_savePwd')?.addEventListener('click', async () => {
    const cred = store.adminCredentials.get();
    if (!cred?.passwordHash || !cred?.salt) { toast('계정 정보가 손상되었습니다. 페이지 새로고침 후 다시 시도하세요.', 'error'); return; }
    const pwdNow = $('#ac_pwdNow').value;
    const pwdNew = $('#ac_pwdNew').value;
    const pwdNew2 = $('#ac_pwdNew2').value;
    if (!pwdNow || !pwdNew || !pwdNew2) { toast('모든 비밀번호 필드를 입력해 주세요', 'error'); return; }
    if (pwdNew.length < 8) { toast('새 비밀번호는 8자 이상이어야 합니다', 'error'); return; }
    if (pwdNew !== pwdNew2) { toast('새 비밀번호 확인이 일치하지 않습니다', 'error'); return; }
    if (pwdNew === pwdNow) { toast('새 비밀번호가 현재 비밀번호와 동일합니다', 'error'); return; }
    const valid = await verifyPassword(pwdNow, cred.passwordHash, cred.salt);
    if (!valid) { toast('현재 비밀번호가 일치하지 않습니다', 'error'); return; }
    const { hash, salt } = await hashPassword(pwdNew);
    store.adminCredentials.set({
      ...cred,
      passwordHash: hash,
      salt,
      updatedAt: utils.nowIso(),
    });
    toast('비밀번호가 변경되었습니다. 다시 로그인해 주세요.', 'success');
    setTimeout(() => { store.auth.clear(); location.reload(); }, 1500);
  });

  $('#st_save')?.addEventListener('click', () => {
    const prev = store.settings.get() || {};
    store.settings.set({
      ...prev,
      brand: $('#st_brand').value.trim(),
      email: $('#st_email').value.trim(),
      phone: $('#st_phone').value.trim(),
      pm: $('#st_pm').value.trim(),
      invoice_terms: $('#st_terms').value.trim(),
      warranty_months: Number($('#st_warranty').value) || 6,
      homepage_url: $('#st_homepage')?.value.trim() || '',
      about_url: $('#st_about')?.value.trim() || '',
      portfolio_url: $('#st_portfolio')?.value.trim() || '',
      company_history: $('#st_history')?.value.trim() || '',
    });
    toast('설정이 저장되었습니다', 'success');
  });
  $('#pr_save')?.addEventListener('click', () => {
    const existing = store.pricing.get() || {};
    store.pricing.set({
      ...existing, // tiers/activeTier 등 보존
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

  $('#tier_save')?.addEventListener('click', () => {
    const cards = document.querySelectorAll('#tier_editor .adm-tier-card');
    const tiers = Array.from(cards).map((c) => ({
      id: c.querySelector('.tf-id').value.trim(),
      name: c.querySelector('.tf-name').value.trim() || '(이름 없음)',
      multiplier: Math.max(0, Number(c.querySelector('.tf-mult').value) || 0),
      description: c.querySelector('.tf-desc').value.trim(),
      includes: c.querySelector('.tf-inc').value.split('\n').map((s) => s.trim()).filter(Boolean),
    })).filter((t) => t.id);
    if (!tiers.length) { toast('단계가 비어 있어 저장하지 않았습니다.', 'error'); return; }
    const activeTier = $('#tier_active').value || tiers[0].id;
    const existing = store.pricing.get() || {};
    store.pricing.set({ ...existing, tiers, activeTier });
    toast('개발 수준이 저장되었습니다.', 'success');
  });

  $('#tier_reset')?.addEventListener('click', () => {
    if (!confirm('기본 4단계로 초기화하시겠어요? 현재 편집 내용은 사라집니다.')) return;
    const existing = store.pricing.get() || {};
    store.pricing.set({ ...existing, tiers: DEFAULT_QUALITY_TIERS, activeTier: 'medium' });
    toast('기본값으로 초기화되었습니다.', 'success');
    window.rerenderView?.();
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

/* ============================================================
   17. 고객요청 답변생성 (Quote Responder)
      크몽·위시켓·프리모아 등 견적요청 → 사람 톤 답변문 자동 작성
   ============================================================ */
const QR_PLATFORMS = [
  { id: 'kmong',    label: '크몽' },
  { id: 'wishket',  label: '위시켓' },
  { id: 'freemoa',  label: '프리모아' },
  { id: 'otherweb', label: '기타 플랫폼' },
  { id: 'email',    label: '이메일·DM' },
];

function _qrScoreCase(c, requestText) {
  const q = (requestText || '').toLowerCase();
  if (!q) return 0;
  let score = 0;
  const tags = (c.tags || []).map((t) => String(t).toLowerCase());
  tags.forEach((t) => { if (t && q.includes(t)) score += 6; });
  const text = `${c.title || ''} ${c.description || ''} ${c.label || ''} ${c.client || ''}`.toLowerCase();
  // 한글 명사 후보를 거칠게 매칭 (2자 이상 토큰)
  const tokens = (q.match(/[가-힣A-Za-z0-9]{2,}/g) || []).slice(0, 60);
  const uniq = Array.from(new Set(tokens));
  uniq.forEach((tok) => {
    if (text.includes(tok)) score += 2;
  });
  if (c.published) score += 1; // 공개 사례 약간 가산
  return score;
}

function _qrPickCases(requestText, limit = 3) {
  const all = (store.cases.all() || []).filter((c) => c && (c.published !== false));
  if (!all.length) return [];
  const scored = all.map((c) => ({ c, s: _qrScoreCase(c, requestText) }));
  scored.sort((a, b) => b.s - a.s || (b.c.year || 0) - (a.c.year || 0));
  // 매칭 0건이면 최신 연도 상위 사례로 fallback
  const top = scored.filter((x) => x.s > 0).slice(0, limit).map((x) => x.c);
  if (top.length >= 1) return top;
  return [...all].sort((a, b) => (b.year || 0) - (a.year || 0)).slice(0, limit);
}

function _qrBuildSystemExtra({ tone, length, settings, cases }) {
  const lengthHint = length === 'short'
    ? '본문 분량은 350~450자 정도로 간결하게. 끝맺음을 반드시 완결할 것.'
    : length === 'long'
      ? '본문 분량은 700~850자 정도. 끝맺음을 반드시 완결할 것 (잘려서는 안 됨).'
      : '본문 분량은 500~650자 정도가 적당. 끝맺음을 반드시 완결할 것.';
  const toneHint = tone === 'formal'
    ? '톤은 정중한 비즈니스 존댓말. 격식 있되 딱딱하지 않게.'
    : '톤은 따뜻한 존댓말. 사람이 직접 쓴 듯 자연스럽고 친근하지만, 가벼운 표현은 자제.';
  const caseLines = (cases || []).map((c, i) => {
    const tags = (c.tags || []).slice(0, 4).join(', ');
    return `  ${i + 1}) [${c.label || c.id}] ${c.client || ''} — ${c.title || ''} | 기술: ${tags} | 결과: ${c.status || ''} ${c.amount ? '('+c.amount+')' : ''} (${c.year || ''})`;
  }).join('\n');
  const links = [
    settings.homepage_url ? `홈페이지: ${settings.homepage_url}` : '',
    settings.about_url ? `회사소개·연혁: ${settings.about_url}` : '',
    settings.portfolio_url ? `포트폴리오: ${settings.portfolio_url}` : '',
  ].filter(Boolean).join(' / ');
  const history = settings.company_history || '대기업 SI 검증 경험과 풀스택 자체 개발팀을 함께 갖춘 함께워크_SI';
  const pm = settings.pm || '박두용';
  const brand = settings.brand || '함께워크_SI';

  return [
    '[현재 모드: 고객요청 답변생성]',
    '당신은 SI/AI 컨설팅사 ' + brand + '의 PM(' + pm + ')이 외주 플랫폼에서 받은 견적 요청에 직접 답신하는 메시지를 작성한다.',
    '',
    '## 절대 규칙',
    '- 사람이 직접 작성한 듯한 자연스러운 한국어 존댓말로만 작성한다. 챗봇·AI 클리셰는 전면 금지.',
    '- 다음 표현·패턴은 절대 사용 금지: "AI가", "저는 AI", "AI 어시스턴트", "모델로서", "물론입니다!", "도와드리겠습니다!", "기꺼이", "최선을 다해", 과한 이모지, ✅·🚀·💡 등 장식 기호, "1. … 2. … 3. …" 식 번호 매김 남발, "##" 헤더 남발.',
    '- 구조 표시(###, **굵게**, 불릿)는 꼭 필요할 때만 한두 군데에만. 기본은 자연스러운 단락 흐름.',
    '- 견적 금액·일당·할인율을 절대 추정해서 적지 말 것. 금액 질문은 모두 "정확한 견적은 짧게 통화 또는 미팅 한 번으로 함께 확정하면 좋겠습니다" 류로 정중히 미룬다.',
    '- 일정·기간은 "대략 N주차" 수준의 추정 범위로만 표현. "정확한 일정은 상담 후 확정"이라는 단서를 자연스럽게 포함.',
    '- 응답 메시지 본문만 출력한다. 머리말("아래는 답변입니다" 같은) 금지. 코드블록 금지. action 블록 금지.',
    '- 어떤 도구(function call)도 호출하지 말 것. 리드 등록·견적 초안 작성 등 시스템 동작은 이 작업과 무관하다. 오직 답신 메시지 텍스트만 출력.',
    '',
    '## 본문 흐름 (자연스럽게 단락으로 녹여라, 헤더 X)',
    '1) 첫 단락: 인사 + 요청 잘 읽었다는 톤 + 핵심 이해를 한 줄로 재정리.',
    '2) 어떻게 만들지: 설계 접근(아키텍처·기술 방향)을 짧고 또렷하게.',
    '3) 기간: 단계 분해(예: 요건/설계 1~2주 → 구축 N주 → 검수 1주 등) — 정확한 일정은 상담 후 확정 단서 포함.',
    '4) "비슷한 경험"으로 아래 사례 ' + (cases?.length || 0) + '건을 자연스럽게 녹여 "우리가 이걸 가장 잘할 수 있는 이유"로 연결. 사례 이름·고객사·기술을 본문 흐름 안에 한 줄씩 자연스럽게 인용 (불릿으로 나열하지 말 것).',
    '5) 추가 연계 기능 제안 1~2개 (요청 도메인에서 자연스럽게 확장될 만한 것).',
    '6) AX(AI Transformation)·AI 워크플로우(에이전트) 확장 여지를 한 단락으로 — "이 작업을 단발 구축으로 끝내지 않고 ○○ 자동화/에이전트화하면 어떤 효과가 가능한지" 정도.',
    '7) 우리 경력·연혁 한 줄(' + history + ')과, 마지막으로 더 자세한 자료는 아래 링크에서 보실 수 있다는 식으로 자연스럽게 안내(' + (links || '링크 미설정 — 회사소개·포트폴리오 안내 문구만 짧게') + ').',
    '8) 마지막 단락: 견적·일정 확정은 짧은 통화 또는 미팅 한 번으로 함께 정하시는 게 좋겠다는 정중한 마무리.',
    '',
    toneHint,
    lengthHint,
    '',
    '## 사례 자료 (본문에 자연스럽게 인용, 그대로 복붙 X)',
    caseLines || '  (등록된 사례 없음 — 일반적 경험으로만 표현)',
  ].join('\n');
}

function _qrBuildUserMessage({ platform, requestText }) {
  const plat = QR_PLATFORMS.find((p) => p.id === platform)?.label || '외주 플랫폼';
  return [
    '아래는 ' + plat + '을 통해 들어온 고객의 견적 요청 원문입니다. 위 규칙에 따라, 이 고객에게 보낼 답신 메시지 본문 한 편을 작성해 주세요.',
    '',
    '— 요청 원문 시작 —',
    (requestText || '').trim(),
    '— 요청 원문 끝 —',
  ].join('\n');
}

export function renderQuoteResponder() {
  const s = store.settings.get() || {};
  const linksMissing = !s.homepage_url && !s.about_url && !s.portfolio_url;
  return `
    <div class="adm-card" style="border-left:4px solid var(--cobalt)">
      <h3 style="display:flex;align-items:center;gap:8px">
        🪶 고객요청 답변생성
        <span style="font-size:11px;font-weight:500;color:var(--steel);padding:3px 8px;background:rgba(0,0,0,.04);border-radius:999px">크몽 · 위시켓 · 프리모아 · 이메일</span>
      </h3>
      <div class="desc">
        외주 플랫폼·이메일로 들어온 견적 요청에 보낼 답신 메시지를 자연스러운 사람 톤으로 자동 작성합니다.
        포트폴리오에서 유사 사례 2~3건을 자동으로 찾아 본문에 녹이고, 마지막에 회사 정보 링크와 함께 마무리합니다.
        <b>견적 금액은 절대 본문에 들어가지 않습니다</b> — 추후 상담에서 함께 확정하도록 자연스럽게 유도합니다.
      </div>
      ${linksMissing ? `
        <div style="margin-top:8px;padding:10px 12px;border:1px dashed #e5b800;background:#fffbeb;border-radius:8px;font-size:12px;color:#7a5d00">
          ⚠️ [설정 → 외부 링크]에 홈페이지·회사소개·포트폴리오 URL을 등록하면 답변 말미에 자연스럽게 노출됩니다.
          <a href="#settings" data-qr-go-settings style="color:var(--cobalt);font-weight:600">설정으로 이동</a>
        </div>` : ''}
    </div>

    <div class="adm-card">
      <h3>1) 입력</h3>
      <div class="adm-field" style="margin-top:8px">
        <label style="font-size:12px;color:var(--steel)">플랫폼</label>
        <div id="qr_platforms" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px">
          ${QR_PLATFORMS.map((p, i) => `
            <button type="button" class="adm-btn secondary qr-plat${i === 0 ? ' active' : ''}" data-platform="${p.id}"
              style="padding:6px 14px;font-size:13px;border-radius:999px">${escapeHtml(p.label)}</button>
          `).join('')}
        </div>
      </div>
      <div class="adm-field" style="margin-top:14px">
        <label style="font-size:12px;color:var(--steel)">고객 견적 요청 원문 <span style="color:#dc2626">*</span></label>
        <textarea id="qr_request" rows="9" placeholder="예) 안녕하세요, 자사몰 회원 데이터를 기반으로 추천 메일을 자동 발송하는 시스템을 만들고 싶습니다. Shopify 연동이 필요하고…"
          style="width:100%;margin-top:6px;padding:12px;border:1px solid var(--line);border-radius:8px;font-family:inherit;font-size:13px;line-height:1.6;resize:vertical"></textarea>
      </div>
      <div class="adm-row" style="margin-top:10px">
        <div class="adm-field">
          <label style="font-size:12px;color:var(--steel)">톤</label>
          <select id="qr_tone" style="width:100%;margin-top:6px;padding:8px 10px;border:1px solid var(--line);border-radius:8px">
            <option value="warm" selected>따뜻한 존댓말 (권장)</option>
            <option value="formal">정중한 비즈니스 존댓말</option>
          </select>
        </div>
        <div class="adm-field">
          <label style="font-size:12px;color:var(--steel)">길이</label>
          <select id="qr_length" style="width:100%;margin-top:6px;padding:8px 10px;border:1px solid var(--line);border-radius:8px">
            <option value="short">짧게 (~500자)</option>
            <option value="medium" selected>보통 (~800자)</option>
            <option value="long">길게 (~1200자)</option>
          </select>
        </div>
      </div>
      <div style="margin-top:14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="adm-btn" id="qr_generate" style="min-width:140px">답변문 생성</button>
        <button class="adm-btn secondary" id="qr_clear">입력 비우기</button>
        <span id="qr_status" style="font-size:12px;color:var(--steel)"></span>
      </div>
    </div>

    <div class="adm-card" id="qr_resultCard" style="display:none">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
        <h3 style="margin:0">2) 생성 결과</h3>
        <div style="display:flex;gap:6px;align-items:center">
          <div id="qr_viewToggle" style="display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden">
            <button type="button" class="qr-view active" data-view="plain" style="padding:6px 12px;font-size:12px;border:0;background:transparent;cursor:pointer">플레인</button>
            <button type="button" class="qr-view" data-view="md" style="padding:6px 12px;font-size:12px;border:0;background:transparent;cursor:pointer;border-left:1px solid var(--line)">마크다운</button>
          </div>
          <button class="adm-btn secondary" id="qr_copy" style="padding:6px 14px;font-size:12px">복사</button>
          <button class="adm-btn secondary" id="qr_regen" style="padding:6px 14px;font-size:12px">재생성</button>
        </div>
      </div>
      <div id="qr_matches" style="margin-top:10px;font-size:11px;color:var(--steel)"></div>
      <div id="qr_result"
        style="margin-top:12px;padding:18px 20px;border:1px solid var(--line);border-radius:10px;background:#fff;line-height:1.85;font-size:14px;color:#1a1a1a;white-space:pre-wrap;min-height:120px">
      </div>
    </div>
  `;
}

export function mountQuoteResponder() {
  let selectedPlatform = QR_PLATFORMS[0].id;
  let lastResultText = '';
  let lastMatchedCases = [];
  let currentRunAbort = null;

  $$('.qr-plat').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.qr-plat').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      selectedPlatform = btn.dataset.platform;
    });
  });

  document.querySelector('[data-qr-go-settings]')?.addEventListener('click', (e) => {
    e.preventDefault();
    location.hash = '#settings';
    if (typeof window.rerenderView === 'function') window.rerenderView();
  });

  $('#qr_clear')?.addEventListener('click', () => {
    const ta = $('#qr_request');
    if (ta) ta.value = '';
    $('#qr_resultCard').style.display = 'none';
    lastResultText = '';
  });

  const setStatus = (msg) => { const el = $('#qr_status'); if (el) el.textContent = msg || ''; };

  const renderResult = () => {
    const el = $('#qr_result');
    if (!el) return;
    const view = document.querySelector('.qr-view.active')?.dataset.view || 'plain';
    if (view === 'md') {
      el.style.whiteSpace = 'normal';
      el.innerHTML = md ? md(lastResultText) : escapeHtml(lastResultText).replace(/\n/g, '<br>');
    } else {
      el.style.whiteSpace = 'pre-wrap';
      el.textContent = lastResultText;
    }
  };

  $$('.qr-view').forEach((b) => {
    b.addEventListener('click', () => {
      $$('.qr-view').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      renderResult();
    });
  });

  $('#qr_copy')?.addEventListener('click', async () => {
    if (!lastResultText) return;
    try {
      await navigator.clipboard.writeText(lastResultText);
      toast('답변문이 복사되었습니다', 'success');
    } catch {
      toast('복사 실패 — 결과창에서 직접 선택해 주세요', 'error');
    }
  });

  $('#qr_regen')?.addEventListener('click', () => runGenerate());
  $('#qr_generate')?.addEventListener('click', () => runGenerate());

  async function runGenerate() {
    const requestText = $('#qr_request')?.value.trim();
    if (!requestText || requestText.length < 15) {
      toast('고객 견적 요청 원문을 좀 더 입력해 주세요 (15자 이상)', 'error');
      return;
    }
    const tone = $('#qr_tone').value;
    const length = $('#qr_length').value;
    const settings = store.settings.get() || {};
    const auth = store.auth.get() || null;

    if (currentRunAbort) { try { currentRunAbort.abort(); } catch {} }
    const abort = new AbortController();
    currentRunAbort = abort;

    lastMatchedCases = _qrPickCases(requestText, 3);
    lastResultText = '';

    const card = $('#qr_resultCard');
    card.style.display = 'block';
    const matchesEl = $('#qr_matches');
    matchesEl.innerHTML = lastMatchedCases.length
      ? '🔎 본문에 자동 인용할 사례: ' + lastMatchedCases.map((c) => `<b>${escapeHtml(c.label || c.id)}</b>`).join(' · ')
      : '🔎 매칭된 사례가 없어 일반적 경험으로 표현합니다.';
    renderResult();

    setStatus('생성 중…');
    $('#qr_generate').disabled = true;

    const systemPromptExtra = _qrBuildSystemExtra({ tone, length, settings, cases: lastMatchedCases });
    const userMsg = _qrBuildUserMessage({ platform: selectedPlatform, requestText });

    try {
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', text: userMsg }],
          context: { mode: 'quote_responder' },
          systemPromptExtra,
          auth,
          variant: 'A',
        }),
        signal: abort.signal,
      });
      if (!resp.ok || !resp.body) {
        const text = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status} ${text.slice(0, 200)}`);
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const s = line.trim();
          if (!s.startsWith('data:')) continue;
          const payload = s.slice(5).trim();
          if (!payload) continue;
          let evt;
          try { evt = JSON.parse(payload); }
          catch { continue; } // keepalive 등 비-JSON 라인 무시
          if (evt.type === 'token' && typeof evt.text === 'string') {
            lastResultText += evt.text;
            renderResult();
          } else if (evt.type === 'done') {
            if (typeof evt.text === 'string' && !lastResultText) {
              lastResultText = evt.text;
              renderResult();
            }
          } else if (evt.type === 'error') {
            throw new Error(evt.error || evt.detail || 'AI 응답 오류');
          }
        }
      }
      // 마지막 정리 — action 블록·머리말 제거
      lastResultText = lastResultText
        .replace(/```action[\s\S]*?```/g, '')
        .replace(/^\s*(아래는|다음은)[^\n]{0,40}답변[^\n]{0,40}\n+/i, '')
        .trim();
      renderResult();
      setStatus(`완료 · ${lastResultText.length}자`);
    } catch (err) {
      if (err.name === 'AbortError') {
        setStatus('취소됨');
      } else {
        toast('생성 실패: ' + (err?.message || err), 'error');
        setStatus('실패');
      }
    } finally {
      $('#qr_generate').disabled = false;
      currentRunAbort = null;
    }
  }
}
