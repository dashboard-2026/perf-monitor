/**
 * HUG 성과지표 외부환경 분석 스크립트 (GitHub Actions에서 주 1회 자동 실행)
 * 결과는 Supabase env_analysis 테이블에 저장됨
 *
 * v3 개선사항 (Google Custom Search → 네이버 뉴스 검색으로 전환):
 *  - Google Programmable Search Engine이 2026년 1월부로 무료 전체웹검색을 중단하여
 *    네이버 뉴스 검색 API로 교체 (한국어 부동산·금융 뉴스에 더 적합, 무료 일 25,000회)
 *  - 키워드별 개별 검색(상위 4개) 후 병합·중복제거 → 더 정확한 뉴스 확보
 *  - 지난주 분석 결과를 프롬프트에 포함 → 전주 대비 변화 추이(trend) 반영
 *  - 지표당 뉴스 최대 8건으로 확대
 *
 * 예상 API 사용량(주 1회 실행 기준): 네이버 뉴스 약 72회(한도 25,000/일),
 *   Gemini 18~36회(1회 실패 시 재시도 포함, 한도 1500/일)
 */

const GEMINI_API_KEY     = process.env.GEMINI_API_KEY;
const NAVER_CLIENT_ID    = process.env.NAVER_CLIENT_ID;
const NAVER_CLIENT_SECRET= process.env.NAVER_CLIENT_SECRET;
const SUPABASE_URL       = process.env.SUPABASE_URL;
const SUPABASE_KEY       = process.env.SUPABASE_KEY;

// 지표당 키워드는 전체 검색 (각 키워드마다 date+sim 2회 호출)
const TEST_MODE = false; // 테스트 시 true (앞 3개 지표만 실행), 운영 시 false로 변경
const MAX_NEWS_PER_INDICATOR     = 8; // 최종 병합 후 남길 뉴스 개수

