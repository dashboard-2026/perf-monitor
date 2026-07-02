/**
 * HUG 성과지표 외부환경 분석 스크립트 (GitHub Actions에서 주 1회 자동 실행)
 * 결과는 Supabase env_analysis 테이블에 저장됨
 *
 * v2 개선사항:
 *  - 키워드별 개별 검색(상위 3개) 후 병합·중복제거 → 더 정확한 뉴스 확보
 *  - 지난주 분석 결과를 프롬프트에 포함 → 전주 대비 변화 추이(trend) 반영
 *  - 지표당 뉴스 최대 8건으로 확대
 *
 * 예상 API 사용량(주 1회 실행 기준): Google Search 약 54회(한도 100/일), Gemini 18회(한도 1500/일)
 */

const GEMINI_API_KEY    = process.env.GEMINI_API_KEY;
const GOOGLE_SEARCH_KEY  = process.env.GOOGLE_SEARCH_API_KEY;
const GOOGLE_SEARCH_CX   = process.env.GOOGLE_SEARCH_ENGINE_ID;
const SUPABASE_URL       = process.env.SUPABASE_URL;
const SUPABASE_KEY       = process.env.SUPABASE_KEY;

const MAX_KEYWORDS_PER_INDICATOR = 4; // 지표당 개별 검색할 키워드 수 (한도 조절용)
const MAX_NEWS_PER_INDICATOR     = 8; // 최종 병합 후 남길 뉴스 개수

