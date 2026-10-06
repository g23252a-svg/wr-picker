/* 패치별 통계 묶음 (data/by-patch.json).
 *
 * 앱은 '엔진 자기 검증'에서 과거 판을 전부 다시 채점하고, 그 결과로 축 가중치까지
 * 자동 보정한다. v18 까지는 그 채점에 '오늘' 통계를 썼다 — 7월(7.2)에 한 판을
 * 10월(7.3a) 승률로 채점한 셈이다. 실사용 271판에서 그렇게 재면 메타 축의 순위
 * 일치도가 0.544(앱에서 제일 잘 맞히는 축)로 나오지만, 그 판을 기록할 때 앱이 쓰던
 * 패치의 통계로 재면 0.497 — 동전던지기다. 자동 보정은 앞의 숫자를 믿고 메타 축에
 * 발언권을 더 주고 있었다.
 *
 * 그래서 패치마다 그 패치 기간 아카이브의 평균을 남긴다. 앱은 판마다 기록된
 * patch(그 판을 고를 때 앱이 쓰던 통계의 패치)로 이 표를 찾아 채점한다.
 *
 * 형식은 작게: {patches:{"7.2b":{from,to,days,brackets:{diamond:{"Ahri":{"mid":[win,pick,ban,main?]}}}}}}
 * 행은 그 패치 기간 절반 이상의 날에 있었던 것만 남긴다(하루 이틀만 잡힌 저픽률 행은
 * 평균이 아니라 우연이다). */
/* keep: 남길 랭크 구간 키(현재 업스트림이 내는 구간). 예전 아카이브에만 있던 구간은
   앱이 고를 수 없으니 싣지 않는다. */
export function buildByPatch(archives,keep=null){
  const groups=new Map();
  for(const a of archives){
    if(!a||!a.patch||!a.brackets)continue;
    if(!groups.has(a.patch))groups.set(a.patch,[]);
    groups.get(a.patch).push(a);
  }
  const patches={};
  for(const [patch,list] of groups){
    list.sort((x,y)=>String(x.updated).localeCompare(String(y.updated)));
    const keys=new Set(list.flatMap(a=>Object.keys(a.brackets)).filter(k=>!keep||keep.includes(k)));
    const brackets={};
    for(const k of keys){
      const days=list.filter(a=>a.brackets[k]&&a.brackets[k].stats);
      if(!days.length)continue;
      const acc={};
      for(const a of days)for(const [name,roles] of Object.entries(a.brackets[k].stats))
        for(const [role,v] of Object.entries(roles)){
          const o=((acc[name]||(acc[name]={}))[role]||(acc[name][role]={w:0,p:0,b:0,n:0}));
          o.w+=v.win;o.p+=v.pick;o.b+=v.ban;o.n++;if(v.main)o.m=(o.m||0)+1;
        }
      const out={};
      for(const [name,roles] of Object.entries(acc))for(const [role,o] of Object.entries(roles)){
        if(o.n*2<days.length)continue;
        const r=x=>+(x/o.n).toFixed(2);
        // 4번째 칸은 주 라인 플래그 — 앱의 상대 라인 배정(laneFit)이 쓴다. 기간 절반 이상일 때만.
        (out[name]||(out[name]={}))[role]=(o.m||0)*2>=o.n?[r(o.w),r(o.p),r(o.b),1]:[r(o.w),r(o.p),r(o.b)];
      }
      if(Object.keys(out).length)brackets[k]=out;
    }
    if(!brackets.diamond)continue;
    patches[patch]={from:list[0].updated,to:list[list.length-1].updated,days:list.length,brackets};
  }
  return {v:1,patches};
}
