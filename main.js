'use strict';

/* ============================================================
 * Pulsewright · 知识脉冲（自建版）
 * 本地知识工作可视化：贡献分 / 热力图 / 知识地层 / 月相日历 / 年度画像
 * 纯本地计算，不联网，无授权校验，只读你的笔记。
 * ============================================================ */

const obsidian = require('obsidian');
const {
  Plugin, ItemView, WorkspaceLeaf, TFile, Notice, Modal,
  Setting, PluginSettingTab, normalizePath
} = obsidian;

const VIEW_TYPE = 'pulsewright-view';
const DAY_MS = 86400000;
const SYNODIC = 29.530588853;
const NEW_MOON_REF = Date.UTC(2000, 0, 6, 18, 14);
const MAX_TOUCHED = 60;

const SETTINGS_VERSION = 2;

const DEFAULT_SETTINGS = {
  /* 数据保留天数：0 = 永久保留。超出天数的日条目在扫描结束时被裁掉。 */
  retentionDays: 0,
  maxWordsPerNote: 4000,
  scoreCap: 120,
  excludedFolders: ['.obsidian', '.trash', 'templates'],
  /* 含这些 frontmatter 字段的笔记不计入统计（大小写不敏感）。 */
  excludeFrontmatter: [],
  dataFolder: 'Pulse',
  trackLive: true,
  /* 贡献分权重，可在设置面板逐项调整。 */
  weights: { wordsPerPoint: 200, note: 4, link: 1.5, revision: 1 },
  /* 两次编辑间隔超过该分钟数，视为新的一段编辑会话。 */
  sessionGapMin: 5,
  /* 导出与备份的隐私开关。 */
  /* 超过这么多天没修改的笔记算「久未更新」。 */
  staleDays: 90,
  /* 「惦记」里逐行配置的几条线：名称 | 匹配 | 每周几次。 */
  lanesText: '',
  /* 面板材质：solid 实心 / frosted 毛玻璃 / acrylic 亚克力。 */
  materialStyle: 'solid',
  exportIncludeSettings: false,
  includeMemosInBackup: false,
  settingsVersion: SETTINGS_VERSION
};

const WEIGHTS = { wordsPerPoint: 200, note: 4, link: 1.5, revision: 1 };

const METRICS = [
  { id: 'words', name: '新增词数' },
  { id: 'notes', name: '新建笔记' },
  { id: 'links', name: '内链数' },
  { id: 'revisions', name: '修订次数' },
  { id: 'focusSec', name: '深度专注' },
  { id: 'score', name: '贡献分' }
];

const RANGES = [
  { id: '7', name: '近 7 天' },
  { id: '30', name: '近 30 天' },
  { id: '90', name: '近 90 天' },
  { id: '365', name: '近一年' },
  { id: 'all', name: '全部' }
];

/* ---------------- 基础工具 ---------------- */

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function dayKeyOf(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function dayKeyToday() { return dayKeyOf(Date.now()); }

function startOfDay(d) {
  const x = new Date(d.getTime());
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d, n) {
  const x = new Date(d.getTime());
  x.setDate(x.getDate() + n);
  x.setHours(0, 0, 0, 0);
  return x;
}

function startOfWeek(d) {
  const x = startOfDay(d);
  const dow = x.getDay(); // 0=周日
  const back = dow === 0 ? 6 : dow - 1;
  return addDays(x, -back);
}

function parseKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key));
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3]);
}