// ── 분석 대상 18개 지표 + 검색 키워드 (중요도순으로 나열, 앞 3개가 개별 검색됨) ──
const INDICATORS = [
  { ws:'ceo', code:'P-01', name:'주택사업금융보증 실적',
    keywords:['건설공사비 지수', 'PF대출', 'CD금리', '재건축 공사비 증액'],
    desc:'주택사업 PF·정비사업 등에 대한 금융보증 공급액(억원). 건설경기·PF시장이 활발할수록 실적 증가. 많을수록 좋음.' },
  { ws:'ceo', code:'P-02', name:'공공지원임대주택 지원 실적',
    keywords:['건설공사비 지수', '공공임대주택 공급 목표', '주택담보대출 금리', '민간임대주택'],
    desc:'공공지원 민간임대주택 보증 지원 실적(호). 임대주택 공급·착공이 늘수록 실적 증가. 많을수록 좋음.' },
  { ws:'ceo', code:'P-03', name:'서민 주거안정 보증실적',
    keywords:['전월세 거래량', '전세보증금 반환보증', '전세사기', '전세자금 금리'],
    desc:'전세보증금 반환보증 등 서민 주거안정 보증 공급액(억원). 전세거래·전세수요가 많을수록 실적 증가. 많을수록 좋음.' },
  { ws:'ceo', code:'P-04', name:'전세보증 이행기한 준수도',
    keywords:['전세가격지수', '전세사기 피해 결정', '대위변제', '역전세'],
    desc:'전세보증 사고 발생 시 이행기한 준수율(%). 전세사고·대위변제가 급증하면 처리 부담이 커져 준수도 하락 압력. 높을수록 좋음.' },
  { ws:'ceo', code:'P-05-1', name:'재무건전성 관리지수 (부채비율)',
    keywords:['보증사고', '대위변제 규모', '공사채 발행', '부동산 경기'],
    desc:'기관 부채비율(%). 보증사고·대위변제가 늘면 부채비율 상승. 낮을수록 좋음.' },
  { ws:'ceo', code:'P-05-2', name:'재무건전성 관리지수 (구상채권 회수율)',
    keywords:['경매 낙찰가율', '부동산 경매 물량', '구상채권 매각', '법원 경매'],
    desc:'구상채권(대위변제 후 회수 대상) 회수율(%). 경매 낙찰가율이 높고 경매시장이 활발할수록 회수 유리. 높을수록 좋음.' },
  { ws:'ceo', code:'P-09', name:'도시계정 기금예산 집행률',
    keywords:['가로주택정비사업', '소규모주택정비사업', '자율주택정비사업', '소규모재건축'],
    desc:'도시계정(소규모 정비사업 융자 등) 기금예산 집행률(%). 가로주택·소규모정비 사업이 활발할수록 융자 집행 증가. 높을수록 좋음.' },

  { ws:'inst', code:'1-1', name:'주거안정 지원 강화',
    keywords:['주택 거래량', '공공임대주택 공급 목표', '보증 수요', '주택 매매가격'],
    desc:'주거안정 관련 보증 지원 실적(억원). 주택거래·보증수요가 많을수록 실적 증가. 많을수록 좋음.' },
  { ws:'inst', code:'1-2', name:'주택공급 지원 강화',
    keywords:['건설공사비 지수', '주택 착공', '분양 물량', '인허가 실적'],
    desc:'주택공급 관련 보증 지원 실적(억원). 주택 착공·분양·인허가가 활발할수록 실적 증가. 많을수록 좋음.' },
  { ws:'inst', code:'2-1', name:'보증사고율',
    keywords:['미분양', '건설사 부도', '입주율', '분양시장'],
    desc:'보증사고율(%). 미분양·건설사 부도·입주 지연이 늘면 사고율 상승. 낮을수록 좋음.' },
  { ws:'inst', code:'2-2', name:'전세임대보증 부채비율',
    keywords:['전세가격지수', '전세가율', '역전세', '임대차 시장'],
    desc:'전세임대보증 부채비율(%). 전세가 하락·역전세가 심해지면 부채비율 상승. 낮을수록 좋음.' },
  { ws:'inst', code:'3-3', name:'전세보증 이행도',
    keywords:['전세가격지수', '전세사기 피해 결정', '대위변제', '역전세'],
    desc:'전세보증 이행도(%, 사고 대비 원활한 이행). 전세사기·대위변제가 급증하면 이행 부담 증가. 낮을수록(사고 적을수록) 좋음.' },
  { ws:'inst', code:'4-1', name:'기업보증 회수율',
    keywords:['건설사 법정관리', '기업 회생', 'PF 부실 사업장', '채권 매각'],
    desc:'기업보증 구상채권 회수율(%). 건설사 법정관리·기업회생이 늘면 회수 어려움. 높을수록 좋음.' },
  { ws:'inst', code:'4-2', name:'개인보증 회수율',
    keywords:['경매 낙찰가율', '주택 경매 물량', '개인회생', '연체율'],
    desc:'개인보증 구상채권 회수율(%). 경매 낙찰가율이 높을수록 회수 유리, 개인회생·연체 증가 시 불리. 높을수록 좋음.' },
  { ws:'inst', code:'5', name:'든든전세주택 공급',
    keywords:['전월세 거래량', '경매 유입 물량', '공공 매입임대', '빈집 매입'],
    desc:'든든전세주택(경매주택 매입 후 공공전세) 공급 세대수. 경매 물량·매입임대 여건이 좋을수록 공급 증가. 많을수록 좋음.' },
  { ws:'inst', code:'6', name:'임대주택 공급 활성화',
    keywords:['주택도시기금 출자', '임대리츠', '공공임대 착공', 'LH 공급'],
    desc:'임대주택 공급 활성화 실적(세대). 기금 출자·임대리츠·공공임대 착공이 활발할수록 실적 증가. 많을수록 좋음.' },
  { ws:'inst', code:'7', name:'주택구입·전세자금 대출지원',
    keywords:['주택담보대출 금리', 'DSR 규제', '정책모기지 한도', '전세자금대출 규제'],
    desc:'주택구입·전세자금 대출지원 실적(세대). 대출금리·DSR 규제·정책모기지 한도가 완화될수록 지원 증가. 많을수록 좋음.' },
  { ws:'inst', code:'8-1', name:'도시재생 활성화 지원실적',
    keywords:['도시재생 뉴딜리츠', '도시재생 씨앗융자', '노후산업단지재생', '소규모정비사업'],
    desc:'도시재생(뉴딜리츠·씨앗융자 등) 지원 실적(백만원). 도시재생 사업·융자가 활발할수록 실적 증가. 많을수록 좋음.' },
];

// ── 사용량 카운터 (실행 로그용) ──────────────────────────────────
let searchCallCount = 0;
let geminiCallCount = 0;

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

