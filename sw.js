/* 鉄の帳簿 — オフライン用キャッシュ。
   記録そのものは localStorage にあるので、ここが消えてもデータは失われない。

   配り方は stale-while-revalidate。
   まずキャッシュを即返して（圏外でも起動する）、裏で取り直して次回に備える。
   → 2026-09-21、キャッシュ優先だけで組んでいたため、CACHE の値を上げ忘れた
     修正が端末に永久に届かなかった。版上げを人間が覚えている前提にしない。 */
var CACHE = "iron-ledger-v3";
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

function store(req, res){
  if (!res || res.status !== 200) return res;
  var copy = res.clone();
  caches.open(CACHE).then(function(c){ c.put(req, copy); }).catch(function(){});
  return res;
}
function offline(req){
  if (req.mode === "navigate") return caches.match("./index.html");
  return new Response("", {status: 504, statusText: "offline"});
}

self.addEventListener("fetch", function(e){
  var req = e.request;
  if (req.method !== "GET") return;

  var url = new URL(req.url);
  var sameOrigin = url.origin === self.location.origin;
  var isFont = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  if (!sameOrigin && !isFont) return;

  if (sameOrigin){
    /* アプリ本体。キャッシュを即返しつつ、必ず裏で取り直す。
       押し付けがましい再読み込みはしない。次に開いたときに新しくなる。

       cache:"no-cache" は「毎回サーバに確認する」であって「毎回落とす」ではない。
       付けないとブラウザのHTTPキャッシュ（GitHub Pages は max-age=600）を掴んで、
       裏で取り直しているつもりが古いままになる。変わっていなければ 304 で済む。
       ナビゲーションの Request はそのまま複製できないので URL から組み直す。 */
    var net = fetch(new Request(req.url, {cache:"no-cache", credentials:"same-origin"}))
      .then(function(res){ return store(req, res); });
    e.waitUntil(net.catch(function(){}));
    e.respondWith(
      caches.match(req).then(function(hit){
        return hit || net.catch(function(){ return offline(req); });
      })
    );
    return;
  }

  /* Webフォントは中身が変わらないのでキャッシュ優先のまま。
     opaque（status 0）も含めて保存する。 */
  e.respondWith(
    caches.match(req).then(function(hit){
      if (hit) return hit;
      return fetch(req).then(function(res){
        var copy = res.clone();
        caches.open(CACHE).then(function(c){ c.put(req, copy); }).catch(function(){});
        return res;
      }).catch(function(){ return offline(req); });
    })
  );
});
