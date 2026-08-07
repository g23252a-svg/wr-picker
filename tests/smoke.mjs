import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const statsSource=fs.readFileSync(new URL('../stats.js',import.meta.url),'utf8');
const sw=fs.readFileSync(new URL('../sw.js',import.meta.url),'utf8');
const manifest=JSON.parse(fs.readFileSync(new URL('../manifest.webmanifest',import.meta.url),'utf8'));

// Inline application code must at least compile in a modern browser runtime.
const inlineScripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]).filter(Boolean);
assert.equal(inlineScripts.length,1,'expected one inline application script');
new Function(inlineScripts[0]);
new Function(sw);

// Load the isolated snapshot without a DOM and validate every metric.
const context={window:{}};
vm.runInNewContext(statsSource,context,{filename:'stats.js'});
const meta=context.window.WR_STATS_META;
const stats=context.window.WR_ROLE_STATS;
const prevStats=context.window.WR_ROLE_STATS_PREV;
const rows=Object.values(stats).flatMap(roles=>Object.entries(roles));
const ROLES=['top','jug','mid','adc','sup'];
const isDate=s=>/^\d{4}-\d{2}-\d{2}$/.test(s||'');
// stats.js is regenerated daily by scripts/fetch-stats.mjs, so assert invariants
// and internal consistency rather than any particular patch's numbers.
assert.match(meta.patch,/^\d+\.\d+[a-z]?$/,'unexpected patch format');
assert.ok(isDate(meta.capturedAt),'capturedAt must be YYYY-MM-DD');
assert.equal(meta.source,'https://www.wildriftfire.com/stats');
assert.equal(meta.region,'CN');
assert.equal(Object.keys(stats).length,meta.champions,'champion count out of sync with meta');
assert.equal(rows.length,meta.rows,'row count out of sync with meta');
assert.ok(rows.length>=120,`suspiciously few role rows: ${rows.length}`);
assert.ok(Object.keys(prevStats).length>0,'trend baseline is empty');
assert.ok(isDate(meta.prevCapturedAt),'prevCapturedAt must be YYYY-MM-DD');
assert.ok(meta.prevCapturedAt<meta.capturedAt,'trend baseline must predate the snapshot');
const allRows=rows.concat(Object.values(prevStats).flatMap(roles=>Object.entries(roles)));
for(const [role,s] of allRows){
  assert.ok(ROLES.includes(role),`invalid role ${role}`);
  for(const metric of ['win','pick','ban'])
    assert.ok(Number.isFinite(s[metric])&&s[metric]>=0&&s[metric]<=100,`invalid ${metric} rate`);
}
// Win rates should straddle 50% — a one-sided table means the parse grabbed the wrong column.
assert.ok(rows.some(([,s])=>s.win>50)&&rows.some(([,s])=>s.win<50),'win rates are one-sided');
// Trend deltas must be computable for champions present in both snapshots.
let overlap=0;
for(const [name,roles] of Object.entries(stats))
  for(const role of Object.keys(roles))
    if(prevStats[name]&&prevStats[name][role]){
      overlap++;
      assert.ok(Number.isFinite(prevStats[name][role].win),`bad prev row ${name}/${role}`);
    }
assert.ok(overlap>=100,`too little trend overlap: ${overlap}`);

// The runtime payload must stay in step with the bundled fallback.
const latest=JSON.parse(fs.readFileSync(new URL('../data/latest.json',import.meta.url),'utf8'));
assert.equal(latest.patch,meta.patch);
assert.equal(latest.updated,meta.capturedAt);
assert.ok(latest.brackets&&latest.brackets.diamond,'latest.json missing the diamond bracket');
for(const [key,b] of Object.entries(latest.brackets)){
  assert.ok(b.stats&&Object.keys(b.stats).length,`bracket ${key} has no stats`);
  assert.equal(Object.values(b.stats).flatMap(r=>Object.keys(r)).length,b.rows,`bracket ${key} row count`);
  for(const roles of Object.values(b.stats))
    for(const role of Object.keys(roles))assert.ok(ROLES.includes(role),`bracket ${key} invalid role ${role}`);
}
assert.equal(
  Object.values(latest.brackets.diamond.stats).flatMap(r=>Object.keys(r)).length,
  rows.length,'bundled snapshot and latest.json disagree on Diamond+ rows');

