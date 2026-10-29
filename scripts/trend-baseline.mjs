/* 추세 기준선 = '직전 패치'의 마지막 며칠 평균.
 *
 * v18 까지는 바로 전날 아카이브를 기준선으로 썼고, 앱은 그 차이를 "직전 패치 대비",
 * "패치 상승세"라고 불렀다. 그런데 같은 패치 안의 하루 변화는 다음 날 되돌아간다
 * (data/history 71일, 11,151쌍: 다음 날 변화에 대한 회귀계수 −0.27). 반대로
 * 패치 경계를 넘는 변화(직전 패치 마지막 3일 평균 → 새 패치 첫 이틀)는 그 뒤로도
 * 같은 방향으로 이어진다(1,022쌍: +0.27 ± 0.04). 이름과 달리 '어제 대비'를 보여주며
 * 노이즈에 거꾸로 베팅하고 있었던 셈이다.
 *
 * 그래서 기준선은 현재 패치와 다른 가장 최근 패치에서, 그 패치의 마지막
 * BASELINE_DAYS 개 아카이브를 평균한다(하루치 노이즈를 줄이려고). 앱의 추세 계산은
 * 그대로 '지금 − 기준선' 이다.
 *
 * [v20] 창은 구간마다 따로 잡는다. 날짜로 마지막 3일을 고른 뒤 그 안에 없는 구간을
 * 버리던 v19 는, 업스트림이 9-24~10-07 동안 Challenger/Legendary 표를 빼먹자 7.3a 내내
 * 그 두 구간의 추세를 비우고 "직전 패치 기록 없음"이라고 적었다 — 7.3 의 9-22·9-23
 * 아카이브에는 그 구간이 있었다. */
export const BASELINE_DAYS=3;

/* archives: 오래된 순으로 정렬된 아카이브 목록 [{patch,updated,brackets:{key:{stats}}}].
 * 현재 패치의 아카이브가 섞여 있어도 건너뛴다. 직전 패치가 없으면 null — 추세를
 * 지어내느니 비워 둔다. 구간마다 {stats,from,updated,days} 를 담고, 최상위
 * from/updated/days 는 Diamond+ 창의 것이다. */
export function patchBaseline(archives,currentPatch,days=BASELINE_DAYS){
  let j=archives.length-1;
  while(j>=0&&archives[j].patch===currentPatch)j--;
  if(j<0)return null;
  const patch=archives[j].patch;
  const prev=[];                                   // 직전 패치의 아카이브, 최신 순
  for(let q=j;q>=0&&archives[q].patch===patch;q--)prev.push(archives[q]);
  const keys=new Set(prev.flatMap(a=>Object.keys(a.brackets||{})));
  const brackets={};
  for(const k of keys){
    // 이 구간이 실제로 들어 있는 마지막 days 개 아카이브
    const win=prev.filter(a=>a.brackets&&a.brackets[k]&&a.brackets[k].stats).slice(0,days);
    if(!win.length)continue;
    const src=win.map(a=>a.brackets[k].stats);
    const out={};
    for(const [name,roles] of Object.entries(src[0]))for(const role of Object.keys(roles)){
      const rows=src.map(s=>s[name]&&s[name][role]).filter(Boolean);
      // 며칠 중 하루라도 빠진 행은 평균을 내지 않는다 — 날짜마다 다른 표본이 섞인다.
      if(rows.length!==src.length)continue;
      const avg=f=>+(rows.reduce((s,r)=>s+r[f],0)/rows.length).toFixed(2);
      // 픽률은 최솟값: 앱은 '양쪽 픽률 1% 이상'일 때만 추세를 믿으므로 보수적으로 둔다.
      (out[name]||(out[name]={}))[role]={win:avg('win'),pick:+Math.min(...rows.map(r=>r.pick)).toFixed(2),ban:avg('ban')};
    }
    if(!Object.keys(out).length)continue;
    brackets[k]={stats:out,updated:win[0].updated,from:win[win.length-1].updated,days:win.length};
  }
  if(!brackets.diamond)return null;
  const d=brackets.diamond;
  return {patch,updated:d.updated,from:d.from,days:d.days,brackets};
}