// ── 분석 대상 18개 지표 + 검색 키워드 (중요도순으로 나열, 앞 3개가 개별 검색됨) ──
const INDICATORS = [
  { ws:'ceo', code:'P-01', name:'주택사업금융보증 실적',
    keywords:['건설공사비 지수', '부동산 PF', '주택 공급대책', '정비사업 활성화'],
    desc:'주택사업 PF·정비사업 등에 대한 금융보증 공급액(억원). 건설경기·PF시장·주택공급 정책이 활발할수록 실적 증가. 많을수록 좋음.' },
  { ws:'ceo', code:'P-02', name:'공공지원임대주택 지원 실적',
    keywords:['공공지원 민간임대', '임대주택 공급대책', '민간임대주택 활성화', '임대리츠'],
    desc:'공공지원 민간임대주택 보증 지원 실적(호). 임대주택 공급 정책·착공이 늘수록 실적 증가. 많을수록 좋음.' },
  { ws:'ceo', code:'P-03', name:'서민 주거안정 보증실적',
    keywords:['전세보증금 반환보증', '전세사기 대책', '전월세 거래량', '임차인 보호'],
    desc:'전세보증금 반환보증 등 서민 주거안정 보증 공급액(억원). 전세거래·전세수요·관련 정책이 많을수록 실적 증가. 많을수록 좋음.' },
  { ws:'ceo', code:'P-04', name:'전세보증 이행기한 준수도',
    keywords:['전세가격지수', '전세사기 피해 결정', '대위변제', '역전세'],
    desc:'전세보증 사고 발생 시 이행기한 준수율(%). 현재 높은 수준에서 안정적으로 유지되고 있는 지표로, 통상적인 여건에서는 준수도가 잘 유지됨. 전세사고·대위변제가 급격히 늘어나는 경우에 한해 하락 압력이 발생할 수 있음. 높을수록 좋음.' },
  { ws:'ceo', code:'P-05-1', name:'재무건전성 관리지수 (부채비율)',
    keywords:['보증사고', '대위변제 규모', '공사채 발행', '부동산 경기'],
    desc:'기관 부채비율(%). 보증사고·대위변제가 늘면 부채비율 상승. 낮을수록 좋음.' },
  { ws:'ceo', code:'P-05-2', name:'재무건전성 관리지수 (구상채권 회수율)',
    keywords:['경매 낙찰가율', '경매 낙찰률', '부동산 경매 물량', '구상채권 매각'],
    desc:'구상채권(대위변제 후 회수 대상) 회수율(%). 경매 낙찰가율·낙찰률이 높고 경매시장이 활발할수록 회수 유리. 높을수록 좋음.' },
  { ws:'ceo', code:'P-09', name:'도시계정 기금예산 집행률',
    keywords:['가로주택정비사업', '소규모주택정비', '도시재생 뉴딜', '노후계획도시 정비'],
    desc:'도시계정(소규모 정비사업 융자 등) 기금예산 집행률(%). 가로주택·소규모정비·도시재생 사업이 활발할수록 융자 집행 증가. 높을수록 좋음.' },

  { ws:'inst', code:'1-1', name:'주거안정 지원 강화',
    keywords:['전세보증금 반환보증', '전세사기 대책', '전월세 거래량', '임차인 보호'],
    desc:'주거안정 관련 보증 지원 실적(억원). 전세거래·전세수요·관련 정책이 많을수록 실적 증가. 많을수록 좋음.' },
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
    desc:'전세보증 이행도(%, 사고 대비 원활한 이행). 현재 안정적으로 잘 관리되고 있는 지표로, 통상적인 여건에서는 이행도가 양호하게 유지됨. 전세사기·대위변제가 급격히 늘어나는 경우에 한해 부담이 커질 수 있음. 낮을수록(사고 적을수록) 좋음.' },
  { ws:'inst', code:'4-1', name:'기업보증 회수율',
    keywords:['건설사 법정관리', '기업 회생', 'PF 부실 사업장', '채권 매각'],
    desc:'기업보증 구상채권 회수율(%). 건설사 법정관리·기업회생이 늘면 회수 어려움. 높을수록 좋음.' },
  { ws:'inst', code:'4-2', name:'개인보증 회수율',
    keywords:['경매 낙찰가율', '경매 낙찰률', '주택 경매 물량', '개인회생'],
    desc:'개인보증 구상채권 회수율(%). 경매 낙찰가율·낙찰률이 높을수록 회수 유리, 개인회생 증가 시 불리. 높을수록 좋음.' },
  { ws:'inst', code:'5', name:'든든전세주택 공급',
    keywords:['전월세 거래량', '경매 유입 물량', '공공 매입임대', '빈집 매입'],
    desc:'든든전세주택(경매주택 매입 후 공공전세) 공급 세대수. 경매 물량·매입임대 여건이 좋을수록 공급 증가. 많을수록 좋음.' },
  { ws:'inst', code:'6', name:'임대주택 공급 활성화',
    keywords:['임대주택 공급대책', '임대리츠', '공공임대 착공', '주택도시기금 출자'],
    desc:'임대주택 공급 활성화 실적(세대). 임대주택 공급 정책·임대리츠·공공임대 착공이 활발할수록 실적 증가. 많을수록 좋음.' },
  { ws:'inst', code:'7', name:'주택구입·전세자금 대출지원',
    keywords:['정책모기지 한도', '가계대출 총량규제', '전세자금대출 규제', '주택도시기금 대출 한도'],
    desc:'주택구입·전세자금 대출지원 실적(세대). 정책모기지·기금 대출 한도가 확대되고 관련 규제가 완화될수록 지원 증가. 정책대출은 DSR 규제 적용 대상이 아니며 정부 고시 별도 금리체계를 적용받음. 많을수록 좋음.' },
  { ws:'inst', code:'8-1', name:'도시재생 활성화 지원실적',
    keywords:['도시재생 뉴딜리츠', '도시재생 씨앗융자', '노후산업단지재생', '소규모정비사업'],
    desc:'도시재생(뉴딜리츠·씨앗융자 등) 지원 실적(백만원). 도시재생 사업·융자가 활발할수록 실적 증가. 많을수록 좋음.' },
];

// ── 사용량 카운터 (실행 로그용) ──────────────────────────────────
let searchCallCount = 0;
let geminiCallCount = 0;

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

// 키워드 1개로 검색 (num=4)
// 네이버 검색 결과의 <b> 태그 등 HTML 마크업 제거
function stripHtml(s){
  return (s||'').replace(/<[^>]*>/g,'').replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
}

