#!/usr/bin/env node
/* 패치 추세 보고서 — "이 챔피언, 새 패치에서 실제로 달라졌나?"를 data/history 만으로 답한다.
 *
 * 사용:  node scripts/trend-report.mjs 말파이트 애쉬              (기본 Diamond+)
 *        node scripts/trend-report.mjs Malphite --bracket=master
 *        node scripts/trend-report.mjs 말파이트 애쉬 --all-brackets
 *        node scripts/trend-report.mjs 말파이트 --json
 *
 * 재는 것
 *   기준선  직전 패치 마지막 3일 평균 — scripts/trend-baseline.mjs 와 같은 계산이라 앱 배지와 같은 기준
 *   현재    현재 패치 아카이브 전부의 평균. 일자별 값도 같이 보여 준다
 *   보정    전체 챔피언의 승률 변화를 픽률 가중 평균한 값을 뺀 것 — 앱의 trendOffset 과 같은 식
 *   노이즈  직전 패치 안에서 그 행의 하루 값이 움직인 폭(SD, 최소~최대)과 전체 행을 모은 pooled SD
 *   판정    현재 패치 아카이브가 3일 이상이고, 보정 변화가 2×SD 밖이고, 현재 평균이 직전 패치의
 *           하루 값 범위 밖일 때만 "노이즈 밖". 그 전에는 변화라고 말하지 않는다
 *
 * 재지 않는 것
 *   왜 바뀌었는지(패치 노트와의 인과). 내 판에서의 변화(백업을 따로 봐야 한다).
 *   업스트림 표가 며칠 창을 굴리는지 모른다 — 패치 첫날부터 값이 조금씩 한 방향으로 끌려가면
 *   이전 패치 판이 섞여 있다는 뜻이고, 그만큼 변화는 실제보다 작게 보인다. 일자별 값을 보라. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {patchBaseline} from './trend-baseline.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const MIN_PICK=1;        // 앱과 같다: 양쪽 픽률 1% 이상인 행만 추세를 믿는다
export const MIN_DAYS=3;        // 현재 패치 아카이브가 이보다 적으면 판정하지 않는다

const mean=xs=>xs.reduce((s,x)=>s+x,0)/xs.length;
const sd=xs=>xs.length>1?Math.sqrt(xs.reduce((s,x)=>s+(x-mean(xs))**2,0)/(xs.length-1)):0;
const r2=x=>Math.round(x*100)/100;
const sgn=x=>(x>0?'+':'')+r2(x).toFixed(2);

export function loadArchives(dir=path.join(ROOT,'data','history')){
  return fs.readdirSync(dir).filter(f=>/^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort()
    .map(f=>JSON.parse(fs.readFileSync(path.join(dir,f),'utf8')))
    .filter(a=>a&&typeof a.patch==='string'&&a.brackets)
    .sort((a,b)=>a.updated<b.updated?-1:a.updated>b.updated?1:0);
}

/* 앱의 trendOffset 과 같은 식: 양쪽 픽률 1% 이상인 행의 승률 변화를 현재 픽률로 가중 평균. */
export function fieldOffset(cur,base){
  let s=0,w=0;
  for(const [name,roles] of Object.entries(cur))for(const [role,v] of Object.entries(roles)){
    const p=base[name]&&base[name][role];
    if(!p||v.pick<MIN_PICK||p.pick<MIN_PICK)continue;
    s+=(v.win-p.win)*v.pick;w+=v.pick;
  }
  return w>0?s/w:0;
}

/* 여러 날의 표를 행별로 평균. 어떤 날에 없는 행은 있는 날만으로 평균하고 days 에 날 수를 적는다. */
export function averageStats(list){
  const out={};
  for(const name of new Set(list.flatMap(s=>Object.keys(s)))){
    for(const role of new Set(list.flatMap(s=>Object.keys(s[name]||{})))){
      const rows=list.map(s=>s[name]&&s[name][role]).filter(Boolean);
      if(!rows.length)continue;
      (out[name]||(out[name]={}))[role]={win:r2(mean(rows.map(r=>r.win))),pick:r2(mean(rows.map(r=>r.pick))),
        ban:r2(mean(rows.map(r=>r.ban))),days:rows.length};
    }
  }
  return out;
}