// Evaluate the champion table, check stable identifiers and snapshot coverage.
const cStart=html.indexOf('const C=')+'const C='.length;
const cEnd=html.indexOf('\n];',cStart)+3;
assert.ok(cStart>0&&cEnd>cStart,'champion database block not found');
const champions=Function(`return ${html.slice(cStart,cEnd)}`)();
assert.equal(champions.length,141);
const names=champions.map(row=>row[1]);
assert.equal(new Set(names).size,names.length,'duplicate champion name');
for(const name of Object.keys(stats))assert.ok(names.includes(name),`stats champion missing from DB: ${name}`);
const stableId=name=>{let h=0x811c9dc5;for(let i=0;i<name.length;i++){h^=name.charCodeAt(i);h=Math.imul(h,0x01000193);}return (h>>>0)||1;};
assert.equal(new Set(names.map(stableId)).size,names.length,'stable champion ID collision');

// Static app-shell integrity.
const ids=[...html.matchAll(/\sid="([^"]+)"/g)].map(m=>m[1]).filter(id=>!id.includes('$'));
assert.equal(new Set(ids).size,ids.length,'duplicate static HTML id');
assert.ok(!/user-scalable\s*=\s*no|maximum-scale\s*=\s*1/i.test(html),'viewport disables zoom');
assert.ok(html.includes('aria-live="polite"'));
assert.ok(html.includes("const APP_VERSION='8.4.0'"));
assert.ok(html.includes('function reliabilityOf(pick)'));
assert.ok(html.includes('function trendOf(c'));
assert.ok(html.includes('async function refreshStats()'),'runtime stat refresh missing');
assert.ok(html.includes("const DATA_ENDPOINT="),'data endpoint missing');
assert.ok(html.includes('id="decisionSummary"'));
assert.ok(html.includes('상대 칩 이름을 탭하면'),'laner-mark hint missing');
assert.ok(html.includes('function banSuggestions()'),'ban advice engine missing');
assert.ok(html.includes('id="banAdvice"'),'ban advice container missing');
assert.ok(html.includes('id="bracketSel"'),'bracket selector missing');
assert.ok(html.includes("wr_bracket"),'bracket persistence missing');
assert.ok(html.includes('payload.prev.brackets[key]')&&!html.includes('payload.prev.brackets.diamond'),
  'trend baseline must be same-bracket only');
