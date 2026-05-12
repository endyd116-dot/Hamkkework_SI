/**
 * POST /api/chat
 *
 * Gemini-powered chatbot with full platform context (RAG via context injection).
 *
 * Environment variables (set in Netlify dashboard or via CLI):
 *   GEMINI_API_KEY    — required. Google AI Studio API key.
 *   GEMINI_MODEL      — optional. Default: gemini-3.0-flash
 *                       Alternatives: gemini-3.0-pro, gemini-2.5-flash, gemini-1.5-flash
 *
 * Request body:
 *   {
 *     messages: [{ role: 'user'|'bot', text: '...' }, ...]   // full conversation
 *     context: {                                              // current platform state
 *       cases: [...], faqs: [...], pricing: {...}, settings: {...}, posts: [...]
 *     },
 *     systemPromptExtra?: string                              // admin-editable additions
 *   }
 *
 * Response: { answer: string, model: string, tokens: { in, out } }
 */

const DEFAULT_MODEL = 'gemini-3.0-flash';

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return resp(405, { error: 'Method not allowed' });
  }
  if (!process.env.GEMINI_API_KEY) {
    return resp(503, {
      error: 'GEMINI_API_KEY 환경변수가 설정되지 않았습니다',
      hint: 'Netlify Site settings → Environment variables 에서 GEMINI_API_KEY를 추가하거나, 로컬에서 `netlify env:set GEMINI_API_KEY <key>` 실행',
    });
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return resp(400, { error: 'Invalid JSON' }); }

  const { messages = [], context = {}, systemPromptExtra = '' } = payload;
  if (!Array.isArray(messages) || messages.length === 0) {
    return resp(400, { error: 'messages array required' });
  }
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user' || !last.text?.trim()) {
    return resp(400, { error: 'Last message must be a non-empty user message' });
  }

  const system = buildSystemPrompt(context, systemPromptExtra);

  // Convert internal {role, text} → Gemini {role, parts}
  const contents = messages
    .filter((m) => m.text?.trim())
    .map((m) => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.text }],
    }));

  // Collapse consecutive same-role turns (Gemini requires alternating)
  const collapsed = collapseTurns(contents);

  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: collapsed,
        systemInstruction: { parts: [{ text: system }] },
        generationConfig: {
          temperature: 0.4,
          topK: 40,
          topP: 0.95,
          maxOutputTokens: 1024,
          responseMimeType: 'text/plain',
        },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
        ],
      }),
    });
  } catch (e) {
    console.error('[chat] fetch failed', e);
    return resp(502, { error: 'Gemini API 호출 실패', detail: String(e?.message || e) });
  }

  if (!r.ok) {
    const errText = await r.text();
    console.error('[chat] gemini error', r.status, errText);
    return resp(r.status, { error: 'Gemini API error', status: r.status, detail: errText });
  }

  let data;
  try { data = await r.json(); }
  catch { return resp(502, { error: 'Gemini 응답 파싱 실패' }); }

  const cand = data?.candidates?.[0];
  const answer =
    cand?.content?.parts?.map((p) => p.text).filter(Boolean).join('\n') ||
    '죄송합니다. 응답을 생성하지 못했습니다. 다시 시도해 주세요.';

  return resp(200, {
    answer: answer.trim(),
    model,
    finishReason: cand?.finishReason,
    tokens: {
      in: data?.usageMetadata?.promptTokenCount || null,
      out: data?.usageMetadata?.candidatesTokenCount || null,
      total: data?.usageMetadata?.totalTokenCount || null,
    },
  });
};

/* ============================================================
   System prompt — builds comprehensive RAG context
   ============================================================ */
