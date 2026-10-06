#!/usr/bin/env node
/* WR Picker stat pipeline.
 *
 * Pulls the WildRiftFire stats page, extracts the inline JSON payload that backs
 * its rank-bracket table, and emits three artifacts:
 *
 *   data/latest.json           every rank bracket, fetched by the app at runtime
 *   data/history/<date>.json   one archive per upstream "updated" date (trend source)
 *   data/by-patch.json         per-patch averages, so the app can re-score old games
 *                              with the stats of their own patch (patch-history.mjs)
 *   stats.js                   Diamond+ snapshot bundled into the app shell as the
 *                              offline fallback, plus the previous patch's baseline for trends
 *
 * Usage:
 *   node scripts/fetch-stats.mjs                  fetch from the network
 *   node scripts/fetch-stats.mjs --from <file>    parse a saved page (offline testing)
 *   node scripts/fetch-stats.mjs --dry-run        report only, write nothing
 *   node scripts/fetch-stats.mjs --rebuild        regenerate outputs from the newest archive (no network)
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {patchBaseline} from './trend-baseline.mjs';
import {buildByPatch} from './patch-history.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const SOURCE_URL='https://www.wildriftfire.com/stats';
const DATA_DIR=path.join(ROOT,'data');
const HISTORY_DIR=path.join(DATA_DIR,'history');

const ROLE={Baron:'top',Jungle:'jug',Mid:'mid',Duo:'adc',Support:'sup'};
// Upstream display names that differ from the champion names used in index.html.
const RENAME={'Nunu & Willump':'Nunu'};

const args=process.argv.slice(2);
const argOf=name=>{const i=args.indexOf(name);return i>=0?args[i+1]:null;};
const fromFile=argOf('--from');
const dryRun=args.includes('--dry-run');

/* ---------- 1. acquire the page ---------- */
async function loadPage(){
  if(fromFile)return fs.readFileSync(path.resolve(fromFile),'utf8');
  const res=await fetch(SOURCE_URL,{headers:{
    'User-Agent':'wr-picker-stats-bot/1.0 (+https://github.com/g23252a-svg/wr-picker)',
    'Accept':'text/html'
  }});
  if(!res.ok)throw new Error(`fetch ${SOURCE_URL} failed: HTTP ${res.status}`);
  return res.text();
}

/* ---------- 2. extract the embedded payload ---------- */
// The table is driven by a JSON object inlined in a <script> tag. Scanning for
// balanced braces is resilient to the surrounding script changing shape.
function extractPayload(html){
  const start=html.indexOf('{"patch"');
  if(start<0)throw new Error('stats payload not found — upstream page structure changed');
  let depth=0,end=-1,inStr=false,esc=false;
  for(let i=start;i<html.length;i++){
    const ch=html[i];
    if(esc){esc=false;continue;}
    if(ch==='\\'){esc=true;continue;}
    if(ch==='"'){inStr=!inStr;continue;}
    if(inStr)continue;
    if(ch==='{')depth++;
    else if(ch==='}'&&--depth===0){end=i+1;break;}
  }
  if(end<0)throw new Error('stats payload is truncated');
  const payload=JSON.parse(html.slice(start,end));
  if(!payload.brackets||!payload.patch)throw new Error('stats payload missing patch/brackets');
  return payload;
}

/* ---------- 3. normalise into the app's champion/role shape ---------- */
function championNames(){
  const html=fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
  const s=html.indexOf('const C=')+'const C='.length;
  const e=html.indexOf('\n];',s)+3;
  if(s<8||e<s)throw new Error('champion database block not found in index.html');
  return new Set(Function(`return ${html.slice(s,e)}`)().map(row=>row[1]));
}

function normaliseBracket(rows,known,unknown,slugs){
  const stats={};
  for(const r of rows){
    const name=RENAME[r.champion]||r.champion;
    const role=ROLE[r.role];
    if(!role){unknown.add(`role:${r.role}`);continue;}
    if(!known.has(name)){unknown.add(`champion:${r.champion}`);continue;}
    // 가이드 URL slug는 업스트림이 알려주는 값을 그대로 쓴다.
    // 이름에서 유추하면 틀린다(예: Nunu & Willump → nunu-amp-willump).
    if(slugs&&r.slug&&/^[a-z0-9-]{2,40}$/.test(r.slug))slugs[name]=r.slug;
    const entry={win:r.win,pick:r.pick,ban:r.ban};
    if(r.tier)entry.tier=r.tier;          // WildRiftFire tier-list grade
    if(r.main)entry.main=1;               // upstream flag: this is the champion's primary role
    (stats[name]||(stats[name]={}))[role]=entry;
  }
  return stats;
}

