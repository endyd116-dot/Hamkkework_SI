/**
 * GET /api/calendar.ics — Google Calendar 구독용 iCal 피드
 *
 * 통합 일정:
 *  - scheduledTasks (콜백·팔로업)
 *  - projects (시작·마감)
 *  - quotes (생성)
 *  - leads (신규)
 *  - invoices (마감)
 *  - calendarNotes (개인 메모)
 *
 * RFC 5545 iCal 포맷. Google Calendar가 주기적으로 fetch.
 */

import { getStore } from '@netlify/blobs';

const STORE_NAME = 'hamkkework';

function getBlobsStore() {
  return getStore({ name: STORE_NAME, consistency: 'strong' });
}
async function readCollection(key) {
  const data = await getBlobsStore().get(key, { type: 'json' });
  return Array.isArray(data) ? data : [];
}

// iCal 텍스트 이스케이프 (RFC 5545)
function escIcs(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '');
}

// ISO datetime → iCal DATE-TIME (UTC: YYYYMMDDTHHMMSSZ)
function toIcsUtc(iso) {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  } catch { return null; }
}

// YYYY-MM-DD → iCal DATE (YYYYMMDD, all-day)
function toIcsDate(ymd) {
  if (!ymd) return null;
  return ymd.replace(/-/g, '');
}

function event({ uid, dtstamp, summary, description, dtstart, dtend, allDay = false }) {
  if (!uid || !summary) return '';
  const lines = ['BEGIN:VEVENT'];
  lines.push(`UID:${uid}@hamkkework.app`);
  lines.push(`DTSTAMP:${dtstamp}`);
  if (allDay) {
    lines.push(`DTSTART;VALUE=DATE:${dtstart}`);
    if (dtend) lines.push(`DTEND;VALUE=DATE:${dtend}`);
  } else {
    lines.push(`DTSTART:${dtstart}`);
    if (dtend) lines.push(`DTEND:${dtend}`);
  }
  lines.push(`SUMMARY:${escIcs(summary)}`);
  if (description) lines.push(`DESCRIPTION:${escIcs(description)}`);
  lines.push('END:VEVENT');
  return lines.join('\r\n');
}

// 75자 라인 폴딩 (iCal RFC)
function foldLines(text) {
  const out = [];
  for (const line of text.split('\r\n')) {
    if (line.length <= 75) { out.push(line); continue; }
    let buf = line;
    let first = true;
    while (buf.length > 0) {
      const chunk = buf.slice(0, first ? 75 : 74);
      out.push(first ? chunk : ' ' + chunk);
      buf = buf.slice(first ? 75 : 74);
      first = false;
    }
  }
  return out.join('\r\n');
}

