/* 鉄の帳簿 — オフライン用キャッシュ。
   アプリ本体は同一オリジンから先読みし、Webフォントは見かけたぶんだけ拾う。
   記録そのものは localStorage にあるので、ここが消えてもデータは失われない。 */
var CACHE = "iron-ledger-v2";
var SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./data.js",
  "./app.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
  "./apple-touch-icon.png"
];

self.addEventListener("install", function(e){
  e.waitUntil(
    caches.open(CACHE)
      .then(function(c){ return c.addAll(SHELL); })
      .then(function(){ return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.map(function(k){
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function(){ return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function(e){
  var req = e.request;
  if (req.method !== "GET") return;

  var url = new URL(req.url);
  var sameOrigin = url.origin === self.location.origin;
  var isFont = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  if (!sameOrigin && !isFont) return;

  e.respondWith(
    caches.match(req).then(function(hit){
      if (hit) return hit;                                   // キャッシュ優先＝圏外でも起動する
      return fetch(req).then(function(res){
        // opaque（フォント）も含めて保存する。status 0 でも put できる
        var copy = res.clone();
        caches.open(CACHE).then(function(c){ c.put(req, copy); }).catch(function(){});
        return res;
      }).catch(function(){
        // ナビゲーションだけは必ずアプリ本体を返す
        if (req.mode === "navigate") return caches.match("./index.html");
        return new Response("", {status: 504, statusText: "offline"});
      });
    })
  );
});