function countRows(stats){return Object.values(stats).reduce((n,roles)=>n+Object.keys(roles).length,0);}

/* ---------- 4. serialise ---------- */
const fmtRoles=roles=>'{'+Object.entries(roles)
  .map(([role,s])=>`${role}:{win:${s.win},pick:${s.pick},ban:${s.ban}`+
    (s.tier?`,tier:${JSON.stringify(s.tier)}`:'')+(s.main?',main:1':'')+'}')
  .join(',')+'}';
const fmtStats=stats=>Object.entries(stats)
  .map(([name,roles])=>`  ${JSON.stringify(name)}:${fmtRoles(roles)}`).join(',\n');

function renderStatsJs({patch,updated,label,stats,prev,prevPatch,prevUpdated,prevFrom,prevDays,sourceNote,brackets}){
  return `/* WR Picker meta snapshot — GENERATED FILE, do not edit by hand.
 * Regenerate with: node scripts/fetch-stats.mjs
 * Source: WildRiftFire ${label} role table (${SOURCE_URL})
 * Upstream note: ${sourceNote}
 * Bundled snapshot is the offline fallback; the app prefers data/latest.json at runtime.
 */
window.WR_STATS_META=Object.freeze({
  patch:${JSON.stringify(patch)},
  capturedAt:${JSON.stringify(updated)},
  region:'CN',
  bracket:${JSON.stringify(label)},
  rows:${countRows(stats)},
  champions:${Object.keys(stats).length},
  source:${JSON.stringify(SOURCE_URL)},
  sourceNote:${JSON.stringify(sourceNote)},
  cadence:'daily',
  brackets:${JSON.stringify(brackets)},
  prevPatch:${JSON.stringify(prevPatch)},
  prevCapturedAt:${JSON.stringify(prevUpdated)},
  prevFrom:${JSON.stringify(prevFrom??null)},
  prevDays:${JSON.stringify(prevDays??null)}
});

window.WR_ROLE_STATS=Object.freeze({
${fmtStats(stats)}
});

window.WR_ROLE_STATS_PREV=Object.freeze({
${prev?fmtStats(prev):''}
});
`;
}

/* ---------- main ---------- */
/* --rebuild: 네트워크 없이 가장 최근 아카이브로 latest.json·stats.js 를 다시 만든다.
   추세 기준선 계산 방식이 바뀌었을 때 다음 정기 실행을 기다리지 않으려고 둔다. */
const rebuild=args.includes('--rebuild');
const unknown=new Set();
let payload,brackets,slugs;
if(rebuild){
  const newest=fs.readdirSync(HISTORY_DIR).filter(f=>f.endsWith('.json')).sort().pop();
  if(!newest)throw new Error('--rebuild needs at least one archive in data/history');
  const a=JSON.parse(fs.readFileSync(path.join(HISTORY_DIR,newest),'utf8'));
  payload={patch:a.patch,updated:a.updated,source:a.source};
  brackets=a.brackets;
  const latestPath=path.join(DATA_DIR,'latest.json');
  slugs=fs.existsSync(latestPath)?(JSON.parse(fs.readFileSync(latestPath,'utf8')).slugs||{}):{};
}else{
  const html=await loadPage();
  payload=extractPayload(html);
  const known=championNames();
  brackets={};
  slugs={};                                       // 챔피언 → 가이드 URL slug (업스트림 제공값)
  for(const [key,b] of Object.entries(payload.brackets)){
    const rows=Array.isArray(b.rows)?b.rows:[];
    if(!rows.length)continue;                     // Legendary is empty until it populates
    brackets[key]={label:b.label,stats:normaliseBracket(rows,known,unknown,slugs)};
  }
}
if(!brackets.diamond)throw new Error('Diamond+ bracket missing from payload');

