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
assert.ok(html.includes("const APP_VERSION='13.0.0'"));
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
   "보정이 걸려 있으나 언제나 1"인 상태를 잡을 수 없다(v9.2의 교훈).
   [v11] 불확실성 처리가 핵심이므로 완전 분리(SE=0) 대신 노이즈 섞인 데이터로 검증한다. */
{
  const src=html.slice(html.indexOf('const AXES=['),html.indexOf('let _axisNeutral='))
    +html.slice(html.indexOf('/* 순위 일치도(AUC)'),html.indexOf('/* score()가 쓰는 축별 발언권 배수'));
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  /* 관측 AUC 는 n 과 무관하게 일정하고 표본만 늘어나는 가짜 리플레이.
     10판 중 1판만 방향이 뒤집히므로 counter 는 확실히 0.5 아래, comfort 는 위. */
  const mkRows=n=>Array.from({length:n},(_,i)=>{
    const won=i%2===0, flip=(i%10===0);
    const good=(won!==flip)?60:40;
    return {won, base:good, tier:50, team:good, counter:100-good, hasAlly:true, hasEnemy:true};
  });
  const load=rows=>Function('clamp','replayPass',
    src+'\nreturn {rankAgreement,rankAgreementSE,shrinkAgreement,axisReport,AXIS_MIN_GAMES,AXIS_PRIOR_SD};')(clamp,()=>rows);
  const L=load(mkRows(200));
  const {rankAgreement,rankAgreementSE,shrinkAgreement,AXIS_MIN_GAMES,AXIS_PRIOR_SD}=L;

  assert.ok(AXIS_PRIOR_SD>0&&AXIS_PRIOR_SD<0.5,'axis prior SD must be a plausible spread');
  assert.equal(rankAgreement(mkRows(60).map(r=>({won:r.won,v:r.won?1:0})),'v'),1,'perfect axis must score 1');
  assert.equal(rankAgreement(mkRows(60).map(r=>({won:r.won,v:r.won?0:1})),'v'),0,'inverted axis must score 0');
  assert.equal(rankAgreement([],'v'),null,'must abstain without both outcomes');

  // 표준오차: 완전 분리면 0, 섞이면 양수, 표본이 커지면 작아진다.
  assert.equal(rankAgreementSE(1,50,50),0,'perfect separation has no sampling error');
  const seSmall=rankAgreementSE(0.6,20,20), seBig=rankAgreementSE(0.6,200,200);
  assert.ok(seSmall>0&&seBig>0,'mixed outcomes must carry sampling error');
  assert.ok(seBig<seSmall,'standard error must shrink as the sample grows');
  assert.equal(rankAgreementSE(0.6,0,10),null,'SE undefined without both outcomes');

  /* 축소: 오차가 크면 0.5 로 당겨지고, 오차가 작아지면 관측값을 그대로 믿는다.
     이게 v11 의 핵심 — v10 은 오차와 무관하게 점 추정을 그대로 썼다. */
  const noisy=shrinkAgreement(0.40,0.10), sharp=shrinkAgreement(0.40,0.005);
  assert.ok(Math.abs(noisy-0.5)<Math.abs(sharp-0.5),'a noisy estimate must be pulled toward 0.5');
  assert.ok(noisy>0.40&&noisy<0.5,'shrunk value must sit between the estimate and 0.5');
  assert.ok(Math.abs(sharp-0.40)<0.01,'a precise estimate must survive nearly intact');
  assert.equal(shrinkAgreement(null,0.05),null,'no estimate, no shrinkage');

  // 같은 관측 AUC 라도 표본이 크면 보정이 강해져야 한다.
  const small=Object.fromEntries(load(mkRows(40)).axisReport().map(a=>[a.k,a]));
  const big=Object.fromEntries(load(mkRows(400)).axisReport().map(a=>[a.k,a]));
  assert.ok(Math.abs(small.counter.auc-big.counter.auc)<0.02,'fixture must hold AUC steady across sizes');
  assert.ok(big.counter.trust<small.counter.trust,'more evidence must yield a stronger correction');
  assert.ok(big.counter.trust>=0.5&&big.comfort.trust<=1.15,'axis trust must stay inside its bounds');
  assert.ok(big.comfort.trust>1&&big.counter.trust<1,'a clearly split axis must move in the right direction');
  assert.equal(big.tier.trust,1,'an axis that tracks nothing must keep its configured weight');

  // 신뢰구간과 '단정 가능' 판정
  for(const a of Object.values(big)){
    assert.ok(a.se>=0,'every axis must report a standard error');
    assert.ok(a.lo<=a.auc&&a.hi>=a.auc,'interval must bracket the estimate');
    assert.equal(a.conclusive,a.lo>0.5||a.hi<0.5,'conclusive must mean the interval clears 0.50');
  }
  assert.equal(big.tier.conclusive,false,'a coin-flip axis must never be called conclusive');
  // 표본이 모자라면 아무리 뒤집혀 있어도 손대지 않는다.
  const tiny=Object.fromEntries(load(mkRows(AXIS_MIN_GAMES-2)).axisReport().map(a=>[a.k,a]));
  assert.equal(tiny.counter.trust,1,`axes under ${AXIS_MIN_GAMES} games must not be adjusted`);
  assert.equal(tiny.counter.active,false,'small samples must be reported as inactive');
}