// 키워드 1개로 검색 (num=4)
async function searchNewsForKeyword(keyword){
  searchCallCount++;
  const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_SEARCH_KEY}&cx=${GOOGLE_SEARCH_CX}&q=${encodeURIComponent(keyword)}&num=4&dateRestrict=w2&hl=ko&gl=kr`;
  const res = await fetch(url);
  if(!res.ok) throw new Error('Google Search: '+await res.text());
  const data = await res.json();
  if(!data.items) return [];
  return data.items.map(i=>({ title:i.title, snippet:i.snippet, link:i.link, keyword }));
}

// 상위 N개 키워드를 개별 검색 후 링크 기준 중복제거하여 병합
async function searchNewsMulti(keywords){
  const targets = keywords.slice(0, MAX_KEYWORDS_PER_INDICATOR);
  const merged = [];
  const seenLinks = new Set();
  for (const kw of targets) {
    try {
      const items = await searchNewsForKeyword(kw);
      for (const it of items) {
        if (!seenLinks.has(it.link)) {
          seenLinks.add(it.link);
          merged.push(it);
        }
      }
    } catch(e) {
      console.log(`   (검색 실패: "${kw}" - ${e.message.slice(0,50)})`);
    }
    await sleep(300);
  }
  return merged.slice(0, MAX_NEWS_PER_INDICATOR);
}

// 지난주 분석 결과 조회 (있으면 변화 비교용으로 사용)
async function fetchPreviousAnalysis(ws, code){
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/env_analysis?id=eq.${ws}:env:${code}&select=payload`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    if(!res.ok) return null;
    const rows = await res.json();
    if(!rows[0]?.payload) return null;
    return JSON.parse(rows[0].payload);
  } catch(e){ return null; }
}

async function analyzeWithGemini(name, desc, newsItems, previous){
  geminiCallCount++;
  const newsText = newsItems.length
    ? newsItems.map((n,i)=>`[${i+1}] ${n.title}\n${n.snippet}`).join('\n\n')
    : '최근 2주간 관련 뉴스를 찾지 못했습니다.';

  const prevText = previous?.analysis
    ? `\n## 지난주 분석 결과\n요약: ${previous.analysis.summary}\n전망: ${previous.analysis.outlook || '(없음)'}\n분석일: ${previous.analyzedAt || '(알 수 없음)'}\n`
    : '\n## 지난주 분석 결과\n(이전 분석 없음 — 이번이 첫 분석)\n';

  const prompt = `당신은 공공기관 성과관리를 지원하는 애널리스트입니다. 아래 지표의 외부환경을 분석해, 성과담당자가 보고서에 바로 인용할 수 있는 사실 중심의 문장을 작성하세요.

## 분석 대상 지표
- 지표명: "${name}"
- 지표 설명: ${desc || '(설명 없음)'}

## 최근 뉴스
${newsText}
${prevText}
## 분석 지침
1. [무관 뉴스 제외] 위 뉴스 중 이 지표와 직접 관련 없는 기사(예: 스포츠·연예·정치 일반 등)는 무시하고, 관련 있는 내용만 근거로 삼으세요.
2. [방향성 판단] 지표 설명의 "높을수록/낮을수록 좋음"을 기준으로 impact를 판정하세요. 예: 보증사고율은 낮을수록 좋은 지표이므로, "사고 증가" 뉴스는 negative입니다. 지표 실적에 유리하면 positive, 불리하면 negative, 중립이면 neutral.
3. [수치 우선] 뉴스에 지수·수치가 있으면 전월 대비·전년동월 대비 변동(상승/하락/보합)을 반드시 확인해 summary와 description에 구체적으로 반영하세요. 비교 수치가 없으면 억지로 만들지 말고 방향성만 서술하세요(수치를 지어내지 마세요).
4. [변화 추이] 지난주 분석이 있으면 이번 주와 비교해 달라진 점을 trend에 반영하세요. 없으면 direction을 "new"로 하세요.
5. [문체] "지속적인 모니터링이 필요하다", "귀추가 주목된다", "예의주시할 필요가 있다" 같은 상투적·공허한 표현을 금지합니다. 구체적 사실·수치·인과관계 중심으로 간결하게 쓰세요.

## 좋은 출력 예시 (형식 참고용)
{
  "summary": "5월 건설공사비지수가 137.67로 전월 대비 0.40%, 전년동월 대비 5.07% 상승하며 역대 최고치를 경신했다. 자재비·인건비 상승이 PF 사업성을 압박해 보증 수요에 부정적으로 작용할 수 있다.",
  "factors": [
    { "name": "공사비 상승", "impact": "negative", "description": "건설공사비지수 전년동월 대비 5.07% 상승으로 사업 원가 부담 확대" },
    { "name": "PF 시장 위축", "impact": "negative", "description": "고금리 지속으로 PF 대출 심사 강화, 신규 보증 수요 둔화" }
  ],
  "outlook": "공사비 상승세가 2분기에도 이어지면 보증 실적 회복은 제한적일 전망이다.",
  "trend": { "direction": "worsening", "description": "지난주 대비 공사비지수가 추가 상승하며 부담이 커졌다." }
}

## 출력 형식
반드시 아래 JSON 형식으로만 응답하세요. 다른 텍스트·마크다운·설명은 절대 포함하지 마세요.
{
  "summary": "2~3문장. 현재 외부환경 핵심을 수치와 함께 요약",
  "factors": [
    { "name": "요인명(10자 이내)", "impact": "positive|negative|neutral", "description": "한 문장. 가능하면 전월/전년동월 대비 수치 포함" }
  ],
  "outlook": "향후 1~2개월 전망 한 문장",
  "trend": { "direction": "improving|worsening|stable|new", "description": "지난주 대비 달라진 점 한 문장 (지난주 분석 없으면 '이번이 첫 분석입니다')" }
}
factors는 2~4개로 작성하세요.`;

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,{
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ contents:[{parts:[{text:prompt}]}], generationConfig:{temperature:0.3,maxOutputTokens:1200} })
  });
  if(!res.ok) throw new Error('Gemini: '+await res.text());
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const m = text.match(/\{[\s\S]*\}/);
  if(!m) throw new Error('JSON 파싱 실패');
  return JSON.parse(m[0]);
}

