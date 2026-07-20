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
assert.equal(meta.patch,'7.2a');
assert.equal(meta.capturedAt,'2026-07-20');
assert.equal(meta.prevPatch,'7.2');
assert.equal(meta.prevCapturedAt,'2026-07-15');
assert.equal(meta.source,'https://www.wildriftfire.com/stats');
assert.equal(Object.keys(stats).length,meta.champions);
assert.equal(rows.length,meta.rows);
assert.equal(stats.Kayle.mid.win,55.83);
assert.equal(stats.Nunu.jug.win,53.75);
assert.equal(stats.Yunara.adc.pick,20.03);
assert.equal(stats['Master Yi'].jug.ban,55.54);
assert.equal(stats.Teemo.top.win,51.75);
assert.equal(stats.Teemo.mid.win,51.7);
assert.equal(prevStats.Nidalee.jug.win,53.42);
const allRows=rows.concat(Object.values(prevStats).flatMap(roles=>Object.entries(roles)));
for(const [role,s] of allRows){
  assert.ok(['top','jug','mid','adc','sup'].includes(role),`invalid role ${role}`);
  assert.ok(Number.isFinite(s.win)&&s.win>=0&&s.win<=100,'invalid win rate');
  assert.ok(Number.isFinite(s.pick)&&s.pick>=0&&s.pick<=100,'invalid pick rate');
  assert.ok(Number.isFinite(s.ban)&&s.ban>=0&&s.ban<=100,'invalid ban rate');
}
// Every current champion/role has trend coverage when it existed in the previous snapshot.
for(const [name,roles] of Object.entries(stats))
  for(const role of Object.keys(roles))
    if(prevStats[name]&&prevStats[name][role])
      assert.ok(Number.isFinite(prevStats[name][role].win),`bad prev row ${name}/${role}`);

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
assert.ok(html.includes("const APP_VERSION='4.2.0'"));
assert.ok(html.includes('function reliabilityOf(pick)'));
assert.ok(html.includes('function trendOf(c'));
assert.ok(html.includes('id="decisionSummary"'));
assert.equal(manifest.id,'./index.html');
assert.ok(manifest.display_override.includes('standalone'));
for(const asset of ['./index.html','./stats.js','./manifest.webmanifest','./icon.svg'])assert.ok(sw.includes(`'${asset}'`),`service worker missing ${asset}`);

console.log(`WR Picker smoke tests passed: ${champions.length} champions, ${rows.length} role rows.`);