/* [v11] 분석 탭 조언은 효과 크기가 아니라 유의성으로 갈라야 한다.
   199판 시점에 "상대 픽을 끝까지 입력하세요"(p=0.55)가 단정형으로 떠 있었다. */
assert.ok(html.includes('function propDiffP('),'two-proportion test missing');
assert.ok(html.includes('function normCdf('),'normal CDF missing');
assert.ok(/const SIG_P=0\.\d+/.test(html),'significance threshold missing');
assert.ok(/const solid=a\.insights\.filter\(x=>x\.kind==='fact'\|\|\(x\.p!=null&&x\.p<=SIG_P\)\)/.test(html),
  'insights must be split by significance');
/* fail-closed: 승률 추론인데 p 를 안 붙이면 조용히 단정형으로 승격되면 안 된다.
   v11 초안이 바로 이 구멍을 갖고 있었다 — p==null 을 '유의함'으로 취급했다. */
assert.ok(!/x\.p==null\|\|x\.p<=SIG_P/.test(html),'a missing p-value must never mean "significant"');
assert.ok(html.includes("kind:'fact'"),'descriptive insights must be tagged as facts');
{
  // 승률을 근거로 드는 인사이트에는 전부 p 가 붙어 있어야 한다.
  const chunks=html.split('ins.push({t:').slice(1);
  const pushes=chunks.map(c=>c.slice(0,900));
  assert.ok(pushes.length>=10,`expected the full insight set, found ${pushes.length}`);
  for(const p of pushes){
    const tagged=/kind:'fact'/.test(p)||/\bp:/.test(p);
    assert.ok(tagged,'every insight must declare kind:\'fact\' or carry a p-value: '+p.slice(0,80));
  }
}
assert.ok(html.includes('아직 판단할 수 없는 관찰'),'tentative observation section missing');
assert.ok(html.includes('.dx.tent{'),'tentative styling missing');
{
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const p=Function('clamp',html.match(/function normCdf\(z\)\{[\s\S]*?\n\}/)[0]
    +'\n'+html.match(/function propDiffP\(w1,n1,w2,n2\)\{[\s\S]*?\n\}/)[0]
    +'\nreturn propDiffP;')(clamp);
  // 같은 비율이면 p=1 에 가깝고, 크게 갈리고 표본이 크면 작아진다.
  assert.ok(p(50,100,50,100)>0.9,'identical rates must not look significant');
  assert.ok(p(90,100,10,100)<0.001,'a huge, well-sampled gap must be significant');
  // 작은 표본의 큰 차이는 유의하지 않아야 한다 — 이게 v10 까지 통과하던 구멍이다.
  assert.ok(p(6,10,2,10)>0.05,'a big gap on 10 games must not clear the bar');
  assert.ok(p(0,0,5,10)===1,'empty buckets must be inert');
}
/* [v11] 전적이 사라지는 경로들. 전부 실제로 재현했던 것이라 회귀로 고정한다. */
// (1) 저장값을 못 읽었을 때 '기록 없음'으로 오해하면 안 된다 — 200판이 0판이 됐었다.
assert.ok(html.includes('let loadFailed=null'),'load failure state missing');
assert.ok(html.includes('function salvageMatches('),'partial salvage missing');
assert.ok(/wr_matches_corrupt/.test(html),'corrupted payload must be quarantined');
assert.ok(!/catch\(e\)\{matches=\[\];\}/.test(html),'a read failure must not silently mean "no history"');
assert.ok(/if\(!loadFailed\)await saveMatches\(\)/.test(html),'boot must not overwrite an unreadable store');
assert.ok(/if\(loadFailed\)return false;/.test(html),'seeding must not treat a read failure as a new device');
assert.ok(/if\(loadFailed\)return;/.test(html),'auto-backup must pause while the store is unreadable');
assert.ok(html.includes('function downloadCorrupt('),'user must be able to retrieve the raw payload');
assert.ok(html.includes('function ackLoadFailure('),'user must be able to resume normal saving');
// (2) ISO 문자열 t 를 가진 백업이 한 판으로 붕괴하면 안 된다.
assert.ok(html.includes('function matchTime('),'timestamp parser missing');
assert.ok(!/const t=Number\(m\.t\)\|\|Date\.now\(\)/.test(html),
  'Number(t)||Date.now() collapses every ISO-timestamped record onto one id');
{
  const mt=Function(html.match(/function matchTime\(raw\)\{[\s\S]*?\n\}/)[0]
    .replace('_tSeq++','(globalThis.__s=(globalThis.__s||0)+1)')+'\nreturn matchTime;')();
  assert.equal(mt(1786525004064),1786525004064,'numeric timestamps must pass through');
  assert.equal(mt('2026-08-01T10:00:00.000Z'),Date.parse('2026-08-01T10:00:00.000Z'),'ISO timestamps must parse');
  assert.notEqual(mt(null),mt(null),'unknown timestamps must never collide');
}
// (3) 성과 입력 대상은 배열 위치가 아니라 판의 신원이어야 한다.
assert.ok(html.includes('let gradingT=null'),'grading target must be identity-based');
assert.ok(!/let gradingIdx/.test(html),'index-based grading target must be gone');
assert.ok(/matches\.find\(m=>m\.t===gradingT\)/.test(html),'grading must look the match up by time');
// (4) 되돌리기 스냅샷이 서로를 덮어쓰면 안 된다.
assert.ok(html.includes('const ROLLBACK_KEYS='),'rollback slots must be separated by reason');
assert.ok(html.includes('async function bestRollback('),'rollback must pick the most complete snapshot');
// (5) 해석 못 한 챔폭 항목을 조용히 버리지 않는다.
assert.ok(html.includes('poolOrphans'),'unresolved pool entries must be preserved');

