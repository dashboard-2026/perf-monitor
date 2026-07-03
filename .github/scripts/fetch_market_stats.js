/**
 * 시장 통계(금리·가격지수) 수집 스크립트
 * 한국은행 ECOS + 한국부동산원 R-ONE API를 호출해 최신 수치를 가져와
 * Supabase market_stats 테이블에 저장한다.
 * GitHub Actions에서 analyze_indicators.js와 함께 주 1회 자동 실행됨.
 */

const ECOS_KEY  = process.env.ECOS_API_KEY;
const REB_KEY    = process.env.REB_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// ── 수집 대상 정의 ────────────────────────────────────────────
// 한국은행(ECOS): 통계표코드 + 항목코드, 일/월 데이터
const ECOS_STATS = [
  { id:'base_rate',    name:'한국은행 기준금리',      statCode:'722Y001', itemCode:'0101000',    period:'D', unit:'%' },
  { id:'cd_rate',       name:'CD금리(91일)',           statCode:'817Y002', itemCode:'010502000',  period:'D', unit:'%' },
  { id:'treasury_3y',   name:'국고채(3년)',            statCode:'817Y002', itemCode:'010200000',  period:'D', unit:'%' },
  { id:'mortgage_rate', name:'주택담보대출 금리',      statCode:'121Y006', itemCode:'BECBLA0302', period:'M', unit:'%' },
  { id:'jeonse_loan',   name:'전세자금대출 금리',      statCode:'121Y006', itemCode:'BECBLA03041',period:'M', unit:'%' },
];

// 한국부동산원(R-ONE): 통계표ID + 항목코드 + 지역코드(전국), 월별 지수
const REB_STATS = [
  { id:'sale_index',   name:'매매가격지수(전국)', statblId:'A_2024_00016', itemCode:'100001', regionCode:'500001' },
  { id:'jeonse_index', name:'전세가격지수(전국)', statblId:'A_2024_00019', itemCode:'100001', regionCode:'500001' },
];

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function yyyymmdd(d){ return d.toISOString().slice(0,10).replace(/-/g,''); }
function yyyymm(d){ return d.toISOString().slice(0,7).replace('-',''); }

// ── 한국은행 ECOS 조회 ───────────────────────────────────────
// 최근 60일(일별) 또는 최근 6개월(월별) 데이터를 가져와 최신값 + 비교값을 계산
async function fetchEcosStat(stat){
  const end = new Date();
  const start = new Date();
  let startStr, endStr;
  if (stat.period === 'D') {
    start.setDate(start.getDate() - 60);
    startStr = yyyymmdd(start); endStr = yyyymmdd(end);
  } else {
    start.setMonth(start.getMonth() - 6);
    startStr = yyyymm(start); endStr = yyyymm(end);
  }

  const url = `https://ecos.bok.or.kr/api/StatisticSearch/${ECOS_KEY}/json/kr/1/100/${stat.statCode}/${stat.period}/${startStr}/${endStr}/${stat.itemCode}`;
  const res = await fetch(url);
  if(!res.ok) throw new Error(`ECOS HTTP ${res.status}`);
  const data = await res.json();

  if (data.RESULT) throw new Error(`ECOS: ${data.RESULT.MESSAGE || data.RESULT.CODE}`);
  const rows = data.StatisticSearch?.row;
  if (!rows || rows.length === 0) throw new Error('ECOS: 데이터 없음');

  // TIME 기준 오름차순 정렬 후 최신값 추출
  rows.sort((a,b) => a.TIME.localeCompare(b.TIME));
  const latest = rows[rows.length - 1];
  const latestValue = parseFloat(latest.DATA_VALUE);

  // 비교 기준값 찾기: 일별이면 "1주 전과 가장 가까운 값", 월별이면 "1개월 전", "1년 전"
  function findClosest(targetDate) {
    let best = null, bestDiff = Infinity;
    for (const r of rows) {
      const rDate = stat.period === 'D'
        ? new Date(`${r.TIME.slice(0,4)}-${r.TIME.slice(4,6)}-${r.TIME.slice(6,8)}`)
        : new Date(`${r.TIME.slice(0,4)}-${r.TIME.slice(4,6)}-01`);
      const diff = Math.abs(rDate - targetDate);
      if (diff < bestDiff) { bestDiff = diff; best = r; }
    }
    return best ? parseFloat(best.DATA_VALUE) : null;
  }

  const latestDate = stat.period === 'D'
    ? new Date(`${latest.TIME.slice(0,4)}-${latest.TIME.slice(4,6)}-${latest.TIME.slice(6,8)}`)
    : new Date(`${latest.TIME.slice(0,4)}-${latest.TIME.slice(4,6)}-01`);

  let prevValue = null, prevLabel = '';
  if (stat.period === 'D') {
    const weekAgo = new Date(latestDate); weekAgo.setDate(weekAgo.getDate() - 7);
    prevValue = findClosest(weekAgo);
    prevLabel = '전주 대비';
  } else {
    const monthAgo = new Date(latestDate); monthAgo.setMonth(monthAgo.getMonth() - 1);
    prevValue = findClosest(monthAgo);
    prevLabel = '전월 대비';
  }

  return {
    id: stat.id, name: stat.name, unit: stat.unit,
    value: latestValue, asOf: latest.TIME,
    prevValue, prevLabel,
    change: prevValue !== null ? +(latestValue - prevValue).toFixed(3) : null,
  };
}