function parseDateStr(s) {
  if (!s) return 0;
  const m = String(s).match(/(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (!m) return 0;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), 0, 0);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

function parseFrontmatter(text) {
  const fm = {};
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return { fm, body: text };
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    if (!k || k[0] === ' ' || k[0] === '-') continue;
    let v = line.slice(i + 1).trim();
    v = v.replace(/^\[/, '').replace(/\]$/, '');
    v = v.replace(/^["']/, '').replace(/["']$/, '');
    if (v !== '') fm[k] = v;
  }
  return { fm, body: text.slice(m[0].length) };
}

function countWords(text) {
  if (!text) return 0;
  const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const latin = (text.match(/[A-Za-z0-9][A-Za-z0-9'’\-]*/g) || []).length;
  return cjk + latin;
}

function countLinks(text) {
  const m = text.match(/\[\[[^\]\n]{1,200}\]\]/g);
  return m ? m.length : 0;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtInt(n) {
  const v = Math.round(Number(n) || 0);
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fmtDur(sec) {
  sec = Number(sec) || 0;
  if (sec < 60) return sec <= 0 ? '0 分钟' : Math.round(sec) + ' 秒';
  if (sec < 3600) return Math.round(sec / 60) + ' 分钟';
  return (sec / 3600).toFixed(1) + ' 小时';
}

function pct(a, b) {
  if (!b) return 0;
  return Math.max(0, Math.min(100, Math.round((a / b) * 100)));
}

function emptyDaily() {
  return {
    words: 0, notes: 0, links: 0, revisions: 0,
    focusSec: 0, interactSec: 0, live: false, score: 0,
    timeQuality: 'estimated', touched: []
  };
}

function ensureDay(daily, key) {
  if (!daily[key]) daily[key] = emptyDaily();
  return daily[key];
}

function computeScore(e, cap, weights) {
  const w = weights || (DEFAULT_SETTINGS && DEFAULT_SETTINGS.weights) || WEIGHTS;
  const wordsPerPoint = Number(w.wordsPerPoint) > 0 ? Number(w.wordsPerPoint) : WEIGHTS.wordsPerPoint;
  const raw = (e.words || 0) / wordsPerPoint
    + (e.notes || 0) * (Number(w.note) || 0)
    + (e.links || 0) * (Number(w.link) || 0)
    + (e.revisions || 0) * (Number(w.revision) || 0);
  const c = typeof cap === 'number' ? cap : DEFAULT_SETTINGS.scoreCap;
  return Math.max(0, Math.min(c, Math.round(raw)));
}

/* 命中排除 frontmatter 字段的笔记不计入统计（大小写不敏感）。 */
function isSkippedNote(fm, settings) {
  const list = (settings && settings.excludeFrontmatter) || [];
  if (!list || !list.length || !fm) return false;
  const keys = Object.keys(fm);
  for (const want of list) {
    const w = String(want || '').trim().toLowerCase();
    if (!w) continue;
    for (const k of keys) {
      if (k.toLowerCase() !== w) continue;
      const v = fm[k];
      if (v === '' || v === 'false' || v === '0' || v === 'no') continue;
      return true;
    }
  }
  return false;
}

function finalizeDaily(daily, settings) {
  const cap = (settings && settings.scoreCap) || DEFAULT_SETTINGS.scoreCap;
  const weights = (settings && settings.weights) || DEFAULT_SETTINGS.weights;
  for (const k of Object.keys(daily)) {
    const e = daily[k];
    e.focusSec = Math.min(6 * 3600, Math.round((e.words || 0) * 0.6));
    e.interactSec = (e.notes || 0) * 180 + (e.revisions || 0) * 90 + (e.links || 0) * 60;
    e.score = computeScore(e, cap, weights);
  }
  return daily;
}

/* 按保留天数裁剪日条目；0 或非法值表示永久保留。 */
function pruneDaily(daily, retentionDays) {
  const days = parseInt(retentionDays, 10);
  if (!isFinite(days) || days <= 0) return daily;
  const cutoff = addDays(startOfDay(new Date()), -(days - 1));
  const cutKey = dayKeyOf(cutoff.getTime());
  const out = {};
  for (const k of Object.keys(daily)) {
    if (k >= cutKey) out[k] = daily[k];
  }
  return out;
}

/* ---- 真实编辑会话 ---- */

/* 把一次编辑事件并进当天的会话列表：与上一段相隔小于 gapMs 就续上，否则开新段。 */
function mergeSession(list, ts, gapMs) {
  const out = Array.isArray(list) ? list.map(function (s) { return [s[0], s[1]]; }) : [];
  const gap = Number(gapMs) > 0 ? Number(gapMs) : 5 * 60000;
  if (!out.length) return [[ts, ts]];
  const last = out[out.length - 1];
  if (ts >= last[0] && ts - last[1] <= gap) {
    last[1] = Math.max(last[1], ts);
    return out;
  }
  if (ts < last[0]) {
    /* 时钟回拨或补记：插到开头，不破坏已有区间。 */
    out.unshift([ts, ts]);
    return out;
  }
  out.push([ts, ts]);
  return out;
}

/* 会话总时长（秒）：单点会话按 1 分钟计，避免一堆 0 秒段。 */
function sessionSeconds(list) {
  if (!Array.isArray(list)) return 0;
  let sec = 0;
  for (const s of list) {
    if (!s || s.length < 2) continue;
    const d = (Number(s[1]) - Number(s[0])) / 1000;
    sec += d > 0 ? d : 60;
  }
  return sec;
}

/* 有真实会话的日期用实测时长，其余仍用词数估算。 */
function applySessions(daily, sessions) {
  if (!sessions) return daily;
  for (const k of Object.keys(daily)) {
    const list = sessions[k];
    if (!list || !list.length) continue;
    const sec = sessionSeconds(list);
    if (sec <= 0) continue;
    daily[k].focusSec = Math.min(6 * 3600, Math.round(sec));
    daily[k].timeQuality = 'measured';
  }
  return daily;
}

/* 单篇笔记 → 日条目 ---------------- */

function collectNote(path, text, stat, settings) {
  const { fm, body } = parseFrontmatter(text);
  const maxWords = (settings && settings.maxWordsPerNote) || DEFAULT_SETTINGS.maxWordsPerNote;
  const wordsRaw = countWords(body);
  const words = Math.min(wordsRaw, maxWords);
  const links = countLinks(body);
  const createdMs = parseDateStr(fm.created) || parseDateStr(fm.date) || (stat && stat.ctime) || (stat && stat.mtime) || Date.now();
  const mtimeMs = (stat && stat.mtime) || createdMs;
  return {
    path: path,
    title: path.split('/').pop().replace(/\.md$/i, ''),
    fm: fm,
    wordsRaw: wordsRaw,
    words: words,
    links: links,
    createdMs: createdMs,
    mtimeMs: mtimeMs,
    bytes: (stat && stat.size) || 0,
    tags: parseTags(fm),
    linkTargets: linkTargetsOf(body)
  };
}

function buildDaily(notes, settings) {
  const daily = {};
  const noteIndex = {};
  for (const n of notes) {
    if (isSkippedNote(n.fm, settings)) continue;
    noteIndex[n.path] = {
      created: n.createdMs, mtime: n.mtimeMs, words: n.wordsRaw,
      links: n.links, bytes: n.bytes, title: n.title,
      tags: n.tags || [], linkTargets: n.linkTargets || []
    };
    const ck = dayKeyOf(n.createdMs);
    const mk = dayKeyOf(n.mtimeMs);
    const e1 = ensureDay(daily, ck);
    e1.notes += 1;
    e1.words += n.words;
    e1.links += n.links;
    if (e1.touched.length < MAX_TOUCHED) e1.touched.push(n.path);
    if (mk !== ck) {
      const e2 = ensureDay(daily, mk);
      e2.revisions += 1;
      if (e2.touched.length < MAX_TOUCHED) e2.touched.push(n.path);
    }
  }
  finalizeDaily(daily, settings);
  return { daily: daily, noteIndex: noteIndex };
}

/* ---------------- 统计 ---------------- */

function rangeWindow(rangeId, daily, nowMs) {
  const today = startOfDay(new Date(typeof nowMs === 'number' && isFinite(nowMs) ? nowMs : Date.now()));
  if (rangeId === 'all') {
    const keys = Object.keys(daily || {}).sort();
    if (!keys.length) return { start: addDays(today, -29), end: today };
    const first = parseKey(keys[0]);
    return { start: first || addDays(today, -29), end: today };
  }
  const n = Math.max(1, parseInt(rangeId, 10) || 30);
  return { start: addDays(today, -(n - 1)), end: today };
}

function daysInWindow(daily, start, end) {
  const out = [];
  let d = startOfDay(start);
  const stop = startOfDay(end);
  let guard = 0;
  while (d <= stop && guard++ < 4000) {
    const key = dayKeyOf(d.getTime());
    out.push({ key: key, date: new Date(d.getTime()), entry: daily[key] || null });
    d = addDays(d, 1);
  }
  return out;
}

function summarize(list) {
  const s = {
    score: 0, words: 0, notes: 0, links: 0, revisions: 0,
    focusSec: 0, interactSec: 0, active: 0, days: list.length,
    best: null, bestKey: null
  };
  for (const it of list) {
    const e = it.entry;
    if (!e) continue;
    s.score += e.score || 0;
    s.words += e.words || 0;
    s.notes += e.notes || 0;
    s.links += e.links || 0;
    s.revisions += e.revisions || 0;
    s.focusSec += e.focusSec || 0;
    s.interactSec += e.interactSec || 0;
    if (isActiveDay(e)) s.active += 1;
    if (!s.best || (e.score || 0) > s.best) { s.best = e.score || 0; s.bestKey = it.key; }
  }
  return s;
}

/* 有分、或有任何真实活动（词数/新建/修订/内链）都算活跃日。 */
function isActiveDay(e) {
  if (!e) return false;
  if ((e.score || 0) > 0) return true;
  return (e.words || 0) > 0 || (e.notes || 0) > 0 || (e.revisions || 0) > 0 || (e.links || 0) > 0;
}

function streaks(daily) {
  const keys = Object.keys(daily).filter(function (k) { return isActiveDay(daily[k]); }).sort();
  if (!keys.length) return { current: 0, longest: 0 };
  let longest = 1, run = 1;
  for (let i = 1; i < keys.length; i++) {
    const prev = parseKey(keys[i - 1]);
    const cur = parseKey(keys[i]);
    if (prev && cur && Math.round((cur - prev) / DAY_MS) === 1) run += 1;
    else run = 1;
    if (run > longest) longest = run;
  }
  let cur = 0;
  let d = startOfDay(new Date());
  if (!isActiveDay(daily[dayKeyOf(d.getTime())])) d = addDays(d, -1);
  for (let i = 0; i < 2000; i++) {
    const k = dayKeyOf(d.getTime());
    if (isActiveDay(daily[k])) { cur += 1; d = addDays(d, -1); } else break;
  }
  return { current: cur, longest: longest };
}

/* 本周 vs 上周：同一套统计口径下的区间对比。 */
function weekCompare(daily, startDate) {
  const start = startOfDay(startDate);
  const cur = summarize(daysInWindow(daily, start, addDays(start, 6)));
  const prev = summarize(daysInWindow(daily, addDays(start, -7), addDays(start, -1)));
  const delta = cur.score - prev.score;
  const pctChange = prev.score > 0 ? Math.round((delta / prev.score) * 100) : (cur.score > 0 ? 100 : 0);
  return { current: cur, previous: prev, delta: delta, pct: pctChange };
}

/* 笔记排行：按「词数 + 内链×50」估影响力，同分看最近修改。只读 noteIndex，不碰正文。 */
function topNotes(noteIndex, limit) {
  const out = [];
  const idx = noteIndex || {};
  for (const path of Object.keys(idx)) {
    const n = idx[path] || {};
    const words = n.words || 0;
    const links = n.links || 0;
    out.push({
      path: path,
      title: n.title || path.split('/').pop(),
      words: words,
      links: links,
      mtime: n.mtime || 0,
      weight: words + links * 50
    });
  }
  out.sort(function (a, b) {
    if (b.weight !== a.weight) return b.weight - a.weight;
    return b.mtime - a.mtime;
  });
  return out.slice(0, Math.max(1, limit || 10));
}

/* ---------------- 笔记地图（标签 / 目录 / 链接 / 陈旧度） ---------------- */

/* 从 frontmatter 取标签：支持 tags / tag 两种键，数组、逗号、空格分隔、# 前缀都能吃。 */
function parseTags(fm) {
  const out = [];
  if (!fm) return out;
  let raw = fm.tags;
  if (raw === undefined || raw === null || raw === '') raw = fm.tag;
  if (raw === undefined || raw === null || raw === '') return out;
  const list = Array.isArray(raw) ? raw : String(raw).split(/[,，、;；\s]+/);
  const seen = {};
  for (let i = 0; i < list.length; i++) {
    let t = String(list[i] === undefined || list[i] === null ? '' : list[i]).trim();
    t = t.replace(/^["']/, '').replace(/["']$/, '');
    t = t.replace(/^#+/, '').replace(/^\[+/, '').replace(/\]$/, '').trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen[key]) continue;
    seen[key] = true;
    out.push(t);
  }
  return out;
}

/* 抽正文里的 [[链接]] 目标原文（别名与锚点先留着，归一化交给 normalizeLinkTarget）。 */
function linkTargetsOf(body) {
  const out = [];
  const re = /\[\[([^\]\n]{1,200})\]\]/g;
  let m;
  while ((m = re.exec(String(body || '')))) out.push(m[1]);
  return out;
}

/* 把 [[目标]] 归一成「路径.md」：去掉 |别名 与 #锚点，补 .md 后缀。 */
function normalizeLinkTarget(target) {
  let t = String(target === undefined || target === null ? '' : target).trim();
  if (!t) return '';
  t = t.split('|')[0].split('#')[0].replace(/\\/g, '/').trim();
  if (!t) return '';
  if (!/\.md$/i.test(t)) t += '.md';
  return t;
}

/* 目录分布：按顶层目录聚合笔记数、词数、最近修改时间。 */
function folderStats(noteIndex) {
  const map = {};
  const idx = noteIndex || {};
  for (const path of Object.keys(idx)) {
    const n = idx[path] || {};
    const slash = path.indexOf('/');
    const folder = slash >= 0 ? path.slice(0, slash) : '(根目录)';
    if (!map[folder]) map[folder] = { folder: folder, notes: 0, words: 0, mtime: 0 };
    map[folder].notes += 1;
    map[folder].words += n.words || 0;
    if ((n.mtime || 0) > map[folder].mtime) map[folder].mtime = n.mtime || 0;
  }
  const out = Object.keys(map).map(function (k) { return map[k]; });
  out.sort(function (a, b) {
    if (b.notes !== a.notes) return b.notes - a.notes;
    if (b.words !== a.words) return b.words - a.words;
    return a.folder < b.folder ? -1 : 1;
  });
  return out;
}

/* 标签统计：出现次数 + 覆盖词数，按次数降序。 */
function collectTags(noteIndex) {
  const map = {};
  const idx = noteIndex || {};
  for (const path of Object.keys(idx)) {
    const n = idx[path] || {};
    const tags = n.tags || [];
    for (let i = 0; i < tags.length; i++) {
      const key = String(tags[i]).toLowerCase();
      if (!map[key]) map[key] = { tag: String(tags[i]), count: 0, words: 0 };
      map[key].count += 1;
      map[key].words += n.words || 0;
    }
  }
  const out = Object.keys(map).map(function (k) { return map[k]; });
  out.sort(function (a, b) {
    if (b.count !== a.count) return b.count - a.count;
    if (b.words !== a.words) return b.words - a.words;
    return a.tag < b.tag ? -1 : 1;
  });
  return out;
}

/* 链接索引：算每篇的入链数，并收集指向不存在笔记的断链。 */
function linkIndex(noteIndex) {
  const idx = noteIndex || {};
  const paths = Object.keys(idx);
  const byBase = {};
  for (const p of paths) {
    const base = p.split('/').pop().replace(/\.md$/i, '').toLowerCase();
    if (!byBase[base]) byBase[base] = [];
    byBase[base].push(p);
  }
  const inlinks = {};
  for (const p of paths) inlinks[p] = 0;
  const broken = {};
  for (const p of paths) {
    const targets = (idx[p] && idx[p].linkTargets) || [];
    for (let i = 0; i < targets.length; i++) {
      const t = normalizeLinkTarget(targets[i]);
      if (!t) continue;
      let hit = null;
      if (idx[t]) hit = t;
      else {
        const base = t.split('/').pop().replace(/\.md$/i, '').toLowerCase();
        const cands = byBase[base];
        if (cands && cands.length) hit = cands[0];
      }
      if (hit) { if (hit !== p) inlinks[hit] += 1; }
      else broken[t] = (broken[t] || 0) + 1;
    }
  }
  return { inlinks: inlinks, broken: broken };
}

/* 孤儿笔记：没有任何入链的笔记（自己链自己不算），按词数降序。 */
function orphanNotes(noteIndex) {
  const idx = noteIndex || {};
  const li = linkIndex(idx);
  const out = [];
  for (const path of Object.keys(idx)) {
    if ((li.inlinks[path] || 0) > 0) continue;
    const n = idx[path] || {};
    out.push({ path: path, title: n.title || path.split('/').pop(), words: n.words || 0, mtime: n.mtime || 0 });
  }
  out.sort(function (a, b) { return (b.words - a.words) || (b.mtime - a.mtime); });
  return out;
}

/* 断链：[[指向]] 找不到对应笔记的目标，按出现次数降序。 */
function brokenLinks(noteIndex) {
  const li = linkIndex(noteIndex || {});
  const out = [];
  for (const target of Object.keys(li.broken)) {
    out.push({ target: target, count: li.broken[target] });
  }
  out.sort(function (a, b) { return (b.count - a.count) || (a.target < b.target ? -1 : 1); });
  return out;
}

/* 久未更新：最后修改时间早于 nowMs - staleDays 天的笔记，最旧的排前面。 */
function staleNotes(noteIndex, nowMs, staleDays) {
  const idx = noteIndex || {};
  const days = Math.max(1, parseInt(staleDays, 10) || 90);
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const cut = now - days * DAY_MS;
  const out = [];
  for (const path of Object.keys(idx)) {
    const n = idx[path] || {};
    const mtime = n.mtime || 0;
    if (!mtime || mtime >= cut) continue;
    out.push({
      path: path,
      title: n.title || path.split('/').pop(),
      words: n.words || 0,
      mtime: mtime,
      days: Math.floor((now - mtime) / DAY_MS)
    });
  }
  out.sort(function (a, b) { return a.mtime - b.mtime; });
  return out;
}

/* 搜索：按标题与路径做子串匹配，标题完全命中的排最前。 */
function searchNotes(noteIndex, query, limit) {
  const idx = noteIndex || {};
  const q = String(query === undefined || query === null ? '' : query).trim().toLowerCase();
  const max = Math.max(1, limit || 20);
  if (!q) return [];
  const out = [];
  for (const path of Object.keys(idx)) {
    const n = idx[path] || {};
    const title = String(n.title || path.split('/').pop());
    if ((title + ' ' + path).toLowerCase().indexOf(q) < 0) continue;
    const tl = title.toLowerCase();
    let rank = 3;
    if (tl === q) rank = 0;
    else if (tl.indexOf(q) === 0) rank = 1;
    else if (tl.indexOf(q) >= 0) rank = 2;
    out.push({ path: path, title: title, words: n.words || 0, links: n.links || 0, mtime: n.mtime || 0, rank: rank });
  }
  out.sort(function (a, b) { return (a.rank - b.rank) || (b.words - a.words) || (b.mtime - a.mtime); });
  return out.slice(0, max);
}

/* 今日回顾：从「写了不少、但很久没碰」的笔记里挑一篇。
 * 用 seed（通常传当天序号）取模，同一天稳定、隔天换一篇。 */
function pickReview(noteIndex, nowMs, seed) {
  const idx = noteIndex || {};
  const now = nowMs || Date.now();
  const cut = now - 30 * DAY_MS;
  const pool = [];
  for (const path of Object.keys(idx)) {
    const n = idx[path] || {};
    const words = n.words || 0;
    const mtime = n.mtime || 0;
    if (words < 50) continue;
    if (!mtime || mtime > cut) continue;
    pool.push({
      path: path,
      title: n.title || path.split('/').pop().replace(/\.md$/i, ''),
      words: words,
      mtime: mtime,
      days: Math.floor((now - mtime) / DAY_MS)
    });
  }
  if (!pool.length) return null;
  pool.sort(function (a, b) { return a.mtime - b.mtime; });
  const i = Math.abs(Math.floor(seed || 0)) % pool.length;
  return pool[i];
}

/* 笔记地图报告：把统计结果写成一份可直接放进库里的 Markdown。 */
function mapMarkdown(noteIndex, opts) {
  const idx = noteIndex || {};
  const o = opts || {};
  const staleDays = o.staleDays || 90;
  const now = o.now || Date.now();
  const stamp = o.stamp || dayKeyOf(now);
  const paths = Object.keys(idx);
  const tags = collectTags(idx);
  const folders = folderStats(idx);
  const li = linkIndex(idx);
  const orphans = orphanNotes(idx);
  const broken = brokenLinks(idx);
  const stale = staleNotes(idx, now, staleDays);
  let totalLinks = 0;
  for (const k of Object.keys(li.inlinks)) totalLinks += li.inlinks[k];

  const lines = [];
  lines.push('# 笔记地图 · ' + stamp);
  lines.push('');
  lines.push('- 笔记总数：**' + fmtInt(paths.length) + '**');
  lines.push('- 标签数：**' + fmtInt(tags.length) + '**');
  lines.push('- 内链总数：**' + fmtInt(totalLinks) + '**');
  lines.push('- 孤儿笔记：**' + fmtInt(orphans.length) + '**');
  lines.push('- 断链目标：**' + fmtInt(broken.length) + '**');
  lines.push('- 超过 ' + staleDays + ' 天没动：**' + fmtInt(stale.length) + '**');
  lines.push('');

  lines.push('## 目录分布');
  if (!folders.length) lines.push('没有目录。');
  else {
    for (const f of folders.slice(0, 20)) {
      lines.push('- ' + f.folder + '：' + f.notes + ' 篇 · ' + fmtInt(f.words) + ' 词');
    }
  }
  lines.push('');

  lines.push('## 标签');
  if (!tags.length) lines.push('还没有笔记在 frontmatter 里写 tags。');
  else {
    lines.push(tags.slice(0, 40).map(function (t) { return '#' + t.tag + '(' + t.count + ')'; }).join(' '));
  }
  lines.push('');

  lines.push('## 孤儿笔记');
  if (!orphans.length) lines.push('没有孤儿笔记。');
  else {
    for (const n of orphans.slice(0, 30)) {
      lines.push('- ' + n.title + '（' + fmtInt(n.words) + ' 词）');
    }
  }
  lines.push('');

  lines.push('## 断链');
  if (!broken.length) lines.push('没有断链。');
  else {
    for (const b of broken.slice(0, 30)) lines.push('- [[' + b.target + ']] × ' + b.count);
  }
  lines.push('');

  lines.push('## 久未更新');
  if (!stale.length) lines.push('没有超期的笔记。');
  else {
    for (const n of stale.slice(0, 30)) lines.push('- ' + n.title + '（' + n.days + ' 天未动）');
  }
  lines.push('');
  lines.push('> 由 Pulsewright 自动生成，数据全部来自本地笔记。');
  return lines.join('\n');
}

/* ---------------- 洞察 ---------------- */

function startOfHour(ms) {
  const d = new Date(ms);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

/* 写作时段网格：7 行（周一起）× 24 列，单位秒。 */
function hourGrid(sessions) {
  const grid = [];
  for (let i = 0; i < 7; i++) {
    const row = [];
    for (let h = 0; h < 24; h++) row.push(0);
    grid.push(row);
  }
  const s = sessions || {};
  for (const k of Object.keys(s)) {
    const list = s[k];
    if (!list || !list.length) continue;
    const day = parseKey(k);
    if (!day) continue;
    const wd = (day.getDay() + 6) % 7;
    for (const seg of list) {
      if (!seg || seg.length < 2) continue;
      let t = Number(seg[0]);
      const end = Number(seg[1]);
      if (!isFinite(t) || !isFinite(end) || end <= t) continue;
      let guard = 0;
      while (t < end && guard < 500) {
        guard += 1;
        const hour = new Date(t).getHours();
        const stop = Math.min(end, startOfHour(t) + 3600000);
        grid[wd][hour] += (stop - t) / 1000;
        t = stop;
      }
    }
  }
  return grid;
}

/* 笔记健康度：词数 40 + 内链 20 + 入链 20 + 新鲜度 20，合计 100 分。 */
function noteHealth(noteIndex, nowMs, opts) {
  const idx = noteIndex || {};
  const o = opts || {};
  const now = typeof nowMs === 'number' && isFinite(nowMs) ? nowMs : Date.now();
  const targetWords = Number(o.targetWords) > 0 ? Number(o.targetWords) : 800;
  const freshDays = Number(o.freshDays) > 0 ? Number(o.freshDays) : 30;
  const decayDays = Number(o.decayDays) > 0 ? Number(o.decayDays) : 365;
  const li = linkIndex(idx);
  const inlinks = li.inlinks || {};
  const items = [];
  for (const path of Object.keys(idx)) {
    const n = idx[path] || {};
    const words = n.words || 0;
    const links = n.links || 0;
    const inn = inlinks[path] || 0;
    const mtime = n.mtime || 0;
    const age = mtime ? Math.max(0, Math.floor((now - mtime) / DAY_MS)) : decayDays;
    let fresh = 0;
    if (age <= freshDays) fresh = 1;
    else if (age < decayDays) fresh = 1 - (age - freshDays) / (decayDays - freshDays);
    const score = Math.round(
      Math.min(1, words / targetWords) * 40 +
      Math.min(1, links / 8) * 20 +
      Math.min(1, inn / 5) * 20 +
      Math.max(0, Math.min(1, fresh)) * 20
    );
    let grade = 'D';
    if (score >= 80) grade = 'A';
    else if (score >= 60) grade = 'B';
    else if (score >= 40) grade = 'C';
    items.push({
      path: path,
      title: n.title || path.split('/').pop().replace(/\.md$/i, ''),
      words: words, links: links, inlinks: inn, age: age, score: score, grade: grade
    });
  }
  items.sort(function (a, b) { return a.score - b.score || b.words - a.words; });
  const counts = { A: 0, B: 0, C: 0, D: 0 };
  let total = 0;
  for (const it of items) {
    counts[it.grade] += 1;
    total += it.score;
  }
  return {
    items: items,
    counts: counts,
    average: items.length ? Math.round(total / items.length) : 0,
    total: items.length
  };
}

function normTitle(s) {
  return String(s || '').toLowerCase().replace(/[^0-9a-z\u4e00-\u9fff]+/g, '');
}

function titleGrams(s) {
  const t = normTitle(s);
  const out = {};
  if (t.length < 2) {
    if (t) out[t] = 1;
    return out;
  }
  for (let i = 0; i + 1 < t.length; i++) out[t.slice(i, i + 2)] = 1;
  return out;
}

/* 近似重复标题：字符 bigram 的 Jaccard 相似度，倒排索引剪枝后两两比较。 */
function similarNotes(noteIndex, opts) {
  const idx = noteIndex || {};
  const o = opts || {};
  const threshold = typeof o.threshold === 'number' ? o.threshold : 0.6;
  const limit = Math.max(1, o.limit || 40);
  const grams = {};
  const gkeys = {};
  const gsize = {};
  const bucket = {};
  const paths = Object.keys(idx);
  const idOf = {};
  for (let pi = 0; pi < paths.length; pi++) idOf[paths[pi]] = pi;
  for (let pi = 0; pi < paths.length; pi++) {
    const p = paths[pi];
    const n = idx[p] || {};
    const title = n.title || p.split('/').pop().replace(/\.md$/i, '');
    const g = titleGrams(title);
    grams[p] = g;
    const ks = Object.keys(g);
    gkeys[p] = ks;
    gsize[p] = ks.length;
    for (let ki = 0; ki < ks.length; ki++) {
      const k = ks[ki];
      if (!bucket[k]) bucket[k] = [];
      bucket[k].push(p);
    }
  }
  const seen = {};
  const pairs = [];
  for (const k of Object.keys(bucket)) {
    const list = bucket[k];
    if (list.length < 2 || list.length > 60) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const ia = idOf[a];
        const ib = idOf[b];
        const key = ia < ib ? ia * 100000 + ib : ib * 100000 + ia;
        if (seen[key]) continue;
        seen[key] = 1;
        const sa = gsize[a];
        const sb = gsize[b];
        if (!sa || !sb) continue;
        /* 交集最多是小的那个，所以 Jaccard 最多是 min/max；够不着阈值就别算了。 */
        const lo = sa < sb ? sa : sb;
        const hi = sa < sb ? sb : sa;
        if (lo / hi < threshold) continue;
        const ka = gkeys[a];
        const small = sa <= sb ? ka : gkeys[b];
        const big = sa <= sb ? grams[b] : grams[a];
        let inter = 0;
        for (let t = 0; t < small.length; t++) if (big[small[t]]) inter += 1;
        if (!inter) continue;
        const union = sa + sb - inter;
        const sim = inter / union;
        if (sim < threshold) continue;
        pairs.push({ a: a, b: b, sim: Math.round(sim * 100) / 100 });
      }
    }
  }
  pairs.sort(function (x, y) { return y.sim - x.sim || (x.a < y.a ? -1 : 1); });
  return pairs.slice(0, limit);
}

/* 标签共现：同一篇笔记里同时出现的标签对，用来发现主题簇。 */
function tagPairs(noteIndex, opts) {
  const idx = noteIndex || {};
  const o = opts || {};
  const minCount = Math.max(2, o.minCount || 2);
  const limit = Math.max(1, o.limit || 12);
  const map = {};
  for (const p of Object.keys(idx)) {
    const n = idx[p] || {};
    const tags = [];
    const seen = {};
    for (const raw of (n.tags || [])) {
      const t = String(raw || '').toLowerCase().trim();
      if (!t || seen[t]) continue;
      seen[t] = 1;
      tags.push(t);
    }
    if (tags.length < 2) continue;
    tags.sort();
    for (let i = 0; i < tags.length; i++) {
      for (let j = i + 1; j < tags.length; j++) {
        const key = tags[i] + '\u0000' + tags[j];
        if (!map[key]) map[key] = { a: tags[i], b: tags[j], count: 0 };
        map[key].count += 1;
      }
    }
  }
  const out = [];
  for (const k of Object.keys(map)) {
    if (map[k].count >= minCount) out.push(map[k]);
  }
  out.sort(function (x, y) { return y.count - x.count || (x.a < y.a ? -1 : 1); });
  return out.slice(0, limit);
}

/* ---------------- 月相 ---------------- */

function moonPhase(ms) {
  const days = (ms - NEW_MOON_REF) / DAY_MS;
  const p = (days / SYNODIC) % 1;
  return p < 0 ? p + 1 : p;
}

function moonPath(cx, cy, r, phase) {
  const p = ((phase % 1) + 1) % 1;
  const outerSweep = p < 0.5 ? 1 : 0;
  const rx = r * Math.abs(Math.cos(2 * Math.PI * p));
  let innerSweep;
  if (p < 0.25) innerSweep = 0;
  else if (p < 0.5) innerSweep = 1;
  else if (p < 0.75) innerSweep = 0;
  else innerSweep = 1;
  return 'M ' + cx + ' ' + (cy - r)
    + ' A ' + r + ' ' + r + ' 0 0 ' + outerSweep + ' ' + cx + ' ' + (cy + r)
    + ' A ' + rx.toFixed(2) + ' ' + r + ' 0 0 ' + innerSweep + ' ' + cx + ' ' + (cy - r)
    + ' Z';
}

/* ---------------- SVG 图表 ---------------- */

function heatLevel(v, max) {
  if (!v || v <= 0) return 0;
  if (!max || max <= 0) return 1;
  const r = v / max;
  if (r <= 0.15) return 1;
  if (r <= 0.4) return 2;
  if (r <= 0.7) return 3;
  return 4;
}

function svgHeatmap(valueByKey, opts) {
  opts = opts || {};
  const weeks = opts.weeks || 53;
  const today = startOfDay(new Date());
  const start = addDays(startOfWeek(today), -7 * (weeks - 1));
  const cell = 13, gap = 3, step = 16;
  const width = weeks * step;
  const top = 18;
  const height = top + 7 * step;
  const cells = [];
  let max = 0;
  for (let w = 0; w < weeks; w++) {
    for (let r = 0; r < 7; r++) {
      const d = addDays(start, w * 7 + r);
      if (d > today) continue;
      const key = dayKeyOf(d.getTime());
      const v = valueByKey[key] || 0;
      if (v > max) max = v;
      cells.push({ key: key, w: w, r: r, v: v });
    }
  }
  /* 悬停提示用自绘气泡（data-tip + 单个 fixed 定位节点），不用 SVG 原生 <title>：
     原生 title 有 1~2 秒延迟、样式不可控，且在缩放过的 SVG 里定位会飘。 */
  const fmtVal = typeof opts.format === 'function' ? opts.format : fmtInt;
  let rects = '';
  for (const c of cells) {
    const lv = heatLevel(c.v, max);
    const tip = c.key + ' · ' + fmtVal(c.v);
    rects += '<rect class="kp-hl-' + lv + '" x="' + (c.w * step) + '" y="' + (top + c.r * step)
      + '" width="' + cell + '" height="' + cell + '" rx="3" data-day="' + c.key + '" data-v="' + c.v
      + '" data-tip="' + String(tip).replace(/"/g, '&quot;') + '"></rect>';
  }
  let labels = '';
  const monthNames = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
  let lastMonth = -1;
  for (let w = 0; w < weeks; w++) {
    const d = addDays(start, w * 7);
    if (d.getMonth() !== lastMonth) {
      lastMonth = d.getMonth();
      labels += '<text class="kp-hl-label" x="' + (w * step) + '" y="12">' + monthNames[lastMonth] + '</text>';
    }
  }
  return '<svg class="kp-heatmap" viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="xMinYMin meet">'
    + labels + rects + '</svg>';
}

/* 悬停气泡：一个 body 级 fixed 节点复用，pointer-events:none 不挡点击。
   用自绘节点而非 SVG 原生 <title>，因为原生 title 有 1~2 秒延迟、样式不可控。
   任何带 data-tip 的节点都能用（热力图格子、柱状图柱体、折线命中点、月相格、标签）。 */
function bindHeatTips(root) {
  const nodes = root.querySelectorAll('[data-tip]');
  if (!nodes.length) return;
  const doc = root.ownerDocument || document;
  let tip = doc.querySelector('.kp-tip');
  if (!tip) {
    tip = doc.createElement('div');
    tip.className = 'kp-tip';
    doc.body.appendChild(tip);
  }
  function show(ev, text) {
    tip.textContent = text;
    tip.classList.add('is-on');
    place(ev);
  }
  function place(ev) {
    const pad = 12;
    const w = tip.offsetWidth || 0, h = tip.offsetHeight || 0;
    let x = ev.clientX + pad, y = ev.clientY + pad;
    if (x + w > window.innerWidth - 8) x = ev.clientX - w - pad;
    if (y + h > window.innerHeight - 8) y = ev.clientY - h - pad;
    tip.style.left = Math.max(8, x) + 'px';
    tip.style.top = Math.max(8, y) + 'px';
  }
  function hide() { tip.classList.remove('is-on'); }
  nodes.forEach(function (r) {
    r.addEventListener('mouseenter', function (ev) { show(ev, r.getAttribute('data-tip') || ''); });
    r.addEventListener('mousemove', place);
    r.addEventListener('mouseleave', hide);
    r.addEventListener('focus', function () {
      const b = r.getBoundingClientRect();
      show({ clientX: b.left + b.width / 2, clientY: b.top + b.height / 2 }, r.getAttribute('data-tip') || '');
    });
    r.addEventListener('blur', hide);
  });
}

function svgStrata(weeks, opts) {
  opts = opts || {};
  const w = 820, h = 200, padB = 20;
  const plotH = h - padB;
  // 每一层各自归一化后再堆叠，否则词数会把其他三层压成一条线
  const layerMax = [1, 1, 1, 1];
  for (let k = 0; k < 4; k++) {
    for (let i = 0; i < weeks.length; i++) {
      if (weeks[i].layers[k] > layerMax[k]) layerMax[k] = weeks[i].layers[k];
    }
  }
  const norm = weeks.map(function (wk) {
    return wk.layers.map(function (v, k) { return v / layerMax[k]; });
  });
  const max = 4;
  const stepX = weeks.length > 1 ? w / (weeks.length - 1) : w;
  let out = '';
  for (let k = 0; k < 4; k++) {
    const top = [], bottom = [];
    for (let i = 0; i < weeks.length; i++) {
      let below = 0;
      for (let j = 0; j < k; j++) below += norm[i][j];
      const belowTop = below + norm[i][k];
      const x = (i * stepX).toFixed(1);
      top.push(x + ',' + (plotH - (belowTop / max) * plotH).toFixed(1));
      bottom.push(x + ',' + (plotH - (below / max) * plotH).toFixed(1));
    }
    out += '<path class="kp-stratum-' + k + '" d="M' + top.join('L') + 'L' + bottom.reverse().join('L') + 'Z"></path>';
  }
  let ticks = '';
  for (let i = 0; i < weeks.length; i += 8) {
    ticks += '<text class="kp-axis-label" x="' + (i * stepX).toFixed(1) + '" y="' + (h - 6) + '">' + escapeHtml(weeks[i].label) + '</text>';
  }
  // 每周一条透明命中带：地层是连成一片的 path，没有单周可悬停的图形，
  // 所以在最上层铺一层看不见的竖条，专门接鼠标并给出这一周的四个数字。
  let hits = '';
  const bandW = weeks.length > 1 ? Math.max(4, stepX * 0.8) : w;
  for (let i = 0; i < weeks.length; i++) {
    const wk = weeks[i];
    const tip = wk.label + ' · 词 ' + fmtInt(wk.layers[0]) + ' · 新 ' + wk.layers[1]
      + ' · 链 ' + wk.layers[2] + ' · 改 ' + wk.layers[3];
    hits += '<rect class="kp-strata-hit" x="' + ((i * stepX) - bandW / 2).toFixed(1)
      + '" y="0" width="' + bandW.toFixed(1) + '" height="' + plotH
      + '" data-tip="' + String(tip).replace(/"/g, '&quot;') + '"></rect>';
  }
  return '<svg class="kp-strata" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' + out + ticks + hits + '</svg>';
}

function svgBars(items, opts) {
  opts = opts || {};
  const w = 820, h = opts.height || 180, padB = 22;
  const plotH = h - padB;
  const max = Math.max(1, items.reduce(function (a, x) { return Math.max(a, x.value); }, 0));
  const n = Math.max(1, items.length);
  const bw = Math.min(48, w / n * 0.62);
  let out = '';
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const bh = (it.value / max) * plotH;
    const x = (i * (w / n)) + (w / n - bw) / 2;
    out += '<rect class="kp-bar" x="' + x.toFixed(1) + '" y="' + (plotH - bh).toFixed(1)
      + '" width="' + bw.toFixed(1) + '" height="' + Math.max(1, bh).toFixed(1) + '" rx="3"'
      + ' data-tip="' + String(it.label + ' · ' + it.value).replace(/"/g, '&quot;') + '"></rect>';
    out += '<text class="kp-axis-label" x="' + (x + bw / 2).toFixed(1) + '" y="' + (h - 6)
      + '" text-anchor="middle">' + escapeHtml(it.label) + '</text>';
  }
  return '<svg class="kp-bars" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' + out + '</svg>';
}

function svgLine(points, opts) {
  opts = opts || {};
  const w = 820, h = opts.height || 160, padB = 18;
  const plotH = h - padB;
  const max = Math.max(1, points.reduce(function (a, p) { return Math.max(a, p.v); }, 0));
  const stepX = points.length > 1 ? w / (points.length - 1) : w;
  const coords = points.map(function (p, i) {
    return (i * stepX).toFixed(1) + ',' + (plotH - (p.v / max) * plotH).toFixed(1);
  });
  if (!coords.length) return '<svg class="kp-line" viewBox="0 0 ' + w + ' ' + h + '"></svg>';
  let out = '<path class="kp-line-area" d="M' + coords.join('L') + 'L' + w + ',' + plotH + 'L0,' + plotH + 'Z"></path>';
  out += '<path class="kp-line-path" d="M' + coords.join('L') + '"></path>';
  /* 透明圆点只做悬停命中区：线本身太细，鼠标很难对准。 */
  const dots = points.map(function (p, i) {
    const cx = (i * stepX).toFixed(1);
    const cy = (plotH - (p.v / max) * plotH).toFixed(1);
    const tip = String(p.label + ' · ' + p.v).replace(/"/g, '&quot;');
    return '<circle class="kp-line-dot" cx="' + cx + '" cy="' + cy + '" r="6" data-tip="' + tip + '"></circle>';
  }).join('');
  out += dots;
  return '<svg class="kp-line" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' + out + '</svg>';
}

/* 周 × 小时热力网格：格子亮度按该时段的累计编辑秒数分档。 */
function svgHourGrid(grid, opts) {
  opts = opts || {};
  const rows = grid || [];
  const cell = 26, gap = 4, step = cell + gap, left = 26, top = 16;
  const width = left + 24 * step;
  const height = top + 7 * step;
  let max = 0;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || [];
    for (let c = 0; c < row.length; c++) max = Math.max(max, Number(row[c]) || 0);
  }
  let out = '';
  for (let c = 0; c < 24; c++) {
    if (c % 3 !== 0) continue;
    out += '<text class="kp-hl-label" x="' + (left + c * step + cell / 2).toFixed(1)
      + '" y="11" text-anchor="middle">' + c + '</text>';
  }
  for (let r = 0; r < 7; r++) {
    const row = rows[r] || [];
    out += '<text class="kp-hl-label" x="0" y="' + (top + r * step + cell * 0.7).toFixed(1) + '">'
      + WEEKDAY_CN[r] + '</text>';
    for (let c = 0; c < 24; c++) {
      const v = Number(row[c]) || 0;
      const lv = heatLevel(v, max);
      const tip = WEEKDAY_CN[r] + ' ' + c + ':00 · ' + (v > 0 ? fmtDur(v) : '没有记录');
      out += '<rect class="kp-hl-' + lv + ' kp-hour-cell" x="' + (left + c * step).toFixed(1)
        + '" y="' + (top + r * step).toFixed(1) + '" width="' + cell + '" height="' + cell
        + '" rx="4" data-tip="' + tip.replace(/"/g, '&quot;') + '"></rect>';
    }
  }
  return '<svg class="kp-hourgrid" viewBox="0 0 ' + width + ' ' + height
    + '" preserveAspectRatio="xMinYMin meet">' + out + '</svg>';
}

/* ---------------- 周复盘 Markdown ---------------- */

/* ISO 8601 周号：周一为一周之始，跨年归属按 ISO 规则（12 月底可能属次年第 01 周）。 */
function weekLabel(startDate) {
  const d = startOfDay(startDate);
  const thursday = addDays(d, 3 - ((d.getDay() + 6) % 7));
  const y = thursday.getFullYear();
  const jan1 = startOfDay(new Date(y, 0, 1));
  const week = Math.floor((thursday - jan1) / DAY_MS / 7) + 1;
  return y + '-W' + pad2(week);
}

function weeklyMarkdown(daily, startDate) {
  const end = addDays(startDate, 6);
  const list = daysInWindow(daily, startDate, end);
  const s = summarize(list);
  const lines = [];
  lines.push('# 知识复盘 · ' + weekLabel(startDate) + '（' + dayKeyOf(startDate.getTime()) + ' ~ ' + dayKeyOf(end.getTime()) + '）');
  lines.push('');
  lines.push('- 贡献分：**' + fmtInt(s.score) + '**（日均 ' + (Math.round(s.score / 7 * 10) / 10) + '）');
  lines.push('- 活跃天数：**' + s.active + ' / 7**');
  lines.push('- 新增词数：**' + fmtInt(s.words) + '**');
  lines.push('- 新建笔记：**' + s.notes + '** ｜ 内链：**' + s.links + '** ｜ 修订：**' + s.revisions + '**');
  lines.push('- 深度专注：**' + fmtDur(s.focusSec) + '**');
  lines.push('- 最高一天：' + (s.bestKey ? dayKeyOf(parseKey(s.bestKey).getTime()) + '（' + s.best + ' 分）' : '—'));
  lines.push('');
  lines.push('## 这一周写了什么');
  const touched = {};
  for (const it of list) {
    if (!it.entry) continue;
    for (const p of it.entry.touched || []) {
      touched[p] = (touched[p] || 0) + 1;
    }
  }
  const top = Object.keys(touched).sort(function (a, b) { return touched[b] - touched[a]; }).slice(0, 8);
  if (top.length) {
    for (const p of top) lines.push('- ' + p.replace(/\.md$/, ''));
  } else {
    lines.push('- 本周没有记录的笔记变动。');
  }
  lines.push('');
  lines.push('## 一句话');
  if (s.active >= 5) lines.push('这一周很稳，节奏没断。');
  else if (s.active >= 2) lines.push('有产出但节奏偏松，下周把「打开就写」的时间固定下来。');
  else lines.push('这一周几乎没动库，先挑一件小事写十行。');
  lines.push('');
  lines.push('> 由 Pulsewright 自动生成，数据全部来自本地笔记。');
  return lines.join('\n');
}

/* ---------------- 品牌与分享卡 ---------------- */

/* 品牌标记：开口圆环 + 脉搏折线。与 docs/logo.svg 同一套路径，
 * 直接用内联 SVG 画，不额外加载图片，深色/浅色主题都能自适应。 */
function brandMarkSvg(size) {
  const s = size || 34;
  /* pathLength="1" 把两条 path 的长度归一到 1，入场时用 dashoffset 1→0 描出来，
   * 不必手算弧长；Chromium 支持 SVG2 的 pathLength。 */
  return '<svg class="kp-mark" width="' + s + '" height="' + s + '" viewBox="0 0 512 512" aria-hidden="true" focusable="false">'
    + '<defs>'
    + '<linearGradient id="kpMarkRing" x1="0" y1="0" x2="1" y2="1">'
    + '<stop offset="0" stop-color="#7c9cff"/><stop offset="1" stop-color="#4ecdc4"/></linearGradient>'
    + '<linearGradient id="kpMarkPulse" x1="0" y1="0" x2="1" y2="0">'
    + '<stop offset="0" stop-color="#96e6e1"/><stop offset="1" stop-color="#ffffff"/></linearGradient>'
    + '</defs>'
    + '<path class="kp-mark-ring" pathLength="1" d="M395 148 A176 176 0 1 0 320 421" fill="none" stroke="url(#kpMarkRing)" stroke-width="34" stroke-linecap="round"/>'
    + '<path class="kp-mark-pulse" pathLength="1" d="M96 256 L176 256 L205 212 L238 320 L272 166 L301 256 L416 256" fill="none" stroke="url(#kpMarkPulse)" stroke-width="24" stroke-linecap="round" stroke-linejoin="round"/>'
    + '</svg>';
}

/* 错峰延迟：第 i 个元素等 base + i*step 毫秒，封顶 cap。返回整数毫秒。 */
function introDelay(i, step, base, cap) {
  const v = (base || 0) + (i || 0) * (step || 0);
  const limit = typeof cap === 'number' ? cap : 600;
  if (!isFinite(v)) return 0;
  return Math.max(0, Math.min(limit, Math.round(v)));
}

/* 视图指纹：数据没变就不重建 DOM。
 * 只累加会改变画面的数字，避免整棵 daily 深比较；浮点先乘 100 取整。 */
function viewSignature(o) {
  o = o || {};
  const d = o.daily || {};
  const keys = Object.keys(d);
  let score = 0, words = 0, notes = 0, links = 0, rev = 0, focus = 0, live = 0;
  for (let i = 0; i < keys.length; i++) {
    const e = d[keys[i]] || {};
    score += e.score || 0;
    words += e.words || 0;
    notes += e.notes || 0;
    links += e.links || 0;
    rev += e.revisions || 0;
    focus += e.focusSec || 0;
    if (e.live) live++;
  }
  const nc = o.noteCache ? Object.keys(o.noteCache).length : 0;
  const memos = Array.isArray(o.memos) ? o.memos.length : 0;
  return [
    o.tab || '', o.range || '', o.metric || '', o.scene || '',
    keys.length,
    Math.round(score * 100) / 100,
    words, notes, links, rev, Math.round(focus * 100) / 100, live,
    nc, memos, o.settingsVersion || 0
  ].join('|');
}

/* 分享卡：1080×1440（3:4）竖图，纯 SVG 字符串，可直接存盘或转 PNG。
 * 只画传进来的数字，不读任何文件，所以能离线生成、也能在测试里断言。 */
function shareCardSvg(o) {
  o = o || {};
  const W = 1080;
  const H = 1440;
  const FONT = "'PingFang SC','Microsoft YaHei','Helvetica Neue',Arial,sans-serif";
  const dim = '#8b93a1';
  const faint = '#5b6270';
  const bars = Array.isArray(o.bars) ? o.bars.slice(0, 60) : [];
  let maxV = 1;
  for (const b of bars) { const v = (b && b.v) || 0; if (v > maxV) maxV = v; }

  const bx = 96;
  const bw = W - 192;
  const by = 812;
  const bh = 196;
  const step = bars.length ? bw / bars.length : bw;
  const barW = Math.max(3, Math.min(20, step - 4));
  let rects = '';
  for (let i = 0; i < bars.length; i++) {
    const v = (bars[i] && bars[i].v) || 0;
    const h = v > 0 ? Math.max(6, Math.round(bh * (v / maxV))) : 3;
    const x = Math.round(bx + i * step + (step - barW) / 2);
    const y = by + bh - h;
    rects += '<rect x="' + x + '" y="' + y + '" width="' + Math.round(barW) + '" height="' + h
      + '" rx="' + Math.min(4, Math.round(barW / 2)) + '" fill="'
      + (v > 0 ? 'url(#kpBar)' : 'rgba(255,255,255,0.05)') + '"/>';
  }

  const stats = [
    { label: '活跃天数', value: fmtInt(o.active || 0) + ' / ' + fmtInt(o.days || 30) },
    { label: '新增词数', value: fmtInt(o.words || 0) },
    { label: '新建笔记', value: fmtInt(o.notes || 0) },
    { label: '当前连续', value: fmtInt(o.streak || 0) + ' 天' }
  ];
  let statSvg = '';
  for (let i = 0; i < stats.length; i++) {
    const x = 96 + i * 224;
    statSvg += '<text x="' + x + '" y="648" font-family="' + FONT + '" font-size="38" font-weight="700" fill="#f2f4f8">'
      + escapeHtml(stats[i].value) + '</text>'
      + '<text x="' + x + '" y="684" font-family="' + FONT + '" font-size="21" fill="' + dim + '">'
      + escapeHtml(stats[i].label) + '</text>';
  }

  const bestText = o.bestKey
    ? ('最好的一天 ' + o.bestKey + ' · ' + fmtInt(o.best || 0) + ' 分')
    : '还没有足够的数据，先写三行。';
  const rangeText = (o.range || '近 30 天') + (o.today ? (' · 截至 ' + o.today) : '');

  return '<svg xmlns="http://www.w3.org/2000/svg" class="kp-sharecard" width="' + W + '" height="' + H
    + '" viewBox="0 0 ' + W + ' ' + H + '">'
    + '<defs>'
    + '<linearGradient id="kpRing" x1="0" y1="0" x2="1" y2="1">'
    + '<stop offset="0" stop-color="#7c9cff"/><stop offset="1" stop-color="#4ecdc4"/></linearGradient>'
    + '<linearGradient id="kpPulse" x1="0" y1="0" x2="1" y2="0">'
    + '<stop offset="0" stop-color="#96e6e1"/><stop offset="1" stop-color="#ffffff"/></linearGradient>'
    + '<linearGradient id="kpBar" x1="0" y1="1" x2="0" y2="0">'
    + '<stop offset="0" stop-color="#4ecdc4"/><stop offset="1" stop-color="#7c9cff"/></linearGradient>'
    + '<radialGradient id="kpGlow" cx="0.5" cy="0.5" r="0.5">'
    + '<stop offset="0" stop-color="#7c9cff" stop-opacity="0.32"/>'
    + '<stop offset="1" stop-color="#7c9cff" stop-opacity="0"/></radialGradient>'
    + '</defs>'
    + '<rect width="' + W + '" height="' + H + '" fill="#0f1116"/>'
    + '<circle cx="944" cy="150" r="360" fill="url(#kpGlow)"/>'
    + '<circle cx="110" cy="1330" r="300" fill="url(#kpGlow)" opacity="0.55"/>'
    + '<g transform="translate(96,96) scale(0.1875)">'
    + '<path d="M395 148 A176 176 0 1 0 320 421" fill="none" stroke="url(#kpRing)" stroke-width="34" stroke-linecap="round"/>'
    + '<path d="M96 256 L176 256 L205 212 L238 320 L272 166 L301 256 L416 256" fill="none" stroke="url(#kpPulse)" stroke-width="24" stroke-linecap="round" stroke-linejoin="round"/>'
    + '</g>'
    + '<text x="218" y="152" font-family="' + FONT + '" font-size="44" font-weight="700" fill="#ffffff">Pulsewright</text>'
    + '<text x="218" y="192" font-family="' + FONT + '" font-size="24" fill="#4ecdc4">知识脉冲</text>'
    + '<rect x="96" y="252" width="' + bw + '" height="1" fill="rgba(255,255,255,0.10)"/>'
    + '<text x="96" y="318" font-family="' + FONT + '" font-size="24" fill="' + dim + '">' + escapeHtml(rangeText) + '</text>'
    + '<text x="96" y="466" font-family="' + FONT + '" font-size="132" font-weight="800" fill="#ffffff">'
    + escapeHtml(fmtInt(o.score || 0)) + '</text>'
    + '<text x="96" y="512" font-family="' + FONT + '" font-size="24" fill="' + dim + '">累计贡献分</text>'
    + statSvg
    + '<text x="96" y="782" font-family="' + FONT + '" font-size="21" fill="' + dim + '">每日节奏</text>'
    + rects
    + '<text x="96" y="1064" font-family="' + FONT + '" font-size="24" fill="' + dim + '">' + escapeHtml(bestText) + '</text>'
    + '<rect x="96" y="1120" width="' + bw + '" height="1" fill="rgba(255,255,255,0.10)"/>'
    + '<text x="96" y="1236" font-family="' + FONT + '" font-size="46" font-weight="700" fill="#ffffff">你的知识，有自己的脉搏。</text>'
    + '<text x="96" y="1292" font-family="' + FONT + '" font-size="22" fill="' + dim + '">Obsidian · 全本地计算 · 零授权校验 · 只读笔记</text>'
    + '<text x="96" y="1352" font-family="' + FONT + '" font-size="18" fill="' + faint + '">pulsewright · 数据全部来自本地笔记，未上传任何内容</text>'
    + '</svg>';
}

/* 配图之外的纯文字版，方便直接粘到社交平台。 */
function shareText(o) {
  o = o || {};
  const lines = [];
  lines.push('我的知识库，' + (o.range || '近 30 天') + '的脉搏：');
  lines.push('');
  lines.push('· 贡献分 ' + fmtInt(o.score || 0));
  lines.push('· 活跃 ' + fmtInt(o.active || 0) + ' / ' + fmtInt(o.days || 30) + ' 天');
  lines.push('· 新增 ' + fmtInt(o.words || 0) + ' 词、' + fmtInt(o.notes || 0) + ' 篇笔记');
  if (o.bestKey) lines.push('· 最好的一天 ' + o.bestKey + '（' + fmtInt(o.best || 0) + ' 分）');
  if (o.streak) lines.push('· 已连续记录 ' + fmtInt(o.streak) + ' 天');
  lines.push('');
  lines.push('你的知识，有自己的脉搏。');
  return lines.join('\n');
}

/* ---------------- 惦记：你在意的事，有没有停 ---------------- */

/* 一条「线」的匹配规则：tag:练琴 / folder:02_学科 / path:巴赫 */
function laneMatch(note, lane, path) {
  if (!note || !lane) return false;
  const raw = String(lane.match || '').trim();
  if (!raw) return false;
  const i = raw.indexOf(':');
  const kind = i > 0 ? raw.slice(0, i).toLowerCase() : 'tag';
  const val = (i > 0 ? raw.slice(i + 1) : raw).trim();
  if (!val) return false;
  const low = val.toLowerCase();
  if (kind === 'tag') {
    const tags = note.tags || [];
    for (let k = 0; k < tags.length; k++) {
      const t = String(tags[k]).toLowerCase();
      if (t === low || t.indexOf(low + '/') === 0) return true;
    }
    return false;
  }
  const pth = String(path || note.path || '').replace(/\\/g, '/');
  if (kind === 'folder') {
    const p = pth.toLowerCase();
    const f = low.replace(/\/+$/, '');
    return p.indexOf(f + '/') === 0;
  }
  if (kind === 'path') {
    const p = (pth + ' ' + String(note.title || '')).toLowerCase();
    return p.indexOf(low) >= 0;
  }
  return false;
}

/* 统计一条线：命中过的日子、最近一次、本周几次、安静了几天。 */
function laneStats(noteIndex, lane, nowMs) {
  const now = typeof nowMs === 'number' && isFinite(nowMs) ? nowMs : Date.now();
  const idx = noteIndex || {};
  const hits = {};
  let lastMs = 0, lastPath = '';
  const keys = Object.keys(idx);
  for (let i = 0; i < keys.length; i++) {
    const p = keys[i];
    const n = idx[p];
    if (!n || !laneMatch(n, lane, p)) continue;
    const t = n.mtime || 0;
    if (!t) continue;
    const k = dayKeyOf(t);
    hits[k] = (hits[k] || 0) + 1;
    if (t > lastMs) { lastMs = t; lastPath = p; }
  }
  const today = startOfDay(new Date(now));
  const nowKey = dayKeyOf(today.getTime());
  const wkStart = dayKeyOf(addDays(today, -6).getTime());
  let weekCount = 0, total = 0;
  for (const k in hits) {
    total += 1;
    if (k >= wkStart && k <= nowKey) weekCount += 1;
  }
  const quiet = lastMs
    ? Math.round((today.getTime() - startOfDay(new Date(lastMs)).getTime()) / 86400000)
    : -1;
  return {
    hits: hits,
    lastMs: lastMs,
    lastKey: lastMs ? dayKeyOf(lastMs) : '',
    lastPath: lastPath,
    lastTitle: lastPath && idx[lastPath] ? (idx[lastPath].title || '') : '',
    weekCount: weekCount,
    total: total,
    quietDays: quiet
  };
}

/* 把一条线的命中情况铺成最近 days 天的格子，左旧右新。 */
function laneSeries(stats, days, nowMs) {
  const n = days || 84;
  const now = startOfDay(new Date(typeof nowMs === 'number' && isFinite(nowMs) ? nowMs : Date.now()));
  const hits = (stats && stats.hits) || {};
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const k = dayKeyOf(addDays(now, -i).getTime());
    out.push({ key: k, hit: !!hits[k] });
  }
  return out;
}

/* 一句状态：只说「动的频率」，不打分、不判好坏。 */
/* 一条线「隔几天算一次」的间隔；状态列和提醒卡必须用同一个，不然两边说法会打架。 */
/* 上周 vs 前一周。今天页只报字数，因为分数对用户没意义。 */
function weekWordsRecap(daily, nowMs) {
  const now = new Date(typeof nowMs === 'number' && isFinite(nowMs) ? nowMs : Date.now());
  const lastStart = addDays(startOfWeek(now), -7);
  const cur = summarize(daysInWindow(daily || {}, startOfDay(lastStart), addDays(startOfDay(lastStart), 6)));
  const prev = summarize(daysInWindow(daily || {}, startOfDay(addDays(lastStart, -7)), addDays(startOfDay(lastStart), -1)));
  const last = cur.words || 0;
  const before = prev.words || 0;
  const pct = before > 0 ? Math.round(((last - before) / before) * 100) : (last > 0 ? 100 : 0);
  return { last: last, before: before, pct: pct, hasData: last > 0 || before > 0 };
}

/* 库档案：与「哪一页」无关的底账，年度画像页拿来当抬头。 */
function libraryFacts(noteIndex, daily) {
  const idx = noteIndex || {};
  const day = daily || {};
  const dayKeys = Object.keys(day).sort();
  let firstDay = '';
  for (let i = 0; i < dayKeys.length; i++) {
    if (isActiveDay(day[dayKeys[i]])) { firstDay = dayKeys[i]; break; }
  }
  let activeDays = 0;
  let sumWords = 0;
  for (let i = 0; i < dayKeys.length; i++) {
    const e = day[dayKeys[i]];
    if (isActiveDay(e)) activeDays += 1;
    sumWords += e.words || 0;
  }
  let longest = null;
  const paths = Object.keys(idx);
  for (let i = 0; i < paths.length; i++) {
    const n = idx[paths[i]] || {};
    if (!longest || (n.words || 0) > longest.words) {
      longest = { path: paths[i], title: n.title || paths[i], words: n.words || 0 };
    }
  }
  return {
    firstDay: firstDay,
    activeDays: activeDays,
    noteCount: paths.length,
    avgWords: activeDays > 0 ? Math.round(sumWords / activeDays) : 0,
    longest: longest
  };
}

/* 年报正文。纯函数，写盘由插件负责，方便单测。 */
function yearReportMarkdown(y, months, facts, summary) {
  const s = summary || {};
  const L = [];
  L.push('# ' + y + ' 年 · 知识脉搏年报');
  L.push('');
  L.push('> 由 Pulsewright 在本地生成，只统计数字，不含任何笔记正文。');
  L.push('');
  L.push('## 这一年');
  L.push('');
  L.push('累计 **' + String(s.score || 0) + '** 分，写了 **' + String(s.words || 0) + '** 个词，新建 **' + String(s.notes || 0) + '** 篇，活跃 **' + String(s.activeDays || 0) + '** 天。');
  L.push('');
  if (s.bestDay) L.push('- 最高的一天：' + s.bestDay + '（' + String(s.bestScore || 0) + ' 分）');
  if (s.topMonth) L.push('- 最用力的月份：' + s.topMonth);
  if (s.topWeekday) L.push('- 最常动笔的星期：' + s.topWeekday);
  if (s.topNote) L.push('- 最厚的一篇：《' + s.topNote + '》');
  L.push('');
  L.push('## 月度分布');
  L.push('');
  L.push('| 月份 | 贡献分 |');
  L.push('| --- | --- |');
  (months || []).forEach(function (m) {
    L.push('| ' + m.label + ' | ' + String(m.value || 0) + ' |');
  });
  L.push('');
  L.push('## 库档案');
  L.push('');
  const f = facts || {};
  L.push('- 第一次动笔：' + (f.firstDay || '—'));
  L.push('- 有产出的天数：' + String(f.activeDays || 0) + ' 天');
  L.push('- 平均每天：' + String(f.avgWords || 0) + ' 词');
  L.push('- 笔记总数：' + String(f.noteCount || 0) + ' 篇');
  if (f.longest) L.push('- 最长的一篇：《' + f.longest.title + '》' + String(f.longest.words) + ' 词');
  L.push('');
  L.push('---');
  L.push('');
  L.push('*Pulsewright · 你的知识，有自己的脉搏。*');
  return L.join('\n');
}

/* 没有「该回头看的旧笔记」时，至少给一篇最近在写的——比一句「没什么要提醒的」有用。 */
/* 按修改时间从近到远排前几条。今天页「换一篇」靠它轮流挑。 */
function recentNotes(noteIndex, limit) {
  const idx = noteIndex || {};
  const n = limit || 20;
  const keys = Object.keys(idx);
  const rows = [];
  for (let i = 0; i < keys.length; i++) {
    const it = idx[keys[i]] || {};
    if (!it.mtime) continue;
    rows.push({ path: keys[i], title: it.title || keys[i], words: it.words || 0, mtime: it.mtime });
  }
  rows.sort(function (a, b) { return b.mtime - a.mtime; });
  return rows.slice(0, n);
}

function latestNote(noteIndex) {
  const idx = noteIndex || {};
  const keys = Object.keys(idx);
  let best = null;
  for (let i = 0; i < keys.length; i++) {
    const n = idx[keys[i]];
    if (!n || !n.mtime) continue;
    if (!best || n.mtime > best.mtime) {
      best = { path: keys[i], title: n.title || keys[i], words: n.words || 0, mtime: n.mtime };
    }
  }
  return best;
}

function laneGapDays(perWeek) {
  const per = perWeek || 0;
  if (per <= 0) return 7;
  return Math.max(0.5, 7 / per);
}

function laneStatus(stats, lane) {
  const per = lane && typeof lane.perWeek === 'number' ? lane.perWeek : 0;
  const quiet = stats ? stats.quietDays : -1;
  if (quiet < 0) return { text: '还没有记录', cls: '' };
  if (per > 0) {
    const wk = stats.weekCount || 0;
    if (wk >= per) return { text: '本周 ' + wk + ' 次 · 正好', cls: 'ok' };
    if (quiet >= laneGapDays(per) * 2) return { text: '本周 ' + wk + ' / ' + per + ' 次 · 安静了 ' + quiet + ' 天', cls: 'warn' };
    return { text: '本周 ' + wk + ' / ' + per + ' 次', cls: '' };
  }
  if (quiet === 0) return { text: '今天动过', cls: 'ok' };
  return { text: quiet + ' 天前', cls: quiet >= 14 ? 'warn' : '' };
}

/* 挑一条最该被提一句的线：超过自己的节奏、且安静最久。 */
function laneAdvice(items) {
  const list = items || [];
  let best = null, bestScore = -1;
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    const st = it && it.stats;
    if (!st || st.quietDays < 0) continue;
    const per = it.lane && it.lane.perWeek ? it.lane.perWeek : 0;
    let score;
    if (per > 0) {
      const gapB = laneGapDays(per);
      if (st.quietDays < gapB * 2) continue;
      score = st.quietDays / gapB;
    } else {
      if (st.quietDays < 14) continue;
      score = st.quietDays / 14;
    }
    if (score > bestScore) { bestScore = score; best = it; }
  }
  return best;
}

function laneAdviceText(it) {
  if (!it || !it.stats) return '';
  const st = it.stats;
  const name = (it.lane && it.lane.name) || '';
  let s = name + ' 这条线安静了 ' + st.quietDays + ' 天。';
  if (st.lastTitle) s += '最后一次是 ' + st.lastKey + '，那篇叫《' + st.lastTitle + '》。';
  else s += '还没有动过的记录。';
  return s;
}

/* 没配过线时给一组起点：先给目录，一个人把生活分成哪几块，通常就写在目录名里。 */
/* 目录名常常带序号前缀和文件名式的分隔，直接拿来当「你在意的事」念不通。 */
function lanePretty(name) {
  let t = String(name || '').trim();
  t = t.replace(/^[0-9]{1,2}\s*[._\-、]\s*/, '');
  t = t.replace(/[_-]+/g, ' ');
  return t.trim() || String(name || '');
}

function suggestLanes(noteIndex, limit) {
  const n = limit || 6;
  const idx = noteIndex || {};
  const tagCount = {};
  const folderCount = {};
  const keys = Object.keys(idx);
  for (let i = 0; i < keys.length; i++) {
    const note = idx[keys[i]];
    if (!note) continue;
    const tags = note.tags || [];
    for (let k = 0; k < tags.length; k++) tagCount[tags[k]] = (tagCount[tags[k]] || 0) + 1;
    const seg = String(note.path || keys[i] || '').replace(/\\/g, '/').split('/');
    if (seg.length > 1) {
      const f = seg.slice(0, -1).join('/');
      if (f && f !== '.') folderCount[f] = (folderCount[f] || 0) + 1;
    }
  }
  const out = [];
  Object.keys(folderCount).sort(function (a, b) { return folderCount[b] - folderCount[a]; }).forEach(function (f) {
    if (out.length >= n || folderCount[f] < 3) return;
    out.push({ name: lanePretty(f.split('/').pop()), match: 'folder:' + f, perWeek: 0, note: folderCount[f] + ' 篇' });
  });
  if (out.length < n) {
    Object.keys(tagCount).sort(function (a, b) { return tagCount[b] - tagCount[a]; }).forEach(function (t) {
      if (out.length >= n || tagCount[t] < 2) return;
      out.push({ name: lanePretty(t), match: 'tag:' + t, perWeek: 0, note: tagCount[t] + ' 篇' });
    });
  }
  return out.slice(0, n);
}

/* 设置页里一行一条：名称 | 匹配 | 每周几次（0 = 不设节奏）。 */
function parseLanes(text) {
  const out = [];
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || raw.charAt(0) === '#') continue;
    const parts = raw.split('|');
    if (parts.length < 2) continue;
    const name = parts[0].trim();
    const match = parts[1].trim();
    if (!name || !match) continue;
    const per = parts.length > 2 ? parseInt(parts[2].trim(), 10) : 0;
    out.push({
      id: 'lane-' + i,
      name: name,
      match: match,
      perWeek: isNaN(per) || per < 0 ? 0 : per
    });
  }
  return out;
}

function formatLanes(lanes) {
  return (lanes || []).map(function (l) {
    return l.name + ' | ' + l.match + ' | ' + (l.perWeek || 0);
  }).join('\n');
}

/* 回声：去年 / 上个月 / 三年前的这个时候，各挑一篇那段时间最后动过的。
 * 「这个时候」而不是「今天」，是因为多数人不会正好在那一天留下笔记，
 * 卡死同一天会让这个功能大部分时间是空的。 */
function echoPicks(noteIndex, nowMs, limit) {
  const now = startOfDay(new Date(typeof nowMs === 'number' && isFinite(nowMs) ? nowMs : Date.now()));
  const idx = noteIndex || {};
  const specs = [
    { id: 'y1', label: '去年这个时候', years: 1 },
    { id: 'm1', label: '上个月这个时候', months: 1 },
    { id: 'y3', label: '三年前这个时候', years: 3 }
  ];
  const byDay = {};
  const keys = Object.keys(idx);
  for (let i = 0; i < keys.length; i++) {
    const p = keys[i];
    const n = idx[p];
    if (!n || !n.mtime) continue;
    const k = dayKeyOf(n.mtime);
    if (!byDay[k]) byDay[k] = [];
    byDay[k].push(p);
  }
  const dayKeys = Object.keys(byDay).sort();
  const used = {};
  const out = [];
  for (let i = 0; i < specs.length; i++) {
    if (limit && out.length >= limit) break;
    const sp = specs[i];
    const d = new Date(now.getTime());
    if (sp.years) d.setFullYear(d.getFullYear() - sp.years);
    if (sp.months) d.setMonth(d.getMonth() - sp.months);
    const target = startOfDay(d);
    let bestKey = '', bestDiff = 999;
    for (let k = 0; k < dayKeys.length; k++) {
      const diff = Math.abs(Math.round((startOfDay(parseKey(dayKeys[k])).getTime() - target.getTime()) / 86400000));
      if (diff <= 5 && diff < bestDiff) { bestDiff = diff; bestKey = dayKeys[k]; }
    }
    if (!bestKey) continue;
    const list = byDay[bestKey].slice().sort(function (a, b) {
      return (idx[b].words || 0) - (idx[a].words || 0);
    });
    let path = '';
    for (let k = 0; k < list.length; k++) {
      if (!used[list[k]] && (idx[list[k]].words || 0) >= 20) { path = list[k]; break; }
    }
    if (!path) {
      for (let k = 0; k < list.length; k++) {
        if (!used[list[k]]) { path = list[k]; break; }
      }
    }
    if (!path) continue;
    used[path] = 1;
    out.push({
      id: sp.id,
      label: sp.label,
      key: bestKey,
      path: path,
      title: idx[path].title || '',
      words: idx[path].words || 0
    });
  }
  return out;
}

/* 从正文里取一句话当回声引文：优先第一句，太长就截断。 */
function echoLead(text, max) {
  const lim = max || 56;
  let t = String(text || '');
  if (t.indexOf('---') === 0) {
    const end = t.indexOf('\n---', 3);
    if (end > 0) t = t.slice(end + 4);
  }
  t = t.replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s{0,3}>+\s?/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return '';
  const m = t.match(/^(.{6,120}?[。！？!?])/);
  let s = m ? m[1] : t;
  if (s.length > lim) s = s.slice(0, lim).replace(/[，、,；;]$/, '') + '…';
  return s;
}

/* ---------------- 导出（供测试） ---------------- */
const PURE = {
  pad2: pad2,
  dayKeyOf: dayKeyOf,
  startOfDay: startOfDay,
  addDays: addDays,
  startOfWeek: startOfWeek,
  parseKey: parseKey,
  parseDateStr: parseDateStr,
  parseFrontmatter: parseFrontmatter,
  countWords: countWords,
  countLinks: countLinks,
  fmtInt: fmtInt,
  fmtDur: fmtDur,
  computeScore: computeScore,
  isSkippedNote: isSkippedNote,
  isActiveDay: isActiveDay,
  pruneDaily: pruneDaily,
  mergeSession: mergeSession,
  sessionSeconds: sessionSeconds,
  applySessions: applySessions,
  finalizeDaily: finalizeDaily,
  collectNote: collectNote,
  buildDaily: buildDaily,
  rangeWindow: rangeWindow,
  daysInWindow: daysInWindow,
  summarize: summarize,
  streaks: streaks,
  moonPhase: moonPhase,
  moonPath: moonPath,
  heatLevel: heatLevel,
  svgHeatmap: svgHeatmap,
  svgStrata: svgStrata,
  svgBars: svgBars,
  svgLine: svgLine,
  svgHourGrid: svgHourGrid,
  weeklyMarkdown: weeklyMarkdown,
  weekLabel: weekLabel,
  weekCompare: weekCompare,
  topNotes: topNotes,
  parseTags: parseTags,
  linkTargetsOf: linkTargetsOf,
  normalizeLinkTarget: normalizeLinkTarget,
  folderStats: folderStats,
  collectTags: collectTags,
  linkIndex: linkIndex,
  orphanNotes: orphanNotes,
  brokenLinks: brokenLinks,
  staleNotes: staleNotes,
  searchNotes: searchNotes,
  pickReview: pickReview,
  mapMarkdown: mapMarkdown,
  startOfHour: startOfHour,
  hourGrid: hourGrid,
  noteHealth: noteHealth,
  normTitle: normTitle,
  titleGrams: titleGrams,
  similarNotes: similarNotes,
  tagPairs: tagPairs,
  brandMarkSvg: brandMarkSvg,
  introDelay: introDelay,
  viewSignature: viewSignature,
  shareCardSvg: shareCardSvg,
  shareText: shareText,
  laneMatch: laneMatch,
  laneStats: laneStats,
  laneSeries: laneSeries,
  laneStatus: laneStatus,
  laneGapDays: laneGapDays,
  latestNote: latestNote,
  recentNotes: recentNotes,
  weekWordsRecap: weekWordsRecap,
  libraryFacts: libraryFacts,
  yearReportMarkdown: yearReportMarkdown,
  laneAdvice: laneAdvice,
  laneAdviceText: laneAdviceText,
  suggestLanes: suggestLanes,
  lanePretty: lanePretty,
  parseLanes: parseLanes,
  formatLanes: formatLanes,
  echoPicks: echoPicks,
  echoLead: echoLead,
  DEFAULT_SETTINGS: DEFAULT_SETTINGS,
  WEIGHTS: WEIGHTS
};
/* ---------------- 视图 ---------------- */

const TAB_DEFS = [
  { id: 'today', name: '今天' },
  { id: 'lanes', name: '惦记' },
  { id: 'board', name: '概览' },
  { id: 'strata', name: '知识地层' },
  { id: 'moon', name: '月相日历' },
  { id: 'year', name: '年度画像' },
  { id: 'review', name: '知识复盘' },
  { id: 'map', name: '笔记地图' },
  { id: 'insight', name: '洞察' },
  { id: 'memo', name: '速记' },
  { id: 'data', name: '数据' }
];

/* 十一个视图分成四栏：先按「你想干什么」分，再按时间尺度分。 */
const MENU_GROUPS = [
  { name: '现在', hint: '最近怎么样', ids: ['today', 'lanes'] },
  { name: '时间', hint: '换个尺度看', ids: ['board', 'strata', 'moon', 'year'] },
  { name: '内容', hint: '库里有什么', ids: ['review', 'map', 'insight'] },
  { name: '做事', hint: '记点什么', ids: ['memo', 'data'] }
];

/* 每页开头一句话：这一页是干什么的。看不懂的一律改到看得懂为止。 */
const PAGE_HINTS = {
  today: '今天写了多少、最近有没有断、还有一件你现在就能做的事。',
  lanes: '你自己说要在意的那几件事，横着看是时间，缺一块就是那几天没碰。',
  board: '全部历史的总量、节奏和热力图。',
  strata: '每个月写下的东西像沉积岩一样堆起来，越厚说明那个月写得越多。',
  moon: '把每个月想成一个月亮：亮面是写完的比例，半途而废的月份是残月。',
  year: '一年一年摆在一起比，看你在哪个月最厚。',
  review: '把该回头看的笔记挑出来，替你复习。',
  map: '你的笔记长什么样：孤儿、断链、标签和目录分布。',
  insight: '写作时辰、相似标题、标签搭配这类不太好一眼看出来的东西。',
  memo: '随手记一句，不用新建一篇笔记。',
  data: '所有原始数字都在这里，也能导出。'
};

const WEEKDAY_CN = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const MONTH_CN = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

function metricValue(entry, metric) {
  if (!entry) return 0;
  if (metric === 'score') return entry.score || 0;
  return entry[metric] || 0;
}

function svgMoon(phase, intensity, size) {
  const r = size / 2 - 2;
  const cx = size / 2;
  const cy = size / 2;
  const d = moonPath(cx, cy, r, phase);
  const op = (0.18 + 0.82 * Math.max(0, Math.min(1, intensity))).toFixed(2);
  return '<svg class="kp-moon-svg" width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">'
    + '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" class="kp-moon-dark"/>'
    + '<path d="' + d + '" class="kp-moon-lit" style="opacity:' + op + '"/>'
    + '</svg>';
}

class PulseView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    const vs = (plugin && plugin.data && plugin.data.viewState) || {};
    this.tab = vs.tab || 'today';
    this.range = vs.range || '90';
    this.metric = vs.metric || 'words';
    this.moonMonth = null;
    this.reviewWeek = null;
    /* 首屏仪式感：只在每个视图实例第一次渲染时播一次，之后切页签不重播。 */
    this._booted = false;
    /* 渲染指纹：refresh() 用它短路掉数据没变的重建，避免无谓重绘。 */
    this._lastSig = '';
    this._countRaf = 0;
    /* 搜索框输入用 rAF 合并重绘，避免逐键重建正文。 */
    this._memoRaf = 0;
    this._mapRaf = 0;
  }

  /* 把当前视图状态写回 data.json，下次打开还是这一页。 */
  saveViewState() {
    try {
      const p = this.plugin;
      if (!p) return;
      p.data.viewState = { tab: this.tab, range: this.range, metric: this.metric };
      p.persist().catch(function (e) { console.error('[pulsewright] saveViewState failed', e); });
    } catch (e) {
      console.error('[pulsewright] saveViewState failed', e);
    }
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Pulsewright'; }
  getIcon() { return 'activity'; }

  async onOpen() {
    this.contentEl.addClass('kp-root');
    this.render();
  }

  async onClose() { }

  /* 数据指纹：refresh 被高频调用（每次保存、每次扫描完），
   * 内容没变就直接跳过整棵 DOM 重建，避免无谓重排。 */
  signature() {
    try {
      const p = this.plugin;
      return viewSignature({
        daily: (p.data && p.data.daily) || {},
        noteCache: p.data && p.data.noteCache,
        memos: p.data && p.data.memos,
        tab: this.tab,
        range: this.range,
        metric: this.metric,
        scene: p.settings && p.settings.sceneStyle,
        settingsVersion: p.settings && p.settings.settingsVersion
      });
    } catch (e) {
      return '';
    }
  }

  refresh() {
    if (!this.contentEl || !this.contentEl.isConnected) return;
    const sig = this.signature();
    if (sig && sig === this._lastSig) return;
    /* 数据变了只需要换正文。整壳重建会把滚动位置清零、把菜单收起来，
     * 库里有文件在动的时候等于每隔几秒把读者踹回顶部。 */
    const shell = this.contentEl.querySelector('.kp-shell');
    const body = shell && shell.querySelector('.kp-body');
    if (body && typeof body.empty === 'function') { this.renderBodyOnly(); return; }
    this.render();
  }

  /* 只重绘正文：切页签、改范围/指标、翻月翻年翻周、速记增删改这些操作
   * 只影响 .kp-body，header、品牌 SVG、九个页签按钮都不必重建。
   * 省掉一次整壳 innerHTML 解析 + 全部事件重绑，交互帧更稳。
   * 换画风（改 shell 的 class）和「刷新」按钮（要复位按钮文案）仍走整壳 render()。 */
  renderBodyOnly() {
    const shell = this.contentEl && this.contentEl.querySelector('.kp-shell');
    const body = shell && shell.querySelector('.kp-body');
    if (!body || typeof body.empty !== 'function') { this.render(); return; }
    const self = this;
    /* 页签高亮只切类名，不重建按钮节点。 */
    if (typeof shell.querySelectorAll === 'function') {
      shell.querySelectorAll('[data-tab]').forEach(function (b) {
        if (!b.classList) return;
        if (b.getAttribute('data-tab') === self.tab) b.classList.add('is-active');
        else b.classList.remove('is-active');
      });
    }
    const keepTop = body.scrollTop || 0;
    this._skipIn = true;
    this.renderTab(body);
    this._skipIn = false;
    if (keepTop) body.scrollTop = keepTop;
    this._lastSig = this.signature();
  }

  data() { return this.plugin.data; }
  daily() { return (this.plugin.data && this.plugin.data.daily) || {}; }

  window() {
    return rangeWindow(this.range, this.daily());
  }

  windowDays() {
    const w = this.window();
    return daysInWindow(this.daily(), w.start, w.end);
  }

  /* ---------- 外壳 ---------- */

  render() {
    const el = this.contentEl;
    el.empty();
    el.addClass('kp-root');
    const scene = (this.plugin.settings.sceneStyle || 'pixel');
    const mat = (this.plugin.settings.materialStyle || 'solid');
    const shell = el.createDiv({ cls: 'kp-shell kp-scene-' + scene + ' kp-mat-' + mat });

    /* 首屏才播入场动画：切页签、刷新数据都不重播，避免每次操作都闪一下。 */
    const boot = !this._booted;
    if (boot) {
      shell.addClass('kp-boot');
      this._booted = true;
    }

    const nowName = (TAB_DEFS.filter(function (t) { return t.id === this.tab; }, this)[0] || TAB_DEFS[0]).name;
    const nameOf = {};
    TAB_DEFS.forEach(function (t) { nameOf[t.id] = t.name; });
    const curTab = this.tab;
    const menuGroups = MENU_GROUPS.map(function (g) {
      const items = g.ids.filter(function (id) { return nameOf[id]; }).map(function (id) {
        return '<button class="kp-menu-item' + (id === curTab ? ' is-active' : '') + '" data-tab="' + id + '">' + nameOf[id] + '</button>';
      }).join('');
      return '<div class="kp-menu-group"><b>' + g.name + '<i>' + g.hint + '</i></b>' + items + '</div>';
    }, this).join('');

    shell.innerHTML = ''
      + '<header class="kp-head">'
      + '  <div class="kp-brand">' + brandMarkSvg(38)
      + '    <div><h2>Pulsewright<span class="kp-brand-cn">知识脉冲</span></h2>'
      + '  <p class="kp-brand-slogan">你的知识，有自己的脉搏。</p></div></div>'
      + '  <div class="kp-head-actions">'
      + '    <button class="kp-btn" data-act="scene" title="换画风">换画风</button>'
      + '    <button class="kp-btn" data-act="rescan" title="重新扫描">刷新</button>'
      + '  </div>'
      + '</header>'
      + '<div class="kp-switch">'
      + '  <button class="kp-switch-now" data-act="all">' + nowName + '<span class="kp-caret">▾</span></button>'
      + '  <p class="kp-now-hint"></p>'
      + '</div>'
      + '<div class="kp-menu-wrap"><div class="kp-menu">' + menuGroups + '</div></div>'
      + '<main class="kp-body"></main>';

    this.bindShell(shell);
    this.renderTab(shell.querySelector('.kp-body'));

    this._lastSig = this.signature();
    if (boot) this.playBoot();
  }

  /* 入场动画的第二段：页签错峰、正文卡片依次浮现。
   * 全走 CSS 变量 + opacity/transform，不碰布局属性；
   * 系统开了「减弱动态效果」时 CSS 媒体查询会把时长压到 0，这里不用特判。 */
  playBoot() {
    const shell = this.contentEl && this.contentEl.querySelector('.kp-shell');
    if (!shell || typeof shell.querySelectorAll !== 'function') return;
    try {
      shell.querySelectorAll('.kp-tab').forEach(function (b, i) {
        if (b.style && b.style.setProperty) b.style.setProperty('--kp-in-delay', introDelay(i, 26, 120, 520) + 'ms');
      });
      const body = shell.querySelector('.kp-body');
      if (body && typeof body.querySelectorAll === 'function') {
        body.querySelectorAll('.kp-card, .kp-kpi, .kp-section').forEach(function (n, i) {
          if (n.style && n.style.setProperty) n.style.setProperty('--kp-in-delay', introDelay(i, 40, 260, 900) + 'ms');
        });
      }
    } catch (e) {
      console.error('[pulsewright] playBoot failed', e);
    }

    /* 入场跑完就摘掉 .kp-boot：动画层与 will-change 不长期驻留，
     * 后续滚动、切页签都是纯静态渲染，帧率不受影响。 */
    const self = this;
    if (this._bootTimer) window.clearTimeout(this._bootTimer);
    this._bootTimer = window.setTimeout(function () {
      self._bootTimer = 0;
      const s = self.contentEl && self.contentEl.querySelector('.kp-shell');
      if (s && s.classList && s.classList.remove) s.classList.remove('kp-boot');
    }, 1600);
  }

  bindShell(shell) {
    const self = this;
    const wrap = shell.querySelector('.kp-menu-wrap');
    const allBtn = shell.querySelector('[data-act="all"]');
    if (allBtn && wrap) {
      allBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        const open = !wrap.classList.contains('is-open');
        wrap.classList.toggle('is-open', open);
        allBtn.classList.toggle('is-open', open);
      });
      /* 点空白处收起：只绑一次，避免每次重绘都堆监听器。 */
      if (!this._outsideBound) {
        this._outsideBound = true;
        document.addEventListener('click', function (ev) {
          const w = self.contentEl.querySelector('.kp-menu-wrap');
          const b2 = self.contentEl.querySelector('[data-act="all"]');
          if (!w || !w.classList.contains('is-open')) return;
          if (w.contains(ev.target) || (b2 && b2.contains(ev.target))) return;
          w.classList.remove('is-open');
          if (b2) b2.classList.remove('is-open');
        });
      }
    }
    shell.querySelectorAll('[data-tab]').forEach(function (b) {
      b.addEventListener('click', function () {
        self.tab = b.getAttribute('data-tab');
        if (wrap) wrap.classList.remove('is-open');
        if (allBtn) allBtn.classList.remove('is-open');
        self.saveViewState();
        self.render();
      });
    });
    const sceneBtn = shell.querySelector('[data-act="scene"]');
    if (sceneBtn) sceneBtn.addEventListener('click', function () { self.plugin.cycleScene(); self.render(); });
    const rescanBtn = shell.querySelector('[data-act="rescan"]');
    if (rescanBtn) rescanBtn.addEventListener('click', async function () {
      rescanBtn.textContent = '扫描中…';
      await self.plugin.rescan(true);
      self.render();
    });
  }

  renderTab(body) {
    if (!body) return;
    const hintEl = this.contentEl.querySelector('.kp-now-hint');
    if (hintEl) hintEl.textContent = PAGE_HINTS[this.tab] || '';
    body.empty();
    body.classList.remove('kp-page-in');
    switch (this.tab) {
      case 'today': this.renderToday(body); break;
      case 'lanes': this.renderLanes(body); break;
      case 'strata': this.renderStrata(body); break;
      case 'moon': this.renderMoon(body); break;
      case 'year': this.renderYear(body); break;
      case 'review': this.renderReview(body); break;
      case 'map': this.renderMap(body); break;
      case 'insight': this.renderInsight(body); break;
      case 'memo': this.renderMemo(body); break;
      case 'data': this.renderData(body); break;
      default: this.renderBoard(body);
    }
    if (!this._skipIn) {
      void body.offsetWidth;
      body.classList.add('kp-page-in');
    }
  }


  /* ---------- 今天（一屏） ---------- */

  /* 一屏之内把该看的看完：今天怎么样、这周怎么样、最近有没有断、能动手做点什么。 */
  renderToday(body) {
    const daily = this.daily();
    const st = streaks(daily);
    const today = startOfDay(new Date());
    const todayKey = dayKeyOf(today.getTime());
    const e = daily[todayKey] || null;
    const words = e ? (e.words || 0) : 0;
    const touched = e && e.touched ? e.touched.length : 0;

    // 昨天与近七天，用来给数字一个参照
    const yKey = dayKeyOf(addDays(today, -1).getTime());
    const yWords = daily[yKey] ? daily[yKey].words || 0 : 0;
    const diff = words - yWords;
    let week7 = 0;
    for (let i = 0; i < 7; i++) {
      const k = dayKeyOf(addDays(today, -i).getTime());
      week7 += daily[k] ? daily[k].words || 0 : 0;
    }
    const avg7 = Math.round(week7 / 7);

    // 十二周时间带 + 月份刻度
    let maxW = 1;
    Object.keys(daily).forEach(function (k) {
      const v = daily[k].words || 0;
      if (v > maxW) maxW = v;
    });
    const start = addDays(today, -83);
    const cells = [];
    const ticks = [];
    for (let i = 0; i < 84; i++) {
      const d = addDays(start, i);
      const k = dayKeyOf(d.getTime());
      const v = daily[k] ? (daily[k].words || 0) : 0;
      const now = i === 83 ? ' is-now' : '';
      cells.push(v > 0
        ? '<i class="kp-bd-cell is-on' + now + '" style="opacity:' + (0.34 + (v / maxW) * 0.6).toFixed(2) + '"></i>'
        : '<i class="kp-bd-cell' + now + '"></i>');
      if (d.getDate() === 1) {
        ticks.push('<span style="grid-column:' + (i + 1) + '">' + (d.getMonth() + 1) + '月</span>');
      }
    }

    // 最近七天七根柱（滚动，最后一根是今天）——周一不会只剩一根
    const wkBars = [];
    let wkMax = 1;
    const wkVals = [];
    for (let i = 6; i >= 0; i--) {
      const d = addDays(today, -i);
      const k = dayKeyOf(d.getTime());
      const v = daily[k] ? daily[k].words || 0 : 0;
      wkVals.push(v);
      if (v > wkMax) wkMax = v;
    }
    const WD = ['日', '一', '二', '三', '四', '五', '六'];
    for (let i = 0; i < 7; i++) {
      const d = addDays(today, i - 6);
      const h = Math.round(6 + (wkVals[i] / wkMax) * 40);
      wkBars.push('<span class="kp-wk-col' + (i === 6 ? ' is-today' : '') + '">'
        + (wkVals[i] > 0 ? '<i style="height:' + h + 'px"></i>' : '')
        + '<em>' + (i === 6 ? '今天' : WD[d.getDay()]) + '</em></span>');
    }
    const wkSum = wkVals.reduce(function (a, b) { return a + b; }, 0);

    const wrec = weekWordsRecap(daily, Date.now());
    let weekRecapLine = '';
    if (wrec.hasData) {
      const sign = wrec.pct > 0 ? '+' : '';
      const tone = wrec.pct > 0 ? ' is-up' : (wrec.pct < 0 ? ' is-down' : '');
      weekRecapLine = '<div class="kp-wk-recap mono' + tone + '">上周 ' + fmtInt(wrec.last)
        + ' 字 · 比前一周 ' + sign + wrec.pct + '%</div>';
    }

    const picks = echoPicks((this.plugin.data && this.plugin.data.noteCache) || {}, Date.now(), 2);

    const sign = diff > 0 ? '+' : '';
    const cmp = yWords > 0
      ? '比昨天 ' + sign + fmtInt(diff) + ' 字'
      : '近七天日均 ' + fmtInt(avg7) + ' 字';

    body.innerHTML = ''
      + '<section class="kp-op">'
      + '  <div class="kp-op-nums">'
      + '    <div class="kp-op-num"><b>' + fmtInt(words) + '</b><span>今天写的字</span><em>' + cmp + '</em></div>'
      + '    <div class="kp-op-num"><b>' + touched + '</b><span>动过的笔记</span><em>近七天日均 ' + fmtInt(avg7) + ' 字</em></div>'
      + '    <div class="kp-op-num"><b>' + st.current + '</b><span>连续天数</span><em>最长 ' + st.longest + ' 天</em></div>'
      + '  </div>'
      + '  <div class="kp-op-band">'
      + '    <div class="kp-op-band-hd"><span>最近 12 周</span><span>今天</span></div>'
      + '    <div class="kp-bd-track">' + cells.join('') + '</div>'
      + '    <div class="kp-bd-axis">' + ticks.join('') + '</div>'
      + '  </div>'
      + '  <div class="kp-op-week">'
      + '    <div class="kp-op-week-hd"><span>最近七天</span><em>共 ' + fmtInt(wkSum) + ' 字</em></div>'
      + '    <div class="kp-wk">' + wkBars.join('') + '</div>'
      + '    ' + weekRecapLine
      + '  </div>'
      + '</section>'
      + this.todayCard()
      + this.echoCard(picks);

    this.bindTodayCard(body);
    this.fillEcho(body, picks);
  }

  /* 一屏里唯一一张卡：一篇你很久没打开、但当时写得不少的笔记。 */
  /* 今天被「先放着」的笔记，按天记；跨天自动清空。 */
  snoozedToday() {
    if (this._snoozeDay !== dayKeyToday()) {
      this._snoozeDay = dayKeyToday();
      this._snoozePaths = {};
    }
    if (!this._snoozePaths) this._snoozePaths = {};
    return this._snoozePaths;
  }

  todayCard() {
    const skip = this.snoozedToday();
    const cache = (this.plugin.data && this.plugin.data.noteCache) || {};
    const seedBase = parseInt(dayKeyToday().replace(/-/g, ''), 10) || 0;

    // 1) 先按「该翻的旧账」挑，跳过今天已经放下的
    for (let k = 0; k <= (this._shuffle || 0); k++) {
      const cand = pickReview(cache, Date.now(), seedBase + k * 7919);
      if (!cand) break;
      if (skip[cand.path]) continue;
      if (k < (this._shuffle || 0)) continue;
      return this.todayCardHtml(cand.path, cand.title, cand.words,
        '这篇你已经 ' + cand.days + ' 天没打开了',
        dayKeyOf(cand.mtime) + ' 写的 · ' + fmtInt(cand.words) + ' 词', '打开接着写');
    }

    // 2) 没有旧账可翻（或全被放下了）：在最近写过的几篇里轮一个
    const recents = recentNotes(cache, 40).filter(function (r) { return !skip[r.path]; });
    if (!recents.length) {
      const anyNote = Object.keys(cache).length > 0;
      return '<section class="kp-card kp-today-free">'
        + '<h3>' + (anyNote ? '今天挑完了' : '这个库还是空的') + '</h3>'
        + '<p class="kp-hint">' + (anyNote
          ? '放下的都记住了，明天再给你看。想再看一轮就点下面。'
          : '写下第一篇，明天这里就有东西可说了。上面那条时间带会跟着长出来。') + '</p>'
        + (anyNote ? '<div class="kp-today-acts"><button class="kp-btn" data-reset="1">再来一轮</button></div>' : '')
        + '</section>';
    }
    const fresh = recents[(this._shuffle || 0) % recents.length];
    const agoD = Math.max(0, Math.round((startOfDay(new Date()).getTime() - startOfDay(new Date(fresh.mtime)).getTime()) / 86400000));
    const whenTxt = agoD === 0 ? '今天写的' : (agoD === 1 ? '昨天写的' : agoD + ' 天前写的');
    const why = (this._shuffle || 0) > 0 ? '没有该翻的旧账 · 换了一篇近期的' : '没有该翻的旧账 · 最近在写这篇';
    return this.todayCardHtml(fresh.path, fresh.title, fresh.words,
      why, whenTxt + ' · ' + fmtInt(fresh.words) + ' 词', '接着写');
  }

  todayCardHtml(path, title, words, why, meta, openLabel) {
    return '<section class="kp-card kp-today-card" data-today="' + escapeHtml(path) + '">'
      + '  <div class="kp-today-why">' + why + '</div>'
      + '  <h3 class="kp-today-title">' + escapeHtml(title) + '</h3>'
      + '  <p class="kp-today-lead" data-lead="1"></p>'
      + '  <div class="kp-today-meta">' + meta + '</div>'
      + '  <div class="kp-today-acts">'
      + '    <button class="kp-btn kp-btn-p" data-note="' + escapeHtml(path) + '">' + openLabel + '</button>'
      + '    <button class="kp-btn" data-shuffle="1">换一篇</button>'
      + '    <button class="kp-btn" data-snooze="' + escapeHtml(path) + '">先放着</button>'
      + '  </div>'
      + '</section>';
  }

  bindTodayCard(body) {
    const self = this;
    /* 「今天挑完了」那张卡没有 .kp-today-card，所以先绑它，再判断卡片在不在。 */
    const reset = body.querySelector('[data-reset]');
    if (reset) {
      reset.addEventListener('click', function () {
        self._snoozeDay = dayKeyToday();
        self._snoozePaths = {};
        self._shuffle = 0;
        self.renderBodyOnly();
      });
    }
    const card = body.querySelector('.kp-today-card');
    if (!card) return;
    const path = card.getAttribute('data-today');
    card.querySelectorAll('[data-note]').forEach(function (b) {
      b.addEventListener('click', function (ev) { ev.preventDefault(); self.openNote(path); });
    });
    card.querySelectorAll('[data-shuffle]').forEach(function (b) {
      b.addEventListener('click', function (ev) {
        ev.preventDefault();
        self._shuffle = (self._shuffle || 0) + 1;
        self.renderBodyOnly();
      });
    });
    card.querySelectorAll('[data-snooze]').forEach(function (b) {
      b.addEventListener('click', function () {
        const sk = self.snoozedToday();
        sk[b.getAttribute('data-snooze') || path] = 1;
        self._shuffle = 0;
        self.renderBodyOnly();
      });
    });
    const lead = card.querySelector('[data-lead]');
    const vault = self.app && self.app.vault;
    const file = vault ? vault.getAbstractFileByPath(path) : null;
    if (lead && file) {
      Promise.resolve(vault.cachedRead(file)).then(function (t) {
        const one = echoLead(t, 60);
        if (one) lead.textContent = '「' + one + '」';
      }).catch(function () { /* 忽略 */ });
    }
  }

  /* ---------- 看板 ---------- */

  renderBoard(body) {
    const daily = this.daily();
    const days = this.windowDays();
    const s = summarize(days);
    const st = streaks(daily);
    const todayKey = dayKeyToday();
    const todayEntry = daily[todayKey] || null;
    const cap = this.plugin.settings.scoreCap || DEFAULT_SETTINGS.scoreCap;
    const picks = echoPicks((this.plugin.data && this.plugin.data.noteCache) || {}, Date.now(), 3);

    const rangeChips = RANGES.map(function (r) {
      return '<button class="kp-chip' + (r.id === this.range ? ' is-active' : '') + '" data-range="' + r.id + '">' + r.name + '</button>';
    }, this).join('');

    const metricChips = METRICS.map(function (m) {
      return '<button class="kp-chip' + (m.id === this.metric ? ' is-active' : '') + '" data-metric="' + m.id + '">' + m.name + '</button>';
    }, this).join('');

    const valueByKey = {};
    const keyList = Object.keys(daily);
    for (const k of keyList) valueByKey[k] = metricValue(daily[k], this.metric);

    const activePct = pct(s.active, s.days);
    const todayScore = todayEntry ? (todayEntry.score || 0) : 0;

    body.innerHTML = ''
      + this.todayFacts(daily, st)
      + '<section class="kp-section kp-chips">'
      + '  <div class="kp-chiprow">' + rangeChips + '</div>'
      + '</section>'
      + '<section class="kp-kpis">'
      + this.kpi('活跃天数', s.active + ' / ' + s.days, '有产出的天数占 ' + activePct + '%', '')
      + this.kpi('当前连续', st.current + ' 天', '最长 ' + st.longest + ' 天', '')
      + this.kpi('投入时间', fmtDur(s.focusSec), '专注 · 交互另计', '')
      + this.kpi('新增词数', fmtInt(s.words), '新建 ' + fmtInt(s.notes) + ' 篇', '')
      + this.kpi('内链 / 修订', fmtInt(s.links) + ' / ' + fmtInt(s.revisions), '最高一天 ' + fmtInt(s.best || 0), '')
      + '</section>'

      + '<section class="kp-card">'
      + '  <div class="kp-sec-head"><h3>年度知识活跃脉冲</h3>'
      + '    <div class="kp-chiprow">' + metricChips + '</div></div>'
      + svgHeatmap(valueByKey, { weeks: 53, format: this.metric === 'focusSec' ? fmtDur : fmtInt })
      + '  <div class="kp-legend"><span>少</span>'
      + '    <i class="kp-hl-0"></i><i class="kp-hl-1"></i><i class="kp-hl-2"></i><i class="kp-hl-3"></i><i class="kp-hl-4"></i>'
      + '  <span>多</span><span class="kp-legend-note">点任意格子看当天明细</span></div>'
      + '</section>'

      + '<section class="kp-card kp-two-col">'
      + '  <div>'
      + '    <h3>最近 30 天</h3>'
      + svgLine(daysInWindow(daily, addDays(startOfDay(new Date()), -29), startOfDay(new Date())).map(function (d) {
        return { label: d.key, v: d.entry ? d.entry.score || 0 : 0 };
      }), { height: 150 })
      + '  </div>'
      + '  <div>'
      + '    <h3>星期分布</h3>'
      + svgBars(this.weekdayItems(), { height: 150 })
      + '  </div>'
      + '</section>'
      + this.echoCard(picks)
      + this.reviewCard()
      + this.topNotesCard();

    this.bindBoard(body);
    this.fillEcho(body, picks);
  }

  /* ---------- 惦记 ---------- */

  renderLanes(body) {
    const idx = (this.plugin.data && this.plugin.data.noteCache) || {};
    if (!Object.keys(idx).length) {
      body.innerHTML = '<section class="kp-card"><h3>惦记</h3>'
        + '<p class="kp-hint">还没有索引到笔记，点右上角「刷新」扫一遍。</p></section>';
      return;
    }
    if (this._laneEdit) { this.renderLaneEditor(body); return; }

    const cfg = parseLanes(this.plugin.settings.lanesText);
    if (!cfg.length) {
      this._laneEdit = true;
      this.renderLaneEditor(body);
      return;
    }

    const now = Date.now();
    const items = cfg.map(function (lane) {
      const stats = laneStats(idx, lane, now);
      return { lane: lane, stats: stats, series: laneSeries(stats, 84, now) };
    });

    const rows = items.map(function (it) {
      const st = laneStatus(it.stats, it.lane);
      const cells = it.series.map(function (d) {
        return '<i class="kp-lane-cell' + (d.hit ? ' is-hit' : '') + '"></i>';
      }).join('');
      return '<div class="kp-lane">'
        + '<div class="kp-lane-name">' + escapeHtml(it.lane.name)
        + (it.lane.perWeek ? '<em>每周 ' + it.lane.perWeek + ' 次</em>' : '')
        + '</div>'
        + '<div class="kp-lane-track">' + cells + '</div>'
        + '<div class="kp-lane-st' + (st.cls ? ' is-' + st.cls : '') + '">' + escapeHtml(st.text) + '</div>'
        + '</div>';
    }).join('');

    const top = laneAdvice(items);
    const ask = top
      ? '<section class="kp-card kp-lane-ask" data-lane-ask="1"><h3>它只想说一句</h3>'
        + '<p>' + escapeHtml(laneAdviceText(top)) + '</p>'
        + '<p class="kp-hint">要现在给它半小时，还是先记一笔「推迟到哪天」？写下来比记在脑子里牢。</p>'
        + '<div class="kp-lane-acts">'
        + (top.stats.lastPath ? '<button class="kp-btn kp-btn-sm" data-note="' + escapeHtml(top.stats.lastPath) + '">打开那篇</button>' : '')
        + '<button class="kp-btn kp-btn-sm" data-lane-snooze="' + escapeHtml(top.lane.name) + '">记一笔推迟</button>'
        + '</div></section>'
      : '';

    body.innerHTML = ''
      + '<section class="kp-card kp-lanes">'
      + '  <div class="kp-sec-head"><h3>你最近有没有偏</h3><span class="kp-eyebrow">最近 12 周</span></div>'
      + '  <p class="kp-hint">这几条是你自己说要在意的事。横着看是时间，缺一块就是那几天没碰。</p>'
      + '  <div class="kp-lane-list">' + rows + '</div>'
      + '  <div class="kp-lane-axis"><span>12 周前</span><span>6 周前</span><span>今天</span></div>'
      + '  <div class="kp-row-actions"><button class="kp-btn kp-btn-sm" data-act="lanes-edit">改这几条</button></div>'
      + '</section>'
      + ask;

    const self = this;
    const btn = body.querySelector('[data-act="lanes-edit"]');
    if (btn) btn.addEventListener('click', function () {
      self._laneEdit = true;
      self.renderBodyOnly();
    });
    body.querySelectorAll('[data-lane-ask] [data-note]').forEach(function (a) {
      a.addEventListener('click', function (ev) {
        ev.preventDefault();
        self.openNote(a.getAttribute('data-note'));
      });
    });
    body.querySelectorAll('[data-lane-snooze]').forEach(function (b) {
      b.addEventListener('click', function () {
        const nm = b.getAttribute('data-lane-snooze') || '';
        b.textContent = '已记下';
        b.disabled = true;
        self.plugin.addMemo('推迟：' + nm + ' —— 还欠一次，' + dayKeyToday() + ' 记下');
      });
    });
  }

  /* 编辑这几条线：直接给一段可改的文本，不另做一套表单。 */
  renderLaneEditor(body) {
    const idx = (this.plugin.data && this.plugin.data.noteCache) || {};
    let text = String(this.plugin.settings.lanesText || '').trim();
    if (!text) {
      const sug = suggestLanes(idx, 5);
      text = sug.length
        ? sug.map(function (s) { return s.name + ' | ' + s.match + ' | 0'; }).join('\n')
        : '练琴 | tag:练琴 | 3\n项目 | folder:项目 | 0';
    }
    body.innerHTML = ''
      + '<section class="kp-card kp-lane-editor">'
      + '  <div class="kp-sec-head"><h3>你在意哪几件事</h3><span class="kp-eyebrow">只有你自己知道</span></div>'
      + '  <p class="kp-hint">一行一条：<b>名称 | 匹配 | 每周几次</b>。匹配写 <code>tag:练琴</code>、'
      + '<code>folder:项目</code> 或 <code>path:英语</code>；每周几次写 0 表示不设节奏，只看上次动过是几天前。'
      + '下面几行是按你库里最常见的目录预填的，改成你真正在意的事就行。</p>'
      + '  <textarea class="kp-lane-edit" spellcheck="false" rows="7">' + escapeHtml(text) + '</textarea>'
      + '  <div class="kp-row-actions">'
      + '    <button class="kp-btn kp-btn-primary" data-act="lane-save">开始</button>'
      + '    <button class="kp-btn" data-act="lane-cancel">取消</button>'
      + '  </div>'
      + '</section>';

    const self = this;
    const ta = body.querySelector('.kp-lane-edit');
    const save = body.querySelector('[data-act="lane-save"]');
    if (save) save.addEventListener('click', function () {
      self.plugin.settings.lanesText = ta ? ta.value : '';
      self._laneEdit = false;
      Promise.resolve(self.plugin.saveSettings()).then(function () { self.renderBodyOnly(); });
    });
    const cancel = body.querySelector('[data-act="lane-cancel"]');
    if (cancel) cancel.addEventListener('click', function () {
      self._laneEdit = false;
      self.renderBodyOnly();
    });
  }

  /* 首页三个事实：今天写了多少、动了哪几篇、连了几天。不出现分数。 */
  todayFacts(daily, st) {
    const e = daily[dayKeyToday()] || null;
    return '<section class="kp-facts">'
      + '<div class="kp-fact"><b>' + fmtInt(e ? e.words || 0 : 0) + '</b><span>今天写的字</span></div>'
      + '<div class="kp-fact"><b>' + (e && e.touched ? e.touched.length : 0) + '</b><span>动过的笔记</span></div>'
      + '<div class="kp-fact"><b>' + st.current + '</b><span>连续天数</span></div>'
      + '</section>';
  }

  echoCard(picks) {
    if (!picks || !picks.length) {
      return '<section class="kp-card kp-echo"><h3>回声</h3>'
        + '<p class="kp-hint">库里还没有够老的笔记。等它长大一点，这里会自己说话。</p></section>';
    }
    const cards = picks.map(function (p, i) {
      return '<div class="kp-echo-card">'
        + '<div class="kp-echo-when">' + escapeHtml(p.label) + '</div>'
        + '<a class="kp-echo-title" data-note="' + escapeHtml(p.path) + '" href="#">' + escapeHtml(p.title) + '</a>'
        + '<p class="kp-echo-lead" data-echo="' + i + '"></p>'
        + '<div class="kp-echo-meta">' + escapeHtml(p.key) + ' · ' + fmtInt(p.words) + ' 词</div>'
        + '</div>';
    }).join('');
    return '<section class="kp-card kp-echo">'
      + '<div class="kp-sec-head"><h3>回声</h3><span class="kp-eyebrow">你以前写过这些话</span></div>'
      + '<div class="kp-echo-grid">' + cards + '</div></section>';
  }

  /* 正文按需读三篇，不进缓存；读不到就留空，不报错。 */
  fillEcho(body, picks) {
    const vault = this.app && this.app.vault;
    if (!vault || !picks || !picks.length) return;
    picks.forEach(function (p, i) {
      const slot = body.querySelector('[data-echo="' + i + '"]');
      if (!slot) return;
      try {
        const f = vault.getAbstractFileByPath(p.path);
        if (!f) return;
        Promise.resolve(vault.cachedRead(f)).then(function (text) {
          const lead = echoLead(text, 56);
          if (lead) slot.textContent = lead;
        }).catch(function () { /* 忽略 */ });
      } catch (e) { /* 忽略 */ }
    });
  }

  /* 今日回顾：从「写得不短、但一个月没碰」的笔记里挑一篇，同一天稳定。
   * 目的是把沉底的旧笔记重新推到手边，而不是再列一次排行榜。 */
  reviewCard() {
    const seed = parseInt(dayKeyToday().replace(/-/g, ''), 10) || 0;
    const n = pickReview(this.plugin.data.noteCache || {}, Date.now(), seed);
    if (!n) {
      return '<section class="kp-card kp-review"><h3>今日回顾</h3>'
        + '<p class="kp-hint">还没有「写了 50 词以上、且超过 30 天没动」的笔记。</p></section>';
    }
    return '<section class="kp-card kp-review">'
      + '  <div class="kp-sec-head"><h3>今日回顾</h3><span class="kp-eyebrow">沉底 ' + n.days + ' 天</span></div>'
      + '  <a class="kp-review-title" data-note="' + escapeHtml(n.path) + '" href="#">' + escapeHtml(n.title) + '</a>'
      + '  <p class="kp-hint">' + fmtInt(n.words) + ' 词 · 上次修改 ' + dayKeyOf(n.mtime) + ' · 今天要不要补一句？</p>'
      + '</section>';
  }

  /* 笔记排行：按词数与内链加权，点标题直接在库里打开。 */
  topNotesCard() {
    const list = topNotes(this.plugin.data.noteCache || {}, 8);
    if (!list.length) {
      return '<section class="kp-card"><h3>最厚重的笔记</h3>'
        + '<p class="kp-hint">还没有索引到笔记。</p></section>';
    }
    const max = Math.max(1, list[0].weight);
    const rows = list.map(function (n) {
      return '<li class="kp-rank-item">'
        + '<span class="kp-rank-idx">' + (list.indexOf(n) + 1) + '</span>'
        + '<a class="kp-rank-title" data-note="' + escapeHtml(n.path) + '" href="#">' + escapeHtml(n.title) + '</a>'
        + '<span class="kp-rank-track"><i style="width:' + pct(n.weight, max) + '%"></i></span>'
        + '<span class="kp-rank-num">' + fmtInt(n.words) + ' 词</span>'
        + '</li>';
    }).join('');
    return '<section class="kp-card"><h3>最厚重的笔记</h3>'
      + '<p class="kp-hint">按词数 + 内链×50 估影响力，点标题打开笔记。</p>'
      + '<ol class="kp-rank">' + rows + '</ol></section>';
  }

  kpi(label, value, sub, cls) {
    return '<div class="kp-kpi ' + (cls || '') + '"><span class="kp-kpi-label">' + label + '</span>'
      + '<b class="kp-kpi-value">' + value + '</b>'
      + '<span class="kp-kpi-sub">' + sub + '</span></div>';
  }

  weekdayItems() {
    const daily = this.daily();
    const sums = [0, 0, 0, 0, 0, 0, 0];
    for (const k of Object.keys(daily)) {
      const d = parseKey(k);
      if (!d) continue;
      const idx = (d.getDay() + 6) % 7;
      sums[idx] += daily[k].score || 0;
    }
    return sums.map(function (v, i) { return { label: WEEKDAY_CN[i], value: v }; });
  }

  bindBoard(body) {
    const self = this;
    body.querySelectorAll('[data-range]').forEach(function (b) {
      b.addEventListener('click', function () { self.range = b.getAttribute('data-range'); self.saveViewState(); self.renderBodyOnly(); });
    });
    body.querySelectorAll('[data-metric]').forEach(function (b) {
      b.addEventListener('click', function () { self.metric = b.getAttribute('data-metric'); self.saveViewState(); self.renderBodyOnly(); });
    });
    body.querySelectorAll('rect[data-day]').forEach(function (r) {
      r.addEventListener('click', function () { self.openDay(r.getAttribute('data-day')); });
    });
    bindHeatTips(body);
    body.querySelectorAll('[data-note]').forEach(function (a) {
      a.addEventListener('click', function (ev) {
        ev.preventDefault();
        self.openNote(a.getAttribute('data-note'));
      });
    });
  }

  openDay(key) {
    new DayDetailModal(this.app, this.plugin, key).open();
  }

  openNote(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file) {
      new Notice('笔记不存在或已被移动：' + path);
      return;
    }
    this.app.workspace.getLeaf(false).openFile(file).catch(function (err) {
      console.error('[pulsewright] openNote failed', err);
      new Notice('打开笔记失败：' + (err && err.message ? err.message : err));
    });
  }

  /* ---------- 知识地层 ---------- */

  strataWeeks(count) {
    const daily = this.daily();
    const today = startOfDay(new Date());
    const first = addDays(startOfWeek(today), -7 * (count - 1));
    const out = [];
    for (let i = 0; i < count; i++) {
      const start = addDays(first, i * 7);
      const layers = [0, 0, 0, 0];
      let words = 0, notes = 0, links = 0, revs = 0;
      for (let j = 0; j < 7; j++) {
        const k = dayKeyOf(addDays(start, j).getTime());
        const e = daily[k];
        if (!e) continue;
        words += e.words || 0;
        notes += e.notes || 0;
        links += e.links || 0;
        revs += e.revisions || 0;
      }
      layers[0] = words;
      layers[1] = notes;
      layers[2] = links;
      layers[3] = revs;
      out.push({ label: dayKeyOf(start.getTime()), layers: layers });
    }
    return out;
  }

  renderStrata(body) {
    const weeks = this.strataWeeks(52);
    const total = weeks.reduce(function (a, w) {
      return a + w.layers[0] + w.layers[1] + w.layers[2] + w.layers[3];
    }, 0);
    body.innerHTML = ''
      + '<section class="kp-card">'
      + '  <div class="kp-sec-head"><h3>知识地层 · 近 52 周</h3><span class="kp-hint">按周堆积</span></div>'
      + svgStrata(weeks, {})
      + '  <div class="kp-legend kp-legend-stack">'
      + '    <span><i class="kp-stratum-swatch-0"></i>新增词数</span>'
      + '    <span><i class="kp-stratum-swatch-1"></i>新建笔记</span>'
      + '    <span><i class="kp-stratum-swatch-2"></i>内链</span>'
      + '    <span><i class="kp-stratum-swatch-3"></i>修订</span>'
      + '  </div>'
      + '  <p class="kp-hint">这一年累计堆了 ' + fmtInt(total) + ' 个知识单元。层越厚，那一周越用力。</p>'
      + '</section>';
    bindHeatTips(body);
  }

  /* ---------- 月相日历 ---------- */

  renderMoon(body) {
    const today = new Date();
    if (!this.moonMonth) this.moonMonth = { y: today.getFullYear(), m: today.getMonth() };
    const y = this.moonMonth.y;
    const m = this.moonMonth.m;
    const daily = this.daily();
    const firstDay = new Date(y, m, 1);
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const offset = (firstDay.getDay() + 6) % 7;
    let max = 1;
    for (let d = 1; d <= daysInMonth; d++) {
      const k = y + '-' + pad2(m + 1) + '-' + pad2(d);
      const e = daily[k];
      if (e && e.score > max) max = e.score;
    }
    let cells = '';
    for (let i = 0; i < offset; i++) cells += '<div class="kp-moon-cell is-empty"></div>';
    const todayKey = dayKeyToday();
    for (let d = 1; d <= daysInMonth; d++) {
      const k = y + '-' + pad2(m + 1) + '-' + pad2(d);
      const e = daily[k];
      const ms = new Date(y, m, d, 12, 0, 0).getTime();
      const phase = moonPhase(ms);
      const inten = e ? Math.min(1, (e.score || 0) / max) : 0;
      const cls = 'kp-moon-cell' + (k === todayKey ? ' is-today' : '') + (e && e.score > 0 ? ' has-score' : '');
      cells += '<div class="' + cls + '" data-day="' + k + '" data-tip="' + k + ' · ' + (e ? (e.score || 0) : 0) + ' 分">'
        + svgMoon(phase, inten, 34)
        + '<span class="kp-moon-day">' + d + '</span></div>';
    }
    const head = ['一', '二', '三', '四', '五', '六', '日'].map(function (x) {
      return '<div class="kp-moon-dow">' + x + '</div>';
    }).join('');
    body.innerHTML = ''
      + '<section class="kp-card">'
      + '  <div class="kp-sec-head">'
      + '    <h3>月相日历 · ' + y + ' 年 ' + (m + 1) + ' 月</h3>'
      + '    <div class="kp-chiprow"><button class="kp-chip" data-moon="-1">‹ 上月</button>'
      + '    <button class="kp-chip" data-moon="0">本月</button>'
      + '    <button class="kp-chip" data-moon="1">下月 ›</button></div>'
      + '  </div>'
      + '  <div class="kp-moon-grid">' + head + cells + '</div>'
      + '  <p class="kp-hint">月相由当天日期真实计算，亮度＝当天产出强度。越接近满月，那天越用力。</p>'
      + '</section>';
    const self = this;
    body.querySelectorAll('[data-moon]').forEach(function (b) {
      b.addEventListener('click', function () {
        const dir = parseInt(b.getAttribute('data-moon'), 10);
        if (dir === 0) { const t = new Date(); self.moonMonth = { y: t.getFullYear(), m: t.getMonth() }; }
        else {
          const nd = new Date(y, m + dir, 1);
          self.moonMonth = { y: nd.getFullYear(), m: nd.getMonth() };
        }
        self.renderBodyOnly();
      });
    });
    body.querySelectorAll('.kp-moon-cell[data-day]').forEach(function (c) {
      c.addEventListener('click', function () { self.openDay(c.getAttribute('data-day')); });
    });
    bindHeatTips(body);
  }

  /* ---------- 年度画像 ---------- */

  renderYear(body) {
    const daily = this.daily();
    const now = new Date();
    const y = (this.yearPick || now.getFullYear());
    this.yearPick = y;
    const months = [];
    let total = 0, activeDays = 0, bestDay = null, bestScore = 0, words = 0, notes = 0;
    for (let m = 0; m < 12; m++) {
      let v = 0;
      const dim = new Date(y, m + 1, 0).getDate();
      for (let d = 1; d <= dim; d++) {
        const k = y + '-' + pad2(m + 1) + '-' + pad2(d);
        const e = daily[k];
        if (!e) continue;
        v += e.score || 0;
        total += e.score || 0;
        words += e.words || 0;
        notes += e.notes || 0;
        if (isActiveDay(e)) activeDays += 1;
        if ((e.score || 0) > bestScore) { bestScore = e.score; bestDay = k; }
      }
      months.push({ label: MONTH_CN[m], value: v });
    }
    const weekday = this.weekdayItems();
    const topWeekday = weekday.reduce(function (a, b) { return b.value > a.value ? b : a; }, weekday[0]);
    const topMonth = months.reduce(function (a, b) { return b.value > a.value ? b : a; }, months[0]);

    const yearNames = [];
    const keys = Object.keys(daily).map(function (k) { return k.slice(0, 4); });
    const uniq = {};
    for (const k of keys) uniq[k] = 1;
    for (const k of Object.keys(uniq).sort()) yearNames.push(k);

    const yearChips = yearNames.map(function (yy) {
      return '<button class="kp-chip' + (String(yy) === String(y) ? ' is-active' : '') + '" data-year="' + yy + '">' + yy + '</button>';
    }).join('');

    body.innerHTML = ''
      + '<section class="kp-section kp-chips"><div class="kp-chiprow">' + yearChips + '</div></section>'
      + '<section class="kp-kpis">'
      + this.kpi(y + ' 年贡献分', fmtInt(total), '活跃 ' + activeDays + ' 天', 'big')
      + this.kpi('最高的一天', bestDay ? bestDay.slice(5) : '—', (bestScore || 0) + ' 分', '')
      + this.kpi('最活跃的月份', topMonth && topMonth.value ? topMonth.label : '—', fmtInt(topMonth ? topMonth.value : 0) + ' 分', '')
      + this.kpi('最活跃的星期', topWeekday && topWeekday.value ? topWeekday.label : '—', fmtInt(topWeekday ? topWeekday.value : 0) + ' 分', '')
      + '</section>'
      + '<section class="kp-card"><h3>' + y + ' 年月度分布</h3>' + svgBars(months, { height: 200 }) + '</section>'
      + '<section class="kp-card"><h3>这一年</h3>'
      + '<p class="kp-portrait">这一年你在库里留下 <b>' + fmtInt(words) + '</b> 个词、新建了 <b>' + fmtInt(notes) + '</b> 篇笔记，'
      + '累计 <b>' + fmtInt(total) + '</b> 分。最用力的是 <b>' + (topMonth && topMonth.value ? topMonth.label : '—') + '</b>，'
      + '最常在 <b>' + (topWeekday && topWeekday.value ? topWeekday.label : '—') + '</b> 动笔。'
      + (bestDay ? '单日最高出现在 <b>' + bestDay + '</b>（' + bestScore + ' 分）。' : '')
      + '</p></section>'
      + this.libraryCard(y);

    const self = this;
    body.querySelectorAll('[data-year]').forEach(function (b) {
      b.addEventListener('click', function () { self.yearPick = parseInt(b.getAttribute('data-year'), 10); self.renderBodyOnly(); });
    });
    const rep8 = body.querySelector('[data-act="year-report"]');
    if (rep8) rep8.addEventListener('click', function () { self.plugin.exportYearReport(self.yearPick); });
  }

  /* 库档案：不属于某一年，是整个库的底账。 */
  libraryCard(y) {
    const f = libraryFacts(this.plugin.data.noteCache || {}, this.daily());
    const longest = f.longest && f.longest.words
      ? '<div class="kp-lib-item"><span>最长的一篇</span><b>' + escapeHtml(f.longest.title) + '</b><em>' + fmtInt(f.longest.words) + ' 词</em></div>'
      : '';
    return '<section class="kp-card">'
      + '<div class="kp-sec-head"><h3>库档案</h3>'
      + '  <button class="kp-btn" data-act="year-report">导出 ' + y + ' 年报</button></div>'
      + '<div class="kp-lib">'
      + '  <div class="kp-lib-item"><span>第一次动笔</span><b>' + (f.firstDay || '—') + '</b><em>' + fmtInt(f.activeDays) + ' 天有产出</em></div>'
      + '  <div class="kp-lib-item"><span>平均每天</span><b>' + fmtInt(f.avgWords) + '</b><em>词</em></div>'
      + '  <div class="kp-lib-item"><span>笔记总数</span><b>' + fmtInt(f.noteCount) + '</b><em>篇</em></div>'
      + longest
      + '</div></section>';
  }

  /* ---------- 知识复盘 ---------- */

  renderReview(body) {
    const daily = this.daily();
    if (!this.reviewWeek) this.reviewWeek = startOfWeek(new Date());
    const start = this.reviewWeek;
    const md = weeklyMarkdown(daily, start);
    const end = addDays(start, 6);
    const cmp = weekCompare(daily, start);
    const arrow = cmp.delta > 0 ? '↑' : (cmp.delta < 0 ? '↓' : '→');
    const trendClass = cmp.delta > 0 ? 'is-up' : (cmp.delta < 0 ? 'is-down' : 'is-flat');
    const trendText = cmp.delta === 0
      ? '与上周持平'
      : (cmp.delta > 0 ? '比上周多 ' + fmtInt(cmp.delta) + ' 分' : '比上周少 ' + fmtInt(-cmp.delta) + ' 分');
    body.innerHTML = ''
      + '<section class="kp-section kp-chips">'
      + '  <div class="kp-chiprow">'
      + '    <button class="kp-chip" data-week="-1">‹ 上一周</button>'
      + '    <span class="kp-week-label">' + dayKeyOf(start.getTime()) + ' ~ ' + dayKeyOf(end.getTime()) + '</span>'
      + '    <button class="kp-chip" data-week="1">下一周 ›</button>'
      + '    <button class="kp-chip" data-week="0">本周</button>'
      + '  </div>'
      + '</section>'
      + '<section class="kp-card kp-compare">'
      + '  <div class="kp-compare-head">'
      + '    <h3>本周 vs 上周</h3>'
      + '    <span class="kp-compare-trend ' + trendClass + '">' + arrow + ' ' + trendText + '</span>'
      + '  </div>'
      + '  <div class="kp-compare-grid">'
      + '    <div><span>贡献分</span><b>' + fmtInt(cmp.current.score) + '</b><em>上周 ' + fmtInt(cmp.previous.score) + '</em></div>'
      + '    <div><span>新增词数</span><b>' + fmtInt(cmp.current.words) + '</b><em>上周 ' + fmtInt(cmp.previous.words) + '</em></div>'
      + '    <div><span>新建笔记</span><b>' + fmtInt(cmp.current.notes) + '</b><em>上周 ' + fmtInt(cmp.previous.notes) + '</em></div>'
      + '    <div><span>活跃天数</span><b>' + cmp.current.active + '</b><em>上周 ' + cmp.previous.active + '</em></div>'
      + '  </div>'
      + '</section>'
      + '<section class="kp-card kp-review">'
      + '  <pre class="kp-review-pre">' + escapeHtml(md) + '</pre>'
      + '  <div class="kp-row-actions">'
      + '    <button class="kp-btn kp-btn-primary" data-act="copy-week">复制 Markdown</button>'
      + '    <button class="kp-btn" data-act="save-week">写入库</button>'
      + '  </div>'
      + '</section>';
    const self = this;
    body.querySelectorAll('[data-week]').forEach(function (b) {
      b.addEventListener('click', function () {
        const dir = parseInt(b.getAttribute('data-week'), 10);
        self.reviewWeek = dir === 0 ? startOfWeek(new Date()) : addDays(start, 7 * dir);
        self.renderBodyOnly();
      });
    });
    body.querySelector('[data-act="copy-week"]').addEventListener('click', async function () {
      try {
        await navigator.clipboard.writeText(md);
        new Notice('复盘已复制到剪贴板');
      } catch (e) {
        new Notice('复制失败：' + e.message);
      }
    });
    body.querySelector('[data-act="save-week"]').addEventListener('click', async function () {
      const path = await self.plugin.writeVaultFile('复盘/复盘-' + weekLabel(start) + '.md', md);
      new Notice('已写入 ' + path);
    });
  }

  /* ---------- 速记 ---------- */

  renderMemo(body) {
    const all = (this.plugin.data.memos || []).slice();
    const q = (this.memoQuery || '').trim().toLowerCase();
    const memos = all.slice().reverse().filter(function (m) {
      if (!q) return true;
      return String(m.text || '').toLowerCase().indexOf(q) >= 0;
    });
    const shown = memos.slice(0, 50);
    const editIdx = typeof this.memoEdit === 'number' ? this.memoEdit : -1;
    const list = shown.map(function (memo) {
      const idx = all.indexOf(memo);
      if (idx === editIdx) {
        return '<li class="kp-memo-item is-editing">'
          + '<span class="kp-memo-time">' + escapeHtml(memo.ts) + '</span>'
          + '<textarea class="kp-memo-edit" rows="2" data-memo-editbox="' + idx + '">' + escapeHtml(memo.text) + '</textarea>'
          + '<button class="kp-memo-del" data-memo-commit="' + idx + '" title="保存">✓</button>'
          + '<button class="kp-memo-del" data-memo-cancel="1" title="取消">↺</button></li>';
      }
      return '<li class="kp-memo-item"><span class="kp-memo-time">' + escapeHtml(memo.ts) + '</span>'
        + '<span class="kp-memo-text">' + escapeHtml(memo.text) + '</span>'
        + '<button class="kp-memo-del" data-memo-edit="' + idx + '" title="编辑">✎</button>'
        + '<button class="kp-memo-del" data-memo-del="' + idx + '" title="删除">×</button></li>';
    }).join('');
    const total = all.length;
    const cap = 500;
    body.innerHTML = ''
      + '<section class="kp-card">'
      + '  <h3>速记</h3>'
      + '  <p class="kp-hint">随手写一句，Ctrl/⌘ + Enter 保存。会同时追加到 <code>' + escapeHtml(this.plugin.settings.dataFolder || 'Pulse') + '/速记.md</code>。</p>'
      + '  <textarea class="kp-memo-input" rows="3" placeholder="现在想到什么…"></textarea>'
      + '  <div class="kp-row-actions"><button class="kp-btn kp-btn-primary" data-act="memo-save">保存速记</button>'
      + '  <button class="kp-btn" data-act="memo-export">导出全部</button></div>'
      + (total >= cap ? '  <p class="kp-hint">已存 ' + total + ' 条，达到上限 ' + cap + ' 条；新的会挤掉最旧的。</p>' : '')
      + '</section>'
      + '<section class="kp-card"><h3>速记列表' + (q ? '（搜索：' + escapeHtml(this.memoQuery) + '）' : '') + '</h3>'
      + '  <input class="kp-memo-search" type="text" placeholder="搜索速记…" value="' + escapeHtml(this.memoQuery || '') + '" />'
      + (list ? '<ul class="kp-memo-list">' + list + '</ul>' : '<p class="kp-hint">' + (q ? '没有匹配的速记。' : '还没有速记。') + '</p>')
      + (memos.length > shown.length ? '<p class="kp-hint">共 ' + memos.length + ' 条，只显示最近 ' + shown.length + ' 条。</p>' : '')
      + '</section>';
    const self = this;
    const input = body.querySelector('.kp-memo-input');
    const save = async function () {
      const text = (input.value || '').trim();
      if (!text) return;
      await self.plugin.addMemo(text);
      input.value = '';
      self.renderBodyOnly();
    };
    body.querySelector('[data-act="memo-save"]').addEventListener('click', save);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
    });
    const expBtn = body.querySelector('[data-act="memo-export"]');
    if (expBtn) expBtn.addEventListener('click', async function () {
      const stamp = dayKeyToday().replace(/-/g, '');
      const lines = ['# Pulsewright 速记导出', '', '导出时间：' + new Date().toLocaleString(), '共 ' + all.length + ' 条', ''];
      for (const m of all) lines.push('- ' + m.ts + ' ' + m.text);
      const p = await self.plugin.writeVaultFile('导出/速记-' + stamp + '.md', lines.join('\n') + '\n');
      new Notice('速记已导出 ' + p);
    });
    const search = body.querySelector('.kp-memo-search');
    if (search) {
      search.addEventListener('input', function () {
        self.memoQuery = search.value;
        const pos = search.selectionStart;
        /* 连续敲字时用 rAF 合并重绘：一帧最多重建一次列表，输入不再逐键卡顿。 */
        if (self._memoRaf) return;
        self._memoRaf = requestAnimationFrame(function () {
          self._memoRaf = 0;
          self.renderBodyOnly();
          const again = self.contentEl && self.contentEl.querySelector('.kp-memo-search');
          if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (e) { } }
        });
      });
    }
    /* 内联编辑：点 ✎ 就地换成 textarea，不弹任何系统对话框。 */
    body.querySelectorAll('[data-memo-edit]').forEach(function (b) {
      b.addEventListener('click', function () {
        const idx = parseInt(b.getAttribute('data-memo-edit'), 10);
        if (isNaN(idx) || !all[idx]) return;
        self.memoEdit = idx;
        self.renderBodyOnly();
        const box = self.contentEl.querySelector('[data-memo-editbox="' + idx + '"]');
        if (box) {
          box.focus();
          try { box.setSelectionRange(box.value.length, box.value.length); } catch (e) { }
        }
      });
    });
    body.querySelectorAll('[data-memo-commit]').forEach(function (b) {
      b.addEventListener('click', async function () {
        const idx = parseInt(b.getAttribute('data-memo-commit'), 10);
        const memo = all[idx];
        if (!memo) return;
        const box = body.querySelector('[data-memo-editbox="' + idx + '"]');
        const text = box ? String(box.value || '').trim() : '';
        self.memoEdit = null;
        if (!text || text === memo.text) { self.renderBodyOnly(); return; }
        memo.text = text;
        await self.plugin.persist();
        self.renderBodyOnly();
      });
    });
    body.querySelectorAll('[data-memo-cancel]').forEach(function (b) {
      b.addEventListener('click', function () {
        self.memoEdit = null;
        self.renderBodyOnly();
      });
    });
    const editBox = body.querySelector('.kp-memo-edit');
    if (editBox) {
      editBox.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          self.memoEdit = null;
          self.renderBodyOnly();
        } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          const btn = body.querySelector('[data-memo-commit]');
          if (btn) btn.click();
        }
      });
    }
    body.querySelectorAll('[data-memo-del]').forEach(function (b) {
      b.addEventListener('click', async function () {
        const idx = parseInt(b.getAttribute('data-memo-del'), 10);
        self.plugin.data.memos.splice(idx, 1);
        await self.plugin.persist();
        self.renderBodyOnly();
      });
    });
  }

  /* ---------- 笔记地图 ---------- */

  renderMap(body) {
    const idx = this.plugin.data.noteCache || {};
    const paths = Object.keys(idx);
    const q = (this.mapQuery || '').trim();
    const tag = this.mapTag || '';
    const staleDays = (this.plugin.settings && this.plugin.settings.staleDays) || 90;

    if (!paths.length) {
      body.innerHTML = '<section class="kp-card"><h3>笔记地图</h3>'
        + '<p class="kp-hint">还没有索引到笔记，点右上角「刷新」扫一遍。</p></section>';
      return;
    }

    /* 搜索区：先出结果，空查询时不出列表。 */
    const hits = q ? searchNotes(idx, q, 30) : [];
    const hitRows = hits.map(function (n) {
      return '<li class="kp-rank-item">'
        + '<a class="kp-rank-title" data-note="' + escapeHtml(n.path) + '" href="#">' + escapeHtml(n.title) + '</a>'
        + '<span class="kp-rank-num">' + fmtInt(n.words) + ' 词 · ' + fmtInt(n.links) + ' 链</span>'
        + '</li>';
    }).join('');

    /* 标签云：按出现次数排序，字号随次数线性放大。 */
    const tags = collectTags(idx);
    const maxTag = tags.length ? tags[0].count : 1;
    const tagChips = tags.slice(0, 60).map(function (t) {
      const active = tag && t.tag.toLowerCase() === tag.toLowerCase() ? ' is-active' : '';
      const size = (12 + Math.round(4 * (t.count / maxTag))).toFixed(0);
      return '<button class="kp-tag' + active + '" data-tag="' + escapeHtml(t.tag) + '" style="font-size:' + size + 'px"'
        + ' data-tip="' + escapeHtml(t.tag + ' · ' + t.count + ' 篇 · ' + fmtInt(t.words) + ' 词') + '">'
        + escapeHtml(t.tag) + '<em>' + t.count + '</em></button>';
    }).join('');

    /* 选中某个标签时，列出该标签下的笔记。 */
    const tagNotes = tag ? paths.filter(function (p) {
      const list = (idx[p] && idx[p].tags) || [];
      for (let i = 0; i < list.length; i++) {
        if (String(list[i]).toLowerCase() === tag.toLowerCase()) return true;
      }
      return false;
    }).sort(function (a, b) { return ((idx[b].words || 0) - (idx[a].words || 0)); }) : [];
    const tagRows = tagNotes.slice(0, 40).map(function (p) {
      const n = idx[p] || {};
      return '<li class="kp-rank-item">'
        + '<a class="kp-rank-title" data-note="' + escapeHtml(p) + '" href="#">' + escapeHtml(n.title || p) + '</a>'
        + '<span class="kp-rank-num">' + fmtInt(n.words || 0) + ' 词</span>'
        + '</li>';
    }).join('');

    /* 目录分布：顶层目录的笔记数与词数。 */
    const folders = folderStats(idx).slice(0, 12);
    const folderMax = folders.length ? folders[0].notes : 1;
    const folderRows = folders.map(function (f) {
      return '<li class="kp-rank-item">'
        + '<span class="kp-rank-title">' + escapeHtml(f.folder) + '</span>'
        + '<span class="kp-rank-track"><i style="width:' + pct(f.notes, folderMax) + '%"></i></span>'
        + '<span class="kp-rank-num">' + f.notes + ' 篇</span>'
        + '</li>';
    }).join('');

    const orphans = orphanNotes(idx);
    const broken = brokenLinks(idx);
    const stale = staleNotes(idx, Date.now(), staleDays);
    const li = linkIndex(idx);

    const orphanRows = orphans.slice(0, 20).map(function (n) {
      return '<li class="kp-rank-item">'
        + '<a class="kp-rank-title" data-note="' + escapeHtml(n.path) + '" href="#">' + escapeHtml(n.title) + '</a>'
        + '<span class="kp-rank-num">' + fmtInt(n.words) + ' 词</span></li>';
    }).join('');

    const brokenRows = broken.slice(0, 20).map(function (b) {
      return '<li class="kp-rank-item">'
        + '<span class="kp-rank-title">' + escapeHtml(b.target) + '</span>'
        + '<span class="kp-rank-num">' + b.count + ' 处</span></li>';
    }).join('');

    const staleRows = stale.slice(0, 20).map(function (n) {
      return '<li class="kp-rank-item">'
        + '<a class="kp-rank-title" data-note="' + escapeHtml(n.path) + '" href="#">' + escapeHtml(n.title) + '</a>'
        + '<span class="kp-rank-num">' + n.days + ' 天未动</span></li>';
    }).join('');

    const totalLinks = Object.keys(li.inlinks).reduce(function (a, k) { return a + li.inlinks[k]; }, 0);

    body.innerHTML = ''
      + '<section class="kp-kpis">'
      + this.kpi('笔记总数', fmtInt(paths.length), '已索引', '')
      + this.kpi('标签数', fmtInt(tags.length), 'frontmatter tags', '')
      + this.kpi('内链总数', fmtInt(totalLinks), '指向库内笔记', '')
      + this.kpi('孤儿笔记', fmtInt(orphans.length), '没有入链', '')
      + this.kpi('断链目标', fmtInt(broken.length), '指向不存在的笔记', '')
      + this.kpi('久未更新', fmtInt(stale.length), '超 ' + staleDays + ' 天', '')
      + '</section>'

      + '<section class="kp-card">'
      + '  <h3>找笔记</h3>'
      + '  <input class="kp-memo-search" type="text" placeholder="搜标题或路径…" value="' + escapeHtml(q) + '" data-map-search />'
      + (q ? (hits.length ? '<ol class="kp-rank">' + hitRows + '</ol>'
        : '<p class="kp-hint">没有匹配「' + escapeHtml(q) + '」的笔记。</p>') : '<p class="kp-hint">输入关键词，按标题和路径即时匹配。</p>')
      + '</section>'

      + '<section class="kp-card">'
      + '  <h3>标签云</h3>'
      + (tags.length ? '<div class="kp-tagcloud">' + tagChips + '</div>'
        : '<p class="kp-hint">还没有笔记在 frontmatter 里写 tags。</p>')
      + (tag ? '<h4 class="kp-subhead">' + escapeHtml(tag) + ' · ' + tagNotes.length + ' 篇</h4>'
        + (tagRows ? '<ol class="kp-rank">' + tagRows + '</ol>' : '<p class="kp-hint">这个标签下没有笔记。</p>') : '')
      + '</section>'

      + '<section class="kp-card">'
      + '  <h3>目录分布</h3>'
      + (folderRows ? '<ol class="kp-rank">' + folderRows + '</ol>' : '<p class="kp-hint">没有目录。</p>')
      + '</section>'

      + '<section class="kp-card kp-two-col">'
      + '  <div><h3>孤儿笔记</h3><p class="kp-hint">没有任何笔记链到它们，最容易沉底。</p>'
      + (orphanRows ? '<ol class="kp-rank">' + orphanRows + '</ol>' : '<p class="kp-hint">没有孤儿笔记。</p>') + '</div>'
      + '  <div><h3>断链</h3><p class="kp-hint">[[目标]] 找不到对应笔记，点开可补写。</p>'
      + (brokenRows ? '<ol class="kp-rank">' + brokenRows + '</ol>' : '<p class="kp-hint">没有断链。</p>') + '</div>'
      + '</section>'

      + '<section class="kp-card">'
      + '  <h3>久未更新</h3>'
      + '  <p class="kp-hint">超过 ' + staleDays + ' 天没改过的笔记，最旧的排前面。</p>'
      + (staleRows ? '<ol class="kp-rank">' + staleRows + '</ol>' : '<p class="kp-hint">没有超期的笔记。</p>')
      + '</section>'

      + '<section class="kp-card">'
      + '  <h3>导出这份地图</h3>'
      + '  <p class="kp-hint">把当前统计写成一份 Markdown 放进库，方便回顾或贴进周报。</p>'
      + '  <div class="kp-row-actions">'
      + '    <button class="kp-btn kp-btn-primary" data-act="map-save">写入库</button>'
      + '    <button class="kp-btn" data-act="map-copy">复制 Markdown</button>'
      + '  </div>'
      + '</section>';

    this.bindMap(body);
  }

  bindMap(body) {
    const self = this;
    body.querySelectorAll('[data-note]').forEach(function (a) {
      a.addEventListener('click', function (ev) {
        ev.preventDefault();
        self.openNote(a.getAttribute('data-note'));
      });
    });
    body.querySelectorAll('[data-tag]').forEach(function (b) {
      b.addEventListener('click', function () {
        const t = b.getAttribute('data-tag');
        self.mapTag = (self.mapTag === t) ? '' : t;
        self.renderBodyOnly();
      });
    });
    const saveBtn = body.querySelector('[data-act="map-save"]');
    if (saveBtn) {
      saveBtn.addEventListener('click', async function () {
        const stamp = dayKeyToday();
        const text = mapMarkdown(self.plugin.data.noteCache || {}, {
          staleDays: (self.plugin.settings && self.plugin.settings.staleDays) || 90,
          now: Date.now(),
          stamp: stamp
        });
        const path = await self.plugin.writeVaultFile('地图/笔记地图-' + stamp.replace(/-/g, '') + '.md', text);
        new Notice('已写入 ' + path);
      });
    }
    const copyBtn = body.querySelector('[data-act="map-copy"]');
    if (copyBtn) {
      copyBtn.addEventListener('click', async function () {
        const text = mapMarkdown(self.plugin.data.noteCache || {}, {
          staleDays: (self.plugin.settings && self.plugin.settings.staleDays) || 90,
          now: Date.now(),
          stamp: dayKeyToday()
        });
        try {
          await navigator.clipboard.writeText(text);
          new Notice('笔记地图已复制到剪贴板');
        } catch (e) {
          new Notice('复制失败：' + e.message);
        }
      });
    }
    bindHeatTips(body);
    const search = body.querySelector('[data-map-search]');
    if (search) {
      search.addEventListener('input', function () {
        self.mapQuery = search.value;
        const pos = search.selectionStart;
        /* 与速记搜索一致：rAF 合并，输入时只重建正文一次。 */
        if (self._mapRaf) return;
        self._mapRaf = requestAnimationFrame(function () {
          self._mapRaf = 0;
          self.renderBodyOnly();
          const again = self.contentEl && self.contentEl.querySelector('[data-map-search]');
          if (again && typeof again.focus === 'function') {
            again.focus();
            if (typeof again.setSelectionRange === 'function') again.setSelectionRange(pos, pos);
          }
        });
      });
    }
  }

  /* ---------- 数据 ---------- */

  renderData(body) {
    const d = this.plugin.data;
    const noteCount = Object.keys(d.noteCache || {}).length;
    const dayCount = Object.keys(d.daily || {}).length;
    const w = (this.plugin.settings && this.plugin.settings.weights) || WEIGHTS;
    const scanMs = typeof d.lastScanMs === 'number' ? d.lastScanMs : null;
    const scanRead = typeof d.lastScanRead === 'number' ? d.lastScanRead : null;
    const scanCost = scanMs === null ? '—' : (scanMs < 1000 ? scanMs + ' 毫秒' : (scanMs / 1000).toFixed(1) + ' 秒');
    const dailyAll = d.daily || {};
    let scoreAll = 0;
    for (const k in dailyAll) scoreAll += dailyAll[k].score || 0;
    const scanSub = scanRead === null
      ? '还没跑过完整扫描'
      : ('本次读取 ' + fmtInt(scanRead) + ' 篇 · 其余命中缓存');
    body.innerHTML = ''
      + '<section class="kp-kpis">'
      + this.kpi('累计贡献分', fmtInt(scoreAll), '全部历史 · 首页已不显示', 'big')
      + this.kpi('已索引笔记', fmtInt(noteCount), '排除目录已过滤', '')
      + this.kpi('有记录的天数', fmtInt(dayCount), '含估算历史', '')
      + this.kpi('上次扫描', d.lastScan ? new Date(d.lastScan).toLocaleString() : '—', '可手动刷新', '')
      + this.kpi('扫描耗时', scanCost, scanSub, '')
      + '</section>'
      + '<section class="kp-card">'
      + '  <h3>评分公式（可解释）</h3>'
      + '  <pre class="kp-formula">贡献分 = 词数/' + w.wordsPerPoint + ' + 新建×' + w.note + ' + 内链×' + w.link + ' + 修订×' + w.revision + '（单日上限 ' + (this.plugin.settings.scoreCap || 120) + '）</pre>'
      + '  <p class="kp-hint">数据来源：frontmatter 的 <code>created</code> 算新建，文件修改时间算修订，正文按中日韩字符＋英文词计数，'
      + '单篇最多计入 ' + (this.plugin.settings.maxWordsPerNote || 4000) + ' 词（防止超长逐字稿把一天的分值撑爆）。</p>'
      + '</section>'
      + '<section class="kp-card">'
      + '  <h3>导出与维护</h3>'
      + '  <div class="kp-row-actions">'
      + '    <button class="kp-btn kp-btn-primary" data-act="csv">导出 CSV</button>'
      + '    <button class="kp-btn" data-act="json">导出 JSON</button>'
      + '    <button class="kp-btn" data-act="backup">备份数据</button>'
      + '    <button class="kp-btn" data-act="rebuild">重建索引</button>'
      + '  </div>'
      + '  <p class="kp-hint">导出文件写到 <code>' + escapeHtml(this.plugin.settings.dataFolder) + '/导出/</code>。</p>'
      + '</section>'
      + '<section class="kp-card kp-share-card">'
      + '  <h3>分享</h3>'
      + '  <p class="kp-hint">按当前区间（' + escapeHtml((RANGES.filter(function (r) { return r.id === this.range; }, this)[0] || {}).name || '近 30 天') + '）生成一张 1080×1440 的卡片，只含统计数字，不含任何笔记正文。</p>'
      + '  <div class="kp-row-actions">'
      + '    <button class="kp-btn kp-btn-primary" data-act="share-card">导出分享卡</button>'
      + '    <button class="kp-btn" data-act="share-text">复制分享文案</button>'
      + '  </div>'
      + '  <p class="kp-hint">卡片同时导出 PNG（1080×1440）和 SVG，存到 <code>' + escapeHtml(this.plugin.settings.dataFolder) + '/导出/</code>；PNG 可以直接发小红书。</p>'
      + '</section>';
    const self = this;
    body.querySelector('[data-act="csv"]').addEventListener('click', function () { self.plugin.exportCSV(); });
    body.querySelector('[data-act="json"]').addEventListener('click', function () { self.plugin.exportJSON(); });
    body.querySelector('[data-act="backup"]').addEventListener('click', function () { self.plugin.backupData(); });
    body.querySelector('[data-act="share-card"]').addEventListener('click', function () { self.plugin.exportShareCard(self.range); });
    body.querySelector('[data-act="share-text"]').addEventListener('click', function () { self.plugin.copyShareText(self.range); });
    body.querySelector('[data-act="rebuild"]').addEventListener('click', async function () {
      await self.plugin.rescan(true);
      self.renderBodyOnly();
    });
  }

  /* ---------- 洞察 ---------- */

  renderInsight(body) {
    const idx = (this.plugin.data && this.plugin.data.noteCache) || {};
    const paths = Object.keys(idx);
    if (!paths.length) {
      body.innerHTML = '<section class="kp-card"><h3>洞察</h3>'
        + '<p class="kp-hint">还没有索引到笔记，点右上角「刷新」扫一遍。</p></section>';
      return;
    }
    const now = Date.now();
    const health = noteHealth(idx, now, {});
    /* 相似标题是这一页最贵的一步，数据没变就直接拿上次的。 */
    const sig = this._lastSig || '';
    if (!this._insightCache || this._insightCache.sig !== sig) {
      this._insightCache = {
        sig: sig,
        sims: similarNotes(idx, { threshold: 0.6, limit: 12 }),
        pairs: tagPairs(idx, { minCount: 2, limit: 12 })
      };
    }
    const sims = this._insightCache.sims;
    const pairs = this._insightCache.pairs;
    const grid = hourGrid((this.plugin.data && this.plugin.data.sessions) || {});
    const weak = health.items.slice(0, 12);

    const gradeRows = ['A', 'B', 'C', 'D'].map(function (g) {
      const c = health.counts[g] || 0;
      return '<li class="kp-breakdown-row">'
        + '<span class="kp-breakdown-name">' + g + ' 级</span>'
        + '<span class="kp-breakdown-bar"><i class="kp-breakdown-fill kp-grade-' + g
        + '" style="width:' + pct(c, health.total) + '%"></i></span>'
        + '<span class="kp-breakdown-num">' + fmtInt(c) + ' 篇</span></li>';
    }).join('');

    const weakRows = weak.length ? weak.map(function (it) {
      return '<li class="kp-rank-item is-stack">'
        + '<a class="kp-rank-title" data-note="' + escapeHtml(it.path) + '" href="#">' + escapeHtml(it.title) + '</a>'
        + '<span class="kp-rank-num kp-grade-' + it.grade + '">' + it.score + ' 分 · ' + it.grade + '</span>'
        + '<span class="kp-hint kp-rank-sub">' + fmtInt(it.words) + ' 词 · ' + fmtInt(it.links) + ' 链 · '
        + (it.age >= 1 ? it.age + ' 天未动' : '今天动过') + '</span></li>';
    }).join('') : '<li class="kp-hint">每一篇都还过得去。</li>';

    const simRows = sims.length ? sims.map(function (p) {
      const ta = idx[p.a] && idx[p.a].title ? idx[p.a].title : p.a;
      const tb = idx[p.b] && idx[p.b].title ? idx[p.b].title : p.b;
      return '<li class="kp-rank-item">'
        + '<a class="kp-rank-title" data-note="' + escapeHtml(p.a) + '" href="#">' + escapeHtml(ta) + '</a>'
        + '<span class="kp-rank-num">≈ ' + Math.round(p.sim * 100) + '%</span>'
        + '<a class="kp-rank-title kp-rank-sub" data-note="' + escapeHtml(p.b) + '" href="#">' + escapeHtml(tb) + '</a></li>';
    }).join('') : '<li class="kp-hint">没有找到高度相似的标题。</li>';

    const pairRows = pairs.length ? pairs.map(function (p) {
      return '<li class="kp-rank-item">'
        + '<span class="kp-rank-title">#' + escapeHtml(p.a) + ' + #' + escapeHtml(p.b) + '</span>'
        + '<span class="kp-rank-num">' + fmtInt(p.count) + ' 篇</span></li>';
    }).join('') : '<li class="kp-hint">还没有成对的标签，给笔记多打几个标签试试。</li>';

    body.innerHTML = ''
      + '<div class="kp-kpis">'
      + this.kpi('平均健康度', fmtInt(health.average) + ' 分', fmtInt(health.total) + ' 篇参与', 'big')
      + this.kpi('A 级笔记', fmtInt(health.counts.A) + ' 篇', '80 分以上')
      + this.kpi('需关注', fmtInt(health.counts.C + health.counts.D) + ' 篇', 'C / D 级')
      + this.kpi('近似重复', fmtInt(sims.length) + ' 组', '标题相似度 ≥ 60%')
      + '</div>'
      + '<section class="kp-card">'
      + '  <div class="kp-sec-head"><h3>写作时段</h3><span class="kp-hint">周 × 小时 · 按真实编辑会话累计</span></div>'
      + svgHourGrid(grid)
      + '  <p class="kp-hint">格子越亮，那个时段你越常打开笔记。空白格子说明一周里这段时间从没写过。</p>'
      + '</section>'
      + '<section class="kp-card kp-two-col">'
      + '  <div><div class="kp-sec-head"><h3>健康度分布</h3></div>'
      + '    <ul class="kp-breakdown">' + gradeRows + '</ul>'
      + '    <p class="kp-hint">词数 40 分 · 出链 20 分 · 入链 20 分 · 新鲜度 20 分。</p></div>'
      + '  <div><div class="kp-sec-head"><h3>最该补的笔记</h3></div>'
      + '    <ul class="kp-rank">' + weakRows + '</ul></div>'
      + '</section>'
      + '<section class="kp-card kp-two-col">'
      + '  <div><div class="kp-sec-head"><h3>近似重复标题</h3></div>'
      + '    <ul class="kp-rank">' + simRows + '</ul></div>'
      + '  <div><div class="kp-sec-head"><h3>标签共现</h3></div>'
      + '    <ul class="kp-rank">' + pairRows + '</ul></div>'
      + '</section>';

    const self = this;
    body.querySelectorAll('[data-note]').forEach(function (a) {
      a.addEventListener('click', function (ev) { ev.preventDefault(); self.openNote(a.getAttribute('data-note')); });
    });
    bindHeatTips(body);
  }
}

