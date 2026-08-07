#!/usr/bin/env node
/* 챔피언 가이드 수집기.
 *
 * WildRiftFire의 챔피언별 가이드 페이지에서 앱이 바로 쓸 수 있는 정보만 추린다.
 *   - 한 줄 요약 (이 챔이 뭘 하는 챔인지)
 *   - 운영 챕터 (Early Game / Jungle Path / Late Game … 이름은 챔마다 다름)
 *   - 카운터 / 시너지 (사이트가 직접 명시한 것 — 우리가 추정한 값이 아님)
 *
 * 콤보·아이템 수치는 담지 않는다. 패치마다 바뀌고 잘못 적으면 실전에서 손해다.
 * 대신 앱에서 원문 가이드로 바로 갈 수 있는 링크를 제공한다.
 *
 * 통계와 달리 가이드는 패치 때나 바뀌므로 매일 돌릴 필요가 없다(주 1회).
 *
 * 사용법:
 *   node scripts/fetch-guides.mjs               전체 수집
 *   node scripts/fetch-guides.mjs --limit 5     앞 5개만 (동작 확인용)
 *   node scripts/fetch-guides.mjs --dry-run     저장하지 않음
 *   node scripts/fetch-guides.mjs --from <디렉터리>
 *       미리 받아둔 <slug>.html 들을 파싱 (네트워크가 막힌 환경에서 검증용)
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const BASE='https://www.wildriftfire.com/guide/';
const OUT=path.join(ROOT,'data','guides.json');
const DELAY_MS=350;                       // 상대 서버를 몰아치지 않는다

const args=process.argv.slice(2);
const argOf=n=>{const i=args.indexOf(n);return i>=0?args[i+1]:null;};
const dryRun=args.includes('--dry-run');
const limit=Number(argOf('--limit'))||0;
const fromDir=argOf('--from');

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const strip=s=>s.replace(/<[^>]+>/g,'').replace(/&#0?39;/g,"'").replace(/&amp;/g,'&')
  .replace(/&quot;/g,'"').replace(/&nbsp;/g,' ').replace(/&[a-z]+;/g,' ')
  .replace(/\s+/g,' ').trim();

/* slug는 추측하지 않는다. 통계 파이프라인이 업스트림에서 받아둔 값을 쓴다.
   이름에서 만들면 틀린다 — 예: "Nunu & Willump"의 실제 slug는 nunu-amp-willump. */
function roster(){
  const p=path.join(ROOT,'data','latest.json');
  if(!fs.existsSync(p))throw new Error('data/latest.json이 없습니다. 먼저 fetch-stats.mjs를 실행하세요.');
  const slugs=JSON.parse(fs.readFileSync(p,'utf8')).slugs;
  if(!slugs||!Object.keys(slugs).length)
    throw new Error('latest.json에 slugs가 없습니다. fetch-stats.mjs를 다시 실행하세요.');
  return Object.entries(slugs);                    // [[champion, slug], ...]
}

/* 영문 가이드 → 한글 전술 요점.
 * 문장을 통째로 번역하지 않는다(오역 위험). 가이드에서 반복적으로 쓰이는
 * 표현만 골라 한글 전술 문장으로 바꾼다. 매칭이 없으면 아무것도 만들지 않는다 —
 * 억지로 채우느니 비워두고 원문 링크로 보내는 편이 정확하다. */
const KO_RULES=[
  [/(weak|struggle\w*|difficult|hard time)[^.]{0,40}\bearly/i,'초반이 약함 — 무리한 교전 대신 안전 파밍'],
  [/\bfarm\b[^.]{0,40}(minion|safe)|as many minions/i,'CS 우선 — 미니언 놓치지 말 것'],
  [/(scale|stronger|powerful|strongest)[^.]{0,40}(late|later)/i,'후반 캐리형 — 시간이 갈수록 강해짐'],
  [/(core item|complete|first item|two items)/i,'코어 아이템 완성이 분기점'],
  [/team ?fight/i,'한타 기여가 핵심'],
  [/\bpoke\b|harass/i,'견제로 체력 깎아두기'],
  [/\broam(ing)?\b/i,'로밍으로 다른 라인에 영향력'],
  [/split ?push|side ?lane/i,'사이드 스플릿 운영'],
  [/(push|shove|clear)[^.]{0,25}wave/i,'웨이브 관리로 주도권 확보'],
  [/(get caught|caught out|out of position|by yourself)/i,'단독 이동 주의 — 잘리면 한타 붕괴'],
  [/(engage|initiate|start the fight)/i,'이니시에이팅 담당'],
  [/(peel|protect)[^.]{0,30}(carry|ally|team)/i,'아군 캐리 보호가 우선'],
  [/(dragon|baron|rift herald|objective)/i,'오브젝트 타이밍 중심 운영'],
  [/\bgank/i,'갱킹으로 라인 개입'],
  [/(dive|all-?in|burst)[^.]{0,30}(squishy|carry|back ?line)/i,'뒷라인 진입해 캐리 처리'],
  [/(crowd control|\bcc\b|stun|knock ?up)/i,'CC 적중이 한타 성패를 가름'],
  [/(sustain|heal|lifesteal)/i,'지속력으로 라인 유지'],
  [/(mobility|dash|escape|reposition)/i,'기동력으로 각 잡고 빠지기'],
  [/(tank|frontline|soak damage)/i,'프론트라인으로 피해 흡수'],
  [/(ambush|invisible|stealth)/i,'시야 밖에서 기습'],
];
function toKorean(text){
  if(!text)return [];
  const out=[];
  for(const [re,ko] of KO_RULES)if(re.test(text)&&!out.includes(ko))out.push(ko);
  return out.slice(0,5);
}

