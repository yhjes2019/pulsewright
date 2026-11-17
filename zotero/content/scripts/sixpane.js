/*
 * Pulsewright for Zotero — the Six Questions pane.
 *
 * Mounted as an ItemPane section. Reads only: it never writes to your
 * bibliography, only to a child note that carries the SIX_MARK comment.
 */
var PulsewrightSix = (function () {
  'use strict';

  var MENU_ID = 'pulsewright-six-menu';
  var CTX_ID = 'pulsewright-six-context';
  var BUTTON_ID = 'pulsewright-six-button';
  var KEY_ID = 'pulsewright-six-key';
  var STYLE_ID = 'pulsewright-style';
  var CACHE_TTL = 30000;
  var POOL_CAP = 4000;

  var core = null;
  var cfg = { pluginID: 'pulsewright@luo.dev', version: '' };
  var cache = { libID: null, at: 0, metas: [], docs: [], index: new Map() };

  var CSS = [
    '.pw-root{font-size:13px;line-height:1.55;padding:2px 0 18px;color:var(--fill-primary,#1a1a1a);}',
    '.pw-sec{border-top:1px solid var(--fill-quinary,rgba(128,128,128,.22));padding:11px 0 5px;}',
    '.pw-sec:first-child{border-top:0;padding-top:2px;}',
    '.pw-h{display:flex;align-items:baseline;gap:7px;margin-bottom:7px;}',
    '.pw-n{font-size:10px;font-weight:700;letter-spacing:.06em;color:var(--fill-secondary,#8a8a8a);min-width:10px;}',
    '.pw-t{font-size:12px;font-weight:700;}',
    '.pw-sub{font-size:11px;color:var(--fill-secondary,#8a8a8a);margin-left:auto;}',
    '.pw-meta{font-size:11.5px;color:var(--fill-secondary,#8a8a8a);margin-bottom:6px;}',
    '.pw-abs{font-size:12px;color:var(--fill-secondary,#8a8a8a);white-space:pre-wrap;max-height:4.6em;overflow:hidden;position:relative;}',
    '.pw-abs.pw-open{max-height:none;}',
    '.pw-more{font-size:11px;color:var(--accent-blue,#0a84ff);cursor:pointer;user-select:none;margin-top:3px;display:inline-block;}',
    '.pw-ta{width:100%;box-sizing:border-box;min-height:62px;resize:vertical;font:inherit;font-size:12px;line-height:1.5;',
    'padding:6px 8px;border-radius:6px;border:1px solid var(--fill-quinary,rgba(128,128,128,.35));',
    'background:var(--material-background,transparent);color:inherit;}',
    '.pw-ta:focus{outline:2px solid var(--accent-blue,#0a84ff);outline-offset:-1px;}',
    '.pw-row{display:flex;align-items:center;gap:8px;margin-top:6px;flex-wrap:wrap;}',
    '.pw-btn{font:inherit;font-size:11.5px;padding:3px 10px;border-radius:5px;cursor:pointer;',
    'border:1px solid var(--fill-quinary,rgba(128,128,128,.35));background:transparent;color:inherit;}',
    '.pw-btn:hover{background:var(--fill-quinary,rgba(128,128,128,.18));}',
    '.pw-btn.pw-primary{border-color:transparent;background:var(--accent-blue,#0a84ff);color:#fff;}',
    '.pw-btn.pw-primary:hover{filter:brightness(1.08);}',
    '.pw-btn[disabled]{opacity:.45;cursor:default;}',
    '.pw-note{font-size:11px;color:var(--fill-secondary,#8a8a8a);}',
    '.pw-ok{color:var(--accent-green,#2aa65c);}',
    '.pw-chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:7px;}',
    '.pw-chip{font-size:11px;padding:1px 7px;border-radius:10px;',
    'background:var(--fill-quinary,rgba(128,128,128,.16));color:var(--fill-secondary,#7a7a7a);white-space:nowrap;}',
    '.pw-hit{display:block;padding:6px 8px;margin:0 -8px;border-radius:6px;cursor:pointer;}',
    '.pw-hit:hover{background:var(--fill-quinary,rgba(128,128,128,.16));}',
    '.pw-hit-t{font-size:12px;line-height:1.4;margin-bottom:2px;}',
    '.pw-hit-m{font-size:10.5px;color:var(--fill-secondary,#8a8a8a);display:flex;align-items:center;gap:6px;}',
    '.pw-bar{flex:0 0 44px;height:3px;border-radius:2px;background:var(--fill-quinary,rgba(128,128,128,.28));overflow:hidden;}',
    '.pw-bar i{display:block;height:100%;background:var(--accent-blue,#0a84ff);border-radius:2px;}',
    '.pw-tbl{width:100%;border-collapse:collapse;font-size:11.5px;}',
    '.pw-tbl th,.pw-tbl td{text-align:left;padding:3px 6px 3px 0;vertical-align:top;}',
    '.pw-tbl th{font-weight:600;color:var(--fill-secondary,#8a8a8a);font-size:10.5px;white-space:nowrap;width:42px;}',
    '.pw-tbl td{color:var(--fill-primary,#1a1a1a);}',
    '.pw-kv{display:flex;gap:14px;flex-wrap:wrap;margin-top:4px;}',
    '.pw-kv div{font-size:11.5px;}',
    '.pw-kv b{font-weight:700;font-size:13px;}',
    '.pw-empty{font-size:12px;color:var(--fill-secondary,#8a8a8a);padding:8px 0;}',
    '.pw-hist{display:flex;align-items:flex-end;gap:3px;height:34px;margin-top:8px;}',
    '.pw-hist i{flex:1;min-width:3px;background:var(--accent-blue,#0a84ff);opacity:.55;border-radius:1px 1px 0 0;}',
    '.pw-hist i.pw-zero{opacity:.14;height:2px!important;}',
    '.pw-panel{display:flex;flex-direction:column;}',
    '.pw-panel-card{position:relative;width:680px;max-height:calc(100vh - 150px);display:flex;flex-direction:column;border-radius:14px;overflow:hidden;font-family:inherit;color:var(--fill-primary,#1a1a1a);background:color-mix(in srgb,var(--material-background,#fff) 84%,transparent);backdrop-filter:blur(24px) saturate(170%);-webkit-backdrop-filter:blur(24px) saturate(170%);border:1px solid color-mix(in srgb,currentColor 12%,transparent);box-shadow:0 26px 70px rgba(0,0,0,.55),0 1px 0 rgba(255,255,255,.07) inset;transform-origin:50% 0;opacity:0;transform:translateY(-6px) scale(.975);transition:opacity .2s cubic-bezier(.2,.8,.2,1),transform .24s cubic-bezier(.2,.8,.2,1);will-change:opacity,transform;}',
    '.pw-panel-card.pw-in{opacity:1;transform:none;}',
    '.pw-panel-card::before{content:"";position:absolute;left:0;right:0;top:0;height:1px;background:linear-gradient(90deg,transparent,rgba(124,156,255,.9),rgba(78,205,196,.9),transparent);}',
    '.pw-panel-card::after{content:"";position:absolute;left:-20%;right:-20%;top:-150px;height:210px;pointer-events:none;background:radial-gradient(50% 100% at 50% 100%,rgba(124,156,255,.20),transparent 72%);}',
    '.pw-panel-head{position:relative;z-index:1;display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid color-mix(in srgb,currentColor 12%,transparent);}',
    '.pw-panel-title{font-size:14px;font-weight:700;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.pw-panel-nav{display:flex;gap:4px;margin-left:auto;align-items:center;}',
    '.pw-nav-btn{font-size:12px;cursor:pointer;padding:4px 9px;border-radius:6px;border:1px solid rgba(128,128,128,.28);color:inherit;opacity:.78;user-select:none;transition:opacity .15s ease,background .15s ease,transform .12s ease;}',
    '.pw-nav-btn:hover{opacity:1;background:rgba(128,128,128,.16);}',
    '.pw-nav-btn:active{transform:scale(.96);}',
    '.pw-panel-close{font-size:12px;cursor:pointer;padding:4px 10px;border-radius:6px;border:1px solid rgba(128,128,128,.35);user-select:none;transition:background .15s ease,transform .12s ease;}',
    '.pw-panel-close:hover{background:rgba(128,128,128,.16);}',
    '.pw-panel-body{position:relative;z-index:1;padding:6px 18px 18px;overflow:auto;scrollbar-gutter:stable;max-height:470px;}',
    '.pw-anim .pw-sec{opacity:0;transform:translateY(7px);animation:pw-rise .36s cubic-bezier(.2,.8,.2,1) forwards;}',
    '.pw-anim .pw-sec:nth-child(1){animation-delay:.05s}',
    '.pw-anim .pw-sec:nth-child(2){animation-delay:.09s}',
    '.pw-anim .pw-sec:nth-child(3){animation-delay:.13s}',
    '.pw-anim .pw-sec:nth-child(4){animation-delay:.17s}',
    '.pw-anim .pw-sec:nth-child(5){animation-delay:.21s}',
    '.pw-anim .pw-sec:nth-child(6){animation-delay:.25s}',
    '.pw-anim .pw-sec:nth-child(7){animation-delay:.29s}',
    '@keyframes pw-rise{to{opacity:1;transform:none;}}',
    '@media (prefers-reduced-motion: reduce){.pw-panel-card{transition:none;opacity:1;transform:none;}.pw-anim .pw-sec{animation:none;opacity:1;transform:none;}}',
    '.pw-panel-card{box-shadow:0 26px 70px rgba(0,0,0,.55),0 0 0 1px rgba(124,156,255,.16),0 0 60px -10px rgba(124,156,255,.35),0 1px 0 rgba(255,255,255,.07) inset;}',
    '.pw-panel-card>.pw-panel-glow{position:absolute;right:-80px;top:-120px;width:320px;height:320px;pointer-events:none;border-radius:50%;background:radial-gradient(circle,rgba(78,205,196,.18),transparent 68%);}',
    '.pw-n{background:linear-gradient(180deg,#7c9cff,#4ecdc4);-webkit-background-clip:text;background-clip:text;color:transparent;}',
    '.pw-root textarea:focus{outline:none;border-color:rgba(124,156,255,.75)!important;box-shadow:0 0 0 3px rgba(124,156,255,.18);}',
    '.pw-chip{transition:background .15s ease,transform .12s ease;}',
    '.pw-chip:hover{background:rgba(124,156,255,.16);}',
    '.pw-panel-body::-webkit-scrollbar{width:8px;}',
    '.pw-panel-body::-webkit-scrollbar-thumb{background:rgba(128,128,128,.32);border-radius:4px;}',
    '.pw-panel-body::-webkit-scrollbar-thumb:hover{background:rgba(128,128,128,.5);}',
    '.pw-panel-card.pw-mat-solid{background:var(--material-background,#fff);backdrop-filter:none;-webkit-backdrop-filter:none;}',
    '.pw-panel-card.pw-mat-glass{background:color-mix(in srgb,var(--material-background,#fff) 84%,transparent);}',
    '.pw-panel-card.pw-mat-acrylic{background:color-mix(in srgb,var(--material-background,#fff) 74%,transparent);backdrop-filter:blur(30px) saturate(190%);-webkit-backdrop-filter:blur(38px) saturate(210%);}',
    '.pw-panel-bar{position:relative;z-index:1;display:flex;align-items:center;gap:10px;padding:0 18px 11px;}',
    '.pw-panel-sub{font-size:11.5px;opacity:.6;}',
    '.pw-mats{display:flex;gap:2px;margin-left:auto;padding:3px;border-radius:9px;background:color-mix(in srgb,currentColor 7%,transparent);}',
    '.pw-mat{padding:2px 10px;border-radius:7px;font-size:11.5px;line-height:1.7;cursor:pointer;opacity:.62;transition:opacity .15s,background .15s;}',
    '.pw-mat:hover{opacity:1;}',
    '.pw-mat.on{opacity:1;font-weight:600;background:color-mix(in srgb,#7c9cff 30%,transparent);}',
    '.pw-pill{margin-left:auto;font-size:10.5px;padding:1px 8px;border-radius:99px;opacity:.72;background:color-mix(in srgb,currentColor 8%,transparent);white-space:nowrap;}',
    '.pw-pill.todo{background:color-mix(in srgb,#ffbf00 24%,transparent);opacity:1;}',
    '.pw-pill.done{background:color-mix(in srgb,#41ba41 26%,transparent);opacity:1;}',
    '.pw-reasons{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;}',
    '.pw-reason{font-size:11.5px;padding:2px 10px;border-radius:99px;cursor:pointer;border:1px dashed color-mix(in srgb,currentColor 24%,transparent);opacity:.82;transition:background .15s,opacity .15s;}',
    '.pw-reason:hover{background:color-mix(in srgb,#7c9cff 20%,transparent);opacity:1;}',
    '.pw-prog{height:3px;border-radius:2px;background:color-mix(in srgb,currentColor 12%,transparent);margin-top:7px;overflow:hidden;}',
    '.pw-prog>i{display:block;height:100%;width:0;background:linear-gradient(90deg,#7c9cff,#4ecdc4);transition:width .32s cubic-bezier(.2,.8,.2,1);}',
    '.pw-acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;padding-top:10px;border-top:1px dashed color-mix(in srgb,currentColor 14%,transparent);}',
    '.pw-empty-cta{margin-top:10px;}',
    '@supports not (backdrop-filter: blur(1px)){.pw-panel-card{background:var(--material-background,#fff);}}',
  ].join('');

  /* ---------------------------------------------------------------- dom */

  // Zotero's main window is a XUL document, so createElement() yields XUL
  // elements that carry no HTML layout. Everything visual must be created in
  // the XHTML namespace explicitly.
  var XHTML = 'http://www.w3.org/1999/xhtml';

  var MATERIAL_KEY = 'pulsewright.material';
  var MATERIALS = [['glass', '毛玻璃'], ['acrylic', '亚克力']];

  function materialNow() {
    var v = 'glass';
    try { v = Zotero.Prefs.get(MATERIAL_KEY, true) || 'glass'; } catch (e) { /* first run */ }
    if (v === 'solid') v = 'glass';   // retired option
    for (var i = 0; i < MATERIALS.length; i++) {
      if (MATERIALS[i][0] === v) return v;
    }
    return 'glass';
  }

  // The three materials are the same vocabulary the Obsidian end uses, so a
  // user who set one to acrylic there finds the same word here.
  // Zotero's Gecko has no color-mix(), so every surface that needs a
  // translucent version of the theme colour is computed here instead of in CSS.
  function parseColor(str) {
    if (!str) return null;
    var t = String(str).trim();
    var m = t.match(/^#([0-9a-f]{6})$/i);
    if (m) {
      var v = parseInt(m[1], 16);
      return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
    }
    m = t.match(/^rgba?\(([^)]+)\)$/i);
    if (m) {
      var parts = m[1].split(/[,\s\/]+/).filter(Boolean);
      if (parts.length >= 3) {
        return [parseInt(parts[0], 10) || 0, parseInt(parts[1], 10) || 0, parseInt(parts[2], 10) || 0];
      }
    }
    return null;
  }

  function themeColor(win, name, fallback) {
    try {
      var raw = win.getComputedStyle(win.document.documentElement).getPropertyValue(name);
      return parseColor(raw) || fallback;
    } catch (e) {
      return fallback;
    }
  }

  function setMaterial(card, key) {
    var win = card.ownerDocument.defaultView;
    var base = themeColor(win, '--material-background', null) ||
               themeColor(win, '--fill-primary', null) || [38, 39, 43];
    // A dark-on-dark theme needs a lighter plate than the theme colour to read
    // as a panel, so the tint leans on the window background when it exists.
    var plate = themeColor(win, '--background-primary', base) === base ? base : base;
    var alpha = key === 'glass' ? 0.88 : 0.74;
    var blur = key === 'glass' ? 'blur(22px) saturate(165%)' : 'blur(34px) saturate(200%)';

    card.style.backgroundColor = 'rgba(' + plate[0] + ',' + plate[1] + ',' + plate[2] + ',' + alpha + ')';
    card.style.backdropFilter = blur;
    card.style.webkitBackdropFilter = blur;
    // On a dark desktop the opacity difference alone is nearly invisible, so
    // each material also changes its edge and, for acrylic, the grain.
    card.style.boxShadow = key === 'acrylic'
      ? '0 30px 80px rgba(0,0,0,.6), inset 0 1px 0 rgba(255,255,255,.16), inset 0 0 0 1px rgba(124,156,255,.22)'
      : '0 26px 70px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.08)';
    card.style.backgroundImage = key === 'acrylic'
      ? 'repeating-linear-gradient(0deg, rgba(255,255,255,.05) 0 1px, transparent 1px 3px), repeating-linear-gradient(90deg, rgba(255,255,255,.035) 0 1px, transparent 1px 3px)'
      : 'none';

    MATERIALS.forEach(function (m) { card.classList.remove('pw-mat-' + m[0]); });
    card.classList.add('pw-mat-' + key);
    try { Zotero.Prefs.set(MATERIAL_KEY, key, true); } catch (e) { /* read-only pref */ }

    var nodes = card.querySelectorAll('.pw-mat');
    for (var k = 0; k < nodes.length; k++) {
      var on = nodes[k].getAttribute('data-mat') === key;
      if (on) nodes[k].classList.add('on');
      else nodes[k].classList.remove('on');
    }
  }

  function mark(sec, kind, text) {
    var h = sec && sec.querySelector('.pw-h');
    if (!h) return;
    var p = mk(sec.ownerDocument, 'span');
    p.className = 'pw-pill' + (kind === 'todo' ? ' todo' : kind === 'done' ? ' done' : '');
    p.textContent = text;
    h.appendChild(p);
  }

  function mk(doc, tag) {
    try { return doc.createElementNS(XHTML, tag); }
    catch (e) { return doc.createElement(tag); }
  }

  function el(doc, tag, cls, text) {
    var n = mk(doc, tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }

  function injectStyle(doc) {
    if (!doc) return;
    var old = doc.getElementById(STYLE_ID);
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var s = mk(doc, 'style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    var host = doc.head || doc.documentElement;
    if (!host) return;
    host.appendChild(s);
  }

  /* -------------------------------------------------------------- data */

  function safeField(item, name) {
    try { return item.getField(name) || ''; } catch (e) { return ''; }
  }

  function metaOf(item) {
    var pub = '';
    var keys = ['publicationTitle', 'bookTitle', 'proceedingsTitle', 'websiteTitle', 'publisher'];
    for (var i = 0; i < keys.length; i++) {
      var v = safeField(item, keys[i]);
      if (v) { pub = v; break; }
    }
    var tags = [];
    try { tags = item.getTags().map(function (t) { return t.tag; }); } catch (e) { tags = []; }
    var nAtt = 0;
    try { nAtt = item.numAttachments(); } catch (e) { nAtt = 0; }
    return {
      id: item.id,
      key: item.key,
      itemType: item.itemType,
      title: safeField(item, 'title'),
      abstractNote: safeField(item, 'abstractNote'),
      publicationTitle: pub,
      date: safeField(item, 'date'),
      DOI: safeField(item, 'DOI'),
      tags: tags,
      dateAdded: item.dateAdded || '',
      numAttachments: nAtt
    };
  }

  var pending = null;
  var poolTimer = null;
  var notifierID = null;
  var lastRoot = null;
  var lastBody = null;

  function emptyPool(libID) {
    return { libID: libID, at: 0, metas: [], docs: [], index: new Map(), ready: false };
  }

  function poolNow(libID) {
    var now = Date.now();
    if (cache.libID === libID && now - cache.at < CACHE_TTL) return cache;
    return null;
  }

  // Zotero.Items.getAll() is async. The earlier synchronous call only ever
  // threw, the throw was swallowed, and the pool stayed empty forever, so
  // every "related" section claimed the library had nothing similar.
  function loadPool(libID) {
    if (pending && pending.libID === libID) return pending.promise;
    var p = Zotero.Items.getAll(libID, true, false).then(function (items) {
      var list = (items || []).filter(function (it) { return it.isRegularItem(); });
      if (list.length > POOL_CAP) list = list.slice(0, POOL_CAP);
      var metas = list.map(metaOf);
      var docs = core.buildDocs(metas);
      var index = new Map();
      for (var i = 0; i < metas.length; i++) index.set(String(metas[i].id), i);
      cache = { libID: libID, at: Date.now(), metas: metas, docs: docs, index: index, ready: true };
      pending = null;
      return cache;
    }).catch(function (e) {
      pending = null;
      Zotero.logError(e);
      return null;
    });
    pending = { libID: libID, promise: p };
    return p;
  }

  function collectAnnotations(item) {
    var out = [];
    var atts = [];
    try { atts = item.getAttachments() || []; } catch (e) { atts = []; }
    var maxPage = 0;
    var fileAttID = null;
    for (var i = 0; i < atts.length; i++) {
      var att = Zotero.Items.get(atts[i]);
      if (!att) continue;
      try { if (!att.isFileAttachment()) continue; } catch (e) { continue; }
      if (!fileAttID) fileAttID = atts[i];
      var anns = [];
      try { anns = att.getAnnotations() || []; } catch (e) { continue; }
      for (var j = 0; j < anns.length; j++) {
        var a = anns[j];
        var page = null;
        try {
          page = core.pageIndexOf({ annotationPosition: a.annotationPosition });
        } catch (e) { page = null; }
        if (typeof page === 'number' && page + 1 > maxPage) maxPage = page + 1;
        out.push({
          pageIndex: page,
          comment: a.annotationComment || '',
          color: a.annotationColor || '',
          type: a.annotationType || 'highlight'
        });
      }
    }
    return { anns: out, pages: Math.max(maxPage, 1), attachmentID: fileAttID };
  }

  function readSixNote(item) {
    var notes = [];
    try { notes = item.getNotes() || []; } catch (e) { notes = []; }
    for (var i = 0; i < notes.length; i++) {
      var n = Zotero.Items.get(notes[i]);
      if (!n) continue;
      var html = '';
      try { html = n.getNote() || ''; } catch (e) { html = ''; }
      var parsed = core.parseSixNote(html);
      if (parsed) return { note: n, data: parsed };
    }
    return null;
  }

  function saveSixNote(item, why, questions) {
    var html = core.sixNoteHtml(why, questions);
    var existing = readSixNote(item);
    if (existing) {
      existing.note.setNote(html);
      return existing.note.saveTx().then(function () { return existing.note; });
    }
    var note = new Zotero.Item('note');
    note.libraryID = item.libraryID;
    note.parentID = item.id;
    note.setNote(html);
    return note.saveTx().then(function () { return note; });
  }

  function openItem(id) {
    try {
      Zotero.getActiveZoteroPane().selectItem(id);
    } catch (e) {
      Zotero.debug('[Pulsewright] selectItem failed: ' + e);
    }
  }

  /* --------------------------------------------------------------- ui */

  function section(doc, root, num, title, sub) {
    var sec = el(doc, 'div', 'pw-sec');
    var h = el(doc, 'div', 'pw-h');
    h.appendChild(el(doc, 'span', 'pw-n', String(num)));
    h.appendChild(el(doc, 'span', 'pw-t', title));
    if (sub) h.appendChild(el(doc, 'span', 'pw-sub', sub));
    sec.appendChild(h);
    root.appendChild(sec);
    return sec;
  }

  function hit(doc, meta, score, why) {
    var row = el(doc, 'div', 'pw-hit');
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.appendChild(el(doc, 'div', 'pw-hit-t', meta.title || '(无标题)'));
    var m = el(doc, 'div', 'pw-hit-m');
    m.appendChild(el(doc, 'span', null, core.describeItem(meta).head || ''));
    if (score != null) {
      var bar = el(doc, 'div', 'pw-bar');
      var fill = mk(doc, 'i');
      fill.setAttribute('style', 'width:' + Math.max(4, Math.round(score * 100)) + '%');
      bar.appendChild(fill);
      m.appendChild(bar);
    }
    if (why) m.appendChild(el(doc, 'span', null, why));
    row.appendChild(m);
    row.addEventListener('click', function () { openItem(meta.id); });
    row.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openItem(meta.id); }
    });
    return row;
  }

  function renderItem(doc, root, item, pool) {
    pool = pool || emptyPool(item.libraryID);
    var meta = metaOf(item);
    var annInfo = collectAnnotations(item);
    var annProfile = core.annotationProfile(annInfo.anns, annInfo.pages);
    var six = readSixNote(item);

    var ranked = [];
    try { ranked = core.similarItems(pool.docs, item.id, 8); } catch (e) { ranked = []; }
    var rankedMetas = ranked.map(function (r) {
      var i = pool.index.get(String(r.id));
      return { meta: i == null ? null : pool.metas[i], score: r.score };
    }).filter(function (r) { return r.meta; });

    var ctx = {
      collections: [],
      annotationTotal: annProfile.total,
      annotationWithComment: annProfile.withComment,
      similarCount: rankedMetas.length
    };
    try {
      ctx.collections = (item.getCollections() || []).map(function (id) {
        var c = Zotero.Collections.get(id);
        return c ? c.name : '';
      }).filter(Boolean);
    } catch (e) { ctx.collections = []; }

    /* 1 — what is this */
    var s1 = section(doc, root, 1, '这本文献讲了什么');
    var d = core.describeItem(meta);
    s1.appendChild(el(doc, 'div', 'pw-meta', d.head || ''));
    if (d.hasAbstract) {
      var abs = el(doc, 'div', 'pw-abs', d.abstract);
      s1.appendChild(abs);
      var more = el(doc, 'span', 'pw-more', '展开摘要');
      more.addEventListener('click', function () {
        var open = abs.classList.toggle('pw-open');
        more.textContent = open ? '收起' : '展开摘要';
      });
      s1.appendChild(more);
    } else {
      s1.appendChild(el(doc, 'div', 'pw-note', '这条没有摘要 — 打开原文读第一段，再回来写第 2 问。'));
    }

    mark(s1, d.hasAbstract ? 'auto' : 'todo', d.hasAbstract ? '自动带出' : '要读原文');

    /* 2 — why I picked it */
    var s2 = section(doc, root, 2, '我为什么选它');
    var whyTa = mk(doc, 'textarea');
    whyTa.className = 'pw-ta';
    whyTa.setAttribute('placeholder', '一句话就够：我想搞清……');
    whyTa.value = six ? six.data.why : '';
    s2.appendChild(whyTa);
    mark(s2, six && six.data.why ? 'done' : 'todo', six && six.data.why ? '已答' : '待你写');
    var reasons = el(doc, 'div', 'pw-reasons');
    ['导师推荐', '综述里引到', '方法可借鉴', '想复现这个实验'].forEach(function (t) {
      var chipR = el(doc, 'span', 'pw-reason', '+ ' + t);
      chipR.addEventListener('click', function () {
        var cur = String(whyTa.value || '').trim();
        if (cur.indexOf(t) !== -1) return;
        whyTa.value = cur ? cur.replace(/[；;]\s*$/, '') + '；' + t : t;
        try { whyTa.focus(); } catch (e) { /* ignore */ }
      });
      reasons.appendChild(chipR);
    });
    s2.appendChild(reasons);
    var hints = core.whyHints(meta, ctx);
    if (hints.length) {
      var chips = el(doc, 'div', 'pw-chips');
      hints.forEach(function (h) { chips.appendChild(el(doc, 'span', 'pw-chip', h)); });
      s2.appendChild(chips);
    }

    /* 3 — related */
    var s3 = section(doc, root, 3, '库里有相关的吗', rankedMetas.length ? rankedMetas.length + ' 篇' : '');
    if (!rankedMetas.length) {
      s3.appendChild(el(doc, 'div', 'pw-note', '库里还没有和它词面相近的条目。多存几篇同主题的，这里会长出来。'));
    } else {
      rankedMetas.slice(0, 5).forEach(function (r) {
        s3.appendChild(hit(doc, r.meta, r.score, core.fmtPct(r.score, 0)));
      });
    }

    mark(s3, rankedMetas.length ? 'auto' : 'todo',
      rankedMetas.length ? '点一条可跳过去' : '库里还太少');

    /* 4 — better alternative? */
    var s4 = section(doc, root, 4, '有没有更优解');
    if (rankedMetas.length) {
      mark(s4, 'auto', rankedMetas.length > 1 ? '可换一篇对比' : '自动');
      var cmp = el(doc, 'div', 'pw-cmp');
      s4.appendChild(cmp);
      var altIdx = 0;
      var drawCmp = function () {
        cmp.textContent = '';
        var target = rankedMetas[altIdx % rankedMetas.length].meta;
        var facts = core.compareFacts(meta, target);
        var tbl = el(doc, 'table', 'pw-tbl');
        var thead = mk(doc, 'tr');
        ['', '这一篇', '对比这一篇'].forEach(function (t) {
          var th = mk(doc, 'th');
          th.textContent = t;
          thead.appendChild(th);
        });
        tbl.appendChild(thead);
        facts.forEach(function (f) {
          var tr = mk(doc, 'tr');
          var th = mk(doc, 'th');
          th.textContent = f.label;
          var td1 = mk(doc, 'td');
          td1.textContent = f.a;
          var td2 = mk(doc, 'td');
          td2.textContent = f.b;
          tr.appendChild(th); tr.appendChild(td1); tr.appendChild(td2);
          tbl.appendChild(tr);
        });
        cmp.appendChild(tbl);
        var af = core.alternativeFacts(meta, pool.metas);
        var kv = el(doc, 'div', 'pw-kv');
        [['更新', af.newer], ['更早', af.older], ['同类型', af.sameType], ['有摘要', af.withAbstract]].forEach(function (pc) {
          var cell = mk(doc, 'div');
          var b = mk(doc, 'b');
          b.textContent = String(pc[1]);
          cell.appendChild(b);
          cell.appendChild(doc.createTextNode(' ' + pc[0]));
          kv.appendChild(cell);
        });
        cmp.appendChild(kv);
        cmp.appendChild(hit(doc, target, null, '打开这一篇'));
      };
      drawCmp();
      if (rankedMetas.length > 1) {
        var swap = el(doc, 'button', 'pw-btn', '换一篇对比');
        swap.type = 'button';
        swap.addEventListener('click', function () {
          altIdx = (altIdx + 1) % rankedMetas.length;
          drawCmp();
        });
        var row4 = el(doc, 'div', 'pw-row');
        row4.appendChild(swap);
        s4.appendChild(row4);
      }
    } else {
      mark(s4, 'todo', '库里还太少');
      s4.appendChild(el(doc, 'div', 'pw-note', '库里没有可比的条目，这一问暂时答不了。多存两篇同方向的论文，这里会自动长出来。'));
    }

    /* 5 — questions after reading */
    var s5 = section(doc, root, 5, '读完还有哪些问题');
    var qTa = mk(doc, 'textarea');
    qTa.className = 'pw-ta';
    qTa.setAttribute('placeholder', '没搞懂的、想追的、怀疑的……');
    qTa.value = six ? six.data.questions : '';
    s5.appendChild(qTa);

    mark(s5, six && six.data.questions ? 'done' : 'todo', six && six.data.questions ? '已答' : '待你写');

    /* save bar (shared by 2 and 5) */
    var bar = el(doc, 'div', 'pw-row');
    var btn = el(doc, 'button', 'pw-btn pw-primary', '保存到子笔记');
    btn.type = 'button';
    var status = el(doc, 'span', 'pw-note', six ? '已有一份回答' : '还没有保存');
    btn.addEventListener('click', function () {
      btn.disabled = true;
      status.textContent = '保存中…';
      saveSixNote(item, whyTa.value, qTa.value).then(function () {
        status.textContent = '已保存';
        status.className = 'pw-note pw-ok';
        btn.disabled = false;
        cache.at = 0;
      }).catch(function (e) {
        status.textContent = '保存失败：' + (e && e.message ? e.message : e);
        status.className = 'pw-note';
        btn.disabled = false;
      });
    });
    bar.appendChild(btn);
    bar.appendChild(status);
    s5.appendChild(bar);

    /* 6 — what next */
    var s6 = section(doc, root, 6, '下一本该读什么');
    var nextPool = rankedMetas.filter(function (r) { return String(r.meta.id) !== String(item.id); });
    var next = core.nextCandidates(nextPool.map(function (r) {
      return { id: r.meta.id, score: r.score };
    }), [item.id], 3);
    if (!next.length) {
      s6.appendChild(el(doc, 'div', 'pw-note', '先把手头这篇读完 —— 库里的相近条目还不够多。'));
    } else {
      next.forEach(function (r) {
        var i = pool.index.get(String(r.id));
        if (i == null) return;
        var m = pool.metas[i];
        var whyBits = [];
        if (core.year4(m.date) && core.year4(m.date) > core.year4(meta.date)) whyBits.push('更新');
        if (m.abstractNote && !meta.abstractNote) whyBits.push('有摘要');
        if (m.itemType === meta.itemType) whyBits.push('同类型');
        s6.appendChild(hit(doc, m, r.score, whyBits.join(' · ')));
      });
    }

    mark(s6, next.length ? 'auto' : 'todo', next.length ? '按相似度排序' : '先多存几篇');

    /* reading profile */
    var s7 = section(doc, root, '·', '你的阅读痕迹');
    if (annProfile.total) {
      var kv2 = el(doc, 'div', 'pw-kv');
      [['批注', annProfile.total], ['写了想法', annProfile.withComment],
       ['前段', annProfile.front], ['中段', annProfile.middle], ['后段', annProfile.back]
      ].forEach(function (p) {
        var cell = mk(doc, 'div');
        var b = mk(doc, 'b');
        b.textContent = String(p[1]);
        cell.appendChild(b);
        cell.appendChild(doc.createTextNode(' ' + p[0]));
        kv2.appendChild(cell);
      });
      s7.appendChild(kv2);
      if (annProfile.withComment === 0) {
        s7.appendChild(el(doc, 'div', 'pw-note', '划了很多但没写想法 — 划重点不等于读懂。'));
      }
    } else {
      s7.appendChild(el(doc, 'div', 'pw-note', '这篇还没有批注。'));
    }
    if (meta.tags.length) {
      var chips2 = el(doc, 'div', 'pw-chips');
      meta.tags.slice(0, 8).forEach(function (t) { chips2.appendChild(el(doc, 'span', 'pw-chip', t)); });
      s7.appendChild(chips2);
    }

    // Things worth doing to the item itself, reachable without leaving the
    // panel: everything here is one click and lands on the real Zotero item.
    var acts = el(doc, 'div', 'pw-acts');
    var openBtn = el(doc, 'button', 'pw-btn', '在 Zotero 里打开');
    openBtn.type = 'button';
    openBtn.addEventListener('click', function () { openItem(item.id); });
    acts.appendChild(openBtn);
    if (meta.DOI) {
      var doiBtn = el(doc, 'button', 'pw-btn', '复制 DOI');
      doiBtn.type = 'button';
      doiBtn.addEventListener('click', function () {
        try { Zotero.Utilities.Internal.copyTextToClipboard(meta.DOI); doiBtn.textContent = '已复制'; } catch (e) { doiBtn.textContent = meta.DOI; }
        setTimeout(function () { doiBtn.textContent = '复制 DOI'; }, 1400);
      });
      acts.appendChild(doiBtn);
    }
    if (annProfile.total) {
      var nextAnn = el(doc, 'button', 'pw-btn', '看批注');
      nextAnn.type = 'button';
      nextAnn.addEventListener('click', function () {
        try { Zotero.getActiveZoteroPane().viewAttachment(annInfo.attachmentID, 'zotero'); } catch (e) { openItem(item.id); }
      });
      acts.appendChild(nextAnn);
    }
    s7.appendChild(acts);
  }

  function paint(doc, body, item, pool) {
    body.textContent = '';
    var root = el(doc, 'div', 'pw-root');
    body.appendChild(root);
    try {
      renderItem(doc, root, item, pool);
      lastRoot = root;
      lastBody = body;
    } catch (e) {
      Zotero.logError(e);
      root.appendChild(el(doc, 'div', 'pw-empty', '渲染出错：' + (e && e.message ? e.message : e)));
    }
    return root;
  }

  function onRender(props) {
    var doc = props.doc;
    var body = props.body;
    var item = props.item;

    if (!doc || !body) return;
    injectStyle(doc);
    if (!item) {
      body.textContent = '';
      var r0 = el(doc, 'div', 'pw-root');
      body.appendChild(r0);
      r0.appendChild(el(doc, 'div', 'pw-empty', '选中一条文献。'));
      return;
    }
    try {
      if (!item.isRegularItem()) {
        body.textContent = '';
        var r1 = el(doc, 'div', 'pw-root');
        body.appendChild(r1);
        r1.appendChild(el(doc, 'div', 'pw-empty', '六问只对文献条目显示。'));
        return;
      }
    } catch (e) { /* fall through */ }

    // Zotero swaps the section body between renders, so an async repaint would
    // land in a detached node and the pane would look empty. The pool is warmed
    // at registration and invalidated by the notifier instead, keeping this
    // path fully synchronous.
    paint(doc, body, item, poolNow(item.libraryID) || emptyPool(item.libraryID));
  }

  function onItemChange(props) {
    try {
      if (props.setEnabled) props.setEnabled(!!(props.item && props.item.isRegularItem()));
    } catch (e) { /* ignore */ }
  }

  var PANEL_ID = 'pulsewright-panel';

  // 精读很少只读一篇，所以「上一篇 / 下一篇」按文献列表当前的排序走，
  // 而不是按加入日期或标题重排——用户看到的顺序就是翻页的顺序。
  function siblingItems() {
    try {
      var zp = Zotero.getActiveZoteroPane();
      var items = (zp && zp.getSortedItems && zp.getSortedItems()) || [];
      var out = [];
      for (var i = 0; i < items.length; i++) {
        if (items[i] && items[i].isRegularItem && items[i].isRegularItem()) out.push(items[i]);
      }
      return out;
    } catch (e) { return []; }
  }

  function currentItem() {
    try {
      var zp = Zotero.getActiveZoteroPane();
      var sel = (zp && zp.getSelectedItems && zp.getSelectedItems()) || [];
      for (var i = 0; i < sel.length; i++) {
        if (sel[i] && sel[i].isRegularItem && sel[i].isRegularItem()) return sel[i];
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function closePanel(doc) {
    var old = doc && doc.getElementById(PANEL_ID);
    if (!old) return;
    try {
      if (old.__pwKeyWin && old.__pwKeyHandler) {
        old.__pwKeyWin.removeEventListener('keydown', old.__pwKeyHandler, true);
      }
    } catch (e) { /* window already gone */ }
    try { if (old.hidePopup) old.hidePopup(); } catch (e) { /* ignore */ }
    if (old.parentNode) old.parentNode.removeChild(old);
  }

  function addEntryPoints(win) {
    var doc = win && win.document;
    if (!doc) return;
    if (!doc.getElementById(BUTTON_ID)) {
      try {
        var bar = doc.getElementById('zotero-items-toolbar');
        if (bar) {
          var btn = doc.createXULElement('toolbarbutton');
          btn.id = BUTTON_ID;
          btn.className = 'zotero-tb-button';
          btn.setAttribute('tooltiptext', '六问');
          btn.style.listStyleImage = 'url("' + cfg.rootURI + 'content/icons/icon20.png")';
          btn.style.width = '22px';
          btn.style.height = '22px';
          btn.addEventListener('command', function () { openPanel(); });
          bar.appendChild(btn);
        }
      } catch (e) { Zotero.logError(e); }
    }
    if (!doc.getElementById(KEY_ID)) {
      try {
        // A <key> element only fires inside its keyset's focus scope, so the
        // shortcut is bound on the window itself instead.
        var keyset = doc.getElementById('mainKeyset') || doc.documentElement;
        var key = doc.createXULElement('key');
        key.id = KEY_ID;
        key.setAttribute('key', '6');
        key.setAttribute('modifiers', 'accel,shift');
        key.addEventListener('command', function () { openPanel(); });
        keyset.appendChild(key);
        if (!win.__pwKeys) {
          win.__pwKeys = function (ev) {
            if (!(ev.ctrlKey || ev.metaKey) || !ev.shiftKey) return;
            if (ev.key !== '6' && ev.code !== 'Digit6') return;
            ev.preventDefault();
            ev.stopPropagation();
            openPanel();
          };
          win.addEventListener('keydown', win.__pwKeys, true);
        }
      } catch (e) { Zotero.logError(e); }
    }
  }

  function removeEntryPoints(win) {
    var doc = win && win.document;
    if (!doc) return;
    var ids = [BUTTON_ID, KEY_ID];
    for (var i = 0; i < ids.length; i++) {
      var n = doc.getElementById(ids[i]);
      if (n && n.parentNode) n.parentNode.removeChild(n);
    }
  }

  // The six questions live in their own overlay rather than in the item pane:
  // Zotero 10 never materialises a plugin's custom item-pane section here, so
  // anything drawn into one is invisible. An overlay is plain DOM and always is.
  function openPanel() {
    var win = Zotero.getMainWindow();
    if (!win) return null;
    var doc = win.document;
    injectStyle(doc);
    closePanel(doc);

    var cur = currentItem();
    var panel = doc.createXULElement('panel');
    panel.id = PANEL_ID;
    panel.setAttribute('style', 'appearance:none;background:transparent;border:0;padding:0;');
    panel.setAttribute('noautohide', 'true');
    var wrap = mk(doc, 'div');
    wrap.className = 'pw-panel';

    var card = mk(doc, 'div');
    card.className = 'pw-panel-card';
    setMaterial(card, materialNow());
    // The popup box sizes itself once, at open time, and clips afterwards, so
    // the ceiling lives on the body instead of being measured here.
    var panelCap = 560;
    card.appendChild(mk(doc, 'div')).className = 'pw-panel-glow';

    var head = mk(doc, 'div');
    head.className = 'pw-panel-head';
    var title = mk(doc, 'div');
    title.className = 'pw-panel-title';
    title.textContent = cur ? ('六问 · ' + cur.getField('title')) : '六问';
    var close = mk(doc, 'div');
    close.className = 'pw-panel-close';
    close.textContent = '关闭';
    close.addEventListener('click', function () { closePanel(doc); });
    var nav = mk(doc, 'div');
    nav.className = 'pw-panel-nav';
    var btnPrev = el(doc, 'span', 'pw-nav-btn', '‹ 上一篇');
    var btnNext = el(doc, 'span', 'pw-nav-btn', '下一篇 ›');
    btnPrev.setAttribute('title', '同一列表里的上一篇');
    btnNext.setAttribute('title', '同一列表里的下一篇');
    btnPrev.addEventListener('click', function () { step(-1); });
    btnNext.addEventListener('click', function () { step(1); });
    nav.appendChild(btnPrev);
    nav.appendChild(btnNext);
    head.appendChild(title);
    head.appendChild(nav);
    head.appendChild(close);

    // A second row: what this thing is for on the left, how it looks on the
    // right. Both are always on screen, so neither is a hidden gesture.
    var bar = mk(doc, 'div');
    bar.className = 'pw-panel-bar';
    var sub = mk(doc, 'div');
    sub.className = 'pw-panel-sub';
    var subBase = '按 1→7 走一遍，就是一次精读';
    sub.textContent = subBase;
    var flashTimer = null;
    function flash(msg) {
      sub.textContent = msg;
      try { if (flashTimer) win.clearTimeout(flashTimer); } catch (e) { /* ignore */ }
      try {
        flashTimer = win.setTimeout(function () { sub.textContent = subBase; }, 1800);
      } catch (e) { /* ignore */ }
    }
    var mats = mk(doc, 'div');
    mats.className = 'pw-mats';
    MATERIALS.forEach(function (m) {
      var chip = el(doc, 'span', 'pw-mat', m[1]);
      chip.setAttribute('data-mat', m[0]);
      chip.setAttribute('title', '面板材质：' + m[1]);
      chip.addEventListener('click', function () { setMaterial(card, m[0]); });
      mats.appendChild(chip);
    });
    bar.appendChild(sub);
    bar.appendChild(mats);

    var body = mk(doc, 'div');
    body.className = 'pw-panel-body';

    card.appendChild(head);
    card.appendChild(bar);
    card.appendChild(body);
    wrap.appendChild(card);
    panel.appendChild(wrap);
    var host = doc.getElementById('mainPopupSet') || doc.documentElement;
    host.appendChild(panel);
    try {
      win.requestAnimationFrame(function () { card.classList.add('pw-in'); });
    } catch (e) { card.classList.add('pw-in'); }
    // openPopupAtScreenRect pins the popup box itself; opening anywhere else
    // lets the popup size to whatever content existed at open time and clip.
    try {
      panel.setAttribute('width', '700');
      panel.setAttribute('height', '560');
    } catch (e) { /* older gecko */ }
    try {
      // openPopupAtScreen takes device pixels while screenX/screenY are CSS px.
      var scale = win.devicePixelRatio || 1;
      panel.openPopupAtScreen(
        Math.round((win.screenX + 60) * scale),
        Math.round((win.screenY + 70) * scale),
        false
      );
    } catch (e) { Zotero.logError(e); }

    // Esc closes the overlay; the handler is removed with the panel.
    try {
      var onKey = function (ev) { if (ev.key === 'Escape') closePanel(doc); };
      win.addEventListener('keydown', onKey, true);
      panel.__pwKeyWin = win;
      panel.__pwKeyHandler = onKey;
    } catch (e) { /* ignore */ }

    if (!cur) {
      body.appendChild(el(doc, 'div', 'pw-empty', '还没选中文献。'));
      var cta = el(doc, 'div', 'pw-note pw-empty-cta',
        '在中间的文献列表里点一条，再按 Ctrl+Shift+6 —— 这七问都围绕被选中的那一篇。');
      body.appendChild(cta);
      return wrap;
    }
    var painted = false;
    var paint = function (pool) {
      var root = el(doc, 'div', painted ? 'pw-root' : 'pw-root pw-anim');
      painted = true;
      body.textContent = '';
      body.appendChild(root);
      try {
        renderItem(doc, root, cur, pool || emptyPool(cur.libraryID));
        updateProgress(card, cur);
      } catch (e) {
        Zotero.logError(e);
        body.appendChild(el(doc, 'div', 'pw-empty', '渲染出错：' + (e && e.message)));
      }
    };
    // The library pool is the one thing that has to be read asynchronously, so
    // when it is not ready yet the panel paints the item half and fills in the
    // library half as soon as the read lands.
    function show(it) {
      if (!it) return;
      cur = it;
      try { title.textContent = '六问 · ' + it.getField('title'); } catch (e) { /* ignore */ }
      var p = poolNow(it.libraryID) || emptyPool(it.libraryID);
      paint(p);
      if (!p.ready) {
        loadPool(it.libraryID).then(function (p2) { if (p2) paint(p2); });
      }
    }
    function step(dir) {
      if (!cur) { flash('先选中一条文献'); return; }
      var list = siblingItems();
      if (!list.length) { flash('这个列表里没有文献'); return; }
      var idx = -1;
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === cur.id) { idx = i; break; }
      }
      var t = idx < 0 ? 0 : idx + dir;
      if (t < 0) { flash('已经是这个列表的第一篇'); return; }
      if (t >= list.length) { flash('已经是这个列表的最后一篇'); return; }
      var target = list[t];
      try { Zotero.getActiveZoteroPane().selectItem(target); } catch (e) { /* ignore */ }
      show(target);
      try { body.scrollTop = 0; } catch (e) { /* ignore */ }
    }
    show(cur);
    return wrap;
  }

  function register(pluginID, coreMod, options) {
    core = coreMod;
    cfg.pluginID = pluginID || cfg.pluginID;
    cfg.version = (options && options.version) || cfg.version;
    cfg.rootURI = (options && options.rootURI) || cfg.rootURI || '';
    try {
      Zotero.MenuManager.registerMenu({
        menuID: MENU_ID,
        pluginID: cfg.pluginID,
        target: 'main/menubar/tools',
        menus: [{
          menuType: 'menuitem',
          l10nID: 'pulsewright-menu-open',
          onCommand: function () { openPanel(); }
        }]
      });
      Zotero.MenuManager.registerMenu({
        menuID: CTX_ID,
        pluginID: cfg.pluginID,
        target: 'main/library/item',
        menus: [{
          menuType: 'menuitem',
          l10nID: 'pulsewright-menu-open',
          onCommand: function () { openPanel(); }
        }]
      });
    } catch (e) { Zotero.logError(e); }
    try { addEntryPoints(Zotero.getMainWindow()); } catch (e) { Zotero.logError(e); }
    warmPool();
    watchLibrary();
  }

  // 批量导入或批量改标签会在几秒内连着来几十条事件，每条都整库重读一次
  // 纯属浪费；等手停下来再做一次就够了。
  function schedulePoolRebuild() {
    var win = null;
    try { win = Zotero.getMainWindow(); } catch (e) { /* ignore */ }
    var run = function () {
      poolTimer = null;
      cache = { libID: null, at: 0, metas: [], docs: [], index: new Map() };
      warmPool();
    };
    try {
      if (poolTimer && win) win.clearTimeout(poolTimer);
      poolTimer = win ? win.setTimeout(run, 900) : null;
      if (!win) run();
    } catch (e) {
      poolTimer = null;
      run();
    }
  }

  // The pool cannot be built synchronously, so build it before it is needed
  // and keep it fresh from the notifier.
  function warmPool() {
    try {
      var libID = Zotero.Libraries.userLibraryID;
      if (!poolNow(libID)) loadPool(libID);
    } catch (e) { /* ignore */ }
  }

  function watchLibrary() {
    if (notifierID) return;
    try {
      notifierID = Zotero.Notifier.registerObserver({
        notify: function (event, type) {
          if (type !== 'item') return;
          if (event === 'add' || event === 'modify' || event === 'delete' || event === 'trash') {
            schedulePoolRebuild();
          }
        }
      }, ['item'], 'pulsewright-six');
    } catch (e) { notifierID = null; }
  }

  function unregister() {
    if (poolTimer) {
      try { Zotero.getMainWindow().clearTimeout(poolTimer); } catch (e) { /* ignore */ }
      poolTimer = null;
    }
    try { Zotero.MenuManager.unregisterMenu(MENU_ID); } catch (e) { /* ignore */ }
    try { Zotero.MenuManager.unregisterMenu(CTX_ID); } catch (e) { /* ignore */ }
    try { removeEntryPoints(Zotero.getMainWindow()); } catch (e) { /* ignore */ }
    try {
      if (notifierID) Zotero.Notifier.unregisterObserver(notifierID);
    } catch (e) { /* ignore */ }
    notifierID = null;
    try { closePanel(Zotero.getMainWindow().document); } catch (e) { /* ignore */ }
  }

  return {
    MENU_ID: MENU_ID,
    register: register,
    unregister: unregister,
    openPanel: openPanel,
    addEntryPoints: addEntryPoints,
    _currentItem: currentItem,
    _metaOf: metaOf,
    _readSixNote: readSixNote
  };
})();