/* 직전 패치 안의 하루 값 노이즈. 행별 {n,sd,min,max,mean} 과, 픽률 1% 이상 행을 모은 pooled SD. */
export function noiseTable(list){
  const per={}; let ss=0,df=0;
  for(const name of new Set(list.flatMap(s=>Object.keys(s)))){
    for(const role of new Set(list.flatMap(s=>Object.keys(s[name]||{})))){
      const rows=list.map(s=>s[name]&&s[name][role]).filter(Boolean);
      if(rows.length<2)continue;
      const w=rows.map(r=>r.win), m=mean(w);
      (per[name]||(per[name]={}))[role]={n:w.length,sd:sd(w),min:Math.min(...w),max:Math.max(...w),mean:m};
      if(rows.every(r=>r.pick>=MIN_PICK)){ss+=w.reduce((s,x)=>s+(x-m)**2,0);df+=w.length-1;}
    }
  }
  return {per,pooledSd:df>0?Math.sqrt(ss/df):0};
}

/* archives: loadArchives() 결과(오래된 순). targets: 영문 이름 배열. */
export function trendReport(archives,targets,{bracket='diamond'}={}){
  if(!archives.length)return null;
  const patch=archives[archives.length-1].patch;
  const base=patchBaseline(archives,patch);
  const has=a=>a.brackets[bracket]&&a.brackets[bracket].stats;
  const curArcs=archives.filter(a=>a.patch===patch&&has(a));
  if(!base||!base.brackets[bracket]||!curArcs.length)
    return {patch,bracket,prevPatch:base?base.patch:null,days:curArcs.map(a=>a.updated),rows:[],error:'기준선(직전 패치) 또는 현재 패치 아카이브가 없음'};
  const prevArcs=archives.filter(a=>a.patch===base.patch&&has(a));
  const B=base.brackets[bracket].stats;
  const curList=curArcs.map(a=>a.brackets[bracket].stats);
  const cur=averageStats(curList);
  const offset=fieldOffset(cur,B);
  const noise=noiseTable(prevArcs.map(a=>a.brackets[bracket].stats));
  const field=[];                                   // 전체 분포: 보정 변화, 양쪽 픽률 1% 이상
  for(const [name,roles] of Object.entries(cur))for(const [role,v] of Object.entries(roles)){
    const p=B[name]&&B[name][role]; if(!p||v.pick<MIN_PICK||p.pick<MIN_PICK)continue;
    field.push({name,role,dc:v.win-p.win-offset});
  }
  field.sort((a,b)=>a.dc-b.dc);
  const rows=[];
  for(const name of targets){
    const roles=new Set([...Object.keys(cur[name]||{}),...Object.keys(B[name]||{})]);
    if(!roles.size){rows.push({name,bracket,missing:true,verdict:'이 구간 표에 없음'});continue;}
    for(const role of roles){
      const v=cur[name]&&cur[name][role], p=B[name]&&B[name][role];
      const days=curArcs.map(a=>{const r=a.brackets[bracket].stats[name]; const x=r&&r[role];
        return x?{updated:a.updated,win:x.win,pick:x.pick,ban:x.ban}:{updated:a.updated};});
      if(!v||!p){rows.push({name,role,bracket,base:p||null,avg:v||null,days,verdict:'기준선 또는 현재 값 없음'});continue;}
      const nz=(noise.per[name]&&noise.per[name][role])||{n:0,sd:0,min:p.win,max:p.win,mean:p.win};
      const d=v.win-p.win, dc=d-offset, band=2*Math.max(nz.sd,noise.pooledSd);
      const outsideRange=v.win<nz.min||v.win>nz.max;
      const lowPick=v.pick<MIN_PICK||p.pick<MIN_PICK;
      const idx=field.findIndex(f=>f.name===name&&f.role===role);
      const pct=idx>=0?Math.round(100*idx/Math.max(1,field.length-1)):null;
      let verdict;
      if(lowPick)verdict='픽률 1% 미만 — 판단 보류';
      else if(curArcs.length<MIN_DAYS)verdict=`현재 패치 아카이브 ${curArcs.length}일 — ${MIN_DAYS}일 미만, 판단 보류`;
      else if(Math.abs(dc)>band&&outsideRange)verdict=dc<0?'노이즈 밖 — 하락':'노이즈 밖 — 상승';
      else verdict='노이즈 안 — 변화라고 말할 수 없음';
      rows.push({name,role,bracket,base:{win:p.win,pick:p.pick,ban:p.ban},avg:{win:v.win,pick:v.pick,ban:v.ban,days:v.days},days,
        delta:{win:r2(d),pick:r2(v.pick-p.pick),ban:r2(v.ban-p.ban)},centered:r2(dc),band:r2(band),
        noise:{n:nz.n,sd:r2(nz.sd),min:nz.min,max:nz.max,pooledSd:r2(noise.pooledSd)},outsideRange,pct,verdict});
    }
  }
  const bb=base.brackets[bracket];
  return {patch,bracket,prevPatch:base.patch,baseline:{from:bb.from,updated:bb.updated,days:bb.days},
    days:curArcs.map(a=>a.updated),offset:{avg:r2(offset),perDay:curList.map(s=>r2(fieldOffset(s,B)))},fieldRows:field.length,rows};
}