// ── 한국부동산원 R-ONE 조회 ──────────────────────────────────
async function fetchRebStat(stat){
  const url = `https://www.reb.or.kr/r-one/openapi/SttsApiTblData.do?KEY=${REB_KEY}&Type=json&pIndex=1&pSize=24&STATBL_ID=${stat.statblId}&DTACYCLE_CD=MM&CLS_ID=${stat.itemCode}&ITM_ID=${stat.regionCode}`;
  const res = await fetch(url);
  if(!res.ok) throw new Error(`REB HTTP ${res.status}`);
  const data = await res.json();

  const body = data?.SttsApiTblData?.[1]?.row;
  if (!body || body.length === 0) throw new Error('REB: 데이터 없음 - ' + JSON.stringify(data).slice(0,200));

  // WRTTIME_DESC(예: "2026.05") 기준 오름차순 정렬
  body.sort((a,b) => (a.WRTTIME_IDTFR_ID||'').localeCompare(b.WRTTIME_IDTFR_ID||''));
  const latest = body[body.length - 1];
  const latestValue = parseFloat(latest.DTA_VAL);
  const latestTime = latest.WRTTIME_IDTFR_ID;

  function findByOffset(offsetMonths) {
    const [y, m] = [parseInt(latestTime.slice(0,4)), parseInt(latestTime.slice(4,6))];
    const target = new Date(y, m - 1 - offsetMonths, 1);
    const targetStr = `${target.getFullYear()}${String(target.getMonth()+1).padStart(2,'0')}`;
    const row = body.find(r => r.WRTTIME_IDTFR_ID === targetStr);
    return row ? parseFloat(row.DTA_VAL) : null;
  }

  const prevMonth = findByOffset(1);
  const prevYear = findByOffset(12);

  return {
    id: stat.id, name: stat.name, unit: '',
    value: latestValue, asOf: latestTime,
    momChange: prevMonth !== null ? +(latestValue - prevMonth).toFixed(2) : null,
    momPct: prevMonth !== null ? +(((latestValue - prevMonth) / prevMonth) * 100).toFixed(2) : null,
    yoyChange: prevYear !== null ? +(latestValue - prevYear).toFixed(2) : null,
    yoyPct: prevYear !== null ? +(((latestValue - prevYear) / prevYear) * 100).toFixed(2) : null,
  };
}

// ── Supabase 저장 ────────────────────────────────────────────
async function saveToSupabase(id, payload){
  const res = await fetch(`${SUPABASE_URL}/rest/v1/market_stats`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer': 'resolution=merge-duplicates',
    },
    body: JSON.stringify({ id, payload: JSON.stringify(payload) }),
  });
  if(!res.ok) throw new Error('Supabase: ' + await res.text());
}

// ── 메인 실행 ────────────────────────────────────────────────
(async () => {
  console.log(`\n📊 시장 통계 수집 시작 — ${new Date().toLocaleString('ko-KR')}\n`);
  let ok = 0, fail = 0;
  const updatedAt = new Date().toISOString();

  for (const stat of ECOS_STATS) {
    try {
      process.stdout.write(`[한국은행] ${stat.name}...`);
      const result = await fetchEcosStat(stat);
      await saveToSupabase('market:' + stat.id, { ...result, source:'ecos', updatedAt });
      console.log(` ✅ ${result.value}${result.unit} (${result.asOf})`);
      ok++;
    } catch(e) {
      console.log(` ❌ ${e.message.slice(0,200)}`);
      fail++;
    }
    await sleep(500);
  }

  for (const stat of REB_STATS) {
    try {
      process.stdout.write(`[부동산원] ${stat.name}...`);
      const result = await fetchRebStat(stat);
      await saveToSupabase('market:' + stat.id, { ...result, source:'reb', updatedAt });
      console.log(` ✅ ${result.value} (${result.asOf})`);
      ok++;
    } catch(e) {
      console.log(` ❌ ${e.message.slice(0,200)}`);
      fail++;
    }
    await sleep(500);
  }

  console.log(`\n완료 — 성공 ${ok}, 실패 ${fail}`);
  if (fail > 0 && ok === 0) process.exit(1);
})();
