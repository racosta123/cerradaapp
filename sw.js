const CACHE='cerradaapp-v2';
const ASSETS=['/cerradaapp/','/cerradaapp/index.html'];

self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(keys=>
    Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch',e=>{
  const url = new URL(e.request.url);
  
  // NO interceptar URLs con ?reg= — dejar que lleguen a la página con el payload
  if(url.searchParams.has('reg')){
    e.respondWith(fetch(e.request));
    return;
  }
  
  e.respondWith(
    fetch(e.request)
      .then(res=>{
        const clone=res.clone();
        caches.open(CACHE).then(cache=>cache.put(e.request,clone));
        return res;
      })
      .catch(()=>caches.match(e.request))
  );
});
