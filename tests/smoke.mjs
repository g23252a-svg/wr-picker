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
assert.ok(html.includes("const APP_VERSION='10.0.0'"));
assert.ok(html.includes('function reliabilityOf(pick)'));
assert.ok(html.includes('function trendOf(c'));
assert.ok(html.includes('async function refreshStats()'),'runtime stat refresh missing');
assert.ok(html.includes("const DATA_ENDPOINT="),'data endpoint missing');
assert.ok(html.includes('id="decisionSummary"'));
assert.ok(html.includes('상대 칩 이름 탭'),'laner-mark hint missing');
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
/* 승리는 성과가 나빠도 깎이면 안 되고(하한 보장), 패배는 성과가 좋으면 올라가야 한다.
   문자열 매칭 대신 perfValue를 실제로 실행해서 확인한다 — v9.1까지는 정규식이
   통과하는데도 이긴 판의 '잘함'이 아무 효과가 없었다(하한이 상한 노릇을 했다). */
{
  const pvSrc=html.match(/function perfValue\(m\)\{[\s\S]*?\n\}/);
  assert.ok(pvSrc,'perfValue block not extractable');
  const perfSrc=html.match(/const PERF=\{[\s\S]*?\n\};/);
  const kdaSrc=html.match(/function kdaValue\(k\)\{[\s\S]*?\n\}/);
  const perfValue=Function('clamp',
    `${perfSrc[0]}\n${kdaSrc[0]}\n${pvSrc[0]}\nreturn perfValue;`)((v,a,b)=>Math.max(a,Math.min(b,v)));
  const plainWin=perfValue({won:true}), plainLoss=perfValue({won:false});
  assert.ok(plainWin>plainLoss,'a win must outrank a loss');
  for(const g of ['mvp','svp','good','ok','bad']){
    assert.ok(perfValue({won:true,perf:g})>=plainWin-1e-9,
      `grading a win as ${g} must never drop below a plain win`);
    assert.ok(perfValue({won:false,perf:g})<=perfValue({won:false,perf:'mvp'})+1e-9,
      `loss grade ${g} must not exceed the best grade`);
  }
  // 이긴 판에서도 '잘함' 이상은 반드시 점수를 올려야 한다 — 무효 입력 회귀 방지.
  for(const g of ['good','svp','mvp'])
    assert.ok(perfValue({won:true,perf:g})>plainWin+1e-6,
      `grading a win as ${g} must actually raise the score (it was a no-op through v9.1)`);
  // '보통'과 '부진'은 이긴 판을 깎지도 올리지도 않는다.
  for(const g of ['ok','bad'])
    assert.ok(Math.abs(perfValue({won:true,perf:g})-plainWin)<1e-9,
      `grading a win as ${g} must leave it unchanged`);
  // 진 판은 성과 등급이 단조롭게 반영돼야 한다.
  const losses=['bad','ok','good','svp','mvp'].map(g=>perfValue({won:false,perf:g}));
  for(let i=1;i<losses.length;i++)
    assert.ok(losses[i]>losses[i-1],'loss grades must be strictly ordered');
  assert.ok(losses[0]<plainLoss&&losses[2]>plainLoss,
    'a graded loss must move above/below an ungraded one');
}
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
assert.ok(/effectiveComfort\(cand\.id,state\.lane\)/.test(html),'score() must use lane-aware effectiveComfort');
/* 탐색은 여전히 막지 않는다. 다만 v9.1부터 감점이 고정 0이 아니라
   '지금 새 챔을 몇 개나 동시에 벌이고 있는가'로 정해진다 — 아무것도 안 벌였으면 0.
   실측(처음 잡는 챔 42% vs 2~3판째 66%)을 값매김하되 상한을 낮게 둬서
   좋은 신규 픽이 여전히 올라오게 한다. */
assert.ok(/const FIRST_PICK_MAX_PENALTY=[1-9]/.test(html),'first-pick penalty cap missing');
assert.ok(/FIRST_PICK_MAX_PENALTY,Math\.max\(0,explorationLoad-1\)\*3/.test(html),
  'first-pick penalty must scale with open explorations, not be a flat charge');
