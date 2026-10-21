/* Service worker: the app works with no signal, and live data is never served from a cache.
   - App files (index.html, manifest, icon): network first, so an update shows up as soon as you
     are online; the saved copy is used only when the network is unreachable.
   - Live data (Sleeper, ESPN scores, FantasyCalc, nflverse, the auto-update file) and pictures: never
     cached here. The app keeps its own copy of the data with the time it was fetched and labels
     it as saved data when offline - an old score is never shown as current. Pictures fall back
     to the colored position badge when offline.
   Bump CACHE_VERSION when you upload a new index.html (optional now, but it clears old files). */
const CACHE_VERSION = 'fantasy-v11-066bc5e8';   // set by build.py
const STATIC_CACHE = 'static-' + CACHE_VERSION;
const ASSETS = ['./', './index.html', './manifest.json', './icon.svg'];

self.addEventListener('install', function(e){
  e.waitUntil(caches.open(STATIC_CACHE).then(function(c){
    return c.addAll(ASSETS);
  }).then(function(){ return self.skipWaiting(); }));
});

self.addEventListener('activate', function(e){
  e.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.filter(function(k){ return k!==STATIC_CACHE; }).map(function(k){ return caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});

self.addEventListener('fetch', function(e){
  const req = e.request; if(req.method !== 'GET') return;
  const url = new URL(req.url);
  if(url.hostname !== self.location.hostname) return;       // live data, pictures: straight to the network
  if(/\.json$/i.test(url.pathname) && !/manifest\.json$/i.test(url.pathname)) return; // same-origin data: never cached
  // app files: network first, saved copy when offline
  e.respondWith(fetch(req).then(function(res){
    if(res && res.status === 200 && res.type === 'basic'){
      const copy = res.clone();
      caches.open(STATIC_CACHE).then(function(c){ return c.put(req, copy); }).catch(function(){ /* storage full: still works online */ });
    }
    return res;
  }).catch(function(){
    return caches.match(req).then(function(hit){ return hit || caches.match('./index.html'); });
  }));
});
