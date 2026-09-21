/* 鉄の帳簿 — 本体。
   記録はこの端末の localStorage にだけ入る。サーバへは一切送らない。
   固定データ（プログラム・種目メタ・強さの物差し）は data.js。 */
(function(){
  "use strict";

  var D        = window.DATA;
  var PROGRAM  = D.PROGRAM,  MG    = D.MG,    MG_ORDER = D.MG_ORDER;
  var EX       = D.EX,       LEVELS = D.LEVELS, PCT    = D.PCT;
  var MG_HUE   = D.MG_HUE,   BW    = D.BWX,   PLATES   = D.PLATES;

  function $(id){ return document.getElementById(id); }

  /* ═══════════════ 保存庫 ═══════════════ */
  var LS = {
    get:function(k, d){
      try { var v = localStorage.getItem("ledger." + k); return v ? JSON.parse(v) : d; }
      catch(e){ return d; }
    },
    set:function(k, v){
      try { localStorage.setItem("ledger." + k, JSON.stringify(v)); return true; }
      catch(e){ return false; }
    },
    del:function(k){ try { localStorage.removeItem("ledger." + k); } catch(e){} }
  };

  var S = {
    sets:[], demo:[], live:false,
    custom:[], bars:{}, level:"beginner", bw:70, offset:0,
    tz:"local", rest:"auto", sound:"both", lastExport:0,
    ex:"ベンチプレス", w:60, r:8,
    view:"today", open:{}, showRail:false, menus:[], ed:null, weights:[],
    calMonth:null, calSel:null,
    restEnd:0, restTotal:0, restEx:"", restTick:null,
    toastTimer:null, lastUndo:null,
    pad:null
  };

  /* ═══════════════ 日付 ═══════════════
     日付の切り替わりを設定で選べる。既定は端末のローカル0時。
     → 旧版は UTC 固定だったので、日本の朝トレが前日に入っていた。 */
  function ymd(ms){
    var d = new Date(ms);
    if (S.tz === "local"){
      return d.getFullYear() + "-" +
        ("0" + (d.getMonth()+1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
    }
    return new Date(ms + Number(S.tz) * 3600000).toISOString().slice(0,10);
  }
  function today(){ return ymd(Date.now()); }
  function dowOf(d){ return new Date(d + "T12:00:00Z").getUTCDay(); }
  function fmtDay(d){
    var p = d.split("-");
    return p[1].replace(/^0/,"") + "/" + p[2] + "（" + "日月火水木金土".charAt(dowOf(d)) + "）";
  }
  function addDays(d, n){
    var t = new Date(d + "T12:00:00Z").getTime() + n * 86400000;
    return new Date(t).toISOString().slice(0,10);
  }
  /* 週の始まりは月曜 */
  function weekStart(d){ var w = dowOf(d); return addDays(d, -((w + 6) % 7)); }

  /* ═══════════════ 計算 ═══════════════ */
  function e1rm(w, r){ return w * (1 + r/30); }
  function round1(n){ return Math.round(n*10)/10; }
  function fmtN(n){ return (Math.round(n*10)/10).toString(); }
  function esc(s){
    return String(s).replace(/[&<>"']/g, function(c){
      return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
    });
  }
  function meta(ex){ return EX[ex] || {u:"bb", inc:2.5, rest:90, std:null}; }
  /* ── 体重 ──
     日ごとに記録する。設定の1つの値ではなく列として持つ。
     自重種目のボリュームと推定1RMには体重が乗るので、昔の記録には
     「その頃の体重」を使う。今日の体重を当てると過去の数字が後から動く。 */
  function saveWeights(){ LS.set("weights", S.weights); }
  function latestWeight(){ return S.weights.length ? S.weights[S.weights.length - 1] : null; }
  function bwNow(){ var l = latestWeight(); return l ? l.kg : S.bw; }
  function bwAt(date){
    if (!S.weights.length) return S.bw;
    var best = null;
    for (var i = 0; i < S.weights.length; i++){
      if (S.weights[i].date <= date) best = S.weights[i]; else break;
    }
    return best ? best.kg : S.weights[0].kg;
  }
  function weightOn(date){
    for (var i = 0; i < S.weights.length; i++) if (S.weights[i].date === date) return S.weights[i];
    return null;
  }
  function sortWeights(){
    S.weights.sort(function(a,b){ return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
  }
  function setWeight(kg, date){
    date = date || today();
    var cur = weightOn(date);
    if (cur){ cur.kg = kg; cur.ts = Date.now(); }
    else { S.weights.push({date:date, kg:kg, ts:Date.now()}); sortWeights(); }
    S.bw = bwNow();                  /* 記録が無いときの控えも合わせておく */
    saveWeights(); saveMeta(); render();
  }
  function removeWeight(date){
    var i = -1;
    S.weights.forEach(function(x, k){ if (x.date === date) i = k; });
    if (i < 0) return;
    var gone = S.weights[i];
    S.weights.splice(i, 1);
    S.bw = bwNow();
    saveWeights(); saveMeta(); render();
    toast(fmtDay(date) + " の体重を消した", "戻す", function(){
      S.weights.splice(i, 0, gone); S.bw = bwNow(); saveWeights(); saveMeta(); render();
    });
  }
  /* n日の移動平均。日々のブレを均さないと増減の向きが読めない */
  function bwAvg(i, n){
    var from = addDays(S.weights[i].date, -(n - 1)), sum = 0, c = 0;
    for (var k = i; k >= 0; k--){
      if (S.weights[k].date < from) break;
      sum += S.weights[k].kg; c++;
    }
    return c ? sum / c : S.weights[i].kg;
  }

  /* 自重種目は「体重＋追加した重り」が実際に動かした重さ */
  function load(ex, w, date){
    return (BW[ex] ? (date ? bwAt(date) : bwNow()) : 0) + w;
  }
  function fmtW(ex, w){
    if (BW[ex]) return w > 0 ? "自重+" + fmtN(w) + "kg" : "自重";
    return fmtN(w) + "kg";
  }
  function unitLabel(ex){
    var u = meta(ex).u;
    return u === "db" ? "片手" : (u === "bw" ? "自重に追加" : (u === "mc" ? "マシンの表示値" : ""));
  }
  /* ダイヤルの見出しに出す短い版。長いと折り返して左右のダイヤルがズレる */
  function unitShort(ex){
    var u = meta(ex).u;
    return u === "db" ? "片手" : (u === "mc" ? "表示値" : "");
  }

  /* 限界までやったときの「その回数で挙がる重量 ÷ 1RM」。間は線形で埋める */
  function pct1rm(reps){
    if (reps <= PCT[0][0]) return PCT[0][1];
    var lastP = PCT[PCT.length-1];
    if (reps >= lastP[0]) return lastP[1];
    for (var i=0; i<PCT.length-1; i++){
      var a = PCT[i], b = PCT[i+1];
      if (reps >= a[0] && reps <= b[0]){
        var t = (reps - a[0]) / (b[0] - a[0]);
        return a[1] + (b[1] - a[1]) * t;
      }
    }
    return 0.75;
  }
  function snap(w, inc){ return Math.max(0, Math.round(w / inc) * inc); }

  /* ═══════════════ データ ═══════════════ */
  function refresh(){ S.live = S.sets.length > 0; dropPR(); }
  /* 表示用。まだ何も無いうちはサンプルを見せる */
  function rows(){ return S.live ? S.sets : S.demo; }
  /* 判断用。サンプルは絶対に混ぜない（混ぜると入力欄に他人の数字が乗る） */
  function real(){ return S.sets; }
  /* メニューは配列で持つ。中身も、名前も、何本あるかも、既定そのものも変えられる。
     data.js の PROGRAM は「工場出荷の形」として残し、ここでは書き換えない。
       days : いま使っている中身
       base : この人にとっての既定（「いまの形を既定にする」で入る）
              null のときは、作り付けのメニューなら PROGRAM が既定 */
  function clone(o){ return JSON.parse(JSON.stringify(o)); }
  function saveMenus(){ LS.set("menus", {v:1, list:S.menus}); }

  function loadMenus(){
    var m = LS.get("menus", null);
    if (m && Array.isArray(m.list) && m.list.length) return m.list;
    /* ひとつ前の版（ledger.program に段ごとの上書きを置いていた）から拾う */
    var legacy = LS.get("program", null);
    return ["beginner","inter"].map(function(id){
      var src = (legacy && legacy[id]) ? legacy[id] : PROGRAM[id];
      return {id:id, label:src.label, cycle:src.cycle, days:clone(src.days), base:null};
    });
  }
  function menuById(id){
    for (var i = 0; i < S.menus.length; i++) if (S.menus[i].id === id) return S.menus[i];
    return null;
  }
  function prog(){ return menuById(S.level) || S.menus[0]; }
  function ownProg(){ return prog(); }          /* もう全部が自分のもの */
  function factory(id){ return PROGRAM[id] || null; }
  function baseDays(m){
    if (m.base) return m.base;
    var f = factory(m.id);
    return f ? f.days : null;
  }
  function isCustomOf(m){
    var b = m.base || (factory(m.id) ? factory(m.id).days : null);
    return !b || JSON.stringify(m.days) !== JSON.stringify(b);
  }
  function isCustom(){
    var m = prog(), b = baseDays(m);
    if (!b) return true;
    return JSON.stringify(m.days) !== JSON.stringify(b);
  }

  function trainedDays(list){
    var seen = {};
    (list || rows()).forEach(function(s){ seen[s.date] = 1; });
    return Object.keys(seen).sort();
  }
  /* サンプルは絶対に混ぜない。混ぜると最初の1セットを記録した瞬間に
     「今日より前にジムへ行った日数」が 6 → 0 に落ちて Day が飛ぶ。 */
  function dayIndex(){
    var t = today();
    var before = trainedDays(real()).filter(function(d){ return d < t; }).length;
    var n = prog().days.length;
    return (((before + S.offset) % n) + n) % n;
  }
  function menuDay(){ return prog().days[dayIndex()]; }

  function streakFrom(days){
    if (!days.length) return 0;
    var set = {}; days.forEach(function(d){ set[d] = 1; });
    var cur = today();
    if (!set[cur]) cur = addDays(cur, -1);
    if (!set[cur]) return 0;
    var n = 0;
    while (set[cur]){ n++; cur = addDays(cur, -1); }
    return n;
  }
  function bestStreak(days){
    var best = 0, run = 0, prev = null;
    days.forEach(function(d){
      run = (prev && addDays(prev, 1) === d) ? run + 1 : 1;
      prev = d; if (run > best) best = run;
    });
    return best;
  }
  function setsTodayFor(ex){
    var t = today(), n = 0;
    real().forEach(function(s){ if (s.date === t && s.ex === ex) n++; });
    return n;
  }
  /* 種目ごとに「日」でまとめる。list を渡さなければ表示用 */
  function sessionsFor(ex, list){
    var byDay = {};
    (list || rows()).forEach(function(s){
      if (s.ex === ex) (byDay[s.date] = byDay[s.date] || []).push(s);
    });
    return Object.keys(byDay).sort().map(function(d){
      var l = byDay[d].slice().sort(function(a,b){ return a.ts - b.ts; });
      var best = 0, top = l[0];
      l.forEach(function(s){
        var v = e1rm(load(s.ex, s.w, s.date), s.r);
        if (v > best){ best = v; top = s; }
      });
      return {date:d, sets:l, best:best, top:top};
    });
  }
  function allTimeBest(ex, list){
    var b = 0;
    (list || rows()).forEach(function(s){
      if (s.ex === ex) b = Math.max(b, e1rm(load(s.ex, s.w, s.date), s.r));
    });
    return b;
  }
  /* それまでの自己ベストを超えていたら PR。
     1セットずつ全走査すると記録が積み上がるほど遅くなる（O(n^2)）ので、
     描画1回につき1度だけ全体を舐めて id の集合を作る。 */
  var prCache = null, prCacheFor = null;
  function dropPR(){ prCache = null; prCacheFor = null; }
  function prIds(list){
    var src = list || rows();
    if (prCache && prCacheFor === src) return prCache;   // 実データとサンプルで別物
    var best = {}, ids = {};
    src.slice().sort(function(a,b){ return a.ts - b.ts; }).forEach(function(s){
      var v = e1rm(load(s.ex, s.w, s.date), s.r);
      if (best[s.ex] !== undefined && v > best[s.ex] + 0.05) ids[s.id] = 1;
      if (best[s.ex] === undefined || v > best[s.ex]) best[s.ex] = v;
    });
    prCacheFor = src; prCache = ids;
    return ids;
  }
  function isPR(s, list){ return !!prIds(list)[s.id]; }

  /* ═══════════════ 強さの物差し ═══════════════
     体重あたりの1RMで 入門/初級/中級/上級/エリート のどこにいるか。
     補助種目の目安は出典の幅が大きい。自分の記録が貯まったらそっちを使う。 */
  function levelOf(ex, list){
    var m = meta(ex);
    if (!m.std) return null;
    var best = allTimeBest(ex, list || real());
    if (!best) return null;
    var ratio = best / bwNow(), std = m.std;
    var score;                                     // 0〜4 の連続値
    if (ratio <= std[0]) score = Math.max(0, ratio / std[0]) - 1;
    else {
      score = 4;
      for (var i = 0; i < std.length - 1; i++){
        if (ratio < std[i+1]){ score = i + (ratio - std[i]) / (std[i+1] - std[i]); break; }
      }
      if (ratio >= std[4]) score = 4 + Math.min(1, (ratio - std[4]) / std[4]);
    }
    return {best:best, ratio:ratio, score:score,
            idx:Math.max(0, Math.min(4, Math.floor(score < 0 ? 0 : score)))};
  }
  /* 全体のレベル。ベンチがあればベンチ、無ければ記録のある種目の平均 */
  function overallLevel(){
    var b = levelOf("ベンチプレス");
    if (b) return Math.max(0, Math.min(4, Math.round(b.score)));
    var sum = 0, n = 0;
    Object.keys(EX).forEach(function(ex){
      var l = levelOf(ex);
      if (l){ sum += l.score; n++; }
    });
    return n ? Math.max(0, Math.min(4, Math.round(sum / n))) : 1;
  }

  /* ═══════════════ 推奨重量 ═══════════════ */
  function recommend(ex, lo, hi){
    var m = meta(ex), inc = m.inc || 2.5;
    var ss = sessionsFor(ex, real());
    var base = 0, why = "", src = "";

    if (ss.length){
      var recent = ss.slice(-3);
      recent.forEach(function(s){ base = Math.max(base, s.best); });
      var last = ss[ss.length - 1];
      var grew = last.top.r >= hi;               // 上限まで回せた＝次は重さを上げる番
      if (grew) base *= 1.025;
      src = "self";
      why = "直近" + recent.length + "回の推定1RM " + fmtN(base / (grew ? 1.025 : 1)) + "kg" +
            (grew ? " ＋ 前回" + last.top.r + "回まで回せたので +2.5%" : "");
    } else {
      if (!m.std) return {none:true, why:"この種目は一般的な目安が無い。軽めから始めて記録を貯める。"};
      var li = overallLevel();
      base = m.std[li] * bwNow();               // 自重種目の std は (体重+追加)÷体重
      src = "std";
      why = "体重" + fmtN(bwNow()) + "kg・" + LEVELS[li] + "の目安（1RM " + fmtN(base) + "kg）から";
    }

    var heavy = base * pct1rm(lo);               // 回数が少ない側＝重い
    var light = base * pct1rm(hi);               // 回数が多い側＝軽い
    if (BW[ex]){ heavy -= bwNow(); light -= bwNow(); } // 入力するのは「追加した重り」

    return {
      none:false, src:src, why:why,
      lo:Math.max(0, snap(light, inc)),
      hi:Math.max(0, snap(heavy, inc)),
      pick:Math.max(0, snap((light + heavy) / 2, inc))
    };
  }

  /* レベルごとの「この回数ならこの重さ」。記録の有無にかかわらず出す。
     自分の記録から出した「次の一手」と並べて見えないと、
     いまの重量が世間のどのへんなのか分からない。 */
  function stdWeights(ex, reps){
    var m = meta(ex);
    if (!m.std) return null;
    var inc = m.inc || 2.5;
    return m.std.map(function(ratio){
      var one = ratio * bwNow();                       // そのレベルの1RM
      var w = one * pct1rm(reps);
      if (BW[ex]) w -= bwNow();                        // 入力するのは追加した重りだけ
      return {one:one, w:Math.max(0, snap(w, inc))};
    });
  }

  /* ═══════════════ サンプル ═══════════════ */
  function buildDemo(){
    var out = [], i = 0;
    function day(back){ return ymd(Date.now() - back*86400000); }
    function add(d, ex, w, r, n){
      for (var k=0; k<(n||1); k++){
        out.push({id:"demo-"+i, ts:Date.parse(d+"T17:0"+(i%6)+":00Z"), date:d, ex:ex, w:w, r:r, demo:true});
        i++;
      }
    }
    add(day(16),"ベンチプレス",55,8,3); add(day(16),"インクラインベンチプレス",40,10,3);
    add(day(13),"チンニング",0,3,4);    add(day(13),"ベントオーバーロー",40,10,3);
    add(day(9), "ベンチプレス",57.5,8,2); add(day(9),"ベンチプレス",57.5,6,1);
    add(day(9), "スミスマシンショルダープレス",30,10,3); add(day(9),"サイドレイズ",5,18,3);
    add(day(6), "スクワット",60,18,3);   add(day(6),"ブルガリアンスクワット",12,14,3);
    add(day(3), "ベンチプレス",60,8,2);  add(day(3),"ベンチプレス",60,7,1);
    add(day(3), "バーベルアームカール",25,10,3);
    add(day(1), "チンニング",0,4,4);     add(day(1),"ワンハンドダンベルロー",20,12,3);
    add(day(1), "バーベルアームカール",27.5,10,3);
    add(day(0), "ベンチプレス",62.5,8,2);
    return out;
  }

  /* ═══════════════ 描画：共通 ═══════════════ */
  function renderClock(){
    var now = new Date();
    var gh = now.toISOString().slice(11,16);
    var jp = new Date(now.getTime()+9*3600000).toISOString().slice(11,16);
    $("clock").innerHTML =
      "<b>" + fmtDay(today()) + "</b><br>アクラ " + gh + " ／ 日本 " + jp;
  }
  function tile(v, unit, k){
    return '<div><div class="v">' + v + '<span>' + unit + '</span></div><div class="k">' + k + '</div></div>';
  }
  function volOf(list){
    var v = 0; list.forEach(function(s){ v += load(s.ex, s.w, s.date) * s.r; }); return v;
  }
  function fmtVol(v){
    return v >= 10000 ? fmtN(v/1000) + " t" : Math.round(v).toLocaleString() + " kg";
  }

  /* ═══════════════ 描画：今日 ═══════════════ */
  /* ホーム画面に追加したアプリとして開かれているか。
     iOS ではこれが Safari と別の保管庫になるので、記録が見えなくなる。 */
  function isStandalone(){
    try {
      return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
             navigator.standalone === true;
    } catch(e){ return false; }
  }

  /* 記録がこの端末にしか無いことの手当て。煽らない。出すのは本当に要るときだけ。 */
  function renderBackupNote(){
    var box = $("backupNote"), txt = $("backupText"), n = real().length;
    box.innerHTML = '<b>控え</b><span id="backupText"></span>';
    txt = $("backupText");

    var msg = null, label = null;
    if (isStandalone() && n === 0){
      msg = "ホーム画面のアプリと Safari は、同じURLでも別の保管庫になる（iOSの仕様）。" +
            "Safari で記録したぶんはここには出ない。消えてはいないので、" +
            "Safari で開いて「引っ越しコード → コピー」、ここで「貼り付け」。";
      label = "設定をひらく";
    } else if (n >= 20) {
      var days = S.lastExport ? Math.floor((Date.now() - S.lastExport) / 86400000) : null;
      if (days === null || days >= 21){
        msg = n + "セットぶんが、この端末の中にしか無い。" +
              (days === null ? "まだ一度も控えを取っていない。" : "前の控えから" + days + "日。") +
              "サイトデータを消すと一緒に消える。";
        label = "控えを取る";
      }
    }
    if (!msg){ box.hidden = true; return; }
    box.hidden = false;
    txt.textContent = msg;
    var b = document.createElement("button");
    b.type = "button"; b.textContent = label;
    b.addEventListener("click", function(){ setView("setup"); });
    box.appendChild(b);
  }

  function renderTally(){
    var t = today(), list = real().filter(function(s){ return s.date === t; });
    var vol = volOf(list);
    $("tally").innerHTML =
      tile(vol >= 10000 ? fmtN(vol/1000) : Math.round(vol).toLocaleString(),
           vol >= 10000 ? "t" : "kg", "総ボリューム") +
      tile(list.length, "本", "セット数") +
      tile(streakFrom(trainedDays(real())), "日", "連続");
    $("sampleNote").hidden = S.live;
    $("sampleText").textContent =
      "「積み上げ」と「分析」だけダミーで埋めてある。この画面の Day・セット数・入力欄は" +
      "本物の記録だけで動くので、最初の1セットを入れても数字は飛ばない。";
  }

  function renderMenu(){
    var d = menuDay(), idx = dayIndex();
    $("dayNo").textContent = (idx + 1);
    $("menuTitle").textContent = d.name;
    $("menuAim").textContent = d.aim;

    var listEl = $("menuList");
    listEl.innerHTML = "";
    var doneSets = 0, totalSets = 0;

    d.items.forEach(function(it){
      var done = setsTodayFor(it.ex);
      doneSets += Math.min(done, it.sets); totalSets += it.sets;

      var b = document.createElement("button");
      b.type = "button";
      b.className = "mi" + (done >= it.sets ? " done" : (done > 0 ? " part" : ""));
      if (it.ex === S.ex) b.setAttribute("aria-current", "true");
      b.innerHTML =
        '<span class="tick" aria-hidden="true">' + (done >= it.sets ? "✓" : (done > 0 ? "●" : "")) + '</span>' +
        '<span class="name">' + esc(it.ex) +
          (it.note ? '<span class="note">' + esc(it.note) + '</span>' : '') + '</span>' +
        '<span class="target"><b>' + done + ' / ' + it.sets + '</b>' + it.lo + '〜' + it.hi + '回</span>';
      b.addEventListener("click", function(){ pick(it); });
      listEl.appendChild(b);
    });

    var pct = totalSets ? Math.round(doneSets / totalSets * 100) : 0;
    $("menuBar").style.width = pct + "%";
    $("menuFoot").textContent =
      prog().label + (prog().cycle ? "・" + prog().cycle : "") +
      " ／ 今日 " + doneSets + " / " + totalSets +
      " セット（目安 " + Math.round(totalSets * 2.5) + "分・" + pct + "%）" +
      (pct >= 100 ? " — 完了。明日は Day " +
        (((dayIndex() + 1) % prog().days.length) + 1) + "。" : "");
  }

  /* 種目を選ぶ。重量は「自分の記録」か「推奨」から入れる。
     サンプルの数字は絶対に入れない。 */
  function pick(it, scroll){
    S.ex = it.ex;
    S.range = {lo:it.lo || 8, hi:it.hi || 12};
    var ss = sessionsFor(it.ex, real());
    if (ss.length){
      var last = ss[ss.length - 1];
      S.w = last.top.w; S.r = last.top.r;
    } else {
      var rec = recommend(it.ex, S.range.lo, S.range.hi);
      S.w = rec.none ? 0 : rec.pick;
      S.r = Math.round((S.range.lo + S.range.hi) / 2);
    }
    render();
    if (scroll !== false) $("logBtn").scrollIntoView({block:"center", behavior:"smooth"});
  }
  /* 今の種目のメニュー上の目標レップ帯 */
  function rangeFor(ex){
    var found = null;
    function scan(p){
      if (!p) return;
      p.days.forEach(function(d){
        d.items.forEach(function(it){ if (it.ex === ex && !found) found = {lo:it.lo, hi:it.hi}; });
      });
    }
    scan(prog());                                   /* いま効いているものを優先 */
    S.menus.forEach(scan);
    ["beginner","inter"].forEach(function(k){ scan(PROGRAM[k]); });
    return found || S.range || {lo:8, hi:12};
  }

  function renderRail(){
    var rail = $("rail");
    rail.hidden = !S.showRail;
    $("otherToggle").setAttribute("aria-expanded", S.showRail ? "true" : "false");
    $("otherToggle").textContent = (S.showRail ? "▾" : "▸") + " メニュー外の種目を選ぶ";
    if (!S.showRail) return;

    var seen = {}, all = [];
    var allDays = [];
    S.menus.forEach(function(m){ allDays = allDays.concat(m.days); });
    allDays.concat(PROGRAM.beginner.days, PROGRAM.inter.days).forEach(function(d){
      d.items.forEach(function(it){ if (!seen[it.ex]){ seen[it.ex] = 1; all.push(it.ex); } });
    });
    S.custom.concat(real().map(function(s){ return s.ex; })).forEach(function(e){
      if (!seen[e]){ seen[e] = 1; all.push(e); }
    });

    rail.innerHTML = "";
    all.forEach(function(e){
      var b = document.createElement("button");
      b.type = "button"; b.className = "chip"; b.textContent = e;
      b.setAttribute("aria-pressed", e === S.ex ? "true" : "false");
      b.addEventListener("click", function(){
        var r = rangeFor(e); pick({ex:e, lo:r.lo, hi:r.hi});
      });
      rail.appendChild(b);
    });
    var add = document.createElement("button");
    add.type = "button"; add.className = "chip add"; add.textContent = "＋ 種目を足す";
    add.addEventListener("click", addExercise);
    rail.appendChild(add);
  }

  function renderDeck(){
    var m = meta(S.ex), r = rangeFor(S.ex);
    $("deckEx").textContent = S.ex;
    $("deckE1rm").textContent = "推定1RM " + fmtN(e1rm(load(S.ex, S.w), S.r)) + "kg";
    $("wUnit").textContent = unitShort(S.ex) ? "／" + unitShort(S.ex) : "";
    $("wOut").innerHTML = BW[S.ex]
      ? (S.w > 0 ? fmtN(S.w) + "<u>kg追加</u>" : '<span style="font-size:30px">自重</span>')
      : fmtN(S.w) + "<u>kg</u>";
    $("rOut").innerHTML = S.r + "<u>回</u>";

    /* ステップ幅は種目に合わせる。サイドレイズで ±5kg は要らない */
    var inc = m.inc;
    fillSteps($("wSteps"), [-inc*2, -inc, inc, inc*2], setW);
    /* 回数も4つ。30〜50回の種目を ±1 だけで動かすのは無理がある */
    fillSteps($("rSteps"), [-5, -1, 1, 5], setR);

    renderRec(r);
    renderStd(r);
    renderPlates();
  }

  function fillSteps(box, deltas, fn){
    box.innerHTML = "";
    deltas.forEach(function(d){
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = (d > 0 ? "+" : "−") + fmtN(Math.abs(d));
      b.addEventListener("click", function(){ fn(d); });
      box.appendChild(b);
    });
  }

  function renderRec(r){
    var rec = recommend(S.ex, r.lo, r.hi), box = $("recBox");
    if (rec.none){
      box.className = "rec none";
      box.innerHTML = '<span class="k">目安</span><span>' + esc(rec.why) + '</span>';
      return;
    }
    var lv = levelOf(S.ex);
    box.className = "rec";
    var range = rec.lo === rec.hi ? fmtN(rec.lo) + "kg"
              : fmtN(rec.lo) + "〜" + fmtN(rec.hi) + "kg";
    box.innerHTML =
      '<span class="k">' + (rec.src === "self" ? "次の一手" : "目安") + '</span>' +
      '<span><span class="v">' + range + '</span> × ' + r.lo + '〜' + r.hi + '回' +
        '<span class="why">' + esc(rec.why) +
        (lv ? ' ／ いまは <b>' + LEVELS[lv.idx] + '</b>' : '') + '</span></span>';
    var b = document.createElement("button");
    b.type = "button"; b.textContent = "入れる";
    b.addEventListener("click", function(){
      S.w = rec.pick; S.r = Math.round((r.lo + r.hi) / 2); renderDeck();
    });
    box.appendChild(b);
  }

  function renderStd(r){
    var box = $("stdBox"), m = meta(S.ex);
    var mid = Math.max(1, Math.round((r.lo + r.hi) / 2));
    var ws = stdWeights(S.ex, mid);
    if (!ws){
      box.hidden = true;
      return;
    }
    box.hidden = false;

    var lv = levelOf(S.ex, real());               // 自分の記録での位置。無ければ null
    var hereIdx = lv ? lv.idx : overallLevel();   // 記録が無い種目はベンチから推定した位置

    var cells = ws.map(function(x, i){
      var cls = "stdcell" + (i === hereIdx ? " now" : (i < hereIdx ? " done" : ""));
      var label = BW[S.ex] ? (x.w > 0 ? "+" + fmtN(x.w) : "自重") : fmtN(x.w);
      return '<button type="button" class="' + cls + '" data-w="' + x.w + '" ' +
        'aria-label="' + LEVELS[i] + 'の目安 ' + fmtN(x.w) + 'kg を入れる">' +
        '<span class="n">' + LEVELS[i] + '</span><span class="w">' + label + '</span></button>';
    }).join("");

    var note;
    if (lv){
      var nx = lv.idx < 4 ? m.std[lv.idx + 1] * bwNow() : null;
      note = 'いまの推定1RM <b>' + fmtN(lv.best) + 'kg</b>（体重比 ' + lv.ratio.toFixed(2) + '倍）。' +
        (nx ? '次の「' + LEVELS[lv.idx + 1] + '」まで 1RM であと <b>' + fmtN(nx - lv.best) + 'kg</b>。'
            : 'この種目はエリート域。');
    } else {
      note = 'この種目はまだ記録が無いので、' +
        (levelOf("ベンチプレス", real()) ? 'ベンチプレスの記録から' : '') +
        '<b>' + LEVELS[hereIdx] + '</b>と見て目安を出している。1セット記録すれば実測に切り替わる。';
    }

    box.innerHTML =
      '<div class="sh"><b>目安</b>' +
      '<span class="now">' + (lv ? "いま " + LEVELS[lv.idx] : "推定 " + LEVELS[hereIdx]) + '</span></div>' +
      '<div class="sub">' + mid + '回でやるなら（' + r.lo + '〜' + r.hi + '回の真ん中）</div>' +
      '<div class="stdrow">' + cells + '</div>' +
      '<div class="note">' + note + ' 数字を押すとその重さが入る。</div>';

    Array.prototype.forEach.call(box.querySelectorAll(".stdcell"), function(b){
      b.addEventListener("click", function(){
        S.w = Number(b.getAttribute("data-w")); S.r = mid; renderDeck();
      });
    });
  }

  function renderPlates(){
    var m = meta(S.ex), row = $("platesRow");
    /* プレート計算はバーベル種目だけ。ダンベルやマシンで「バー20kg」は嘘になる */
    row.hidden = m.u !== "bb";
    if (row.hidden) return;

    var bar = S.bars[S.ex] !== undefined ? S.bars[S.ex] : (m.bar !== undefined ? m.bar : 20);
    $("barSel").value = String(bar);
    var box = $("stack");
    box.innerHTML = "";
    if (bar === 0){ box.innerHTML = '<span class="rem">バーなし（プレート計算なし）</span>'; return; }
    var perSide = (S.w - bar) / 2;
    if (perSide < 0){ box.innerHTML = '<span class="rem">バーより軽い（' + fmtN(bar) + 'kg 未満）</span>'; return; }
    if (perSide === 0){ box.innerHTML = '<span class="rem">バーのみ</span>'; return; }
    var left = perSide;
    PLATES.forEach(function(p){
      var n = Math.floor((left + 1e-9) / p[0]);
      if (n <= 0) return;
      left = round1(left - n * p[0]);
      for (var k = 0; k < n; k++){
        var el = document.createElement("span");
        el.className = "plate " + p[1]; el.textContent = fmtN(p[0]);
        box.appendChild(el);
      }
    });
    if (left > 0.01){
      var rm = document.createElement("span");
      rm.className = "rem"; rm.textContent = "＋端数 " + fmtN(left) + "kg（プレートで組めない）";
      box.appendChild(rm);
    }
  }

  function renderLast(){
    var ss = sessionsFor(S.ex, real()), t = today(), prev = null, cur = null;
    for (var i = ss.length - 1; i >= 0; i--){ if (ss[i].date !== t){ prev = ss[i]; break; } }
    ss.forEach(function(s){ if (s.date === t) cur = s; });
    var card = $("lastCard");
    if (!prev){
      card.innerHTML = '<div class="top"><strong>前回の' + esc(S.ex) + '</strong></div>' +
        '<div class="when">記録なし。ここが初回の基準になる。</div>';
      return;
    }
    var d = cur ? cur.best - prev.best : 0;
    var cls = !cur ? "flat" : (d > 0.05 ? "up" : (d < -0.05 ? "down" : "flat"));
    var badge = !cur ? "今日はまだ" : (d > 0.05 ? "▲ +" + fmtN(d) + "kg"
             : (d < -0.05 ? "▼ " + fmtN(d) + "kg" : "＝ 同値"));
    card.innerHTML =
      '<div class="top"><strong>前回の' + esc(S.ex) + '</strong><span class="delta ' + cls + '">' + badge + '</span></div>' +
      '<div class="when">' + fmtDay(prev.date) + ' ・ 推定1RM ' + fmtN(prev.best) + 'kg</div>' +
      '<div class="setline">' + prev.sets.map(function(s){
        return '<span class="setpill">' + fmtW(s.ex, s.w) + '×' + s.r + '</span>';
      }).join("") + '</div>';
  }

  function renderToday(){
    var t = today();
    var list = real().filter(function(s){ return s.date === t; })
                     .sort(function(a,b){ return b.ts - a.ts; });
    var box = $("todayList");
    if (!list.length){
      var all = real(), days = trainedDays(all);
      box.className = "empty";
      box.textContent = "今日はまだ0本。上のメニューから種目を選ぶと重量が入ります。" +
        (all.length ? "（通算 " + all.length + "本 / " + days.length + "日・最後は " +
          fmtDay(days[days.length-1]) + "）" : "");
      return;
    }
    box.className = "today-list";
    box.innerHTML = "";
    list.forEach(function(s, idx){
      var pr = isPR(s, real());
      var row = document.createElement("div");
      row.className = "row" + (pr ? " prset" : "");
      row.innerHTML =
        '<span class="i">' + (list.length - idx) + '</span>' +
        '<span class="ex">' + esc(s.ex) + (pr ? ' <span class="pr">PR</span>' : '') + '</span>' +
        '<span class="wr">' + fmtW(s.ex, s.w) + ' × ' + s.r + '<u>回</u></span>';
      var ed = document.createElement("button");
      ed.type = "button"; ed.className = "edit"; ed.textContent = "✎";
      ed.setAttribute("aria-label", s.ex + " のセットを直す");
      ed.addEventListener("click", function(){ editSet(s); });
      row.appendChild(ed);
      var del = document.createElement("button");
      del.type = "button"; del.className = "del"; del.textContent = "×";
      del.setAttribute("aria-label", s.ex + " のセットを削除");
      del.addEventListener("click", function(){ removeSet(s); });
      row.appendChild(del);
      box.appendChild(row);
    });
  }

  /* ═══════════════ 描画：積み上げ ═══════════════ */
  function renderStats(){
    var list = rows(), days = trainedDays(list);
    var vol = volOf(list);
    var t = today(), ws = weekStart(t), ms = t.slice(0,7);
    var wk = list.filter(function(s){ return s.date >= ws; });
    var mo = list.filter(function(s){ return s.date.slice(0,7) === ms; });
    var first = days[0];

    $("stats").innerHTML =
      '<div><div class="v">' + (vol >= 10000 ? fmtN(vol/1000) : Math.round(vol).toLocaleString()) +
        '<span>' + (vol >= 10000 ? "t" : "kg") + '</span></div>' +
        '<div class="k">これまでに挙げた総重量</div>' +
        '<div class="s">' + list.length + ' セット</div></div>' +
      '<div><div class="v">' + days.length + '<span>日</span></div>' +
        '<div class="k">ジムに行った日数</div>' +
        '<div class="s">' + (first ? fmtDay(first) + " から" : "—") + '</div></div>' +
      '<div><div class="v">' + streakFrom(days) + '<span>日</span></div>' +
        '<div class="k">連続</div>' +
        '<div class="s">最長 ' + bestStreak(days) + ' 日</div></div>' +
      '<div><div class="v">' + wk.length + '<span>本</span></div>' +
        '<div class="k">今週のセット</div>' +
        '<div class="s">' + fmtVol(volOf(wk)) + '</div></div>' +
      '<div><div class="v">' + mo.length + '<span>本</span></div>' +
        '<div class="k">今月のセット</div>' +
        '<div class="s">' + fmtVol(volOf(mo)) + '</div></div>' +
      '<div><div class="v">' + trainedDays(mo).length + '<span>日</span></div>' +
        '<div class="k">今月のトレ日</div>' +
        '<div class="s">' + (+ms.slice(0,4)) + '年' + (+ms.slice(5,7)) + '月</div></div>';
  }

  /* その日の主な部位（上位3つ）。カレンダーの点に使う */
  function dayMuscles(list){
    var per = {};
    list.forEach(function(s){
      var mg = MG[s.ex] || [];
      mg.forEach(function(raw, i){
        var m = raw.replace(/\+$/, "");
        if (MG_ORDER.indexOf(m) === -1) return;
        per[m] = (per[m] || 0) + (i === 0 ? 1 : 0.5);
      });
    });
    return Object.keys(per).sort(function(a,b){ return per[b] - per[a]; }).slice(0,3);
  }

  function renderCal(){
    var list = rows(), byDay = {};
    list.forEach(function(s){ (byDay[s.date] = byDay[s.date] || []).push(s); });

    if (!S.calMonth) S.calMonth = today().slice(0,7);
    var ym = S.calMonth.split("-"), Y = +ym[0], M = +ym[1];
    $("calMonth").textContent = Y + "年 " + M + "月";

    $("calDow").innerHTML = ["月","火","水","木","金","土","日"]
      .map(function(d){ return '<div class="caldow">' + d + '</div>'; }).join("");

    var first = S.calMonth + "-01";
    var lead = (dowOf(first) + 6) % 7;                 // 月曜始まり
    var dim = new Date(Date.UTC(Y, M, 0)).getUTCDate();

    var maxVol = 0;
    Object.keys(byDay).forEach(function(d){
      if (d.slice(0,7) === S.calMonth) maxVol = Math.max(maxVol, volOf(byDay[d]));
    });

    var grid = $("calGrid");
    grid.innerHTML = "";
    for (var i = 0; i < lead; i++){
      var pad = document.createElement("div");
      pad.className = "calcell pad"; grid.appendChild(pad);
    }
    for (var dd = 1; dd <= dim; dd++){
      var date = S.calMonth + "-" + ("0" + dd).slice(-2);
      var sets = byDay[date] || [];
      var cell = document.createElement("button");
      cell.type = "button";
      cell.className = "calcell" + (sets.length ? " has" : "") + (date === today() ? " today" : "");
      cell.setAttribute("aria-pressed", S.calSel === date ? "true" : "false");
      cell.setAttribute("aria-label", fmtDay(date) + (sets.length ? " " + sets.length + "セット" : " 休み"));
      if (sets.length && maxVol > 0){
        var a = 0.14 + 0.5 * (volOf(sets) / maxVol);
        cell.style.background = "color-mix(in srgb, var(--accent) " + Math.round(a*100) + "%, var(--surface-2))";
      }
      var dots = dayMuscles(sets).map(function(m){
        return '<i style="background:' + (MG_HUE[m] || "#888") + '"></i>';
      }).join("");
      cell.innerHTML = '<span>' + dd + '</span><span class="caldots">' + dots + '</span>';
      (function(date){
        cell.addEventListener("click", function(){
          S.calSel = (S.calSel === date) ? null : date;
          renderCal(); renderCalDay();
        });
      })(date);
      grid.appendChild(cell);
    }

    $("calFoot").innerHTML = MG_ORDER.map(function(m){
      return '<span class="lg"><i style="background:' + MG_HUE[m] + '"></i>' + m + '</span>';
    }).join("") + '<span style="margin-left:auto">色の濃さ＝その日のボリューム</span>';
  }

  function renderCalDay(){
    var box = $("calDay");
    if (!S.calSel){ box.innerHTML = ""; return; }
    var list = rows().filter(function(s){ return s.date === S.calSel; });
    if (!list.length){
      box.innerHTML = '<div class="empty">' + fmtDay(S.calSel) + ' は記録なし。</div>';
      return;
    }
    var exs = {};
    list.forEach(function(s){ (exs[s.ex] = exs[s.ex] || []).push(s); });
    box.innerHTML =
      '<div class="lastcard"><div class="top"><strong>' + fmtDay(S.calSel) + '</strong>' +
      '<span class="when">' + list.length + '本 ・ ' + fmtVol(volOf(list)) + '</span></div>' +
      Object.keys(exs).map(function(e){
        return '<div class="dgrp"><span class="n">' + esc(e) + '</span><span class="setline">' +
          exs[e].sort(function(a,b){ return a.ts - b.ts; }).map(function(s){
            return '<span class="setpill' + (isPR(s) ? " prset" : "") + '">' +
              fmtW(s.ex, s.w) + '×' + s.r + '</span>';
          }).join("") + '</span></div>';
      }).join("") + '</div>';
  }

  function renderBars(){
    var list = rows();
    if (!list.length){ $("bars").innerHTML = ""; $("barsLab").innerHTML = ""; return; }
    var weeks = [], cur = weekStart(today());
    for (var i = 11; i >= 0; i--) weeks.push(addDays(cur, -7 * i));

    var vols = weeks.map(function(ws){
      var we = addDays(ws, 7);
      return volOf(list.filter(function(s){ return s.date >= ws && s.date < we; }));
    });
    var max = Math.max.apply(null, vols.concat([1]));

    $("bars").innerHTML = weeks.map(function(ws, i){
      var h = Math.round(vols[i] / max * 100);
      return '<span class="b' + (i === weeks.length-1 ? " now" : "") + '" title="' +
        ws + ' ' + fmtVol(vols[i]) + '"><i style="height:' + Math.max(h, vols[i] ? 3 : 0) + '%"></i></span>';
    }).join("");
    $("barsLab").innerHTML =
      '<span>' + weeks[0].slice(5).replace("-","/") + '</span>' +
      '<span>' + weeks[weeks.length-1].slice(5).replace("-","/") + ' の週</span>';
    $("barsNote").textContent = "直近12週 ／ 最大 " + fmtVol(max);
  }

  function renderHist(){
    var byDay = {};
    rows().forEach(function(s){ (byDay[s.date] = byDay[s.date] || []).push(s); });
    var days = Object.keys(byDay).sort().reverse();
    var box = $("hist");
    if (!days.length){ box.innerHTML = '<div class="empty" style="border:none">まだ何もありません。</div>'; return; }
    box.innerHTML = "";
    days.forEach(function(d, di){
      var list = byDay[d], exs = {};
      list.forEach(function(s){ (exs[s.ex] = exs[s.ex] || []).push(s); });
      var open = S.open[d] !== undefined ? S.open[d] : di === 0;

      var wrap = document.createElement("div"); wrap.className = "day";
      var head = document.createElement("button");
      head.type = "button"; head.className = "day-head";
      head.setAttribute("aria-expanded", open ? "true" : "false");
      head.innerHTML = '<span class="d">' + fmtDay(d) + '</span>' +
        '<span class="s">' + list.length + '本 ・ ' + fmtVol(volOf(list)) + ' ' + (open ? "▾" : "▸") + '</span>';
      head.addEventListener("click", function(){ S.open[d] = !open; renderHist(); });
      wrap.appendChild(head);

      if (open){
        var body = document.createElement("div"); body.className = "day-body";
        Object.keys(exs).forEach(function(e){
          var g = document.createElement("div"); g.className = "dgrp";
          g.innerHTML = '<span class="n">' + esc(e) + '</span><span class="setline">' +
            exs[e].sort(function(a,b){ return a.ts - b.ts; }).map(function(s){
              return '<span class="setpill' + (isPR(s) ? " prset" : "") + '">' +
                fmtW(s.ex, s.w) + '×' + s.r + '</span>';
            }).join("") + '</span>';
          body.appendChild(g);
        });
        wrap.appendChild(body);
      }
      box.appendChild(wrap);
    });
  }

  /* ═══════════════ 描画：分析 ═══════════════ */
  function renderChart(){
    var ss = sessionsFor(S.ex).slice(-12);
    $("chartEx").textContent = S.ex;
    var box = $("chart");
    if (ss.length < 2){
      box.innerHTML = '<div class="empty">' +
        (ss.length ? "2回目を記録すると線になります。" : "この種目はまだ記録がありません。") + '</div>';
      return;
    }
    var W = 560, H = 150, PL = 34, PR = 46, PT = 16, PB = 24;
    var vals = ss.map(function(s){ return s.best; });
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    if (max - min < 1){ max += 1; min = Math.max(0, min - 1); }
    var pad = (max - min) * 0.18; min = Math.max(0, min - pad); max += pad;
    var x = function(i){ return PL + (W - PL - PR) * (i / (ss.length - 1)); };
    var y = function(v){ return PT + (H - PT - PB) * (1 - (v - min) / (max - min)); };
    var pts = ss.map(function(s, i){ return x(i) + "," + y(s.best); });
    var area = "M" + x(0) + "," + (H - PB) + " L" + pts.join(" L") + " L" + x(ss.length - 1) + "," + (H - PB) + " Z";

    var svg = '<svg class="spark" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' +
      esc(S.ex) + 'の推定1RM推移">';
    [0, 0.5, 1].forEach(function(f){
      var v = min + (max - min) * f;
      svg += '<line class="grid" x1="' + PL + '" y1="' + y(v) + '" x2="' + (W - PR) + '" y2="' + y(v) + '"></line>';
      svg += '<text x="' + (PL - 6) + '" y="' + (y(v) + 3.5) + '" text-anchor="end">' + fmtN(v) + '</text>';
    });
    svg += '<path class="area" d="' + area + '"></path>';
    svg += '<polyline class="line" points="' + pts.join(" ") + '"></polyline>';
    ss.forEach(function(s, i){
      var last = i === ss.length - 1;
      svg += '<circle class="dot' + (last ? " last" : "") + '" cx="' + x(i) + '" cy="' + y(s.best) + '" r="' + (last ? 4.5 : 3) + '"></circle>';
    });
    var lastS = ss[ss.length - 1];
    svg += '<text class="val" x="' + (x(ss.length - 1) + 8) + '" y="' + (y(lastS.best) + 4) + '">' + fmtN(lastS.best) + 'kg</text>';
    svg += '<text x="' + PL + '" y="' + (H - 6) + '" text-anchor="start">' + ss[0].date.slice(5).replace("-", "/") + '</text>';
    svg += '<text x="' + (W - PR) + '" y="' + (H - 6) + '" text-anchor="end">' + lastS.date.slice(5).replace("-", "/") + '</text>';
    svg += '</svg>';
    box.innerHTML = svg;
  }

  function renderLevels(){
    var box = $("lvBox"), list = rows();
    var cur = levelOf(S.ex, list);
    var html = '<div class="head"><strong>強さの物差し</strong>' +
      '<span class="lvtop sub">体重 ' + fmtN(bwNow()) + 'kg あたりの推定1RM</span></div>' +
      (S.live ? "" : '<p class="foot-note" style="margin:0">いまはサンプルの数字。' +
        '最初のセットを記録すると自分の記録に切り替わる。</p>');

    if (cur){
      var seg = "";
      for (var i = 0; i < 5; i++){
        seg += '<i class="' + (cur.score >= i ? "on" + (i === 4 ? " max" : "") : "") + '"></i>';
      }
      html += '<div class="lv"><div class="lvtop"><span class="now">' + esc(S.ex) + ' — ' +
        LEVELS[cur.idx] + '</span><span class="sub">1RM ' + fmtN(cur.best) + 'kg ／ 体重比 ' +
        cur.ratio.toFixed(2) + '倍</span></div>' +
        '<div class="lvtrack">' + seg + '</div>' +
        '<div class="lvscale">' + LEVELS.map(function(l){ return '<span>' + l + '</span>'; }).join("") +
        '</div></div>';
      var m = meta(S.ex), nx = cur.idx < 4 ? m.std[cur.idx + 1] * bwNow() : null;
      if (nx) html += '<p class="foot-note" style="margin:0">次の「' + LEVELS[cur.idx+1] +
        '」まで あと <b>' + fmtN(nx - cur.best) + 'kg</b>（1RM ' + fmtN(nx) + 'kg）</p>';
    } else {
      html += '<p class="foot-note" style="margin:0">' + esc(S.ex) +
        ' はまだ記録が無いので判定できない。1セット記録すれば出る。</p>';
    }

    /* 記録のある種目を一覧で */
    var have = [];
    Object.keys(EX).forEach(function(ex){
      var l = levelOf(ex, list); if (l) have.push({ex:ex, l:l});
    });
    have.sort(function(a,b){ return b.l.score - a.l.score; });
    if (have.length){
      html += '<div style="margin-top:4px">' + have.map(function(h){
        return '<div class="lvrow"><span class="nm">' + esc(h.ex) +
          '<small>1RM ' + fmtN(h.l.best) + 'kg ／ 体重比 ' + h.l.ratio.toFixed(2) + '倍</small></span>' +
          '<span class="bd bd' + h.l.idx + '">' + LEVELS[h.l.idx] + '</span></div>';
      }).join("") + '</div>';
    }
    html += '<p class="foot-note" style="margin:0">男性の一般的な目安（体重あたりの1RM）。' +
      'ビッグ3は出典がおおむね一致するが、<b>補助種目はばらつきが大きい</b>ので順位づけの道具として見ること。</p>';
    box.innerHTML = html;
  }

  /* 実際にやったセット数（直近7日）を部位別に */
  function renderVolumeDone(){
    var box = $("volDone"), t = today(), from = addDays(t, -6);
    var list = rows().filter(function(s){ return s.date >= from; });
    var per = {}; MG_ORDER.forEach(function(m){ per[m] = 0; });
    var upper = 0, chest = 0;
    list.forEach(function(s){
      var mg = MG[s.ex] || [];
      mg.forEach(function(raw, i){
        var full = raw.charAt(raw.length - 1) === "+";
        var m = full ? raw.slice(0, -1) : raw;
        if (m === "胸上部"){ upper += 1; return; }
        if (per[m] === undefined) per[m] = 0;
        per[m] += (i === 0 || full) ? 1 : 0.5;
      });
      if ((MG[s.ex] || [])[0] === "胸") chest += 1;
    });

    var MAXV = 30;
    var html = '<div class="head"><div class="eyebrow">実際にやったセット数</div>' +
      '<div class="num" style="font-size:12px;color:var(--ink-3)">直近7日・計' + list.length + 'セット</div></div>' +
      '<div class="vscale"><span></span><span><i style="font-style:normal">0</i>' +
      '<i style="font-style:normal">10</i><i style="font-style:normal">20</i>' +
      '<i style="font-style:normal">30</i></span><span></span></div>';

    MG_ORDER.forEach(function(m){
      var n = Math.round((per[m] || 0) * 2) / 2;
      var cls = n < 10 ? "low" : (n > 20 ? "over" : "");
      html += '<div class="vrow"><span class="mgn">' + m + '</span>' +
        '<span class="track"><i class="band"></i>' +
        '<i class="fill ' + cls + '" style="width:' + Math.min(100, n / MAXV * 100) + '%"></i></span>' +
        '<span class="vn">' + n + '<u>set</u></span></div>';
      if (m === "胸" && chest){
        var ratio = Math.round(upper / chest * 100);
        html += '<div class="vsub">うちインクライン系＝<b>' + ratio + '%</b>' +
          (ratio < 35 ? '。上部が薄い。' : '。バランスは取れている。') + '</div>';
      }
    });
    html += '<p class="foot-note" style="margin:0">こっちが<b>実績</b>。下の「週あたりのセット数」は' +
      'プログラム上の<b>予定</b>。ズレていたら予定どおり動けていないということ。' +
      'ダンベル種目は片手の重量で記録している。</p>';
    box.innerHTML = html;
  }

  function weeklyVolume(){
    var days = prog().days, per = {}, total = 0;
    MG_ORDER.forEach(function(m){ per[m] = 0; });
    days.forEach(function(d){
      d.items.forEach(function(it){
        total += it.sets;
        var mg = MG[it.ex] || [];
        mg.forEach(function(raw, i){
          var full = raw.charAt(raw.length - 1) === "+";
          var m = full ? raw.slice(0, -1) : raw;
          if (per[m] === undefined) per[m] = 0;
          per[m] += it.sets * ((i === 0 || full) ? 1 : 0.5);
        });
      });
    });
    var k = 7 / days.length;
    Object.keys(per).forEach(function(m){ per[m] = Math.round(per[m] * k * 2) / 2; });
    return {per:per, total:Math.round(total * k), cycle:days.length};
  }

  function renderVolume(){
    var v = weeklyVolume(), box = $("vol"), MAXV = 30;
    var html = '<div class="head"><div class="eyebrow">週あたりのセット数（予定）</div>' +
      '<div class="num" style="font-size:12px;color:var(--ink-3)">' + prog().label +
      '・全' + v.total + 'セット/週</div></div>' +
      '<div class="vscale"><span></span><span><i style="font-style:normal">0</i>' +
      '<i style="font-style:normal">10</i><i style="font-style:normal">20</i>' +
      '<i style="font-style:normal">30</i></span><span></span></div>';

    MG_ORDER.forEach(function(m){
      var n = v.per[m] || 0;
      var cls = n < 10 ? "low" : (n > 20 ? "over" : "");
      html += '<div class="vrow"><span class="mgn">' + m + '</span>' +
        '<span class="track"><i class="band"></i>' +
        '<i class="fill ' + cls + '" style="width:' + Math.min(100, n / MAXV * 100) + '%"></i></span>' +
        '<span class="vn">' + n + '<u>set</u></span></div>';
      if (m === "胸"){
        var up = v.per["胸上部"] || 0;
        var ratio = n ? Math.round(up / n * 100) : 0;
        html += '<div class="vrow sub"><span class="mgn">└ 上部</span>' +
          '<span class="track"><i class="band"></i>' +
          '<i class="fill up" style="width:' + Math.min(100, up / MAXV * 100) + '%"></i></span>' +
          '<span class="vn">' + up + '<u>set</u></span></div>' +
          '<div class="vsub">インクライン系＝胸の <b>' + ratio + '%</b>。' +
          (ratio < 35 ? '上部が薄い。インクラインを1セット足す。' : '上部とフラットのバランスは取れている。') +
          '</div>';
      }
    });
    html += '<p class="foot-note" style="margin:0">' +
      'グレーの帯が目安レンジ <b>10〜20セット</b>。多関節種目は主働筋を1セット、補助の部位を0.5セットで数えている。' +
      '<br>黄色＝少なすぎ／赤＝多すぎ。赤が出たら、その部位の単関節種目を1セット減らす。</p>';
    box.innerHTML = html;
  }

  function renderGrad(){
    var box = $("grad"), target = bwNow() + 20;
    var ss = sessionsFor("ベンチプレス");
    var best = 0;
    ss.forEach(function(s){ best = Math.max(best, s.best); });
    var mainOK = false, mainDay = "";
    ss.forEach(function(s){
      var n = 0;
      s.sets.forEach(function(x){ if (x.w >= bwAt(s.date) && x.r >= 8) n++; });
      if (n >= 3){ mainOK = true; mainDay = s.date; }
    });
    var maxOK = best >= target;
    var pct = Math.min(100, Math.round(best / target * 100));

    box.innerHTML =
      '<div class="head"><strong>初心者からの卒業判定</strong>' +
        '<span class="delta ' + (maxOK && mainOK ? "up" : "flat") + '">' +
        (maxOK && mainOK ? "条件クリア" : pct + "%") + '</span></div>' +
      '<div class="gauge"><i class="' + (maxOK ? "hit" : "") + '" style="width:' + pct + '%"></i></div>' +
      '<div class="crit"><span class="mk ' + (maxOK ? "up" : "flat") + '">' + (maxOK ? "✓" : "—") + '</span>' +
        '<span>ベンチプレス推定MAX <b>' + fmtN(best) + 'kg</b> ／ 目標 <b>' + fmtN(target) +
        'kg</b>（体重＋20kg）</span></div>' +
      '<div class="crit"><span class="mk ' + (mainOK ? "up" : "flat") + '">' + (mainOK ? "✓" : "—") + '</span>' +
        '<span>体重（' + fmtN(bwNow()) + 'kg）で8回×3セット' +
        (mainOK ? '　<b>達成：' + fmtDay(mainDay) + '</b>' : '　未達') + '</span></div>' +
      '<p class="foot-note" style="margin:0">両方クリアしたら設定を「初中級」に切り替える。' +
        (S.level !== "beginner" ? '（いまは「' + esc(prog().label) + '」）' : '') + '</p>';
  }

  /* ═══════════════ 描画：設定 ═══════════════ */
  function renderSettings(){
    $("bwOut").textContent = fmtN(bwNow()) + " kg";
    var lw = latestWeight();
    $("bwSub").textContent = lw
      ? (lw.date === today() ? "今日 測った" : fmtDay(lw.date) + " が最後") +
        " ／ 記録 " + S.weights.length + "件"
      : "まだ測っていない。押すと今日のぶんとして記録する";
    $("tzSel").value = String(S.tz);
    $("restSel").value = String(S.rest);
    $("soundSel").value = String(S.sound);
    $("dataCount").textContent = S.sets.length + " セット／" + trainedDays(S.sets).length + " 日ぶん";

    var host = "";
    try { host = location.host || "この端末"; } catch(e){ host = "この端末"; }
    $("originNote").innerHTML =
      '記録は <b>' + esc(host) + '</b> ごとに分かれて入っている。<b>パスは関係ない</b>ので、' +
      '同じホスト名なら <code>/iron-ledger/</code> でも <code>/別の名前/</code> でも同じ記録が出る。' +
      '<br>ホスト名が変わると（独自ドメインにした・別のアカウントに移した）別物になる。' +
      '<b>iOSでは「ホーム画面に追加」したアプリと Safari も別物</b>。' +
      'そのときは上の<b>引っ越しコード</b>で移す。消えてはいない。' +
      (isStandalone() ? '<br>いまは<b>ホーム画面のアプリ</b>として開いている。' : '');

    renderMenuList();
    renderDayList();
    renderDiag();
  }

  /* ═══════════════ メニュー編集 ═══════════════
     既定のプログラムは data.js のまま触らない。
     変えたぶんだけ ledger.program に自分用のコピーとして持つ。 */
  function openDayEditor(idx){
    var p = prog();
    if (!p.days[idx]) return;
    S.ed = {idx:idx, day:clone(p.days[idx])};
    $("editor").hidden = false;
    document.body.style.overflow = "hidden";
    renderEditor();
    $("editor").scrollTop = 0;
  }
  function closeEditor(){
    $("editor").hidden = true;
    document.body.style.overflow = "";
    S.ed = null;
  }
  function saveEditor(){
    if (!S.ed) return;
    var own = ownProg();
    own.days[S.ed.idx] = S.ed.day;
    saveMenus();
    closeEditor();
    render();
    toast("メニューを保存した。");
  }

  function renderEditor(){
    if (!S.ed) return;
    var d = S.ed.day, body = $("edBody");
    $("edTitle").textContent = "Day " + (S.ed.idx + 1) + " を編集";
    body.innerHTML = "";

    /* 名前とねらい */
    var head = el("div", "ecard");
    head.appendChild(fieldBtn("名前", d.name || "（なし）", function(){
      openText({title:"Day の名前", value:d.name || "", okLabel:"決定",
        hint:"短く。「胸」「背中＋肩」など。", onOk:function(v){
          d.name = v.trim().slice(0, 24); closeText(); renderEditor();
        }});
    }));
    head.appendChild(fieldBtn("ねらい", d.aim || "（なし）", function(){
      openText({title:"この日のねらい", value:d.aim || "", okLabel:"決定",
        hint:"メニューの上に出る一言。空でもいい。", onOk:function(v){
          d.aim = v.trim().slice(0, 200); closeText(); renderEditor();
        }});
    }));
    body.appendChild(head);

    /* 種目 */
    d.items.forEach(function(it, i){
      var card = el("div", "ecard mi-card");

      var top = el("div", "etop");
      var mv = el("div", "emove");
      mv.appendChild(iconBtn("▲", i === 0, function(){ swapItem(i, -1); }, "ひとつ上へ"));
      mv.appendChild(iconBtn("▼", i === d.items.length - 1, function(){ swapItem(i, 1); }, "ひとつ下へ"));
      top.appendChild(mv);

      var nm = el("button", "ename");
      nm.type = "button";
      /* メモは下に専用の行がある。ここに出すと二重になる */
      nm.innerHTML = esc(it.ex) +
        '<small style="opacity:.65">タップで種目を差し替え</small>';
      nm.style.cssText = "background:none;border:none;text-align:left;padding:0;color:inherit";
      nm.addEventListener("click", function(){
        openPicker("種目を差し替え", function(name){ it.ex = name; renderEditor(); });
      });
      top.appendChild(nm);

      var del = el("button", "edel"); del.type = "button"; del.textContent = "×";
      del.setAttribute("aria-label", it.ex + " を外す");
      del.addEventListener("click", function(){
        d.items.splice(i, 1); renderEditor();
      });
      top.appendChild(del);
      card.appendChild(top);

      /* セット数 */
      var f1 = el("div", "efield");
      f1.appendChild(el("span", null, "セット数"));
      var st = el("div", "estep");
      st.appendChild(stepBtn("−", function(){ it.sets = Math.max(1, it.sets - 1); renderEditor(); }));
      st.appendChild(el("span", "v", String(it.sets)));
      st.appendChild(stepBtn("＋", function(){ it.sets = Math.min(20, it.sets + 1); renderEditor(); }));
      f1.appendChild(st);
      card.appendChild(f1);

      /* 回数のレンジ */
      var f2 = el("div", "efield");
      f2.appendChild(el("span", null, "回数"));
      var rg = el("div", "estep");
      rg.appendChild(numBtn(it.lo, function(){
        openPad({title:it.ex + "：回数の下限", unit:"回", value:it.lo, dec:false, min:1, max:200,
          hint:"重いほう。ここを下回ったら重量を下げる", quick:[5,8,10,12,15],
          onOk:function(v){ it.lo = v; if (it.hi < v) it.hi = v; renderEditor(); }});
      }));
      rg.appendChild(el("span", null, "〜"));
      rg.appendChild(numBtn(it.hi, function(){
        openPad({title:it.ex + "：回数の上限", unit:"回", value:it.hi, dec:false, min:1, max:200,
          hint:"ここまで回せたら次は重量を上げる", quick:[8,10,12,15,20],
          onOk:function(v){ it.hi = Math.max(v, it.lo); renderEditor(); }});
      }));
      f2.appendChild(rg);
      card.appendChild(f2);

      /* メモ */
      var f3 = el("div", "efield");
      f3.appendChild(el("span", null, "メモ"));
      var nb = el("button", "barsel"); nb.type = "button";
      nb.style.cssText = "padding:6px 10px;max-width:58%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
      nb.textContent = it.note ? it.note : "（なし）";
      nb.addEventListener("click", function(){
        openText({title:it.ex + " のメモ", value:it.note || "", okLabel:"決定",
          hint:"メニューに小さく出る。フォームの注意など。空でもいい。",
          onOk:function(v){
            v = v.trim().slice(0, 120);
            if (v) it.note = v; else delete it.note;
            closeText(); renderEditor();
          }});
      });
      f3.appendChild(nb);
      card.appendChild(f3);

      body.appendChild(card);
    });

    var add = el("button", "eadd"); add.type = "button"; add.textContent = "＋ 種目を足す";
    add.addEventListener("click", function(){
      openPicker("種目を足す", function(name){
        var r = rangeFor(name);
        d.items.push({ex:name, sets:3, lo:r.lo, hi:r.hi});
        renderEditor();
      });
    });
    body.appendChild(add);

    var total = 0;
    d.items.forEach(function(it){ total += it.sets; });
    body.appendChild(el("div", "esum",
      "この日は " + d.items.length + "種目・" + total + "セット（目安 " +
      Math.round(total * 2.5) + "分）。保存するまで反映されない。"));

    function swapItem(i, dir){
      var j = i + dir;
      if (j < 0 || j >= d.items.length) return;
      var t = d.items[i]; d.items[i] = d.items[j]; d.items[j] = t;
      renderEditor();
    }
  }

  /* 小物 */
  function el(tag, cls, text){
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function iconBtn(label, disabled, fn, aria){
    var b = el("button", null, label); b.type = "button";
    if (aria) b.setAttribute("aria-label", aria);
    if (disabled) b.disabled = true; else b.addEventListener("click", fn);
    return b;
  }
  function stepBtn(label, fn){
    var b = el("button", null, label); b.type = "button";
    b.addEventListener("click", fn);
    return b;
  }
  function numBtn(v, fn){
    var b = el("button", "v", String(v)); b.type = "button";
    b.style.cursor = "pointer";
    b.addEventListener("click", fn);
    return b;
  }
  function fieldBtn(label, value, fn){
    var f = el("div", "efield");
    f.appendChild(el("span", null, label));
    var b = el("button", "barsel", value); b.type = "button";
    b.style.cssText = "padding:6px 10px;max-width:62%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    b.addEventListener("click", fn);
    f.appendChild(b);
    return f;
  }

  /* ── 種目ピッカー ── */
  var pickOnPick = null;
  function openPicker(title, onPick){
    pickOnPick = onPick;
    $("pickTitle").textContent = title;
    var list = $("pickList");
    list.innerHTML = "";

    var free = el("button", null); free.type = "button";
    free.innerHTML = '＋ 自由に入力<small>ここに無い種目を足す</small>';
    free.addEventListener("click", function(){
      closePicker();
      openText({title:"種目名", value:"", okLabel:"決定", hint:"例：インクラインベンチ",
        onOk:function(v){
          v = v.trim().slice(0, 40);
          if (!v) return;
          if (S.custom.indexOf(v) === -1){ S.custom.push(v); saveMeta(); }
          closeText();
          if (onPick) onPick(v);
        }});
    });
    list.appendChild(free);

    /* 部位ごとに並べる。どこにも属さないものは最後 */
    var seen = {}, groups = {};
    MG_ORDER.forEach(function(m){ groups[m] = []; });
    groups["その他"] = [];
    Object.keys(EX).concat(S.custom).concat(real().map(function(x){ return x.ex; }))
      .forEach(function(ex){
        if (seen[ex]) return;
        seen[ex] = 1;
        var mg = (MG[ex] || [])[0];
        mg = (mg || "").replace(/\+$/, "");
        (groups[mg] ? groups[mg] : groups["その他"]).push(ex);
      });

    Object.keys(groups).forEach(function(m){
      if (!groups[m].length) return;
      list.appendChild(el("div", "grp", m));
      groups[m].forEach(function(ex){
        var b = el("button", null); b.type = "button";
        var mt = meta(ex);
        b.innerHTML = esc(ex) + '<small>' +
          (unitLabel(ex) ? unitLabel(ex) + "・" : "") +
          "インターバル " + (mt.rest || 90) + "秒" +
          (mt.std ? "" : "・目安なし") + '</small>';
        b.addEventListener("click", function(){
          closePicker();
          if (onPick) onPick(ex);
        });
        list.appendChild(b);
      });
    });
    $("pickSheet").hidden = false;
  }
  function closePicker(){ $("pickSheet").hidden = true; pickOnPick = null; }

  /* ── Day の一覧（設定タブ）── */
  function renderDayList(){
    var p = prog(), box = $("dayList"), cur = dayIndex();
    box.innerHTML = "";
    p.days.forEach(function(d, i){
      var row = el("div", "dayrow" + (i === cur ? " cur" : ""));
      row.appendChild(el("span", "n", "Day " + (i + 1)));

      var t = el("button", "t"); t.type = "button";
      var total = 0;
      d.items.forEach(function(it){ total += it.sets; });
      t.innerHTML = esc(d.name || "（名前なし）") +
        '<small>' + d.items.length + '種目・' + total + 'セット</small>';
      t.addEventListener("click", function(){ openDayEditor(i); });
      row.appendChild(t);

      var mv = el("div", "emove");
      mv.appendChild(iconBtn("▲", i === 0, function(){ moveDay(i, -1); }, "ひとつ上へ"));
      mv.appendChild(iconBtn("▼", i === p.days.length - 1, function(){ moveDay(i, 1); }, "ひとつ下へ"));
      row.appendChild(mv);

      var del = el("button", "edel"); del.type = "button"; del.textContent = "×";
      del.setAttribute("aria-label", "Day " + (i+1) + " を消す");
      del.addEventListener("click", function(){ removeDay(i); });
      row.appendChild(del);

      box.appendChild(row);
    });

    $("dayHead").textContent = "「" + p.label + "」の Day";
    var hasOwnBase = !!p.base, fac = factory(p.id);
    $("progNote").innerHTML =
      (isCustom() ? '<b>いまの形は既定と違う。</b>' : '既定どおり。') +
      ' Day を押すと中身を編集できる。' +
      '<br>1周は <b>' + p.days.length + '日</b>。ローテーションは<b>ジムに行った日数</b>で進むので、' +
      'Day を増減すると今日どこに当たるかも変わる。記録は消えない。' +
      '<br>「既定に戻す」の戻り先は ' +
      (hasOwnBase ? '<b>自分で決めた既定</b>（いまの形を既定にする、で更新）'
                  : (fac ? '<b>作り付けの形</b>（動画の構成そのまま）'
                         : '<b>まだ無い</b>。「いまの形を既定にする」で決める')) + '。';
  }
  function moveDay(i, dir){
    var own = ownProg(), j = i + dir;
    if (j < 0 || j >= own.days.length) return;
    var t = own.days[i]; own.days[i] = own.days[j]; own.days[j] = t;
    saveMenus(); render();
  }
  function removeDay(i){
    var own = ownProg();
    if (own.days.length <= 1){ toast("これ以上は減らせない。"); return; }
    var name = own.days[i].name || ("Day " + (i+1));
    if (!window.confirm("「" + name + "」をメニューから外す。記録は消えない。続ける？")) return;
    var gone = clone(own.days[i]);
    own.days.splice(i, 1);
    saveMenus(); render();
    toast("「" + esc(name) + "」を外した", "戻す", function(){
      ownProg().days.splice(i, 0, gone); saveMenus(); render();
    });
  }
  function addDay(){
    var own = ownProg();
    own.days.push({name:"新しい日", aim:"", items:[]});
    saveMenus(); render();
    openDayEditor(own.days.length - 1);
  }
  /* 「いまの形を既定にする」＝ この人にとっての戻り先を差し替える。
     作り付けの形（data.js）は残るので、そこへも戻せる。 */
  function setAsBase(){
    var m = prog();
    if (!window.confirm("「" + m.label + "」のいまの形を既定にする。\n以後「既定に戻す」はここへ戻る。続ける？")) return;
    var prev = m.base ? clone(m.base) : null;
    m.base = clone(m.days);
    saveMenus(); render();
    toast("いまの形を既定にした", "取り消す", function(){
      prog().base = prev; saveMenus(); render();
    });
  }
  function resetProgram(){
    var m = prog(), b = baseDays(m);
    if (!b){ toast("このメニューにはまだ既定が無い。「いまの形を既定にする」を先に。"); return; }
    if (JSON.stringify(m.days) === JSON.stringify(b)){ toast("すでに既定のまま。"); return; }
    var where = m.base ? "自分で決めた既定" : "作り付けの形";
    if (!window.confirm("「" + m.label + "」を" + where + "に戻す。記録は消えない。続ける？")) return;
    var gone = clone(m.days);
    m.days = clone(b);
    saveMenus(); render();
    toast(where + "に戻した", "やっぱり戻す", function(){
      prog().days = gone; saveMenus(); render();
    });
  }

  /* ── メニューそのものの出し入れ ── */
  function renderMenuList(){
    var box = $("menuList2");
    box.innerHTML = "";
    S.menus.forEach(function(m, i){
      var row = el("div", "dayrow" + (m.id === S.level ? " cur" : ""));
      row.appendChild(el("span", "n", m.id === S.level ? "使用中" : ""));

      var t = el("button", "t"); t.type = "button";
      var sets = 0;
      m.days.forEach(function(d){ d.items.forEach(function(it){ sets += it.sets; }); });
      t.innerHTML = esc(m.label) + '<small>' + esc(m.cycle || "") + ' ・ ' +
        m.days.length + 'Day ・ 全' + sets + 'セット</small>';
      t.addEventListener("click", function(){
        S.level = m.id; S.offset = 0; saveMeta(); render();
      });
      row.appendChild(t);

      var ed = el("button", "edel"); ed.type = "button"; ed.textContent = "✎";
      ed.setAttribute("aria-label", m.label + " の名前を変える");
      ed.addEventListener("click", function(){ editMenuMeta(m); });
      row.appendChild(ed);

      var del = el("button", "edel"); del.type = "button"; del.textContent = "×";
      del.setAttribute("aria-label", m.label + " を消す");
      del.addEventListener("click", function(){ removeMenu(i); });
      row.appendChild(del);

      box.appendChild(row);
    });
  }
  function editMenuMeta(m){
    openText({title:"メニューの名前", value:m.label, okLabel:"決定",
      hint:"「初心者」「ジムA」「自宅」など。", onOk:function(v){
        v = v.trim().slice(0, 24);
        if (v) m.label = v;
        closeText();
        openText({title:"周期の説明", value:m.cycle || "", okLabel:"決定",
          hint:"画面に小さく出るだけ。「7日で1周」「5分割」など。空でもいい。",
          onOk:function(w){
            m.cycle = w.trim().slice(0, 24);
            closeText(); saveMenus(); render();
          }});
      }});
  }
  function addMenu(copy){
    var src = copy ? prog() : null;
    var m = {
      id:"m" + Date.now(),
      label:copy ? prog().label + " のコピー" : "新しいメニュー",
      cycle:copy ? (src.cycle || "") : "",
      days:copy ? clone(src.days) : [{name:"Day 1", aim:"", items:[]}],
      base:null
    };
    S.menus.push(m);
    S.level = m.id; S.offset = 0;
    saveMenus(); saveMeta(); render();
    if (!copy) openDayEditor(0); else toast("「" + esc(m.label) + "」を作った。");
  }
  function removeMenu(i){
    if (S.menus.length <= 1){ toast("これ以上は減らせない。"); return; }
    var m = S.menus[i];
    if (!window.confirm("メニュー「" + m.label + "」を消す。記録は消えない。続ける？")) return;
    var gone = clone(m);
    S.menus.splice(i, 1);
    if (S.level === m.id){ S.level = S.menus[0].id; S.offset = 0; saveMeta(); }
    saveMenus(); render();
    toast("「" + esc(m.label) + "」を消した", "戻す", function(){
      S.menus.splice(i, 0, gone); S.level = gone.id; saveMenus(); saveMeta(); render();
    });
  }

  /* ═══════════════ 診断 ═══════════════
     「消えた」と「今日のぶんが無いだけ」と「別の保管庫を見ている」は
     見た目が同じ。推測させず、入っているものをそのまま出す。 */
  function rawKey(k){
    try { return localStorage.getItem("ledger." + k); } catch(e){ return null; }
  }
  function describe(k){
    var v = rawKey(k);
    if (v === null) return "なし";
    var kb = (v.length / 1024).toFixed(1) + "KB";
    try {
      var a = JSON.parse(v);
      if (Array.isArray(a)) return a.length + "件 / " + kb;
      if (a && Array.isArray(a.sets)) return a.sets.length + "件 / " + kb +
        (a.at ? " / " + new Date(a.at).toLocaleString("ja-JP") : "");
      return "配列ではない / " + kb;
    } catch(e){ return "★壊れている★ / " + kb; }
  }
  function diagText(){
    var now = new Date();
    var L = [];
    L.push("── 鉄の帳簿 診断 ──");
    L.push("いま      : " + now.toLocaleString("ja-JP") + " / UTC " + now.toISOString().slice(0,16));
    L.push("時差      : UTC" + (now.getTimezoneOffset() <= 0 ? "+" : "-") +
           Math.abs(now.getTimezoneOffset()/60));
    L.push("日付の設定: " + S.tz + " → 今日は " + today());
    L.push("開き方    : " + (isStandalone() ? "ホーム画面のアプリ" : "ブラウザ") + " / " + location.host);
    L.push("");
    L.push("ledger.sets  : " + describe("sets"));
    L.push("ledger.bak   : " + describe("bak"));
    L.push("ledger.weights: " + describe("weights"));
    L.push("ledger.cache : " + describe("cache") + "  （旧版）");
    L.push("ledger.queue : " + describe("queue") + "  （旧版）");
    L.push("ledger.prefs : " + (rawKey("prefs") ? "あり" : "なし"));
    L.push("ledger.program: " + (rawKey("program")
      ? S.menus.map(function(m){ return m.label + (isCustomOf(m) ? "*" : ""); }).join(" / ")
      : "既定のまま") + "  （* は既定と違う）");
    L.push("");
    L.push("読み込めた記録: " + S.sets.length + "件");
    if (S.sets.length){
      var byDate = {};
      S.sets.forEach(function(x){ byDate[x.date] = (byDate[x.date] || 0) + 1; });
      var days = Object.keys(byDate).sort();
      L.push("日付の範囲    : " + days[0] + " 〜 " + days[days.length-1] + "（" + days.length + "日）");
      L.push("直近5日:");
      days.slice(-5).forEach(function(d){ L.push("  " + d + " : " + byDate[d] + "本"); });
      L.push("最後の1件:");
      var last = S.sets[S.sets.length-1];
      L.push("  " + last.date + " " + last.ex + " " + last.w + "kg×" + last.r);
      L.push("  記録時刻 " + new Date(last.ts).toLocaleString("ja-JP"));
      /* 設定どおりに付け直すと日付が変わるもの＝旧版のUTC基準で入ったもの */
      var off = 0;
      S.sets.forEach(function(x){ if (ymd(x.ts) !== x.date) off++; });
      L.push("日付がズレている記録: " + off + "件" +
             (off ? "  ←「日付を取り直す」で直る" : ""));
    }
    return L.join("\n");
  }
  function renderDiag(){
    var el = $("diagOut");
    if (el) el.textContent = diagText();
  }

  /* 記録した時刻から日付を付け直す。ts が正、date は表示用の入れ物。 */
  function refileDates(){
    backup(true);
    var before = S.sets.map(function(x){ return x.date; });
    var changed = 0;
    S.sets.forEach(function(x){
      var d = ymd(x.ts);
      if (d !== x.date){ x.date = d; changed++; }
    });
    if (!changed){ toast("ズレている記録は無かった。"); return; }
    save(); refresh(); render();
    toast(changed + "件の日付を付け直した", "戻す", function(){
      S.sets.forEach(function(x, i){ x.date = before[i]; });
      save(); refresh(); render();
    });
  }

  function restoreBak(){
    var bak = LS.get("bak", null);
    if (!bak || !Array.isArray(bak.sets) || !bak.sets.length){
      toast("控えがまだ無い。"); return;
    }
    applyImport({sets:bak.sets});
  }

  /* ═══════════════ 画面の切り替え ═══════════════ */
  var VIEWS = [["today","viewToday","tabToday"], ["ledger","viewLedger","tabLedger"],
               ["stats","viewStats","tabStats"], ["setup","viewSetup","tabSetup"]];
  function setView(v){
    S.view = v;
    VIEWS.forEach(function(x){
      $(x[1]).hidden = x[0] !== v;
      $(x[2]).setAttribute("aria-selected", x[0] === v ? "true" : "false");
    });
    render();
    window.scrollTo(0, 0);
  }

  function render(){
    dropPR();
    renderClock();
    if (S.view === "today"){
      renderMenu(); renderTally(); renderBwCard(); renderBackupNote();
      renderRail(); renderDeck(); renderLast(); renderToday();
    } else if (S.view === "ledger"){
      renderStats(); renderBwChart(); renderCal(); renderCalDay(); renderBars(); renderHist();
    } else if (S.view === "stats"){
      renderChart(); renderLevels(); renderVolumeDone(); renderVolume(); renderGrad();
    } else {
      renderSettings();
    }
  }

  /* ═══════════════ テンキー ═══════════════
     native の input は使わない。type=number は iOS で全角・IME・
     既存値への割り込みが起きて、打った数字と違う値が確定する。 */
  function openPad(opt){
    S.pad = {buf:"", opt:opt, touched:false};
    $("padTitle").textContent = opt.title;
    $("padSheet").hidden = false;

    var grid = $("padGrid");
    grid.innerHTML = "";
    var keys = ["1","2","3","4","5","6","7","8","9", opt.dec ? "." : "C", "0", "←"];
    keys.forEach(function(k){
      var b = document.createElement("button");
      b.type = "button";
      b.className = "padkey" + (/[0-9.]/.test(k) ? "" : " fn");
      b.textContent = k;
      b.addEventListener("click", function(){ padKey(k); });
      grid.appendChild(b);
    });

    var q = $("padQuick"); q.innerHTML = "";
    (opt.quick || []).forEach(function(v){
      var b = document.createElement("button");
      b.type = "button"; b.textContent = fmtN(v) + (opt.unit || "");
      b.addEventListener("click", function(){
        S.pad.buf = String(v); S.pad.touched = true; padDraw();
      });
      q.appendChild(b);
    });
    padDraw();
  }
  function padKey(k){
    var p = S.pad; if (!p) return;
    if (k === "←"){ p.buf = p.buf.slice(0, -1); }
    else if (k === "C"){ p.buf = ""; }
    else if (k === "."){ if (p.buf.indexOf(".") === -1) p.buf = (p.buf || "0") + "."; }
    else {
      if (p.buf === "0") p.buf = "";
      if (p.buf.replace(".", "").length < 6) p.buf += k;
    }
    p.touched = true;
    padDraw();
  }
  function padValue(){
    var p = S.pad;
    if (!p.touched) return p.opt.value;
    if (p.buf === "" || p.buf === ".") return null;
    var v = Number(p.buf);
    return isFinite(v) ? v : null;
  }
  function padDraw(){
    var p = S.pad, v = padValue(), o = p.opt;
    var bad = v === null || v < o.min || v > o.max;
    $("padOut").className = "padout" + (bad ? " bad" : "");
    $("padOut").innerHTML = (p.touched ? (p.buf === "" ? "—" : esc(p.buf)) : fmtN(o.value)) +
      '<u>' + (o.unit || "") + '</u>';
    $("padHint").textContent = bad
      ? (v === null ? "数字を入れる" : fmtN(o.min) + "〜" + fmtN(o.max) + " の範囲で")
      : (o.hint || "");
    $("padOk").disabled = bad;
  }
  function closePad(){ $("padSheet").hidden = true; S.pad = null; }
  function padCommit(){
    var v = padValue();
    if (v === null) return;
    var o = S.pad.opt;
    if (v < o.min || v > o.max) return;
    closePad();
    o.onOk(v);
  }

  /* ═══════════════ インターバルタイマー ═══════════════ */
  var audio = null;
  function unlockAudio(){
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!audio) audio = new AC();
      if (audio.state === "suspended") audio.resume();
    } catch(e){}
  }
  function beep(){
    if (S.sound === "off" || S.sound === "vib") return;
    try {
      if (!audio) return;
      [0, 0.18, 0.36].forEach(function(t){
        var o = audio.createOscillator(), g = audio.createGain();
        o.type = "sine"; o.frequency.value = 880;
        g.gain.setValueAtTime(0.0001, audio.currentTime + t);
        g.gain.exponentialRampToValueAtTime(0.25, audio.currentTime + t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + t + 0.14);
        o.connect(g); g.connect(audio.destination);
        o.start(audio.currentTime + t); o.stop(audio.currentTime + t + 0.16);
      });
    } catch(e){}
  }
  function buzz(){
    if (S.sound === "off" || S.sound === "snd") return;
    try { if (navigator.vibrate) navigator.vibrate([180, 90, 180]); } catch(e){}
  }
  function restSeconds(ex){
    if (S.rest === "off") return 0;
    if (S.rest === "auto") return meta(ex).rest || 90;
    return Number(S.rest) || 90;
  }
  function startRest(ex){
    var sec = restSeconds(ex);
    if (!sec) return;
    S.restTotal = sec; S.restEnd = Date.now() + sec * 1000; S.restEx = ex;
    if (S.restTick) clearInterval(S.restTick);
    S.restTick = setInterval(tickRest, 250);
    tickRest();
  }
  function stopRest(){
    if (S.restTick) clearInterval(S.restTick);
    S.restTick = null; S.restEnd = 0;
    $("restBar").hidden = true;
  }
  function tickRest(){
    var bar = $("restBar");
    if (!S.restEnd){ bar.hidden = true; return; }
    var left = Math.ceil((S.restEnd - Date.now()) / 1000);
    bar.hidden = false;

    if (left <= 0){
      if (!S.restDone){ S.restDone = true; beep(); buzz(); }
      bar.className = "restbar done";
      bar.innerHTML = '<span class="t">GO</span>' +
        '<span class="ex"><span class="k">rest done</span><br>' + esc(S.restEx) + ' の次のセット</span>';
      var ok = document.createElement("button");
      ok.type = "button"; ok.textContent = "閉じる";
      ok.addEventListener("click", stopRest);
      bar.appendChild(ok);
      if (Date.now() - S.restEnd > 15000) stopRest();
      return;
    }
    S.restDone = false;
    bar.className = "restbar";
    var mm = Math.floor(left / 60), ssec = ("0" + (left % 60)).slice(-2);
    bar.innerHTML = '<span class="t">' + mm + ':' + ssec + '</span>' +
      '<span class="ex"><span class="k">interval</span><br>' + esc(S.restEx) + '</span>';
    var plus = document.createElement("button");
    plus.type = "button"; plus.textContent = "+30秒";
    plus.addEventListener("click", function(){ S.restEnd += 30000; S.restTotal += 30; tickRest(); });
    var skip = document.createElement("button");
    skip.type = "button"; skip.textContent = "スキップ";
    skip.addEventListener("click", stopRest);
    bar.appendChild(plus); bar.appendChild(skip);
    var p = document.createElement("i");
    p.className = "prog";
    p.style.width = Math.round((1 - left / S.restTotal) * 100) + "%";
    bar.appendChild(p);
  }

  /* ═══════════════ トースト ═══════════════ */
  function toast(msg, actionLabel, action){
    var t = $("toast");
    t.hidden = false;
    t.innerHTML = "<span>" + msg + "</span>";
    if (action){
      var b = document.createElement("button");
      b.type = "button"; b.textContent = actionLabel;
      b.addEventListener("click", function(){ t.hidden = true; action(); });
      t.appendChild(b);
    }
    if (S.toastTimer) clearTimeout(S.toastTimer);
    S.toastTimer = setTimeout(function(){ t.hidden = true; }, 6000);
  }

  /* ═══════════════ 操作 ═══════════════ */
  function setW(d){
    var inc = meta(S.ex).inc;
    S.w = Math.max(0, round1(Math.round((S.w + d) / inc) * inc));
    renderDeck();
  }
  function setR(d){ S.r = Math.max(1, Math.min(999, S.r + d)); renderDeck(); }

  function addExercise(){
    var name = window.prompt("種目名を入力（例：インクラインベンチ）");
    if (!name) return;
    name = name.trim().slice(0, 40);
    if (!name) return;
    if (S.custom.indexOf(name) === -1) S.custom.push(name);
    S.ex = name; saveMeta(); render();
  }

  /* 1日1回だけ控えを取る。毎回2重に書くと容量を食うので頻度を絞る。
     「記録が消えた」はここから戻せるかどうかで詰みかどうかが決まる。 */
  function backup(force){
    if (!S.sets.length) return;
    var last = LS.get("bakAt", 0);
    if (!force && Date.now() - last < 86400000) return;
    if (LS.set("bak", {at:Date.now(), sets:S.sets.slice(-8000)})) LS.set("bakAt", Date.now());
  }

  /* 書いたつもりで書けていない、を作らない。
     setItem は例外を投げずに握りつぶされることがある（プライベートモード・
     容量・保存の制限）。書いたら必ず読み返して、入っていなければ黙らない。 */
  function save(){
    backup(false);
    var want = S.sets.slice(-8000);
    var ok = LS.set("sets", want);
    var got = ok ? LS.get("sets", null) : null;
    var wrote = Array.isArray(got) && got.length === want.length;

    var bar = $("syncBar");
    if (!wrote){
      bar.hidden = false; bar.className = "syncbar off";
      bar.innerHTML = '<b>保存できていない</b><span>この端末に書き込めない' +
        '（プライベートブラウズか、容量がいっぱい）。<b>このまま閉じると今日の記録は消える。</b>' +
        '設定→引っ越しコードでコピーして退避すること。</span>';
      return false;
    }
    bar.hidden = true;
    return true;
  }
  function saveMeta(){
    LS.set("prefs", {custom:S.custom, bars:S.bars, level:S.level, bw:S.bw,
                     offset:S.offset, tz:S.tz, rest:S.rest, sound:S.sound,
                     lastExport:S.lastExport});
  }

  function logSet(){
    unlockAudio();
    var now = Date.now();
    var rec = {id:"s" + now + "-" + Math.floor(Math.random()*1000),
               ts:now, date:ymd(now), ex:S.ex, w:S.w, r:S.r};
    S.sets.push(rec);
    save(); refresh(); render();

    var btn = $("logBtn");
    btn.textContent = "記録した";
    setTimeout(function(){ btn.textContent = "セットを記録"; }, 900);

    var pr = isPR(rec, S.sets);
    toast((pr ? "🏆 自己ベスト　" : "") + "<b>" + esc(fmtW(rec.ex, rec.w)) + " × " + rec.r + "</b>",
      "取り消す", function(){
        S.sets = S.sets.filter(function(x){ return x.id !== rec.id; });
        save(); refresh(); render(); stopRest();
      });
    startRest(S.ex);
  }

  function removeSet(s){
    if (s.demo){ S.demo = S.demo.filter(function(x){ return x.id !== s.id; }); dropPR(); render(); return; }
    var idx = S.sets.findIndex(function(x){ return x.id === s.id; });
    if (idx === -1) return;
    var gone = S.sets[idx];
    S.sets.splice(idx, 1);
    save(); refresh(); render();
    toast("<b>" + esc(fmtW(gone.ex, gone.w)) + " × " + gone.r + "</b> を消した", "戻す", function(){
      S.sets.splice(idx, 0, gone); save(); refresh(); render();
    });
  }

  function editSet(s){
    if (s.demo){ toast("サンプルは直せない。記録すると本物に切り替わる。"); return; }
    var m = meta(s.ex);
    openPad({
      title:s.ex + " の重量を直す", unit:"kg", value:s.w, dec:true,
      min:0, max:600, hint:unitLabel(s.ex) ? unitLabel(s.ex) + "の重さ" : "",
      quick:[s.w, s.w + m.inc, s.w - m.inc].filter(function(v){ return v >= 0; }),
      onOk:function(w){
        openPad({
          title:s.ex + " の回数を直す", unit:"回", value:s.r, dec:false,
          min:1, max:999, quick:[s.r, s.r + 1, s.r - 1].filter(function(v){ return v >= 1; }),
          onOk:function(r){
            var t = S.sets.find(function(x){ return x.id === s.id; });
            if (!t) return;
            t.w = w; t.r = r;
            save(); refresh(); render();
            toast("直した：<b>" + esc(fmtW(t.ex, w)) + " × " + r + "</b>");
          }
        });
      }
    });
  }

  function openWeightPad(){
    var m = meta(S.ex), r = rangeFor(S.ex), rec = recommend(S.ex, r.lo, r.hi);
    var q = [];
    if (!rec.none){ q.push(rec.pick); if (rec.lo !== rec.pick) q.push(rec.lo); if (rec.hi !== rec.pick) q.push(rec.hi); }
    var last = sessionsFor(S.ex, real()).slice(-1)[0];
    if (last && q.indexOf(last.top.w) === -1) q.push(last.top.w);
    openPad({
      title:BW[S.ex] ? S.ex + "：自重に追加する重さ" : S.ex + " の重量",
      unit:"kg", value:S.w, dec:true, min:0, max:600,
      hint:unitLabel(S.ex) ? "この種目は" + unitLabel(S.ex) + "で記録する" : "",
      quick:q,
      onOk:function(v){ S.w = round1(v); renderDeck(); }
    });
  }
  function openRepPad(){
    var r = rangeFor(S.ex);
    openPad({
      title:S.ex + " の回数", unit:"回", value:S.r, dec:false, min:1, max:999,
      hint:"メニュー上の目安は " + r.lo + "〜" + r.hi + "回",
      quick:[r.lo, Math.round((r.lo + r.hi)/2), r.hi],
      onOk:function(v){ S.r = Math.round(v); renderDeck(); }
    });
  }
  function openBwPad(date){
    date = date || today();
    var cur = weightOn(date), base = cur ? cur.kg : bwNow();
    var q = [base, round1(base + 0.5), round1(base - 0.5)]
      .filter(function(v){ return v >= 30 && v <= 200; });
    openPad({
      title:(date === today() ? "今日の体重" : fmtDay(date) + " の体重"),
      unit:"kg", value:base, dec:true, min:30, max:200,
      hint:"同じ条件で測ると比べやすい（起きてすぐ・トイレのあと）",
      quick:q,
      onOk:function(v){
        v = round1(v);
        var had = weightOn(date), before = had ? had.kg : null;
        setWeight(v, date);
        var last = null;
        for (var i = 0; i < S.weights.length; i++){
          if (S.weights[i].date < date) last = S.weights[i]; else break;
        }
        var d = last ? round1(v - last.kg) : 0;
        toast("<b>" + fmtN(v) + "kg</b>" +
          (last ? "（" + fmtDay(last.date) + " から " + (d > 0 ? "+" : "") + fmtN(d) + "kg）"
                : "　最初の記録"),
          before === null ? null : "元に戻す",
          before === null ? null : function(){ setWeight(before, date); });
      }
    });
  }

  /* 今日タブの体重カード */
  function renderBwCard(){
    var box = $("bwCard"), t = today(), cur = weightOn(t);
    box.innerHTML = "";
    box.appendChild(el("span", "k", "体重"));
    var mid = el("div", "mid");

    if (cur){
      var i = 0;
      S.weights.forEach(function(x, k){ if (x.date === t) i = k; });
      var prev = i > 0 ? S.weights[i - 1] : null;
      var d = prev ? round1(cur.kg - prev.kg) : 0;
      var cls = !prev ? "flat" : (d > 0.05 ? "up" : (d < -0.05 ? "down" : "flat"));
      box.className = "bwcard";
      mid.innerHTML =
        '<div class="v">' + fmtN(cur.kg) + '<u>kg</u>' +
        (prev ? '<em class="delta ' + cls + '">' + (d > 0 ? "+" : "") + fmtN(d) + '</em>' : '') + '</div>' +
        '<div class="s">' + (prev ? fmtDay(prev.date) + " から" : "最初の記録") +
        (S.weights.length >= 3 ? ' ／ 7日平均 ' + fmtN(bwAvg(i, 7)) + 'kg' : '') + '</div>';
    } else {
      var l = latestWeight();
      box.className = "bwcard none";
      mid.innerHTML =
        '<div class="v" style="font-size:16px;color:var(--ink-3)">今日はまだ</div>' +
        '<div class="s">' + (l ? "最後は " + fmtDay(l.date) + " の " + fmtN(l.kg) + "kg"
          : "記録がまだ無い。いまは設定の " + fmtN(S.bw) + "kg で計算している。") + '</div>';
    }
    box.appendChild(mid);
    var b = el("button", null, cur ? "直す" : "測る"); b.type = "button";
    b.addEventListener("click", function(){ openBwPad(t); });
    box.appendChild(b);
  }

  /* 積み上げタブの体重の推移 */
  function renderBwChart(){
    var box = $("bwBox");
    if (!S.weights.length){
      box.innerHTML = '<div class="top"><div class="eyebrow">体重の推移</div></div>' +
        '<div class="empty">まだ記録が無い。「今日」タブの体重カードから測る。</div>';
      return;
    }
    var from = addDays(today(), -119);
    var ws = [], idx = [];
    S.weights.forEach(function(x, i){ if (x.date >= from){ ws.push(x); idx.push(i); } });
    if (!ws.length){ ws = S.weights.slice(-1); idx = [S.weights.length - 1]; }

    var first = ws[0], last = ws[ws.length - 1];
    var diff = round1(last.kg - first.kg);
    var html = '<div class="top"><div class="eyebrow">体重の推移</div>' +
      '<div class="num" style="font-size:12px;color:var(--ink-3)">' + ws.length + '回・直近120日</div></div>';

    if (ws.length >= 2){
      var W = 560, H = 150, PL = 38, PR = 48, PT = 14, PB = 24;
      var t0 = Date.parse(first.date + "T12:00:00Z"), t1 = Date.parse(last.date + "T12:00:00Z");
      var span = Math.max(1, t1 - t0);
      var vals = ws.map(function(x){ return x.kg; });
      var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
      if (max - min < 1){ max += 0.5; min -= 0.5; }
      var pad = (max - min) * 0.2; min -= pad; max += pad;
      var x = function(d){ return PL + (W - PL - PR) * ((Date.parse(d + "T12:00:00Z") - t0) / span); };
      var y = function(v){ return PT + (H - PT - PB) * (1 - (v - min) / (max - min)); };
      var pts = ws.map(function(q){ return x(q.date) + "," + y(q.kg); });
      var avgPts = ws.map(function(q, k){ return x(q.date) + "," + y(bwAvg(idx[k], 7)); });

      var svg = '<svg class="spark bw" viewBox="0 0 ' + W + ' ' + H +
        '" role="img" aria-label="体重の推移">';
      [0, 0.5, 1].forEach(function(f){
        var v = min + (max - min) * f;
        svg += '<line class="grid" x1="' + PL + '" y1="' + y(v) + '" x2="' + (W - PR) +
          '" y2="' + y(v) + '"></line><text x="' + (PL - 6) + '" y="' + (y(v) + 3.5) +
          '" text-anchor="end">' + fmtN(v) + '</text>';
      });
      svg += '<polyline class="line" points="' + pts.join(" ") + '"></polyline>';
      if (ws.length >= 3) svg += '<polyline class="avg" points="' + avgPts.join(" ") + '"></polyline>';
      ws.forEach(function(q, k){
        var isLast = k === ws.length - 1;
        svg += '<circle class="dot' + (isLast ? " last" : "") + '" cx="' + x(q.date) +
          '" cy="' + y(q.kg) + '" r="' + (isLast ? 4.5 : 2.5) + '"></circle>';
      });
      svg += '<text class="val" x="' + (x(last.date) + 8) + '" y="' + (y(last.kg) + 4) + '">' +
        fmtN(last.kg) + 'kg</text>';
      svg += '<text x="' + PL + '" y="' + (H - 6) + '" text-anchor="start">' +
        first.date.slice(5).replace("-", "/") + '</text>';
      svg += '<text x="' + (W - PR) + '" y="' + (H - 6) + '" text-anchor="end">' +
        last.date.slice(5).replace("-", "/") + '</text></svg>';
      html += svg +
        '<div class="bwlegend"><span class="a"><i></i>実測</span>' +
        (ws.length >= 3 ? '<span class="b"><i></i>7日平均</span>' : '') +
        '<span style="margin-left:auto">' + fmtDay(first.date) + ' から <b class="delta ' +
        (diff > 0.05 ? "up" : (diff < -0.05 ? "down" : "flat")) + '">' +
        (diff > 0 ? "+" : "") + fmtN(diff) + 'kg</b></span></div>';
    } else {
      html += '<div class="empty">2回目を記録すると線になる。</div>';
    }

    html += '<div class="bwlist">';
    var recent = S.weights.slice(-10).reverse();
    recent.forEach(function(q, k){
      var older = recent[k + 1];
      var d = older ? round1(q.kg - older.kg) : null;
      html += '<div class="bwrow" data-d="' + q.date + '">' +
        '<span class="d">' + fmtDay(q.date) + '</span>' +
        '<button type="button" class="w">' + fmtN(q.kg) + 'kg</button>' +
        '<span class="dl ' + (d === null ? "flat" : (d > 0.05 ? "up" : (d < -0.05 ? "down" : "flat"))) +
        '">' + (d === null ? "—" : (d > 0 ? "+" : "") + fmtN(d)) + '</span>' +
        '<button type="button" class="del" aria-label="' + q.date + ' の体重を消す">×</button></div>';
    });
    html += '</div><p class="foot-note" style="margin-top:8px">' +
      '数字を押せば直せる。日々のブレは気にせず<b>7日平均の向き</b>を見る。' +
      '自重種目のボリュームと推定1RMには、<b>その頃の体重</b>を使っている。</p>';
    box.innerHTML = html;

    Array.prototype.forEach.call(box.querySelectorAll(".bwrow"), function(row){
      var date = row.getAttribute("data-d");
      row.querySelector(".w").addEventListener("click", function(){ openBwPad(date); });
      row.querySelector(".del").addEventListener("click", function(){ removeWeight(date); });
    });
  }

  /* ═══════════════ 書き出し／読み込み ═══════════════
     記録はこの端末の localStorage にしか無い。そして localStorage は
     「https + ホスト名」ごとに別物で、ホーム画面に追加したアプリと
     Safari でも別の保管庫になる（iOSの仕様）。
     → だから引っ越しの手段が無いと、URLを変えた瞬間に過去が消えたように見える。 */
  function payload(){
    return {app:"iron-ledger", v:2, at:new Date().toISOString(),
            prefs:{custom:S.custom, bars:S.bars, level:S.level, bw:S.bw,
                   offset:S.offset, tz:S.tz, rest:S.rest, sound:S.sound},
            menus:S.menus,
            weights:S.weights,
            sets:S.sets};
  }
  function markExported(){ S.lastExport = Date.now(); saveMeta(); }

  /* 取り込みは常に追加。重複は id で飛ばすので、何度読んでも増えない */
  function applyImport(d){
    var incoming = (d && Array.isArray(d.sets)) ? d.sets : null;
    if (!incoming){ toast("読めなかった（sets が無い）"); return false; }
    var have = {};
    S.sets.forEach(function(x){ have[x.id] = 1; });
    var added = 0;
    incoming.forEach(function(x){
      if (!x || typeof x.w !== "number" || typeof x.r !== "number" || !x.ex) return;
      var id = x.id || ("i" + x.ts + "-" + x.ex);
      if (have[id]) return;
      have[id] = 1; added++;
      S.sets.push({id:id, ts:x.ts || Date.parse(x.date || "") || Date.now(),
                   date:x.date || ymd(x.ts || Date.now()), ex:x.ex, w:x.w, r:x.r});
    });
    S.sets.sort(function(a,b){ return a.ts - b.ts; });
    if (d.prefs) applyPrefs(d.prefs);
    if (Array.isArray(d.weights) && d.weights.length){
      var haveW = {};
      S.weights.forEach(function(x){ haveW[x.date] = 1; });
      d.weights.forEach(function(x){
        if (x && typeof x.kg === "number" && x.date && !haveW[x.date]){
          haveW[x.date] = 1; S.weights.push({date:x.date, kg:x.kg, ts:x.ts || 0});
        }
      });
      sortWeights(); S.bw = bwNow(); saveWeights();
    }
    if (d.menus && Array.isArray(d.menus) && d.menus.length){ S.menus = d.menus; saveMenus(); }
    else if (d.program && typeof d.program === "object"){        /* ひとつ前の版の書き出し */
      Object.keys(d.program).forEach(function(id){
        var t = menuById(id);
        if (t) t.days = clone(d.program[id].days);
      });
      saveMenus();
    }
    if (!menuById(S.level)) S.level = S.menus[0].id;
    save(); saveMeta(); refresh(); render();
    toast("読み込んだ：<b>" + added + "</b> セット追加" +
          (added < incoming.length ? "（" + (incoming.length - added) + "件は重複なので飛ばした）" : ""));
    return true;
  }
  function parseAndImport(text){
    var d;
    try { d = JSON.parse(String(text).trim()); }
    catch(e){ toast("読めなかった（コードが途中で切れているかも）"); return; }
    applyImport(d);
  }

  function exportData(){
    var blob = new Blob([JSON.stringify(payload(), null, 1)], {type:"application/json"});
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = "iron-ledger-" + today() + ".json";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function(){ URL.revokeObjectURL(url); }, 2000);
    markExported(); render();
    toast("書き出した。端末を変えるときはこれを読み込む。");
  }
  function importData(){
    var inp = document.createElement("input");
    inp.type = "file"; inp.accept = "application/json,.json";
    inp.addEventListener("change", function(){
      var f = inp.files && inp.files[0];
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function(){ parseAndImport(fr.result); };
      fr.readAsText(f);
    });
    inp.click();
  }

  /* 引っ越しコード。ファイルを経由しないので、iOSのファイル選択を踏まずに
     別のURL・ホーム画面アプリ・別端末へ移せる。クリップボードはOS共通。 */
  function copyCode(){
    var text = JSON.stringify(payload());
    var n = S.sets.length;
    /* 記録が何年ぶんも溜まるとコードが長くなりすぎて貼り付けが苦しい。
       そのときは黙って失敗させず、ファイルへ誘導する。 */
    if (text.length > 400000){
      toast("記録が多すぎてコードにできない（" + Math.round(text.length/1024) +
            "KB）。上の「書き出す」でファイルにして移す。");
      return;
    }
    function fallback(){
      openText({
        title:"引っ越しコード", readOnly:true, value:text, okLabel:"閉じる",
        hint:"全部えらんでコピーする。移したい先で「貼り付け」に入れる。（" + n + "セット）",
        onOk:closeText
      });
    }
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(function(){
        markExported(); render();
        toast("コピーした（" + n + "セット）。移したい先で「貼り付け」。");
      }).catch(fallback);
    } else { fallback(); }
  }
  function pasteCode(){
    openText({
      title:"引っ越しコードを貼り付け", readOnly:false, value:"", okLabel:"読み込む",
      hint:"前の画面で「コピー」した中身をここに貼る。いまの記録は消えない（足すだけ）。",
      onOk:function(v){
        if (!v.trim()){ toast("何も貼られていない"); return; }
        closeText(); parseAndImport(v);
      }
    });
  }

  /* ── テキストのシート ── */
  var textOnOk = null;
  function openText(o){
    var ta = $("textArea");
    $("textTitle").textContent = o.title;
    $("textHint").textContent = o.hint || "";
    $("textOk").textContent = o.okLabel || "読み込む";
    ta.value = o.value || "";
    ta.readOnly = !!o.readOnly;
    textOnOk = o.onOk;
    $("textSheet").hidden = false;
    setTimeout(function(){
      ta.focus();
      if (o.readOnly) ta.select();
    }, 50);
  }
  function closeText(){ $("textSheet").hidden = true; textOnOk = null; }

  function wipe(){
    if (!window.confirm("この端末の記録を全部消す。書き出していないぶんは戻せない。続ける？")) return;
    if (!window.confirm("本当に消す？")) return;
    backup(true);
    S.sets = []; LS.del("sets"); LS.del("cache"); LS.del("queue");
    refresh(); render();
    toast("消した。");
  }

  /* ═══════════════ 起動 ═══════════════ */
  function applyPrefs(d){
    if (!d) return;
    if (Array.isArray(d.custom)) S.custom = d.custom;
    if (d.bars && typeof d.bars === "object") S.bars = d.bars;
    else if (typeof d.bar === "number") S.bars = {};          // 旧版の共通バー設定は捨てる
    if (typeof d.level === "string" && d.level) S.level = d.level;
    if (typeof d.bw === "number" && d.bw >= 30 && d.bw <= 200) S.bw = d.bw;
    if (typeof d.offset === "number") S.offset = d.offset;
    if (d.tz === "local" || d.tz === "0" || d.tz === "9" || d.tz === 0 || d.tz === 9) S.tz = String(d.tz);
    if (d.rest !== undefined) S.rest = String(d.rest);
    if (d.sound !== undefined) S.sound = String(d.sound);
    if (typeof d.lastExport === "number") S.lastExport = d.lastExport;
  }

  /* 旧版（ledger.cache ＋ ledger.queue）からの引っ越し */
  function loadSets(){
    var v2 = LS.get("sets", null);
    if (Array.isArray(v2) && v2.length) return v2;

    /* sets が空か読めない。控えがあれば、それが正。黙って空で始めない。
       ここで空のまま進むと、次に1セット記録した時点で空が上書き確定してしまう。 */
    var bak = LS.get("bak", null);
    if (bak && Array.isArray(bak.sets) && bak.sets.length){
      S.restored = bak.sets.length;
      return bak.sets;
    }
    if (Array.isArray(v2)) return v2;

    var cache = LS.get("cache", []) || [], queue = LS.get("queue", []) || [];
    var del = {}, out = [];
    queue.forEach(function(op){ if (op && op.op === "del") del[op.id] = 1; });
    cache.forEach(function(r){ if (r && !del[r.id]) out.push(r); });
    var haveTs = {};
    out.forEach(function(r){ haveTs[r.ts] = 1; });
    queue.forEach(function(op){
      if (!op || op.op !== "add" || haveTs[op.ts]) return;
      out.push({id:op.cid, ts:op.ts, date:op.date, ex:op.ex, w:op.w, r:op.r});
    });
    out = out.filter(function(r){
      return r && typeof r.w === "number" && typeof r.r === "number" && r.ex && r.date;
    }).sort(function(a,b){ return a.ts - b.ts; });
    if (out.length) LS.set("sets", out);
    return out;
  }

  function start(){
    var prefs = LS.get("prefs", null);
    /* 旧版は日付の区切りが UTC 固定だった。設定が無い＝まだ一度も選んでいない人。
       そのまま端末のローカル時刻に切り替えると、旧版で入れた記録の日付が
       ズレたまま残り、「今日やったのに今日のぶんが無い」ことになる。
       ts（記録した瞬間）が正なので、そこから付け直す。 */
    var hadTz = !!(prefs && prefs.tz !== undefined);
    applyPrefs(prefs);
    S.menus = loadMenus();
    var wl = LS.get("weights", null);
    S.weights = Array.isArray(wl) ? wl.filter(function(x){
      return x && typeof x.kg === "number" && x.date;
    }) : [];
    sortWeights();
    if (!menuById(S.level)) S.level = S.menus[0].id;   /* 消されたメニューを指していたら先頭へ */
    saveMenus();
    S.sets = loadSets();
    S.demo = buildDemo();

    if (!hadTz && S.sets.length){
      var off = 0;
      S.sets.forEach(function(x){
        var d = ymd(x.ts);
        if (d !== x.date){ x.date = d; off++; }
      });
      if (off){ backup(true); save(); S.refiled = off; }
    }
    saveMeta();                 /* tz を書いて、二度と走らせない */

    refresh();
    S.calMonth = today().slice(0,7);

    var first = menuDay().items[0];
    if (first) pick(first, false); else render();
    setView("today");

    /* 起動時に手当てしたことは黙らない。黙ると次に同じ不安を持つ。 */
    if (S.restored){
      toast("記録が読めなかったので<b>控えから" + S.restored + "件</b>戻した。");
    } else if (S.refiled){
      toast("旧版はUTC基準で日付を切っていたので、<b>" + S.refiled +
            "件</b>の日付をこの端末の時刻で付け直した。記録は消えていない。");
    }
  }

  /* ═══════════════ イベント ═══════════════ */
  $("wOut").addEventListener("click", openWeightPad);
  $("rOut").addEventListener("click", openRepPad);
  $("logBtn").addEventListener("click", logSet);
  $("barSel").addEventListener("change", function(e){
    S.bars[S.ex] = Number(e.target.value); renderPlates(); saveMeta();
  });
  $("dayEdit").addEventListener("click", function(){ openDayEditor(dayIndex()); });
  $("edBack").addEventListener("click", function(){
    if (window.confirm("保存せずに閉じる？")) closeEditor();
  });
  $("edSave").addEventListener("click", saveEditor);
  $("pickClose").addEventListener("click", closePicker);
  $("pickSheet").addEventListener("click", function(e){
    if (e.target === $("pickSheet")) closePicker();
  });
  $("dayAdd").addEventListener("click", addDay);
  $("progReset").addEventListener("click", resetProgram);
  $("dayPrev").addEventListener("click", function(){ S.offset--; saveMeta(); render(); });
  $("dayNext").addEventListener("click", function(){ S.offset++; saveMeta(); render(); });
  $("otherToggle").addEventListener("click", function(){ S.showRail = !S.showRail; renderRail(); });
  $("menuAdd").addEventListener("click", function(){ addMenu(false); });
  $("menuCopy").addEventListener("click", function(){ addMenu(true); });
  $("progBase").addEventListener("click", setAsBase);

  /* openBwPad は日付を取る。そのまま渡すとクリックイベントが日付として入る */
  $("bwOut").addEventListener("click", function(){ openBwPad(); });
  $("tzSel").addEventListener("change", function(e){ S.tz = e.target.value; saveMeta(); render(); });
  $("restSel").addEventListener("change", function(e){ S.rest = e.target.value; saveMeta(); });
  $("soundSel").addEventListener("change", function(e){
    S.sound = e.target.value; unlockAudio();
    if (S.sound !== "off"){ beep(); buzz(); }
  });
  $("expBtn").addEventListener("click", exportData);
  $("impBtn").addEventListener("click", importData);
  $("copyBtn").addEventListener("click", copyCode);
  $("pasteBtn").addEventListener("click", pasteCode);
  $("textClose").addEventListener("click", closeText);
  $("textOk").addEventListener("click", function(){
    if (textOnOk) textOnOk($("textArea").value);
  });
  $("textSheet").addEventListener("click", function(e){
    if (e.target === $("textSheet")) closeText();
  });
  $("wipeBtn").addEventListener("click", wipe);
  $("refileBtn").addEventListener("click", refileDates);
  $("restoreBtn").addEventListener("click", restoreBak);
  $("diagCopy").addEventListener("click", function(){
    var t = diagText();
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(t).then(function(){ toast("診断をコピーした。"); })
        .catch(function(){ openText({title:"診断", readOnly:true, value:t, okLabel:"閉じる",
          hint:"全部えらんでコピーする。", onOk:closeText}); });
    } else {
      openText({title:"診断", readOnly:true, value:t, okLabel:"閉じる",
        hint:"全部えらんでコピーする。", onOk:closeText});
    }
  });

  $("calPrev").addEventListener("click", function(){ shiftMonth(-1); });
  $("calNext").addEventListener("click", function(){ shiftMonth(1); });
  function shiftMonth(n){
    var p = S.calMonth.split("-"), Y = +p[0], M = +p[1] + n;
    while (M < 1){ M += 12; Y--; }
    while (M > 12){ M -= 12; Y++; }
    S.calMonth = Y + "-" + ("0" + M).slice(-2);
    S.calSel = null;
    renderCal(); renderCalDay();
  }

  VIEWS.forEach(function(x){ $(x[2]).addEventListener("click", function(){ setView(x[0]); }); });

  $("padClose").addEventListener("click", closePad);
  $("padOk").addEventListener("click", padCommit);
  $("padSheet").addEventListener("click", function(e){ if (e.target === $("padSheet")) closePad(); });
  document.addEventListener("keydown", function(e){
    if (!S.pad) return;
    if (e.key === "Escape"){ closePad(); return; }
    if (e.key === "Enter"){ padCommit(); return; }
    if (e.key === "Backspace"){ padKey("←"); e.preventDefault(); return; }
    if (/^[0-9]$/.test(e.key)){ padKey(e.key); return; }
    if (e.key === "." && S.pad.opt.dec){ padKey("."); }
  });

  setInterval(renderClock, 30000);
  start();
})();