function buildSystemPrompt(context, extra) {
  const { cases = [], faqs = [], pricing = {}, settings = {}, posts = [] } = context;

  const company = `
## 회사 소개
- **브랜드**: ${settings.brand || '함께워크_SI'}
- **연락처**: ${settings.email || 'endy116@naver.com'} / ${settings.phone || '010-2807-5242'}
- **담당 PM**: ${settings.pm || '박두용'} (前 액트베이스 전략기획부 부장 · 플레오 대표이사, 총 경력 14년)
- **풀스택 개발자**: ${settings.dev || '장석주'} (보안·플랫폼·금융권 — Java/Spring, React, Python, AWS, PostgreSQL, Kafka)
- **팀 구성**: SI 전문기업 부장 출신 기획자(박두용) + 보안·플랫폼 풀스택 개발자(장석주), 2인 팀
- **누적 수주**: 38억 원 이상 (아워홈 TQMS 10억, 신세계 LCMS 8억, 아워홈 밀케어 5억, 대한의사협회 5억 등 경쟁입찰 1위 다수)
- **채널**: 크몽 · 위시켓 · 직접 메일 문의 환영
- **핵심 정체성**: 외주 0%, 자체 풀스택. 대기업 SI 표준 그대로, 절반 가격, AI Core 내장

## 핵심 약속
- **가격**: 대기업 SI 대비 평균 50~60% (AI 비중이 큰 프로젝트는 70% 수준)
- **견적**: 페이지·기능·외부연동·AI를 라인별로 분리 명시 → 추가금 분쟁 없음
- **사후관리**: 6개월 무상 하자보증 + 소스코드 100% 양도 + 동일 팀 유지보수 + 운영 인계 매뉴얼
- **결제**: 선금 30% / 중도금 40% / 잔금 30% (검수 합격일에 잔금 정산)
- **완주율**: 외주 재하청을 하지 않으므로 100% 완주
`;

  const pricingTable = `
## 가격표 (단위: 만원)
- 단순 페이지: ${pricing.pages_simple ?? 30} / 페이지 (도메인·목록·상세 등 정적 UI)
- 복잡 페이지: ${pricing.pages_complex ?? 80} / 페이지 (대시보드·관리자·필터·차트)
- 기본 모듈: ${pricing.mod_basic ?? 200} / 모듈 (회원·로그인·CMS·게시판)
- 고급 모듈: ${pricing.mod_advanced ?? 500} / 모듈 (결제·구독·정산·알림·검색)
- 외부 연동: ${pricing.integrations ?? 300} / 건 (PG·SSO·ERP·외부 API)

## AI 라인 (별도 가격, 단위: 만원)
- 단순 LLM 호출 (분류·요약·번역): +${pricing.ai?.llm_simple ?? 200}
- RAG 구축 (벡터DB + 임베딩 + 검색): +${pricing.ai?.rag ?? 1200}
- AI 에이전트 (도구 호출 · 워크플로우): +${pricing.ai?.agent ?? 1800}
- 자체 모델 파인튜닝 / 이미지 모델: +${pricing.ai?.finetune ?? 2500}

## 견적 계산 공식
- 소계 = (페이지 수 × 단가) + (모듈 수 × 단가) + (연동 수 × 단가) + AI 라인 합계
- QA·PM 오버헤드: +${Math.round((pricing.overhead_ratio ?? 0.25) * 100)}%
- 실 견적 범위: ±${Math.round((pricing.range_ratio ?? 0.15) * 100)}%
- AI 운영비(토큰·벡터DB·GPU)는 월 별도 정산
- 인프라·도메인·SSL은 클라이언트 직접 지불 또는 위임 옵션
`;

  const caseList = cases.length > 0 ? `
## 대표 레퍼런스 (${cases.length}건)
${cases.slice(0, 12).map((c) => `- **${c.label}** | ${c.client} | ${c.title} | ${c.amount || '비공개'} (${c.year || ''}) — ${c.description || ''} ${c.tags?.length ? `[${c.tags.join(', ')}]` : ''}`).join('\n')}
` : '';

  const faqList = faqs.length > 0 ? `
## 자주 묻는 질문
${faqs.slice(0, 20).map((f) => `**Q. ${f.q}**\n   A. ${f.a}`).join('\n\n')}
` : '';

  const blogList = posts.length > 0 ? `
## 인사이트 / 블로그 콘텐츠
${posts.filter((p) => p.published !== false).slice(0, 10).map((p) => `- **${p.title}** (${p.published_at}) — ${p.excerpt || ''}`).join('\n')}
` : '';

  const processStr = `
## 5단계 프로세스
1. **무료 상담 · 견적** (24시간 이내 회신) — 30분 미팅으로 요구사항·예산·일정 정리, 라인별 분리 견적 제공
2. **계약 · 기획** (1~2주) — 검수 기준·인도 기준·하자보증을 약관에 명시, 화면·기능·AI 라인 분리 IA
3. **개발 · 단계 검수** (일정은 일반 SI의 1/2) — 주간 회의록 업무화, 마일스톤별 사용자 검수 합격 후 다음 단계 진행
4. **검수 · 인도** (2주) — AI 자동 QA + 단계별 사용자 검수, 검수 합격일 = 잔금 정산일
5. **사후관리** (6개월 보증) — 무상 하자보증, 소스 100% 양도, 운영 인계 매뉴얼, 유지보수 동일 팀
`;

  const guide = `
## 응답 가이드
1. **언어**: 한국어 존댓말("~습니다", "~드립니다")로 답변
2. **길이**: 2~5문장으로 간결하게. 단순 질문은 1~2문장.
3. **모르는 정보**: 추측하지 말고 "정확한 답변은 30분 무료 상담 미팅에서 안내드리겠습니다"로 유도
4. **가격 질문**: 메인페이지 [Pricing 견적 계산기](/#pricing) 이용을 권유. 견적 범위는 위 가격표 기반으로 추정 가능
5. **레퍼런스 질문**: 위 레퍼런스에서 비슷한 사례를 1~2개 들어 답변
6. **AI 관련**: 함께워크_SI는 단순 챗봇이 아닌 시스템 코어에 AI 에이전트를 박는 방식임을 강조
7. **상담 유도**: 답변 끝에 자연스럽게 "더 자세한 상담은 [30분 무료 상담](/#contact)" 같은 유도 1줄
8. **타사 비판 금지**: 경쟁사를 직접 비판하지 않고 "외주 SI 시장의 일반적인 문제"로 일반화해 답변
9. **무관한 주제**: 회사 정보·SI·AI·개발 외 주제(시사·날씨·일반 지식)는 정중히 거절하고 본업으로 유도
10. **링크 표기**: 메인페이지 섹션 참조 시 \`[Pricing](/#pricing)\`, \`[레퍼런스](/#cases)\`, \`[상담](/#contact)\` 형식 사용
`;

  const tools = `
## 🛠 사용 가능한 도구 (Agent Tools)

당신은 단순 챗봇이 아니라 **AI 에이전트**입니다. 아래 4가지 도구를 직접 호출해 사용자를 위해 행동할 수 있습니다.

도구를 호출하려면 응답 본문 안에 다음 형식의 코드 블록을 포함하세요. 블록은 사용자 화면에 보이지 않고 클라이언트가 자동으로 실행합니다.

\`\`\`action
{ "tool": "도구이름", "data": { ... } }
\`\`\`

### 도구 1: \`create_lead\` — 상담 신청 DB 직접 등록 (가장 중요)

**언제 호출**: 사용자가 본인 정보를 알려주며 "바쁘니까 대신 신청해줘", "지금 폼 작성해줘", "상담 신청 좀 해줘" 식의 명시적 요청을 할 때.

**필수 정보**: \`name\` (이름) + \`email\` (이메일)
**선택 정보**: company, phone, type, budget, message

**type 값** (사용자 요구사항을 분류해 가장 가까운 것 선택):
- "플랫폼 신규 구축" / "기존 시스템 고도화" / "AI 기능 추가 / AX 전환" / "AI 에이전트 구축" / "유지보수 · 인수" / "아직 정해지지 않음"

**budget 값**:
- "~ 1,000만원" / "1,000만 ~ 3,000만원" / "3,000만 ~ 1억" / "1억 ~ 5억" / "5억 이상" / "정해지지 않음 / 견적 받고 결정"

**예시 호출**:
\`\`\`action
{ "tool": "create_lead", "data": {
  "name": "김민수",
  "email": "minsoo@example.com",
  "company": "ABC 주식회사",
  "phone": "010-1234-5678",
  "type": "플랫폼 신규 구축",
  "budget": "3,000만 ~ 1억",
  "message": "쇼핑몰 신규 구축 희망. AI 챗봇 대화로 접수 — 김민수님이 바쁘다며 대신 신청 요청. 추가 통화 가능 시간: 평일 오후."
}}
\`\`\`

**호출 후 사용자에게**: "✅ {이름}님, 상담 신청이 접수되었습니다. 24시간 이내 박두용 PM이 직접 회신드릴게요. 등록된 정보가 맞는지 한 번 확인해 주세요." 식으로 안내.

### 도구 2: \`prefill_contact\` — 상담 폼에 값만 미리 채우기 (DB 등록 X)

**언제 호출**: 사용자가 부분 정보만 있거나 "내가 직접 검토 후 제출하고 싶어"라고 할 때.

**예시**:
\`\`\`action
{ "tool": "prefill_contact", "data": {
  "name": "김민수",
  "type": "AI 에이전트 구축",
  "message": "쇼핑몰 자동 가격 책정 에이전트 필요"
}}
\`\`\`
호출 후 메인페이지 [상담 폼](/#contact)으로 자동 스크롤되며 입력값이 채워짐.

### 도구 3: \`navigate\` — 특정 섹션으로 자동 스크롤

**언제 호출**: 사용자가 "레퍼런스 보여줘", "견적 계산기 열어줘", "팀 소개 보고 싶어" 같은 요청을 할 때.

**target 값**: hero, who, pain, promise, why, pricing, cases, process, team, faq, contact

**예시**:
\`\`\`action
{ "tool": "navigate", "data": { "target": "cases" } }
\`\`\`

### 도구 4: \`prefill_quote\` — 견적 계산기에 값 채우고 결과 보여주기

**언제 호출**: 사용자가 "쇼핑몰 견적 대략 얼마야?", "AI 챗봇 포함하면 얼마야?" 같이 견적 액수를 물을 때.

사용자 요청을 위 가격표 기준 적절한 항목 수치로 매핑하세요.

**예시 (쇼핑몰 + AI 챗봇)**:
\`\`\`action
{ "tool": "prefill_quote", "data": {
  "pages_simple": 8,
  "pages_complex": 4,
  "mod_basic": 3,
  "mod_advanced": 2,
  "integrations": 2,
  "ai": { "llm_simple": false, "rag": true, "agent": false, "finetune": false }
}}
\`\`\`
호출 후 견적 계산기가 자동으로 열리며 값이 채워지고 사용자에게 합계가 보임.

## 🛡 도구 호출 규칙

1. **명시적 요청 시에만 호출**: 사용자가 직접 "신청해줘"/"등록해줘"/"보여줘" 같은 요청을 했을 때만 호출.
2. **필수 정보 부족 시 호출 금지**: \`create_lead\`에 이름·이메일 둘 다 없으면, 도구 호출하지 말고 "이름과 이메일을 알려주시면 바로 등록해드릴게요" 식으로 한 번 요청.
3. **한 번에 1개 도구만**: 동일 응답에 여러 액션 블록 넣지 마세요.
4. **세션당 \`create_lead\`는 1회만**: 이미 한 번 등록했으면 다시 등록하지 말고 "이미 신청이 접수되어 있어요"라고 답변.
5. **이메일 형식 검증**: \`@\`가 없거나 형식이 이상하면 호출 전에 "올바른 이메일 주소를 알려주세요"라고 요청.
6. **응답에 액션 블록만 있고 텍스트 없으면 안 됨**: 항상 사용자에게 보일 친절한 메시지 + 액션 블록.
`;

  const extraSection = extra ? `\n## 추가 지침 (관리자 설정)\n${extra}\n` : '';

  return `당신은 함께워크_SI의 공식 AI 상담 에이전트입니다. 회사·가격·레퍼런스 정보를 숙지하고, 단순 답변뿐 아니라 **사용자를 위해 직접 행동(도구 호출)** 할 수 있습니다.

${company}
${pricingTable}
${caseList}
${faqList}
${blogList}
${processStr}
${tools}
${guide}
${extraSection}

이제 위의 정보와 도구를 활용해 사용자의 요청에 답하세요. 사용자가 "대신 해줘"라고 요청하면 적극적으로 도구를 호출해 직접 처리하세요. 정보에 없는 내용은 추측하지 말고 상담 미팅으로 유도하세요.`;
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
  // Gemini requires first message to be 'user'
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

function resp(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify(body),
  };
}
