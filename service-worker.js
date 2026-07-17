const CACHE = 'helpsni-v06-online';
const ASSETS = ['./','index.html','styles.css','app.js','mascot.png','logo-icon.png','favicon.png','icon-192.png','icon-512.png','manifest.webmanifest'];
self.addEventListener('install', event => { self.skipWaiting(); event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS))); });
self.addEventListener('activate', event => { event.waitUntil(Promise.all([caches.keys().then(keys => Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))), self.clients.claim()])); });
self.addEventListener('fetch', event => {
  if(event.request.method!=='GET') return;
  event.respondWith(fetch(event.request).then(response => { const copy=response.clone(); caches.open(CACHE).then(cache=>cache.put(event.request,copy)); return response; }).catch(()=>caches.match(event.request).then(hit=>hit||caches.match('./'))));
});
self.addEventListener('push', event => {
  let payload={title:'Helpsni',body:'Máte nové upozornění.',url:'./'};
  try { payload={...payload,...event.data.json()}; } catch { if(event.data) payload.body=event.data.text(); }
  event.waitUntil(self.registration.showNotification(payload.title,{body:payload.body,icon:'icon-192.png',badge:'favicon.png',data:{url:payload.url||'./',jobId:payload.jobId||null}}));
});
self.addEventListener('notificationclick', event => {
  event.notification.close(); const url=event.notification.data?.url||'./';
  event.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{for(const client of list){if('focus' in client)return client.focus();}return clients.openWindow(url);}));
});
