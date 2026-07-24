#!/usr/bin/env node
/* WR Picker stat pipeline.
 *
 * Pulls the WildRiftFire stats page, extracts the inline JSON payload that backs
 * its rank-bracket table, and emits three artifacts:
 *
 *   data/latest.json           every rank bracket, fetched by the app at runtime
 *   data/history/<date>.json   one archive per upstream "updated" date (trend source)
 *   stats.js                   Diamond+ snapshot bundled into the app shell as the
 *                              offline fallback, plus the previous archive for trends
 *
 * Usage:
 *   node scripts/fetch-stats.mjs                  fetch from the network
 *   node scripts/fetch-stats.mjs --from <file>    parse a saved page (offline testing)
 *   node scripts/fetch-stats.mjs --dry-run        report only, write nothing
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

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

function normaliseBracket(rows,known,unknown){
  const stats={};
  for(const r of rows){
    const name=RENAME[r.champion]||r.champion;
    const role=ROLE[r.role];
    if(!role){unknown.add(`role:${r.role}`);continue;}
    if(!known.has(name)){unknown.add(`champion:${r.champion}`);continue;}
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

function renderStatsJs({patch,updated,label,stats,prev,prevPatch,prevUpdated,sourceNote,brackets}){
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
  prevCapturedAt:${JSON.stringify(prevUpdated)}
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
const html=await loadPage();
const payload=extractPayload(html);
const known=championNames();
const unknown=new Set();

const brackets={};
for(const [key,b] of Object.entries(payload.brackets)){
  const rows=Array.isArray(b.rows)?b.rows:[];
  if(!rows.length)continue;                       // Legendary is empty until it populates
  brackets[key]={label:b.label,stats:normaliseBracket(rows,known,unknown)};
}
if(!brackets.diamond)throw new Error('Diamond+ bracket missing from payload');

const updated=payload.updated;
if(!/^\d{4}-\d{2}-\d{2}$/.test(updated||''))throw new Error(`unexpected updated date: ${updated}`);

// Archive this upstream revision, then find the newest strictly-older archive for trends.
fs.mkdirSync(HISTORY_DIR,{recursive:true});
const archivePath=path.join(HISTORY_DIR,`${updated}.json`);
const archive={patch:payload.patch,updated,source:payload.source,brackets};

const olderDates=fs.existsSync(HISTORY_DIR)
  ? fs.readdirSync(HISTORY_DIR).filter(f=>f.endsWith('.json')).map(f=>f.replace(/\.json$/,''))
      .filter(d=>d<updated).sort()
  : [];
const prevDate=olderDates[olderDates.length-1]||null;
let prevArchive=null;
if(prevDate){
  try{prevArchive=JSON.parse(fs.readFileSync(path.join(HISTORY_DIR,`${prevDate}.json`),'utf8'));}
  catch{prevArchive=null;}
}
// Fall back to whatever the bundled file already carries, so the very first run
// after this pipeline lands still has a trend baseline.
let prevStats=prevArchive&&prevArchive.brackets&&prevArchive.brackets.diamond
  ? prevArchive.brackets.diamond.stats : null;
let prevPatch=prevArchive?prevArchive.patch:null;
let prevUpdated=prevArchive?prevArchive.updated:null;
if(!prevStats){
  const bundled=path.join(ROOT,'stats.js');
  if(fs.existsSync(bundled)){
    const ctx={window:{}};
    new Function('window',fs.readFileSync(bundled,'utf8'))(ctx.window);
    const meta=ctx.window.WR_STATS_META||{};
    if(ctx.window.WR_ROLE_STATS&&meta.capturedAt&&meta.capturedAt<updated){
      prevStats=ctx.window.WR_ROLE_STATS;prevPatch=meta.patch;prevUpdated=meta.capturedAt;
    }
  }
}

const diamond=brackets.diamond;
const statsJs=renderStatsJs({
  patch:payload.patch,updated,label:diamond.label,stats:diamond.stats,
  prev:prevStats,prevPatch,prevUpdated,sourceNote:payload.source,
  brackets:Object.entries(brackets).map(([k,b])=>({key:k,label:b.label,rows:countRows(b.stats)}))
});

const latest={
  patch:payload.patch,updated,source:payload.source,url:SOURCE_URL,
  generatedFrom:'scripts/fetch-stats.mjs',
  brackets:Object.fromEntries(Object.entries(brackets).map(([k,b])=>[k,{
    label:b.label,rows:countRows(b.stats),champions:Object.keys(b.stats).length,stats:b.stats
  }])),
  // Trend baseline travels with the data so the app can compute deltas for whichever
  // bracket it is showing, without shipping a second request.
  prev:prevArchive?{
    patch:prevArchive.patch,updated:prevArchive.updated,
    brackets:Object.fromEntries(Object.entries(prevArchive.brackets||{})
      .map(([k,b])=>[k,{stats:b.stats}]))
  }:(prevStats?{patch:prevPatch,updated:prevUpdated,brackets:{diamond:{stats:prevStats}}}:null)
};

/* ---------- report ---------- */
const summary=Object.entries(brackets)
  .map(([k,b])=>`${b.label} ${countRows(b.stats)}행/${Object.keys(b.stats).length}챔프`).join(' · ');
console.log(`patch ${payload.patch} · updated ${updated}`);
console.log(summary);
console.log(prevUpdated?`trend baseline: ${prevPatch} (${prevUpdated})`:'trend baseline: none yet');
if(unknown.size){
  console.log('UNMAPPED (skipped, add to index.html champion DB):');
  for(const u of unknown)console.log('  - '+u);
}

if(dryRun){console.log('\n--dry-run: no files written');process.exit(unknown.size?2:0);}

fs.writeFileSync(archivePath,JSON.stringify(archive)+'\n');
fs.writeFileSync(path.join(DATA_DIR,'latest.json'),JSON.stringify(latest)+'\n');
fs.writeFileSync(path.join(ROOT,'stats.js'),statsJs);
console.log(`\nwrote data/history/${updated}.json, data/latest.json, stats.js`);
if(unknown.size)process.exitCode=2;