assert.ok(html.includes('function computeExplorationLoad('),'exploration pacing missing');
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

/* [v9] 적 라인 배정 엔진.
   실사용 150판에서 적을 입력한 146판 중 42판은 라인 상대를 못 찾아 상성 축이
   죽었고, 21판은 폴백이 엉뚱한 챔을 상대로 세웠다. 한 명씩 찾는 방식으로
   되돌아가지 않도록 고정하고, 배정 자체를 실제로 실행해 검증한다. */
assert.ok(html.includes('function assignEnemyLanes('),'enemy lane assignment missing');
assert.ok(html.includes('function laneOpponent('),'lane opponent resolver missing');
assert.ok(html.includes('function laneFitConfidence('),'assignment confidence missing');
assert.ok(/const asg=currentAssign\(\)/.test(html),'score() must use the shared assignment');
assert.ok(!/find\(c=>c && primeLaneOf\(c\)===state\.lane\)/.test(html),
  'per-champion laner fallback must not come back');
assert.ok(/counter\+=Math\.round\(laneSum\*lanerConf\*laneMatchupScale\(state\.lane\)\)/.test(html),
  'lane matchup must be damped by assignment confidence and lane type');
assert.ok(/counter=clamp\(counter,-22,22\)/.test(html),'team-level counter must be capped');

// 배정 엔진을 실제로 실행한다 (DOM 없이 필요한 것만 주입).
{
  const dbSrc=html.slice(html.indexOf("const T={S:'S'"),html.indexOf('const LANES=['));
  const {byId,byEn}=Function(dbSrc+'\nreturn {byId,byEn};')();
  const asgSrc=html.slice(html.indexOf('const ASSIGN_LANES='),html.indexOf('/* 배정은 드래프트가 바뀔 때만'));
  assert.ok(asgSrc.includes('function assignEnemyLanes('),'assignment block not extractable');
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const statOf=(c,lane)=>(stats[c.en]&&stats[c.en][lane])||null;
  const {assignEnemyLanes,laneOpponent,laneFit}=
    Function('byId','clamp','statOf',asgSrc+'\nreturn {assignEnemyLanes,laneOpponent,laneFit};')(byId,clamp,statOf);
  const ids=(...en)=>en.map(n=>byEn[n].id);

  // 정석 조합 5명은 각자 제자리에 가야 한다.
  const team=ids('Lee Sin','Ahri','Darius','Jinx','Thresh');
  const full=assignEnemyLanes(team,'mid',null);
  const at=l=>full.byLane[l]&&full.byLane[l].en;
  assert.equal(at('jug'),'Lee Sin','jungler misassigned');
  assert.equal(at('mid'),'Ahri','mid laner misassigned');
  assert.equal(at('top'),'Darius','top laner misassigned');
  assert.equal(at('adc'),'Jinx','adc misassigned');
  assert.equal(at('sup'),'Thresh','support misassigned');
  assert.equal(laneOpponent(full,'mid').conf,1,'a clean assignment must be fully trusted');

  /* 다리우스는 탑·정글 둘 다 가능하다. 탑이 비어 있으면 탑으로 가야 하고,
     그때 정글을 묻는다면 '겸업 추정'으로만 답해야 한다 — 예전 폴백은 이걸
     구분하지 않고 정글 상대로 확정해버렸다. */
  const two=assignEnemyLanes(ids('Corki','Darius'),'jug',null);
  assert.equal(two.byLane.top&&two.byLane.top.en,'Darius','flex pick must take its main lane');
  const jugOpp=laneOpponent(two,'jug');
  assert.ok(jugOpp.alt&&jugOpp.conf>0&&jugOpp.conf<1,'off-lane guess must be flagged and discounted');

  // 그 라인에 설 수 있는 적이 아예 없으면 상대를 지어내지 않는다.
  const none=laneOpponent(assignEnemyLanes(ids('Malphite','Lee Sin'),'adc',null),'adc');
  assert.equal(none.c,null,'must not invent a laner when no candidate exists');
  assert.equal(none.conf,0,'unknown laner must carry zero confidence');

  // 🎯 지정은 배정을 이긴다.
  const pinned=assignEnemyLanes(team,'mid',byEn['Thresh'].id);
  assert.equal(pinned.byLane.mid.en,'Thresh','explicit lane mark must win');
  assert.equal(laneOpponent(pinned,'mid').conf,1,'explicit mark must be fully trusted');

  // 적합도는 실제 역할 통계를 따라야 한다(추측 금지).
  assert.ok(laneFit(byEn['Thresh'],'sup')>laneFit(byEn['Thresh'],'top'),'laneFit must follow role stats');
  assert.equal(laneFit(byEn['Thresh'],'adc'),0,'laneFit must be zero for impossible lanes');
}