/* ---------------- 当天明细弹窗 ---------------- */

class DayDetailModal extends Modal {
  constructor(app, plugin, key) {
    super(app);
    this.plugin = plugin;
    this.key = key;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('kp-modal');
    const e = (this.plugin.data.daily || {})[this.key] || null;
    if (!e) {
      contentEl.createEl('h3', { text: this.key });
      contentEl.createEl('p', { text: '这一天没有记录。' });
      return;
    }
    const w = (this.plugin.settings && this.plugin.settings.weights) || WEIGHTS;
    const parts = [
      { name: '词数', v: (e.words || 0) / w.wordsPerPoint, color: 0 },
      { name: '新建', v: (e.notes || 0) * w.note, color: 1 },
      { name: '内链', v: (e.links || 0) * w.link, color: 2 },
      { name: '修订', v: (e.revisions || 0) * w.revision, color: 3 }
    ];
    const total = Math.max(1, parts.reduce(function (a, p) { return a + p.v; }, 0));

    contentEl.innerHTML = ''
      + '<h3>' + this.key + ' <span class="kp-badge ' + (e.timeQuality === 'measured' ? 'is-live' : '') + '">' + (e.timeQuality === 'measured' ? '时长实测' : '时长估算') + '</span></h3>'
      + '<div class="kp-modal-score">' + fmtInt(e.score) + '<em> 分</em></div>'
      + '<div class="kp-breakdown">'
      + parts.map(function (p) {
        return '<div class="kp-breakdown-row"><span>' + p.name + '</span>'
          + '<div class="kp-bar-track"><div class="kp-breakdown-fill kp-stratum-' + p.color + '" style="width:' + pct(p.v, total) + '%"></div></div>'
          + '<b>' + (Math.round(p.v * 10) / 10) + '</b></div>';
      }).join('')
      + '</div>'
      + '<div class="kp-modal-metrics">'
      + '<span>词数 <b>' + fmtInt(e.words) + '</b></span>'
      + '<span>新建 <b>' + fmtInt(e.notes) + '</b></span>'
      + '<span>内链 <b>' + fmtInt(e.links) + '</b></span>'
      + '<span>修订 <b>' + fmtInt(e.revisions) + '</b></span>'
      + '<span>专注 <b>' + fmtDur(e.focusSec) + '</b></span>'
      + '</div>'
      + ((e.touched && e.touched.length)
        ? '<h4>这天动过的笔记</h4><ul class="kp-touched">'
        + e.touched.slice(0, 20).map(function (p) {
          return '<li>' + escapeHtml(p) + '</li>';
        }).join('') + '</ul>'
        : '');
  }