// 네이버 뉴스 1개 쿼리 호출 (정렬방식 지정)
async function naverNewsQuery(keyword, sort){
  searchCallCount++;
  const url = `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(keyword)}&display=5&sort=${sort}`;
  const res = await fetch(url, {
    headers: {
      'X-Naver-Client-Id': NAVER_CLIENT_ID,
      'X-Naver-Client-Secret': NAVER_CLIENT_SECRET,
    }
  });
  if(!res.ok) throw new Error('Naver Search: '+await res.text());
  const data = await res.json();
  if(!data.items) return [];
  const oneMonthAgo = Date.now() - 30*24*60*60*1000;
  return data.items
    .filter(i => new Date(i.pubDate).getTime() >= oneMonthAgo)
    .map(i=>({ title:stripHtml(i.title), snippet:stripHtml(i.description), link:i.originallink||i.link, keyword }));
}

// 키워드 1개를 최신순(date) + 관련도순(sim) 두 번 검색해 병합 (최근 1개월 이내)
async function searchNewsForKeyword(keyword){
  const [byDate, bySim] = await Promise.all([
    naverNewsQuery(keyword, 'date'),
    naverNewsQuery(keyword, 'sim'),
  ]);
  // 최신순 우선으로 병합하되 링크 중복 제거
  const merged = [];
  const seen = new Set();
  for (const it of [...byDate, ...bySim]) {
    if (!seen.has(it.link)) { seen.add(it.link); merged.push(it); }
  }
  return merged;
}

// 상위 N개 키워드를 개별 검색 후 링크 기준 중복제거하여 병합
async function searchNewsMulti(keywords){
  const targets = keywords; // 지정된 키워드 전체를 검색
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
      console.log(`   (검색 실패: "${kw}" - ${e.message.slice(0,300)})`);
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

// Supabase 범용 조회 (perf_meta / perf_data)
async function sbGet(table, id){
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}&select=payload`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    if(!res.ok) return null;
    const rows = await res.json();
    if(!rows[0]?.payload) return null;
    return JSON.parse(rows[0].payload);
  } catch(e){ return null; }
}

// 지표별 실적 컨텍스트 로딩 (달성률·작년실적%). 실적 수치는 로그에 절대 남기지 않음.
// 반환: { 'ceo:P-01': { achRate, lastYearRate, lastYearOwnRate, budgetGrowthPct }, ... }
async function loadPerfContext(){
  const ctx = {};
  const year = new Date().getFullYear();
  for (const ws of ['ceo','inst']) {
    const indicators = await sbGet('perf_meta', `${ws}:meta:indicators`);
    const data = await sbGet('perf_data', `${ws}:data:${year}`);
    if (!indicators) continue;
    for (const ind of indicators) {
      const entry = {};
      try {
        const annualTarget = ind.annualTarget ?? ind.target ?? null;
        const rec = data?.[ind.code];
        // 실적은 actual[월] 객체 → 가장 최근 입력된 월의 누적 실적 사용
        let actual = null;
        if (rec?.actual && typeof rec.actual === 'object') {
          for (let m = 12; m >= 1; m--) {
            const v = rec.actual[m];
            if (v !== null && v !== undefined && v !== '') { actual = parseFloat(v); break; }
          }
        }
        if (actual !== null && annualTarget) {
          entry.achRate = Math.round((actual / annualTarget) * 1000) / 10; // 소수1자리 %
        }
        const hasLastYearActual = ind.lastYearActual !== null && ind.lastYearActual !== undefined;
        const hasLastYearTarget = ind.lastYearTarget !== null && ind.lastYearTarget !== undefined;
        if (hasLastYearActual && hasLastYearTarget) {
          // 작년 예산 규모까지 있으면: 작년 실제 집행률 + 올해 예산 증가율을 정확히 계산
          entry.lastYearOwnRate = Math.round((ind.lastYearActual / ind.lastYearTarget) * 1000) / 10;
          if (annualTarget) {
            entry.budgetGrowthPct = Math.round(((annualTarget - ind.lastYearTarget) / ind.lastYearTarget) * 1000) / 10;
          }
        } else if (hasLastYearActual && annualTarget) {
          // 작년 예산 정보 없으면: 올해 목표 대비로만 근사 (규모 변화는 반영 못함)
          entry.lastYearRate = Math.round((ind.lastYearActual / annualTarget) * 1000) / 10;
        }
      } catch(e){}
      if (entry.achRate !== undefined || entry.lastYearRate !== undefined || entry.lastYearOwnRate !== undefined) {
        ctx[`${ws}:${ind.code}`] = entry;
      }
    }
  }
  return ctx;
}

// 시장지표 로딩 (금리·가격지수 최신값 + 추세)
async function loadMarketContext(){
  const ids = ['base_rate','cd_rate','treasury_3y','mortgage_rate','jeonse_loan','sale_index','jeonse_index'];
  const out = {};
  for (const id of ids) {
    const p = await sbGet('market_stats', `market:${id}`);
    if (p) out[id] = p;
  }
  return out;
}

// Gemini 호출 1회 시도 (내부용, 재시도는 analyzeWithGemini에서 처리)
// [1단계] 검색 그라운딩을 켜고 자유 서술형 조사 결과를 받음 (JSON 아님)
async function callGeminiSearch(prompt){
  geminiCallCount++;
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${GEMINI_API_KEY}`,{
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      contents:[{parts:[{text:prompt}]}],
      tools:[{ google_search:{} }],
      generationConfig:{temperature:0.3, maxOutputTokens:2000}
    })
  });
  if(!res.ok) throw new Error('Gemini(검색): '+await res.text());
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map(p=>p.text).filter(Boolean).join('\n') || '';
  return text.trim();
}