/* [v9] 숙련도는 판이 쌓이면 수동 사전값을 완전히 버린다.
   실측: 15판 33%인 챔이 수동 70에 끌려 적용 53(중립 위)에 머물렀다. */
assert.ok(/const spread=60\+40\*Math\.min\(1,f\.n\/15\)/.test(html),'comfort spread must scale with sample size');
assert.ok(/const outcome=m\.won\?0\.74:0\.26/.test(html),'win/loss spread must stay wide enough to learn from');

/* [v9] 성과 입력은 기록 '이후'에 묻는다. 사전 선택 방식으로 되돌아가면
   실사용에서 그랬듯 등급 입력률이 28%로 주저앉는다. */
assert.ok(html.includes('function openPerfRow('),'post-log grading row missing');
assert.ok(html.includes('function patchGraded('),'in-place record patching missing');
assert.ok(/openPerfRow\(matches\.length-1\)/.test(html),'logMatch must open grading for the new record');
assert.ok(!/let pendingPerf/.test(html),'pre-log pending grade must be gone');
assert.ok(/id="perfRow"[^>]*hidden/.test(html),'grading row must start hidden');
assert.ok(html.includes('.perfrow[hidden]{display:none}'),'hidden grading row must actually hide');

/* [v9.1] 개인 실적이 메타를 이길 수 있어야 한다.
   v9까지는 숙련 값에 불확실성이 두 번 걸려(사전분포 + shrink) 실질 폭이 43~63인데
   메타 축은 28~84였고, 그래서 0승 5패인 챔이 원딜 1순위였다. */
assert.ok(!/\(posterior-\.5\)\*spread\*shrink/.test(html),'comfort must not double-shrink');
assert.ok(/\(posterior-\.5\)\*spread,25,78/.test(html),'comfort spread must reach the axis edges');
assert.ok(/const evidence=Math\.min\(1,\(cInfo\.games\|\|0\)\/10\)/.test(html),'comfort weight must scale with evidence');
assert.ok(/W\.comfort\*\(0\.35\+0\.5\*evidence\)/.test(html),'meta mode must widen comfort weight as evidence accrues');
assert.ok(/const shrink=clamp\(f\.n\/4,0,1\)/.test(html),'manual prior must hand over by 4 games');
// 라인별 실적 분리 — 케넨 미드 25% / 탑 43%처럼 갈리는 걸 뭉뚱그리면 안 된다.
assert.ok(/function famComfort\(id,lane\)/.test(html),'comfort must be lane-aware');
assert.ok(/const L=lane&&f\.lane\[lane\]/.test(html),'lane-specific record lookup missing');
assert.ok(/f\.lane\[m\.lane\]/.test(html),'computeFam must accumulate per-lane records');

// [v9] 엔진 자기 교정 리포트 — 점수가 승률과 어긋나면 숨기지 않고 말한다.
assert.ok(html.includes('추천 점수 → 실제 승률'),'engine calibration card missing');
assert.ok(html.includes('내 라인 상대를 알고 있었나'),'laner coverage card missing');
assert.ok(html.includes('out.calib='),'calibration model missing');
assert.ok(/out\.opp=oppB/.test(html),'laner coverage model missing');

/* ============ [v10] 엔진 자기 검증 ============
   v9의 성적표는 판마다 저장해둔 scoreSnapshot을 채점했다 — 그 값은 그 판을
   기록할 당시 엔진이 남긴 것이라, 실사용 111판에 일곱 개 엔진 버전이 섞여 있었다.
   저장값으로 되돌아가면 성적표가 다시 박물관을 채점하게 되므로 고정한다. */
