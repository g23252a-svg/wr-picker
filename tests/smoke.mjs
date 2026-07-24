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
assert.ok(html.includes("const APP_VERSION='5.1.0'"));
assert.ok(html.includes('function reliabilityOf(pick)'));
assert.ok(html.includes('function trendOf(c'));
assert.ok(html.includes('async function refreshStats()'),'runtime stat refresh missing');
assert.ok(html.includes("const DATA_ENDPOINT="),'data endpoint missing');
assert.ok(html.includes('id="decisionSummary"'));
assert.ok(html.includes('상대 칩 이름을 탭하면'),'laner-mark hint missing');
assert.ok(html.includes('class="chip.marked') || /chip\.marked|chip'\+\(marked/.test(html),'marked chip state missing');
assert.ok(sw.includes("pathname.includes('/data/')"),'service worker must bypass cache for stat data');
assert.equal(manifest.id,'./index.html');
assert.ok(manifest.display_override.includes('standalone'));
for(const asset of ['./index.html','./stats.js','./manifest.webmanifest','./icon.svg'])assert.ok(sw.includes(`'${asset}'`),`service worker missing ${asset}`);

console.log(`WR Picker smoke tests passed: ${champions.length} champions, ${rows.length} role rows.`);
