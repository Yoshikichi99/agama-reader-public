/* 掌上阿含 · 核心逻辑（无 DOM 依赖，可在 Node 里单测）
 *
 * 数据六张表：canon 目录 / theme 主题 / xref 对读 / notes.zcj 注释 / pali 巴利 / text.* 正文分片
 * 设计要点见 文档\数据结构.md 与 注释层设计.md
 */
var AR = (function () {
  'use strict';

  var S = {
    index: null,      // 分片清单
    canon: null,      // 目录树
    theme: null,      // 主题索引
    xref: null,       // 对读表
    notes: null,      // 注释包（zcj）
    pali: null,       // 巴利三层索引
    paliZh: null,     // 巴利逐段直译（内置表）
    paliOver: {},     // 用户导入/覆盖的巴利直译 { key: { 规范行: 中文 } }
    days: null,       // 今日一句
    leaf: {},         // 经号 -> {k,n,p,path[],series,node}
    pathOf: {},       // 经号 -> {s: 部, i: [下标路径]}，供「回上一层」用
    owner: {},        // 经号 -> 所属部 id（键前缀不可靠时以它为准）
    trans: {},        // 部 -> { 经号: { 段号: 译文 } }
    num: {},          // 经号 -> {zw: 正聞本号, fg: 佛光本号}
    series: {},       // 部 -> 已载条目数组
    loaded: {},       // 部 -> true
    noteIdx: null     // 页面 -> {notes:{r:h}, cmp:h}
  };

  var BASE = 'data/';

  /* ---------- 繁简转换 ----------
   * 数据一律以繁体存储（02 的既定决策：存繁转简），简体在运行时生成。
   * 映射表 498 条短语 + 4148 字，另有两处保护：
   *   1. 「明覆」是术语，不能被转成「明复」
   *   2. 「莊春江」的人名不能被转成「庄春江」
   */
  var T2S_C = null;      // 字表
  var T2S_FIRST = null;  // 首字索引，避免 498 条短语逐条 indexOf
  var LANG = 'simp';     // 默认简体

  function initT2S(d) {
    T2S_C = Object.assign({}, (d && d.c) || {});
    delete T2S_C['祇'];              // 「祇樹給孤獨園」的祇不能简化
    T2S_FIRST = {};
    ((d && d.p) || []).forEach(function (pair) {
      var f = pair[0][0];
      (T2S_FIRST[f] || (T2S_FIRST[f] = [])).push(pair);
    });
    // 短语可能重叠，长的先试
    Object.keys(T2S_FIRST).forEach(function (k) {
      T2S_FIRST[k].sort(function (a, b) { return b[0].length - a[0].length; });
    });
  }

  function toSimp(s) {
    if (s == null || !T2S_C) return s == null ? '' : String(s);
    var src = String(s).split('明覆').join('\u0001');
    var out = '', i = 0, n = src.length;
    while (i < n) {
      var list = T2S_FIRST[src[i]];
      var hit = null;
      if (list) {
        for (var j = 0; j < list.length; j++) {
          if (src.startsWith(list[j][0], i)) { hit = list[j]; break; }
        }
      }
      if (hit) { out += hit[1]; i += hit[0].length; }
      else { out += (T2S_C[src[i]] || src[i]); i++; }
    }
    return out.split('\u0001').join('明覆').replace(/庄春江/g, '莊春江');
  }

  function conv(s) { return LANG === 'simp' ? toSimp(s) : String(s == null ? '' : s); }

  function setLang(l) {
    LANG = (l === 'trad') ? 'trad' : 'simp';
    return LANG;
  }

  function lang() { return LANG; }

  /* ---------- 载入 ---------- */

  /* 资源随 App 版本更新，但文件名不变；WebView 会拿旧缓存，
   * 所以这里一律 no-store，保证换版本后读到的是新数据。
   */
  function loadGz(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('讀取失敗：' + url + '（' + r.status + '）');
      return r.arrayBuffer();
    }).then(function (ab) {
      if (typeof DecompressionStream === 'undefined') {
        throw new Error('此瀏覽器不支援 DecompressionStream');
      }
      var ds = new DecompressionStream('gzip');
      var st = new Blob([ab]).stream().pipeThrough(ds);
      return new Response(st).text();
    }).then(function (t) { return JSON.parse(t); });
  }

  function loadJson(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('讀取失敗：' + url);
      return r.json();
    });
  }

  function walk(node, trail, series, out) {
    if (!node.c) {
      out.push({ k: node.k, n: node.n, p: node.p, path: trail, series: series, node: node });
      return out;
    }
    var t = trail.concat(node.n ? [node.n] : []);
    for (var i = 0; i < node.c.length; i++) walk(node.c[i], t, series, out);
    return out;
  }

  /** 记录每个叶子在部内的下标路径，供「回上一层」用 */
  function walkIdx(node, idxs, series) {
    if (!node.c) {
      if (node.k) S.pathOf[node.k] = { s: series, i: idxs };
      return;
    }
    for (var i = 0; i < node.c.length; i++) walkIdx(node.c[i], idxs.concat([i]), series);
  }

  function boot() {
    return loadJson(BASE + 'daily.json').catch(function () { return { items: [] }; })
      .then(function (days) {
        S.days = days;
        return Promise.all([
          loadGz(BASE + 'canon.json.gz'),
          loadJson(BASE + 'index.json'),
          loadGz(BASE + 't2s.json.gz').catch(function () { return null; })
        ]);
      })
      .then(function (r) {
        S.canon = r[0];
        S.index = r[1];
        initT2S(r[2]);
        try {
          if (typeof localStorage !== 'undefined') {
            S.paliOver = JSON.parse(localStorage.getItem('ar.palizh') || '{}') || {};
          }
        } catch (e) { S.paliOver = {}; }
        // 目录叶子索引
        S.canon.groups.forEach(function (g) {
          g.c.forEach(function (b) {
            var out = [];
            walk(b, [], b.id, out);
            out.forEach(function (lf) { S.leaf[lf.k] = lf; S.owner[lf.k] = b.id; });
            walkIdx(b, [], b.id);
          });
        });
        // 其余三张表体积小，后台补齐，不挡首屏
        return Promise.all([
          loadGz(BASE + 'theme.json.gz').then(function (d) { S.theme = d; }),
          loadGz(BASE + 'xref.json.gz').then(function (d) { S.xref = d; }),
          loadGz(BASE + 'num.json.gz').then(function (d) { S.num = d || {}; }),
          loadGz(BASE + 'notes.zcj.json.gz').then(function (d) { S.notes = d; buildNoteIndex(); })
        ]).catch(function (e) { console.warn('附表載入失敗', e); });
      });
  }

  function buildNoteIndex() {
    var idx = {};
    (S.notes.entries || []).forEach(function (e) {
      var b = idx[e.p] || (idx[e.p] = { notes: {}, cmp: '' });
      if (e.k === 'note') b.notes[e.r] = e.h;
      else if (e.k === 'cmp') b.cmp = e.h;
    });
    S.noteIdx = idx;
  }

  /* ---------- 按需载入 ---------- */

  function loadSeries(s) {
    if (S.loaded[s]) return Promise.resolve(S.series[s]);
    if (!S.index || !S.index.series[s]) return Promise.resolve([]);
    return loadGz(BASE + S.index.series[s].f).then(function (list) {
      S.series[s] = list;
      S.loaded[s] = true;
      return list;
    });
  }

  /* 译文分片：按部随正文一起载入。没有译文的部就没有文件，404 当空。
   * 结构：trans.<setid>.<部>.json.gz → S.trans[setid][部] = { k: { b: 译文 } }
   * 多个 setid 可并存（ai＝自制/校订，ai2＝外部包…），前端用 setTransSet 选。
   */
  var TRANS_SETS = ['ai2', 'ai', 'review'];
  var TRANS_SET = 'ai2';

  function setTransSet(id) {
    if (!id) return;
    TRANS_SET = id;
  }

  function transSet() { return TRANS_SET; }

  function loadTrans(s, setid) {
    var id = setid || TRANS_SET;
    S.trans = S.trans || {};
    S.transLoaded = S.transLoaded || {};
    var key = id + '|' + s;
    if (S.transLoaded[key]) return Promise.resolve((S.trans[id] || {})[s] || {});
    return loadGz(BASE + 'trans.' + id + '.' + s + '.json.gz').then(function (d) {
      var map = {};
      ((d && d.entries) || []).forEach(function (e) {
        (map[e.k] || (map[e.k] = {}))[e.b] = e.h;
      });
      (S.trans[id] = S.trans[id] || {})[s] = map;
      S.transLoaded[key] = true;
      return map;
    }).catch(function () {
      (S.trans[id] = S.trans[id] || {})[s] = {};
      S.transLoaded[key] = true;
      return {};
    });
  }

  /* 本地改写优先：用户改过的段，显示用本地那份，其余用当前译集 */
  function trOverride() {
    try { return JSON.parse(localStorage.getItem('ar.tr') || '{}'); } catch (e) { return {}; }
  }

  function setTrOverride(k, b, text) {
    var all = trOverride();
    var e = all[k] || (all[k] = {});
    if (text) e[b] = text; else delete e[b];
    if (!Object.keys(e).length) delete all[k];
    localStorage.setItem('ar.tr', JSON.stringify(all));
  }

  function transOf(k, b) {
    var ov = trOverride();
    if (ov[k] && ov[k][b]) return ov[k][b];
    var s = seriesOf(k);
    var m = ((S.trans || {})[TRANS_SET] || {})[s] || {};
    var e = m[k];
    return e ? (e[b] || '') : '';
  }

  /* 当前译集在**这一经**没有译文时，自动换到有译文的那一套。
   * 只按经判断，不按部：部里有别的经不代表这一经有，
   * 否则「样稿集」会把全量集挡掉（2026-11-14 踩过）。
   */
  function ensureTransSet(series, k) {
    function has(map) {
      var e = map && map[k];
      if (!e) return false;
      for (var b in e) { if (e[b]) return true; }
      return false;
    }
    return loadTrans(series).then(function (map) {
      if (has(map)) return TRANS_SET;
      var rest = TRANS_SETS.filter(function (id) { return id !== TRANS_SET; });
      var chain = Promise.resolve(null);
      rest.forEach(function (id) {
        chain = chain.then(function (found) {
          if (found) return found;
          return loadTrans(series, id).then(function (m) { return has(m) ? id : null; });
        });
      });
      return chain.then(function (found) {
        if (found) { TRANS_SET = found; return found; }
        return TRANS_SET;
      });
    });
  }
  function hasTransSet(k, setid) {
    var s = seriesOf(k);
    var m = ((S.trans || {})[setid] || {})[s] || {};
    var e = m[k];
    if (!e) return false;
    for (var b in e) { if (e[b]) return true; }
    return false;
  }

  function hasTrans(k) {
    if (hasTransSet(k, TRANS_SET)) return true;
    var ov = trOverride()[k];
    return !!(ov && Object.keys(ov).length);
  }
  /* ---------- 用户注释（词/句级，本机） ----------
   * ar.ua = { 经号: [ { b:段, s:起, e:止, h:内容, ts:时间 } ] }
   * 与莊春江的词注同一层显示，点开时一起列出。
   */
  function uaAll() {
    try { return JSON.parse(localStorage.getItem('ar.ua') || '{}'); } catch (e) { return {}; }
  }

  function uaFor(k, b) {
    var all = uaAll()[k] || [];
    return all.filter(function (x) { return x.b === b; });
  }

  function uaAdd(k, b, s, e, h) {
    var all = uaAll();
    var list = all[k] || (all[k] = []);
    var hit = list.filter(function (x) { return x.b === b && x.s === s && x.e === e; })[0];
    if (hit) { hit.h = h; hit.ts = Date.now(); }
    else list.push({ b: b, s: s, e: e, h: h, ts: Date.now() });
    localStorage.setItem('ar.ua', JSON.stringify(all));
  }

  function uaDel(k, ts) {
    var all = uaAll();
    all[k] = (all[k] || []).filter(function (x) { return x.ts !== ts; });
    if (!all[k].length) delete all[k];
    localStorage.setItem('ar.ua', JSON.stringify(all));
  }

  function loadAllSeries(onStep) {
    var todo = Object.keys(S.index.series).filter(function (s) { return !S.loaded[s]; });
    var done = 0;
    function next() {
      if (!todo.length) return Promise.resolve();
      var s = todo.shift();
      return loadSeries(s).then(function () {
        done++;
        if (onStep) onStep(done, done + todo.length);
        return next();
      });
    }
    return next();
  }

  /* 一条经属于哪个部，**不能看键前缀**：
   *   OTHER.中阿含56/彌醯經  属于 MA
   *   PAGE.Ap/Ap56.htm       属于 Ap
   * 这些页原站没按部编号，键就带了 OTHER/PAGE 前缀。以 canon 里的归属为准。 */
  function seriesOf(k) {
    if (S.owner && S.owner[k]) return S.owner[k];
    return String(k).split('.')[0];
  }

  /* ---------- 取一条经 ---------- */

  function entry(key) {
    var list = S.series[seriesOf(key)];
    if (!list) return null;
    for (var i = 0; i < list.length; i++) if (list[i].k === key) return list[i];
    return null;
  }

  /* ---------- 注标解析 ---------- */

  function notesFor(entry) {
    var page = entry.p;
    var pack = (S.noteIdx || {})[page] || { notes: {}, cmp: '' };
    var gloss = (S.notes && S.notes.glossary) || {};
    var out = [];
    entry.b.forEach(function (b) {
      var marks = [];
      (b.m || []).forEach(function (m) {
        var txt = m.k === 'n' ? gloss[m.r] : pack.notes[m.r];
        if (txt) marks.push({ o: m.o, n: m.n, k: m.k, r: m.r, h: txt });
      });
      out.push({ i: b.i, t: b.t, g: b.g, fp: b.fp, m: marks });
    });
    return { blocks: out, cmp: pack.cmp };
  }

  /* ---------- 巴利（3.5 MB，按需载一次） ---------- */

  var paliPromise = null;

  /* 巴利译文按「规范化整行」查；必须和 工具\挂巴利译文.py 的 norm() 一致 */
  function normPali(s) {
    s = String(s || '').replace(/\u3000/g, ' ').trim();
    s = s.replace(/^\d+\.\s*/, '');
    return s.replace(/\s+/g, ' ').trim();
  }

  function ensurePali() {
    if (S.pali) return Promise.resolve(S.pali);
    if (paliPromise) return paliPromise;
    paliPromise = loadGz(BASE + 'pali.json.gz').then(function (d) {
      S.pali = d;
      // 译文表是可选层：没有也照常读巴利原文
      return loadGz(BASE + 'pali.zh.json.gz').then(function (z) {
        S.paliZh = z;
      }).catch(function () {
        S.paliZh = null;
      }).then(function () {
        return d;
      });
    }).catch(function (e) {
      paliPromise = null;
      console.warn('巴利表載入失敗', e);
      return null;
    });
    return paliPromise;
  }

  /* 译文包 v2：byKey[key] 是 [{p: 巴利段, z: 中文段}]，直接采用译者段落对。
   * 用户覆盖 ar.palizh 仍按「规范化巴利行」存，合并时优先于内置。 */
  function paliPairsOf(key) {
    var raw = (S.paliZh && S.paliZh.byKey && S.paliZh.byKey[key]) || null;
    var over = (S.paliOver && S.paliOver[key]) || {};
    if (!raw) return null;
    var out = [];
    if (Array.isArray(raw)) {
      raw.forEach(function (pair) {
        var line = normPali(pair.p);
        out.push({ p: pair.p, z: (over[line] != null) ? over[line] : (pair.z || ''),
                   pey: pair.pey ? 1 : 0 });
      });
    } else {
      // 旧格式兼容：规范行 -> 中文
      Object.keys(raw).forEach(function (line) {
        out.push({ p: line, z: (over[line] != null) ? over[line] : raw[line], pey: 0 });
      });
    }
    return out;
  }

  function paliFor(entry) {
    if (!S.pali) return { blocks: [], decl: [], zh: null, pairs: null };
    var ids = (S.pali.key && S.pali.key[entry.k]) || (S.pali.page && S.pali.page[entry.p]) || [];
    var blocks = [], decl = [];
    ids.forEach(function (h) {
      if (S.pali.blocks[h]) blocks.push(S.pali.blocks[h]);
      if (S.pali.decl && S.pali.decl[h]) decl.push(S.pali.decl[h]);
    });

    /* 北传经的巴利块是「对读本」，例如 SA.1 的巴利原文是
     * SN.22.12／13／14／51。直译必须按这些对读本的经号合并，
     * 不能只查 entry.k（SA.1 本身没有直译）。 */
    var keys = [];
    var seen = {};
    (decl.length ? decl : [entry.k]).forEach(function (k) {
      if (!k || seen[k]) return;
      seen[k] = 1;
      keys.push(k);
    });

    var overEntry = (S.paliOver && S.paliOver[entry.k]) || {};
    var pairs = [];
    keys.forEach(function (k) {
      var ps = paliPairsOf(k);
      if (!ps) return;
      ps.forEach(function (x) {
        var n = normPali(x.p);
        if (overEntry[n] != null) x = { p: x.p, z: overEntry[n], pey: x.pey };
        pairs.push(x);
      });
    });
    if (!pairs.length) pairs = null;

    var zh = {};
    if (pairs) {
      pairs.forEach(function (x) {
        var n = normPali(x.p);
        if (x.z) zh[n] = x.z;
      });
    }
    Object.keys(overEntry).forEach(function (n) { if (overEntry[n]) zh[n] = overEntry[n]; });
    return {
      blocks: blocks, decl: decl, pairs: pairs,
      zh: Object.keys(zh).length ? zh : null
    };
  }

  function setPaliOverrides(map) {
    S.paliOver = map || {};
  }

  /* 给导出用：内置直译 + 用户覆盖，按经号取（规范行 -> 中文） */
  function paliZhOf(key) {
    var pairs = paliPairsOf(key);
    var over = (S.paliOver && S.paliOver[key]) || {};
    var out = {};
    if (pairs) {
      pairs.forEach(function (x) {
        var n = normPali(x.p);
        if (x.z) out[n] = x.z;
      });
    }
    Object.keys(over).forEach(function (n) { if (over[n]) out[n] = over[n]; });
    return Object.keys(out).length ? out : null;
  }

  /* ---------- 对读 ---------- */

  function xrefOf(key) {
    if (!S.xref || !S.xref.edges) return [];
    return S.xref.edges[key] || [];
  }

  function groupOf(key) {
    if (!S.xref || !S.xref.groups) return null;
    for (var i = 0; i < S.xref.groups.length; i++) {
      if (S.xref.groups[i].indexOf(key) >= 0) return S.xref.groups[i];
    }
    return null;
  }

  /* ---------- 搜索 ---------- */

  function search(q, opts) {
    opts = opts || {};
    q = (q || '').trim();
    if (!q) return [];
    var qSimp = toSimp(q);
    var hits = [];
    var seriesList = opts.series
      ? (Array.isArray(opts.series) ? opts.series : [opts.series])
      : Object.keys(S.series);
    seriesList.forEach(function (s) {
      (S.series[s] || []).forEach(function (e) {
        for (var i = 0; i < e.b.length; i++) {
          var t = e.b[i].t;
          // 数据存繁体：先用原文查（繁体输入），不中再把正文转简体查一遍
          var at = t.indexOf(q);
          var text = t, used = q;
          if (at < 0) {
            text = toSimp(t);
            at = text.indexOf(qSimp);
            used = qSimp;
          }
          if (at >= 0) {
            hits.push({
              k: e.k, s: s,
              n: (e.h && e.h.nm) || e.k,
              blk: e.b[i].i,
              at: at,
              q: used,
              snip: snippet(text, at, used.length)
            });
            return;
          }
        }
      });
    });
    return hits;
  }

  function snippet(t, at, len) {
    var a = Math.max(0, at - 24), b = Math.min(t.length, at + len + 40);
    return (a > 0 ? '…' : '') + t.slice(a, b) + (b < t.length ? '…' : '');
  }

  /* ---------- 引用导出 ---------- */

  function quote(entry, blocks) {
    var h = entry.h || {};
    var head = (h.nm || entry.k) + (h.alt && h.alt.length ? '（' + h.alt.join('／') + '）' : '');
    var body = blocks.map(function (b) { return b.t; }).join('\n');
    return head + '\n' + body + '\n\n——《' + (h.nm || entry.k) + '》' + entry.k +
      (h.tr ? '（' + h.tr + '）' : '');
  }

  /* ---------- 目录辅助 ---------- */

  function groupList(gid) {
    for (var i = 0; i < (S.canon ? S.canon.groups.length : 0); i++) {
      if (S.canon.groups[i].id === gid) return S.canon.groups[i];
    }
    return null;
  }

  function countOf(node) {
    if (!node.c) return 1;
    var n = 0;
    for (var i = 0; i < node.c.length; i++) n += countOf(node.c[i]);
    return n;
  }

  return {
    S: S,
    boot: boot,
    toSimp: toSimp,
    conv: conv,
    setLang: setLang,
    lang: lang,
    loadSeries: loadSeries,
    loadTrans: loadTrans,
    setTransSet: setTransSet,
    transSet: transSet,
    TRANS_SETS: TRANS_SETS,
    hasTransSet: hasTransSet,
    ensureTransSet: ensureTransSet,
    setTrOverride: setTrOverride,
    trOverride: trOverride,
    transOf: transOf,
    hasTrans: hasTrans,
    uaAll: uaAll,
    uaFor: uaFor,
    uaAdd: uaAdd,
    uaDel: uaDel,
    loadAllSeries: loadAllSeries,
    seriesOf: seriesOf,
    entry: entry,
    notesFor: notesFor,
    ensurePali: ensurePali,
    paliFor: paliFor,
    setPaliOverrides: setPaliOverrides,
    paliZhOf: paliZhOf,
    normPali: normPali,
    xrefOf: xrefOf,
    groupOf: groupOf,
    search: search,
    quote: quote,
    groupList: groupList,
    countOf: countOf,
    walk: walk
  };
})();

if (typeof module !== 'undefined') module.exports = AR;
