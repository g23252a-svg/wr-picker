const CACHE='wr-picker-v5.1.0';
const OFFLINE='./index.html';
const ASSETS=['./','./index.html','./stats.js','./manifest.webmanifest','./icon.svg'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS))));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('message',event=>{if(event.data&&event.data.type==='SKIP_WAITING')self.skipWaiting();});
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET'||new URL(event.request.url).origin!==location.origin)return;
  const isNavigation=event.request.mode==='navigate';
  // 통계 payload는 매일 갱신되므로 반드시 네트워크 우선. 앱 셸만 캐시 우선.
  const isData=new URL(event.request.url).pathname.includes('/data/');
  const networkFirst=target=>fetch(event.request)
    .then(response=>{if(response.ok){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(target||event.request,copy));}return response;})
    .catch(()=>caches.match(target||event.request));
  event.respondWith((isNavigation
    ? networkFirst(OFFLINE).then(r=>r||caches.match(OFFLINE))
    : isData
    ? networkFirst().then(r=>r||Response.error())
    : caches.match(event.request).then(cached=>cached||fetch(event.request).then(response=>{if(response.ok){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(event.request,copy));}return response;}))
  ));
});
