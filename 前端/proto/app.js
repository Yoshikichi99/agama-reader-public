/* 掌上阿含 · 界面与路由（无框架，hash 路由） */
(function () {
  'use strict';

  var app = document.getElementById('app');
  var selHandler = null;   // 当前阅读页的选字处理函数
  var bootEl = document.getElementById('boot');
  var ORDER = {};          // 部 -> 按目录顺序排好的经号
  var LAST = 'ar.last';
  var LANG_KEY = 'ar.lang';
  var scrollMemo = {};      // 非阅读页的滚动位置：首页→设置→返回时恢复
  var lastRoute = '';
  var searchBack = null;    // 从搜索结果进入阅读时，返回原搜索页
  var searchRestoreScroll = null;
  var customFontName = '';
  var customFontLoaded = false;

  /* 自定义阅读字体存 IndexedDB（字体可能几 MB，localStorage 放不下） */
  var FONT_DB = 'ar.fonts';
  function fontDb() {
    return new Promise(function (resolve, reject) {
      var r = indexedDB.open(FONT_DB, 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('fonts', { keyPath: 'id' }); };
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }
  function fontGet() {
    return fontDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction('fonts', 'readonly').objectStore('fonts').get('read');
        t.onsuccess = function () { resolve(t.result || null); };
        t.onerror = function () { reject(t.error); };
      });
    }).catch(function () { return null; });
  }
  function fontPut(name, data) {
    return fontDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction('fonts', 'readwrite').objectStore('fonts').put({ id: 'read', name: name, data: data });
        t.onsuccess = function () { resolve(); };
        t.onerror = function () { reject(t.error); };
      });
    });
  }
  function fontDel() {
    return fontDb().then(function (db) {
      return new Promise(function (resolve) {
        db.transaction('fonts', 'readwrite').objectStore('fonts').delete('read');
        resolve();
      });
    }).catch(function () { });
  }
  function b64Bytes(b64) {
    var s = atob(String(b64 || '')), a = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
    return a;
  }
  function applyCustomFont(name, b64) {
    return new Promise(function (resolve, reject) {
      if (!window.FontFace || !document.fonts) return reject(new Error('no FontFace'));
      var face = new FontFace('ARReadFont', b64Bytes(b64).buffer);
      face.load().then(function (f) {
        document.fonts.add(f);
        customFontName = name || '自定义字体';
        customFontLoaded = true;
        resolve();
      }, reject);
    });
  }
  function loadCustomFont() {
    return fontGet().then(function (rec) {
      if (!rec || !rec.data) return null;
      return applyCustomFont(rec.name, rec.data);
    }).catch(function () { return null; });
  }
  function pickReadFont() {
    if (window.ARIO && window.ARIO.pickFont) window.ARIO.pickFont();
    else toast('此環境不支持選字體');
  }
  window.ARIO_onFont = function (name, b64) {
    if (!b64) { toast('字體讀取失敗'); return; }
    fontPut(name, b64).then(function () {
      return applyCustomFont(name, b64);
    }).then(function () {
      var p = readPrefs();
      p.font = 'custom';
      savePrefs(p);
      if ((location.hash || '').indexOf('#/settings') === 0) viewSettings();
      toast('已套用字體：' + (name || '自訂'));
    }).catch(function () {
      toast('字體格式不支持：請用 TTF / OTF / WOFF / WOFF2（TTC 字體集暫不支持）');
    });
  };

  /* 原生在页面加载完成、系统深浅色切换时回报；比 WebView 的 matchMedia 可靠 */
  window.__sysDark = null;
  window.ARIO_onSystemDark = function (dark) {
    window.__sysDark = !!dark;
    if (readPrefs().theme === 'system') applyPrefs();
  };

  /* ---------- 渲染入口：所有 HTML 都经这里上屏，顺带做繁简转换 ---------- */
  function paint(html) {
    applyPrefs();          // 每次上屏都同步一次偏好，防止外部改动未生效
    // 弹层挂在 body 上，不属于 #app；换页时要一并清掉，否则会盖在新页面上
    Array.prototype.forEach.call(document.querySelectorAll('.sheet-mask'), function (m) {
      m.remove();
    });
    document.body.classList.remove('paged-mode');
    app.innerHTML = AR.conv(html);
    // 不是阅读页就告诉原生「已不在分页」，否则音量键会被一直吃掉
    if (!document.getElementById('paged') && window.ARIO && window.ARIO.setPaged) {
      try { window.ARIO.setPaged(false); } catch (e) { }
    }
    // 阅读页隐藏状态栏；退出恢复。系统顶部手势仍可临时调出。
    if (window.ARIO && window.ARIO.setImmersive) {
      try { window.ARIO.setImmersive(!!document.getElementById('readApp')); } catch (e) { }
    }
    // 顶栏高度因安全区而异，量出来给吸顶元素用
    var bb = document.querySelector('.bar');
    if (bb) document.documentElement.style.setProperty('--barh', bb.offsetHeight + 'px');
    // 每次换页都归零：不做浏览器那种「回到上次滚动位置」
    // 阅读页始终从顶部开始；其它页面从 scrollMemo 恢复（首页↔设置等）
    var routeKey = location.hash || '#/';
    var keep = /^#\/k\//.test(routeKey) ? 0 : (scrollMemo[routeKey] || 0);
    window.scrollTo(0, keep);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function h(html) { return html; }

  function toast(msg, ms) {
    var el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, ms || 1800);
  }

  function go(hash) { location.hash = hash; }

  function orderOf(series) {
    if (ORDER[series]) return ORDER[series];
    var out = [];
    var g = AR.S.canon.groups;
    for (var i = 0; i < g.length; i++) {
      for (var j = 0; j < g[i].c.length; j++) {
        if (g[i].c[j].id !== series) continue;
        AR.walk(g[i].c[j], [], series, []).forEach(function (lf) { out.push(lf.k); });
      }
    }
    // 阅读页的上一经/下一经按经号数字自然顺序，不跟目录的「相应/品」分组顺序走。
    function seq(k) {
      var m = /(\d+(?:\.\d+)*)$/.exec(String(k || ''));
      if (!m) return [Number.MAX_SAFE_INTEGER];
      return m[1].split('.').map(function (x) { return +x; });
    }
    function cmp(a, b) {
      var aa = seq(a), bb = seq(b);
      for (var n = 0; n < Math.max(aa.length, bb.length); n++) {
        var d = (aa[n] == null ? -1 : aa[n]) - (bb[n] == null ? -1 : bb[n]);
        if (d) return d;
      }
      return String(a).localeCompare(String(b));
    }
    out = out.filter(function (k, i, a) { return k && a.indexOf(k) === i; });
    out.sort(cmp);
    ORDER[series] = out;
    return out;
  }

  /* ---------- 经后笔记 ---------- */

  function getPost(k) {
    try {
      var raw = localStorage.getItem('ar.post.' + k);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function segNoteHTML(b, nz) {
    if (!nz || !nz.h) return '';
    return '<div class="nz" data-nb="' + b + '">' +
      '<span class="nz-t">筆記</span>' +
      esc(nz.h).replace(/\n/g, '<br>') + '</div>';
  }

  /* 段笔记保存/删除后立刻更新当前页，不用重开经文。
   * 有译文时笔记在 .tr 之后，没有就在段落之后。 */
  function refreshSegNote(k, b, saved) {
    var p = document.querySelector('.read-body p[data-b="' + b + '"]');
    if (!p) return;
    var old = document.querySelector('.read-body .nz[data-nb="' + b + '"]');
    if (!saved) {
      if (old) old.remove();
      p.classList.remove('hasn');
    } else {
      p.classList.add('hasn');
      var html = AR.conv(segNoteHTML(b, segNotes(k)[b]));
      if (old) {
        old.outerHTML = html;
      } else {
        var after = p, next = p.nextElementSibling;
        if (next && next.classList && next.classList.contains('tr')) after = next;
        after.insertAdjacentHTML('afterend', html);
      }
    }
    // 笔记增减会改变正文高度，翻页模式要重算页数
    if (readPrefs().paging === 'page' && window.__pageRecalc) window.__pageRecalc(true);
  }

  function savePost(k, txt) {
    var old = getPost(k) || {};
    var now = new Date().toISOString();
    var rec = { k: k, h: txt, created: old.created || now, updated: now };
    localStorage.setItem('ar.post.' + k, JSON.stringify(rec));
    clearDraft('post', k);
    return rec;
  }

  function delPost(k) {
    localStorage.removeItem('ar.post.' + k);
    clearDraft('post', k);
  }

  function fmtTs(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' +
      p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* ---------- 书库：收藏 / 高亮 / 段笔记 / 经后笔记 ----------
   * 锚点跟注释层一致：经级用经号 k，段级用块序号 b（见 注释层设计.md 第四节）。
   * 首版用 localStorage（个人笔记体量小）；量大了再迁 IndexedDB。
   *   ar.fav  { k: {t} }
   *   ar.hl   { k: { b: {t} } }
   *   ar.sn   { k: { b: {h, created, updated} } }
   *   ar.post.<k> {h, created, updated}      经后笔记（旧格式，保留）
   */
  var K_FAV = 'ar.fav', K_HL = 'ar.hl', K_SN = 'ar.sn';

  function readStore(key, def) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : def;
    } catch (e) { return def; }
  }

  function writeStore(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { }
  }

  function nowIso() { return new Date().toISOString(); }

  function favOf(k) { return readStore(K_FAV, {})[k] || null; }

  function isFav(k) { return !!favOf(k); }

  function setFav(k, tag) {
    var m = readStore(K_FAV, {});
    var old = m[k] || {};
    m[k] = { t: old.t || nowIso(), tag: (tag || '').trim() };
    writeStore(K_FAV, m);
  }

  function unfav(k) {
    var m = readStore(K_FAV, {});
    delete m[k];
    writeStore(K_FAV, m);
  }

  function hlMap(k) { return readStore(K_HL, {})[k] || {}; }

  /** 某段的高亮区间数组。旧格式（整段一条对象）读出来时转成区间 [0,-1]。 */
  function hlRanges(k, b) {
    var m = hlMap(k)[b];
    if (!m) return [];
    if (Array.isArray(m)) return m;
    return [{ s: 0, e: -1, t: m.t, x: m.x || '', fp: m.fp || '' }];
  }

  /** 追加或移除一个区间；返回该段是否还剩高亮 */
  function toggleRangeHl(k, b, s, e, fpv, excerpt) {
    var all = readStore(K_HL, {});
    var m = all[k] || (all[k] = {});
    var arr = hlRanges(k, b).slice();
    var idx = -1;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].s === s && (arr[i].e == null ? -1 : arr[i].e) === e) { idx = i; break; }
    }
    if (idx >= 0) arr.splice(idx, 1);
    else arr.push({ s: s, e: e, t: nowIso(), x: excerpt || '', fp: fpv || '' });
    if (arr.length) m[b] = arr;
    else delete m[b];
    if (!Object.keys(m).length) delete all[k];
    writeStore(K_HL, all);
    return arr.length > 0;
  }

  /** 整段高亮（没有选区时用） */
  function toggleHl(k, b, excerpt, fpv) {
    return toggleRangeHl(k, b, 0, -1, fpv, excerpt);
  }

  function segNotes(k) { return readStore(K_SN, {})[k] || {}; }

  function setSegNote(k, b, txt, excerpt, fpv) {
    var all = readStore(K_SN, {});
    var m = all[k] || (all[k] = {});
    var old = m[b] || {};
    if (!txt) { delete m[b]; }
    else {
      m[b] = {
        h: txt, x: excerpt || old.x || '', fp: fpv || old.fp || '',
        created: old.created || nowIso(), updated: nowIso()
      };
    }
    if (!Object.keys(m).length) delete all[k];
    writeStore(K_SN, all);
    clearDraft('seg', k, b);
  }

  /* ---------- 未保存的笔记草稿 ----------
   * 每敲一个字就写 localStorage：切页、按返回、锁屏、被杀进程都不丢。
   * 草稿不进入「我的资料」备份，也不参与同步；存满 30 天自动清。
   */
  var K_DRAFTS = 'ar.drafts';

  function draftMap() {
    var m = readStore(K_DRAFTS, {});
    return (m && typeof m === 'object' && !Array.isArray(m)) ? m : {};
  }
  function draftKey(kind, k, b) { return kind + '|' + k + '|' + (b == null ? '' : b); }
  function getDraft(kind, k, b) {
    var d = draftMap()[draftKey(kind, k, b)];
    return (d && typeof d === 'object') ? d : null;
  }
  function putDraft(kind, k, b, obj) {
    var m = draftMap();
    m[draftKey(kind, k, b)] = obj;
    writeStore(K_DRAFTS, m);
  }
  function clearDraft(kind, k, b) {
    var m = draftMap(), key = draftKey(kind, k, b);
    if (m[key]) { delete m[key]; writeStore(K_DRAFTS, m); }
  }
  /* 草稿比已保存的笔记还旧 → 丢弃；与已保存内容一致 → 清掉 */
  function draftFor(kind, k, b, savedText, savedUpdated) {
    var d = getDraft(kind, k, b);
    if (!d || typeof d.h !== 'string' || d.h === savedText) {
      if (d) clearDraft(kind, k, b);
      return { text: savedText, restored: false };
    }
    var upd = Date.parse(savedUpdated || '');
    if (!isNaN(upd) && d.ts && d.ts < upd) {
      clearDraft(kind, k, b);
      return { text: savedText, restored: false };
    }
    return { text: d.h, restored: true };
  }
  function draftHintHTML(id) {
    return '<div class="draft-hint" id="' + id + 'Hint">已恢復上次未儲存的草稿' +
      '<span id="' + id + 'Discard">捨棄</span></div>';
  }
  function purgeDrafts() {
    var m = draftMap(), cut = Date.now() - 30 * 86400000, dirty = false;
    Object.keys(m).forEach(function (key) {
      var d = m[key];
      if (!d || !d.ts || d.ts < cut) { delete m[key]; dirty = true; }
    });
    if (dirty) writeStore(K_DRAFTS, m);
  }

  function allFavs() {
    var m = readStore(K_FAV, {});
    return Object.keys(m).map(function (k) {
      var v = m[k];
      if (!v || typeof v !== 'object') return null;   // 旧版/损坏记录不让整页炸掉
      return { k: k, t: v.t || '', tag: v.tag || '' };
    }).filter(Boolean).sort(function (a, b) { return a.t < b.t ? 1 : -1; });
  }

  function allHl() {
    var m = readStore(K_HL, {}), out = [];
    Object.keys(m).forEach(function (k) {
      Object.keys(m[k]).forEach(function (b) {
        var arr = Array.isArray(m[k][b]) ? m[k][b] : [m[k][b]];
        arr.forEach(function (r) {
          out.push({
            k: k, b: +b, t: r.t, x: r.x || '', fp: r.fp || '',
            s: r.s == null ? 0 : r.s, e: r.e == null ? -1 : r.e
          });
        });
      });
    });
    return out.sort(function (a, b) { return a.t < b.t ? 1 : -1; });
  }

  function allSegNotes() {
    var m = readStore(K_SN, {}), out = [];
    Object.keys(m).forEach(function (k) {
      Object.keys(m[k]).forEach(function (b) {
        out.push({
          k: k, b: +b, h: m[k][b].h, x: m[k][b].x || '',
          fp: m[k][b].fp || '', t: m[k][b].updated
        });
      });
    });
    return out.sort(function (a, b) { return a.t < b.t ? 1 : -1; });
  }

  /* ---------- 文件夹：收藏 / 笔记 / 划线 各自独立、可嵌套 ---------- */
  var K_FOLDERS = 'ar.folders', K_ITEM_FOLDER = 'ar.itemfolder';
  var FOLDER_TYPE_NAME = { fav: '收藏', note: '筆記', hl: '劃線' };

  function folderTypeOf(kind) { return kind === 'seg' || kind === 'post' ? 'note' : kind; }

  function folderTree(type) {
    var all = readStore(K_FOLDERS, {});
    var arr = all[type];
    return Array.isArray(arr) ? arr : [];
  }
  function saveFolderTree(type, arr) {
    var all = readStore(K_FOLDERS, {});
    all[type] = arr || [];
    writeStore(K_FOLDERS, all);
  }
  function folderById(type, id) {
    return folderTree(type).filter(function (f) { return f.id === id; })[0] || null;
  }
  function folderPath(type, id) {
    var p = [], guard = 0;
    while (id && guard++ < 50) {
      var f = folderById(type, id);
      if (!f) break;
      p.unshift(f.name);
      id = f.parent || '';
    }
    return p.join(' / ');
  }
  function folderChildren(type, parent) {
    return folderTree(type).filter(function (f) { return (f.parent || '') === (parent || ''); });
  }
  function folderSubtree(type, id) {
    var out = {}, arr = folderTree(type);
    function add(x) {
      out[x] = true;
      arr.forEach(function (f) { if ((f.parent || '') === x) add(f.id); });
    }
    add(id);
    return out;
  }
  function itemKey(kind, it) {
    if (kind === 'fav') return it.k;
    if (kind === 'note' || kind === 'seg' || kind === 'post') {
      return it.k + '\u0001' + (kind === 'post' ? 'post' : it.b);
    }
    return it.k + '\u0001' + it.b + '\u0001' + it.s + '\u0001' + it.e;
  }
  function itemFolder(type, key) {
    var all = readStore(K_ITEM_FOLDER, {});
    return (all[type] || {})[key] || '';
  }
  function setItemFolder(type, key, folder) {
    var all = readStore(K_ITEM_FOLDER, {});
    var m = all[type] || (all[type] = {});
    if (folder) m[key] = folder; else delete m[key];
    writeStore(K_ITEM_FOLDER, all);
  }
  function matchesFolder(type, kind, it, folder) {
    if (folder === 'all') return true;
    var key = itemKey(kind, it), cur = itemFolder(type, key);
    if (folder === 'root') return !cur;
    return !!folderSubtree(type, folder)[cur];
  }
  function folderItems(type, id) {
    var sub = folderSubtree(type, id), all = readStore(K_ITEM_FOLDER, {})[type] || {};
    return Object.keys(all).filter(function (key) { return !!sub[all[key]]; });
  }
  function removeItemByKey(type, key) {
    var p = key.split('\u0001');
    if (type === 'fav') { unfav(p[0]); return; }
    if (type === 'note') {
      if (p[1] === 'post') delPost(p[0]);
      else setSegNote(p[0], +p[1], '');
      return;
    }
    if (type === 'hl') {
      var m = readStore(K_HL, {}), bucket = m[p[0]], arr = bucket && bucket[+p[1]];
      if (!arr) return;
      var list = (Array.isArray(arr) ? arr : [arr]).filter(function (r) {
        return !((r.s == null ? 0 : r.s) === +p[2] && (r.e == null ? -1 : r.e) === +p[3]);
      });
      if (list.length) bucket[+p[1]] = list; else delete bucket[+p[1]];
      if (!Object.keys(bucket).length) delete m[p[0]];
      writeStore(K_HL, m);
    }
  }
  function cleanItemFolder(type, key) {
    var all = readStore(K_ITEM_FOLDER, {});
    if (all[type] && all[type][key]) {
      delete all[type][key];
      writeStore(K_ITEM_FOLDER, all);
    }
  }

  function allPosts() {
    var out = [];
    for (var i = 0; i < localStorage.length; i++) {
      var key = localStorage.key(i);
      if (key.indexOf('ar.post.') !== 0) continue;
      try {
        var v = JSON.parse(localStorage.getItem(key));
        if (v && v.h) out.push({ k: key.slice(8), h: v.h, t: v.updated || v.created });
      } catch (e) { }
    }
    return out.sort(function (a, b) { return a.t < b.t ? 1 : -1; });
  }

  /* ---------- 笔记包：导出 / 导入 / 多套注释 ----------
   * 格式沿用 注释层设计.md 第五节的 pack，四种条目共用一个 entries 数组：
   *   kind: post（经后笔记）/ seg（段笔记）/ hl（高亮）/ fav（收藏）
   * 锚点：经级 {k}，段级 {k, b, fp}。fp 是段落指纹，跨版本导入靠它重新对位。
   */
  var K_SETS = 'ar.sets', K_ZCJ = 'ar.zcjOn';
  var PACK_KIND = 'agama-reader-library';

  function allSets() { return readStore(K_SETS, {}); }

  function saveSet(id, obj) { var m = allSets(); m[id] = obj; writeStore(K_SETS, m); }

  function delSet(id) { var m = allSets(); delete m[id]; writeStore(K_SETS, m); }

  function zcjOn() {
    var v = null;
    try { v = localStorage.getItem(K_ZCJ); } catch (e) { }
    return v === null ? true : v === '1';
  }

  function setZcjOn(on) {
    try { localStorage.setItem(K_ZCJ, on ? '1' : '0'); } catch (e) { }
  }

  function ymd() {
    var d = new Date(), p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
  }

  function buildPack(shareLic) {
    var entries = [];
    allPosts().forEach(function (p) {
      entries.push({ kind: 'post', a: { k: p.k }, h: p.h, t: p.t });
    });
    allSegNotes().forEach(function (s) {
      entries.push({ kind: 'seg', a: { k: s.k, b: s.b, fp: s.fp || '' }, h: s.h, x: s.x, t: s.t });
    });
    allHl().forEach(function (h) {
      entries.push({
        kind: 'hl',
        a: { k: h.k, b: h.b, fp: h.fp || '', s: h.s == null ? 0 : h.s, e: h.e == null ? -1 : h.e },
        x: h.x, t: h.t
      });
    });
    allFavs().forEach(function (f) {
      entries.push({ kind: 'fav', a: { k: f.k }, tag: f.tag, t: f.t });
    });
    // 用户自己写的东西，著作权在用户，默认不代为授权
    var mine = shareLic || '未指定（著作權屬作者本人，保留所有權利）';

    return {
      v: 1,
      kind: PACK_KIND,
      meta: {
        id: 'local',
        name: '我的筆記',
        author: '',
        license: shareLic || '',
        app: '掌上阿含 0.1.0',
        corpus: '2026-11-13',
        created: nowIso(),
        count: entries.length
      },
      licenses: {
        notes: mine,
        quotedText: 'CC BY-NC-SA 4.0（entries 中 x 欄位的經文摘錄，著作權屬莊春江）'
      },
      notice: '本檔含兩類內容，授權不同，分開看待：'
        + '① 筆記與標籤（h / tag 欄位）——由作者本人撰寫，著作權屬作者。'
        + '本程式不對其施加任何授權條款，作者亦未在此授予他人許可；'
        + '是否可再散布，取決於作者本人的聲明。'
        + '② 經文摘錄（x 欄位）——著作權屬莊春江，依 CC BY-NC-SA 4.0 授權：'
        + '可自由複製、改作、再散布；須註明作者與出處；不得作商業使用；衍生作品須以相同條款分享。'
        + '轉發本檔時，僅第 ② 部分受上述條款約束。',
      entries: entries
    };
  }

  // 调试钩子：便于在真机上核对包结构，也方便命令行导出（不影响正常流程）
  window.AR_buildPack = buildPack;
  window.AR_paliPack = buildPaliPack;
  window.AR_importPali = importPaliZhPack;
  window.AR_resolve = resolveSutta;   // 调试用：命令行核对经号解析

  function doExport() {
    var pack = buildPack(null);
    if (!pack.entries.length) { toast('還沒有可導出的內容'); return; }
    var text = JSON.stringify(pack, null, 1);
    var name = 'agama-notes-' + ymd() + '.json';
    if (window.ARIO && window.ARIO.export) {
      window.ARIO.export(name, 'application/json', text);
      return;
    }
    copyText(text, '已複製筆記包（可存成 ' + name + '）');
  }
  function startImport() {
    if (window.ARIO && window.ARIO.pick) { window.ARIO.pick(); return; }
    // 浏览器里没有文件选择器桥接，退回粘贴
    var mask = document.createElement('div');
    mask.className = 'sheet-mask';
    mask.innerHTML = '<div class="sheet"><div class="hd"><span class="t">貼上筆記包</span>' +
      '<span class="x" data-close>×</span></div>' +
      '<textarea id="pgTxt" placeholder="把 .json 檔的內容貼在這裡"></textarea>' +
      '<div class="btns"><span class="btn" id="pgCancel">取消</span>' +
      '<span class="btn pri" id="pgOk">導入</span></div></div>';
    mountSheet(mask);
    var ta = mask.querySelector('#pgTxt');
    ta.focus();
    mask.addEventListener('click', function (ev) {
      if (ev.target === mask || ev.target.hasAttribute('data-close')) mask.remove();
    });
    mask.querySelector('#pgCancel').onclick = function () { mask.remove(); };
    mask.querySelector('#pgOk').onclick = function () {
      var t = ta.value.trim();
      mask.remove();
      if (t) handleAnyImport(t);
    };
  }

  // Android 壳回传文件内容时调用（pick 不带回调，内容只从这里回来）
  window.ARIO_onFile = function (text) { handleAnyImport(text); };

  /* 一个入口认两种包：
   *   agama-userdata（自己导出的备份）→ 合并用户数据
   *   带 entries 的笔记包              → 作为新的註釋來源导入
   */
  function handleAnyImport(text) {
    var p = null;
    try { p = JSON.parse(text); } catch (e) {
      var md = parseNoteMarkdown(text);
      if (md.length) { importNotePack({ notes: md, meta: { name: '手寫筆記' } }); return; }
      toast('檔案不是有效的 JSON'); return;
    }
    if (!p || typeof p !== 'object') { toast('檔案格式不對'); return; }
    if (p.kind === 'agama-note-pack' || Array.isArray(p.notes)) {
      importNotePack(p);
      return;
    }
    if (p.kind === 'agama-pali-zh') {
      importPaliZhPack(p);
      return;
    }
    if (p.kind === 'agama-userdata' || (p.data && (p.data.notes || p.data.annotations || p.data.palizh))) {
      importUserData(p);
      return;
    }
    if (p.entries && p.entries.length) {
      handleImportText(text);
      return;
    }
    toast('認不出這個檔案的類型');
  }

  function handleImportText(text) {
    var p = null;
    try { p = JSON.parse(text); } catch (e) { toast('檔案不是有效的 JSON'); return; }
    if (!p || !p.entries || !p.entries.length) { toast('檔案裡沒有筆記'); return; }

    var name = (p.meta && p.meta.name) || '未命名';
    var author = (p.meta && p.meta.author) || '未署名';
    var mask = document.createElement('div');
    mask.className = 'sheet-mask';
    mask.innerHTML = '<div class="sheet"><div class="hd"><span class="t">導入筆記</span>' +
      '<span class="x" data-close>×</span></div>' +
      '<table class="lict" style="margin-bottom:16px">' +
      '<tr><th>名稱</th><td>' + esc(name) + '</td></tr>' +
      '<tr><th>作者</th><td>' + esc(author) + '</td></tr>' +
      '<tr><th>條目</th><td>' + p.entries.length + ' 條</td></tr>' +
      (p.meta && p.meta.license
        ? '<tr><th>授權</th><td>' + esc(p.meta.license) + '</td></tr>'
        : '<tr><th>授權</th><td>未指定<span class="dim">　筆記著作權屬原作者，未授予額外許可</span></td></tr>') +
      '</table>' +
      '<p class="dim" style="font-size:12.5px;color:var(--ink3);line-height:1.8;margin:0 0 14px">' +
      '「合併」會把內容併進你自己的筆記；「新的一套」會獨立保存，' +
      '可在設定裡與莊春江的註釋同時開啟（疊加）或單獨開啟（切換）。</p>' +
      '<div class="btns"><span class="btn" id="ipCancel">取消</span>' +
      '<span class="btn" id="ipSet">作為新的一套</span>' +
      '<span class="btn pri" id="ipMerge">合併進我的筆記</span></div></div>';
    mountSheet(mask);
    mask.addEventListener('click', function (ev) {
      if (ev.target === mask || ev.target.hasAttribute('data-close')) mask.remove();
    });
    mask.querySelector('#ipCancel').onclick = function () { mask.remove(); };
    mask.querySelector('#ipMerge').onclick = function () {
      var n = importMerge(p);
      mask.remove();
      toast('已合併 ' + n + ' 條');
      viewSettings();
    };
    mask.querySelector('#ipSet').onclick = function () {
      var id = 'set' + Date.now();
      saveSet(id, { meta: p.meta || { name: name }, entries: p.entries, on: true, added: nowIso() });
      mask.remove();
      toast('已導入一套：「' + name + '」');
      viewSettings();
    };
  }

  function importMerge(p) {
    var n = 0;
    (p.entries || []).forEach(function (e) {
      var a = e.a || {};
      if (!a.k) return;
      if (e.kind === 'post') { if (e.h) { savePostRaw(a.k, e.h, e.t); n++; } }
      else if (e.kind === 'seg') { if (e.h) { setSegNote(a.k, a.b, e.h, e.x, a.fp); n++; } }
      else if (e.kind === 'hl') {
        toggleRangeHl(a.k, a.b, a.s == null ? 0 : a.s, a.e == null ? -1 : a.e, a.fp, e.x); n++;
      }
      else if (e.kind === 'fav') { setFav(a.k, e.tag); n++; }
    });
    return n;
  }

  /* 简单手写笔记包 / AI 批量包：只认 k、b（可选）、text，不强迫用户学内部结构 */
  function importNotePack(p) {
    var n = 0;
    (p.notes || []).forEach(function (x) {
      if (!x || !x.k || !x.text) return;
      var k = String(x.k);
      if (x.post === true || x.b == null) {
        savePostRaw(k, String(x.text), x.t);
        if (x.folder) setItemFolder('note', k + '\u0001post', x.folder);
        n++;
      } else {
        var b = +x.b;
        setSegNote(k, b, String(x.text), x.quote || '', x.fp || '');
        if (x.folder) setItemFolder('note', k + '\u0001' + b, x.folder);
        n++;
      }
    });
    if (!n) { toast('筆記包裡沒有可導入的內容'); return; }
    toast('已導入 ' + n + ' 條筆記');
    if ((location.hash || '').indexOf('#/notes') === 0) viewNotes();
  }

  /* 手写模板：
   * ## SA.1
   * ### 第 6 段
   * 笔记内容……
   * ## SA.8
   * （没有“### 第N段”就作为经后笔记）
   */
  function parseNoteMarkdown(text) {
    var out = [], key = '', b = null, buf = [];
    function flush() {
      var body = buf.join('\n').trim();
      if (key && body) {
        if (b == null) out.push({ k: key, post: true, text: body });
        else out.push({ k: key, b: b, text: body });
      }
      buf = [];
    }
    String(text || '').split(/\r?\n/).forEach(function (line) {
      var m = line.match(/^##\s+([A-Za-z]{2,3}\.\d+(?:\.\d+)*)\s*$/);
      if (m) { flush(); key = m[1]; b = null; return; }
      var bm = line.match(/^###\s*第\s*(\d+)\s*段/);
      if (bm) { flush(); b = +bm[1]; return; }
      if (line.charAt(0) === '#') return;
      buf.push(line);
    });
    flush();
    return out;
  }

  function savePostRaw(k, h, ts) {
    var t = ts || nowIso();
    try {
      localStorage.setItem('ar.post.' + k, JSON.stringify({ k: k, h: h, created: t, updated: t }));
    } catch (e) { }
  }

  /** 当前开启的导入集，在该段上的注释。
   *  跨版本对位：先按段落指纹 fp 找，找不到才退回段号 b。
   *  老师的包若按另一版经文做，段号会错位，指纹能救回来。
   */
  function setNotesAt(k, b, fpIndex) {
    var out = [], sets = allSets();
    Object.keys(sets).forEach(function (id) {
      var s = sets[id];
      if (!s || s.on === false) return;
      var nm = (s.meta && s.meta.name) || id;
      (s.entries || []).forEach(function (e) {
        var a = e.a || {};
        if (a.k !== k) return;
        var bb = a.b;
        if (a.fp && fpIndex && fpIndex[a.fp] != null) bb = fpIndex[a.fp];
        if (e.kind === 'seg' || e.kind === 'hl') {
          if (bb === b) out.push({ set: nm, kind: e.kind, h: e.h || '', x: e.x || '' });
        } else if (e.kind === 'post') {
          if (a.b == null) out.push({ set: nm, kind: 'post', h: e.h || '', x: '' });
        }
      });
    });
    return out;
  }

  /* ---------- 首页 ---------- */

  var SLIDES = [
    'assets/scene-bamboo.jpg', 'assets/scene-mist.jpg', 'assets/scene-cloud.jpg',
    'assets/scene-lake.jpg', 'assets/scene-tropic.jpg', 'assets/scene-ridge.jpg',
    'assets/scene-cloud3.jpg'
  ];
  var K_HERO_DAY = 'ar.heroDay';
  var K_HERO_IDX = 'ar.heroIdx';

  /* 首页图不手动切：同一天保持同一张，隔天换下一张，轮完从头。
   * 只用 localStorage 的日期 + 下标，不需要任何权限。 */
  function heroOfDay() {
    var n = SLIDES.length;
    if (!n) return 0;
    var today = ymd();
    var last = null, idx = 0;
    try {
      last = localStorage.getItem(K_HERO_DAY);
      idx = parseInt(localStorage.getItem(K_HERO_IDX), 10) || 0;
    } catch (e) { }
    if (last !== today) {
      idx = last ? (idx + 1) % n : 0;
      try {
        localStorage.setItem(K_HERO_DAY, today);
        localStorage.setItem(K_HERO_IDX, String(idx));
      } catch (e) { }
    }
    return ((idx % n) + n) % n;
  }

  function dayIndex(len) {
    if (!len) return 0;
    var d = Math.floor(Date.now() / 86400000);
    return ((d % len) + len) % len;
  }

  function viewHome() {
    var days = (AR.S.days && AR.S.days.items) || [];
    var q = days[dayIndex(days.length)] || { t: '', s: '', k: '' };
    var hi = heroOfDay();

    var last = null;
    try { last = JSON.parse(localStorage.getItem(LAST) || 'null'); } catch (e) { }
    var lastLf = last && AR.S.leaf[last.k];
    var lastSub = lastLf ? (lastLf.n + ' · ' + daysAgo(last.ts)) : '尚未開始閱讀';

    paint(
      '<div class="app">' +
      '<div class="hero"><div class="hero-slide" style="background-image:url(' +
        SLIDES[hi] + ')" role="img" aria-label="經文閱讀頁風景"></div></div>' +

      '<div class="verse">' +
      '<div class="verse-tag">今日一句</div>' +
      '<p class="verse-q">' + esc(q.t) + '</p>' +
      '<div class="verse-src">' + esc(q.s || '') + (q.k ? '　·　' + esc(q.k) : '') + '</div>' +
      '</div>' +

      '<nav class="home-nav">' +
      row('dir', '經文目錄', '四阿含 · 五尼柯耶', '#/d/A') +
      row('search', '搜索經文', '在全部經文中檢索', '#/search') +
      row('book', '繼續閱讀', lastSub, last ? '#/k/' + encodeURIComponent(last.k) : '#/d/A') +
      row('hist', '瀏覽歷史', countText(histAll().length, '尚無記錄'), '#/history') +
      row('pali', '巴利語原文', '巴利三藏 · 依目錄直讀', '#/pali') +
      row('note', '我的筆記', countText(allPosts().length + allSegNotes().length, '尚無筆記'), '#/notes') +
      row('mark', '我的劃線', countText(allHl().length, '尚無劃線'), '#/highlights') +
      row('star', '我的收藏', countText(allFavs().length, '尚無收藏'), '#/favorites') +
      row('gear', '設置', '文字 · 簡繁 · 授權', '#/settings') +
      '</nav>' +
      '<div class="foot"><a class="foot-link" href="#/license">授權與致謝 ›</a></div>' +
      '</div>'
    );
    bindHomeRows();
    fitDailyVerse();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitDailyVerse);
  }

  /* 今日一句：最多占「原来三行」的高度（19.5px × 1.95 × 3 ≈ 114px）。
   * 先降字号，最低 15px；还超就压缩行距，最低 1.6；都到底才硬裁。 */
  function fitDailyVerse() {
    var p = document.querySelector('.verse-q');
    if (!p) return;
    var base = 19.5, minFs = 15, baseLh = 1.95, minLh = 1.6;
    var maxH = base * baseLh * 3;
    var fs = base, lh = baseLh;
    p.style.fontSize = fs + 'px';
    p.style.lineHeight = lh;
    p.style.maxHeight = '';
    p.style.overflow = '';

    function tooTall() { return p.scrollHeight > maxH + 1; }

    while (fs > minFs && tooTall()) {
      fs = Math.max(minFs, fs - 0.5);
      p.style.fontSize = fs + 'px';
    }
    while (lh > minLh && tooTall()) {
      lh = Math.max(minLh, Math.round((lh - 0.05) * 100) / 100);
      p.style.lineHeight = lh;
    }
    if (tooTall()) {
      p.style.maxHeight = maxH + 'px';
      p.style.overflow = 'hidden';
    }
  }

  window.addEventListener('resize', function () {
    if (document.querySelector('.verse-q')) fitDailyVerse();
  });

  /* 首页行是普通 <a>，正常情况下单击就会走 hash。
   * 旧 WebView 的 300ms 双击缩放、或上一页残留的触摸监听，偶尔会把第一次点击吃掉；
   * 这里显式再走一遍，只处理站内 hash，不动外链。 */
  function bindHomeRows() {
    Array.prototype.forEach.call(document.querySelectorAll('.home-nav .row'), function (a) {
      a.addEventListener('click', function (ev) {
        var href = a.getAttribute('href');
        if (!href || href.charAt(0) !== '#') return;
        ev.preventDefault();
        if (location.hash === href) route();
        else location.hash = href;
      });
    });
  }

  function countText(n, empty) {
    return n ? ('共 ' + n + ' 條') : empty;
  }

  function daysAgo(ts) {
    if (!ts) return '';
    var d = Math.round((Date.now() - ts) / 86400000);
    if (d <= 0) return '今天讀過';
    if (d === 1) return '昨天讀過';
    return d + ' 天前讀過';
  }

  /* 全站经数：合并页算 2–3 经，不按页算（雜阿含 1362 而非 1356） */
  var TOTAL_SUTTAS = null;
  function totalSuttas() {
    if (TOTAL_SUTTAS != null) return TOTAL_SUTTAS;
    var n = 0;
    AR.S.canon.groups.forEach(function (g) {
      g.c.forEach(function (b) { n += suttaCountOf(b); });
    });
    TOTAL_SUTTAS = n;
    return n;
  }

  function suttaCountOf(node) {
    var n = 0;
    (function walk(x) {
      if (!x.c) { n += splitSuttaName(x.n, x.k).count || 1; return; }
      x.c.forEach(walk);
    })(node);
    return n;
  }

  var ICONS = {
    dir: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v18H6.5A2.5 2.5 0 0 1 4 18.5z"/><path d="M8 3v18"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/></svg>',
    book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 6.5C10 4.8 7 4.4 4 5v13c3-.6 6-.2 8 1.5"/><path d="M12 6.5c2-1.7 5-2.1 8-1.5v13c-3-.6-6-.2-8 1.5"/><path d="M12 6.5v13.5"/></svg>',
    pali: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 20V6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v14"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>',
    note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4"/><path d="M9 12h7M9 16h5"/></svg>',
    mark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 16l9-9 4 4-9 9H4z"/><path d="M13 7l4 4"/><path d="M4 21h16"/></svg>',
    star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 4l2.4 5 5.6.8-4 4 1 5.6-5-2.7-5 2.7 1-5.6-4-4 5.6-.8z"/></svg>',
    hist: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 5v5h5"/><path d="M4.6 10a8 8 0 1 1 2.5 7.5"/><path d="M12 8v4.5l3 1.8"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 8h10M18 8h2M4 16h4M12 16h8"/><circle cx="16" cy="8" r="2"/><circle cx="10" cy="16" r="2"/></svg>'
  };

  function row(ico, t, sub, href) {
    return '<a class="row" href="' + href + '">' +
      '<span class="ico">' + ICONS[ico] + '</span>' +
      '<span class="txt"><span class="t">' + esc(t) + '</span>' +
      '<div class="sub">' + esc(sub) + '</div></span>' +
      '<span class="arw">›</span></a>';
  }

  /* ---------- 目录 ---------- */

  function viewGroup(gid) {
    var g = AR.groupList(gid);
    if (!g) return viewHome();
    // 汉译四部＋别译的固定次序：雜-中-長-增-別；巴利四部：相-中-長-增
    var list = g.c.slice().sort(function (a, b) {
      var ia = GROUP_ORDER.indexOf(a.id), ib = GROUP_ORDER.indexOf(b.id);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    var rows = '';
    list.forEach(function (b) {
      rows += '<div class="dir-row" data-href="#/s/' + b.id + '">' +
        '<span class="nm">' + esc(b.n) + '</span>' +
        '<span class="ct">' + suttaCountOf(b) + ' 經</span><span class="arw">›</span></div>';
    });
    var tabs = ['A', 'B', 'C'].map(function (x) {
      var gg = AR.groupList(x);
      return '<a class="chip" href="#/d/' + x + '"' +
        (x === gid ? ' style="border-color:var(--ochre);color:var(--ochre-d)"' : '') + '>' +
        esc(gg.n) + '</a>';
    }).join('');

    paint(
      bar(g.n, '#/') +
      '<div class="app hasjumpfix">' +
      '<div class="search-h" style="padding-bottom:0"><div class="pair">' + tabs + '</div></div>' +
      '<div class="dir-h">' + esc(g.n) + '</div>' + rows + '</div>' +
      // 跳转栏固定在底部：小部条目多，放上面会把列表往下挤，滚起来也不方便
      '<div class="jumpfix">' +
      '<input class="jin" id="jumpIn" type="text" autocomplete="off" ' +
      'placeholder="經號，如 SA.1／雜1">' +
      '<button class="jgo" id="jumpGo">跳轉</button>' +
      '<button class="hintbtn" id="jumpHint" aria-label="格式說明">？</button>' +
      '</div>'
    );
    bindDirRows();
    bindJumpBox(null, null);

    var hb = document.getElementById('jumpHint');
    if (hb) hb.addEventListener('click', function () {
      var mask = document.createElement('div');
      mask.className = 'sheet-mask';
      mask.innerHTML = '<div class="sheet"><div class="hd"><span class="t">經號怎麼寫</span>' +
        '<span class="x" data-close>×</span></div>' +
        '<div class="b">' +
        '<p>以下寫法都可以，大小寫不拘：</p>' +
        '<p><b>SA.1</b>　<b>sa1</b>　<b>雜阿含1</b>　<b>杂1</b>　<b>945</b>（在本部時可只寫數字）</p>' +
        '<p><b>相應部1相應1</b>　<b>SN1.1</b>　<b>增壹阿含2品1</b>　<b>AA2.1</b></p>' +
        '<div class="who">部代號</div>' +
        '<p class="dim">SA＝雜阿含　MA＝中阿含　DA＝長阿含　AA＝增壹阿含　ZA＝別譯雜阿含<br>' +
        'SN＝相應部　MN＝中部　AN＝增支部　DN＝長部<br>' +
        '小部可直接寫名稱：法句、經集、如是語、優陀那…</p>' +
        '</div></div>';
      mountSheet(mask);
      mask.addEventListener('click', function (ev) {
        if (ev.target === mask || ev.target.hasAttribute('data-close')) mask.remove();
      });
    });
  }

  /* ---------- 部页：一层到经 ----------
   * 按「最接近经文的那一层」分区（相應／品／集），誦、篇不进导航。
   * 顶部一条分区菜单，点了跳到对应区；列表以经号排布为主，有经名的才带标题。
   */
  function flatOf(node) {
    var groups = [], orphans = [];
    (function walk(n, top) {
      if (!n.c) { orphans.push({ k: n.k, n: n.n }); return; }
      var subs = n.c.filter(function (x) { return !!x.c; });
      var leaves = n.c.filter(function (x) { return !x.c; });

      if (subs.length && leaves.length) {
        // 部根上「既有分组、又有散页」。两种情形要分开处理：
        //  · 散页占多数（譬喻：575 散页 vs 14 个小品）→ 树本身碎了，压平成一个列表；
        //  · 散页只是少数（杂阿含：3 页被移出附录的散页 vs 5 个诵）→ 保留分区，
        //    散页当孤儿按编号插回对应区。
        // 判断错就会把整部压成一组——2026-11-14 就因此让杂阿含的 50 个相应全丢了。
        if (leaves.length > subs.length) {
          var g0 = { name: n.n || '', top: '', items: [] };
          groups.push(g0);
          (function collect(x) {
            if (!x.c) { g0.items.push({ k: x.k, n: x.n }); return; }
            x.c.forEach(collect);
          })(n);
          return;
        }
        subs.forEach(function (ch) { walk(ch, top || ch.n); });
        leaves.forEach(function (lf) { orphans.push({ k: lf.k, n: lf.n }); });
        return;
      }
      if (subs.length) { subs.forEach(function (ch) { walk(ch, top || ch.n); }); return; }
      var nm = n.n || '';
      var g = groups.length && groups[groups.length - 1].name === nm ? groups[groups.length - 1] : null;
      // top = 部下的第一层（誦／篇／分／集），只作小字标注，不再占一级导航
      if (!g) { g = { name: nm, top: top || '', items: [] }; groups.push(g); }
      n.c.forEach(function (ch) { g.items.push({ k: ch.k, n: ch.n }); });
    })(node, '');

    // 没有分区的孤立页（如原「附錄」那三页）：插到「前一个号码」所在的分区。
    // 不能用「最后一个起点≤n 的分区」——分区是树序不是序数序，会插错。
    if (orphans.length) {
      var owner = [];
      groups.forEach(function (g, gi) {
        g.items.forEach(function (x) { owner.push([itemNum(x), gi]); });
      });
      owner.sort(function (a, b) { return a[0] - b[0]; });
      orphans.forEach(function (it) {
        var n0 = itemNum(it);
        var gi = 0;
        for (var i = 0; i < owner.length; i++) {
          if (owner[i][0] <= n0) gi = owner[i][1];
        }
        if (groups[gi]) groups[gi].items.push(it);
      });
    }
    groups.forEach(function (g) {
      g.items.sort(function (a, b) { return numCmp(a, b); });
    });
    return groups;
  }

  function sumCount(items) {
    var s = 0;
    (items || []).forEach(function (it) { s += splitSuttaName(it.n, it.k).count || 1; });
    return s;
  }

  /* 点分数字逐段比较：2.9 要排在 2.10 前面，纯按首个数字排会乱 */
  function numCmp(a, b) {
    var pa = sortParts(a), pb = sortParts(b);
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      if (pa[i] !== pb[i]) return pa[i] - pb[i];
    }
    return 0;
  }

  function itemNum(it) {
    var n = parseInt(splitSuttaName(it.n, it.k).num, 10);
    return isNaN(n) ? 0 : n;
  }

  function firstNum(n) {
    var m = /(\d+)/.exec(String(n || ''));
    return m ? +m[1] : 0;
  }

  /* 「中阿含122經/瞻波經」→ 122 + 瞻波經；
     「相應部1相應1經/暴流經」→ 1.1 + 暴流經；
     「雜阿含1152經」→ 1152，無標題。 */
  function splitSuttaName(n, k) {
    var m, rg;
    n = String(n || '');
    // 原站「只有页面」的经（键形如 PAGE.Ap/Ap56.htm）：
    // 页名开头的数字是品内序号（「2.狮子座品」= 品2 第1页），拿来当经号必然重号。
    // 这类页以**页面号**为准，标题用页名；页名等于键名的说明没抽出标题，就只显示号。
    if (k && (rg = /^PAGE\.[^/]+\/[A-Za-z]*(\d+)\.htm$/.exec(k))) {
      // 页名开头的「2.」是品内序号，和页面号并列会重复，去掉
      var title = n.indexOf('PAGE.') === 0 ? '' : n.replace(/^\d+\s*[.、]\s*/, '');
      if (/^\d+\.?$/.test(title)) title = '';
      return { num: String(+rg[1]), title: title, count: 1 };
    }
    // 合并页：雜阿含143、144經 / 雜阿含755-757經 —— 一页覆盖数经
    if ((rg = /^(\D*?)(\d+)\s*[、,，\-–~]\s*(\d+)經/.exec(n))) {
      var a = +rg[2], b = +rg[3];
      if (b >= a) return { num: a + '–' + b, title: '', count: b - a + 1 };
    }
    // 品＋經两级编号的（增壹、增支部、相應部）
    if ((m = /^增壹阿含(\d+)品(\d+)經\/?(.*)$/.exec(n))) return { num: m[1] + '.' + m[2], title: m[3], count: 1 };
    if ((m = /^增支部(\d+)集(\d+)經\/?(.*)$/.exec(n))) return { num: m[1] + '.' + m[2], title: m[3], count: 1 };
    if ((m = /^相應部(\d+)相應(\d+)經\/?(.*)$/.exec(n))) return { num: m[1] + '.' + m[2], title: m[3], count: 1 };
    // 如是語／優陀那这类：OTHER.名前N經/題名
    if ((m = /^OTHER\..+?(\d+)經\/?(.*)$/.exec(n))) return { num: m[1], title: m[2], count: 1 };
    // 中阿含56/彌醯經 —— 数字后面直接是「/」，没有「經」
    if ((m = /^OTHER\..+?(\d+)\/(.*)$/.exec(n))) return { num: m[1], title: m[2], count: 1 };
    // 原站只有頁面、沒抽出經名的
    if ((m = /^PAGE\.[^/]*\/[A-Za-z]*(\d+)\.htm$/.exec(n))) return { num: m[1], title: '', count: 1 };
    // Th Th2 / Ap Ap56 这种「前綴 前綴數字」
    if ((m = /^([A-Za-z]+)\s+\1(\d+)$/.exec(n))) return { num: m[2], title: '', count: 1 };
    // 1.雙品 這类
    if ((m = /^(\d+)\.(.*)$/.exec(n))) return { num: m[1], title: m[2], count: 1 };
    // 中阿含56/彌醯經（模块前缀已被剥掉的情况）
    if ((m = /^(\D+?)(\d+)\/(.*)$/.exec(n))) return { num: m[2], title: m[3], count: 1 };
    // 雜阿含1152經 / 中阿含122經/瞻波經
    if ((m = /^(\D+?)(\d+)經\/?(.*)$/.exec(n))) return { num: m[2], title: m[3], count: 1 };
    return { num: '', title: n, count: 1 };
  }

  /* ---------- 异本（大正 / 正聞 / 佛光）----------
   * 只有编号能切：正文我们只有大正藏这一份。
   * 异本号来自 数据\clean\num.json.gz（由页首异本栏抽出），
   * 没有该本号的（如中阿含、相应部）退回大正号显示。
   */
  var K_EDITION = 'ar.edition';
  var EDITION_NAME = { tw: '大正本', zw: '正聞本', fg: '佛光本' };
  var edition = 'tw';
  try { edition = localStorage.getItem(K_EDITION) || 'tw'; } catch (e) { }

  function setEdition(v) {
    edition = v;
    try { localStorage.setItem(K_EDITION, v); } catch (e) { }
  }

  function altNumOf(k) {
    var r = (AR.S.num || {})[k];
    if (!r) return null;
    var v = r[edition];
    return v && v !== 'x' ? v : null;
  }

  /** 目录与阅读页显示的号：异本优先，没有就退回大正号 */
  function shownNum(it) {
    if (edition !== 'tw') {
      var v = altNumOf(it.k);
      if (v) return v;
    }
    return splitSuttaName(it.n, it.k).num || it.k;
  }

  /** 排序用：异本号优先，没有就按大正号 */
  function sortParts(it) {
    var v = edition !== 'tw' ? altNumOf(it.k) : null;
    var s = v || splitSuttaName(it.n, it.k).num || '';
    // 名字里没有号码（如部根上的散页「比丘尼品」）时退回用键里的数字，
    // 否则会被当成 0 排到最前面
    if (!s) {
      var mk = /\.(\d+(?:\.\d+)*)$/.exec(String(it.k || ''));
      if (mk) s = mk[1];
    }
    return String(s).split(/[.\-–]/).map(function (x) { return parseInt(x, 10) || 0; });
  }
  /* ---------- 部页 ----------
   * 两种视图：
   *   經號（默认）—— 1..N 连续排布，最可预期；
   *   相應 —— 按相應分组。
   * 为什么不能只用相應：莊老師的相應分类依印順《會編》，经号是「大正藏」顺序，
   * 两者不同序（陰相應 1–272、婆羅門相應 88–1187 都是散开的）。
   * 所以相應只能作为「另一种看法」，不能当唯一主轴。
   */
  var K_MODEOF = 'ar.dirmode';
  var dirMode = 'num';        // 当前部页的视图，返回时恢复用
  var nextNav = 'read';       // 下一次进经的来路：read（自然阅读）/ jump（跳转）
  var paliMode = false;       // 从「巴利語原文」入口来的：巴利在上、汉译在下
  // 部内固定次序：漢譯四部 = 相-中-長-增；阿含對讀 = 雜-中-長-增-別
  var GROUP_ORDER = ['SA', 'MA', 'DA', 'AA', 'ZA', 'SN', 'MN', 'DN', 'AN'];
  function markNav(kind) { nextNav = kind || 'read'; }

  /* ---------- 经号跳转 ----------
   * 认这些写法：SA.1 / sa1 / 雜阿含1 / 杂1 / 相应部1相应1 / SN1.1 / 945（在部页里）
   * 部名直接用 canon 里的部名做前缀匹配，所以「法句」「如是语」这类小部也认得，
   * 不用另外维护一张别名表。
   */
  function resolveSutta(q, curSeries) {
    var s = String(q || '').trim();
    if (!s) return null;
    s = s.replace(/[\uFF10-\uFF19]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);   // 全角数字
    });
    if (!/[0-9]/.test(s)) return null;

    var nums = (s.match(/\d+/g) || []).map(Number);
    if (!nums.length) return null;
    var prefix = s.replace(/[\d\s.、,\-–_/\\]/g, '');
    var simp = AR.conv(prefix).toLowerCase();

    var sid = null;
    if (!prefix) {
      sid = curSeries || null;                       // 只给数字：用当前部
    } else {
      // 1) 字母代号（SA / SN / MA …）
      var hit = null;
      AR.S.canon.groups.forEach(function (g) {
        g.c.forEach(function (b) {
          if (b.id.toLowerCase() === simp) hit = b.id;
        });
      });
      if (hit) sid = hit;
    }
    if (!sid && simp) {
      // 2) 部名前缀：雜阿含／杂／法句／如是语…
      var best = null;
      AR.S.canon.groups.forEach(function (g) {
        g.c.forEach(function (b) {
          var nm = AR.conv(b.n || '').replace(/[經经]$/, '').toLowerCase();
          if (!nm) return;
          if (nm.indexOf(simp) === 0 || simp.indexOf(nm) === 0) {
            if (!best || nm.length > best.len) best = { id: b.id, len: nm.length };
          }
        });
      });
      if (best) sid = best.id;
    }
    if (!sid) return null;

    var key = sid + '.' + nums.join('.');
    if (AR.S.leaf[key]) return key;
    if (nums.length > 1 && AR.S.leaf[sid + '.' + nums[nums.length - 1]]) {
      return sid + '.' + nums[nums.length - 1];
    }
    // 兜底：按号在部内找（小部的键是 PAGE.xxx，拼不出来）
    return keyByNumber(sid, nums);
  }

  function keyByNumber(sid, nums) {
    var node = seriesNode(sid);
    if (!node) return null;
    var want = nums.join('.');
    var last = String(nums[nums.length - 1]);
    var hit = null;
    (function walk(n) {
      if (!n.c) return;
      if (n.c.some(function (x) { return !!x.c; })) { n.c.forEach(walk); return; }
      n.c.forEach(function (ch) {
        if (hit) return;
        var sp = splitSuttaName(ch.n, ch.k);
        if (sp.num === want || sp.num === last || firstNum(ch.n) === +last) hit = ch.k;
      });
    })(node);
    return hit;
  }

  function jumpBoxHTML(hint, ph) {
    return '<div class="jumpbox">' +
      '<input class="jin" id="jumpIn" type="text" inputmode="text" ' +
      'placeholder="' + esc(ph) + '" autocomplete="off">' +
      '<button class="jgo" id="jumpGo">跳轉</button></div>' +
      (hint ? '<div class="jump-hint">' + esc(hint) + '</div>' : '');
  }

  function bindJumpBox(curSeries, onLocal) {
    var inp = document.getElementById('jumpIn');
    var go = document.getElementById('jumpGo');
    if (!inp || !go) return;
    function submit() {
      var q = inp.value.trim();
      if (!q) return;
      var k = resolveSutta(q, curSeries);
      if (!k) {
        toast('認不出這個寫法，試試 SA.1、雜阿含1、雜1');
        return;
      }
      // 经号跳转直接进阅读页；返回时 parentOf 会回目录并定位/高亮
      markNav('jump');
      var href = '#/k/' + encodeURIComponent(k) + '?back=dir';
      if (paliMode) href += '&via=pali';
      location.hash = href;
    }
    go.addEventListener('click', submit);
    inp.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); submit(); }
    });
  }
  function viewSeries(series) {
    paliMode = /[?&]via=pali/.test(location.hash);   // 传下去，经文页才知道巴利在前
    var node = seriesNode(series);
    if (!node) return viewGroup('A');
    var groups = flatOf(node);
    var total = groups.reduce(function (s, g) { return s + sumCount(g.items); }, 0);

    var atM = location.hash.match(/[?&]at=([^&]+)/);
    var atKey = atM ? decodeURIComponent(atM[1]) : '';
    var modeM = location.hash.match(/[?&]by=(num|shen)/);
    // 从上级进来一律先看经号；只有带 at=（从经文返回）才恢复上次的视图
    // 增壹阿含本身按品次第排，四百多格经号网格没有意义，直接按品看
    var byGroupOnly = (series === 'AA');
    // 小部 16 集大多只有一个“相应”，双视图没有意义，只留经号
    var onlyNum = (groupOfSeries(series) === 'C');
    var mode = byGroupOnly ? 'shen'
      : onlyNum ? 'num'
        : (modeM ? modeM[1] : (atKey ? (dirMode || 'num') : 'num'));
    dirMode = mode;

    var tabs = '';
    if (!byGroupOnly && !onlyNum) {
      tabs = '<div class="mtabs">' +
        '<a class="mtab' + (mode === 'num' ? ' on' : '') + '" data-mode="num">經號</a>' +
        '<a class="mtab' + (mode === 'shen' ? ' on' : '') + '" data-mode="shen">相應</a></div>';
    } else if (byGroupOnly) {
      tabs = '<div class="mtabs"><a class="mtab on" data-mode="shen">品</a></div>';
    }

    var head = bar(node.n, paliMode ? '#/pali' : ('#/d/' + groupOfSeries(series)),
      '<span class="act">' + total + ' 經</span>') + tabs;

    // 有经名的部用两列（号＋名），纯编号的部用五列
    var titled = 0, counted = 0;
    groups.forEach(function (g) {
      g.items.forEach(function (it) {
        counted++;
        if (splitSuttaName(it.n, it.k).title) titled++;
      });
    });
    var cols = counted && titled / counted > 0.5 ? 'cols2' : 'cols5';

    if (mode === 'num') {
      // 全部经按号码归并成一条线；顶部保留经号跳转
      var flat = [];
      groups.forEach(function (g) { g.items.forEach(function (it) { flat.push(it); }); });
      flat.sort(function (a, b) { return numCmp(a, b); });
      var cells = flat.map(function (it) { return cellHTML(it, cols); }).join('');
      var numBar = '<div class="dirbar">' +
        '<input class="jin" id="jumpIn" type="text" inputmode="text" ' +
        'placeholder="跳至經號，如 945" autocomplete="off">' +
        '<button class="jgo" id="jumpGo">跳</button></div>';
      paint(head + '<div class="app">' + numBar +
        '<div class="sgrid ' + cols + '" id="numgrid">' + cells + '</div></div>');
      bindJumpBox(series);
    } else {
      var pick = groups[0] ? (groups[0].name || node.n) : node.n;
      var shenBar = '<div class="dirbar">' +
        '<button class="pick" id="pickBtn"><span class="pick-t">' + esc(pick) + '</span><i>▾</i></button>' +
        '<input class="jin" id="jumpIn" type="text" inputmode="text" ' +
        'placeholder="跳至經號，如 945" autocomplete="off">' +
        '<button class="jgo" id="jumpGo">跳</button></div>';
      var body = groups.map(function (g, i) {
        return '<section class="sgroup" id="grp' + i + '">' +
          '<div class="sg-h"><span class="sn">' + esc(g.name || node.n) +
          (g.top && g.top !== g.name ? '<em>' + esc(g.top) + '</em>' : '') + '</span>' +
          '<span class="ct">' + sumCount(g.items) + ' 經</span></div>' +
          '<div class="sgrid ' + cols + '">' +
          g.items.map(function (it) { return cellHTML(it, cols); }).join('') +
          '</div></section>';
      }).join('');
      paint(head + '<div class="app">' + shenBar +
        '<div class="sgwrap haspick">' + body + '</div></div>');
      bindPicker(groups, node.n);
      bindJumpBox(series);
    }

    // 吸顶偏移用实测高度，避免 tabs 有/无、字体大小变化时错位
    var tb = document.querySelector('.mtabs');
    var db = document.querySelector('.dirbar');
    document.documentElement.style.setProperty('--tabh', (tb ? tb.offsetHeight : 0) + 'px');
    document.documentElement.style.setProperty('--dirbarh', (db ? db.offsetHeight : 0) + 'px');

    // 模式切换
    Array.prototype.forEach.call(document.querySelectorAll('[data-mode]'), function (el) {
      el.addEventListener('click', function () {
        var m = el.getAttribute('data-mode');
        dirMode = m;
        location.hash = '#/s/' + series + (atKey ? '?by=' + m + '&at=' + encodeURIComponent(atKey) : '?by=' + m);
      });
    });

    if (atKey) locateCell(atKey, mode);
  }

  function cellHTML(it, cols) {
    var s = splitSuttaName(it.n, it.k);
    var num = shownNum(it);
    // 名字里没有号码时，退成键里的编号：AA.5.1 → 5.1
    if (!num || /^[A-Za-z]/.test(num)) {
      var mk = /\.(\d+(?:\.\d+)*)$/.exec(String(it.k || ''));
      if (mk) num = mk[1];
    }
    // 从「巴利語原文」入口进来时，把来路带到经文页（那边巴利排在上面）
    var href = '#/k/' + encodeURIComponent(it.k) + (paliMode ? '?via=pali' : '');
    if (cols === 'cols2') {
      return '<a class="scell" data-key="' + esc(it.k) + '" href="' + href + '">' +
        '<b>' + esc(num) + '</b>' + (s.title ? '<span>' + esc(s.title) + '</span>' : '') + '</a>';
    }
    return '<a class="scell" data-key="' + esc(it.k) + '" href="' + href + '"><b>' + esc(num) + '</b></a>';
  }
  /* 从经文返回：把「刚才读的那一格」滚进屏幕，并标出来。
   * 以前相应视图是滚到分区顶部就算完——相应长的（诸天相应 100 多经）会把目标格
   * 甩到屏幕外，只看见一个高亮分区看不出在哪；分区标题本来就吸顶，直接盯住格子更准。
   * 目录页一千多个格子，WebView 里字体是 swap 加载、栅格行高常比首帧晚一两拍才定，
   * 只滚一次会「差一点点」，所以滚完回头看一眼，没停对就按新位置补滚。 */
  function locateCell(key, mode) {
    var el = document.querySelector('.scell[data-key="' + key + '"]');
    if (!el) return;
    el.classList.add('at');
    function placeOnce() {
      // 56 = 让出吸顶分区标题的高度，格子别藏到标题底下
      window.scrollTo(0, Math.max(0,
        el.getBoundingClientRect().top + window.scrollY - stickyOffset() - 56));
    }
    function landed() {
      var t = stickyOffset(), r = el.getBoundingClientRect();
      return r.top >= t + 40 && r.bottom <= window.innerHeight + 2;
    }
    // 只滚一次会踩到「布局还没长开」的那一拍：第一次滚的时候上面几段还没排完，
    // 算出来的位置是对的，等内容撑开格子就又被推下去了。隔几拍各补一次，代价只是几次 scrollTo。
    placeOnce();
    setTimeout(placeOnce, 120);
    setTimeout(placeOnce, 360);
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () { setTimeout(placeOnce, 40); });
    }
    setTimeout(function () {
      if (!landed()) {
        // 还是没停对（例如目标就在文档最末，滚不过去）：兜底把这一格放到屏幕中间
        var r = el.getBoundingClientRect();
        window.scrollTo(0, Math.max(0, r.top + window.scrollY - window.innerHeight / 2));
      }
      syncPickerFromScroll();
    }, 800);
  }

  /* 当前滚到哪一段相应：取「已经顶到吸顶线下方的最后一个分区」 */
  function currentGroupIndex() {
    var th = stickyOffset() + 6, secs = document.querySelectorAll('.sgroup'), best = 0;
    for (var i = 0; i < secs.length; i++) {
      if (secs[i].getBoundingClientRect().top - th <= 0) best = i;
    }
    return best;
  }

  /* 相應选择器：50 个相應塞进一排芯片会乏力，改成一次弹出的列表。
   * 列表默认停在「你现在所在的那一段」，并把它标出来——30 个相应从头翻太费劲。 */
  function bindPicker(groups, fallbackName) {
    var btn = document.getElementById('pickBtn');
    if (!btn) return;
    window.__pickedGroups = groups;
    btn.addEventListener('click', function () {
      var curIdx = currentGroupIndex();
      var mask = document.createElement('div');
      mask.className = 'sheet-mask';
      var rows = groups.map(function (g, i) {
        var nums = g.items.map(itemNum).filter(Boolean);
        var lo = nums.length ? Math.min.apply(null, nums) : 0;
        var hi = nums.length ? Math.max.apply(null, nums) : 0;
        return '<div class="pickrow-i' + (i === curIdx ? ' cur' : '') + '" data-i="' + i + '">' +
          '<span class="pn">' + esc(g.name || fallbackName) + '</span>' +
          '<span class="pc">' + (lo && hi ? (lo === hi ? lo : lo + '–' + hi) + '　' : '') +
          sumCount(g.items) + ' 經</span></div>';
      }).join('');
      mask.innerHTML = '<div class="sheet"><div class="hd"><span class="t">選擇相應</span>' +
        '<span class="x" data-close>×</span></div>' +
        '<div class="picklist">' + rows + '</div></div>';
      mountSheet(mask);
      // 直接把列表滚到当前相应（居中），省掉从头翻
      var curEl = mask.querySelector('.pickrow-i.cur');
      var list = mask.querySelector('.picklist');
      if (curEl && list) {
        var d = curEl.getBoundingClientRect().top - list.getBoundingClientRect().top;
        list.scrollTop = Math.max(0, list.scrollTop + d - (list.clientHeight - curEl.offsetHeight) / 2);
      }
      mask.addEventListener('click', function (ev) {
        if (ev.target === mask || ev.target.hasAttribute('data-close')) mask.remove();
      });
      Array.prototype.forEach.call(mask.querySelectorAll('.pickrow-i'), function (el) {
        el.addEventListener('click', function () {
          var g = document.getElementById('grp' + el.getAttribute('data-i'));
          mask.remove();
          if (!g) return;
          window.scrollTo(0, Math.max(0, g.getBoundingClientRect().top + window.scrollY - stickyOffset() - 2));
          btn.firstChild.textContent = el.querySelector('.pn').textContent;
        });
      });
    });
    window.addEventListener('scroll', throttled(syncPickerFromScroll, 120), { passive: true });
    syncPickerFromScroll();
  }

  function syncPickerFromScroll() {
    var btn = document.getElementById('pickBtn');
    if (!btn || !window.__pickedGroups) return;
    var secs = document.querySelectorAll('.sgroup');
    if (!secs.length) return;
    var best = secs[currentGroupIndex()];
    if (best) {
      var nm = best.querySelector('.sg-h .sn');
      if (nm) btn.firstChild.textContent = nm.textContent.replace(/\s+/g, '');
    }
  }

  function stickyOffset() {
    var h = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--barh')) || 52;
    var t = document.querySelector('.mtabs');
    var d = document.querySelector('.dirbar');
    return h + (t ? t.offsetHeight : 0) + (d ? d.offsetHeight : 0);
  }
  function seriesNode(series) {
    var out = null;
    AR.S.canon.groups.forEach(function (g) {
      g.c.forEach(function (b) { if (b.id === series) out = b; });
    });
    return out;
  }

  function backHref(series) {
    return '#/d/' + groupOfSeries(series);
  }

  function throttled(fn, ms) {
    var last = 0, timer = null;
    return function () {
      var now = Date.now();
      if (now - last >= ms) { last = now; fn(); }
      else if (!timer) {
        timer = setTimeout(function () { timer = null; last = Date.now(); fn(); }, ms - (now - last));
      }
    };
  }

  function groupOfSeries(series) {
    var gid = 'A';
    AR.S.canon.groups.forEach(function (g) {
      g.c.forEach(function (b) { if (b.id === series) gid = g.id; });
    });
    return gid;
  }

  /* ---------- 层级后退 ----------
   * 后退 = 回上一层，不是回浏览过的上一页。
   *   經文 → 它所在的品/相應 → 部 → 組 → 首頁
   * 章法上也更符合「读经」这件事：读者脑子里是一棵树，不是一条栈。
   */
  function parentOfKey(k) {
    var p = AR.S.pathOf && AR.S.pathOf[k];
    if (!p) return '#/d/' + groupOfSeries(AR.seriesOf(k));
    // 部页是一层到底，回来时定位到该经那一格；巴利入口进来时把标记带回去
    return '#/s/' + p.s + '?by=' + (dirMode || 'num') + '&at=' + encodeURIComponent(k) +
      (paliMode ? '&via=pali' : '');
  }

  function parentOf(hash) {
    var m;
    if ((m = hash.match(/^#\/k\/([^?]+)(?:\?|$)/))) {
      var back = hash.match(/[?&]back=([a-z]+)/);
      if (back && back[1] === 'dir') return parentOfKey(decodeURIComponent(m[1]));
      // 从搜索结果点进来的：返回原搜索页，保留关键词、范围与经号范围
      if (back && back[1] === 'search') {
        var qm = hash.match(/[?&]q=([^&]*)/);
        var sm = hash.match(/[?&]series=([^&]*)/);
        var rm = hash.match(/[?&]range=([^&]*)/);
        var lm = hash.match(/[?&]lim=([^&]*)/);
        var q = qm ? decodeURIComponent(qm[1]) : (searchBack ? searchBack.q : '');
        var s = sm ? decodeURIComponent(sm[1]) : (searchBack ? searchBack.series : 'all');
        var r = rm ? decodeURIComponent(rm[1]) : (searchBack ? searchBack.range : 'all');
        var l = lm ? +lm[1] : (searchBack ? searchBack.limit : 80);
        if (searchBack) searchRestoreScroll = searchBack.scroll;
        return '#/search?q=' + encodeURIComponent(q || '') +
          '&series=' + encodeURIComponent(s || 'all') +
          '&range=' + encodeURIComponent(r || 'all') +
          '&lim=' + (l || 80);
      }
      // 从收藏/笔记/划线列表点进来的，返回时回原列表
      if (back && /^(favorites|notes|highlights)$/.test(back[1])) return '#/' + back[1];
      var from = hash.match(/[?&]from=([^&]+)/);
      // 从对读点进来的，返回时回到原来那一经，而不是甩回目录
      if (from) return '#/k/' + from[1];
      return parentOfKey(decodeURIComponent(m[1]));
    }

    if ((m = hash.match(/^#\/history(?:\?from=([^&]+))?/))) {
      return m[1] ? '#/k/' + m[1] : '#/';     // 历史页返回：回到来的那一经
    }
    // 从「巴利語原文」进来的，退出去还是回那个入口页，不是组页
    if ((m = hash.match(/^#\/s\/([A-Za-z]+)/))) {
      if (/[?&]via=pali/.test(hash)) return '#/pali';
      return '#/d/' + groupOfSeries(m[1]);
    }
    if ((hash.match(/^#\/d\/[A-C]/))) return '#/';
    return '#/';
  }

  // 供 Android 壳调用：返回父级 hash；已在根则返回空串，由壳决定是否退出
  window.ARUp = function () {
    var cur = location.hash || '#/';
    var up = parentOf(cur);
    if (!up || up === cur) return '';
    location.hash = up;
    return up;
  };

  // 从搜索结果进入阅读后，只要翻页（含同经内翻屏），返回就应该回目录，
  // 而不是再回搜索页。这里只改当前地址，不触发重新渲染。
  function dropSearchBack() {
    var h = location.hash || '';
    if (!/[?&]back=search(?:&|$)/.test(h)) return;
    var m = h.match(/^#\/k\/([^?]+)(?:\?(.*))?$/);
    if (!m) return;
    var keep = [];
    (m[2] || '').split('&').forEach(function (p) {
      if (!p || /^back=/.test(p) || /^q=/.test(p) || /^series=/.test(p) ||
          /^range=/.test(p) || /^lim=/.test(p)) return;
      keep.push(p);
    });
    var nh = '#/k/' + m[1] + (keep.length ? '?' + keep.join('&') : '');
    try { history.replaceState(null, '', nh); } catch (e) { }
  }

  function bindDirRows() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-href]'), function (el) {
      el.addEventListener('click', function () { go(el.getAttribute('data-href')); });
    });
  }

  /* ---------- 阅读页 ---------- */

  function viewRead(rawKey, mode) {
    var key = decodeURIComponent(rawKey);
    var s = AR.seriesOf(key);
    var mb = (location.hash.match(/[?&]b=(\d+)/) || [])[1];
    AR.loadSeries(s).then(function () {
      // 自动换译集后要写回偏好，否则下一次 paint() 会按旧偏好把它改回去
      return AR.ensurePali().then(function () {
        return AR.ensureTransSet(s, key);
      }).then(function (set) {
        var p = readPrefs();
        if (set && set !== p.transSet) { p.transSet = set; savePrefs(p); }
        return set;
      });
    }).then(function () {
      var e = AR.entry(key);
      if (!e) {
        paint(bar('找不到', '#/') + '<div class="app"><div class="dir-h">找不到 ' + esc(key) + '</div></div>');
        return;
      }
      localStorage.setItem(LAST, JSON.stringify({ k: key, ts: Date.now() }));
      pushHist(key, nextNav);
      nextNav = 'read';
      renderRead(e, mode, mb ? +mb : 0);
    }).catch(function (err) {
      document.documentElement.setAttribute('data-err', (err && (err.stack || err.message)) || String(err));
      paint(bar('載入失敗', '#/') + '<div class="app"><div class="dir-h">' + esc(err.message) + '</div></div>');
    });
  }

  /* 巴利长段的句级切分。只在“句数相同 / 差 1 句”时成对；
   * 差得多就退回整段，宁可不配也不硬配错。 */
  function paliSentences(t) {
    var s = String(t || ''), out = [], start = 0, lead = '';
    // 行首「1. 」「155. 」是源站段号，不是句子
    var lm = /^(\d+\.\s*)/.exec(s);
    if (lm) { lead = lm[1]; s = s.slice(lead.length); }
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if ((ch === '.' || ch === '!' || ch === '?') &&
          i + 1 < s.length && /\s/.test(s.charAt(i + 1))) {
        // 行内也可能有编号行首（如 2. …），别把编号当句号
        if (/\d/.test(s.charAt(i - 1)) && /^\d+$/.test(s.slice(start, i))) continue;
        var k = i + 1;
        while (k < s.length && /\s/.test(s.charAt(k))) k++;
        var nx = s.charAt(k);
        if (k < s.length && /[“"‘'A-Za-zĀĪŪṬḌṆṂṄÑ]/.test(nx)) {
          while (k < s.length && /[”’"']/.test(s.charAt(k))) k++;
          out.push(s.slice(start, k).trim());
          start = k; i = k - 1;
        }
      }
    }
    out.push(s.slice(start).trim());
    out = out.filter(Boolean);
    if (lead && out.length) out[0] = lead + out[0];
    return out;
  }

  function zhSentences(t) {
    var s = String(t || ''), out = [], start = 0;
    for (var i = 0; i < s.length; i++) {
      if ('。！？'.indexOf(s.charAt(i)) >= 0) {
        var k = i + 1;
        while (k < s.length && '」』”’）】》'.indexOf(s.charAt(k)) >= 0) k++;
        out.push(s.slice(start, k).trim());
        start = k; i = k - 1;
      }
    }
    out.push(s.slice(start).trim());
    return out.filter(Boolean);
  }

  function mergeShortest(list) {
    var best = 0, bl = Infinity;
    for (var i = 0; i < list.length - 1; i++) {
      var l = list[i].length + list[i + 1].length;
      if (l < bl) { bl = l; best = i; }
    }
    var out = list.slice();
    out.splice(best, 2, list[best] + list[best + 1]);
    return out;
  }

  function splitLongestZh(list) {
    var idx = 0;
    for (var i = 1; i < list.length; i++) if (list[i].length > list[idx].length) idx = i;
    var s = list[idx], mid = Math.floor(s.length / 2), cut = -1, bd = 1e9;
    for (var j = 0; j < s.length; j++) {
      if ('，；：'.indexOf(s.charAt(j)) >= 0) {
        var d = Math.abs(j - mid);
        if (d < bd) { bd = d; cut = j; }
      }
    }
    if (cut < 0) cut = mid;
    var a = s.slice(0, cut + 1), b = s.slice(cut + 1);
    if (!a || !b) return list;
    var out = list.slice();
    out.splice(idx, 1, a, b);
    return out;
  }

  function alignPaliPairs(ps, zs) {
    // 只用“句数完全相同”的段落做句级配对；
    // 不为了凑数去拆/并汉译句子——那是拿汉语的分段反过来套巴利语。
    if (ps.length === zs.length) {
      return ps.map(function (p, i) { return [p, zs[i]]; });
    }
    return null;
  }

  /* 整段巴利只是一个「标记」吗？（peyyāla 缩略语、经名、品名这类）
   * 要把段号、括号、结尾句点剥掉再看，剩下的词本身才是有没有意义的依据。 */
  function paliMarkerText(t) {
    var s = String(t || '').trim();
    s = s.replace(/^[（(\[]\s*/, '').replace(/\s*[）)\]]\s*\.?$/, '').trim();
    s = s.replace(/^\(\d+\)\s*/, '').replace(/[.…·]+\s*$/, '').trim();
    return s;
  }

  function isPaliMarker(t) {
    var s = paliMarkerText(t);
    if (!s || s.length > 45 || s.split(/\s+/).length > 6) return false;
    return /peyyāl|suttaṃ|vaggo|nipāto|paṇṇāsaka|saṃyuttaṃ|kathā/i.test(s);
  }

  function paliPairMismatch(p, z) {
    var a = String(p || '').trim(), b = String(z || '').trim();
    if (!a || !b) return false;
    /* 旧的判据是「含 suttaṃ 等词 + 汉译 >80 字」和「巴利 <30 字而汉译 >4 倍」，
     * 结果把 Evaṃ me sutaṃ…（如是我闻）、Navamaṃ.（第九）这类正常段落也判成缩略语，
     * 汉译整段被换成提示——2026-11-17 实测会误伤 100 多段。
     * 现在只认「整段就是一个标记词」，其余一律照常显示汉译。 */
    return isPaliMarker(a) && b.length > 60;
  }

  function paliLineHTML(t, z, pey) {
    // 源包承认这一段巴利是缩略语、汉译是展开内容：汉译照给，底下补一句说明
    if (pey && z) {
      return '<div class="plp"><p class="pl">' + esc(t) + '</p>' +
        '<p class="pz">' + esc(z) +
        '<span class="pey">（原文此處為縮略語，漢譯依前文展開）</span></p></div>';
    }
    if (t.length >= 160) {
      var ps = paliSentences(t);
      if (!z) {
        return ps.map(function (p) { return '<p class="pl">' + esc(p) + '</p>'; }).join('');
      }
      var pairs = alignPaliPairs(ps, zhSentences(z));
      if (pairs && pairs.length) {
        return pairs.map(function (x) {
          if (paliPairMismatch(x[0], x[1])) {
            return '<div class="plp"><p class="pl">' + esc(x[0]) + '</p>' +
              '<p class="pz mismatch">（原文此處為縮略語，未逐句配漢譯）</p></div>';
          }
          return '<div class="plp"><p class="pl">' + esc(x[0]) + '</p>' +
            '<p class="pz">' + esc(x[1]) + '</p></div>';
        }).join('');
      }
    }
    if (paliPairMismatch(t, z)) {
      return '<p class="pl">' + esc(t) + '</p>' +
        '<p class="pz mismatch">（原文此處為縮略語，未逐句配漢譯）</p>';
    }
    return '<p class="pl">' + esc(t) + '</p>' +
      (z ? '<p class="pz">' + esc(z) + '</p>' : '');
  }

  /* 巴利块开头常见的书目行（只在开头连续剥，正文里出现不误伤） */
  function isPaliHeader(t) {
    if (/^Namo tassa/i.test(t)) return true;
    if (/nikāy[eo]$/i.test(t)) return true;                  // Saṃyuttanikāyo / Khuddakanikāye
    if (/pāḷi$/i.test(t)) return true;                       // Ekakanipātapāḷi
    if (/paṇṇāsakaṃ$/i.test(t)) return true;                 // 1. Paṭhamapaṇṇāsakaṃ
    if (/(vaggo|saṃyuttaṃ|nipāto|kathā)$/i.test(t)) return true;
    if (/^[A-Z]{2,3}\.[\d.-]+$/.test(t)) return true;        // AN.1.188-197
    if (/^[A-Z]{2,3}\.[\d.]+\/\s*$/.test(t)) return true;    // AN.10.62/
    if (/^[A-Z]{2,3}\.[\d.]+\/\s*\d+\./.test(t)) return true;// AN.4.34/ 4. Aggappasādasuttaṃ
    if (/^[A-Z]{2,3}\.[\d.]+\/\(\d+\)/.test(t)) return true; // SN.1.1/(1) Oghataraṇasuttaṃ
    if (/^\d+\.\s+.*suttaṃ$/i.test(t) && t.length < 60) return true; // 1. Oghataraṇasuttaṃ
    return false;
  }

  function renderRead(e, mode, jumpB) {
    // 从「巴利語原文」入口来的：巴利排最前、默认展开
    paliMode = /[?&]via=pali/.test(location.hash);
    document.body.classList.toggle('pali-first', paliMode);
    var head = e.h || {};
    var notes = AR.notesFor(e);
    // 关掉莊春江那套时，注标与比对一并隐去；经文与巴利不受影响
    if (!zcjOn()) {
      notes.blocks.forEach(function (b) { b.m = []; });
      notes.cmp = '';
    }
    // 给每个注标一个全局序号，供点击回查（块内序号会串号）
    var gi = 0;
    notes.all = [];
    notes.blocks.forEach(function (b) {
      (b.m || []).forEach(function (m) { m.g = gi++; notes.all.push(m); });
    });
    var pali = AR.paliFor(e);
    var xr = AR.xrefOf(e.k);
    var grp = AR.groupOf(e.k);
    var hl = hlMap(e.k), sn = segNotes(e.k);

    var body = '';
    notes.blocks.forEach(function (b) {
      if (b.g === 'skip') return;
      if (b.g === 'num') { body += '<p class="num">' + esc(b.t) + '</p>'; return; }
      var cls = [];
      if (b.g === 'v') cls.push('v');
      if (b.g === 'h') cls.push('ph');
      body += '<p data-b="' + b.i + '"' + (cls.length ? ' class="' + cls.join(' ') + '"' : '') + '>' +
        withMarks(b.t, b.m, hlRanges(e.k, b.i), AR.uaFor(e.k, b.i), b.i) + '</p>';
      // 译文跟在段后；开关靠 body 的 no-trans 类，不重绘
      var tv = AR.transOf(e.k, b.i);
      if (tv) {
        var mine = !!(AR.trOverride()[e.k] || {})[b.i];
        body += '<div class="tr' + (mine ? ' mine' : '') + '" data-k="' + esc(e.k) +
          '" data-tb="' + b.i + '">' + esc(tv) + '</div>';
      }
      // 本段笔记也附在段后，和译文同一个位置逻辑
      var nz = sn[b.i];
      body += segNoteHTML(b.i, nz);
    });

    // 对读：直接在本页展开对应经的正文（不跳走），另留一个小「跳转」
    var xrList = xr.length ? xr.slice(0, 3).map(function (x) {
      return { k: x.k, tag: x.s.indexOf('r') >= 0 ? '對號' : (x.s.indexOf('d') >= 0 ? '巴利' : '同頁') };
    }) : (grp ? grp.filter(function (k) { return k !== e.k; }).slice(0, 3).map(function (k) {
      return { k: k, tag: '同組' };
    }) : []);

    var pairs = '';
    if (xrList.length) {
      pairs = '<div class="xr-list">' + xrList.map(function (x) {
        var lf = AR.S.leaf[x.k];
        return '<div class="xr-item" data-xk="' + esc(x.k) + '">' +
          '<div class="xr-h">' +
          '<span class="xr-n">' + esc(lf ? lf.n : x.k) + '</span>' +
          '<span class="xr-t">' + esc(x.tag) + '</span>' +
          '<a class="xr-go" data-nav="jump" href="#/k/' + encodeURIComponent(x.k) + '?from=' + encodeURIComponent(e.k) + '">跳轉</a>' +
          '</div><div class="xr-b">載入中…</div></div>';
      }).join('') + '</div>';
    }

    var paliSec = '';
    if (pali.blocks.length) {
      var pzh = pali.zh || {};
      var zhN = Object.keys(pzh).length;
      var decl = pali.decl.length
        ? '<div class="declaim">巴利原文 · ' + esc(pali.decl.join('／')) +
          (pali.decl[0] !== e.k ? '（本經的對讀本）' : '') +
          (zhN ? '' : '　·　暫無直譯') + '</div>'
        : '';
      var pnote = zhN
        ? '<div class="pali-note">巴利直譯為 AI 批量初譯，僅供參考；如有更可靠的對譯本，歡迎聯繫（見授權頁）。</div>'
        : '';
      // 译文包是「译者段落对」时直接用它的分段，不再拿我们的块去对
      var paliBody = '';
      if (pali.pairs && pali.pairs.length) {
        paliBody = pali.pairs.map(function (pair) {
          return paliLineHTML(pair.p, pair.z || '', pair.pey);
        }).join('');
      } else {
        // 源站巴利块前面挂着「Namo tassa / 部名 / 相应 / 品 / 经号标题」这些书目行，
        // 卡片里还不显眼，正文化以后太抢戏；只在开头连续剥掉，碰到正文就停。
        var plines = pali.blocks.join('\n').split(/\n+/)
          .map(function (t) { return t.trim(); })
          .filter(Boolean);
        var pst = 0;
        while (pst < plines.length && pst < 12 && isPaliHeader(plines[pst])) pst++;
        if (pst < plines.length) plines = plines.slice(pst);
        paliBody = plines.map(function (t) {
          return paliLineHTML(t, pzh[AR.normPali(t)]);
        }).join('');
      }
      paliSec = '<details class="sec fold" data-fold="pali"><summary><span class="dot"></span>巴利語</summary>' + pnote + decl +
        '<div class="sec-b"><div class="pali">' + paliBody + '</div></div></details>';
    }

    // 比对：原站 6682 条「比对」其实只有一行标题「南北傳經文比對(莊春江作)：」，
    // 没有正文。只有标题就整块不渲染，免得页面上留个空栏。
    var cmpLines = (notes.cmp || '').split('\n')
      .map(function (x) { return x.trim(); })
      .filter(function (x) { return x && !/經文比對/.test(x); });
    var cmpSec = cmpLines.length
      ? '<details class="sec fold" data-fold="cmp"><summary><span class="dot"></span>經文比對</summary>' +
      '<div class="sec-b">' +
      cmpLines.map(function (l) { return '<p>' + esc(l) + '</p>'; }).join('') + '</div></details>'
      : '';

    var alt = (head.alt && head.alt.length)
      ? '<div class="alt">異本：' + esc(head.alt.join('　')) + '</div>' : '';

    // 北传经的巴利块是「对读本」；把对读本经号直接写在本经异本下面
    var xrKeys = (pali.decl || []).filter(function (k, i, a) {
      return k && k !== e.k && a.indexOf(k) === i;
    });
    var xrRef = xrKeys.length
      ? '<div class="xr-ref">對讀：' + xrKeys.map(function (k) {
        return '<b>' + esc(k) + '</b>';
      }).join('／') + '</div>'
      : '';

    var path = head.path ? '<div class="path">' + esc(head.path) + '</div>' : '';

    var order = orderOf(e.c), pos = order.indexOf(e.k);
    var prev = pos > 0 ? order[pos - 1] : null;
    var next = pos >= 0 && pos < order.length - 1 ? order[pos + 1] : null;
    var pager = ''; var _unusedPager = '<div class="pager">' +
      (prev ? '<a href="#/k/' + encodeURIComponent(prev) + '">‹ ' + esc(nameOf(prev)) + '</a>' : '<span></span>') +
      (next ? '<a class="next" href="#/k/' + encodeURIComponent(next) + '">' + esc(nameOf(next)) + ' ›</a>' : '<span></span>') +
      '</div>';

    var favOn = isFav(e.k);
    // 有些页原站没抽出标题（键形如 PAGE.Ap/Ap56.htm），直接显示键名没有意义，
    // 退成「部名 頁碼」；其余情况仍用经名，最后才退回键名。
    var dispTitle = head.nm;
    if (!dispTitle) {
      var mk = /^PAGE\.[^/]+\/[A-Za-z]*(\d+)\.htm$/.exec(e.k);
      var sn = seriesNode(AR.seriesOf(e.k));
      if (mk && sn) dispTitle = sn.n + ' 第 ' + (+mk[1]) + ' 頁';
      else dispTitle = e.k;
    }

    // 阅读页不常驻顶栏：平时只有正文，单击唤出上下菜单（见 bindReadMenu）
    var edNum = altNumOf(e.k);
    var noLine = edition !== 'tw' && edNum
      ? EDITION_NAME[edition] + ' ' + edNum + '　·　大正 ' + esc(e.k)
      : esc(e.k);

    paint(
      '<div class="app read" id="readApp">' +
      '<div class="runhead"><span class="no">' + noLine + '</span></div>' +
      '<div class="pageview"><div class="paged" id="paged">' +
      '<div class="read-head">' +
      '<h1>' + esc(dispTitle) + '</h1>' + alt + xrRef + path +
      '</div>' +
      (paliMode ? paliSec : '') +
      (paliMode
        ? '<details class="sec fold" data-fold="xr" open><summary><span class="dot"></span>莊春江譯文</summary>' +
          '<div class="sec-b"><div class="read-body">' + body + '</div></div></details>'
        : '<div class="read-body">' + body + '</div>') +
      '<div class="actbar" id="actbar">' +
      '<span class="ab" id="abAnno">註釋</span>' +
      '<span class="ab" id="abHl">高亮</span>' +
      '<span class="ab" id="abNote">筆記</span>' +
      '<span class="ab" id="abCopy">複製</span>' +
      '<span class="ab dim" id="abClose">取消</span>' +
      '</div>' +
      (pairs ? '<details class="sec fold" data-fold="xref"><summary><span class="dot"></span>對讀</summary>' +
        '<div class="sec-b">' + pairs + '</div></details>' : '') +
      cmpSec + (paliMode ? '' : paliSec) +
      postSection(e.k) +
      '</div></div>' +
      '</div>' +
      '<div class="pageind" id="pageInd">1 / 1</div>' +
      '<div class="readmenu top" id="menuTop">' +
      '<span class="mi" id="mBack">‹ 返回</span>' +
      '<span class="mi" id="mDir">目錄</span>' +
      '<span class="mi" id="mEd">' + EDITION_NAME[edition] + '</span>' +
      '<span class="mi" id="mHist"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.7"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg></span>' +
      '</div>' +
      '<div class="readmenu bottom" id="menuBottom">' +
      '<a class="mb" data-act="search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">' +
      '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/></svg><span>搜索</span></a>' +
      '<a class="mb' + (readPrefs().trans ? ' on' : '') + '" data-act="trans"><svg viewBox="0 0 24 24">' +
      // 不是跨语言翻译，是「古 → 今」，所以用古今两个字，不用 "A/文"
      '<text x="5.4" y="16.6" text-anchor="middle" font-size="9" font-family="serif" fill="currentColor">古</text>' +
      '<path d="M10.2 12.2h3.2M12.2 10.8l1.6 1.4-1.6 1.4" stroke="currentColor" stroke-width="1.1" ' +
      'fill="none" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<text x="18.6" y="16.6" text-anchor="middle" font-size="9" font-family="serif" fill="currentColor">今</text>' +
      '</svg><span>翻譯</span></a>' +
      '<a class="mb off" data-act="tts"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">' +
      '<path d="M4 9v6h3l5 4V5L7 9H4z"/><path d="M16 9.5c1 1.5 1 3.5 0 5"/></svg><span>朗讀</span></a>' +
      '<a class="mb' + (favOn ? ' on' : '') + '" data-act="fav"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">' +
      '<path d="M12 4l2.4 5 5.6.8-4 4 1 5.6-5-2.7-5 2.7 1-5.6-4-4 5.6-.8z"/></svg><span>收藏</span></a>' +
      '<a class="mb" data-act="set"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">' +
      '<path d="M4 8h10M18 8h2M4 16h4M12 16h8"/><circle cx="16" cy="8" r="2"/>' +
      '<circle cx="10" cy="16" r="2"/></svg><span>設置</span></a>' +
      '<a class="mb" data-act="more"><svg viewBox="0 0 24 24" fill="currentColor">' +
      '<circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/>' +
      '<circle cx="18" cy="12" r="1.6"/></svg><span>更多</span></a>' +
      '</div>'
    );

    bindMarks(notes);
    bindPost(e.k);
    bindParaOps(e, notes);
    bindReadMenu(e, head, notes);
    playSlide();
    bindFolds();
    bindTransEdit();
    bindXref();
    bindSwipeNav(prev, next);
    applyPaging();
    if (jumpB) jumpToBlock(jumpB);

    // 收藏暂时挂在标题行右侧（菜单只放约定的四项）
    var bf = document.getElementById('btnFav');
    if (bf) bf.addEventListener('click', function (ev) {
      ev.stopPropagation();
      showFavEditor(e.k, function (on) {
        bf.textContent = on ? '★' : '☆';
        bf.className = 'fav' + (on ? ' on' : '');
      });
    });

    document.title = AR.conv(dispTitle + ' · 掌上阿含');
    window.scrollTo(0, 0);
  }

  /* ---------- 阅读页菜单：单击唤出上下两条，5 秒无互动收起 ---------- */
  var menuTimer = null;

  function bindReadMenu(e, head, notes) {
    var top = document.getElementById('menuTop');
    var bot = document.getElementById('menuBottom');
    if (!top || !bot) return;

    function hide() {
      top.classList.remove('show');
      bot.classList.remove('show');
      clearTimeout(menuTimer);
      menuTimer = null;
    }
    function show() {
      top.classList.add('show');
      bot.classList.add('show');
      reset();
    }
    function reset() {
      clearTimeout(menuTimer);
      menuTimer = setTimeout(hide, 5000);
    }
    function isOpen() { return top.classList.contains('show'); }

    [top, bot].forEach(function (bar) {
      bar.addEventListener('click', function () { reset(); });
      bar.addEventListener('touchstart', function () { reset(); }, { passive: true });
    });

    var app = document.getElementById('readApp');
    // 菜单控制交给统一委托器（bindParaOps 里），这里只暴露接口
    window.__readMenu = { show: show, hide: hide, isOpen: isOpen, reset: reset };

    document.getElementById('mBack').addEventListener('click', function () {
      hide();
      var bk = location.hash.match(/[?&]back=([a-z]+)/);
      if (bk) location.hash = parentOf(location.hash) || '#/';
      else location.hash = '#/';
    });

    document.getElementById('mDir').addEventListener('click', function () {
      hide();
      location.hash = '#/s/' + AR.seriesOf(e.k) + '?by=' + (dirMode || 'num') +
        '&at=' + encodeURIComponent(e.k);           // 本经所在的部页，定位到那一格
    });

    var mEd = document.getElementById('mEd');
    mEd.addEventListener('click', function () {
      var r = (AR.S.num || {})[e.k] || {};
      var avail = ['tw'];
      if (r.zw) avail.push('zw');
      if (r.fg) avail.push('fg');
      if (avail.length === 1) { toast('此經沒有異本號'); return; }
      var i = avail.indexOf(edition);
      var next = avail[(i + 1) % avail.length];
      setEdition(next);
      mEd.textContent = EDITION_NAME[next];
      var no = document.querySelector('.runhead .no');
      if (no) {
        var v = next === 'tw' ? null : r[next];
        no.innerHTML = AR.conv(next !== 'tw' && v
          ? EDITION_NAME[next] + ' ' + v + '　·　大正 ' + e.k
          : e.k);
      }
      reset();
    });

    document.getElementById('mHist').addEventListener('click', function () {
      hide();
      location.hash = '#/history?from=' + encodeURIComponent(e.k);
    });

    /* 下条：图标在上、文字在下 */
    Array.prototype.forEach.call(bot.querySelectorAll('.mb'), function (el) {
      el.addEventListener('click', function () {
        var act = el.getAttribute('data-act');
        if (act === 'search') {
          hide();
          var sid = AR.seriesOf(e.k);
          var sc = groupOfSeries(sid) === 'C' ? 'C' : sid;
          location.hash = '#/search?series=' + encodeURIComponent(sc);
          return;
        }
        if (act === 'trans') { hide(); showTranslateSheet(e); return; }
        if (act === 'tts') { hide(); showTtsSheet(); return; }
        if (act === 'fav') {
          hide();
          showFavEditor(e.k, function (on) {
            var bf = document.getElementById('btnFav');
            if (bf) { bf.textContent = on ? '★' : '☆'; bf.className = 'fav' + (on ? ' on' : ''); }
          });
          return;
        }
        if (act === 'set') { hide(); showReadSettings(); return; }
        if (act === 'more') { hide(); showMoreSheet(e, notes); return; }
      });
    });
  }

  /* ---------- 左右翻页 ----------
   * 用 CSS 多栏做分页：容器宽 = 一屏，column-width = 一屏宽，超出部分横向排；
   * 翻页就是平移整个多栏盒子。字号/行距变了只要重新算一次即可，不用自己切段。
   */
  /* 分页开关：只切类与重算尺寸，不重排 DOM，所以设置面板可以一直开着 */
  function applyPaging() {
    var on = readPrefs().paging === 'page';
    document.body.classList.toggle('paged-mode', on);
    if (window.ARIO && window.ARIO.setPaged) {
      try { window.ARIO.setPaged(on); } catch (e) { }
    }
    var pg = document.getElementById('paged');
    if (!pg) return;
    if (on) {
      // 若切进来时切经动画还没结束，#readApp 上残留的 transform 会让
      // .pageview 的 fixed 定位改以 #readApp 为包含块，页数会算错，先摘掉。
      var ra = document.getElementById('readApp');
      if (ra) ra.classList.remove('in-left', 'in-right');
      setupPaging();
    } else {
      pg.style.transform = '';
      window.__pageRecalc = null;
    }
  }

  /* 页数 = 列数。scrollWidth 可能已含末尾的 column-gap，用 round 比 ceil 稳：
   * N 列时 scrollWidth = N*step - gap（含末尾 gap 时 = N*step），
   * 两种都应收敛到 N，而不是 N+1。 */
  function pageTotal(pg, gap, step) {
    return Math.max(1, Math.round((pg.scrollWidth + gap) / step));
  }

  function setupPaging() {
    var pg = document.getElementById('paged');
    var pv = document.querySelector('.pageview');
    if (!pg || !pv) return;

    var gap = 0, step = 0;
    function metrics() {
      var cs = getComputedStyle(pg);
      var padL = parseFloat(cs.paddingLeft) || 0;
      gap = parseFloat(cs.columnGap) || 0;
      step = parseFloat(cs.width) - padL * 2 + gap;
      return step > 0;
    }
    if (!metrics()) return;

    var total = pageTotal(pg, gap, step);
    var idx = 0;

    function paintInd() {
      var ind = document.getElementById('pageInd');
      if (ind) ind.textContent = (idx + 1) + ' / ' + total;
    }
    function goto(i) {
      idx = Math.max(0, Math.min(total - 1, i));
      pg.style.transform = 'translateX(' + (-idx * step) + 'px)';
      paintInd();
    }

    /* 字体就绪、旋转、改字号行距、展开/收起折叠区之后重算页数；
     * keep=true 时尽量停在原来那一页，不要把人弹回第一页。 */
    function recalc(keep) {
      if (!document.body.classList.contains('paged-mode')) return;  // 已切回滚动模式
      if (document.getElementById('paged') !== pg) return;   // 旧页面，已换 DOM
      if (!metrics()) return;
      total = pageTotal(pg, gap, step);
      idx = keep ? Math.max(0, Math.min(total - 1, idx)) : 0;
      goto(idx);
    }

    window.__pageTurn = function (d) {
      dropSearchBack();
      var want = idx + d;
      // 翻到本经最后一页/第一页之外：交给切经，别把用户卡住
      if (want < 0 || want >= total) {
        if (window.__suttaNav) window.__suttaNav(d > 0 ? 1 : -1);
        return;
      }
      goto(want);
    };
    window.__pageInfo = function () {
      return { idx: idx, total: total, step: step, gap: gap,
               scrollWidth: pg.scrollWidth, height: pg.clientHeight };
    };
    window.__pageRecalc = recalc;
    goto(0);

    // 横向滑动翻页。用 on* 属性而不是 addEventListener：
    // 反复切翻页模式/重设时不会叠出多份监听，一次滑动只翻一页。
    var sx = 0, sy = 0;
    pv.ontouchstart = function (ev) {
      var t = ev.touches[0];
      sx = t.clientX; sy = t.clientY;
    };
    pv.ontouchend = function (ev) {
      var dx = ev.changedTouches[0].clientX - sx;
      var dy = ev.changedTouches[0].clientY - sy;
      // 从系统返回手势安全区起手的横滑不抢，交给系统
      var safe = Math.max(24, Math.round(window.innerWidth * 0.05));
      if (sx < safe || sx > window.innerWidth - safe) return;
      if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.4) {
        var want = idx + (dx < 0 ? 1 : -1);
        if (want < 0 || want >= total) {
          if (window.__suttaNav) window.__suttaNav(want < 0 ? -1 : 1);
        } else {
          dropSearchBack();
          goto(want);
        }
      }
    };

    // 字体加载完成后栏宽会变，页数要重算（首次进入阅读页尤其明显）
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () {
        setTimeout(function () { recalc(true); }, 0);
      });
    }
  }

  // 旋转/窗口尺寸变化后重算页数（只在翻页模式、且当前页仍是这块 DOM 时生效）
  window.addEventListener('resize', function () {
    if (readPrefs().paging === 'page' && window.__pageRecalc) {
      window.__pageRecalc(true);
    }
  });
  /* ---------- 阅读偏好：字号 / 行距 / 主题 / 标记 / 常亮 / 翻页 ---------- */
  var K_PREFS = 'ar.readprefs';
  var PREFS_DEF = { fs: 19, lh: 2.0, theme: 'light', marks: true, notes: true, hl: true, awake: true, paging: 'scroll', trans: false, transSet: 'ai2', paliZh: true, volTurn: false, anim: true, font: 'default' };

  function readPrefs() {
    return Object.assign({}, PREFS_DEF, readStore(K_PREFS, {}));
  }

  function savePrefs(p) {
    writeStore(K_PREFS, p);
    applyPrefs();
    // 翻页模式下字号/行距变化会改变列数，稍后重算页数（当前页尽量不跳）
    if (p.paging === 'page' && window.__pageRecalc) {
      setTimeout(function () {
        if (window.__pageRecalc) window.__pageRecalc(true);
      }, 0);
    }
  }

  function applyPrefs() {
    var p = readPrefs();
    document.documentElement.style.setProperty('--read-fs', p.fs + 'px');
    document.documentElement.style.setProperty('--read-lh', p.lh);
    var sysDark = false;
    try {
      // 原生上报优先；部分 ROM 的 WebView matchMedia 不跟系统深色
      if (typeof window.__sysDark === 'boolean') sysDark = window.__sysDark;
      else sysDark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    } catch (e) { }
    var dark = p.theme === 'dark' || (p.theme === 'system' && sysDark);
    document.documentElement.classList.toggle('dark', dark);
    document.body.classList.toggle('dark', dark);
    var ff = 'var(--serif)';
    if (p.font === 'system') ff = 'system-ui, -apple-system, "Noto Sans CJK SC", "PingFang SC", sans-serif';
    else if (p.font === 'custom' && customFontLoaded) ff = '"ARReadFont", var(--serif)';
    document.documentElement.style.setProperty('--read-font', ff);
    document.body.classList.toggle('no-mark', !p.marks);
    document.body.classList.toggle('no-note', !p.notes);
    document.body.classList.toggle('no-hl', !p.hl);
    document.body.classList.toggle('no-trans', !p.trans);
    document.body.classList.toggle('no-palizh', !p.paliZh);
    if (window.AR && AR.setTransSet) AR.setTransSet(p.transSet || 'ai2');
    if (window.ARIO && window.ARIO.setChrome) {
      try { window.ARIO.setChrome(dark); } catch (e) { }
    }
    if (window.ARIO && window.ARIO.setVolumeTurn) {
      try { window.ARIO.setVolumeTurn(!!p.volTurn); } catch (e) { }
    }
    if (window.ARIO && window.ARIO.keepScreen) {
      try { window.ARIO.keepScreen(!!p.awake); } catch (e) { }
    }
  }

  /* 「跟隨系統」时，系统深浅色变了要立即同步页面与状态栏 */
  var themeMq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function onSystemThemeChange() {
    if (readPrefs().theme === 'system') applyPrefs();
  }
  if (themeMq) {
    if (themeMq.addEventListener) themeMq.addEventListener('change', onSystemThemeChange);
    else if (themeMq.addListener) themeMq.addListener(onSystemThemeChange);
  }

  /* ---------- 我的資料：导出 / 导入 ----------
   * 全部只在本机（localStorage）。换机、重装前导一份出来最稳妥。
   */
  var UD_MAPS = { notes: 'ar.sn', favorites: 'ar.fav', highlights: 'ar.hl',
                  translations: 'ar.tr', palizh: 'ar.palizh', history: 'ar.hist',
                  folders: 'ar.folders', itemfolders: 'ar.itemfolder' };

  function collectUserData() {
    // 笔记、标签、注释放前面；历史放最后，打开备份先看到笔记与标签。
    var out = {};
    ['notes', 'favorites', 'highlights', 'translations', 'palizh',
     'folders', 'itemfolders'].forEach(function (k) {
      try { out[k] = JSON.parse(localStorage.getItem(UD_MAPS[k]) || '{}'); } catch (e) { out[k] = {}; }
    });
    try { out.annotations = JSON.parse(localStorage.getItem('ar.ua') || '{}'); } catch (e) { out.annotations = {}; }
    // 别人给的笔记包（註釋來源）也一起备份
    try { out.noteSets = JSON.parse(localStorage.getItem('ar.sets') || 'null') || allSets(); }
    catch (e) { out.noteSets = {}; }
    out.posts = {};
    for (var i = 0; i < localStorage.length; i++) {
      var key = localStorage.key(i);
      if (key && key.indexOf('ar.post.') === 0) {
        out.posts[key.slice('ar.post.'.length)] = localStorage.getItem(key);
      }
    }
    // 历史是数组，放最后；histAll() 已按 30 天过滤
    out.history = histAll();
    return out;
  }

  function exportUserData() {
    var data = collectUserData();
    var n = {
      notes: Object.keys(data.notes).length,
      annotations: Object.keys(data.annotations).length,
      posts: Object.keys(data.posts).length,
      favorites: Object.keys(data.favorites).length,
      highlights: Object.keys(data.highlights).length,
      translations: Object.keys(data.translations).length,
      history: data.history.length
    };
    var pack = {
      v: 1, kind: 'agama-userdata',
      exported: new Date().toISOString(),
      note: '掌上阿含的本機資料備份：筆記、註釋、高亮、收藏、譯文改寫、經後筆記。',
      summary: n, data: data
    };
    var name = '掌上阿含-我的資料-' + new Date().toISOString().slice(0, 10) + '.json';
    try {
      window.ARIO.export(name, 'application/json', JSON.stringify(pack, null, 1));
      toast('已匯出：筆記 ' + n.notes + '、註釋 ' + n.annotations + '、經後 ' + n.posts);
    } catch (e) { toast('匯出失敗'); }
  }

  function importUserData(pack) {
      var d = (pack && pack.data) || pack;
      if (!d || typeof d !== 'object') { toast('檔案格式不對'); return; }
      var n = 0;
      Object.keys(UD_MAPS).forEach(function (k) {
        if (!d[k] || typeof d[k] !== 'object') return;
        // 历史是数组，不能按 id 合并：写进对象会让阅读页 pushHist() 直接抛
        // “a.unshift is not a function”，所有经文都打不开（2026-11-17 真机踩到过）。
        if (k === 'history') {
          if (!Array.isArray(d[k])) return;
          var curH = histAll().slice();
          var seenH = {};
          curH.forEach(function (x) { if (x) seenH[x.k + '\u0001' + x.kind + '\u0001' + x.t] = 1; });
          d[k].forEach(function (x) {
            if (!x || !x.k || !histFresh(x)) return;
            var sig = x.k + '\u0001' + x.kind + '\u0001' + x.t;
            if (seenH[sig]) return;
            seenH[sig] = 1;
            curH.push(x); n++;
          });
          curH.sort(function (a, b) { return a.t < b.t ? 1 : -1; });
          localStorage.setItem('ar.hist', JSON.stringify(curH.slice(0, 400)));
          return;
        }
        var cur = {};
        try { cur = JSON.parse(localStorage.getItem(UD_MAPS[k]) || '{}'); } catch (e) { }
        Object.keys(d[k]).forEach(function (id) { cur[id] = d[k][id]; n++; });
        localStorage.setItem(UD_MAPS[k], JSON.stringify(cur));
      });
      if (d.annotations && typeof d.annotations === 'object') {
        var au = {};
        try { au = JSON.parse(localStorage.getItem('ar.ua') || '{}'); } catch (e) { }
        Object.keys(d.annotations).forEach(function (k) {
          var mine = au[k] || [];
          var seen = {};
          mine.forEach(function (x) { seen[x.ts] = 1; });
          (d.annotations[k] || []).forEach(function (x) {
            if (!x || seen[x.ts]) return;
            mine.push(x); n++;
          });
          au[k] = mine;
        });
        localStorage.setItem('ar.ua', JSON.stringify(au));
      }
      if (d.posts && typeof d.posts === 'object') {
        Object.keys(d.posts).forEach(function (k) {
          if (typeof d.posts[k] === 'string') {
            localStorage.setItem('ar.post.' + k, d.posts[k]); n++;
          }
        });
      }
      /* 别人给的註釋套（「作為新的一套」导入的）也在备份里。
       * 2026-11-17 之前只导出、不写回，换机后这些套会静默消失；这里按 id 補回去，
       * 本机已有的同名 id 保留本机那份，不覆盖正在用的。 */
      if (d.noteSets && typeof d.noteSets === 'object') {
        var sets = {};
        try { sets = JSON.parse(localStorage.getItem('ar.sets') || '{}') || {}; } catch (e) { sets = {}; }
        Object.keys(d.noteSets).forEach(function (sid) {
          if (!sets[sid] && d.noteSets[sid]) { sets[sid] = d.noteSets[sid]; n++; }
        });
        try { localStorage.setItem('ar.sets', JSON.stringify(sets)); } catch (e) { }
      }
      if (window.AR && AR.setPaliOverrides) {
        try { AR.setPaliOverrides(JSON.parse(localStorage.getItem('ar.palizh') || '{}')); } catch (e) { }
      }
      toast('已匯入 ' + n + ' 項');
      setTimeout(function () { route(); }, 900);
  }

  function showReadSettings() {
    var mask = document.createElement('div');
    mask.className = 'sheet-mask';

    function render() {
      var p = readPrefs();
      mask.innerHTML = AR.conv(
        '<div class="sheet"><div class="hd"><span class="t">閱讀設置</span>' +
        '<span class="x" data-close>×</span></div><div class="rset">' +
        '<div class="row"><span class="k">字號</span><span class="stepper">' +
        '<span class="btn2" data-fs="-1">−</span><b>' + p.fs + '</b>' +
        '<span class="btn2" data-fs="1">＋</span></span></div>' +
        '<div class="row"><span class="k">行距</span><span class="seg lhseg">' +
        [1.4, 1.6, 1.8, 2.0, 2.2, 2.4].map(function (v) {
          return '<a class="seg-i' + (Math.abs(p.lh - v) < 0.01 ? ' on' : '') +
            '" data-lh="' + v + '">' + v.toFixed(1) + '</a>';
        }).join('') + '</span></div>' +
        '<div class="row"><span class="k">主題</span><span class="seg">' +
        '<a class="seg-i' + (p.theme === 'system' ? ' on' : '') + '" data-theme="system">跟隨系統</a>' +
        '<a class="seg-i' + (p.theme === 'light' ? ' on' : '') + '" data-theme="light">淺色</a>' +
        '<a class="seg-i' + (p.theme === 'dark' ? ' on' : '') + '" data-theme="dark">深色</a>' +
        '</span></div>' +
        '<div class="row"><span class="k">翻頁</span><span class="seg">' +
        '<a class="seg-i' + (p.paging === 'scroll' ? ' on' : '') + '" data-paging="scroll">上下滾動</a>' +
        '<a class="seg-i' + (p.paging === 'page' ? ' on' : '') + '" data-paging="page">左右翻頁</a>' +
        '</span></div>' +
        '<div class="row"><span class="k">註釋標記<i>字下的虛線，點字即看註</i></span>' +
        '<span class="sw' + (p.marks ? ' on' : '') + '" data-toggle="marks"></span></div>' +
        '<div class="row"><span class="k">經內筆記<i>附在段後顯示</i></span>' +
        '<span class="sw' + (p.notes ? ' on' : '') + '" data-toggle="notes"></span></div>' +
        '<div class="row"><span class="k">高亮<i>自己劃的重點</i></span>' +
        '<span class="sw' + (p.hl ? ' on' : '') + '" data-toggle="hl"></span></div>' +
        '<div class="row"><span class="k">屏幕常亮</span>' +
        '<span class="sw' + (p.awake ? ' on' : '') + '" data-toggle="awake"></span></div>' +
        '<div class="row"><span class="k">切換動畫<i>舊機器可關掉</i></span>' +
        '<span class="sw' + (p.anim ? ' on' : '') + '" data-toggle="anim"></span></div>' +
        '<div class="row"><span class="k">音量鍵翻頁<i>僅在左右翻頁時生效</i></span>' +
        '<span class="sw' + (p.volTurn ? ' on' : '') + '" data-toggle="volTurn"></span></div>' +
        '</div></div>');

      Array.prototype.forEach.call(mask.querySelectorAll('[data-fs]'), function (el) {
        el.addEventListener('click', function () {
          var p2 = readPrefs();
          p2.fs = Math.min(26, Math.max(15, p2.fs + Number(el.getAttribute('data-fs'))));
          savePrefs(p2);
          render();
        });
      });
      Array.prototype.forEach.call(mask.querySelectorAll('[data-lh]'), function (el) {
        el.addEventListener('click', function () {
          var p2 = readPrefs();
          p2.lh = Number(el.getAttribute('data-lh'));
          savePrefs(p2);
          render();
        });
      });
      Array.prototype.forEach.call(mask.querySelectorAll('[data-theme]'), function (el) {
        el.addEventListener('click', function () {
          var p2 = readPrefs();
          p2.theme = el.getAttribute('data-theme');
          savePrefs(p2);
          render();
        });
      });
      Array.prototype.forEach.call(mask.querySelectorAll('[data-paging]'), function (el) {
        el.addEventListener('click', function () {
          var p2 = readPrefs();
          p2.paging = el.getAttribute('data-paging');
          savePrefs(p2);
          applyPaging();                // 就地切换，面板留着
          render();
        });
      });
      Array.prototype.forEach.call(mask.querySelectorAll('[data-toggle]'), function (el) {
        el.addEventListener('click', function () {
          var p2 = readPrefs();
          var k = el.getAttribute('data-toggle');
          p2[k] = !p2[k];
          savePrefs(p2);
          render();
        });
      });
    }

    mountSheet(mask);
    render();
    mask.addEventListener('click', function (ev) {
      if (ev.target === mask || ev.target.hasAttribute('data-close')) mask.remove();
    });
  }

  /* ---------- 翻译 / 朗读 / 更多 ---------- */
  /* 譯文面板：開關、選譯本、匯出／匯入自己的改寫 */
  function showTranslateSheet(e) {
    var mask = document.createElement('div');
    mask.className = 'sheet-mask';
    var series = AR.seriesOf(e.k);
    var avail = {};          // setid → 本經段數

    function render() {
      var p = readPrefs();
      var cur = AR.transSet();
      var sets = AR.TRANS_SETS.filter(function (id) { return avail[id]; });
      var ov = AR.trOverride()[e.k] || {};
      var ovN = Object.keys(ov).length;
      var mine = avail[e.k + '|' + cur] || 0;
      var pzN = 0;
      try { var zm = AR.paliFor(e).zh; pzN = zm ? Object.keys(zm).length : 0; } catch (err) { }
      // 巴利页通常没有漢譯改写；有直译时只显示「巴利直译」这一行，少一行噪声
      var showTrRow = (mine > 0 || ovN > 0 || !pzN);

      mask.innerHTML = AR.conv(
        '<div class="sheet"><div class="hd"><span class="t">翻譯</span>' +
        '<span class="x" data-close>×</span></div><div class="rset">' +
        (showTrRow
          ? '<div class="row"><span class="k">顯示其它譯本<i>' +
            (mine ? '本經 ' + mine + ' 段' : '暫未導入其它譯本') + '</i></span>' +
            '<span class="sw' + (p.trans ? ' on' : '') + '" data-tr="1"></span></div>'
          : '') +
        (pzN
          ? '<div class="row"><span class="k">顯示巴利直譯<i>本經 ' + pzN + ' 段</i></span>' +
            '<span class="sw' + (p.paliZh ? ' on' : '') + '" data-palizh="1"></span></div>'
          : '') +
        (sets.length > 1
          ? '<div class="row"><span class="k">譯本<i>可切換，也可只留一套</i></span><span class="seg">' +
            sets.map(function (id) {
              return '<a class="seg-i' + (id === cur ? ' on' : '') + '" data-set="' + id + '">' +
                (id === 'ai2' ? '外部初譯' : (id === 'ai' ? '自製' : id)) + '</a>';
            }).join('') + '</span></div>'
          : '') +
        (ovN
          ? '<div class="row"><span class="k">我的改寫<i>' + ovN + ' 段</i></span>' +
            '<span class="btn ghost" data-trreset="1">還原全部</span></div>'
          : '') +
        '</div><div class="b" style="padding-top:12px">' +
        '<p class="dim">' + (showTrRow
          ? '點任一段譯文可改寫，改寫只存在本機、隨時可還原，不會覆蓋原文與默認譯本。'
          : '巴利直譯只在本機顯示，暫不支援改寫。') + '</p>' +
        (pzN
          ? '<p class="dim">巴利直譯為 AI 批量初譯，僅供參考；如有更可靠的對譯本，歡迎聯繫（見授權頁）。</p>'
          : '') +
        '</div>' +
        (showTrRow
          ? '<div class="btns">' +
            '<span class="btn ghost" data-trimp="1">匯入改寫</span>' +
            '<span class="btn ghost" data-trexp="1">匯出譯文</span>' +
            '</div>'
          : '') +
        (pzN
          ? '<div class="btns">' +
            '<span class="btn ghost" data-pzexp="1">匯出本經直譯</span>' +
            '<span class="btn ghost" data-pzimp="1">匯入巴利直譯</span>' +
            '</div>'
          : '') +
        '</div></div>');

      var trSw = mask.querySelector('[data-tr]');
      if (trSw) trSw.addEventListener('click', function () {
        var p2 = readPrefs();
        p2.trans = !p2.trans;
        savePrefs(p2);
        document.querySelectorAll('.read-body .tr').forEach(function (el) {
          el.style.display = p2.trans ? '' : 'none';
        });
        render();
      });
      var pzSw = mask.querySelector('[data-palizh]');
      if (pzSw) pzSw.addEventListener('click', function () {
        var p2 = readPrefs();
        p2.paliZh = !p2.paliZh;
        savePrefs(p2);
        render();
      });
      var pzExp = mask.querySelector('[data-pzexp]');
      if (pzExp) pzExp.addEventListener('click', function () {
        exportPaliZh(e.k);
      });
      var pzImp = mask.querySelector('[data-pzimp]');
      if (pzImp) pzImp.addEventListener('click', function () {
        mask.remove();
        importPaliZh();
      });
      Array.prototype.forEach.call(mask.querySelectorAll('[data-set]'), function (el) {
        el.addEventListener('click', function () {
          var p2 = readPrefs();
          p2.transSet = el.getAttribute('data-set');
          savePrefs(p2);
          AR.setTransSet(p2.transSet);
          mask.remove();
          route();                       // 换译本要重渲染
        });
      });
      var rst = mask.querySelector('[data-trreset]');
      if (rst) rst.addEventListener('click', function () {
        setTrOverrideAll(e.k, {});
        mask.remove();
        route();
        toast('已還原本經改寫');
      });
      var trImp = mask.querySelector('[data-trimp]');
      if (trImp) trImp.addEventListener('click', importOverrides);
      var trExp = mask.querySelector('[data-trexp]');
      if (trExp) trExp.addEventListener('click', function () {
        exportTranslate(e.k);
      });
    }

    // 先按本經統計各譯本有多少段
    Promise.all(AR.TRANS_SETS.map(function (id) {
      return AR.loadTrans(series, id).then(function (map) {
        // 按「部」统计：只要这一部有译文就把这套列出来，本经没有也不隐藏
        avail[id] = Object.keys(map).length;
        avail[e.k + '|' + id] = Object.keys(map[e.k] || {}).length;
      });
    })).then(function () { render(); });

    mountSheet(mask);
    mask.addEventListener('click', function (ev) {
      if (ev.target === mask || ev.target.hasAttribute('data-close')) mask.remove();
    });
  }

  /* 整经清空本地改写 */
  function setTrOverrideAll(k, map) {
    var all = AR.trOverride();
    if (Object.keys(map).length) all[k] = map; else delete all[k];
    localStorage.setItem('ar.tr', JSON.stringify(all));
  }

  /* 汇出：把当前译本 + 我的改写合成一份 JSON，走 ARIO.export */
  function exportTranslate(k) {
    var series = AR.seriesOf(k);
    AR.loadTrans(series).then(function (map) {
      var base = map[k] || {};
      var ov = AR.trOverride()[k] || {};
      var rows = [];
      Object.keys(base).forEach(function (b) {
        rows.push({ b: +b, h: ov[b] || base[b], mine: !!ov[b] });
      });
      Object.keys(ov).forEach(function (b) {
        if (!base[b]) rows.push({ b: +b, h: ov[b], mine: true });
      });
      rows.sort(function (a, b) { return a.b - b.b; });
      var pack = {
        v: 1, kind: 'agama-translation',
        meta: { id: 'export', name: '譯文匯出', k: k, set: AR.transSet(),
                license: 'CC BY-NC-SA 4.0', basedOn: 'text 2026-11-14' },
        entries: rows.map(function (x) { return { k: k, b: x.b, h: x.h }; })
      };
      var name = (k.replace(/[^\w.-]+/g, '_') || 'trans') + '.json';
      try {
        window.ARIO.export(name, 'application/json', JSON.stringify(pack, null, 1));
      } catch (err) { toast('匯出失敗'); }
    });
  }

  /* 汇入：读别人给的译文本（或自己导出的），并成「我的改写」 */
  function importOverrides() {
    if (!window.ARIO || !window.ARIO.pick) { toast('此環境不支援選檔'); return; }
    window.ARIO.pick(function (name, text) {
      var pack;
      try { pack = JSON.parse(text); } catch (err) { toast('不是有效的 JSON'); return; }
      var rows = (pack && pack.entries) || (Array.isArray(pack) ? pack : []);
      if (!rows.length) { toast('裡面沒有譯文'); return; }
      var all = AR.trOverride();
      var n = 0;
      rows.forEach(function (r) {
        if (!r || !r.k || !r.h) return;
        (all[r.k] || (all[r.k] = {}))[r.b] = r.h;
        n++;
      });
      localStorage.setItem('ar.tr', JSON.stringify(all));
      toast('已匯入 ' + n + ' 段，作為你的改寫');
    });
  }

  /* ---------- 巴利直译：导出 / 导入 ---------- */
  function buildPaliPack(k) {
    var e = AR.entry(k);
    if (!e) return null;
    var zh = (AR.paliFor(e).zh || {});
    var keys = Object.keys(zh || {});
    if (!keys.length) return null;
    return {
      v: 1, kind: 'agama-pali-zh', k: k,
      name: (e.h && e.h.nm) || k,
      author: '昭',
      authorUrl: 'https://gujiduizhao.com/AGAMA',
      license: 'CC BY-NC-SA 4.0',
      note: 'AI 批量初譯，僅供參考；不保證準確。',
      exported: new Date().toISOString(),
      entries: keys.map(function (line) { return { pali: line, zh: zh[line] }; })
    };
  }

  function exportPaliZh(k) {
    var pack = buildPaliPack(k);
    if (!pack) { toast('本經沒有巴利直譯'); return; }
    var name = 'agama-pali-zh-' + String(k).replace(/[^\w.-]+/g, '_') + '.json';
    var text = JSON.stringify(pack, null, 1);
    if (window.ARIO && window.ARIO.export) {
      window.ARIO.export(name, 'application/json', text);
      return;
    }
    copyText(text, '已複製巴利直譯');
  }

  function importPaliZh() {
    if (!window.ARIO || !window.ARIO.pick) { toast('此環境不支援選檔'); return; }
    window.ARIO.pick();
  }

  function importPaliZhPack(p) {
    var all = readStore('ar.palizh', {});
    var n = 0;
    function add(k, line, zh) {
      k = String(k || '');
      line = AR.normPali(line || '');
      zh = String(zh || '').trim();
      if (!k || !line || !zh) return;
      var b = all[k] || (all[k] = {});
      b[line] = zh;
      n++;
    }
    if (p.kind === 'agama-pali-zh') {
      var k = p.k || p.key;
      (p.entries || []).forEach(function (e) { add(k, e.pali || e.line, e.zh || e.h); });
    }
    if (p.byKey && typeof p.byKey === 'object') {
      Object.keys(p.byKey).forEach(function (k2) {
        var m = p.byKey[k2] || {};
        Object.keys(m).forEach(function (line) { add(k2, line, m[line]); });
      });
    }
    if (!n) { toast('裡面沒有巴利直譯'); return; }
    writeStore('ar.palizh', all);
    if (AR.setPaliOverrides) AR.setPaliOverrides(all);
    route();
    toast('已匯入 ' + n + ' 段巴利直譯');
  }

  /* 点译文改一段：本地覆盖，可还原 */
  function showTrEditor(k, b) {
    var cur = AR.transOf(k, b);
    var ov = (AR.trOverride()[k] || {})[b] || '';
    var mask = document.createElement('div');
    mask.className = 'sheet-mask';
    mask.innerHTML = AR.conv(
      '<div class="sheet"><div class="hd"><span class="t">改寫這一段</span>' +
      '<span class="x" data-close>×</span></div>' +
      '<textarea class="trin" id="trTxt"></textarea>' +
      '<div class="btns">' +
      (ov ? '<span class="btn ghost" id="trRestore">還原默認</span>' : '') +
      '<span class="btn" data-close>取消</span>' +
      '<span class="btn pri" id="trSave">儲存</span></div></div>');
    mountSheet(mask);
    var ta = mask.querySelector('#trTxt');
    ta.value = cur;
    ta.focus();
    mask.querySelector('#trSave').addEventListener('click', function () {
      var v = ta.value.trim();
      if (!v) { toast('不能為空'); return; }
      AR.setTrOverride(k, b, v);
      mask.remove();
      route();
      toast('已存為你的改寫');
    });
    var rs = mask.querySelector('#trRestore');
    if (rs) rs.addEventListener('click', function () {
      AR.setTrOverride(k, b, '');
      mask.remove();
      route();
      toast('已還原默認譯文');
    });
    mask.addEventListener('click', function (ev) {
      if (ev.target === mask || ev.target.hasAttribute('data-close')) mask.remove();
    });
  }
  function showTtsSheet() {
    var mask = document.createElement('div');
    mask.className = 'sheet-mask';
    mask.innerHTML = AR.conv(
      '<div class="sheet"><div class="hd"><span class="t">朗讀</span>' +
      '<span class="x" data-close>×</span></div><div class="b">' +
      '<p>朗讀還沒有接上。</p>' +
      '<p class="dim">計劃用系統語音引擎出聲（不增大程式體積），' +
      '也可外接人工誦讀的音频包，按段定位。' +
      '接好之後可以在設置裡選引擎、語速與是否跟隨高亮。</p>' +
      '</div></div>');
    mountSheet(mask);
    mask.addEventListener('click', function (ev) {
      if (ev.target === mask || ev.target.hasAttribute('data-close')) mask.remove();
    });
  }

  function showMoreSheet(e, notes) {
    var mask = document.createElement('div');
    mask.className = 'sheet-mask';
    mask.innerHTML = AR.conv(
      '<div class="sheet"><div class="hd"><span class="t">更多</span>' +
      '<span class="x" data-close>×</span></div><div class="picklist">' +
      '<div class="pickrow-i" data-more="quote"><span class="pn">全文引用</span></div>' +
      '</div></div>');
    mountSheet(mask);
    mask.addEventListener('click', function (ev) {
      if (ev.target === mask || ev.target.hasAttribute('data-close')) mask.remove();
    });
    mask.querySelector('[data-more="quote"]').addEventListener('click', function () {
      mask.remove();
      doQuote(e, notes.blocks);
    });
  }
  /* ---------- 历史记录 ---------- */

  var K_HIST = 'ar.hist';
  var HIST_DAYS = 30;
  var WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  /* 只保留最近 30 天；时间坏掉的旧记录也无法判断新旧，一并清掉，
   * 另有 400 条上限兜底。读取时过滤，pushHist 写回时会顺手把过期项清掉。 */
  function histFresh(x) {
    if (!x || !x.t) return false;
    var ts = Date.parse(x.t);
    if (isNaN(ts)) return false;
    return ts >= Date.now() - HIST_DAYS * 86400000;
  }

  function histAll() {
    var a = readStore(K_HIST, []);
    // 备份导入可能把 history 写成对象（旧版 collectUserData 空表就是 {}），
    // 那之后 pushHist() 的 a.unshift 会炸掉整个阅读页——这里兜住，只认数组。
    return Array.isArray(a) ? a.filter(histFresh) : [];
  }

  function pushHist(k, kind) {
    if (!k) return;
    var a = histAll();
    // 同一条连续重复不记
    if (a.length && a[0].k === k && a[0].kind === kind) return;
    a.unshift({ k: k, kind: kind, t: nowIso() });
    if (a.length > 400) a.length = 400;
    writeStore(K_HIST, a);
  }

  function dayLabel(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '-' + WEEK[d.getDay()];
  }

  var historyTab = 'jump';
  var historyManage = false;      // 多选管理态
  var historySel = {};            // 原数组下标 -> true
  var historyBlockClick = 0;      // 长按刚进管理态时，吞掉抬手那一下

  /* 历史记录做成整页：底部弹层翻起来费劲，整页可以一路滚、也能跳进去读 */
  function viewHistory() {
    var fromM = location.hash.match(/[?&]from=([^&]+)/);
    var from = fromM ? decodeURIComponent(fromM[1]) : '';
    var back = from ? '#/k/' + encodeURIComponent(from) : '#/';
    var tab = historyTab;
    var all = [];
    histAll().forEach(function (x, i) {
      if (x.kind === tab) all.push({ x: x, i: i });
    });
    var shown = all.slice(0, 300);

    var body = '';
    if (!all.length) {
      body = '<div class="empty-hint">' +
        (tab === 'jump'
          ? '還沒有跳轉記錄。用經號跳轉或點對讀連結會記在這裡。'
          : '還沒有閱讀記錄。從目錄點進經文，或前後翻閱，會記在這裡。') +
        '</div>';
    } else {
      var lastDay = '';
      shown.forEach(function (o) {
        var x = o.x, d = dayLabel(x.t);
        if (d !== lastDay) { body += '<div class="hist-day">' + d + '</div>'; lastDay = d; }
        body += '<a class="hist-row' + (historySel[o.i] ? ' sel' : '') + '" href="#/k/' +
          encodeURIComponent(x.k) + '" data-nav="jump" data-i="' + o.i + '">' +
          (historyManage ? '<span class="hcheck"></span>' : '') +
          '<span class="hn">' + esc(nameOf(x.k)) + '</span>' +
          '<span class="hk">' + esc(x.k) + '</span></a>';
      });
    }

    var selN = Object.keys(historySel).length;
    var manageBar = historyManage
      ? '<div class="hist-bar" id="histBar">' +
        '<span class="hb" id="hAll">全選</span>' +
        '<span class="hb danger" id="hDel">刪除' + (selN ? ' (' + selN + ')' : '') + '</span>' +
        '<span class="hb" id="hCancel">取消</span></div>'
      : '';

    paint(
      bar('歷史記錄', back, '<span class="act" id="hManage">' + (historyManage ? '完成' : '管理') + '</span>') +
      '<div class="app' + (historyManage ? ' hist-manage' : '') + '"><div class="mtabs inline">' +
      '<a class="mtab' + (tab === 'jump' ? ' on' : '') + '" data-t="jump">跳轉</a>' +
      '<a class="mtab' + (tab === 'read' ? ' on' : '') + '" data-t="read">閱讀</a></div>' +
      '<div class="hist-list page">' + body + '</div></div>' + manageBar
    );

    Array.prototype.forEach.call(document.querySelectorAll('[data-t]'), function (el) {
      el.addEventListener('click', function () {
        historyTab = el.getAttribute('data-t');
        historyManage = false;
        historySel = {};
        viewHistory();
      });
    });

    var manage = document.getElementById('hManage');
    if (manage) {
      manage.addEventListener('click', function () {
        historyManage = !historyManage;
        historySel = {};
        viewHistory();
      });
    }

    var list = document.querySelector('.hist-list');
    if (list) {
      // 历史条目不需要选字，长按不要再弹系统的复制/搜索菜单
      list.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });
    }

    function refreshSelUI() {
      Array.prototype.forEach.call(document.querySelectorAll('.hist-row'), function (row) {
        row.classList.toggle('sel', !!historySel[row.getAttribute('data-i')]);
      });
      var del = document.getElementById('hDel');
      var n = Object.keys(historySel).length;
      if (del) del.textContent = AR.conv('刪除') + (n ? ' (' + n + ')' : '');
    }

    Array.prototype.forEach.call(document.querySelectorAll('.hist-row'), function (row) {
      var idx = row.getAttribute('data-i');
      var lp = null;

      function clearLp() { if (lp) { clearTimeout(lp); lp = null; } }

      row.addEventListener('touchstart', function () {
        if (historyManage) return;
        clearLp();
        lp = setTimeout(function () {
          lp = null;
          historyBlockClick = Date.now() + 700;
          if (navigator.vibrate) { try { navigator.vibrate(12); } catch (e) { } }
          historyManage = true;
          historySel = {};
          historySel[idx] = true;
          viewHistory();
        }, 480);
      }, { passive: true });
      row.addEventListener('touchmove', clearLp, { passive: true });
      row.addEventListener('touchend', clearLp, { passive: true });
      row.addEventListener('touchcancel', clearLp, { passive: true });

      row.addEventListener('click', function (ev) {
        if (!historyManage) return;
        ev.preventDefault();
        if (Date.now() < historyBlockClick) return;
        if (historySel[idx]) delete historySel[idx]; else historySel[idx] = true;
        refreshSelUI();
      });
    });

    var hAll = document.getElementById('hAll');
    if (hAll) {
      hAll.addEventListener('click', function () {
        shown.forEach(function (o) { historySel[o.i] = true; });
        refreshSelUI();
      });
    }
    var hCancel = document.getElementById('hCancel');
    if (hCancel) {
      hCancel.addEventListener('click', function () {
        historyManage = false;
        historySel = {};
        viewHistory();
      });
    }
    var hDel = document.getElementById('hDel');
    if (hDel) {
      hDel.addEventListener('click', function () {
        var ids = Object.keys(historySel);
        if (!ids.length) { toast('先選要刪的記錄'); return; }
        confirmSheet('刪除記錄', '共 ' + ids.length + ' 條，刪除後不能恢復。', '刪除', function () {
          var drop = {};
          ids.forEach(function (i) { drop[i] = true; });
          var keep = histAll().filter(function (x, i) { return !drop[i]; });
          writeStore(K_HIST, keep);
          historyManage = false;
          historySel = {};
          viewHistory();
          toast('已刪除 ' + ids.length + ' 條');
        });
      });
    }
  }

  /* 切经动画：只在手势/按钮切换时播，直接打开链接不播 */
  var pendingSlide = 0;

  function playSlide() {
    var d = pendingSlide;
    pendingSlide = 0;
    if (!d || !readPrefs().anim) return;
    /* 翻页模式下不要给 #readApp 加 transform：
     * 翻页时正文全在 position:fixed 的 .pageview 里，#readApp 自身几乎无流内容；
     * 一旦 #readApp 有 transform，它会成为 fixed 子元素的包含块，
     * .pageview 只剩下 40px 高，多栏被切成几百个小列，页数直接算成几百。
     * 切经的翻页动效由 .paged 自己的 translateX 过渡承担。 */
    if (readPrefs().paging === 'page') return;
    var app = document.getElementById('readApp');
    if (!app) return;
    var cls = d > 0 ? 'in-left' : 'in-right';
    app.classList.add(cls);
    setTimeout(function () { app.classList.remove(cls); }, 320);
  }
  /* 折叠区状态记忆：对读默认展开，巴利／比对默认收起 */
  var FOLD_DEFAULT = { xref: true, pali: false, cmp: false, xr: true };

  function bindFolds() {
    Array.prototype.forEach.call(document.querySelectorAll('details[data-fold]'), function (d) {
      var name = d.getAttribute('data-fold');
      var v = localStorage.getItem('ar.fold.' + name);
      d.open = (v === null) ? !!FOLD_DEFAULT[name] : (v === '1');
      if (paliMode && name === 'pali') d.open = true;   // 巴利入口进来默认展开
      d.addEventListener('toggle', function () {
        localStorage.setItem('ar.fold.' + name, d.open ? '1' : '0');
        // 折叠区展开/收起会增减正文高度，翻页模式下页数要跟着重算
        if (readPrefs().paging === 'page' && window.__pageRecalc) {
          window.__pageRecalc(true);
        }
      });
    });
  }
  /* 点译文块 → 改这一段（存本机，不改默认译本） */
  /* 译文：长按才编辑，避免一划一碰就弹编辑器 */
  /* 译文长按编辑由统一委托器处理 */
  function bindTransEdit() { }

  /* 对读：把对应经的正文直接展开在本页，不跳走 */
  function bindXref() {
    Array.prototype.forEach.call(document.querySelectorAll('.xr-item'), function (el) {
      var k = el.getAttribute('data-xk');
      var box = el.querySelector('.xr-b');
      if (!box) return;
      AR.loadSeries(AR.seriesOf(k)).then(function () {
        var en = AR.entry(k);
        if (!en) { box.textContent = '（載入失敗）'; return; }
        var ps = (en.b || []).filter(function (b) {
          return b.g !== 'h' && b.g !== 'num' && (b.t || '').trim();
        });
        var show = ps.slice(0, 8);
        var html = show.map(function (b) { return '<p>' + esc(b.t) + '</p>'; }).join('');
        if (ps.length > show.length) {
          html += '<div class="xr-more">… 共 ' + ps.length + ' 段，想看全按下「跳轉」</div>';
        }
        box.innerHTML = AR.conv(html);
      }).catch(function () { box.textContent = '（載入失敗）'; });
    });
  }

  /* 左右滑动手势切上一经/下一经（上下滚动模式）；翻页模式在首末页时也让位给切经 */
  function bindSwipeNav(prev, next) {
    window.__suttaNav = function (d) {
      var k = d > 0 ? next : prev;
      if (!k) { toast(d > 0 ? '已到本部經的最後一經' : '已到本部經的第一經'); return false; }
      pendingSlide = d > 0 ? 1 : -1;
      // 巴利入口进来时要带着 via=pali，否则下一经会退回汉译版式、返回也回汉译目录
      location.hash = '#/k/' + encodeURIComponent(k) + (paliMode ? '?via=pali' : '');
      return true;
    };
    var app = document.getElementById('readApp');
    if (!app) return;
    var sx = 0, sy = 0, moved = false;
    app.addEventListener('touchstart', function (ev) {
      var t = ev.touches[0];
      sx = t.clientX; sy = t.clientY; moved = false;
    }, { passive: true });
    app.addEventListener('touchmove', function (ev) {
      var t = ev.touches[0];
      if (Math.abs(t.clientX - sx) > 12) moved = true;
    }, { passive: true });
    app.addEventListener('touchend', function (ev) {
      // 翻页模式交给横向翻页。这里必须动态判断：原来的写法是在绑定时就 return，
      // 从设置里切到翻页后旧监听仍在，横滑会同时触发切经与翻页。
      if (readPrefs().paging === 'page') return;
      if (!moved) return;
      var safe = Math.max(24, Math.round(window.innerWidth * 0.05));
      if (sx < safe || sx > window.innerWidth - safe) return;
      var t = ev.changedTouches[0];
      var dx = t.clientX - sx, dy = t.clientY - sy;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      window.__suttaNav(dx < 0 ? 1 : -1);
    }, { passive: true });
  }
  function jumpToBlock(b) {
    var p = document.querySelector('.read-body p[data-b="' + b + '"]');
    if (!p) return;
    setTimeout(function () {
      window.scrollTo(0, Math.max(0, window.scrollY + p.getBoundingClientRect().top - 90));
      p.classList.add('flash');
      setTimeout(function () { p.classList.remove('flash'); }, 1600);
    }, 60);
  }

  /* 段落操作：点一段 → 选中 → 底部出现「高亮 / 筆記 / 複製」 */
  function bindParaOps(e, notes) {
    var bar = document.getElementById('actbar');
    var app = document.getElementById('readApp');
    if (!bar || !app) return;
    var cur = null;
    var sel = null;          // 文字选区 {b, s, e, text}
    // 指纹 → 段号，供跨版本对位
    var fpIndex = {};
    notes.blocks.forEach(function (x) { if (x.fp) fpIndex[x.fp] = x.i; });

    function textOf(b) {
      var hit = '';
      notes.blocks.forEach(function (x) { if (x.i === b) hit = x.t; });
      return hit;
    }

    function excerptOf(b) {
      var t = textOf(b).replace(/\s+/g, '');
      return t.length > 34 ? t.slice(0, 34) + '…' : t;
    }

    function fpOf(b) {
      var fpv = '';
      notes.blocks.forEach(function (x) { if (x.i === b) fpv = x.fp || ''; });
      return fpv;
    }

    function clearSel() {
      window.__suppressMenu = Date.now() + 500;
      Array.prototype.forEach.call(document.querySelectorAll('.read-body p.sel'), function (x) {
        x.classList.remove('sel');
      });
      Array.prototype.forEach.call(document.querySelectorAll('.hlr.sel-hl'), function (x) {
        x.classList.remove('sel-hl');
      });
      var s = window.getSelection && window.getSelection();
      if (s && s.removeAllRanges) s.removeAllRanges();
      bar.classList.remove('on');
      cur = null;
      sel = null;
    }

    function refreshBar() {
      var el = document.getElementById('abHl');
      if (el) {
        var exact = false;
        if (sel) {
          exact = hlRanges(e.k, sel.b).some(function (r) {
            return r.s === sel.s && (r.e == null ? -1 : r.e) === sel.e;
          });
        }
        el.textContent = exact ? '取消高亮' : '高亮';
        el.classList.toggle('on', exact);
      }
    }

    /* 点已有的高亮：把这一条选起来，操作条上直接给「取消高亮」 */
    function selectHighlight(el) {
      var b = +el.getAttribute('data-hlb');
      var s = +el.getAttribute('data-hls');
      var en = +el.getAttribute('data-hle');
      if (isNaN(b) || isNaN(s) || isNaN(en)) return;
      clearSel();
      cur = b;
      var t = textOf(b);
      sel = { b: b, s: s, e: en, text: t.slice(s, en < 0 ? t.length : en) };
      Array.prototype.forEach.call(document.querySelectorAll('.hlr'), function (x) {
        if (+x.getAttribute('data-hlb') === b && +x.getAttribute('data-hls') === s &&
            +x.getAttribute('data-hle') === en) x.classList.add('sel-hl');
      });
      bar.classList.add('on');
      refreshBar();
      if (window.__readMenu && window.__readMenu.hide) window.__readMenu.hide();
    }

    /* 重绘某一段（高亮增删后就地更新，不整页重排、不丢滚动位置） */
    function rerenderBlock(b) {
      var blk = null;
      notes.blocks.forEach(function (x) { if (x.i === b) blk = x; });
      var p = document.querySelector('.read-body p[data-b="' + b + '"]');
      if (!blk || !p) return;
      p.innerHTML = AR.conv(withMarks(blk.t, blk.m, hlRanges(e.k, b), AR.uaFor(e.k, b), b));
      bindMarks(notes);
      p.classList.toggle('hasn', !!segNotes(e.k)[b]);
    }

    /* 只取「同一段内」的文字选区 */
    function readSelection() {
      var s = window.getSelection && window.getSelection();
      if (!s || s.isCollapsed || !s.rangeCount) return null;
      var r = s.getRangeAt(0);
      var bodyEl = document.querySelector('.read-body');
      if (!bodyEl || !bodyEl.contains(r.commonAncestorContainer)) return null;
      var p1 = upToP(r.startContainer), p2 = upToP(r.endContainer);
      if (!p1 || p1 !== p2) return null;
      var b = +p1.getAttribute('data-b');
      var a = toOrigOffset(b, charOffset(p1, r.startContainer, r.startOffset));
      var z = toOrigOffset(b, charOffset(p1, r.endContainer, r.endOffset));
      if (z <= a) return null;
      return { b: b, s: a, e: z, text: r.toString() };
    }

    function upToP(n) {
      while (n && n !== document.body) {
        if (n.nodeType === 1 && n.hasAttribute && n.hasAttribute('data-b')) return n;
        n = n.parentNode;
      }
      return null;
    }

    /* DOM 位置 → 段落里「看得见的第几个字」。
     * 早先用「遍历文本节点累加长度」，遇到边界落在元素上（比如整词选中一个
     * .mark）就算不出来；改用 Range 直接量「从段首到这个点有多少字」，稳。
     * 注意：这个数**不是**原文偏移——校勘记号 [ ] { } 在渲染时被剥掉了。
     */
    function charOffset(root, target, off) {
      try {
        var rg = document.createRange();
        rg.setStart(root, 0);
        rg.setEnd(target, off);
        return rg.toString().length;
      } catch (e) {
        return 0;
      }
    }

    /* 可见字序号 → 原文偏移。按原文重走一遍，跳过 [ ] { }。
     * 不换算的话，含校勘记号的段落里选「哲」会存成「众」（左移 4 字）。
     */
    function toOrigOffset(b, domOff) {
      var t = textOf(b) || '';
      var n = 0;
      for (var i = 0; i < t.length; i++) {
        var ch = t.charAt(i);
        if (ch === '[' || ch === ']' || ch === '{' || ch === '}') continue;
        if (n === domOff) return i;
        n++;
      }
      return t.length;
    }

    /* 单击留给「唤出菜单」，选段改成**长按**（按约定） */
    function selectPara(p) {
      var b = +p.getAttribute('data-b');
      if (cur === b) { clearSel(); return; }
      clearSel();
      // 进选择模式时先把菜单收起来，别挡住操作条
      document.querySelectorAll('.readmenu').forEach(function (el) { el.classList.remove('show'); });
      // 长按之后紧跟着会来一个 click，别让它把菜单又拉起来
      window.__suppressMenu = Date.now() + 800;
      window.__suppressMark = Date.now() + 800;
      cur = b;
      p.classList.add('sel');
      bar.classList.add('on');
      refreshBar();
      if (navigator.vibrate) { try { navigator.vibrate(12); } catch (e) { } }
    }

    window.__clearSel = clearSel;
    /* ---------- 我的註（词/句级，本机） ---------- */

    function showUaEditor(k, b, st, en, oldTs) {
      var list = AR.uaAll()[k] || [];
      var old = oldTs ? list.filter(function (x) { return x.ts === oldTs; })[0] : null;
      var mask = document.createElement('div');
      mask.className = 'sheet-mask';
      mask.innerHTML = AR.conv(
        '<div class="sheet"><div class="hd"><span class="t">我的註釋</span>' +
        '<span class="x" data-close>×</span></div>' +
        '<textarea class="trin" id="uaTxt" placeholder="寫下你對這幾個字的解釋…"></textarea>' +
        '<div class="btns">' +
        (old ? '<span class="btn ghost" id="uaDel">刪除</span>' : '') +
        '<span class="btn" data-close>取消</span>' +
        '<span class="btn pri" id="uaSave">儲存</span></div></div>');
      mountSheet(mask);
      var ta = mask.querySelector('#uaTxt');
      ta.value = old ? old.h : '';
      ta.focus();
      mask.querySelector('#uaSave').addEventListener('click', function () {
        var v = ta.value.trim();
        if (!v) { toast('不能為空'); return; }
        if (old) AR.uaDel(k, old.ts);
        AR.uaAdd(k, b, st, en, v);
        mask.remove();
        route();
        toast('已存為註釋');
      });
      var d = mask.querySelector('#uaDel');
      if (d) d.addEventListener('click', function () {
        AR.uaDel(k, old.ts);
        mask.remove();
        route();
        toast('已刪除');
      });
      mask.addEventListener('click', function (ev) {
        if (ev.target === mask || ev.target.hasAttribute('data-close')) mask.remove();
      });
    }

    document.getElementById('abAnno').addEventListener('click', function () {
      // 有选区：给这几个字写註；没有选区（双击选段）：把这一段的註释都列出来
      if (sel) { bar.classList.remove('on'); showUaEditor(e.k, sel.b, sel.s, sel.e, ''); return; }
      if (cur != null) { bar.classList.remove('on'); showBlockNotes(e.k, cur, fpIndex); return; }
      toast('先長按選一段文字');
    });

    /* 点已有注释：我的与莊春江的一起列出（由统一委托器调用） */
    function showUaSheet(ts) {
        var mine = (AR.uaAll()[e.k] || []).filter(function (x) { return x.ts === ts; })[0];
        if (!mine) return;
        var blk = (notes.blocks || []).filter(function (x) { return x.i === mine.b; })[0] || {};
        var zcj = [];
        // 优先列出与选区重叠的莊注；没有重叠才退回「同段全部」
        var all = [];
        (blk.m || []).forEach(function (mk) {
          var note = (notes.all || [])[mk.g];
          if (!note) return;
          all.push(note);
          var o = mk.o, end = o + (mk.n || 0);
          if (end > mine.s && o < mine.e) zcj.push(note);
        });
        // 没有重叠就什么都不显示：给没注释的字加注，不该带出别处的注
        var html = '<div class="sheet"><div class="hd"><span class="t">註釋</span>' +
          '<span class="x" data-close>×</span></div><div class="b">' +
          '<div class="who">我的註釋　<a class="ref" id="uaEdit">編輯</a></div>' +
          String(mine.h).split('\n').map(function (l) { return '<p>' + esc(l) + '</p>'; }).join('');
        zcj.forEach(function (z) {
          html += '<div class="who">莊春江</div>' +
            String(z.h || '').split('\n').map(function (l) { return '<p>' + esc(l) + '</p>'; }).join('');
        });
        html += '</div></div>';
        var mask = document.createElement('div');
        mask.className = 'sheet-mask';
        mask.innerHTML = AR.conv(html);
        mountSheet(mask);
        mask.addEventListener('click', function (ev2) {
          if (ev2.target === mask || ev2.target.hasAttribute('data-close')) mask.remove();
          else if (ev2.target.id === 'uaEdit') {
            mask.remove();
            showUaEditor(e.k, mine.b, mine.s, mine.e, mine.ts);
          }
        });
    }


    /* 双击选段后点「註釋」：把这一段的我的/莊春江/导入集注释放到一个面板里。
     * 以前这里拆成「看注 N」和「註」两个按钮，导入集多一条就多一个按钮，
     * 现在统一成一个入口；有文字选区时仍然直接开编辑器写新註。
     */
    function showBlockNotes(k, b) {
      var mine = (AR.uaAll()[k] || []).filter(function (u) { return u.b === b; });
      var blk = (notes.blocks || []).filter(function (x) { return x.i === b; })[0] || {};
      var zcj = [];
      (blk.m || []).forEach(function (mk) {
        var n = (notes.all || [])[mk.g];
        if (n) zcj.push(n);
      });
      var sets = setNotesAt(k, b, fpIndex);
      if (!mine.length && !zcj.length && !sets.length) { toast('這一段沒有註釋'); return; }

      var body = '';
      if (mine.length) {
        body += '<div class="who">我的註釋</div>';
        mine.forEach(function (u) {
          body += '<p>' + esc(u.h).replace(/\n/g, '<br>') +
            '　<a class="ref" data-ua="' + u.ts + '">編輯</a></p>';
        });
      }
      if (zcj.length) {
        body += '<div class="who">莊春江</div>';
        zcj.forEach(function (z) {
          body += String(z.h || '').split('\n').map(function (l) {
            return '<p>' + esc(l) + '</p>';
          }).join('');
        });
      }
      var groups = {}, order = [];
      sets.forEach(function (n) {
        if (!groups[n.set]) { groups[n.set] = []; order.push(n.set); }
        groups[n.set].push(n);
      });
      order.forEach(function (name) {
        body += '<div class="who">' + esc(name) + '</div>' +
          groups[name].map(function (n) {
            return (n.x ? '<p class="dim">' + esc(n.x) + '</p>' : '') +
              (n.h ? '<p>' + (n.kind === 'post' ? '<span class="tagk">經後總評</span>　' : '') +
                esc(n.h) + '</p>' : '');
          }).join('');
      });

      var mask = document.createElement('div');
      mask.className = 'sheet-mask';
      mask.innerHTML = AR.conv('<div class="sheet"><div class="hd"><span class="t">這一段的註釋</span>' +
        '<span class="x" data-close>×</span></div><div class="b">' + body + '</div></div>');
      mountSheet(mask);
      mask.addEventListener('click', function (ev) {
        if (ev.target === mask || ev.target.hasAttribute('data-close')) { mask.remove(); return; }
        var ed = ev.target.closest && ev.target.closest('[data-ua]');
        if (!ed) return;
        var ts = +ed.getAttribute('data-ua');
        var u = mine.filter(function (x) { return x.ts === ts; })[0];
        if (u) { mask.remove(); showUaEditor(k, u.b, u.s, u.e, u.ts); }
      });
    }


    /* ---------- 统一事件入口 ----------
     * 页面上曾有四套各自绑定的 click/touchstart（注标、注释、译文、段落+菜单），
     * 谁先谁后全靠 stopPropagation，层一多就互相打架。
     * 现在只在这里监听：按 closest() 判断点到哪一层，按优先级分发。
     * 顺序：用户注释 > 莊注 > 译文 > 段落（长按选段）> 菜单/翻页
     */
    var lpTimer = null, lpX = 0, lpY = 0, touchStartAt = 0;
    var clickBlockUntil = 0;

    function onLongPress(target) {
      // 长按只做一件事：译文改编辑框。正文交给系统的文字选择，
      // 不再顺手把整段选上（那样会盖掉文字选区，註/高亮 用不了）。
      clickBlockUntil = Date.now() + 900;
      var tr = target.closest && target.closest('.tr');
      if (tr) showTrEditor(e.k, +tr.getAttribute('data-tb'));
    }

    app.addEventListener('touchstart', function (ev) {
      if (ev.touches && ev.touches.length > 1) return;
      var t = (ev.touches && ev.touches[0]) || ev;
      lpX = t.clientX || 0; lpY = t.clientY || 0;
      touchStartAt = Date.now();
      var target = ev.target;
      lpTimer = setTimeout(function () { lpTimer = null; onLongPress(target); }, 450);
    }, { passive: true });

    app.addEventListener('touchmove', function (ev) {
      if (!lpTimer) return;
      var t = (ev.touches && ev.touches[0]) || ev;
      if (Math.abs((t.clientX || 0) - lpX) > 12 || Math.abs((t.clientY || 0) - lpY) > 12) {
        clearTimeout(lpTimer); lpTimer = null;
      }
    }, { passive: true });

    /* 真机长按由 WebView 自己接管选字，但它**不发 selectionchange**（只发
     * touchstart + contextmenu），所以我们得主动探一次选区，不能干等事件。
     */
    /* 长按后选区不是立刻就有：WebView 建选区可能晚于 contextmenu，
     * 所以隔一会儿连探几次，探到就停。
     */
    function probeSelection(times) {
      var total = times || 8;
      (function tick(i) {
        setTimeout(function () {
          var got = false;
          if (selHandler) {
            try { got = selHandler() === true; } catch (e) { }
          }
          if (!got && i + 1 < total) tick(i + 1);
        }, i === 0 ? 40 : 130);
      })(0);
    }

    app.addEventListener('contextmenu', function (ev) {
      // 不要 preventDefault：WebView 的长按选字就是靠这一步起来的，
      // 拦掉它选区就没了（2026-11-14 踩过）。这里只借机探一次选区。
      probeSelection(8);
    });

    app.addEventListener('touchend', function () {
      if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
      var held = touchStartAt && (Date.now() - touchStartAt > 450);
      if (held) {
        // 抬手那个 click 一律吞掉，否则它会把刚浮出的操作条收掉
        clickBlockUntil = Date.now() + 600;
        probeSelection(8);
      }
      touchStartAt = 0;
    }, { passive: true });

    app.addEventListener('dblclick', function (ev) {
      var tr = ev.target.closest('.tr');
      if (tr) { ev.preventDefault(); showTrEditor(e.k, +tr.getAttribute('data-tb')); return; }
      // 双击＝选整段（原来占用长按的操作挪到这里）
      var p = ev.target.closest('.read-body p[data-b]');
      if (p) {
        ev.preventDefault();
        var s0 = window.getSelection && window.getSelection();
        if (s0 && s0.removeAllRanges) s0.removeAllRanges();
        selectPara(p);
      }
    });

    app.addEventListener('click', function (ev) {
      if (Date.now() < clickBlockUntil) return;      // 长按刚结束，这一下不算点击
      // 操作条自己的按钮：由各自处理，别让"点空白收条"的逻辑把条收掉
      if (ev.target.closest && ev.target.closest('#actbar')) return;
      // 折叠卡的展开/收起（对读、巴利、比对）是按钮，不该顺便把顶栏菜单唤出来
      if (ev.target.closest && ev.target.closest('summary')) return;
      var menu = window.__readMenu || {};

      // 1) 用户注释
      var ua = ev.target.closest('.ua');
      if (ua) { showUaSheet(+ua.getAttribute('data-ua')); return; }

      // 2) 莊春江注
      var mk = ev.target.closest('.mark');
      if (mk) {
        var m = notes.all[Number(mk.getAttribute('data-mi'))];
        if (m) showNote(m);
        return;
      }

      // 3) 链接、收藏、译文
      if (ev.target.closest('a')) return;
      // 译文单击在上下滚动时无动作；左右翻页时仍要走边缘翻页/中间唤菜单
      if (ev.target.closest('.tr') && !document.body.classList.contains('paged-mode')) return;

      // 点已有的高亮：选中它，操作条上会出现「取消高亮」
      var hlr = ev.target.closest('.hlr');
      if (hlr) { selectHighlight(hlr); return; }

      var sel = window.getSelection && window.getSelection();
      if (sel && !sel.isCollapsed) return;

      // 4) 操作条开着：这一下是收尾
      var act = document.getElementById('actbar');
      if (act && act.classList.contains('on')) { clearSel(); return; }

      // 5) 左右翻页只用手势；点击一律只唤出/收起菜单，避免和系统边缘手势冲突
      if (menu.isOpen && menu.isOpen()) menu.hide(); else if (menu.show) menu.show();
    });

    document.getElementById('abClose').addEventListener('click', clearSel);

    document.getElementById('abHl').addEventListener('click', function () {
      if (sel) {
        var s0 = sel;
        var left = toggleRangeHl(e.k, s0.b, s0.s, s0.e, fpOf(s0.b),
          excerpt(s0.text));
        rerenderBlock(s0.b);
        clearSel();
        toast(left || hlRanges(e.k, s0.b).length ? '已高亮' : '已取消高亮');
        return;
      }
      if (cur == null) return;
      var on = toggleHl(e.k, cur, excerptOf(cur), fpOf(cur));
      rerenderBlock(cur);
      refreshBar();
      toast(on ? '已高亮' : '已取消高亮');
    });

    document.getElementById('abNote').addEventListener('click', function () {
      if (cur == null) return;
      var b = cur;
      // 经内笔记载体始终是整段：即使从词/句选区进来，也按这一段存
      var ex = excerptOf(b);
      showNoteEditor(e.k, b, function (saved) {
        refreshSegNote(e.k, b, saved);
      }, ex, fpOf(b));
      bar.classList.remove('on');
    });

    document.getElementById('abCopy').addEventListener('click', function () {
      if (sel) { copyText(AR.conv(sel.text), '已複製選取'); clearSel(); return; }
      if (cur == null) return;
      var blk = null;
      notes.blocks.forEach(function (x) { if (x.i === cur) blk = x; });
      if (!blk) return;
      copyText(AR.conv(blk.t), '已複製此段');
      clearSel();
    });

    // 选字后把操作条抬出来（Android 长按选词同样触发）
    selHandler = function () {
      var s = readSelection();
      if (!s) return false;
      sel = s;
      cur = s.b;
      if (window.__readMenu && window.__readMenu.hide) window.__readMenu.hide();
      Array.prototype.forEach.call(document.querySelectorAll('.read-body p.sel'), function (x) {
        x.classList.remove('sel');
      });
      bar.classList.add('on');
      refreshBar();
      return true;
    };
  }

  function excerpt(t) {
    var s = (t || '').replace(/\s+/g, '').trim();
    return s.length > 34 ? s.slice(0, 34) + '…' : s;
  }

  function copyText(txt, okMsg) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(function () { toast(okMsg); },
        function () { toast('複製失敗'); });
      return;
    }
    var ta = document.createElement('textarea');
    ta.value = txt;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast(okMsg); } catch (e) { toast('複製失敗'); }
    ta.remove();
  }

  /* 段笔记编辑弹层 */
  function showNoteEditor(k, b, onDone, excerpt, fpv) {
    var old = segNotes(k)[b] || {};
    var saved = old.h || '';
    var d = draftFor('seg', k, b, saved, old.updated);
    var mask = document.createElement('div');
    mask.className = 'sheet-mask';
    mask.innerHTML = '<div class="sheet">' +
      '<div class="hd"><span class="t">這一段的筆記</span><span class="x" data-close>×</span></div>' +
      (d.restored ? draftHintHTML('snDraft') : '') +
      '<textarea id="snTxt" placeholder="寫下你對這一段的理解…"></textarea>' +
      '<div class="btns">' +
      (old.h ? '<span class="btn ghost" id="snDel">刪除</span>' : '') +
      '<span class="btn" id="snCancel">取消</span>' +
      '<span class="btn pri" id="snSave">儲存</span></div>' +
      '</div>';
    mountSheet(mask);
    var ta = mask.querySelector('#snTxt');
    ta.value = d.text;
    ta.focus();

    if (d.restored) {
      var dis = mask.querySelector('#snDraftDiscard');
      if (dis) dis.onclick = function () {
        clearDraft('seg', k, b);
        ta.value = saved;
        var h = mask.querySelector('#snDraftHint');
        if (h) h.remove();
        toast('已捨棄草稿');
      };
    }
    ta.addEventListener('input', function () {
      if (ta.value === saved) clearDraft('seg', k, b);
      else putDraft('seg', k, b, {
        h: ta.value, x: excerpt || '', fp: fpv || '', ts: Date.now()
      });
    });

    function close() { mask.remove(); }
    mask.addEventListener('click', function (ev) {
      if (ev.target === mask || ev.target.hasAttribute('data-close')) close();
    });
    mask.querySelector('#snCancel').onclick = close;
    var del = mask.querySelector('#snDel');
    if (del) del.onclick = function () {
      setSegNote(k, b, '');
      close();
      if (onDone) onDone(false);
      toast('已刪除');
    };
    mask.querySelector('#snSave').onclick = function () {
      var v = ta.value.trim();
      setSegNote(k, b, v, excerpt, fpv);
      close();
      if (onDone) onDone(!!v);
      toast(v ? '已儲存' : '已清空');
    };
  }

  function nameOf(k) {
    var lf = AR.S.leaf[k];
    return lf ? lf.n : k;
  }

  /* 渲染一段正文：注标与高亮区间在同一段文字里交错。
   * 关键：高亮按「原文偏移」存（s..e），注标也在原文偏移上，
   * 两者用同一套坐标，所以可以互相切割、嵌套。
   * e = -1 表示到段尾（旧数据整段高亮）。
   */
  /* 校勘记号的显示处理：数据一个字都不动，只在渲染时换记号
   *   [字]  → 校勘补入，虚线
   *   {字}  → 底本字，删除线
   * 为了不破坏注标锚点，顺手生成「原位置 → 新位置」对照表，
   * 后面的注标与高亮都按新位置落。
   */
  function markBrackets(t) {
    var m = new Array(t.length + 1), s = '';
    for (var i = 0; i < t.length; i++) {
      m[i] = s.length;
      var ch = t.charAt(i);
      if (ch === '[') { s += '<span class="coll">'; continue; }
      if (ch === ']') { s += '</span>'; continue; }
      if (ch === '{') { s += '<span class="del">'; continue; }
      if (ch === '}') { s += '</span>'; continue; }
      s += esc(ch);
    }
    m[t.length] = s.length;
    return { html: s, map: m };
  }

  /* 统一的行内分层渲染。
   * 输入：原文 text + 若干层（每层有 items:[{s,e,...}]、一个 class、可选的属性函数）。
   * 做法：原文先转义并把校勘括号变成 span（同时记下「原位置 → 新位置」），
   *       所有层映射到新坐标后取并集边界切成小段，每段按由内到外的顺序套 span。
   * 好处：再加一层只需多传一个 layer，不用再考虑跟其它三层的交叉。
   */
  function renderLayers(text, layers) {
    var B = markBrackets(text);
    var T = B.html, MP = B.map;
    function at(i) { return MP[Math.max(0, Math.min(i, text.length))]; }

    var L = (layers || []).map(function (ly) {
      var rs = (ly.items || []).map(function (it) {
        var e = (it.e == null || it.e < 0) ? text.length : it.e;
        return { s: at(it.s), e: at(e), it: it };
      }).filter(function (r) { return r.e > r.s; })
        .sort(function (a, b) { return a.s - b.s; });
      return { cls: ly.cls, attr: ly.attr, rs: rs };
    });

    var seen = {}, pts = [];
    function cut(p) { if (!seen[p]) { seen[p] = 1; pts.push(p); } }
    cut(0); cut(T.length);
    L.forEach(function (ly) {
      ly.rs.forEach(function (r) { cut(r.s); cut(r.e); });
    });
    pts.sort(function (a, b) { return a - b; });

    var out = '';
    for (var i = 0; i < pts.length - 1; i++) {
      var a = pts[i], b = pts[i + 1];
      if (b <= a) continue;
      var seg = T.slice(a, b);
      // 数组顺序＝由内到外
      L.forEach(function (ly) {
        var hit = null;
        for (var k = 0; k < ly.rs.length; k++) {
          var r = ly.rs[k];
          if (a >= r.s && b <= r.e) { hit = r; break; }
        }
        if (!hit) return;
        var cls = typeof ly.cls === 'function' ? ly.cls(hit.it) : ly.cls;
        var attr = ly.attr ? ly.attr(hit.it) : '';
        seg = '<span class="' + cls + '"' + attr + '>' + seg + '</span>';
      });
      out += seg;
    }
    return out;
  }

  /* 四层：高亮（内）→ 莊注标 → 用户注释（外） */
  function withMarks(t, marks, ranges, uas, blockNo) {
    return renderLayers(t, [
      {
        cls: 'hlr',
        attr: function (it) {
          return ' data-hlb="' + blockNo + '" data-hls="' + it.s0 + '" data-hle="' + it.e0 + '"';
        },
        items: (ranges || []).map(function (r) {
          return { s: r.s, e: r.e, s0: r.s, e0: r.e == null ? -1 : r.e };
        })
      },
      {
        cls: function (it) { return 'anno mark ' + (it.k === 'l' ? 'l' : 'n'); },
        attr: function (it) { return ' data-mi="' + it.g + '"'; },
        items: (marks || []).map(function (m) {
          return { s: m.o, e: m.o + (m.n || 0), g: m.g, k: m.k };
        })
      },
      {
        cls: 'anno ua',
        attr: function (it) { return ' data-ua="' + it.ts + '"'; },
        items: (uas || []).map(function (u) { return { s: u.s, e: u.e, ts: u.ts }; })
      }
    ]);
  }

  /* 注标点击由阅读页的统一委托器处理（见 bindParaOps） */
  function bindMarks(notes) { }

  function showNote(m) {
    var mask = document.createElement('div');
    mask.className = 'sheet-mask';
    mask.innerHTML = '<div class="sheet"><div class="hd">' +
      '<span class="t">' + (m.k === 'l' ? '註' : '詞釋') + '</span>' +
      '<span class="x" data-close>×</span></div>' +
      '<div class="b"><div class="who">莊春江</div>' + String(m.h).split('\n').map(function (l) {
        return l ? '<p>' + linkifyRefs(esc(l)) + '</p>' : '';
      }).join('') +
      '</div></div>';
    mountSheet(mask);
    var close = function () { mask.remove(); };
    mask.addEventListener('click', function (ev) {
      if (ev.target === mask || ev.target.hasAttribute('data-close')) { close(); return; }
      // 点经号引用：先收弹层，再走链接
      var a = ev.target.closest('a.ref');
      if (a) close();
    });
  }

  function postSection(k) {
    var p = getPost(k);
    var inner;
    if (p && p.h) {
      inner = '<div class="card">' + esc(p.h) + '</div>' +
        '<div class="ts">' + (p.updated !== p.created ? '最後修改 ' : '寫於 ') +
        esc(fmtTs(p.updated)) + '</div>';
    } else {
      inner = '<div class="empty" id="postNew">讀完這一經，有什麼想法？<br>' +
        '<b>點此寫下經後筆記</b>　只存在本機，不會上傳。</div>';
    }
    return '<div class="post"><div class="hd"><span>經後筆記</span>' +
      (p && p.h ? '<span class="edit" id="postEdit">編輯</span>' : '') +
      '</div><div id="postBox">' + inner + '</div></div>';
  }

  function bindPost(k) {
    var box = document.getElementById('postBox');
    if (!box) return;

    function edit() {
      var p = getPost(k) || { h: '' };
      var saved = p.h || '';
      var d = draftFor('post', k, null, saved, p.updated);
      box.innerHTML = AR.conv(
        (d.restored ? draftHintHTML('postDraft') : '') +
        '<textarea id="postTxt" placeholder="寫下你的感悟，或記下想再查的地方…"></textarea>' +
        '<div class="btns">' +
        (p.h ? '<span class="btn ghost" id="postDel">刪除</span>' : '') +
        '<span class="btn" id="postCancel">取消</span>' +
        '<span class="btn pri" id="postSave">儲存</span></div>');
      var t = document.getElementById('postTxt');
      t.value = d.text;
      t.focus();
      if (d.restored) {
        var dis = document.getElementById('postDraftDiscard');
        if (dis) dis.onclick = function () {
          clearDraft('post', k, null);
          t.value = saved;
          var h = document.getElementById('postDraftHint');
          if (h) h.remove();
          toast('已捨棄草稿');
        };
      }
      t.addEventListener('input', function () {
        if (t.value === saved) clearDraft('post', k, null);
        else putDraft('post', k, null, { h: t.value, ts: Date.now() });
      });
      document.getElementById('postCancel').onclick = function () {
        box.innerHTML = AR.conv(postInner(k));
        bindPost(k);
      };
      var del = document.getElementById('postDel');
      if (del) del.onclick = function () {
        delPost(k);
        box.innerHTML = AR.conv(postInner(k));
        bindPost(k);
        toast('已刪除');
      };
      document.getElementById('postSave').onclick = function () {
        var v = t.value.trim();
        if (!v) { toast('內容為空'); return; }
        savePost(k, v);
        box.innerHTML = AR.conv(postInner(k));
        bindPost(k);
        toast('已儲存');
      };
    }

    var nw = document.getElementById('postNew');
    if (nw) nw.onclick = edit;
    var ed = document.getElementById('postEdit');
    if (ed) ed.onclick = edit;
  }

  function postInner(k) {
    var p = getPost(k);
    if (p && p.h) {
      return '<div class="card">' + esc(p.h) + '</div>' +
        '<div class="ts">' + (p.updated !== p.created ? '最後修改 ' : '寫於 ') +
        esc(fmtTs(p.updated)) + '</div>';
    }
    return '<div class="empty" id="postNew">讀完這一經，有什麼想法？<br>' +
      '<b>點此寫下經後筆記</b>　只存在本機，不會上傳。</div>';
  }

  function doQuote(e, blocks) {
    // 引用也跟随阅读界面的繁简设置：简体用户拿到简体，繁体用户保留原文
    var txt = AR.conv(AR.quote(e, blocks));
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(function () { toast('經文已複製'); },
        function () { toast('複製失敗'); });
    } else {
      var ta = document.createElement('textarea');
      ta.value = txt;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast('經文已複製'); } catch (x) { toast('複製失敗'); }
      ta.remove();
    }
  }

  /* ---------- 搜索 ---------- */

  var SEARCH_SCOPES = [
    { v: 'all', label: '全部欄目' },
    { v: 'A', label: '北傳阿含', group: true },
    { v: 'SA', label: '雜阿含', sub: true },
    { v: 'MA', label: '中阿含', sub: true },
    { v: 'DA', label: '長阿含', sub: true },
    { v: 'AA', label: '增壹阿含', sub: true },
    { v: 'ZA', label: '別譯雜阿含', sub: true },
    { v: 'B', label: '南傳尼柯耶', group: true },
    { v: 'SN', label: '相應部', sub: true },
    { v: 'MN', label: '中部', sub: true },
    { v: 'DN', label: '長部', sub: true },
    { v: 'AN', label: '增支部', sub: true },
    { v: 'C', label: '小部' }
  ];

  function searchScopeLabel(s) {
    for (var i = 0; i < SEARCH_SCOPES.length; i++) {
      if (SEARCH_SCOPES[i].v === s) return SEARCH_SCOPES[i].label;
    }
    return '全部欄目';
  }

  function searchScopeIds(s) {
    if (s === 'all') return null;
    if (s === 'A' || s === 'B' || s === 'C') {
      var g = AR.groupList(s);
      return g ? g.c.map(function (b) { return b.id; }) : [];
    }
    return [s];
  }

  function viewSearch(q) {
    q = q || '';
    var sm = location.hash.match(/[?&]series=([^&]+)/);
    var scope = sm ? decodeURIComponent(sm[1]) : 'all';
    // 小部的具体集（如 Dh）在筛选里统一归到「小部」
    if (scope !== 'all' && groupOfSeries(scope) === 'C') scope = 'C';
    if (!SEARCH_SCOPES.some(function (x) { return x.v === scope; })) scope = 'all';
    var rngm = location.hash.match(/[?&]range=([^&]+)/);
    var range = rngm ? decodeURIComponent(rngm[1]) : 'all';
    if (range !== 'all' && !/^\d+-\d+$/.test(range)) range = 'all';
    var limm = location.hash.match(/[?&]lim=([^&]+)/);
    var limit = limm ? Math.max(80, +limm[1] || 80) : 80;

    var scopeOpts = SEARCH_SCOPES.map(function (x) {
      return '<button type="button" class="scope-item' +
        (x.group ? ' group' : '') + (x.sub ? ' sub' : '') +
        (scope === x.v ? ' on' : '') + '" data-scope="' + x.v + '">' +
        esc(x.label) + '</button>';
    }).join('');

    paint(
      bar('搜索經文', '#/') +
      '<div class="app"><div class="search-h">' +
      '<input id="q" type="search" placeholder="輸入關鍵詞，如「無常」「四聖諦」" value="' + esc(q) + '">' +
      '<div class="search-scope"><label>範圍</label>' +
      '<button type="button" class="scope-btn" id="scopeBtn">' +
      '<span id="scopeLabel">' + esc(searchScopeLabel(scope)) + '</span><i>▾</i></button>' +
      '<div class="scope-menu" id="scopeMenu">' + scopeOpts + '</div></div>' +
      '<div class="search-range" id="searchRange"></div></div>' +
      '<div id="res"></div></div>'
    );
    var input = document.getElementById('q');
    var btn = document.getElementById('scopeBtn');
    var menu = document.getElementById('scopeMenu');
    var timer = null;

    btn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      menu.classList.toggle('on');
    });

    Array.prototype.forEach.call(menu.querySelectorAll('[data-scope]'), function (el) {
      el.addEventListener('click', function (ev) {
        ev.stopPropagation();
        scope = el.getAttribute('data-scope');
        document.getElementById('scopeLabel').textContent = AR.conv(searchScopeLabel(scope));
        Array.prototype.forEach.call(menu.querySelectorAll('[data-scope]'), function (x) {
          x.classList.toggle('on', x.getAttribute('data-scope') === scope);
        });
        menu.classList.remove('on');
        range = 'all';
        limit = 80;
        renderRange();
        run(input.value);
      });
    });

    input.addEventListener('input', function () {
      clearTimeout(timer);
      limit = 80;
      timer = setTimeout(function () { run(input.value); }, 260);
    });
    input.addEventListener('focus', function () { menu.classList.remove('on'); });
    input.addEventListener('click', function () { menu.classList.remove('on'); });
    input.focus();
    renderRange();
    if (q) run(q); else run('');

    function scopeIds() { return searchScopeIds(scope); }

    function singleSeries() {
      return ['SA', 'MA', 'DA', 'AA', 'ZA', 'SN', 'MN', 'DN', 'AN'].indexOf(scope) >= 0;
    }

    function numOf(k) {
      var m = /(\d+(?:\.\d+)*)$/.exec(String(k || ''));
      return m ? parseFloat(m[1].split('.')[0]) : 0;
    }

    function numRanges() {
      if (!singleSeries()) return [];
      var max = 0;
      Object.keys(AR.S.leaf || {}).forEach(function (k) {
        if (k.indexOf(scope + '.') !== 0) return;
        max = Math.max(max, numOf(k));
      });
      if (max <= 300) return [];
      var out = [];
      for (var a = 1; a <= max; a += 300) out.push(a + '-' + Math.min(max, a + 299));
      return out;
    }

    function renderRange() {
      var box = document.getElementById('searchRange');
      if (!box) return;
      var rs = numRanges();
      box.innerHTML = rs.length
        ? '<label>經號</label><div class="range-opts">' +
          '<button type="button" class="range-i' + (range === 'all' ? ' on' : '') + '" data-r="all">全部</button>' +
          rs.map(function (r) {
            return '<button type="button" class="range-i' + (range === r ? ' on' : '') +
              '" data-r="' + r + '">' + r + '</button>';
          }).join('') + '</div>'
        : '';
      Array.prototype.forEach.call(box.querySelectorAll('[data-r]'), function (el) {
        el.addEventListener('click', function () {
          range = el.getAttribute('data-r');
          limit = 80;
          renderRange();
          run(input.value);
        });
      });
    }

    function inRange(k) {
      if (range === 'all') return true;
      var p = range.split('-');
      var n = numOf(k);
      return n >= +p[0] && n <= +p[1];
    }

    function run(v) {
      var res = document.getElementById('res');
      // 搜索命中的正文是繁体原文，直接塞进去会与界面不一致
      function put(html) { res.innerHTML = AR.conv(html); }
      v = (v || '').trim();
      var ids = scopeIds();
      if (!v) {
        put('<div class="search-tip">在' + esc(searchScopeLabel(scope)) + '中檢索。' +
          (scope === 'all' ? '首次檢索需載入全部經文，約需數秒。' : '') + '</div>');
        return;
      }
      if (ids) {
        var missing = ids.filter(function (s) { return !AR.S.loaded[s]; });
        if (missing.length) {
          put('<div class="search-tip">正在載入 ' + esc(searchScopeLabel(scope)) + '…</div>');
          Promise.all(ids.map(function (s) { return AR.loadSeries(s); }))
            .then(function () { run(v); });
          return;
        }
      } else if (!allLoaded()) {
        put('<div class="search-tip">正在載入全部經文…</div>');
        AR.loadAllSeries(function (done, total) {
          put('<div class="search-tip">正在載入經文 ' + done + ' / ' + total + '…</div>');
        }).then(function () { run(v); });
        return;
      }
      var hits = AR.search(v, ids ? { series: ids } : {});
      if (!hits.length) {
        put('<div class="search-tip">在' + esc(searchScopeLabel(scope)) + '中沒有找到「' + esc(v) + '」。</div>');
        return;
      }
      var filtered = hits.filter(function (x) { return inRange(x.k); });
      if (!filtered.length) {
        put('<div class="search-tip">在' + esc(searchScopeLabel(scope)) + '中，这个经号范围没有找到「' + esc(v) + '」。</div>');
        return;
      }
      var shown = filtered.slice(0, limit);
      put('<div class="search-tip">' + esc(searchScopeLabel(scope)) +
        (range === 'all' ? '' : '　經號 ' + esc(range)) +
        '　共 ' + filtered.length + ' 處' +
        (filtered.length > limit ? '（顯示前 ' + limit + ' 條）' : '') + '</div>' +
        shown.map(function (x) {
          var backQ = '?back=search&q=' + encodeURIComponent(v) +
            '&series=' + encodeURIComponent(scope) +
            '&range=' + encodeURIComponent(range) +
            '&lim=' + limit;
          return '<div class="hit" data-nav="jump" data-href="#/k/' + encodeURIComponent(x.k) + backQ + '">' +
            '<div class="n">' + esc(x.n) + '<small>' + esc(x.k) + '</small></div>' +
            '<div class="s">' + hilite(x.snip, x.q || v) + '</div></div>';
        }).join('') +
        (filtered.length > limit
          ? '<div class="search-more"><button type="button" id="moreHits">顯示更多（剩餘 ' +
            (filtered.length - limit) + ' 條）</button></div>'
          : ''));
      bindDirRows();
      searchBack = { q: v, series: scope, range: range, limit: limit, scroll: window.scrollY };
      Array.prototype.forEach.call(document.querySelectorAll('.hit[data-href]'), function (el) {
        el.addEventListener('click', function () { searchBack.scroll = window.scrollY; });
      });
      if (searchRestoreScroll != null) {
        var sy = searchRestoreScroll;
        searchRestoreScroll = null;
        setTimeout(function () { window.scrollTo(0, sy); }, 40);
      }
      var more = document.getElementById('moreHits');
      if (more) more.addEventListener('click', function () {
        limit += 80;
        run(v);
      });
    }
  }

  function allLoaded() {
    return Object.keys(AR.S.index.series).every(function (s) { return AR.S.loaded[s]; });
  }

  function hilite(s, q) {
    var e = esc(s), qe = esc(q);
    return e.split(qe).join('<em>' + qe + '</em>');
  }

  /* ---------- 巴利入口 ---------- */

  function viewPali() {
    var S = AR.S;
    var rows = '';
    S.canon.groups.forEach(function (g) {
      if (g.id === 'A') return;      // 汉译四阿含不作为巴利入口
      g.c.slice().sort(function (a, b) {
        var ia = GROUP_ORDER.indexOf(a.id), ib = GROUP_ORDER.indexOf(b.id);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      }).forEach(function (b) {
        rows += '<div class="dir-row" data-href="#/s/' + b.id + '?via=pali">' +
          '<span class="nm">' + esc(b.n) + '</span>' +
          '<span class="ct">' + suttaCountOf(b) + ' 經</span><span class="arw">›</span></div>';
      });
    });
    paint(
      bar('巴利語原文', '#/') +
      '<div class="app"><div class="search-tip">南傳五部與小部均附巴利原文，進入經文後在頁尾查看。</div>' +
      '<div class="dir-h">尼柯耶與小部</div>' + rows + '</div>'
    );
    bindDirRows();
  }

  /* ---------- 顶栏 ---------- */

  function bar(title, back, act) {
    return '<div class="bar">' +
      (back ? '<a class="back" href="' + back + '">‹</a>' : '<span class="back"></span>') +
      '<div class="ttl">' + esc(title) + '</div>' +
      '<div class="acts">' + (act || '') + '</div>' +
      '</div>';
  }

  /* ---------- 更新日志 ---------- */

  function viewChangelog() {
    paint(
      bar('更新日誌', '#/updates') +
      '<div class="app lic">' +
      '<h2>更新日誌</h2>' +
      '<p class="dim">只列用戶可見的變動；安裝包與資源包見「獲取更新及資源包」。</p>' +

      // 新版本加在最上面，并把 open 移到最新一版；旧版默认收起。
      '<details class="clog" open>' +
      '<summary><span class="clog-v">1.0.3</span></summary>' +
      '<ul>' +
      '<li>左右翻頁進下一經不再多出空白頁；切換翻頁模式後橫滑不會同時跳經；字號、行距改變會重算頁數。</li>' +
      '<li>閱讀頁頂部固定顯示經號（左上角，翻頁時每一頁都在）。</li>' +
      '<li>對讀修正：SN.35.90 改配 SA.227；SA.277 只保留 SN.35.97 / SN.35.98。</li>' +
      '<li>內置字體補上擴展 B 生僻字、巴利變音與箭頭符號；常用字子集一併重建。</li>' +
      '<li>閱讀歷史只保留最近 30 天；完整備份把歷史放在最後。</li>' +
      '<li>今日一句最多佔原來三行的高度：先降字號，再收行距。</li>' +
      '<li>筆記草稿自動保存：切走、重開、重載都不丟；保存或刪除段後筆記立即更新。</li>' +
      '<li>深色模式下搜索命中詞改柔和，夜裡不刺眼。</li>' +
      '<li>軟件內更新日誌補上 1.0.2 並按版本折疊；昭同修網站改為 gujiduizhao.com/AGAMA。</li>' +
      '</ul>' +
      '</details>' +

      '<details class="clog">' +
      '<summary><span class="clog-v">1.0.2</span></summary>' +
      '<ul>' +
      '<li>深色模式下「剛才讀的是這一經」的高亮更明顯：仍是 1px 細框，另加淡底色與經號換色。</li>' +
      '<li>回到目錄時一定把那一格滾進螢幕：相應很長的部（如諸天相應）不再停在段首、把高亮甩在螢幕外；順帶修掉字型載入稍晚時定位「差一點」的問題。</li>' +
      '<li>「相應」選擇清單打開時自動停在目前所在相應，並高亮該列。</li>' +
      '<li>深色模式下的高亮（整段或字詞）不再用淺色米黃底，換成低飽和琥珀，夜裡讀不刺眼。</li>' +
      '<li>修正巴利直譯把正常段落的漢譯誤判成「原文此處為縮略語」而藏起來的問題（實測影響 100 多段，含「如是我聞」開頭與「第九」這類序數標題）。</li>' +
      '<li>巴利原文真正只是 Dutiyapeyyālo. 一類縮略語的 4 段，漢譯照常顯示，末尾加一句說明。</li>' +
      '<li>完整備份恢復補上「別人給的註釋套」：換機／重裝匯入後不再遺失。</li>' +
      '<li>修復匯入備份後所有經文都打不開的問題（備份裡的歷史記錄形狀不對會弄壞閱讀頁）。</li>' +
      '</ul>' +
      '</details>' +

      '<details class="clog">' +
      '<summary><span class="clog-v">1.0.1</span></summary>' +
      '<ul>' +
      '<li>巴利語卡片：修正首行縮進，經號標題移到 AI 直譯說明下方；巴利入口的漢譯卡片可收起。</li>' +
      '<li>修復「跟隨系統」深色／淺色主題不生效。</li>' +
      '<li>閱讀頁上一經／下一經改按經號自然順序；到本部最後一經提示「已到本部經的最後一經」。</li>' +
      '<li>從閱讀頁回到目錄時，剛才閱讀的經號保持高亮。</li>' +
      '<li>修正部分段落以「；」「，」等標點開頭的問題。</li>' +
      '<li>閱讀頁默認隱藏狀態欄，退出恢復；頂部下滑可臨時調出。</li>' +
      '<li>譯文段落增加右側留白。</li>' +
      '<li>搜索結果超過 80 條時可「顯示更多」；單部檢索增加經號範圍篩選。</li>' +
      '<li>註釋／詞釋彈層不再顯示經文校勘說明。</li>' +
      '<li>從設置返回首頁時保持原滾動位置；閱讀頁仍從頂部開始。</li>' +
      '</ul>' +
      '</details>' +

      '<details class="clog">' +
      '<summary><span class="clog-v">1.0.0</span></summary>' +
      '<ul>' +
      '<li>首個公開源碼版本；相應部巴利逐段直譯、南北傳對讀、筆記/高亮/收藏、離線全文搜索。</li>' +
      '</ul>' +
      '</details>' +
      '</div>'
    );
    document.title = AR.conv('更新日誌 · 掌上阿含');
  }

  /* ---------- 获取更新及资源包 ---------- */

  function viewUpdates() {
    paint(
      bar('獲取更新及資源包', '#/') +
      '<div class="app lic">' +
      '<h2>獲取更新及資源包</h2>' +
      '<p>本應用是離線閱讀器，<b>不會自動聯網檢查更新</b>。請複製下面的網址，在瀏覽器中打開：</p>' +

      '<div class="upd-box">' +
      '<div class="upd-lab">專案倉庫</div>' +
      '<div class="upd-url" id="repoUrl">https://github.com/Yoshikichi99/agama-reader-public</div>' +
      '<span class="upd-copy" id="copyRepo">複製倉庫網址</span>' +
      '</div>' +

      '<div class="upd-box">' +
      '<div class="upd-lab">更新與資源包（Releases）</div>' +
      '<div class="upd-url" id="relUrl">https://github.com/Yoshikichi99/agama-reader-public/releases</div>' +
      '<span class="upd-copy" id="copyRel">複製 Releases 網址</span>' +
      '</div>' +

      '<p>安裝包、翻譯包、巴利直譯包和更新說明會放在 Releases。下載後：</p>' +
      '<ul>' +
      '<li>APK：直接安裝；簽名不同時需先匯出資料、卸載舊版，再裝新版並匯入；</li>' +
      '<li>翻譯包／筆記包：用「設定 → 我的資料 → 匯入資料」選擇檔案；</li>' +
      '<li>更新前建議先匯出一份完整備份。</li>' +
      '</ul>' +

      '<p class="dim">本應用離線，不會自動打開這個網址，也不會在背景檢查更新。' +
      '若連結暫時無法打開，表示倉庫尚未公開或網路不可達；可稍後再試。</p>' +
      '<p><a class="upd-copy" href="#/changelog">查看更新日誌</a></p>' +
      '</div>'
    );
    document.title = AR.conv('獲取更新及資源包 · 掌上阿含');
    var cr = document.getElementById('copyRepo');
    if (cr) cr.addEventListener('click', function () {
      copyText('https://github.com/Yoshikichi99/agama-reader-public', '已複製倉庫網址');
    });
    var cl = document.getElementById('copyRel');
    if (cl) cl.addEventListener('click', function () {
      copyText('https://github.com/Yoshikichi99/agama-reader-public/releases', '已複製 Releases 網址');
    });
  }

  /* ---------- 使用协议 ---------- */

  function viewTerms() {
    paint(
      bar('使用協議', '#/') +
      '<div class="app lic terms">' +
      '<h2>使用協議</h2>' +
      '<p class="dim">版本 1.0　·　2026-11-15</p>' +
      '<p>歡迎使用「掌上阿含」離線閱讀器（以下簡稱「本應用」）。使用本應用即表示你已閱讀、理解並同意本協議；如不同意，請停止使用並卸載。</p>' +
      '<p>本應用由專案維護者獨立製作，不是莊春江工作站、出版社或任何機構的官方產品。未滿 18 歲的使用者，請在法定監護人陪同下閱讀本協議。</p>' +

      '<h2>一、服務說明</h2>' +
      '<p>本應用是<strong>離線閱讀器</strong>：經文、註釋、巴利原文和翻譯包隨安裝包提供，不依賴網路。不提供帳號註冊、登入、雲端同步、線上支付、廣告或內容推送。</p>' +
      '<p>主要功能：經文閱讀、目錄與搜尋、筆記、高亮、收藏、瀏覽歷史、巴利對讀、巴利直譯、資料匯出／匯入。功能可能隨版本調整，重大變化會在更新說明中註明。</p>' +

      '<h2>二、內容與授權</h2>' +
      '<table class="lict">' +
      '<tr><th>程式</th><td><b>AGPL-3.0</b><br><span class="dim">前端、Android 殼、建置與資料腳本</span></td></tr>' +
      '<tr><th>經文・註釋・巴利原文</th><td><b>CC BY-NC-SA 4.0</b><br><span class="dim">莊春江，家屬授權開放分享</span></td></tr>' +
      '<tr><th>翻譯包</th><td><b>CC BY-NC-SA 4.0</b><br><span class="dim">古今對譯、巴利直譯由昭 同修提供</span></td></tr>' +
      '<tr><th>專案文檔</th><td><b>CC BY 4.0</b></td></tr>' +
      '<tr><th>圖片／字型</th><td>各依原作者許可；字型 <b>SIL OFL 1.1</b></td></tr>' +
      '</table>' +
      '<p>使用經文、註釋、翻譯包時，不得刪除作者、出處和授權標識；不得用於商業目的；衍生作品須以相同條款分享。程式碼的 AGPL 許可另有規定。</p>' +
      '<p><b>巴利直譯聲明：</b>相應部巴利逐段直譯由人工智慧批量處理，未經逐句人工校對，<b>不保證準確，僅供參考</b>。如有更可靠的對譯本，歡迎聯繫維護者。</p>' +
      '<p>你自己寫的筆記、高亮、標籤和經後筆記，著作權屬於你；本應用不主張權利，也不代你授權。匯出筆記包時，包內的經文摘錄仍受 CC BY-NC-SA 4.0 約束。</p>' +

      '<h2>三、使用者行為</h2>' +
      '<ul>' +
      '<li>僅將本應用用於合法目的，不從事違法、侵權、騷擾、欺詐或傷害他人的行為；</li>' +
      '<li>不刪除、遮蔽或偽造內容中的作者、出處、版權和授權標識；</li>' +
      '<li>不將經論內容用於商業銷售、付費分發或其他營利用途；</li>' +
      '<li>不冒充本應用維護者、莊春江家屬或任何相關機構；</li>' +
      '<li>不傳播惡意程式、垃圾資訊，或干擾他人設備與網路；</li>' +
      '<li>對自己寫入的筆記、註釋、匯入的第三方內容和匯出檔案負責。</li>' +
      '</ul>' +

      '<h2>四、隱私與資料</h2>' +
      '<p>本應用<strong>不聯網、不收集、不上傳</strong>任何個人資訊，也不申請網路權限。筆記、高亮、收藏、瀏覽歷史、閱讀偏好只保存在本機 localStorage。</p>' +
      '<p>卸載本應用或清除應用資料，會刪除上述本機資料；請在卸載／換機前自行匯出備份。匯入／匯出使用系統檔案選擇器（SAF），應用只讀取你明確選擇的檔案。</p>' +
      '<p>如你匯入他人提供的筆記包或翻譯包，其內容與授權由提供者負責；請自行確認來源與許可。</p>' +

      '<h2>五、免責聲明</h2>' +
      '<p>本應用按「現狀」提供。維護者不保證內容完整、準確、適用於你的特定目的，也不保證應用永不出錯。經文、註釋、譯文和 AI 巴利直譯可能存在錯漏；涉及修行、醫療、法律或其他重要決定時，請以權威文本、善知識或專業人士的意見為準。</p>' +
      '<p>在法律允許的範圍內，維護者不對因使用或無法使用本應用造成的間接損失、資料遺失、設備故障或誤操作承擔責任。請自行備份本機資料。</p>' +

      '<h2>六、協議變更與終止</h2>' +
      '<p>維護者可能隨版本更新修訂本協議；更新後會在應用內或發布說明中註明版本。繼續使用即視為接受更新後的條款；如不接受，請停止使用並卸載。</p>' +
      '<p>你可以隨時停止使用本應用。卸載後本協議終止，但已產生的授權義務（如 CC BY-NC-SA 的署名、非商業、相同方式分享）仍然有效。</p>' +

      '<h2>七、第三方連結與內容</h2>' +
      '<p>本應用可能展示第三方網站地址（如「古籍對照」），僅作資訊提供；本應用離線，不會自動開啟外鏈。第三方網站的內容、可用性和隱私做法由該第三方負責。</p>' +
      '<p>本應用收錄的圖片、字型等第三方素材，按各自許可提供；詳見<a href="#/license">授權與致謝</a>。</p>' +

      '<h2>八、其他</h2>' +
      '<p>本協議中的標題僅為閱讀方便，不影響條款解釋。部分條款被認定無效或不可執行的，不影響其餘條款的效力。</p>' +
      '<p>如對本協議有疑問，或發現內容、程式錯誤，請聯繫：<b>Zhuran_77@foxmail.com</b>。</p>' +
      '<p class="dim">本協議是專案維護者為離線閱讀器編寫的使用約定，不構成法律意見。如你所在地區的法律有強制性規定，以該等法律規定為準。</p>' +
      '</div>'
    );
    document.title = AR.conv('使用協議 · 掌上阿含');
  }

  /* ---------- 授权与致谢 ---------- */

  function viewLicense() {
    paint(
      bar('授權與致謝', '#/') +
      '<div class="app lic">' +
      '<h2>內容</h2>' +
      '<p>經文、譯文、註釋與巴利原文，均由 <b>莊春江</b> 老師翻譯、整理與著述；' +
      '老師於 2025 年離世後，家屬決議以創用 CC 授權開放分享。</p>' +
      '<table class="lict">' +
      '<tr><th>作者</th><td>莊春江（家屬授權開放分享）</td></tr>' +
      '<tr><th>來源</th><td>莊春江工作站（agama.buddhason.org），已停更</td></tr>' +
      '<tr><th>授權</th><td><b>CC BY-NC-SA 4.0</b><br>' +
      '<span class="dim">可自由複製、改作、再散布；須標示作者與來源，不得商業使用，衍生作品同條款。</span></td></tr>' +
      '</table>' +

      '<h2>巴利直譯聲明</h2>' +
      '<p>相應部的巴利逐段直譯由 <b>昭 同修</b> 提供，經 <b>人工智能批量處理</b>，' +
      '未經逐句人工校對，<b>不保證準確</b>，僅供閱讀參考。若發現明顯錯誤，歡迎指出；' +
      '如有同修願意提供質量更可靠的對譯本，也歡迎來信（見下方「聯絡」）。</p>' +
      '<p class="dim">直譯文字與巴利原文的段落對齊也由程式自動處理，' +
      '少數長段可能出現句意錯位；遇到請以經文原文與莊春江譯文為準。</p>' +

      '<h2>分層授權</h2>' +
      '<p>這個程式裡不同層的東西授權不同，分開標示，不混為一談：</p>' +
      '<table class="lict">' +
      '<tr><th>程式碼</th><td><b>AGPL-3.0</b><br><span class="dim">前端、Android 殼、建置與資料加工腳本。' +
      '可自由使用、修改、再分發；但分發修改版須同樣以 AGPL-3.0 開源，並提供完整源碼</span></td></tr>' +
      '<tr><th>文檔</th><td><b>CC BY 4.0</b><br><span class="dim">專案裡的說明文件——設計稿、資料結構、' +
      '更新日誌這類文字。<b>不是</b>程式檔案，也不是資料</span></td></tr>' +
      '<tr><th>資料</th><td><b>CC BY-NC-SA 4.0</b><br><span class="dim">資料庫六張表由經文派生，' +
      '隨內容走，不因加工而換授權</span></td></tr>' +
      '<tr><th>圖片</th><td>各依原作者許可（見下）</td></tr>' +
      '<tr><th>字型</th><td><b>SIL OFL 1.1</b></td></tr>' +
      '<tr><th>經文內容</th><td><b>CC BY-NC-SA 4.0</b>（不可放寬）</td></tr>' +
      '<tr><th>翻譯包</th><td>相應部巴利直譯與古今對譯包由 <b>昭 同修</b> 提供（AI 批量處理），' +
      '同以 <b>CC BY-NC-SA 4.0</b> 約束；<b>不保證準確，僅供參考</b></td></tr>' +
      '</table>' +
      '<p class="dim">AGPL-3.0 只管程式，<b>不覆蓋經文</b>；' +
      '經文的「非商業性」由原作者設定，本項目無權放寬。</p>' +
      '<p class="dim"><b>你自己寫的筆記、劃線與標籤不屬於上表任何一層。</b>' +
      '著作權在你，本程式不對它施加任何條款，也不代你授權；' +
      '導出筆記包時可自行決定要不要聲明分享授權，預設為「不指定」。' +
      '包內若有經文摘錄，該部分才受 CC BY-NC-SA 4.0 約束。</p>' +

      '<h2>圖片</h2>' +
      '<table class="lict">' +
      '<tr><th>嵐山竹林</th><td>Naokijp　<b>CC BY-SA 4.0</b></td></tr>' +
      '<tr><th>霧中山林</th><td>jesse orrico　<b>CC0</b></td></tr>' +
      '<tr><th>雲海覆林</th><td>David Zhang　<b>CC BY-SA 2.0</b></td></tr>' +
      '<tr><th>晨霧湖林</th><td>Anne LaBastille / NARA　<b>Public domain</b></td></tr>' +
      '<tr><th>熱帶霧山</th><td>Timothy A. Gonsalves　<b>CC BY-SA 4.0</b></td></tr>' +
      '<tr><th>雲海長卷</th><td>David Zhang　<b>CC BY-SA 2.0</b></td></tr>' +
      '<tr><th>雲山晨光</th><td>David Zhang　<b>CC BY-SA 2.0</b></td></tr>' +
      '</table>' +
      '<p class="dim">七張均經裁切與壓縮，屬改作；改作版本同以原條款提供。' +
      '圖片與經文內容並列分發，各自適用其原許可。</p>' +

      '<h2>字型</h2>' +
      '<p>Noto Serif SC（Google / notofonts），<b>SIL Open Font License 1.1</b>。' +
      '依本程式實際用字裁切為子集（兩個字重，各約 1.3 MB），裁切屬改作，OFL 允許並要求隨附許可全文。' +
      '另用 HanaMinA/B（GlyphWiki Project）與 Noto Sans Math（Noto Project）' +
      '為擴展 B、巴利變音與箭頭等缺字補了三個小字集（合共約 28 KB），三者都是 <b>OFL 1.1</b>。</p>' +
      '<details class="ofl"><summary>Noto 字型授權全文（SIL OFL 1.1）</summary>' +
      '<pre id="oflText">載入中…</pre></details>' +
      '<details class="ofl"><summary>HanaMin 字型授權全文（SIL OFL 1.1）</summary>' +
      '<pre id="oflText2">載入中…</pre></details>' +
      '<details class="ofl"><summary>Noto Sans Math 字型授權全文（SIL OFL 1.1）</summary>' +
      '<pre id="oflText3">載入中…</pre></details>' +

      '<h2>本離線版對內容做了什麼</h2>' +
      '<ul>' +
      '<li>把經文與註釋從莊春江工作站的 HTML 拆分為結構化資料：段、偈、注標、錨點；</li>' +
      '<li>註釋抽成可替換的獨立層，使用者自己的筆記與註釋包同一格式；</li>' +
      '<li>補了別譯雜阿含 362 經的頁面（工作站只有目錄項、沒有頁面）；</li>' +
      '<li>提供繁→簡的執行期轉換，只保存繁體原文；</li>' +
      '<li>收錄範圍為經文與註釋，<b>不含</b>莊春江工作站的論述性著作與站點功能頁。</li>' +
      '</ul>' +
      '<p class="dim">不涉及文字內容的刪改；文字以莊春江工作站的版本為準。</p>' +

      '<h2>致謝</h2>' +
      '<p>本程式是 <b>獨立作品</b>：除下列素材外，經文內容取自莊春江工作站，' +
      '程式與排版為本項目自寫。</p>' +
      '<table class="lict">' +
      '<tr><th>內容</th><td>莊春江工作站　經文、譯文、註釋、巴利原文</td></tr>' +
      '<tr><th>翻譯包</th><td>昭 同修　古今對譯、巴利直譯　<b>CC BY-NC-SA 4.0</b></td></tr>' +
      '<tr><th>圖片</th><td>Wikimedia Commons 諸位作者（見上）</td></tr>' +
      '<tr><th>字型</th><td>Noto Serif SC　Google / notofonts；HanaMin 擴展字　GlyphWiki Project；Noto Sans Math　Noto Project（OFL 1.1）</td></tr>' +
      '</table>' +
      '<p class="dim">程式源碼以 AGPL-3.0 提供，隨發佈一併附上（AGPL 第 6 條的要求）。' +
      '翻譯包由昭 同修提供，以 CC BY-NC-SA 4.0 約束；引用時請保留署名與出處。</p>' +

      '<h2>同修網站</h2>' +
      '<p>昭 同修 另製作佛經線上閱讀網站「古籍對照」，歡迎在瀏覽器打開：</p>' +
      '<p><b>https://gujiduizhao.com/AGAMA</b>　<span class="ref" id="copySite">複製網址</span></p>' +
      '<p class="dim">本程式離線，不直接聯網；請複製網址到瀏覽器。</p>' +

      '<h2>聯絡</h2>' +
      '<p>若認為內容侵權，或發現內容、程式錯誤，請來信：<b>Zhuran_77@foxmail.com</b>，核實後即修正或移除。</p>' +
      '<p class="tip">本程式由讀者自行製作，與內容作者及家屬無隸屬或背書關係。' +
      '程式不聯網、不申請任何權限，筆記只存在本機。</p>' +
      '</div>'
    );
    document.title = AR.conv('授權與致謝 · 掌上阿含');
    var cp = document.getElementById('copySite');
    if (cp) cp.addEventListener('click', function () {
      copyText('https://gujiduizhao.com/AGAMA', '已複製網址');
    });
    loadOFL('oflText', 'assets/OFL.txt');
    loadOFL('oflText2', 'assets/OFL-HanaMin.txt');
    loadOFL('oflText3', 'assets/OFL-NotoSansMath.txt');
  }

  function loadOFL(id, path) {
    var pre = document.getElementById(id);
    if (!pre) return;
    fetch(path).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.text();
    }).then(function (t) {
      pre.textContent = t;
    }).catch(function () {
      pre.textContent = '（許可全文讀取失敗，請見發佈包內的 ' + path + '）';
    });
  }

  /* ---------- 我的笔记 / 划线 / 收藏 ---------- */

  var notesState = { manage: false, sel: {}, folder: 'all' };
  var hlState = { manage: false, sel: {}, folder: 'all' };
  var favState = { manage: false, sel: {}, folder: 'all' };
  var manageBlockClick = 0;

  function folderLabel(type, id) {
    if (id === 'all') return '全部';
    if (id === 'root') return '未分類';
    return folderPath(type, id) || '未分類';
  }
  function folderBarHTML(type, state) {
    return '<div class="foldbar"><span class="fb-name">' + esc(folderLabel(type, state.folder)) +
      '</span><span class="fb-pick" id="fbPick">文件夾 ›</span></div>';
  }
  function bindFolderBar(type, state, view) {
    var b = document.getElementById('fbPick');
    if (b) b.addEventListener('click', function () {
      showFolderSheet(type, state, view, false);
    });
  }

  function folderRowsHTML(type, forMove) {
    var out = '';
    if (!forMove) out += '<button class="fold-row" data-fid="all">全部</button>';
    out += '<button class="fold-row" data-fid="root">未分類</button>';
    function walk(parent, depth) {
      folderChildren(type, parent).forEach(function (f) {
        out += '<button class="fold-row" data-fid="' + esc(f.id) + '" style="padding-left:' +
          (14 + depth * 18) + 'px">' + esc(f.name) + '</button>';
        walk(f.id, depth + 1);
      });
    }
    walk('', 0);
    return out;
  }

  function showFolderSheet(type, state, view, forMove) {
    var mask = document.createElement('div');
    mask.className = 'sheet-mask';
    mask.innerHTML = '<div class="sheet"><div class="hd"><span class="t">' +
      (forMove ? '移動到文件夾' : '文件夾') + '</span><span class="x" data-close>×</span></div>' +
      '<div class="b"><div class="fold-list">' + folderRowsHTML(type, forMove) + '</div>' +
      '<div class="btns">' + (forMove ? '' : '<span class="btn" id="foldNew">新建文件夾</span>' +
        '<span class="btn" id="foldManage">管理文件夾</span>') +
      '<span class="btn ghost" data-close>取消</span></div></div></div>';
    mountSheet(mask);
    mask.addEventListener('click', function (ev) {
      if (ev.target === mask || ev.target.hasAttribute('data-close')) mask.remove();
    });
    Array.prototype.forEach.call(mask.querySelectorAll('[data-fid]'), function (el) {
      el.addEventListener('click', function () {
        var id = el.getAttribute('data-fid');
        if (forMove) {
          var keys = state.__moveKeys || [];
          keys.forEach(function (k) { setItemFolder(type, k, id === 'root' ? '' : id); });
          state.manage = false;
          state.sel = {};
          mask.remove();
          view();
          toast('已移動 ' + keys.length + ' 條');
        } else {
          state.folder = id;
          mask.remove();
          view();
        }
      });
    });
    var n = mask.querySelector('#foldNew');
    if (n) n.addEventListener('click', function () { mask.remove(); showFolderCreate(type, state, view); });
    var m = mask.querySelector('#foldManage');
    if (m) m.addEventListener('click', function () { mask.remove(); showFolderManage(type, state, view); });
  }

  function showFolderCreate(type, state, view, parent) {
    var mask = document.createElement('div');
    mask.className = 'sheet-mask';
    var parentOpts = '<option value="">（根目錄）</option>';
    function walk(p, depth) {
      folderChildren(type, p).forEach(function (f) {
        parentOpts += '<option value="' + esc(f.id) + '">' + esc('　'.repeat(depth) + f.name) + '</option>';
        walk(f.id, depth + 1);
      });
    }
    walk('', 0);
    mask.innerHTML = '<div class="sheet"><div class="hd"><span class="t">新建文件夾</span>' +
      '<span class="x" data-close>×</span></div><div class="b">' +
      '<input id="foldName" type="text" placeholder="文件夾名稱" autocomplete="off">' +
      '<p class="dim">上級文件夾</p><select id="foldParent" class="fold-select">' + parentOpts + '</select>' +
      '<div class="btns"><span class="btn" data-close>取消</span><span class="btn pri" id="foldSave">建立</span></div>' +
      '</div></div>';
    mountSheet(mask);
    if (parent) mask.querySelector('#foldParent').value = parent;
    mask.addEventListener('click', function (ev) {
      if (ev.target === mask || ev.target.hasAttribute('data-close')) mask.remove();
    });
    mask.querySelector('#foldSave').addEventListener('click', function () {
      var name = mask.querySelector('#foldName').value.trim();
      if (!name) { toast('請輸入名稱'); return; }
      var arr = folderTree(type);
      arr.push({ id: 'f' + Date.now() + Math.floor(Math.random() * 1000), name: name,
        parent: mask.querySelector('#foldParent').value || '' });
      saveFolderTree(type, arr);
      mask.remove();
      view();
      toast('已建立文件夾');
    });
  }

  function showFolderManage(type, state, view) {
    var mask = document.createElement('div');
    mask.className = 'sheet-mask';
    var out = '<div class="fold-list">';
    if (!folderTree(type).length) out += '<p class="dim">還沒有文件夾。</p>';
    function walk(parent, depth) {
      folderChildren(type, parent).forEach(function (f) {
        var n = folderItems(type, f.id).length;
        out += '<div class="fold-manage" style="padding-left:' + (depth * 18) + 'px">' +
          '<span>' + esc(f.name) + (n ? '（' + n + '）' : '') + '</span>' +
          '<span class="fold-del" data-del-fold="' + esc(f.id) + '">刪除</span></div>';
        walk(f.id, depth + 1);
      });
    }
    walk('', 0);
    out += '</div>';
    mask.innerHTML = '<div class="sheet"><div class="hd"><span class="t">管理文件夾</span>' +
      '<span class="x" data-close>×</span></div><div class="b">' + out +
      '<div class="btns"><span class="btn" id="foldNew2">新建文件夾</span>' +
      '<span class="btn ghost" data-close>完成</span></div></div></div>';
    mountSheet(mask);
    mask.addEventListener('click', function (ev) {
      if (ev.target === mask || ev.target.hasAttribute('data-close')) mask.remove();
    });
    mask.querySelector('#foldNew2').addEventListener('click', function () {
      mask.remove(); showFolderCreate(type, state, view);
    });
    Array.prototype.forEach.call(mask.querySelectorAll('[data-del-fold]'), function (el) {
      el.addEventListener('click', function () {
        var id = el.getAttribute('data-del-fold');
        mask.remove();
        deleteFolderFlow(type, state, view, id);
      });
    });
  }

  function deleteFolderFlow(type, state, view, id) {
    var name = (folderById(type, id) || {}).name || '';
    var sub = folderSubtree(type, id);
    var keys = folderItems(type, id);
    var descendants = Object.keys(sub).filter(function (x) { return x !== id; });
    confirmSheet('刪除文件夾', '「' + name + '」' +
      (keys.length ? '內有 ' + keys.length + ' 條，會先移到「未分類」。' : '會被刪除。'),
      '刪除文件夾', function () {
        var arr = folderTree(type).filter(function (f) { return !sub[f.id]; });
        saveFolderTree(type, arr);
        if (sub[state.folder]) state.folder = 'all';
        keys.forEach(function (k) { setItemFolder(type, k, ''); });
        if (!keys.length) { view(); toast('已刪除文件夾'); return; }
        confirmSheet('文件夾內還有 ' + keys.length + ' 條',
          '要連同這些條目一起刪除嗎？刪除後不能恢復。',
          '連同刪除', function () {
            keys.forEach(function (k) { removeItemByKey(type, k); cleanItemFolder(type, k); });
            view(); toast('已刪除文件夾與 ' + keys.length + ' 條');
          }, { cancelText: '保留條目', delay: 3000, danger: true });
        // 第二个弹窗关闭/取消时，第一层已经把条目移到未分類
      });
  }

  function moveSelected(type, state, view, keys) {
    if (!keys.length) { toast('請先選擇條目'); return; }
    state.__moveKeys = keys;
    showFolderSheet(type, state, view, true);
  }

  function manageBarHTML(n) {
    return '<div class="hist-bar" id="mBar">' +
      '<span class="hb" id="mAll">全選</span>' +
      '<span class="hb" id="mMove">移動</span>' +
      '<span class="hb danger" id="mDel">刪除' + (n ? ' (' + n + ')' : '') + '</span>' +
      '<span class="hb" id="mCancel">取消</span></div>';
  }

  /* 笔记/划线/收藏共用一套管理态：管理按钮、长按进管理、全选、删除确认、取消 */
  function bindManage(state, view, opts) {
    var mb = document.getElementById('mManage');
    if (mb) mb.addEventListener('click', function () {
      state.manage = !state.manage;
      state.sel = {};
      view();
    });

    var rows = document.querySelectorAll(opts.rowSel);
    function refresh() {
      Array.prototype.forEach.call(rows, function (row) {
        row.classList.toggle('sel', !!state.sel[row.getAttribute('data-mid')]);
      });
      var del = document.getElementById('mDel');
      if (del) {
        var n = Object.keys(state.sel).length;
        del.textContent = AR.conv('刪除') + (n ? ' (' + n + ')' : '');
      }
    }

    Array.prototype.forEach.call(rows, function (row) {
      var id = row.getAttribute('data-mid');
      var lp = null;
      function clearLp() { if (lp) { clearTimeout(lp); lp = null; } }

      row.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });
      row.addEventListener('touchstart', function () {
        if (state.manage) return;
        clearLp();
        lp = setTimeout(function () {
          lp = null;
          manageBlockClick = Date.now() + 700;
          if (navigator.vibrate) { try { navigator.vibrate(12); } catch (e) { } }
          state.manage = true;
          state.sel = {};
          state.sel[id] = true;
          view();
        }, 480);
      }, { passive: true });
      row.addEventListener('touchmove', clearLp, { passive: true });
      row.addEventListener('touchend', clearLp, { passive: true });
      row.addEventListener('touchcancel', clearLp, { passive: true });

      row.addEventListener('click', function (ev) {
        if (!state.manage) return;
        ev.preventDefault();
        if (Date.now() < manageBlockClick) return;
        if (state.sel[id]) delete state.sel[id]; else state.sel[id] = true;
        refresh();
      });
    });

    var all = document.getElementById('mAll');
    if (all) all.addEventListener('click', function () {
      opts.ids.forEach(function (id) { state.sel[id] = true; });
      refresh();
    });

    var cancel = document.getElementById('mCancel');
    if (cancel) cancel.addEventListener('click', function () {
      state.manage = false;
      state.sel = {};
      view();
    });

    var del = document.getElementById('mDel');
    if (del) del.addEventListener('click', function () {
      var ids = Object.keys(state.sel);
      if (!ids.length) { toast('先選要刪的記錄'); return; }
      confirmSheet('刪除' + opts.label, '共 ' + ids.length + ' 條，刪除後不能恢復。', '刪除', function () {
        opts.remove(ids);
        state.manage = false;
        state.sel = {};
        view();
        toast('已刪除 ' + ids.length + ' 條');
      });
    });
  }

  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function emptyBlock(tip, act) {
    return '<div class="empty-hint">' + esc(tip) +
      (act ? '<div class="eh-act"><a href="' + act[1] + '">' + esc(act[0]) + '</a></div>' : '') +
      '</div>';
  }

  function viewNotes() {
    var items = [];
    allPosts().forEach(function (p) {
      items.push({ kind: 'post', k: p.k, h: p.h, t: p.t });
    });
    allSegNotes().forEach(function (s) {
      items.push({ kind: 'seg', k: s.k, b: s.b, h: s.h, x: s.x, t: s.t });
    });
    items.sort(function (a, b) { return a.t < b.t ? 1 : -1; });
    items = items.filter(function (it) {
      return matchesFolder('note', it.kind, it, notesState.folder);
    });

    var body = items.length ? items.map(function (it, idx) {
      var href = '#/k/' + encodeURIComponent(it.k) + '?back=notes' +
        (it.kind === 'seg' ? '&b=' + it.b : '');
      return '<a class="lrow manage-row' + (notesState.sel[idx] ? ' sel' : '') +
        '" data-mid="' + idx + '" href="' + href + '">' +
        '<div class="lrow-h">' +
        (notesState.manage ? '<span class="hcheck"></span>' : '') +
        '<span class="nm">' + esc(nameOf(it.k)) + '</span>' +
        '<span class="ts">' + esc(fmtDate(it.t)) + '</span></div>' +
        (it.x ? '<div class="quote">' + esc(it.x) + '</div>' : '') +
        '<div class="note">' + esc(it.h) + '</div>' +
        '<div class="meta">' + esc(it.k) +
        (it.kind === 'seg' ? '　第 ' + it.b + ' 段' : '　經後筆記') + '</div>' +
        '</a>';
    }).join('') : emptyBlock('還沒有筆記。在經文裡點一段，選「筆記」就能寫下想法。', ['去讀經', '#/d/A']);

    var selN = Object.keys(notesState.sel).length;
    paint(bar('我的筆記', '#/',
      '<span class="act" id="mManage">' + (notesState.manage ? '完成' : '管理') + '</span>') +
      '<div class="app' + (notesState.manage ? ' manage' : '') + '">' +
      folderBarHTML('note', notesState) +
      '<div class="list-h">共 ' + items.length + ' 條</div>' + body + '</div>' +
      (notesState.manage ? manageBarHTML(selN) : ''));

    bindManage(notesState, viewNotes, {
      rowSel: '.manage-row',
      ids: items.map(function (_, i) { return String(i); }),
      label: '筆記',
      remove: function (ids) {
        ids.forEach(function (id) {
          var it = items[+id];
          if (!it) return;
          cleanItemFolder('note', itemKey(it.kind, it));
          if (it.kind === 'post') delPost(it.k);
          else setSegNote(it.k, it.b, '');
        });
      }
    });
    bindFolderBar('note', notesState, viewNotes);
    var mv = document.getElementById('mMove');
    if (mv) mv.addEventListener('click', function () {
      var keys = Object.keys(notesState.sel).map(function (i) {
        var it = items[+i]; return it ? itemKey(it.kind, it) : '';
      }).filter(Boolean);
      moveSelected('note', notesState, viewNotes, keys);
    });
  }

  function viewHighlights() {
    var all = allHl().filter(function (h) {
      return matchesFolder('hl', 'hl', h, hlState.folder);
    });
    var byKey = {};
    all.forEach(function (h) { (byKey[h.k] || (byKey[h.k] = [])).push(h); });
    var keys = Object.keys(byKey).sort(function (a, b) {
      return byKey[b][0].t < byKey[a][0].t ? -1 : 1;
    });

    var body = all.length ? keys.map(function (k) {
      return '<div class="lgroup">' +
        '<div class="lg-h"><a href="#/k/' + encodeURIComponent(k) + '?back=highlights">' + esc(nameOf(k)) + '</a>' +
        '<span class="ts">' + esc(k) + '　' + byKey[k].length + ' 處</span></div>' +
        byKey[k].sort(function (a, b) { return a.b - b.b; }).map(function (h) {
          var idx = all.indexOf(h);
          return '<a class="hlrow manage-row' + (hlState.sel[idx] ? ' sel' : '') +
            '" data-mid="' + idx + '" href="#/k/' + encodeURIComponent(k) + '?back=highlights&b=' + h.b + '">' +
            (hlState.manage ? '<span class="hcheck"></span>' : '') +
            '<span class="hbar"></span>' +
            '<span class="tx">' + (h.x ? esc(h.x) : '第 ' + h.b + ' 段') + '</span></a>';
        }).join('') +
        '</div>';
    }).join('') : emptyBlock('還沒有劃線。點一段經文，選「高亮」就會留在這裡。', ['去讀經', '#/d/A']);

    var selN = Object.keys(hlState.sel).length;
    paint(bar('我的劃線', '#/',
      '<span class="act" id="mManage">' + (hlState.manage ? '完成' : '管理') + '</span>') +
      '<div class="app' + (hlState.manage ? ' manage' : '') + '">' +
      folderBarHTML('hl', hlState) +
      '<div class="list-h">共 ' + all.length + ' 處</div>' + body + '</div>' +
      (hlState.manage ? manageBarHTML(selN) : ''));

    bindManage(hlState, viewHighlights, {
      rowSel: '.manage-row',
      ids: all.map(function (_, i) { return String(i); }),
      label: '劃線',
      remove: function (ids) {
        var m = readStore(K_HL, {});
        ids.forEach(function (id) {
          var h = all[+id];
          if (!h) return;
          cleanItemFolder('hl', itemKey('hl', h));
          var bucket = m[h.k];
          if (!bucket) return;
          var arr = bucket[h.b];
          if (arr == null) return;
          var list = Array.isArray(arr) ? arr : [arr];
          list = list.filter(function (r) {
            var s = r.s == null ? 0 : r.s, e = r.e == null ? -1 : r.e;
            return !(r.t === h.t && s === h.s && e === h.e);
          });
          if (list.length) bucket[h.b] = list; else delete bucket[h.b];
          if (!Object.keys(bucket).length) delete m[h.k];
        });
        writeStore(K_HL, m);
      }
    });
    bindFolderBar('hl', hlState, viewHighlights);
    var mv = document.getElementById('mMove');
    if (mv) mv.addEventListener('click', function () {
      var keys = Object.keys(hlState.sel).map(function (i) {
        var h = all[+i]; return h ? itemKey('hl', h) : '';
      }).filter(Boolean);
      moveSelected('hl', hlState, viewHighlights, keys);
    });
  }

  function viewFavorites() {
    var all = allFavs().filter(function (f) {
      return matchesFolder('fav', 'fav', f, favState.folder);
    });
    var body = all.length ? all.map(function (f) {
      return '<div class="lrow fav manage-row' + (favState.sel[f.k] ? ' sel' : '') +
        '" data-mid="' + esc(f.k) + '" data-open="' + esc(f.k) + '">' +
        '<div class="lrow-h">' +
        (favState.manage ? '<span class="hcheck"></span>' : '') +
        '<a class="nm" href="#/k/' + encodeURIComponent(f.k) + '?back=favorites">' + esc(nameOf(f.k)) + '</a>' +
        '<span class="ts">' + esc(fmtDate(f.t)) + '</span></div>' +
        '<div class="fav-b">' +
        '<span class="tag' + (f.tag ? '' : ' empty') + '" data-tag="' + esc(f.k) + '">' +
        (f.tag ? esc(f.tag) : '＋ 加標籤') + '</span>' +
        '<span class="meta">' + esc(f.k) + '</span>' +
        '</div></div>';
    }).join('') : emptyBlock('還沒有收藏。在經文頁右上角點 ☆ 就能收藏，順手寫個標籤更好找。', ['去讀經', '#/d/A']);

    var selN = Object.keys(favState.sel).length;
    paint(bar('我的收藏', '#/',
      '<span class="act" id="mManage">' + (favState.manage ? '完成' : '管理') + '</span>') +
      '<div class="app' + (favState.manage ? ' manage' : '') + '">' +
      folderBarHTML('fav', favState) +
      '<div class="list-h">共 ' + all.length + ' 條</div>' + body + '</div>' +
      (favState.manage ? manageBarHTML(selN) : ''));

    Array.prototype.forEach.call(document.querySelectorAll('.lrow.fav'), function (el) {
      el.addEventListener('click', function (ev) {
        if (favState.manage) return;
        if (ev.target.closest('a') || ev.target.closest('[data-tag]')) return;
        var k = el.getAttribute('data-open');
        if (k) location.hash = '#/k/' + encodeURIComponent(k) + '?back=favorites';
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-tag]'), function (el) {
      el.addEventListener('click', function (ev) {
        if (favState.manage) return;
        ev.preventDefault();
        ev.stopPropagation();
        showFavEditor(el.getAttribute('data-tag'), function () { viewFavorites(); });
      });
    });
    bindManage(favState, viewFavorites, {
      rowSel: '.manage-row',
      ids: all.map(function (f) { return f.k; }),
      label: '收藏',
      remove: function (ids) {
        ids.forEach(function (k) { cleanItemFolder('fav', k); unfav(k); });
      }
    });
    bindFolderBar('fav', favState, viewFavorites);
    var mv = document.getElementById('mMove');
    if (mv) mv.addEventListener('click', function () {
      moveSelected('fav', favState, viewFavorites, Object.keys(favState.sel));
    });
  }

  /* 收藏弹层：收藏时顺手写个标签，日后一眼能认出是哪一部 */
  function showFavEditor(k, onDone) {
    var cur = favOf(k);
    var mask = document.createElement('div');
    mask.className = 'sheet-mask';
    mask.innerHTML = '<div class="sheet">' +
      '<div class="hd"><span class="t">' + (cur ? '編輯收藏' : '收藏這部經') + '</span>' +
      '<span class="x" data-close>×</span></div>' +
      '<div class="fav-name">' + esc(nameOf(k)) + '</div>' +
      '<input id="favTag" type="text" maxlength="24" ' +
      'placeholder="加個標籤，例如：無常／四聖諦／要再讀">' +
      '<div class="btns">' +
      (cur ? '<span class="btn ghost" id="favDel">取消收藏</span>' : '') +
      '<span class="btn" id="favCancel">取消</span>' +
      '<span class="btn pri" id="favSave">儲存</span></div>' +
      '</div>';
    mountSheet(mask);

    var inp = mask.querySelector('#favTag');
    inp.value = cur ? (cur.tag || '') : '';
    inp.focus();

    function close() { mask.remove(); }
    mask.addEventListener('click', function (ev) {
      if (ev.target === mask || ev.target.hasAttribute('data-close')) close();
    });
    mask.querySelector('#favCancel').onclick = close;
    var del = mask.querySelector('#favDel');
    if (del) del.onclick = function () {
      unfav(k); close();
      if (onDone) onDone(false);
      toast('已取消收藏');
    };
    mask.querySelector('#favSave').onclick = function () {
      setFav(k, inp.value);
      close();
      if (onDone) onDone(true);
      toast('已收藏');
    };
  }

  /* 挂到 body 上的浮层都要过繁简转换：
   * paint() 只负责 #app 里的内容，弹层是 body 的直属子节点，走不到那条管线。
   * 这里统一收口，避免「弹层永远是繁体」这类问题再犯。 */
  function mountSheet(el) {
    // 互斥：弹层叠弹层会遮成灰片，先关掉已有的
    Array.prototype.forEach.call(document.querySelectorAll('.sheet-mask'), function (m) { m.remove(); });
    el.innerHTML = AR.conv(el.innerHTML);
    document.body.appendChild(el);
    document.documentElement.classList.add('sheet-open');
    document.body.classList.add('sheet-open');   // 锁住背后的阅读页，别让弹层滑动带着正文走
  }

  /* 弹层可能从很多地方直接 remove()，用观察器统一解锁 */
  var sheetLockObs = new MutationObserver(function () {
    var open = !!document.querySelector('.sheet-mask');
    document.documentElement.classList.toggle('sheet-open', open);
    document.body.classList.toggle('sheet-open', open);
  });
  sheetLockObs.observe(document.body, { childList: true, subtree: true });

  /* 注释里的经号变成可点的引用（只有本库确实有这一经才转） */
  var REF_RE = /\b([A-Z]{2,3}\.\d+(?:\.\d+)?)/g;

  function linkifyRefs(escaped) {
    var leaf = (AR.S && AR.S.leaf) || {};
    return escaped.replace(REF_RE, function (m) {
      if (!leaf[m]) return m;
      return '<a class="ref" data-nav="jump" href="#/k/' + encodeURIComponent(m) + '">' + m + '</a>';
    });
  }
  /* 自绘确认框：WebView 默认不弹 window.confirm，用它会被静默忽略 */
  function confirmSheet(title, msg, okText, onOk, opts) {
    opts = opts || {};
    var mask = document.createElement('div');
    mask.className = 'sheet-mask';
    mask.innerHTML = '<div class="sheet"><div class="hd"><span class="t">' + esc(title) + '</span>' +
      '<span class="x" data-close>×</span></div>' +
      '<div class="b"><p>' + esc(msg) + '</p></div>' +
      '<div class="btns"><span class="btn" id="cfNo">' + esc(opts.cancelText || '取消') + '</span>' +
      '<span class="btn pri' + (opts.danger ? ' danger' : '') + '" id="cfYes">' +
      esc(okText || '確定') + '</span></div></div>';
    mountSheet(mask);
    mask.addEventListener('click', function (ev) {
      if (ev.target === mask || ev.target.hasAttribute('data-close')) mask.remove();
    });
    mask.querySelector('#cfNo').onclick = function () { mask.remove(); };
    var yes = mask.querySelector('#cfYes');
    if (opts.delay) {
      var left = Math.ceil(opts.delay / 1000);
      yes.disabled = true;
      yes.classList.add('wait');
      yes.textContent = (okText || '確定') + '（' + left + 's）';
      var tm = setInterval(function () {
        if (!document.body.contains(yes)) { clearInterval(tm); return; }
        left--;
        if (left <= 0) {
          clearInterval(tm);
          yes.disabled = false;
          yes.classList.remove('wait');
          yes.textContent = okText || '確定';
        } else {
          yes.textContent = (okText || '確定') + '（' + left + 's）';
        }
      }, 1000);
    }
    yes.onclick = function () {
      if (yes.disabled) return;
      mask.remove();
      if (onOk) onOk();
    };
  }

  /* ---------- 设置 ---------- */

  function viewSettings() {
    var cur = AR.lang();
    var prefs = readPrefs();
    var sets = allSets();
    var setRows = '';
    Object.keys(sets).forEach(function (id) {
      var s = sets[id], m = s.meta || {};
      setRows += '<div class="set-row">' +
        '<span class="k">' + esc(m.name || id) +
        '<span class="sub2">' + esc(m.author || '未署名') + '　' + (s.entries || []).length + ' 條</span></span>' +
        '<span class="del" data-del="' + esc(id) + '">刪除</span>' +
        '<span class="sw' + (s.on !== false ? ' on' : '') + '" data-set="' + esc(id) + '"></span></div>';
    });

    paint(
      bar('設置', '#/') +
      '<div class="app">' +
      '<div class="set-h">語言</div>' +
      '<div class="set-row"><span class="k">文字</span>' +
      '<span class="seg">' +
      '<a class="seg-i' + (cur === 'simp' ? ' on' : '') + '" data-lang="simp">簡體</a>' +
      '<a class="seg-i' + (cur === 'trad' ? ' on' : '') + '" data-lang="trad">繁體</a>' +
      '</span></div>' +
      '<div class="set-note">經文以繁體存儲，簡體為即時轉換；切換後立即生效，不需重新載入。</div>' +
      '<div class="set-row"><span class="k">閱讀字體</span>' +
      '<span class="seg">' +
      '<a class="seg-i' + (prefs.font !== 'system' && !(prefs.font === 'custom' && customFontLoaded) ? ' on' : '') + '" data-font="default">默認</a>' +
      '<a class="seg-i' + (prefs.font === 'system' ? ' on' : '') + '" data-font="system">系統</a>' +
      '<a class="seg-i' + (prefs.font === 'custom' && customFontLoaded ? ' on' : '') + '" data-font="custom">自訂</a>' +
      '</span></div>' +
      '<div class="set-note">只影響閱讀頁；缺字會回落默認字體。</div>' +
      '<div class="set-row link" id="fontPick"><span class="k">導入字體文件' +
      '<span class="sub2">' + (customFontLoaded ? esc(customFontName) : '未導入') + '</span></span>' +
      '<span class="v">' + (customFontLoaded ? '更換 ›' : '›') + '</span></div>' +
      '<div class="set-note">單個字體檔案上限 32 MB；字體只存在本機，不隨資料備份。</div>' +
      (customFontLoaded ? '<div class="set-row link" id="fontClear"><span class="k">移除自訂字體</span><span class="v">›</span></div>' : '') +

      '<div class="set-h">閱讀</div>' +
      '<div class="set-row"><span class="k">主題</span><span class="seg">' +
      '<a class="seg-i' + (prefs.theme === 'system' ? ' on' : '') + '" data-theme="system">跟隨系統</a>' +
      '<a class="seg-i' + (prefs.theme === 'light' ? ' on' : '') + '" data-theme="light">淺色</a>' +
      '<a class="seg-i' + (prefs.theme === 'dark' ? ' on' : '') + '" data-theme="dark">深色</a>' +
      '</span></div>' +
      '<div class="set-row"><span class="k">異本編號' +
      '<span class="sub2">目錄的經號與排序會跟著換</span></span>' +
      '<span class="seg">' +
      '<a class="seg-i' + (edition === 'tw' ? ' on' : '') + '" data-ed="tw">大正</a>' +
      '<a class="seg-i' + (edition === 'zw' ? ' on' : '') + '" data-ed="zw">正聞</a>' +
      '<a class="seg-i' + (edition === 'fg' ? ' on' : '') + '" data-ed="fg">佛光</a>' +
      '</span></div>' +
      '<div class="set-note">只有雜阿含（正聞／佛光）與增壹（佛光）有異本號；' +
      '其餘部沒有異本對號，一律顯示大正本號。正文只有大正藏一份，切換的是編號不是文字。</div>' +

      '<div class="set-h">註釋來源</div>' +
      '<div class="set-row"><span class="k">莊春江（內置）' +
      '<span class="sub2">詞條注 · 頁內注 · 漢巴經文比對</span></span>' +
      '<span class="sw' + (zcjOn() ? ' on' : '') + '" id="swZcj"></span></div>' +
      setRows +
      '<div class="set-note">可多套疊加，也可只留一套。</div>' +

      '<div class="set-h">資料</div>' +
      '<div class="set-row link" id="btnExpAll"><span class="k">匯出資料' +
      '<span class="sub2">筆記・註釋・高亮・收藏・譯文改寫・筆記包</span></span><span class="v">›</span></div>' +
      '<div class="set-row link" id="btnImpAll"><span class="k">匯入資料' +
      '<span class="sub2">自動識別：備份包或筆記包，合併不覆蓋</span></span><span class="v">›</span></div>' +
      '<div class="set-note">這些資料只存在本機；換手機或重裝前先匯出一份。' +
      '別人給的筆記包也用「匯入資料」進來，會多出一套可開關的註釋來源。</div>' +
      '<div class="set-note">導出為 .json，可換機時導入，也可給他人使用。' +
      '你寫的筆記與標籤著作權在你，導出時可自行決定要不要聲明分享授權（預設不指定）；' +
      '只有檔內的經文摘錄固定受 CC BY-NC-SA 4.0 約束（非商業、註明出處），檔中已寫明。</div>' +

      '<div class="set-h">關於</div>' +
      '<div class="set-row"><span class="k">內容</span><span class="v">莊春江 編譯 · CC BY-NC-SA 4.0</span></div>' +
      '<div class="set-row"><span class="k">程式</span><span class="v">AGPL-3.0</span></div>' +
      '<div class="set-row"><span class="k">翻譯包</span><span class="v">昭 同修 提供 · CC BY-NC-SA 4.0</span></div>' +
      '<div class="set-row"><span class="k">圖片</span><span class="v">按各自許可（CC0／CC BY-SA）</span></div>' +
      '<a class="set-row link" href="#/updates"><span class="k">獲取更新及資源包<span class="sub2">GitHub · 請自行在瀏覽器打開</span></span><span class="v">›</span></a>' +
      '<a class="set-row link" href="#/terms"><span class="k">使用協議</span><span class="v">›</span></a>' +
      '<a class="set-row link" href="#/license"><span class="k">授權與致謝</span><span class="v">›</span></a>' +
      '<div class="set-note">內容許可由原作者設定，不可放寬。本程式不聯網、不申請任何權限；筆記只存在本機。</div>' +
      '</div>'
    );

    Array.prototype.forEach.call(document.querySelectorAll('[data-lang]'), function (el) {
      el.addEventListener('click', function () {
        var l = el.getAttribute('data-lang');
        try { localStorage.setItem(LANG_KEY, l); } catch (e) { }
        AR.setLang(l);
        viewSettings();
        toast(l === 'trad' ? '已切換為繁體' : '已切換為簡體');
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-font]'), function (el) {
      el.addEventListener('click', function () {
        var f = el.getAttribute('data-font');
        var p2 = readPrefs();
        if (f === 'custom' && !customFontLoaded) {
          toast('請選擇一個字體文件');
          pickReadFont();
          return;
        }
        p2.font = f;
        savePrefs(p2);
        toast(f === 'system' ? '閱讀字體：系統' :
          (f === 'custom' ? '閱讀字體：自訂' : '閱讀字體：默認'));
        viewSettings();
      });
    });
    var fp = document.getElementById('fontPick');
    if (fp) fp.addEventListener('click', function () { pickReadFont(); });
    var fc = document.getElementById('fontClear');
    if (fc) fc.addEventListener('click', function () {
      fontDel().then(function () {
        customFontLoaded = false;
        customFontName = '';
        var p2 = readPrefs();
        p2.font = 'default';
        savePrefs(p2);
        viewSettings();
        toast('已移除自訂字體');
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-ed]'), function (el) {
      el.addEventListener('click', function () {
        setEdition(el.getAttribute('data-ed'));
        viewSettings();
        toast('異本已切換：' + EDITION_NAME[edition]);
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-theme]'), function (el) {
      el.addEventListener('click', function () {
        var p2 = readPrefs();
        p2.theme = el.getAttribute('data-theme');
        savePrefs(p2);
        viewSettings();
        toast(p2.theme === 'system' ? '主題：跟隨系統' :
          (p2.theme === 'dark' ? '主題：深色' : '主題：淺色'));
      });
    });

    var z = document.getElementById('swZcj');
    if (z) z.addEventListener('click', function () {
      setZcjOn(!zcjOn());
      viewSettings();
      toast(zcjOn() ? '已開啟莊春江註釋' : '已關閉莊春江註釋');
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-set]'), function (el) {
      el.addEventListener('click', function () {
        var id = el.getAttribute('data-set');
        var m = allSets();
        if (!m[id]) return;
        m[id].on = m[id].on === false;
        writeStore(K_SETS, m);
        viewSettings();
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-del]'), function (el) {
      el.addEventListener('click', function () {
        var id = el.getAttribute('data-del');
        var m = allSets();
        var nm = (m[id] && m[id].meta && m[id].meta.name) || id;
        confirmSheet('刪除這一套註釋', '「' + nm + '」會從本機移除，不影響你自己的筆記。', '刪除', function () {
          delSet(id);
          viewSettings();
          toast('已刪除');
        });
      });
    });

    document.getElementById('btnExpAll').addEventListener('click', function () { exportUserData(); });
    document.getElementById('btnImpAll').addEventListener('click', function () { startImport(); });
  }

  /* ---------- 路由 ---------- */

  function route() {
    var hash = location.hash || '#/';
    // 非阅读页离开时记住滚动位置；阅读页不记，始终回顶部
    if (lastRoute && lastRoute !== hash && !/^#\/k\//.test(lastRoute)) {
      scrollMemo[lastRoute] = window.scrollY;
    }
    lastRoute = hash;
    // 离开历史页就退出管理态，免得下次回来还带着旧选择
    if ((location.hash || '#/').indexOf('#/history') !== 0) {
      historyManage = false;
      historySel = {};
    }
    if ((location.hash || '#/').indexOf('#/notes') !== 0) {
      notesState.manage = false;
      notesState.sel = {};
    }
    if ((location.hash || '#/').indexOf('#/highlights') !== 0) {
      hlState.manage = false;
      hlState.sel = {};
    }
    if ((location.hash || '#/').indexOf('#/favorites') !== 0) {
      favState.manage = false;
      favState.sel = {};
    }
    // 巴利优先的版式只在巴利阅读页生效
    document.body.classList.remove('pali-first');
    var m;
    if ((m = hash.match(/^#\/d\/([A-C])/))) return viewGroup(m[1]);
    if ((m = hash.match(/^#\/s\/([A-Za-z]+)/))) return viewSeries(m[1]);
    if ((m = hash.match(/^#\/k\/([^?]+)/))) return viewRead(m[1]);
    if ((m = hash.match(/^#\/search(?:\?q=([^&]+))?/))) return viewSearch(m[1] ? decodeURIComponent(m[1]) : '');
    if (hash.indexOf('#/pali') === 0) return viewPali();
    if (hash.indexOf('#/notes') === 0) return viewNotes();
    if (hash.indexOf('#/highlights') === 0) return viewHighlights();
    if (hash.indexOf('#/favorites') === 0) return viewFavorites();
    if (hash.indexOf('#/changelog') === 0) return viewChangelog();
    if (hash.indexOf('#/updates') === 0) return viewUpdates();
    if (hash.indexOf('#/terms') === 0) return viewTerms();
    if (hash.indexOf('#/license') === 0) return viewLicense();
    if (hash.indexOf('#/settings') === 0) return viewSettings();
    if (hash.indexOf('#/history') === 0) return viewHistory();
    return viewHome();
  }

  // 带 data-nav 的链接（对读、搜索结果、历史）算跳转；其余（目录、翻页）算自然阅读
  document.addEventListener('click', function (ev) {
    if (historyManage) return;      // 历史管理态里点行只是选/取消，不算跳转
    var el = ev.target.closest && ev.target.closest('[data-nav]');
    if (el) markNav(el.getAttribute('data-nav'));
  }, true);

  /* 选字操作条优先于上下菜单：条开着时，点条外只收条，不再把阅读菜单唤出来 */
  document.addEventListener('click', function (ev) {
    var bar = document.getElementById('actbar');
    if (!bar || !bar.classList.contains('on')) return;
    if (ev.target.closest && ev.target.closest('#actbar')) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (window.__clearSel) window.__clearSel();
  }, true);

  /* 搜索范围下拉：点别处收起（只装在 document 上一次） */
  document.addEventListener('click', function (ev) {
    var menu = document.querySelector('.scope-menu.on');
    if (menu && !(ev.target.closest && ev.target.closest('.search-scope'))) {
      menu.classList.remove('on');
    }
  });

  window.addEventListener('hashchange', route);

  /* 选字监听只装一次；具体处理函数由当前阅读页注入（selHandler） */
  var selTimer = null;
  document.addEventListener('selectionchange', function () {
    if (!selHandler) return;
    clearTimeout(selTimer);
    selTimer = setTimeout(function () {
      try { selHandler(); } catch (e) { }
    }, 220);
  });

  // 语言先定下来，首屏才不会闪一下繁体
  try { AR.setLang(localStorage.getItem(LANG_KEY) || 'simp'); } catch (e) { AR.setLang('simp'); }
  // 不要让浏览器/WebView 恢复上次滚动位置——本项目一律回到顶部
  try { if ('scrollRestoration' in history) history.scrollRestoration = 'manual'; } catch (e) { }

  applyPrefs();

  AR.boot().then(function () {
    return loadCustomFont();
  }).then(function () {
    purgeDrafts();
    route();
    bootEl.classList.add('hide');
    setTimeout(function () { bootEl.remove(); }, 400);
    if (location.search.indexOf('diag') >= 0) setTimeout(diag, 600);
  }).catch(function (err) {
    bootEl.innerHTML = '<div class="mark">載入失敗</div><div>' + esc(err.message) + '</div>';
  });

  /* 临时诊断：把关键宽度写进 DOM，供 --dump-dom 读取 */
  function diag() {
    setTimeout(function () {
      var pick = ['.app', '.read-body', '.read-body p', '.bar', '.pager'];
      var lines = ['innerWidth=' + window.innerWidth,
        'clientWidth=' + document.documentElement.clientWidth,
        'bodyScrollW=' + document.body.scrollWidth,
        'docScrollW=' + document.documentElement.scrollWidth];
      pick.forEach(function (sel) {
        var el = document.querySelector(sel);
        if (!el) { lines.push(sel + ' : (none)'); return; }
        var cs = getComputedStyle(el);
        lines.push(sel + ' : w=' + Math.round(el.getBoundingClientRect().width) +
          ' scrollW=' + el.scrollWidth +
          ' padL=' + cs.paddingLeft + ' padR=' + cs.paddingRight +
          ' ws=' + cs.whiteSpace + ' fs=' + cs.fontSize + ' ta=' + cs.textAlign);
      });
      var pre = document.createElement('pre');
      pre.id = 'diag';
      pre.textContent = lines.join('\n');
      document.body.appendChild(pre);
    }, 300);
  }
})();