  onClose() { this.contentEl.empty(); }
}

/* ---------------- 设置页 ---------------- */

class PulseSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Pulsewright · 设置' });

    new Setting(containerEl)
      .setName('单日贡献分上限')
      .setDesc('超过这个分数的部分不再累加，防止某一天因批量导入异常膨胀。')
      .addText(function (t) {
        t.setValue(String(this.plugin.settings.scoreCap));
        t.onChange(async function (v) {
          const n = parseInt(v, 10);
          if (!isNaN(n) && n > 0) {
            this.plugin.settings.scoreCap = n;
            await this.plugin.saveSettings();
            this.plugin.applySettings();
          }
        }.bind(this));
      }.bind(this));

    new Setting(containerEl)
      .setName('单篇计入词数上限')
      .setDesc('超长逐字稿只按这个上限计分。')
      .addText(function (t) {
        t.setValue(String(this.plugin.settings.maxWordsPerNote));
        t.onChange(async function (v) {
          const n = parseInt(v, 10);
          if (!isNaN(n) && n > 0) {
            this.plugin.settings.maxWordsPerNote = n;
            await this.plugin.saveSettings();
            this.plugin.applySettings();
          }
        }.bind(this));
      }.bind(this));

    new Setting(containerEl)
      .setName('排除带这些 frontmatter 字段的笔记')
      .setDesc('逗号分隔。例如填 private, draft，那么 frontmatter 里 private: true 的笔记完全不参与统计（字段值写 false/0/no 视为未排除）。')
      .addText(function (t) {
        t.setPlaceholder('private, draft');
        t.setValue((this.plugin.settings.excludeFrontmatter || []).join(', '));
        t.onChange(async function (v) {
          this.plugin.settings.excludeFrontmatter = v.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
          await this.plugin.saveSettings();
          this.plugin.applySettings();
        }.bind(this));
      }.bind(this));

    new Setting(containerEl)
      .setName('历史保留天数')
      .setDesc('只保留最近这些天的日度数据，0 表示永久保留。调小后需要重新扫描才会真正裁掉旧数据。')
      .addText(function (t) {
        t.setValue(String(this.plugin.settings.retentionDays));
        t.onChange(async function (v) {
          const n = parseInt(v, 10);
          if (!isNaN(n) && n >= 0) {
            this.plugin.settings.retentionDays = n;
            await this.plugin.saveSettings();
            this.plugin.applySettings();
          }
        }.bind(this));
      }.bind(this));

    new Setting(containerEl)
      .setName('久未更新阈值（天）')
      .setDesc('超过这么多天没有修改的笔记，会出现在「笔记地图」的久未更新清单里。')
      .addText(function (t) {
        t.setValue(String(this.plugin.settings.staleDays));
        t.onChange(async function (v) {
          const n = parseInt(v, 10);
          if (!isNaN(n) && n > 0) {
            this.plugin.settings.staleDays = n;
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
          }
        }.bind(this));
      }.bind(this));

    new Setting(containerEl)
      .setName('编辑会话间隔（分钟）')
      .setDesc('同一天里两次编辑相隔超过这个分钟数，就记作两次独立会话。')
      .addText(function (t) {
        t.setValue(String(this.plugin.settings.sessionGapMin));
        t.onChange(async function (v) {
          const n = parseInt(v, 10);
          if (!isNaN(n) && n > 0) {
            this.plugin.settings.sessionGapMin = n;
            await this.plugin.saveSettings();
          }
        }.bind(this));
      }.bind(this));

    const self = this;
    const weightRows = [
      ['wordsPerPoint', '评分权重 · 多少词记 1 分', '词数 ÷ 这个数就是词数分。默认 200，即 200 词 1 分。', '200', false],
      ['note', '评分权重 · 每新建一篇笔记', '新建一篇笔记加几分。默认 4。', '4', true],
      ['link', '评分权重 · 每条内链', '每条 [[双链]] 加几分。默认 1.5。', '1.5', true],
      ['revision', '评分权重 · 每次修订', '笔记内容发生变化记一次修订，每次加几分。默认 1。', '1', true]
    ];
    weightRows.forEach(function (row) {
      const key = row[0], name = row[1], desc = row[2], ph = row[3], allowZero = row[4];
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText(function (t) {
          t.setPlaceholder(ph);
          t.setValue(String(self.plugin.settings.weights[key]));
          t.onChange(async function (v) {
            const n = parseFloat(v);
            if (isFinite(n) && (allowZero ? n >= 0 : n > 0)) {
              self.plugin.settings.weights[key] = n;
              await self.plugin.saveSettings();
              self.plugin.applySettings();
            }
          });
        });
    });

    new Setting(containerEl)
      .setName('惦记的几条线')
      .setDesc('一行一条：名称 | 匹配 | 每周几次。匹配写 tag:练琴、folder:02_学科 或 path:巴赫；每周几次写 0 表示不设节奏，只看上次动过是几天前。')
      .addTextArea(function (t) {
        t.setPlaceholder('练琴 | tag:练琴 | 3');
        t.setValue(this.plugin.settings.lanesText || '');
        t.inputEl.rows = 6;
        t.onChange(async function (v) {
          this.plugin.settings.lanesText = v;
          await this.plugin.saveSettings();
        }.bind(this));
      }.bind(this));

    new Setting(containerEl)
      .setName('排除目录')
      .setDesc('逗号分隔，匹配路径前缀。')
      .addText(function (t) {
        t.setValue((this.plugin.settings.excludedFolders || []).join(', '));
        t.onChange(async function (v) {
          this.plugin.settings.excludedFolders = v.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
          await this.plugin.saveSettings();
          this.plugin.applySettings();
        }.bind(this));
      }.bind(this));

    new Setting(containerEl)
      .setName('数据目录')
      .setDesc('导出的 CSV/JSON、复盘、速记写到这里（相对库根）。')
      .addText(function (t) {
        t.setValue(this.plugin.settings.dataFolder);
        t.onChange(async function (v) {
          this.plugin.settings.dataFolder = v.trim() || 'Pulse';
          await this.plugin.saveSettings();
        }.bind(this));
      }.bind(this));

    new Setting(containerEl)
      .setName('画风')
      .setDesc('面板配色主题。')
      .addDropdown(function (dd) {
        dd.addOption('pixel', '像素');
        dd.addOption('ink', '水墨');
        dd.addOption('mono', '极简');
        dd.addOption('star', '星图');
        dd.setValue(this.plugin.settings.sceneStyle || 'pixel');
        dd.onChange(async function (v) {
          this.plugin.settings.sceneStyle = v;
          await this.plugin.saveSettings();
          this.plugin.refreshViews(true);
        }.bind(this));
      }.bind(this));

    new Setting(containerEl)
      .setName('面板材质')
      .setDesc('卡片和菜单的表面质感。实心最稳，毛玻璃透出一点背景，亚克力更厚也更亮。')
      .addDropdown(function (dd) {
        dd.addOption('solid', '实心（默认）');
        dd.addOption('frosted', '毛玻璃');
        dd.addOption('acrylic', '亚克力');
        dd.setValue(this.plugin.settings.materialStyle || 'solid');
        dd.onChange(async function (v) {
          this.plugin.settings.materialStyle = v;
          await this.plugin.saveSettings();
          this.plugin.refreshViews(true);
        }.bind(this));
      }.bind(this));

    new Setting(containerEl)
      .setName('重新扫描')
      .setDesc('重新读取全库，重建日度统计。')
      .addButton(function (b) {
        b.setButtonText('立即扫描').onClick(async function () {
          await this.plugin.rescan(true);
          new Notice('扫描完成');
        });
      });

    new Setting(containerEl)
      .setName('导出 JSON 时包含设置项')
      .setDesc('默认关闭。设置项里有你的目录名与权重，分享数据时建议保持关闭。')
      .addToggle(function (tg) {
        tg.setValue(!!this.plugin.settings.exportIncludeSettings);
        tg.onChange(async function (v) {
          this.plugin.settings.exportIncludeSettings = v;
          await this.plugin.saveSettings();
        }.bind(this));
      }.bind(this));

    new Setting(containerEl)
      .setName('备份时包含速记正文')
      .setDesc('默认关闭。速记可能含私人内容，备份文件默认只存统计与索引。')
      .addToggle(function (tg) {
        tg.setValue(!!this.plugin.settings.includeMemosInBackup);
        tg.onChange(async function (v) {
          this.plugin.settings.includeMemosInBackup = v;
          await this.plugin.saveSettings();
        }.bind(this));
      }.bind(this));

    new Setting(containerEl)
      .setName('导出')
      .addButton(function (b) {
        b.setButtonText('CSV').onClick(function () { this.plugin.exportCSV(); }.bind(this));
      }.bind(this))
      .addButton(function (b) {
        b.setButtonText('JSON').onClick(function () { this.plugin.exportJSON(); }.bind(this));
      }.bind(this))
      .addButton(function (b) {
        b.setButtonText('完整备份').onClick(function () { this.plugin.backupData(); }.bind(this));
      }.bind(this));
  }
}