// [2단계] 그라운딩 없이 JSON만 정리 (기존 방식)
async function callGeminiOnce(prompt){
  geminiCallCount++;
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${GEMINI_API_KEY}`,{
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ contents:[{parts:[{text:prompt}]}], generationConfig:{temperature:0.3,maxOutputTokens:3000} })
  });
  if(!res.ok) throw new Error('Gemini: '+await res.text());
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const m = text.match(/\{[\s\S]*\}/);
  if(!m) throw new Error('JSON 파싱 실패 - 원문(앞 500자): ' + (text.slice(0,500) || '(빈 응답, finishReason: ' + (data.candidates?.[0]?.finishReason || '알수없음') + ')'));
  return JSON.parse(m[0]);
}

// 지표별 관련 시장지표 매칭 (해당 지표 분석에 근거로 넣을 것들)
const MARKET_RELEVANCE = {
  'P-01': ['treasury_3y','cd_rate'], 'P-02': ['jeonse_loan','mortgage_rate'],
  'P-03': ['jeonse_index','jeonse_loan'], 'P-04': ['jeonse_index'],
  'P-05-2': [], 'P-09': ['treasury_3y'],
  '1-1': ['jeonse_index','jeonse_loan'], '1-2': ['sale_index','treasury_3y'],
  '2-1': ['sale_index','mortgage_rate'], '2-2': ['jeonse_index'],
  '3-3': ['jeonse_index'], '4-1': ['treasury_3y'], '4-2': [],
  '5': ['jeonse_index','sale_index'], '6': ['mortgage_rate'],
  '7': ['mortgage_rate','jeonse_loan','base_rate'], '8-1': ['treasury_3y'],
};
const MARKET_NAMES = {
  base_rate:'기준금리', cd_rate:'CD금리(91일)', treasury_3y:'국고채(3년)',
  mortgage_rate:'주택담보대출금리', jeonse_loan:'전세자금대출금리',
  sale_index:'매매가격지수', jeonse_index:'전세가격지수',
};

function buildMarketText(code, marketCtx){
  const ids = MARKET_RELEVANCE[code] || [];
  const lines = [];
  for (const id of ids) {
    const m = marketCtx[id];
    if (!m) continue;
    let line = `- ${MARKET_NAMES[id]}: 최신 ${m.value}${m.source==='ecos'?'%':''} (${m.asOf})`;
    if (m.source === 'ecos' && m.change !== null && m.change !== undefined) line += `, ${m.prevLabel} ${m.change>0?'+':''}${m.change}%p`;
    if (m.source === 'reb' && m.momPct !== null && m.momPct !== undefined) line += `, 전월비 ${m.momPct>0?'+':''}${m.momPct}%, 전년비 ${m.yoyPct>0?'+':''}${m.yoyPct}%`;
    lines.push(line);
  }
  return lines.length ? lines.join('\n') : '(직접 연관된 시장지표 없음)';
}

function buildPerfText(perf){
  if (!perf) return '(실적 데이터 없음)';
  const parts = [];
  if (perf.achRate !== undefined) parts.push(`올해 현재 달성률 약 ${perf.achRate}% (연간목표 대비 누적)`);
  if (perf.lastYearOwnRate !== undefined) {
    parts.push(`작년 실제 집행률(자체 예산 대비) 약 ${perf.lastYearOwnRate}%`);
    if (perf.budgetGrowthPct !== undefined) {
      const dir = perf.budgetGrowthPct > 0 ? '증가' : perf.budgetGrowthPct < 0 ? '감소' : '동일';
      parts.push(`올해 예산 규모는 작년 대비 약 ${Math.abs(perf.budgetGrowthPct)}% ${dir}`);
    }
  } else if (perf.lastYearRate !== undefined) {
    parts.push(`작년 실적은 올해 목표의 약 ${perf.lastYearRate}% 수준 (작년 예산 규모 정보 없어 참고용)`);
  }
  return parts.length ? parts.join(' / ') : '(실적 데이터 없음)';
}

async function analyzeWithGemini(name, desc, newsItems, previous, code, marketCtx, perfCtx){
  const newsText = newsItems.length
    ? newsItems.map((n,i)=>`[${i+1}] ${n.title}\n${n.snippet}`).join('\n\n')
    : '최근 1개월간 네이버에서 관련 뉴스를 찾지 못함.';

  const prevText = previous?.analysis
    ? `\n## 지난주 분석 결과\n요약: ${previous.analysis.summary}\n전망: ${previous.analysis.outlook || '(없음)'}\n`
    : '\n## 지난주 분석 결과\n(이전 분석 없음 — 이번이 첫 분석)\n';

  const marketText = buildMarketText(code, marketCtx);
  const perfText = buildPerfText(perfCtx);

  // [1단계] 검색 그라운딩으로 심층 조사 (자유 서술)
  const searchPrompt = `당신은 공공기관 성과관리 애널리스트입니다. 아래 지표와 관련된 최근 1~2개월간의 정책·시장 동향을 Google 검색으로 조사해, 핵심 사실을 6~8줄로 정리하세요.

## 분석 대상 지표
- 지표명: "${name}"
- 지표 설명: ${desc || '(설명 없음)'}

## 참고: 이미 수집된 네이버 뉴스 (추가 조사 시 중복 피하기)
${newsText}

## 조사 지침
- 정부 정책 발표, 제도 변경, 관련 통계 수치(전월/전년 대비 변동)를 우선 조사하세요.
- 이 지표의 실적에 영향을 줄 수 있는 요인을 인과관계 중심으로 파악하세요.
- 확인되지 않은 추측은 배제하고, 검색으로 확인된 사실만 정리하세요.
- 각 줄은 간결한 사실 문장으로 작성하세요 (출처 URL은 생략).`;

  let searchFindings = '';
  try {
    searchFindings = await callGeminiSearch(searchPrompt);
  } catch(e) {
    console.log(`   (검색 그라운딩 실패, 뉴스만으로 진행: ${e.message.slice(0,60)})`);
  }
  const findingsText = searchFindings
    ? `\n## Gemini 심층 조사 결과 (Google 검색 기반)\n${searchFindings}\n`
    : '';

  // [2단계] 종합하여 JSON 정리 (그라운딩 없이)
  const prompt = `당신은 공공기관 성과관리를 지원하는 애널리스트입니다. 아래 정보를 종합해, 성과담당자가 보고서에 바로 인용할 수 있는 사실 중심의 분석을 작성하세요.

## 분석 대상 지표
- 지표명: "${name}"
- 지표 설명: ${desc || '(설명 없음)'}

## 최근 뉴스 (네이버)
${newsText}
${findingsText}
## 실제 시장지표 (한국은행·부동산원 확정 수치)
${marketText}

## 우리 기관 실적 현황 (전망 판단 근거)
${perfText}
${prevText}
## 분석 지침
1. [무관 정보 제외] 이 지표와 직접 관련 없는 내용은 무시하고, 관련 있는 것만 근거로 삼으세요.
2. [방향성 판단] 지표 설명의 "높을수록/낮을수록 좋음"을 기준으로 impact를 판정하세요. 지표 실적에 유리하면 positive, 불리하면 negative, 중립이면 neutral.
3. [수치 우선] 위 시장지표의 실제 수치와 뉴스의 수치를 우선 활용하세요. 수치를 지어내지 마세요.
4. [실적 연계 전망 — 중요] 'outlook'에는 위 '실적 현황'과 외부여건을 연계해 전망하세요. 예: 작년 실제 집행률이 95%였는데 올해 예산이 30% 증가했다면, 절대 집행 부담이 커진 점을 고려해 전망하세요("예산 규모 확대로 집행 부담 증가하나, 작년 집행률 고려 시 무난할 전망" 등). 예산 증가율 정보가 없으면 단순히 목표 대비 작년 수준과 현재 여건만 비교하세요. 달성률 수치를 outlook에 직접 언급해도 됩니다.
5. [변화 추이] 지난주 분석이 있으면 달라진 점을 trend에 반영, 없으면 direction을 "new"로.
6. [문체 — 반드시 준수] 공공기관 보고서 문체(개조식 "~함", "~임", "~됨" 체)로만 작성. "~습니다/~한다/~해요" 금지. "지속적인 모니터링 필요", "귀추가 주목됨" 같은 공허한 표현 금지.
7. [분량 엄수] summary는 2문장·120자 이내, factors description 각 40자 이내, outlook 1~2문장·70자 이내, trend.description 40자 이내.

## 출력 형식
반드시 아래 JSON 형식으로만 응답하세요. 다른 텍스트·마크다운은 절대 포함하지 마세요. 문자열 안 큰따옴표는 \\" 로 이스케이프하세요.
{
  "summary": "2문장, 120자 이내, 보고서체(~함/~임). 외부환경 핵심을 수치와 함께 요약",
  "factors": [
    { "name": "요인명(10자 이내)", "impact": "positive|negative|neutral", "description": "40자 이내, 보고서체" }
  ],
  "outlook": "실적 현황과 외부여건을 연계한 전망, 70자 이내, 보고서체",
  "trend": { "direction": "improving|worsening|stable|new", "description": "지난주 대비 달라진 점, 40자 이내, 보고서체" }
}
factors는 2~4개로 작성하세요.`;

  // 최대 2회 시도
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await callGeminiOnce(prompt);
    } catch(e) {
      lastErr = e;
      if (attempt < 2) {
        console.log(`   (Gemini JSON 정리 1차 실패, 재시도... ${e.message.slice(0,80)})`);
        await sleep(1000);
      }
    }
  }
  throw lastErr;
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
  console.log(`대상: ${INDICATORS.length}개 지표 (네이버 뉴스 + Gemini 검색 + 시장·실적 근거 종합)\n`);

  // 시장지표·실적 컨텍스트 로딩 (실적 수치는 로그에 출력하지 않음)
  const marketCtx = await loadMarketContext();
  const perfCtx = await loadPerfContext();
  console.log(`시장지표 ${Object.keys(marketCtx).length}종, 실적 컨텍스트 ${Object.keys(perfCtx).length}개 지표 로딩 완료\n`);

  const targets = TEST_MODE ? INDICATORS.slice(0, 3) : INDICATORS;
  console.log(TEST_MODE ? '🧪 테스트 모드: 앞 3개 지표만 실행\n' : '');
  let ok=0, fail=0;
  for(const ind of targets){
    try{
      process.stdout.write(`[${ind.code}] ${ind.name}...`);
      const news = await searchNewsMulti(ind.keywords);
      const previous = await fetchPreviousAnalysis(ind.ws, ind.code);
      await sleep(300);
      const analysis = await analyzeWithGemini(ind.name, ind.desc, news, previous, ind.code, marketCtx, perfCtx[`${ind.ws}:${ind.code}`]);
      await sleep(1000);
      await saveToSupabase(ind.ws, ind.code, analysis, news);
      console.log(` ✅ (뉴스 ${news.length}건${previous?', 전주비교 O':', 첫분석'})`);
      ok++;
    }catch(e){
      console.log(` ❌ ${e.message.slice(0,600)}`);
      fail++;
    }
    await sleep(500);
  }
  console.log(`\n완료 — 성공 ${ok}, 실패 ${fail}`);
  console.log(`API 사용량 — 네이버 뉴스 검색: ${searchCallCount}회(한도 25,000/일), Gemini: ${geminiCallCount}회(한도 1500/일)`);
  if(fail>0 && ok===0) process.exit(1);
})();