const updated=payload.updated;
if(!/^\d{4}-\d{2}-\d{2}$/.test(updated||''))throw new Error(`unexpected updated date: ${updated}`);
// The upstream page is a third party and this script commits unattended, so refuse
// anything that would end up as markup or a script fragment in the app.
if(!/^[0-9A-Za-z.]{1,12}$/.test(payload.patch))throw new Error(`unsafe patch label: ${payload.patch}`);
for(const [key,b] of Object.entries(brackets)){
  if(!/^[a-z]{3,16}$/.test(key))throw new Error(`unsafe bracket key: ${key}`);
  if(!/^[A-Za-z0-9+ .\-]{1,24}$/.test(b.label||''))throw new Error(`unsafe bracket label: ${b.label}`);
}

// Archive this upstream revision, then build the trend baseline from the previous patch.
fs.mkdirSync(HISTORY_DIR,{recursive:true});
const archivePath=path.join(HISTORY_DIR,`${updated}.json`);
const archive={patch:payload.patch,updated,source:payload.source,brackets};

const olderArchives=fs.readdirSync(HISTORY_DIR).filter(f=>f.endsWith('.json'))
  .map(f=>f.replace(/\.json$/,'')).filter(d=>d<updated).sort()
  .map(d=>{try{return JSON.parse(fs.readFileSync(path.join(HISTORY_DIR,`${d}.json`),'utf8'));}catch{return null;}})
  .filter(Boolean);
/* [v19] 기준선은 '어제'가 아니라 '직전 패치의 마지막 며칠'이다 — 이유는
   trend-baseline.mjs 머리말. 직전 패치가 없으면 추세를 비운다(전날로 대신하지 않는다). */
const base=patchBaseline(olderArchives,payload.patch);
const prevStats=base?base.brackets.diamond.stats:null;
const prevPatch=base?base.patch:null;
const prevUpdated=base?base.updated:null;

const diamond=brackets.diamond;
const statsJs=renderStatsJs({
  patch:payload.patch,updated,label:diamond.label,stats:diamond.stats,
  prev:prevStats,prevPatch,prevUpdated,prevFrom:base?base.from:null,prevDays:base?base.days:null,sourceNote:payload.source,
  brackets:Object.entries(brackets).map(([k,b])=>({key:k,label:b.label,rows:countRows(b.stats)}))
});

const latest={
  patch:payload.patch,updated,source:payload.source,url:SOURCE_URL,
  generatedFrom:'scripts/fetch-stats.mjs',
  slugs,                                          // 가이드 수집기와 앱 링크가 함께 쓴다
  brackets:Object.fromEntries(Object.entries(brackets).map(([k,b])=>[k,{
    label:b.label,rows:countRows(b.stats),champions:Object.keys(b.stats).length,stats:b.stats
  }])),
  // Trend baseline travels with the data so the app can compute deltas for whichever
  // bracket it is showing, without shipping a second request.
  prev:base?{patch:base.patch,updated:base.updated,from:base.from,days:base.days,brackets:base.brackets}:null
};

/* ---------- report ---------- */
const summary=Object.entries(brackets)
  .map(([k,b])=>`${b.label} ${countRows(b.stats)}행/${Object.keys(b.stats).length}챔프`).join(' · ');
console.log(`patch ${payload.patch} · updated ${updated}`);
console.log(summary);
console.log(base?`trend baseline: ${base.patch} (${base.from}~${base.updated}, ${base.days}일 평균)`:'trend baseline: none (no previous patch archived)');
if(unknown.size){
  console.log('UNMAPPED (skipped, add to index.html champion DB):');
  for(const u of unknown)console.log('  - '+u);
}

if(dryRun){console.log('\n--dry-run: no files written');process.exit(unknown.size?2:0);}

if(!rebuild)fs.writeFileSync(archivePath,JSON.stringify(archive)+'\n');
// 오늘 아카이브까지 포함해 패치별 평균을 다시 만든다(현재 패치의 평균도 하루씩 자란다).
const byPatch=buildByPatch(olderArchives.concat([archive]),Object.keys(brackets));
byPatch.updated=updated;
fs.writeFileSync(path.join(DATA_DIR,'by-patch.json'),JSON.stringify(byPatch)+'\n');
fs.writeFileSync(path.join(DATA_DIR,'latest.json'),JSON.stringify(latest)+'\n');
fs.writeFileSync(path.join(ROOT,'stats.js'),statsJs);
console.log(rebuild?"\nrebuilt data/latest.json, data/by-patch.json, stats.js (archive untouched)":`\nwrote data/history/${updated}.json, data/latest.json, data/by-patch.json, stats.js`);
if(unknown.size)process.exitCode=2;
