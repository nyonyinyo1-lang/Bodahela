const V='boda-hela-v26';
const ASSETS=['/','/index.html','/manifest.webmanifest','/icon-192.png','/icon-512.png','/icon-maskable-512.png','/apple-touch-icon.png','/splash-poster.jpg'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(V).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==V).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{
  const r=e.request;
  if(r.method!=='GET')return;               // clock-sync HEAD request goes straight to the network
  const u=new URL(r.url);
  if(u.origin!==location.origin||u.pathname.startsWith('/api/')||u.pathname.endsWith('.mp4'))return;     // fonts etc. handled by the browser
  if(r.mode==='navigate'){
    e.respondWith(fetch(r).then(res=>{const cp=res.clone();caches.open(V).then(c=>c.put('/',cp));return res}).catch(()=>caches.match('/')));
    return;
  }
  e.respondWith(caches.match(r).then(hit=>hit||fetch(r).then(res=>{if(res.ok){const cp=res.clone();caches.open(V).then(c=>c.put(r,cp))}return res})));
});