assert.ok(html.includes('function replayPass('),'engine replay missing');
assert.ok(html.includes('function engineReplay('),'trusted replay entry missing');
assert.ok(/const rep=engineReplay\(\)/.test(html),'calibration must score the current engine');
assert.ok(!/const scored=M\.filter\(m=>m\.scoreSnapshot/.test(html),
  'calibration must not grade stored snapshots from older engines');
assert.ok(html.includes('function foldMatch('),'shared fam accumulator missing');
assert.ok(/matches\.forEach\(m=>foldMatch\(famMap,m\)\)/.test(html),
  'computeFam and the replay must share one accumulator');
// 채점은 그 판 직전까지의 전적만 봐야 한다. 전체 전적으로 채점하면 결과를 미리 아는 셈이다.
assert.ok(/famMap=acc;/.test(html)&&/foldMatch\(acc,m\)/.test(html),'replay must be prequential');
assert.ok(html.includes('function rankAgreement('),'axis rank agreement missing');
assert.ok(html.includes('function axisReport('),'axis report missing');
assert.ok(html.includes('function axisTrust('),'axis trust missing');
assert.ok(html.includes('축별 성적표'),'axis report card missing');
assert.ok(html.includes('function setAutoAxis('),'auto-axis toggle missing');
assert.ok(/next\.autoAxis=next\.autoAxis!==false/.test(html),'auto-axis must default on');
// 축 보정은 반드시 세 가중치 전부에 걸려야 한다(하나라도 빠지면 축끼리 눈금이 어긋난다).
for(const [k,re] of [['comfort',/\*TR\.comfort/],['tier',/const tierW=W\.tier\*TR\.tier/],
  ['team',/W\.team\*TR\.team/],['counter',/W\.counter\*TR\.counter/]])
  assert.ok(re.test(html),`axis trust not applied to ${k}`);

/* 축 보정 산식을 실제로 실행해서 경계를 확인한다. 문자열 매칭만으로는
   "보정이 걸려 있으나 언제나 1"인 상태를 잡을 수 없다(v9.2의 교훈). */
{
  // replayPass는 주입한다(전적·DOM 없이 돌려야 하므로). 나머지 산식만 떼어 온다.
  const src=html.slice(html.indexOf('const AXES=['),html.indexOf('let _axisNeutral='))
    +html.slice(html.indexOf('/* 순위 일치도(AUC)'),html.indexOf('/* score()가 쓰는 축별 발언권 배수'));
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  /* 가짜 리플레이 결과: counter 축은 뒤집혀 있고(진 판이 더 높다), comfort·team 축은
     잘 맞히며, tier 축은 승패와 무관하다. n을 바꿔 표본 게이트도 확인한다. */
  const mkRows=n=>Array.from({length:n},(_,i)=>{
    const won=i%2===0;
    return {won,base:won?60:45,tier:50,team:won?60:45,counter:won?40:60,hasAlly:true,hasEnemy:true};
  });
  const load=rows=>Function('clamp','replayPass',
    src+'\nreturn {rankAgreement,axisReport,AXIS_MIN_GAMES,AXIS_FULL_GAMES};')(clamp,()=>rows);
  const {rankAgreement,AXIS_MIN_GAMES,AXIS_FULL_GAMES}=load(mkRows(60));
  assert.ok(AXIS_FULL_GAMES>AXIS_MIN_GAMES,'full-confidence threshold must exceed the minimum');
  assert.equal(rankAgreement(mkRows(60).map(r=>({won:r.won,v:r.won?1:0})),'v'),1,
    'rankAgreement must be 1 for a perfect axis');
  assert.equal(rankAgreement(mkRows(60).map(r=>({won:r.won,v:r.won?0:1})),'v'),0,
    'rankAgreement must be 0 for a fully inverted axis');
  assert.equal(rankAgreement([],'v'),null,'rankAgreement must abstain without both outcomes');

  const big=Object.fromEntries(load(mkRows(AXIS_FULL_GAMES)).axisReport().map(a=>[a.k,a]));
  assert.ok(big.counter.trust<1,'an inverted axis must lose weight');
  assert.ok(big.counter.trust>=0.5,'axis trust must never fall below half');
  assert.ok(big.comfort.trust>1&&big.comfort.trust<=1.15,
    'a well-calibrated axis may gain weight, but only a little');
  assert.equal(big.tier.trust,1,'an axis that tracks nothing must keep its configured weight');

  // 표본이 모자라면 아무리 뒤집혀 있어도 손대지 않는다.
  const small=Object.fromEntries(load(mkRows(AXIS_MIN_GAMES-2)).axisReport().map(a=>[a.k,a]));
  assert.equal(small.counter.trust,1,`axes under ${AXIS_MIN_GAMES} games must not be adjusted`);
  assert.equal(small.counter.active,false,'small samples must be reported as inactive');
  // 표본이 늘수록 보정이 세져야 한다(확신도가 표본에 비례).
  const mid=Object.fromEntries(load(mkRows(AXIS_MIN_GAMES+2)).axisReport().map(a=>[a.k,a]));
  assert.ok(mid.counter.trust>big.counter.trust,'confidence in the adjustment must grow with sample size');
}

/* [v10] 분석 탭 막대가 실제로 그려져야 한다.
   `.bf`는 span이라 display:block이 없으면 인라인이 되어 width·height가 통째로
   무시된다 — 분석 탭이 생긴 v7.1 이후 모든 막대가 트랙만 남은 채 비어 있었다. */
assert.ok(/\.bar \.bf\{display:block;/.test(html),
  'bar fill must be a block box or its width is ignored');
assert.ok(/\.bar\.axis \.bv\{flex:0 0 \d+px\}/.test(html),
  'axis rows need a wider value column or the numbers wrap mid-word');

/* [v10] 라인 상성 축의 과대주장 교정.
   라인 상성은 상한이 없어 실사용에서 +36까지 나왔고, 그 하나로 상성 축을
   포화시킬 수 있었다(팀 단위 항목은 v9에서 이미 ±22로 잘려 있었다). */
assert.ok(/const LANE_MATCHUP_CAP=\d+/.test(html),'lane matchup cap missing');
assert.ok(/laneSum=clamp\(laneSum,-LANE_MATCHUP_CAP,LANE_MATCHUP_CAP\)/.test(html),
  'lane matchup must be capped before it reaches the counter axis');
const laneCap=+html.match(/const LANE_MATCHUP_CAP=(\d+)/)[1];
assert.ok(laneCap>0&&laneCap<=22,'lane matchup cap must not exceed the team-level cap');
// 봇 듀오는 1v1 라인이 아니다 — 정글과 같은 이유로 감쇠한다.
assert.ok(/const BOT_DUO_DAMP=0\.\d+/.test(html),'bot-lane damping missing');
{
  const scale=Function(html.match(/function laneMatchupScale\(lane\)\{[^}]*\}/)[0]
    +'\n'+html.match(/const BOT_DUO_DAMP=0\.\d+;/)[0].replace('const','var')
    +'\nreturn laneMatchupScale;')();
  assert.ok(scale('adc')<1&&scale('sup')<1,'bot duo lanes must be damped');
  assert.equal(scale('top'),1,'solo lanes must keep full lane matchup weight');
  assert.equal(scale('mid'),1,'solo lanes must keep full lane matchup weight');
}

/* [v10] 가이드 카운터 관계의 라인 태그를 쓴다.
   414건 전부에 태그가 달려 있는데 엔진은 그걸 버리고 있었다 — 서폿 럭스의
   카운터 목록이 미드 럭스 상대에도 그대로 적용됐다. */
assert.ok(html.includes('const GUIDE_LANE='),'guide lane map missing');
assert.ok(html.includes('function guideRelWeight('),'lane-aware guide relation missing');
assert.ok(/guideMatchup\(cand,laner,lane\)/.test(html),'guideMatchup must take a lane');
for(const rel of Object.values(guides.champions).flatMap(g=>[].concat(g.counteredBy||[],g.synergy||[])))
  assert.ok(rel.lane,'every guide relation must carry a lane tag');
{
  const laneMap=Function(`return ${html.match(/const GUIDE_LANE=\{[^}]*\}/)[0].replace('const GUIDE_LANE=','')}`)();
  const seen=new Set(Object.values(guides.champions)
    .flatMap(g=>[].concat(g.counteredBy||[],g.synergy||[])).map(r=>r.lane));
  for(const l of seen)assert.ok(laneMap[l],`guide lane "${l}" has no mapping`);
  const relWeight=Function('GUIDE_LANE',
    html.match(/function guideRelWeight\(g,slug,lane\)\{[\s\S]*?\n\}/)[0]+'\nreturn guideRelWeight;')(laneMap);
  // 럭스의 가이드는 서폿 기준이다 — 미드 럭스를 상대할 때 그대로 쓰면 안 된다.
  const lux=guides.champions['Lux'], pyke=guides.champions['Pyke'];
  assert.ok(lux&&pyke,'Lux/Pyke guides needed for this check');
  assert.ok((lux.counteredBy||[]).some(r=>r.slug===pyke.slug&&r.lane==='support'),
    'expected Lux to list Pyke as a support-lane counter');
  assert.equal(relWeight(lux,pyke.slug,'sup'),14,'same-lane guide counter must keep full weight');
  assert.equal(relWeight(lux,pyke.slug,'mid'),5,'off-lane guide counter must be damped');
  assert.ok(relWeight(lux,pyke.slug,'mid')>0,'off-lane guide counter must not be discarded');
  assert.equal(relWeight(lux,'not-a-champ','sup'),0,'unrelated champions must score zero');
}

/* 시드 전적은 새 기기에서 1회 적재되는 실사용 기록이고, README의 검증 수치가
   전부 이 데이터로 계산된다. 조용히 깨지면 두 곳이 동시에 거짓말을 하게 된다. */
{
  const seed=JSON.parse(fs.readFileSync(new URL('../data/seed-history.json',import.meta.url),'utf8'));
  const M=seed.matches;
  assert.ok(Array.isArray(M)&&M.length>=190,`seed history too small: ${M&&M.length}`);
  assert.equal(new Set(M.map(m=>m.t)).size,M.length,'duplicate match timestamp in seed');
  assert.ok(M.every((m,i)=>i===0||m.t>M[i-1].t),'seed history must be sorted by time');
  const GRADES=['mvp','svp','good','ok','bad'];
  const idOf=new Set(names.map(stableId));
  for(const m of M){
    assert.ok(ROLES.includes(m.lane),`seed: bad lane ${m.lane}`);
    assert.equal(typeof m.won,'boolean',`seed: won must be boolean at ${m.t}`);
    assert.ok(idOf.has(m.pick),`seed: unknown pick id ${m.pick} at ${m.t}`);
    // 픽·아군·상대·top3가 전부 실제 챔피언이어야 한다(전사 오타 방지).
    for(const id of [m.top,m.laneMark,m.lanerAuto,...(m.ally||[]),...(m.enemy||[]),...(m.top3||[])])
      if(id!=null)assert.ok(idOf.has(id),`seed: unknown champion id ${id} at ${m.t}`);
    assert.ok((m.ally||[]).length<=4&&(m.enemy||[]).length<=5,`seed: roster overflow at ${m.t}`);
    if(m.perf!=null)assert.ok(GRADES.includes(m.perf),`seed: bad perf grade ${m.perf} at ${m.t}`);
    // top3는 있으면 3개이고 첫 항목이 top이어야 한다.
    if(Array.isArray(m.top3)&&m.top3.length)
      assert.equal(m.top3[0],m.top,`seed: top3[0] must equal top at ${m.t}`);
    if(m.scoreSnapshot)for(const k of ['total','meta','team','counter','comfort','confidence'])
      assert.ok(Number.isFinite(m.scoreSnapshot[k]),`seed: bad scoreSnapshot.${k} at ${m.t}`);
  }
  // 챔폭(pool)도 실제 챔피언만 가리켜야 한다.
  for(const id of Object.keys(seed.pool||{}))assert.ok(idOf.has(+id),`seed pool: unknown id ${id}`);
}

console.log(`WR Picker smoke tests passed: ${champions.length} champions, ${rows.length} role rows.`);