export default async (req) => {
  // (선택) 토큰 검증 — 환경변수 CALENDAR_TOKEN 있으면 ?token= 필수
  const url = new URL(req.url);
  const requiredToken = process.env.CALENDAR_TOKEN;
  if (requiredToken && url.searchParams.get('token') !== requiredToken) {
    return new Response('Unauthorized', { status: 401 });
  }

  const [tasks, projects, quotes, leads, invoices, notes] = await Promise.all([
    readCollection('scheduledTasks'),
    readCollection('projects'),
    readCollection('quotes'),
    readCollection('leads'),
    readCollection('invoices'),
    readCollection('calendarNotes'),
  ]);

  const dtstamp = toIcsUtc(new Date().toISOString());
  const events = [];

  // 콜백 요청 — 30분 이벤트
  for (const t of tasks) {
    if (t.type !== 'callback_request') continue;
    const start = toIcsUtc(t.scheduledAt || t.createdAt);
    if (!start) continue;
    const startDate = new Date(t.scheduledAt || t.createdAt);
    const endDate = new Date(startDate.getTime() + 30 * 60000);
    const end = toIcsUtc(endDate.toISOString());
    const summary = `${t.urgency === 'urgent' ? '🚨 ' : '📞 '}${t.leadName || '고객'} 콜백`;
    const description = [
      `연락처: ${t.contact || '-'}`,
      `방법: ${t.method || '-'}`,
      t.preferredTime ? `선호 시간: ${t.preferredTime}` : '',
      t.topic ? `주제: ${t.topic}` : '',
      `상태: ${t.status || 'pending'}`,
    ].filter(Boolean).join('\n');
    events.push(event({ uid: `task-${t.id}`, dtstamp, summary, description, dtstart: start, dtend: end }));
  }

  // 프로젝트 — 시작·마감 각각
  for (const p of projects) {
    if (p.startDate) {
      const ymd = (p.startDate || '').slice(0, 10).replace(/-/g, '');
      if (ymd && /^\d{8}$/.test(ymd)) {
        events.push(event({
          uid: `proj-start-${p.id}`,
          dtstamp,
          summary: `🚀 [시작] ${p.title || p.clientName || '프로젝트'}`,
          description: `${p.clientName || ''}\n${p.summary || ''}`,
          dtstart: ymd,
          allDay: true,
        }));
      }
    }
    if (p.deadline || p.endDate) {
      const target = p.deadline || p.endDate;
      const ymd = (target || '').slice(0, 10).replace(/-/g, '');
      if (ymd && /^\d{8}$/.test(ymd)) {
        events.push(event({
          uid: `proj-end-${p.id}`,
          dtstamp,
          summary: `⏰ [마감] ${p.title || p.clientName || '프로젝트'}`,
          description: `${p.clientName || ''}\n${p.summary || ''}`,
          dtstart: ymd,
          allDay: true,
        }));
      }
    }
  }

  // 견적서 — 생성일 (all-day)
  for (const q of quotes) {
    const ymd = toIcsDate((q.createdAt || '').slice(0, 10));
    if (!ymd) continue;
    events.push(event({
      uid: `quote-${q.id}`,
      dtstamp,
      summary: `📄 ${q.clientName || '고객'} 견적 ${Math.round(q.total || 0)}만원`,
      description: q.title || '',
      dtstart: ymd,
      allDay: true,
    }));
  }

  // 신규 리드
  for (const l of leads) {
    const ymd = toIcsDate((l.createdAt || '').slice(0, 10));
    if (!ymd) continue;
    events.push(event({
      uid: `lead-${l.id}`,
      dtstamp,
      summary: `✨ ${l.name || '리드'} ${l.company ? '('+l.company+')' : ''}`.trim(),
      description: [`타입: ${l.type || '-'}`, `예산: ${l.budget || '-'}`, `상태: ${l.status || '-'}`, l.message || ''].filter(Boolean).join('\n'),
      dtstart: ymd,
      allDay: true,
    }));
  }

  // 인보이스 마감
  for (const inv of invoices) {
    const ymd = toIcsDate((inv.dueDate || '').slice(0, 10));
    if (!ymd) continue;
    events.push(event({
      uid: `inv-${inv.id}`,
      dtstamp,
      summary: `💰 ${inv.clientName || '인보이스'} 마감 ${inv.amount ? '('+inv.amount+'만원)' : ''}`,
      description: `상태: ${inv.status || 'pending'}`,
      dtstart: ymd,
      allDay: true,
    }));
  }

  // 개인 메모
  for (const n of notes) {
    const ymd = toIcsDate(n.date);
    if (!ymd) continue;
    events.push(event({
      uid: `note-${n.id}`,
      dtstamp,
      summary: `📝 ${(n.text || '').slice(0, 50)}`,
      description: n.text || '',
      dtstart: ymd,
      allDay: true,
    }));
  }

  const body = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//함께워크_SI//Admin Calendar v1//KO',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:함께워크_SI',
    'X-WR-TIMEZONE:Asia/Seoul',
    'X-WR-CALDESC:함께워크_SI 통합 일정 (콜백·프로젝트·견적·리드·메모)',
    ...events.filter(Boolean),
    'END:VCALENDAR',
  ].join('\r\n');

  return new Response(foldLines(body), {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="hamkkework-calendar.ics"',
      'Cache-Control': 'public, max-age=300', // 5분 캐시 (잦은 호출 방지)
    },
  });
};