/* [v11] 통계 세대가 바뀌면 적 라인 배정 캐시도 무효화돼야 한다.
   랭크 구간을 바꿔도 옛 통계로 계산한 배정을 계속 쓰고 있었다. */
assert.ok(/_asgKey.*_engineDataVersion|state\.enemy\.join\(','\)\+'\|'\+_engineDataVersion/.test(html),
  'assignment cache key must include the stats generation');
{
  const i=html.indexOf('function applyStatsPayload('), j=html.indexOf('function sanitizeStatsTable(');
  assert.ok(html.slice(i,j).includes('bumpEngineData()'),
    'the generation must bump where ROLE_STATS actually changes (bracket switches go through here)');
}

/* [v11] 적 5라인 배정 격자 — 빈 칸이 곧 '아직 모르는 라인'이다.
   실사용 199판에서 적을 입력한 195판 중 56판(29%)은 내 라인 상대가 안 들어와
   상성 계산이 꺼진 채였다. 문장 안내(v9.1)와 칩 배지(v10)로는 줄지 않았다. */
assert.ok(html.includes('id="enemyLaneGrid"'),'enemy lane grid container missing');
assert.ok(html.includes('function renderLaneGrid('),'lane grid renderer missing');
assert.ok(/renderLaneGrid\(asg\)/.test(html),'chips() must render the grid from the shared assignment');
assert.ok(/\.lanegrid\{display:grid;grid-template-columns:repeat\(5,1fr\)/.test(html),
  'lane grid must lay out all five lanes');
// 빈 칸은 버튼이어야 누를 수 있다(그냥 표시만 하면 v9.1 안내와 다를 게 없다).
assert.ok(/onclick="focusEnemyAdd\('\$\{l\}'\)"/.test(html),'empty lane slot must be tappable');
assert.ok(/function focusEnemyAdd\(lane\)/.test(html),'focusEnemyAdd must accept a lane');
assert.ok(html.includes('let addLaneHint=null'),'lane hint state missing');
// 빈 검색창에서도 그 라인 후보를 띄워야 한다.
assert.ok(/if\(!raw&&addLaneHint\)/.test(html),'lane hint must seed suggestions without a query');
assert.ok(/if\(!raw\.trim\(\)&&!addLaneHint\)/.test(html),'dropdown must stay open for a lane hint');
assert.ok(html.includes('ddhead'),'lane hint header missing');
// 힌트는 다른 쪽으로 가거나 추가하면 풀려야 한다(엉뚱한 목록이 계속 뜨면 안 된다).
assert.ok(/setAddSide\(s\)\{if\(s!=='enemy'\)addLaneHint=null/.test(html),'lane hint must clear when switching side');

/* [v11] 원딜 서폿 카드의 교란을 숨기지 않는다.
   '서폿류 없음'은 대체로 아군을 덜 입력한 판이었다(2명 이하 0승 8패). */
assert.ok(html.includes('out.duo.byAllyCount='),'duo card must break down by ally input count');
assert.ok(html.includes('out.duo.deep='),'duo card must control for input completeness');
assert.ok(html.includes('두 원인이 섞여 있습니다'),'duo card must disclose the confound');

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
  const scale=Function(html.match(/const BOT_DUO_DAMP=0\.\d+;/)[0].replace('const','var')
    +'\n'+html.match(/const LANE_MATCHUP_SCALE=\{[^}]*\};/)[0].replace('const','var')
    +'\n'+html.match(/function laneMatchupScale\(lane\)\{[^}]*\}/)[0]
    +'\nreturn laneMatchupScale;')();
  assert.ok(scale('adc')<1&&scale('sup')<1,'bot duo lanes must be damped');
  assert.equal(scale('top'),1,'solo lanes must keep full lane matchup weight');
  assert.equal(scale('mid'),1,'solo lanes must keep full lane matchup weight');
  /* [v11] 정글 감쇠가 클래스 매트릭스 한 성분에만 걸려 실효 0.68이던 것을
     라인 상성 전체로 옮겼다. 감쇠는 이 표 한 곳에서만 결정돼야 한다. */
  assert.ok(scale('jug')<scale('adc'),'jungle must be damped at least as much as the bot duo');
  assert.ok(!/else a=Math\.round\(a\*0\.5\)/.test(html),
    'jungle damping must not be applied to only one matchup component');
  assert.ok(/a=Math\.round\(a\*0\.5\)/.test(html),
    'the v8.4 guide-data damping is a different rule and must stay');
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


