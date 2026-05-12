/**
 * POST /api/chat
 *
 * AI chatbot endpoint. The frontend uses a rule-based RAG-lite by default
 * (admin-configurable intents). When you're ready for real RAG/LLM:
 *
 *  1. Provision ANTHROPIC_API_KEY (or OPENAI_API_KEY) in Netlify env
 *  2. Add a vector store (Supabase pgvector / Pinecone) and ingest:
 *     - sales pitch document
 *     - case studies
 *     - pricing rates
 *     - FAQ entries (auto-syncable from /assets/data/seed.json)
 *  3. Replace the body of `answer()` below with retrieve+generate.
 */

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }
  const { question, sessionId } = payload;
  if (!question) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing question' }) };
  }

  // === LLM integration scaffold ===
  // if (process.env.ANTHROPIC_API_KEY) {
  //   const r = await fetch('https://api.anthropic.com/v1/messages', {
  //     method: 'POST',
  //     headers: {
  //       'x-api-key': process.env.ANTHROPIC_API_KEY,
  //       'anthropic-version': '2023-06-01',
  //       'content-type': 'application/json',
  //     },
  //     body: JSON.stringify({
  //       model: 'claude-haiku-4-5-20251001',
  //       max_tokens: 600,
  //       system: '함께워크_SI 공식 상담 챗봇입니다. 회사소개서·견적표·케이스를 기반으로 친절하게 답변하세요.',
  //       messages: [{ role: 'user', content: question }],
  //     }),
  //   });
  //   const data = await r.json();
  //   return {
  //     statusCode: 200,
  //     body: JSON.stringify({ answer: data?.content?.[0]?.text || '응답 생성 실패' }),
  //   };
  // }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      answer: '서버 챗봇은 아직 배포되지 않았습니다. 프론트엔드의 규칙 기반 응답을 사용해 주세요. (어드민 → AI 챗봇 설정에서 인텐트를 편집하세요)',
      sessionId,
    }),
  };
};
