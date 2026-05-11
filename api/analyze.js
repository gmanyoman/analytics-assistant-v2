// api/analyze.js
// Vercel serverless function for Analytics Assistant v2
// Handles Claude API calls with rate limiting and cost protection

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// 간단한 메모리 기반 rate limiting (하루당 IP당 50회)
let dailyRequests = {};

export default async function handler(req, res) {
  // CORS 헤더 추가
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. POST only.' });
  }

  const { question, context } = req.body;
  
  // 입력 검증
  if (!question || typeof question !== 'string' || question.trim().length === 0) {
    return res.status(400).json({ error: 'Missing or invalid question' });
  }
  if (!context || typeof context !== 'object') {
    return res.status(400).json({ error: 'Missing or invalid context' });
  }

  // Rate limiting: IP당 하루 50회
  try {
    const today = new Date().toISOString().split('T')[0];
    const ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown';
    const key = `${today}:${ip}`;
    
    dailyRequests[key] = (dailyRequests[key] || 0) + 1;
    
    // 콘솔에 로깅 (Vercel 대시보드에서 확인 가능)
    console.log(`[${new Date().toISOString()}] IP=${ip}, day=${today}, requests=${dailyRequests[key]}, question="${question.substring(0,50)}..."`);
    
    // 하루 50회 초과 시 거부
    if (dailyRequests[key] > 50) {
      return res.status(429).json({ 
        error: `일일 요청 제한(50회)을 초과했습니다. 내일 다시 시도하세요.` 
      });
    }

    // 메모리 정리: 오래된 날짜 제거 (최대 3일치만 유지)
    const keys = Object.keys(dailyRequests);
    keys.forEach(k => {
      const [date] = k.split(':');
      const daysDiff = Math.floor((new Date(today) - new Date(date)) / (1000 * 60 * 60 * 24));
      if (daysDiff > 3) delete dailyRequests[k];
    });

  } catch (e) {
    console.error('Rate limiting error:', e);
    // rate limiting 실패해도 계속 진행 (너무 중요하지 않음)
  }

  try {
    // API key 확인
    if (!ANTHROPIC_API_KEY) {
      console.error('ANTHROPIC_API_KEY not set in environment');
      return res.status(500).json({ error: 'Server configuration error: API key not set' });
    }

    // 시스템 프롬프트
    const systemPrompt = `당신은 데이터 분석가입니다. 사용자 질문과 데이터를 보고 한국어로 인사이트를 생성합니다.
반드시 다음 JSON 스키마로만 응답하세요. 마크다운 코드펜스 없이, 다른 텍스트 없이 순수 JSON만:
{
  "summary": "데이터에서 발견한 핵심을 1-2 문장으로",
  "cause": "근본 원인 가설을 2-3 문장으로",
  "hypotheses": ["검증 가능한 가설 1", "가설 2", "가설 3"],
  "actions": [
    {"title": "구체적 액션", "detail": "왜/어떻게", "priority": "high"}
  ],
  "followUps": ["후속 질문 1", "후속 질문 2", "후속 질문 3"]
}
priority는 high/med/low. actions는 2-3개. followUps는 정확히 3개. 데이터의 실제 숫자에 근거하세요.`;

    // Anthropic Claude API 호출
    const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',  // Haiku 4.5 = 저비용, 적절한 성능
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: `질문: ${question}\n\n데이터:\n${JSON.stringify(context, null, 2)}`
        }]
      })
    });

    if (!anthropicResponse.ok) {
      const errData = await anthropicResponse.json();
      console.error('Anthropic API error:', errData);
      return res.status(anthropicResponse.status).json({ 
        error: `Claude API error: ${errData.error?.message || 'Unknown error'}` 
      });
    }

    const data = await anthropicResponse.json();
    
    // 응답 파싱
    const textContent = data.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');

    // JSON 추출 (마크다운 펜스 제거)
    const jsonText = textContent
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();

    let insight;
    try {
      insight = JSON.parse(jsonText);
    } catch (parseErr) {
      console.error('JSON parse error:', parseErr, 'Raw text:', jsonText.substring(0, 200));
      return res.status(500).json({ 
        error: 'Failed to parse Claude response as JSON. The API might have returned unexpected format.' 
      });
    }

    // 응답 반환
    return res.status(200).json({ insight });

  } catch (error) {
    console.error('Fatal error in analyze handler:', error);
    return res.status(500).json({ 
      error: `Server error: ${error.message}. Check Vercel logs for details.` 
    });
  }
}