/* [v12] "몇 판 더 있어야 아는가" — 검정력 계산.
   이 앱이 제일 자주 하는 말이 "아직 판단할 수 없습니다"라, 그 말에 기한을 붙이는
   숫자가 틀리면 사용자는 답이 안 나오는 질문을 몇 백 판씩 기다리게 된다. */
{
  const cut=(a,b)=>{const i=html.indexOf(a),j=html.indexOf(b,i);
    assert.ok(i>=0&&j>i,`v12: cannot extract ${a}`);return html.slice(i,j);};
  const src=cut('function normCdf(z){','function barRow(');
  const L=new Function('clamp',src+'\nreturn {normCdf,invNorm,propDiffP,selP,gamesToDecide,SIG_P,Z_POWER};')
    ((v,a,b)=>Math.min(b,Math.max(a,v)));
  const {invNorm,propDiffP,gamesToDecide,SIG_P}=L;

  // 역정규: 표준 임계값을 되돌려야 한다.
  assert.ok(Math.abs(invNorm(0.975)-1.959964)<0.002,'invNorm(0.975) must be ~1.96');
  assert.ok(Math.abs(invNorm(0.5))<0.002,'invNorm(0.5) must be ~0');
  assert.ok(invNorm(0.999)>invNorm(0.99),'invNorm must be increasing');

  // 차이가 없으면 답이 없다 — 무한대를 큰 정수로 위장해 내놓으면 안 된다.
  assert.equal(gamesToDecide(50,100,50,100,1),null,'no observed difference, no sample size');
  assert.equal(gamesToDecide(5,10,5,0,1),null,'empty group must abstain');

  // 관측 격차가 클수록 필요한 판수가 적어야 한다.
  const wide=gamesToDecide(35,50,15,50,1), narrow=gamesToDecide(27,50,23,50,1);
  assert.ok(wide>=0&&narrow>0,'both must return a usable count');
  assert.ok(wide<narrow,'a bigger observed gap must need fewer extra games');

  /* [v13] 적응형 슬럼프 창. 고정 창은 그 길이와 다른 슬럼프를 놓친다 —
   실사용 242판에서 고정 20%(40판)는 45%(-8%p)로 보고했는데 실제 바닥은
   최근 30판 37%(-17%p)였다. 여러 창을 훑되, 훑은 만큼 p를 보정해야 한다.
   보정을 빼먹으면 '가장 나쁜 구간 고르기'가 곧바로 가짜 유의성이 된다. */
{
  assert.ok(/const CANDS=\[10,12,16,20,24,30,40\]\.filter\(k=>k>=RECENT_MIN&&k<=Math\.floor\(n\*0\.4\)\);/.test(html),
    'v13: candidate windows must be bounded by the history size');
  assert.ok(/const pick=windows\.slice\(\)\.sort\(\(a,b\)=>a\.p-b\.p\|\|b\.k-a\.k\)\[0\];/.test(html),
    'v13: the strongest window wins, ties going to the larger sample');
  assert.ok(/dropP:selP\(propDiffP\(rw,R\.length,bw,B\.length\),WSCAN\)/.test(html),
    'v13: scanning many windows must be paid for with a multiple-comparison correction');
  assert.ok(/dropNeed:gamesToDecide\(rw,R\.length,bw,B\.length,WSCAN\)/.test(html),
    'v13: required sample must use the same window correction as p');
  assert.ok(/windows,wscan:WSCAN/.test(html),'v13: the window curve must reach the renderer');
  assert.ok(/\.wcurve\{/.test(html)&&/\.wcurve \.wbase\{/.test(html),'v13: window curve styles must exist');
  // 음수 마진으로 기준선을 끌어올리면 아래 문단을 덮는다(v13 초안이 그랬다).
  assert.ok(!/class="wbase" style="margin-top:\$\{-/.test(html),
    'v13: the baseline must be positioned inside the chart, not pulled up with a negative margin');
}

/* [v13] 성과 축. 승률만 보면 '내 플레이가 무너졌나'를 영영 못 묻는다.
   단 성과는 승패와 강하게 붙어 있어(실사용 242판 p=0.0001), 전체 평균을
   비교하면 '연패 중이니 성과도 낮다'는 동어반복이 된다 — v13 초안이 실제로
   그 함정에 빠져 p=0.041 로 '성과 하락'을 단정했다. 승/패로 나눠서만 판정한다. */
{
  assert.ok(/function meanDiffP\(A,B\)\{/.test(html),'v13: mean-difference test must exist');
  assert.ok(/if\(!A\|\|!B\|\|A\.length<3\|\|B\.length<3\)return null;/.test(html),
    'v13: the mean test must abstain on tiny samples');
  // perfValue() 는 승패(0.74/0.26)를 섞으므로 성과 비교에 쓰면 승률을 두 번 재게 된다.
  assert.ok(/const gradeOf=m=>PERF\[m\.perf\]\?PERF\[m\.perf\]\.v:null;/.test(html),
    'v13: the form axis must use the raw grade, not the outcome-blended perfValue');
  assert.ok(!/gradedOf=A=>A\.filter\(m=>m\.perf\)\.map\(m=>perfValue\(m\)\)/.test(html),
    'v13: perfValue blends the result in by design and must not drive the form axis');
  assert.ok(/const declined=dropped\(\{\.\.\.fLost,p:fLost\.p!=null\?selP\(fLost\.p,2\):null\}\)\s*\|\|dropped\(\{\.\.\.fWon,p:fWon\.p!=null\?selP\(fWon\.p,2\):null\}\);/.test(html),
    'v13: the decline verdict must come from within-result comparisons, corrected for both');
  assert.ok(!/dropped\(fAll\)/.test(html),
    'v13: the confounded aggregate must never drive the verdict');
  assert.ok(/verdict:!enough\?'unknown':declined\?'decline':wrDown\?'held':'unknown'/.test(html),
    'v13: verdict must fall back to unknown rather than guessing');
  assert.ok(/\.formbox\{/.test(html),'v13: form verdict styles must exist');
}

/* [v12.1] 앱이 기록할 수 없던 시절의 판을 baseline 으로 쓰면 안 된다.
     '팀 문제' 표시는 v8.1 에 생겼고, 그 전 판은 정의상 전부 0 이다. 창을 안 좁히면
     실사용 218판에서 "팀 문제가 3%→18%로 급증(p=0.002)"이라는 가짜 신호가
     카드의 유일한 '달라진 것'이 된다. 실제로 v12.0 이 그걸 띄웠다. */
  assert.ok(/const cmp=\(label,f,kind,worse,note,eligible\)=>/.test(html),
    'v12.1: cmp must accept an eligibility window');
  assert.ok(/const R2=eligible\?R\.filter\(eligible\):R, B2=eligible\?B\.filter\(eligible\):B;/.test(html),
    'v12.1: both windows must be narrowed, not just the recent one');
  assert.ok(/if\(eligible&&\(R2\.length<6\|\|B2\.length<12\)\)return null;/.test(html),
    'v12.1: a narrowed comparison must abstain when either side is too small');
  assert.ok(/'표시가 늘었다면[^']*',canFlagTeam\)/.test(html),
    'v12.1: the team-issue item must be gated to versions that could record it');
  assert.ok(/const canFlagTeam=m=>verNum\(m\.modelVersion\)>=TEAM_ISSUE_SINCE;/.test(html)
    &&/const TEAM_ISSUE_SINCE=verNum\('8\.1\.0'\);/.test(html),
    'v12.1: capability must be decided by the recorded model version');
  assert.ok(/\]\.filter\(Boolean\);/.test(html),'v12.1: abstained items must be dropped, not left as null');

  // 다중 비교를 보정하면 문턱이 올라가므로 더 많이 필요하다.
  assert.ok(gamesToDecide(27,50,23,50,5)>narrow,'Bonferroni correction must raise the required sample');

  /* '앞으로 더' 판수여야지 '총' 판수면 안 된다. 이미 충분히 갈린 관측에까지
     수백 판을 더 요구하면 사용자는 답이 나온 질문을 계속 기다리게 된다. */
  assert.equal(gamesToDecide(45,50,5,50,1),0,'an already decisive gap needs no further games');
  assert.ok(gamesToDecide(30,50,20,50,1)<gamesToDecide(28,50,22,50,1),
    'the returned count must be additional games, shrinking as evidence strengthens');

  /* 화면이 기대는 불변식: 아직 유의하지 않은 관찰은 반드시 '앞으로 더' 필요하다.
     여기가 깨지면 "우연일 확률 20%"라면서 "이미 판단 가능"이라고 말하게 된다. */
  for(const [w1,n1,w2,n2] of [[27,50,23,50],[12,20,10,25],[60,120,55,130],[9,15,14,30]]){
    const pv=propDiffP(w1,n1,w2,n2), k=gamesToDecide(w1,n1,w2,n2,1);
    if(pv>SIG_P)assert.ok(k>0,`p=${pv.toFixed(3)} is inconclusive but asks for ${k} more games`);
  }
  // 정수·유한이어야 화면에 그대로 찍을 수 있다.
  assert.ok(Number.isInteger(narrow)&&Number.isFinite(narrow),'required sample must be a finite integer');
}

/* [v12] 최근 부진 진단. 슬럼프에 없는 원인을 만들어 붙이는 게 제일 나쁜 조언이라,
   '달라진 것'으로 올라가는 조건이 느슨해지지 않았는지 소스에서 지킨다. */
{
  assert.ok(/out\.diag=null;/.test(html),'v12: diag must default to null');
  assert.ok(/changed:items\.filter\(x=>x\.p<=SIG_P&&x\.worse\)/.test(html),
    'v12: only significant AND worse items may be reported as changed');
  assert.ok(/shifted:items\.filter\(x=>x\.p<=SIG_P&&!x\.worse\)/.test(html),
    'v12: significant improvements must be surfaced, not filed under "no change"');
  // 유의하게 달라졌는데 나쁜 방향이 아닌 항목이 '이상 없음' 목록에 섞이면 안 된다.
  assert.ok(/const shown=d\.changed\.concat\(d\.shifted\|\|\[\]\);/.test(html)
    &&/const rest=d\.items\.filter\(x=>!shown\.includes\(x\)\);/.test(html),
    'v12: the "no change" list must exclude everything already shown');
  // 패치 항목은 방향을 실제로 재야 한다(v12 초안은 worse:true 고정이었다).
  assert.ok(/worse:ow\/on\.length<fw\/off\.length,isWinrate:true/.test(html),
    'v12: patch item must derive its direction from the data');
  assert.ok(!/worse:true,isWinrate:true/.test(html),'v12: no hard-coded "worse" direction');
  // 카드가 실제로 화면에 붙어 있어야 한다(v8.4의 .bf 사고 재발 방지).
  assert.ok(/body\.innerHTML=verdict\+diagCard\+insights\+/.test(html),
    'v12: diagnosis card must be mounted in the analysis tab');
  assert.ok(/\.dgrow\{/.test(html)&&/\.dgok\{/.test(html),'v12: diagnosis card styles must exist');
  // 다중 비교 보정을 p 에만 걸고 need 에 안 걸면 두 숫자가 서로 어긋난다.
  assert.ok(/x\.need=gamesToDecide\(x\.recent\.k,x\.recent\.n,x\.base\.k,x\.base\.n,items\.length\);/.test(html),
    'v12: required-sample must use the same multiple-comparison correction as p');
}


console.log(`WR Picker smoke tests passed: ${champions.length} champions, ${rows.length} role rows.`);
