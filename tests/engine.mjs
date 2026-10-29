/* [v20] 헤드리스 엔진 로더 — index.html 의 인라인 스크립트를 DOM/저장소 스텁과 함께 vm 에
   올리고, 내부 함수·상태를 돌려준다. 정규식으로 소스를 들여다보던 검사들을 '실제로
   돌려 보는' 검사로 바꾸기 위한 것이다(replayPass 가 옛 판을 오늘 통계로 채점하는
   돌연변이가 정규식 검사를 전부 통과했다). */
import fs from 'node:fs'; import vm from 'node:vm';
const HTML=new URL('../index.html',import.meta.url), STATS=new URL('../stats.js',import.meta.url);
export const EXPORTS=['byId','byEn','byKey','C','DB','score','state','pool','weights','matches','famMap','computeFam','effectiveComfort',
 'famComfort','perfValue','playCount','ROLE_STATS','assignEnemyLanes','laneOpponent','currentAssign','analysisModel',
 'axisReport','axisTrust','engineReplay','replayPass','rankAgreement','clamp','migrateMatch','sanitizeStatsPayload','sanitizeStatsTable',
 'sanitizeWeights','applyStatsPayload','trendOf','trendOffset','statOf','adoptByPatch','sanitizeByPatch','statsForMatch','META_SNAPSHOT',
 'firstPickFact','propDiffP','gamesToDecide','selP','meanDiffP','normCdf','invNorm','SIG_P','MIN_BUCKET','PERF','LANEKR',
 'sanitizeGuides','myMains','selfCheckKey','poolSig','canFlagTeam','verNum','TREND_BADGE','esc','hasOwn','matchTime','toStableId',
 'mergeMatches','computeExplorationLoad','FAMILIAR_BAND','appliedBracket','setComfort','invalidateSelfCheck','foldMatch'];
export function loadEngine(opts={}){
  let src=fs.readFileSync(opts.htmlPath||HTML,'utf8').match(/<script>([\s\S]*?)<\/script>\s*<\/body>/)[1];
  if(opts.patch)src=opts.patch(src);
  src=src.replace("const btn=document.getElementById('themeBtn');","const btn=null;");
  const stats=fs.readFileSync(opts.statsPath||STATS,'utf8');
  const el=()=>({textContent:'',innerHTML:'',style:{},classList:{add(){},remove(){},contains(){return false},toggle(){}},
    setAttribute(){},getAttribute(){return null},appendChild(){},addEventListener(){},querySelector(){return null},
    querySelectorAll(){return []},focus(){},scrollIntoView(){},remove(){},dataset:{},children:[],value:'',checked:false,hidden:false});
  const doc={getElementById:()=>el(),querySelector:()=>null,querySelectorAll:()=>[],createElement:()=>el(),
    addEventListener(){},body:el(),documentElement:el(),head:el()};
  const store={};
  const ls={getItem:k=>k in store?store[k]:null,setItem:(k,v)=>{store[k]=String(v)},removeItem:k=>{delete store[k]}};
  const storage={get:async k=>(k in store?{value:store[k]}:null),set:async(k,v)=>{store[k]=String(v)},delete:async k=>{delete store[k]}};
  const win={document:doc,localStorage:ls,storage,addEventListener(){},matchMedia:()=>({matches:false,addEventListener(){}}),
    location:{href:'',protocol:'https:',reload(){}},navigator:{serviceWorker:{register(){return Promise.resolve()},addEventListener(){}},onLine:true},
    fetch:()=>Promise.reject(new Error('offline')),setTimeout,clearTimeout,setInterval:()=>0,clearInterval,requestAnimationFrame:cb=>cb(0),
    confirm:()=>true,alert(){},prompt:()=>null,
    console,Date,Math,JSON,Object,Array,String,Number,Boolean,RegExp,Error,Map,Set,Promise,isFinite,isNaN,parseInt,parseFloat};
  win.window=win; win.globalThis=win; win.self=win;
  const ctx=vm.createContext(win);
  vm.runInContext(stats,ctx);
  vm.runInContext(src+'\n;globalThis.__E={'+EXPORTS.map(k=>k+":(typeof "+k+"!=='undefined')?"+k+":undefined").join(',')
    +',live:{get ROLE_STATS(){return ROLE_STATS},get matches(){return matches},get pool(){return pool},get GUIDES(){return GUIDES},get STATS_BY_PATCH(){return STATS_BY_PATCH},get explorationLoad(){return explorationLoad},get famMap(){return famMap}}};',ctx);
  return ctx.__E;
}
