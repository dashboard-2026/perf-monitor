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

  // 그래프용 시계열: 일별이면 월말값으로 압축, 월별이면 그대로 → 최근 12포인트
  function buildSeries() {
    let points;
    if (stat.period === 'D') {
      // 월별 마지막 값만 추출
      const byMonth = {};
      for (const r of rows) {
        const ym = r.TIME.slice(0,6);
        byMonth[ym] = parseFloat(r.DATA_VALUE); // 정렬돼 있어 마지막이 월말값
      }
      points = Object.keys(byMonth).sort().map(ym => ({ t: ym, v: byMonth[ym] }));
    } else {
      points = rows.map(r => ({ t: r.TIME, v: parseFloat(r.DATA_VALUE) }));
    }
    return points.slice(-12); // 최근 12포인트
  }

  return {
    id: stat.id, name: stat.name, unit: stat.unit,
    value: latestValue, asOf: latest.TIME,
    prevValue, prevLabel,
    change: prevValue !== null ? +(latestValue - prevValue).toFixed(3) : null,
    series: buildSeries(),
  };
}

// ── 한국부동산원 R-ONE 조회 ──────────────────────────────────
async function fetchRebStat(stat){
  // 선택 파라미터(CLS_ID/ITM_ID/GRP_ID)는 통계표마다 체계가 달라 확신할 수 없으므로
  // 필수 파라미터만으로 최근 13개월치 전체를 받아온 뒤, "전국" 항목을 코드에서 걸러낸다.
  // 이 통계표는 지역·유형별로 행이 매우 많아 1페이지(1000건)로는 부족할 수 있어 여러 페이지를 이어 받는다.
  const end = new Date();
  const start = new Date(); start.setMonth(start.getMonth() - 13);
  const startStr = `${start.getFullYear()}${String(start.getMonth()+1).padStart(2,'0')}`;
  const endStr = `${end.getFullYear()}${String(end.getMonth()+1).padStart(2,'0')}`;

  const PAGE_SIZE = 1000;
  const MAX_PAGES = 10; // 최대 10,000건까지 확보
  let body = [];
  for (let pIndex = 1; pIndex <= MAX_PAGES; pIndex++) {
    const url = `https://www.reb.or.kr/r-one/openapi/SttsApiTblData.do?KEY=${REB_KEY}&Type=json&pIndex=${pIndex}&pSize=${PAGE_SIZE}&STATBL_ID=${stat.statblId}&DTACYCLE_CD=MM&START_WRTTIME=${startStr}&END_WRTTIME=${endStr}`;
    const res = await fetch(url);
    if(!res.ok) throw new Error(`REB HTTP ${res.status}`);
    const data = await res.json();
    const page = data?.SttsApiTblData?.[1]?.row;
    if (!page || page.length === 0) break; // 더 이상 데이터 없음
    body = body.concat(page);
    if (page.length < PAGE_SIZE) break; // 마지막 페이지
    await sleep(200);
  }
  if (body.length === 0) throw new Error('REB: 데이터 없음');
  console.log(`   (참고: ${stat.name} 총 ${body.length}건 수신)`);

  // "전국"이 포함된 항목만 필터링 (CLS_NM, ITM_NM, GRP_NM 중 어디에 있을지 몰라 모두 확인)
  const nationwide = body.filter(r =>
    (r.CLS_NM && r.CLS_NM.includes('전국')) ||
    (r.ITM_NM && r.ITM_NM.includes('전국')) ||
    (r.GRP_NM && r.GRP_NM.includes('전국'))
  );
  const rows = nationwide.length > 0 ? nationwide : body; // 전국 필터링 실패 시 전체 사용(디버깅용)
  if (nationwide.length === 0) {
    console.log(`   (참고: "전국" 필터 매칭 0건, 전체 ${body.length}건 중 첫 행 샘플: ${JSON.stringify(body[0]).slice(0,300)})`);
  } else {
    const months = [...new Set(nationwide.map(r => r.WRTTIME_IDTFR_ID))].sort();
    console.log(`   (참고: "전국" 매칭 ${nationwide.length}건, 확보된 월: ${months[0]}~${months[months.length-1]})`);
  }

  rows.sort((a,b) => (a.WRTTIME_IDTFR_ID||'').localeCompare(b.WRTTIME_IDTFR_ID||''));
  const latest = rows[rows.length - 1];
  const latestValue = parseFloat(latest.DTA_VAL);
  const latestTime = latest.WRTTIME_IDTFR_ID;

  function findByOffset(offsetMonths) {
    const [y, m] = [parseInt(latestTime.slice(0,4)), parseInt(latestTime.slice(4,6))];
    const target = new Date(y, m - 1 - offsetMonths, 1);
    const targetStr = `${target.getFullYear()}${String(target.getMonth()+1).padStart(2,'0')}`;
    const row = rows.find(r => r.WRTTIME_IDTFR_ID === targetStr);
    return row ? parseFloat(row.DTA_VAL) : null;
  }

  const prevMonth = findByOffset(1);
  const prevYear = findByOffset(12);

  // 그래프용 시계열: 최근 12개월
  const series = rows.slice(-12).map(r => ({ t: r.WRTTIME_IDTFR_ID, v: +parseFloat(r.DTA_VAL).toFixed(3) }));

  return {
    id: stat.id, name: stat.name, unit: '',
    value: +latestValue.toFixed(3), asOf: latestTime,
    momChange: prevMonth !== null ? +(latestValue - prevMonth).toFixed(2) : null,
    momPct: prevMonth !== null ? +(((latestValue - prevMonth) / prevMonth) * 100).toFixed(2) : null,
    yoyChange: prevYear !== null ? +(latestValue - prevYear).toFixed(2) : null,
    yoyPct: prevYear !== null ? +(((latestValue - prevYear) / prevYear) * 100).toFixed(2) : null,
    series,
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