// v5.2 리뷰에서 확정된 결함의 회귀 가드
assert.ok(html.includes('function sanitizeStatsPayload('),'remote payload sanitizer missing');
assert.ok(html.includes('[hidden]{display:none!important}'),'[hidden] must beat author display:flex');
assert.ok(html.includes('mainIds.has(c.id)'),'ban advice must not suggest banning own mains');
assert.ok(!/bsel\.innerHTML/.test(html),'bracket selector must be DOM-built, not innerHTML');
assert.ok(html.includes('data-banid'),'ban advice focus restoration missing');
assert.ok(html.includes('class="chip.marked') || /chip\.marked|chip'\+\(marked/.test(html),'marked chip state missing');
assert.ok(sw.includes("pathname.includes('/data/')"),'service worker must bypass cache for stat data');
assert.equal(manifest.id,'./index.html');
assert.ok(manifest.display_override.includes('standalone'));
for(const asset of ['./index.html','./stats.js','./manifest.webmanifest','./icon.svg'])assert.ok(sw.includes(`'${asset}'`),`service worker missing ${asset}`);

// [v7] 개인 성과 학습 — 승패 단독 학습으로 되돌아가지 않도록 고정.
assert.ok(html.includes('const PERF='),'performance grade table missing');
assert.ok(html.includes('function perfValue('),'performance value fn missing');
assert.ok(/svp:\{[^}]*v:0\.\d+/.test(html),'SVP grade missing');
assert.ok(html.includes('function playCount('),'play count fn missing');
assert.ok(html.includes('id="perfBtns"'),'performance buttons missing');
assert.ok(html.includes('function parseKDA('),'KDA parser missing');
assert.ok(html.includes('const SCHEMA_VERSION=5'),'schema must be bumped for perf/kda');
// 메타 모드가 숙련을 완전히 0으로 만들면 매판 새 챔을 추천하게 된다(챔 churn 회귀).
assert.ok(!/recMode==='meta'\)\s*\?\s*0\s*:/.test(html),'meta mode must not zero out mastery weight');
assert.ok(/recMode==='meta'\)\s*\?\s*W\.comfort\*/.test(html),'meta mode comfort floor missing');
// [v8] 숙련도는 실측이 주도한다 — 수동 설정은 사전값일 뿐.
assert.ok(html.includes('function effectiveComfort('),'measured/manual comfort blend missing');
assert.ok(html.includes('function kdaValue('),'KDA signal missing');
assert.ok(/perfValue\(m\)\{[\s\S]{0,400}kdaValue/.test(html),'perfValue must use KDA');
// 승리는 성과가 나빠도 깎이면 안 된다(하한 보장), 패배는 성과가 좋으면 올라가야 한다.
assert.ok(/m\.won\?Math\.max\(outcome,blend\):blend/.test(html),
  'a win must never score below its outcome value');
// [v8.1] 라인전 사거리 — 와일드리프트는 라인전 비중이 커서 같은 원거리끼리도 갈린다.
assert.ok(html.includes('const REACH='),'reach table missing');
assert.ok(html.includes('function reachOf('),'reachOf missing');
assert.ok(/'Orianna':2/.test(html)&&/'Kennen':0/.test(html),'key reach entries missing');
assert.ok(html.includes('사거리 열세로 견제 손해'),'reach disadvantage note missing');
const reachSrc=html.match(/const REACH=\{[\s\S]*?\n\};/);
assert.ok(reachSrc,'REACH block not parseable');
const reach=Function(`return ${reachSrc[0].replace('const REACH=','').replace(/;$/,'')}`)();
for(const n of Object.keys(reach))assert.ok(names.includes(n),`REACH champion not in roster: ${n}`);
for(const v of Object.values(reach))assert.ok([0,1,2].includes(v),'reach tier must be 0/1/2');
// [v8.1] 팀 문제로 진 판은 챔피언 평가에서 중립 처리한다.
assert.ok(html.includes('function isUncontrolled('),'team-issue predicate missing');
assert.ok(html.includes('id="teamIssueBtn"'),'team-issue button missing');
assert.ok(/isUncontrolled\(m\)&&!m\.won/.test(html),'only losses may be neutralised');
assert.ok(html.includes('teamIssue'),'teamIssue must persist on records');
// [v8.2] 목표 설정 — '전 포지션 숙련'이면 라인을 버리라는 조언을 하지 않는다.
assert.ok(html.includes("next.goal='allround'"),'goal setting missing');
assert.ok(html.includes('function setGoal('),'goal toggle missing');
assert.ok(html.includes('라인이 아니라 챔 문제입니다'),'allround advice missing');
assert.ok(html.includes('주력을 좁히세요'),'lane-narrowing advice missing');
assert.ok(html.includes('const topP=')&&html.includes('const subP='),'Korean particle helpers missing');
assert.ok(!/\$\{LANEKR\[[^\]]+\]\}(는|가) /.test(html),'hardcoded Korean particle after lane name');
// [v8.3] 전술 브리핑 — 가이드 원문 요약을 앱에서 보여준다.
assert.ok(html.includes('function tacticsPanel('),'tactics panel missing');
assert.ok(html.includes('async function loadGuides()'),'guide loader missing');
assert.ok(html.includes('function situationalTips('),'situational tips missing');
assert.ok(html.includes('GUIDE_BASE'),'guide link base missing');
// slug는 URL에 들어가므로 정제되어야 한다.
assert.ok(/\/\^\[a-z0-9-\]\{2,40\}\$\//.test(html),'guide slug must be validated');
const guides=JSON.parse(fs.readFileSync(new URL('../data/guides.json',import.meta.url),'utf8'));
assert.ok(guides.champions&&Object.keys(guides.champions).length>=100,'guides.json too small');
for(const [name,g] of Object.entries(guides.champions)){
  assert.ok(names.includes(name),`guide champion not in roster: ${name}`);
  assert.match(g.slug,/^[a-z0-9-]{2,40}$/,`bad guide slug: ${name}`);
  for(const rel of [].concat(g.counteredBy||[],g.synergy||[]))
    assert.match(rel.slug,/^[a-z0-9-]{2,40}$/,`bad related slug in ${name}`);
}
assert.ok(sw.includes("'./data/guides.json'"),'guides must be precached for offline');
// [v8.4] 가이드가 명시한 상성이 클래스 추정보다 우선한다.
assert.ok(html.includes('function guideMatchup('),'guide matchup missing');
assert.ok(html.includes('가이드 상성'),'guide matchup note missing');
assert.ok(/a=Math\.round\(a\*0\.5\)/.test(html),'class-matrix guess must be damped when real data exists');
assert.ok(html.includes('접근만 하면 유리하나 진입이 어려움'),'melee-vs-long-reach dive gate missing');
// 가이드 카운터 데이터가 실제로 로스터 챔피언을 가리켜야 쓸모가 있다.
const slugToName={};
for(const [n,g] of Object.entries(guides.champions))slugToName[g.slug]=n;
let resolvable=0,total=0;
for(const g of Object.values(guides.champions))
  for(const rel of (g.counteredBy||[])){total++;if(slugToName[rel.slug])resolvable++;}
assert.ok(total>=200,`too few counter relations: ${total}`);
assert.ok(resolvable/total>=0.9,`counter slugs mostly unresolvable: ${resolvable}/${total}`);
// 수동 comfort가 실측을 덮어쓰는 옛 구조로 되돌아가면 안 된다.
assert.ok(!/const comfort = manualC \|\| autoC/.test(html),'manual comfort must not override measured');
assert.ok(/effectiveComfort\(cand\.id\)/.test(html),'score() must use effectiveComfort');
// 탐색을 막지 않는다: 첫 픽에 점수 감점 없음(배지는 유지).
assert.ok(/const FIRST_PICK_PENALTY=0/.test(html),'first pick must not be penalized (exploration)');
assert.ok(html.includes('const familiarity = 0'),'familiarity penalty must be neutral');
assert.ok(html.includes('bd-first'),'first-pick badge should remain informational');
// 자동 백업 실패 원인을 구분해야 사용자가 빠져나올 수 있다.
assert.ok(html.includes('autoBackupError'),'auto-backup error cause missing');
assert.ok(html.includes("NotFoundError"),'file-missing case must be distinguished');
assert.ok(/resumeAutoBackup\(\)\{[\s\S]{0,500}enableAutoBackup\(\)/.test(html),
  'failed reconnect must offer picking a new file');
// 분석 탭 — 소표본 오진을 막는 유의성 판정이 핵심이므로 고정한다.
assert.ok(html.includes('function analysisModel()'),'analysis model missing');
assert.ok(html.includes('function renderAnalysis()'),'analysis renderer missing');
assert.ok(html.includes('function binomAtMost('),'significance test missing');
assert.ok(html.includes('id="tabAna"')&&html.includes('id="tabRec"'),'log tabs missing');
assert.ok(html.includes('MIN_BUCKET'),'small-sample gating missing');
assert.ok(!/expRows|staleBox|seenN/.test(html),'dead analysis code left in records tab');
// 자동 백업 — 전적이 기기에 갇히지 않도록 하는 경로
assert.ok(html.includes('async function autoBackupWrite('),'auto-backup writer missing');
assert.ok(html.includes('showSaveFilePicker'),'file handle picker missing');
assert.ok(html.includes('async function restoreAutoBackup('),'auto-backup handle restore missing');
assert.ok(html.includes('function backupPayload()'),'shared backup payload missing');
assert.ok(html.includes('async function copyBackup()'),'clipboard fallback missing');
assert.ok(/saveMatches\(\)\{[\s\S]{0,1200}autoBackupWrite/.test(html),'saveMatches must sync auto-backup');
/* 데이터 보호 — 과거 전적이 조용히 사라지는 경로를 막는 가드.
   각 항목은 실제로 존재했던 손실 경로에 대응한다. */
assert.ok(html.includes('function mergeMatches('),'match merge missing');
// 복원이 통째로 덮어쓰면 그 뒤에 쌓인 판이 전부 사라진다.
assert.ok(!/matches=d\.matches\.map\(migrateMatch\)/.test(html),'import must merge, not replace');
assert.ok(/const \{merged,added\}=mergeMatches\(matches,incoming\)/.test(html),'import must use merge');
// 챔피언 ID를 못 찾아도 판을 버리지 않는다.
assert.ok(html.includes('out.pickRaw=m.pick'),'unresolved picks must be preserved');
assert.ok(!/const pick=toStableId\(m\.pick\);\s*if\(pick==null\)return null;/.test(html),
  'migrateMatch must not drop matches with unknown champions');
// 파괴적 작업 전 스냅샷 + 되돌리기
assert.ok(html.includes('async function snapshotBeforeDestructive('),'destructive snapshot missing');
assert.ok(html.includes('async function rollbackRestore('),'rollback missing');
assert.ok(/clearMatches\(\)\{[\s\S]{0,600}snapshotBeforeDestructive/.test(html),'clear must snapshot first');
// 저장 실패를 조용히 삼키면 안 된다.
assert.ok(html.includes('saveFailed=true'),'save failure must be surfaced');
assert.ok(html.includes('id="storageWarn"'),'storage warning banner missing');
// 시드는 병합만 한다.
assert.ok(/seedHistoryIfEmpty\(\)\{[\s\S]{0,900}mergeMatches/.test(html),'seed must merge, not overwrite');

// [v6] 상성 엔진 — 기동 메이지(아리류)의 암살자 역카운터 회귀 방지.
assert.ok(html.includes('const escK='),'assassin escape-adjust rule missing');
assert.ok(/'Ahri':\{[^}]*mob:2/.test(html),'Ahri mobility kit missing');
const pairSrc=html.match(/const PAIR=\{[\s\S]*?\n\};/);
assert.ok(pairSrc,'PAIR table missing');
const pair=Function(`return ${pairSrc[0].replace('const PAIR=','').replace(/;$/,'')}`)();
assert.ok((pair.Ahri||{}).Talon>=4,'Ahri>Talon famous matchup missing');
// PAIR의 모든 키·상대가 실제 로스터에 존재해야 함 (오타·삭제 챔 방지).
for(const [a,opps] of Object.entries(pair)){
  assert.ok(names.includes(a),`PAIR key not in roster: ${a}`);
  for(const b of Object.keys(opps))assert.ok(names.includes(b),`PAIR opponent not in roster: ${a}>${b}`);
}
assert.ok(html.includes('상대 기동성에 접근 무효'),'dive-vs-mobile gating missing');

console.log(`WR Picker smoke tests passed: ${champions.length} champions, ${rows.length} role rows.`);