/* ---------------- 插件主体 ---------------- */

class PulsewrightPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.data = this.data || {};
    this.data.daily = this.data.daily || {};
    this.data.noteCache = this.data.noteCache || {};
    this.data.memos = this.data.memos || [];
    this.data.liveDays = this.data.liveDays || {};
    if (!this.data.installedAt) this.data.installedAt = Date.now();
    this.installDayKey = dayKeyOf(this.data.installedAt);

    this.registerView(VIEW_TYPE, function (leaf) { return new PulseView(leaf, this); }.bind(this));

    this.addRibbonIcon('activity', '打开 Pulsewright', function () { this.activateView(); }.bind(this));

    this.addCommand({
      id: 'open',
      name: '打开 Pulsewright 面板',
      callback: function () { this.activateView(); }.bind(this)
    });
    this.addCommand({
      id: 'rescan',
      name: '重新扫描知识库',
      callback: function () { this.rescan(true); }.bind(this)
    });
    this.addCommand({
      id: 'export-csv',
      name: '导出 Pulsewright CSV',
      callback: function () { this.exportCSV(); }.bind(this)
    });
    this.addCommand({
      id: 'export-json',
      name: '导出 Pulsewright JSON',
      callback: function () { this.exportJSON(); }.bind(this)
    });
    this.addCommand({
      id: 'memo',
      name: '速记一条',
      callback: function () {
        this.activateView().then(function (leaf) {
          const v = leaf && leaf.view;
          if (!v) return;
          v.tab = 'memo';
          if (typeof v.render === 'function') v.render();
          const box = v.contentEl && v.contentEl.querySelector('.kp-memo-input');
          if (box && typeof box.focus === 'function') box.focus();
        });
      }.bind(this)
    });
    this.addCommand({
      id: 'map',
      name: '打开笔记地图',
      callback: function () {
        this.activateView().then(function (leaf) {
          const v = leaf && leaf.view;
          if (!v) return;
          v.tab = 'map';
          if (typeof v.render === 'function') v.render();
        });
      }.bind(this)
    });

    this.addCommand({
      id: 'insight',
      name: '打开洞察',
      callback: function () {
        this.activateView().then(function (leaf) {
          const v = leaf && leaf.view;
          if (!v) return;
          v.tab = 'insight';
          if (typeof v.render === 'function') v.render();
        });
      }.bind(this)
    });

    this.addSettingTab(new PulseSettingTab(this.app, this));

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('kp-status');

    this.app.workspace.onLayoutReady(function () {
      this.rescan(false);
      this.updateStatus();
    }.bind(this));

    if (this.settings.trackLive) this.registerVaultEvents();

    this.registerInterval(setInterval(function () {
      this.rescan(false);
      this.updateStatus();
    }.bind(this), 15 * 60 * 1000));
  }

  async onunload() {
    /* 裸 setTimeout 不受 Obsidian 托管，卸载时必须手动清掉，
       否则插件禁用后 30 秒还会触发一次 rescan / persist。 */
    if (this._pending) {
      clearTimeout(this._pending);
      this._pending = null;
    }
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  /* ---- 设置 ---- */

  async loadSettings() {
    const raw = await this.loadData();
    this.data = raw || {};
    const saved = (raw && raw.settings) || {};
    /* v1 → v2：historyDays 是死配置，改成 retentionDays（0 = 永久保留）。 */
    if (saved.historyDays !== undefined && saved.retentionDays === undefined) {
      const hd = parseInt(saved.historyDays, 10);
      saved.retentionDays = (isFinite(hd) && hd > 0) ? hd : 0;
    }
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    this.settings.weights = Object.assign({}, WEIGHTS, saved.weights || {});
    if (!Array.isArray(this.settings.excludedFolders)) this.settings.excludedFolders = DEFAULT_SETTINGS.excludedFolders.slice();
    if (!Array.isArray(this.settings.excludeFrontmatter)) this.settings.excludeFrontmatter = [];
    this.settings.settingsVersion = SETTINGS_VERSION;
    if (!this.data.version) this.data.version = 1;
    this.data.version = Math.max(this.data.version, 2);
  }

  async saveSettings() {
    this.data.settings = this.settings;
    await this.saveData(this.data);
  }

  async persist() {
    this.data.settings = this.settings;
    await this.saveData(this.data);
  }

  /* 改设置只影响「怎么算」，不影响「文件内容」。
   * 所以走 rescan(false)：命中 mtime 缓存，不重读任何文件，只重算分数与视图。 */
  applySettings() {
    this.rescan(false).then(function () { this.refreshViews(); }.bind(this));
  }

  /* ---- 扫描 ---- */

  isExcluded(path) {
    const dataFolder = (this.settings.dataFolder || 'Pulse').replace(/\/+$/, '');
    if (path === dataFolder || path.indexOf(dataFolder + '/') === 0) return true;
    const ex = this.settings.excludedFolders || [];
    for (const pre of ex) {
      if (!pre) continue;
      if (path === pre || path.indexOf(pre + '/') === 0) return true;
    }
    return false;
  }

  async rescan(force) {
    if (this._scanning) return this._scanPromise;
    this._scanning = true;
    const self = this;
    this._scanPromise = (async function () {
      const startedAt = Date.now();
      try {
        const files = self.app.vault.getMarkdownFiles();
        const cache = self.data.noteCache || {};
        const nextCache = {};
        const notes = [];
        let readCount = 0;
        let todayDeltaWords = 0;
        /* 第一遍只比对 mtime：没变的直接吃缓存，把真正要读的文件挑出来。
         * 这样「改一个设置」「改一篇笔记」都只读那一篇，不再全库重读。 */
        const pending = [];
        for (const f of files) {
          if (self.isExcluded(f.path)) continue;
          const stat = { ctime: f.stat.ctime, mtime: f.stat.mtime, size: f.stat.size };
          const cached = cache[f.path];
          /* 旧版缓存没有 tags / linkTargets，碰到就重读一次补上，之后照常走缓存。 */
          if (!force && cached && cached.mtime === stat.mtime && cached.tags !== undefined) {
            nextCache[f.path] = cached;
            notes.push({
              path: f.path, title: f.basename, fm: {}, wordsRaw: cached.wordsRaw,
              words: cached.words, links: cached.links,
              createdMs: cached.created, mtimeMs: cached.mtime, bytes: stat.size,
              tags: cached.tags || [], linkTargets: cached.linkTargets || []
            });
            continue;
          }
          pending.push({ file: f, stat: stat, cached: cached });
        }
        /* 第二遍读变动的文件：小批并发，每两批让出一次主线程，
         * 避免几百个 cachedRead 串成一条长队列把界面锁住。 */
        const BATCH = 8;
        for (let i = 0; i < pending.length; i += BATCH) {
          const slice = pending.slice(i, i + BATCH);
          const texts = await Promise.all(slice.map(function (it) {
            return self.app.vault.cachedRead(it.file).catch(function () { return null; });
          }));
          for (let j = 0; j < slice.length; j++) {
            const text = texts[j];
            if (text === null || text === undefined) continue;
            const it = slice[j];
            readCount += 1;
            const n = collectNote(it.file.path, text, it.stat, self.settings);
            n.title = it.file.basename;
            if (it.cached && typeof it.cached.wordsRaw === 'number' && n.wordsRaw > it.cached.wordsRaw) {
              todayDeltaWords += (n.wordsRaw - it.cached.wordsRaw);
            }
            nextCache[it.file.path] = {
              mtime: it.stat.mtime, created: n.createdMs, wordsRaw: n.wordsRaw,
              words: n.words, links: n.links, bytes: it.stat.size, title: it.file.basename,
              tags: n.tags || [], linkTargets: n.linkTargets || []
            };
            notes.push(n);
          }
          if ((i / BATCH) % 2 === 1) await new Promise(function (r) { setTimeout(r, 0); });
        }
        const built = buildDaily(notes, self.settings);
        const todayK = dayKeyToday();
        if (todayDeltaWords > 0) {
          const e = built.daily[todayK] || (built.daily[todayK] = emptyDaily());
          e.words += Math.min(todayDeltaWords, 5000);
          e.score = computeScore(e, self.settings.scoreCap, self.settings.weights);
          e.focusSec = Math.min(6 * 3600, Math.round((e.words || 0) * 0.6));
        }
        const liveDays = self.data.liveDays || {};
        for (const k of Object.keys(built.daily)) built.daily[k].live = !!liveDays[k];
        applySessions(built.daily, self.data.sessions);
        for (const k of Object.keys(built.daily)) {
          if (!built.daily[k].timeQuality) built.daily[k].timeQuality = 'estimated';
        }
        const kept = pruneDaily(built.daily, self.settings.retentionDays);
        self.data.daily = kept;
        self.data.sessions = pruneDaily(self.data.sessions || {}, self.settings.retentionDays);
        self.data.noteCache = nextCache;
        self.data.lastScan = Date.now();
        self.data.lastScanMs = self.data.lastScan - startedAt;
        self.data.lastScanRead = readCount;
        await self.persist();
        self.refreshViews();
        self.updateStatus();
        return { notes: notes.length, read: readCount, ms: self.data.lastScanMs, pruned: Object.keys(built.daily).length - Object.keys(kept).length };
      } catch (err) {
        console.error('[pulsewright] scan failed', err);
        new Notice('Pulsewright 扫描失败：' + (err && err.message ? err.message : err));
        return null;
      } finally {
        self._scanning = false;
      }
    })();
    return this._scanPromise;
  }

  registerVaultEvents() {
    const recordSession = function () {
      const now = Date.now();
      const k = dayKeyOf(now);
      const gapMs = (Number(this.settings.sessionGapMin) || 5) * 60000;
      this.data.sessions = this.data.sessions || {};
      this.data.sessions[k] = mergeSession(this.data.sessions[k], now, gapMs);
    }.bind(this);
    const debounced = function () {
      this.data.liveDays = this.data.liveDays || {};
      this.data.liveDays[dayKeyToday()] = true;
      recordSession();
      if (this._pending) return;
      this._pending = setTimeout(function () {
        this._pending = null;
        this.rescan(false);
        this.persist().catch(function (e) { console.error('[pulsewright] persist failed', e); });
      }.bind(this), 30000);
    }.bind(this);
    this.registerEvent(this.app.vault.on('modify', debounced));
    this.registerEvent(this.app.vault.on('create', debounced));
    this.registerEvent(this.app.vault.on('delete', debounced));
    this.registerEvent(this.app.vault.on('rename', debounced));
  }

  updateStatus() {
    if (!this.statusEl) return;
    const e = (this.data.daily || {})[dayKeyToday()];
    this.statusEl.setText('脉冲 ' + (e ? (e.score || 0) : 0));
  }

  /* ---- 视图 ---- */

  /* 当前配置的几条线。 */
  lanes() {
    return parseLanes(this.settings && this.settings.lanesText);
  }

  async activateView() {
    try {
      let leaf = null;
      const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
      if (leaves.length) leaf = leaves[0];
      else {
        leaf = this.app.workspace.getLeaf('tab');
        await leaf.setViewState({ type: VIEW_TYPE, active: true });
      }
      this.app.workspace.revealLeaf(leaf);
      return leaf;
    } catch (err) {
      console.error('[pulsewright] activateView failed', err);
      new Notice('Pulsewright 面板打开失败：' + (err && err.message ? err.message : err));
      return null;
    }
  }

  refreshViews(full) {
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach(function (leaf) {
      const v = leaf.view;
      if (!v) return;
      if (full && typeof v.render === 'function' && v.contentEl && v.contentEl.isConnected) { v.render(); return; }
      if (typeof v.refresh === 'function') v.refresh();
    });
  }

  cycleScene() {
    const order = ['pixel', 'ink', 'mono', 'star'];
    const cur = this.settings.sceneStyle || 'pixel';
    const i = order.indexOf(cur);
    this.settings.sceneStyle = order[(i + 1) % order.length];
    this.saveSettings();
  }

  /* ---- 文件写入 ---- */

  async ensureFolder(folder) {
    const parts = folder.split('/').filter(Boolean);
    let cur = '';
    for (const p of parts) {
      cur = cur ? cur + '/' + p : p;
      if (!(await this.app.vault.adapter.exists(cur))) {
        await this.app.vault.adapter.mkdir(cur);
      }
    }
  }

  async writeVaultFile(relPath, content) {
    const folder = this.settings.dataFolder || 'Pulse';
    const full = normalizePath(folder + '/' + relPath);
    const dir = full.split('/').slice(0, -1).join('/');
    if (dir) await this.ensureFolder(dir);
    await this.app.vault.adapter.write(full, content);
    return full;
  }

  /* ---- 速记 ---- */

  async addMemo(text) {
    const now = new Date();
    const memo = { ts: dayKeyOf(now.getTime()) + ' ' + pad2(now.getHours()) + ':' + pad2(now.getMinutes()), text: text };
    this.data.memos.push(memo);
    if (this.data.memos.length > 500) this.data.memos = this.data.memos.slice(-500);
    await this.persist();
    const folder = this.settings.dataFolder || 'Pulse';
    const path = normalizePath(folder + '/速记.md');
    const exists = await this.app.vault.adapter.exists(path);
    if (!exists) {
      await this.ensureFolder(folder);
      await this.app.vault.adapter.write(path, '---\nid: 速记\nname: 速记\ntype: system\ncreated: ' + dayKeyOf(now.getTime()) + '\n---\n\n# 速记\n\n');
    }
    await this.app.vault.adapter.append(path, '- ' + memo.ts + ' ' + text + '\n');
    new Notice('速记已保存');
  }

  /* ---- 导出 ---- */

  csvText() {
    const daily = this.data.daily || {};
    const head = 'date,score,words,notes,links,revisions,focus_sec,interact_sec,quality';
    const rows = Object.keys(daily).sort().map(function (k) {
      const e = daily[k];
      return [k, e.score || 0, e.words || 0, e.notes || 0, e.links || 0,
        e.revisions || 0, e.focusSec || 0, e.interactSec || 0, e.live ? 'live' : 'estimated'].join(',');
    });
    return '\ufeff' + head + '\n' + rows.join('\n') + '\n';
  }

  async exportCSV() {
    const stamp = dayKeyToday().replace(/-/g, '');
    const path = await this.writeVaultFile('导出/Pulsewright-' + stamp + '.csv', this.csvText());
    new Notice('已导出 ' + path);
  }

  async exportYearReport(year) {
    const y = year || new Date().getFullYear();
    const daily = this.data.daily || {};
    const months = [];
    let total = 0, words = 0, notes = 0, activeDays = 0, bestDay = '', bestScore = 0;
    for (let m = 0; m < 12; m++) {
      let v = 0;
      const dim = new Date(y, m + 1, 0).getDate();
      for (let d = 1; d <= dim; d++) {
        const k = y + '-' + pad2(m + 1) + '-' + pad2(d);
        const e = daily[k];
        if (!e) continue;
        v += e.score || 0;
        total += e.score || 0;
        words += e.words || 0;
        notes += e.notes || 0;
        if (isActiveDay(e)) activeDays += 1;
        if ((e.score || 0) > bestScore) { bestScore = e.score || 0; bestDay = k; }
      }
      months.push({ label: MONTH_CN[m], value: v });
    }
    const topMonth = months.reduce(function (a, b) { return b.value > a.value ? b : a; }, months[0]);
    const WD_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const wdSum = [0, 0, 0, 0, 0, 0, 0];
    Object.keys(daily).forEach(function (k) {
      const e = daily[k];
      if (!e) return;
      const d = new Date(k + 'T00:00:00');
      if (isNaN(d.getTime())) return;
      wdSum[d.getDay()] += e.score || 0;
    });
    let topIdx = 0;
    for (let wi = 1; wi < 7; wi++) if (wdSum[wi] > wdSum[topIdx]) topIdx = wi;
    const topWeekday = wdSum[topIdx] > 0 ? { label: WD_CN[topIdx], value: wdSum[topIdx] } : null;
    const facts = libraryFacts(this.data.noteCache || {}, daily);
    const md = yearReportMarkdown(y, months, facts, {
      score: total,
      words: words,
      notes: notes,
      activeDays: activeDays,
      bestDay: bestDay,
      bestScore: bestScore,
      topMonth: topMonth && topMonth.value ? topMonth.label : '',
      topWeekday: topWeekday && topWeekday.value ? topWeekday.label : '',
      topNote: facts.longest && facts.longest.words ? facts.longest.title : ''
    });
    const path = await this.writeVaultFile('导出/Pulsewright-' + y + '年报.md', md);
    new Notice('已导出 ' + path);
  }

  async exportJSON() {
    const stamp = dayKeyToday().replace(/-/g, '');
    const payload = {
      exportedAt: Date.now(),
      plugin: 'pulsewright',
      schema: 2,
      daily: this.data.daily,
      noteCount: Object.keys(this.data.noteCache || {}).length
    };
    if (this.settings.exportIncludeSettings) payload.settings = this.settings;
    const path = await this.writeVaultFile('导出/Pulsewright-' + stamp + '.json', JSON.stringify(payload, null, 2));
    new Notice('已导出 ' + path + (this.settings.exportIncludeSettings ? '' : '（不含设置项）'));
  }

  async backupData() {
    const stamp = dayKeyToday().replace(/-/g, '');
    const copy = JSON.parse(JSON.stringify(this.data));
    if (!this.settings.includeMemosInBackup) delete copy.memos;
    const path = await this.writeVaultFile('导出/Pulsewright-备份-' + stamp + '.json', JSON.stringify(copy, null, 2));
    new Notice('已备份 ' + path + (this.settings.includeMemosInBackup ? '' : '（未含速记正文）'));
  }

  /* 分享卡要的数字：全部取自指定区间，和看板上看到的一致，
   * 不做任何额外推断，也不带任何笔记正文。 */
  sharePayload(rangeId) {
    const daily = (this.data && this.data.daily) || {};
    const rid = rangeId || (this.data && this.data.viewState && this.data.viewState.range) || '90';
    const win = rangeWindow(rid, daily);
    const list = daysInWindow(daily, win.start, win.end);
    const sum = summarize(list);
    const st = streaks(daily);
    const bars = list.slice(-30).map(function (it) {
      return { v: (it.entry && it.entry.score) || 0 };
    });
    const hit = RANGES.filter(function (r) { return r.id === rid; })[0];
    return {
      score: sum.score,
      active: sum.active,
      days: sum.days,
      words: sum.words,
      notes: sum.notes,
      links: sum.links,
      streak: st.current,
      best: sum.best,
      bestKey: sum.bestKey,
      range: (hit && hit.name) || '近 30 天',
      today: dayKeyToday(),
      bars: bars
    };
  }

  /* SVG 在 Obsidian 里能看，但发小红书要的是 PNG。
   * 用浏览器自己的渲染器把 SVG 画到 canvas 上再取字节，
   * 字体、渐变、圆角都和卡片上看到的一致。 */
  async svgToPng(svgText, width, height) {
    if (typeof document === 'undefined' || typeof Image === 'undefined' || typeof Blob === 'undefined') {
      throw new Error('当前环境没有 canvas');
    }
    const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      const loaded = new Promise(function (resolve, reject) {
        img.onload = function () { resolve(); };
        img.onerror = function () { reject(new Error('SVG 解码失败')); };
      });
      img.src = url;
      await loaded;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('拿不到 2D 上下文');
      ctx.drawImage(img, 0, 0, width, height);
      const dataUrl = canvas.toDataURL('image/png');
      const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async writeVaultBinary(relPath, bytes) {
    const folder = this.settings.dataFolder || 'Pulse';
    const full = normalizePath(folder + '/' + relPath);
    const dir = full.split('/').slice(0, -1).join('/');
    if (dir) await this.ensureFolder(dir);
    await this.app.vault.adapter.writeBinary(full, bytes.buffer ? bytes.buffer : bytes);
    return full;
  }

  async exportShareCard(rangeId) {
    const stamp = dayKeyToday().replace(/-/g, '');
    const svg = shareCardSvg(this.sharePayload(rangeId));
    const svgPath = await this.writeVaultFile('导出/Pulsewright-分享-' + stamp + '.svg', svg);
    try {
      const png = await this.svgToPng(svg, 1080, 1440);
      const pngPath = await this.writeVaultBinary('导出/Pulsewright-分享-' + stamp + '.png', png);
      new Notice('分享卡已导出 ' + pngPath);
      return pngPath;
    } catch (e) {
      new Notice('PNG 转换失败，已保留 SVG：' + svgPath);
      return svgPath;
    }
  }

  async copyShareText(rangeId) {
    const text = shareText(this.sharePayload(rangeId));
    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard) throw new Error('no clipboard');
      await navigator.clipboard.writeText(text);
      new Notice('分享文案已复制到剪贴板');
      return text;
    } catch (e) {
      const stamp = dayKeyToday().replace(/-/g, '');
      const path = await this.writeVaultFile('导出/Pulsewright-分享文案-' + stamp + '.txt', text);
      new Notice('剪贴板不可用，文案已写到 ' + path);
      return text;
    }
  }
}

module.exports = PulsewrightPlugin;
module.exports.PURE = PURE;
module.exports.VIEW_TYPE = VIEW_TYPE;