async function saveToSupabase(ws, code, analysis, news){
  const payload = { analysis, news, analyzedAt: new Date().toISOString() };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/env_analysis`,{
    method:'POST',
    headers:{'Content-Type':'application/json','apikey':SUPABASE_KEY,'Authorization':`Bearer ${SUPABASE_KEY}`,'Prefer':'resolution=merge-duplicates'},
    body: JSON.stringify({ id:`${ws}:env:${code}`, payload: JSON.stringify(payload) })
  });
  if(!res.ok) throw new Error('Supabase: '+await res.text());
}

(async ()=>{
  console.log(`\n🔍 외부환경 분석 시작 — ${new Date().toLocaleString('ko-KR')}`);
  console.log(`대상: ${INDICATORS.length}개 지표 (지표당 상위 ${MAX_KEYWORDS_PER_INDICATOR}개 키워드 개별 검색)\n`);
  let ok=0, fail=0;
  for(const ind of INDICATORS){
    try{
      process.stdout.write(`[${ind.code}] ${ind.name}...`);
      const news = await searchNewsMulti(ind.keywords);
      const previous = await fetchPreviousAnalysis(ind.ws, ind.code);
      await sleep(300);
      const analysis = await analyzeWithGemini(ind.name, ind.desc, news, previous);
      await sleep(1000);
      await saveToSupabase(ind.ws, ind.code, analysis, news);
      console.log(` ✅ (뉴스 ${news.length}건${previous?', 전주비교 O':', 첫분석'})`);
      ok++;
    }catch(e){
      console.log(` ❌ ${e.message.slice(0,60)}`);
      fail++;
    }
    await sleep(500);
  }
  console.log(`\n완료 — 성공 ${ok}, 실패 ${fail}`);
  console.log(`API 사용량 — Google Search: ${searchCallCount}회(한도 100/일), Gemini: ${geminiCallCount}회(한도 1500/일)`);
  if(fail>0 && ok===0) process.exit(1);
})();