/* index.html 의 챔피언 표에서 한글 이름·별명 → 영문 이름. (DB 는 앱 안에만 있다.) */
export function nameMap(htmlPath=path.join(ROOT,'index.html')){
  const html=fs.readFileSync(htmlPath,'utf8'), m=new Map(), un=s=>s.replace(/\\'/g,"'");
  for(const [,ko,en] of html.matchAll(/\['([가-힣A-Za-z0-9 .&]+)','((?:[^'\\]|\\.)+)',\[/g)){m.set(ko,un(en));m.set(un(en).toLowerCase(),un(en));}
  for(const [,en,al] of html.matchAll(/'((?:[^'\\]|\\.)+)':\[((?:'[가-힣]+',?)+)\]/g))
    for(const a of al.match(/'[가-힣]+'/g)||[])m.set(a.slice(1,-1),un(en));
  return m;
}

const md=s=>s?s.slice(5):'?';
export function formatReport(rep,label=n=>n){
  if(!rep)return '아카이브 없음';
  const L=[];
  if(rep.error){L.push(`${rep.patch} · ${rep.bracket}: ${rep.error}`);return L.join('\n');}
  L.push(`패치 추세 — ${rep.patch} (아카이브 ${rep.days.length}일: ${rep.days.map(md).join(', ')}) vs ${rep.prevPatch} 마지막 ${rep.baseline.days}일(${md(rep.baseline.from)}~${md(rep.baseline.updated)}) · ${rep.bracket}`);
  L.push(`  전체 보정(픽 가중 평균 승률 변화) ${sgn(rep.offset.avg)}%p · 일자별 ${rep.offset.perDay.map(sgn).join(' ')} · 비교 행 ${rep.fieldRows}`);
  for(const r of rep.rows){
    if(!r.delta){L.push(`${label(r.name)}${r.role?' '+r.role:''}: ${r.verdict}`);continue;}
    L.push(`${label(r.name)} ${r.role}  승률 ${r.base.win.toFixed(2)} → ${r.avg.win.toFixed(2)} (${sgn(r.delta.win)}, 보정 ${sgn(r.centered)})  픽 ${r.base.pick}→${r.avg.pick} (${sgn(r.delta.pick)})  밴 ${r.base.ban}→${r.avg.ban} (${sgn(r.delta.ban)})`);
    L.push(`    일자별 ${r.days.map(x=>`${md(x.updated)} ${x.win==null?'—':x.win.toFixed(2)}`).join(' | ')}`);
    L.push(`    ${rep.prevPatch} 하루 폭 ${r.noise.min.toFixed(2)}~${r.noise.max.toFixed(2)} (SD ${r.noise.sd.toFixed(2)}, ${r.noise.n}일; 전체 pooled SD ${r.noise.pooledSd.toFixed(2)}) · 판정 띠 ±${r.band.toFixed(2)} · 범위 ${r.outsideRange?'밖':'안'}${r.pct==null?'':` · 전체 중 하위 ${r.pct}%`}`);
    L.push(`    판정: ${r.verdict}`);
  }
  return L.join('\n');
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2), opt={bracket:'diamond',all:false,json:false,dir:undefined};
  const names=[];
  for(const a of args){
    if(a.startsWith('--bracket='))opt.bracket=a.slice(10);
    else if(a==='--all-brackets')opt.all=true;
    else if(a==='--json')opt.json=true;
    else if(a.startsWith('--dir='))opt.dir=a.slice(6);
    else names.push(a);
  }
  if(!names.length){console.error('사용: node scripts/trend-report.mjs <챔피언…> [--bracket=diamond|master|challenger|apex] [--all-brackets] [--json]');process.exit(2);}
  const nm=nameMap(), back=new Map();
  for(const [k,v] of nm)if(/^[가-힣]/.test(k)&&!back.has(v)&&k.length>1)back.set(v,k);
  const targets=[], unknown=[];
  for(const n of names){const en=nm.get(n)||nm.get(n.toLowerCase());if(en)targets.push(en);else unknown.push(n);}
  if(unknown.length){console.error(`모르는 이름: ${unknown.join(', ')}`);if(!targets.length)process.exit(2);}
  const archives=loadArchives(opt.dir);
  const brackets=opt.all?[...new Set(archives.flatMap(a=>Object.keys(a.brackets)))]:[opt.bracket];
  const reps=brackets.map(b=>trendReport(archives,targets,{bracket:b}));
  if(opt.json)console.log(JSON.stringify(reps.length===1?reps[0]:reps,null,1));
  else console.log(reps.map(r=>formatReport(r,n=>back.has(n)?`${back.get(n)}(${n})`:n)).join('\n\n'));
}