function parseGuide(h){
  const out={};
  // 카운터/시너지는 각각 고유 클래스를 가진다. 사이트가 명시한 값만 담는다.
  const pick=cls=>{
    const m=h.match(new RegExp('class="data-mod counters-mod '+cls+'"([\\s\\S]*?)(?=<h2|<\\/section)'));
    if(!m)return [];
    const slugs=[...m[1].matchAll(/href="\/guide\/([a-z0-9-]+)"/g)].map(x=>x[1]);
    const lanes=[...m[1].matchAll(/lanes\/white-([a-z]+)\.png/g)].map(x=>x[1]);
    return slugs.map((s,i)=>({slug:s,lane:lanes[i]||null}));
  };
  const cb=pick('counters'), sy=pick('synergies');
  if(cb.length)out.counteredBy=cb;
  if(sy.length)out.synergy=sy;

  const hp=h.match(/How to play [^<]*<\/h2>([\s\S]*?)(?=<h2|$)/i);
  if(hp){
    const t=strip(hp[1]);
    if(t.length>40){
      out.summary=t.slice(0,340);
      const ko=toKorean(t); if(ko.length)out.summaryKo=ko;
    }
  }

  /* 운영 챕터 — 제목이 챔마다 다르다(Early Game / Jungle Path / Laning …).
     고정 이름을 가정하지 않고 Build Breakdown 이후 본문을 그대로 수집한다. */
  const bd=h.indexOf('Build Breakdown');
  if(bd>0){
    const tail=h.slice(bd);
    const end=tail.search(/PATCH HISTORY/i);
    const body=end>0?tail.slice(0,end):tail;
    const parts=[...body.matchAll(/<h2[^>]*>([^<]{1,60})<\/h2>([\s\S]*?)(?=<h2|$)/g)];
    const PHASE_KO={'Early Game':'초반','Mid Game':'중반','Late Game':'후반',
      'Jungle Path':'정글 동선','Laning':'라인전','Laning Phase':'라인전'};
    const ch=parts.map(p=>{
      const t=strip(p[1]), d=strip(p[2]).slice(0,420);
      return {t,tKo:PHASE_KO[t]||t,d,ko:toKorean(d)};
    }).filter(c=>c.d.length>60&&!/Build Breakdown|Conclusion/i.test(c.t)).slice(0,4);
    if(ch.length)out.chapters=ch;
  }
  return out;
}

const all=roster();
const targets=limit?all.slice(0,limit):all;
const guides={}; const missing=[]; const empty=[];

for(let i=0;i<targets.length;i++){
  const [name,slug]=targets[i];
  try{
    let html;
    if(fromDir){
      const f=path.join(fromDir,slug+'.html');
      if(!fs.existsSync(f)){missing.push(`${name} (${slug}) 파일 없음`);continue;}
      html=fs.readFileSync(f,'utf8');
    }else{
      const res=await fetch(BASE+slug,{headers:{
        'User-Agent':'wr-picker-guide-bot/1.0 (+https://github.com/g23252a-svg/wr-picker)',
        'Accept':'text/html'}});
      if(!res.ok){missing.push(`${name} (${slug}) HTTP ${res.status}`);continue;}
      html=await res.text();
    }
    const g=parseGuide(html);
    if(!g.summary&&!g.chapters&&!g.counteredBy)empty.push(`${name} (${slug})`);
    else guides[name]=Object.assign({slug},g);
  }catch(e){missing.push(`${name} (${slug}) ${e.message}`);}
  finally{
    if(i%20===19)console.log(`  ...${i+1}/${targets.length}`);
    if(!fromDir)await sleep(DELAY_MS);
  }
}

console.log(`수집 ${Object.keys(guides).length} / ${targets.length}`);
if(missing.length){console.log('가져오지 못함:');missing.forEach(m=>console.log('  - '+m));}
if(empty.length){console.log('내용 없음(구조 변경 가능):');empty.forEach(m=>console.log('  - '+m));}

if(dryRun){console.log('\n--dry-run: 저장하지 않음');process.exit(0);}
// 절반 이상 실패하면 기존 파일을 덮지 않는다(사이트 구조 변경 시 데이터 보호).
if(Object.keys(guides).length < targets.length*0.5){
  console.error('수집 성공률이 50% 미만입니다. 기존 guides.json을 유지합니다.');
  process.exit(1);
}
fs.mkdirSync(path.dirname(OUT),{recursive:true});
fs.writeFileSync(OUT,JSON.stringify({
  source:'https://www.wildriftfire.com/guide/',
  note:'가이드 원문 요약. 콤보·아이템 수치는 담지 않으며 앱에서 원문 링크로 연결한다.',
  champions:guides
})+'\n');
console.log(`\nwrote data/guides.json (${(fs.statSync(OUT).size/1024).toFixed(0)}KB)`);
