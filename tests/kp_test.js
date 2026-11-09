// 用 Node 模拟 obsidian 模块，跑一遍插件的纯函数与生命周期
// 用法：node tests/kp_test.js [main.js 路径]
global.setInterval = function () { return 0; };
global.clearInterval = function () {};
const path = require('path');
const Module = require('module');

class FakeElement {
  constructor() { this.children = []; this.textContent = ''; this.classList = { add(){}, remove(){} }; }
  empty() { this.children = []; }
  createDiv(o) { const c = new FakeElement(); this.children.push(c); return c; }
  createEl(t, o) { const c = new FakeElement(); c.textContent = (o && o.text) || ''; this.children.push(c); return c; }
  addClass() {}
  setText(t) { this.textContent = t; }
  querySelector() { return new FakeElement(); }
  querySelectorAll() { return []; }
}

class FakePlugin {
  constructor(app, manifest) { this.app = app; this.manifest = manifest; this._data = null; }
  async loadData() { return this._data; }
  async saveData(d) { this._data = JSON.parse(JSON.stringify(d)); }
  registerView() {}
  addRibbonIcon() { return new FakeElement(); }
  addCommand() {}
  addSettingTab() {}
  addStatusBarItem() { return new FakeElement(); }
  registerEvent() {}
  registerInterval() {}
  registerDomEvent() {}
}
class FakeItemView {
  constructor(leaf) { this.leaf = leaf; this.contentEl = new FakeElement(); this.app = (leaf && leaf.app) || {}; }
}
class FakeModal { constructor(app) { this.app = app; this.contentEl = new FakeElement(); } open() {} close() {} }
class FakeSetting {
  constructor() {}
  setName() { return this; }
  setDesc() { return this; }
  addText() { return this; }
  addButton() { return this; }
  addDropdown() { return this; }
  setHeading() { return this; }
}
class FakePluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = new FakeElement(); } }
class FakeNotice { constructor(msg) { FakeNotice.last = msg; } }
class FakeTFile {}

const fakeObsidian = {
  Plugin: FakePlugin,
  ItemView: FakeItemView,
  WorkspaceLeaf: class {},
  TFile: FakeTFile,
  Notice: FakeNotice,
  Modal: FakeModal,
  Setting: FakeSetting,
  PluginSettingTab: FakePluginSettingTab,
  normalizePath: (p) => p.replace(/\\/g, '/').replace(/\/+/g, '/'),
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'obsidian') return fakeObsidian;
  return origLoad.apply(this, arguments);
};

const target = process.argv[2] || './main.js';
const PluginClass = require(path.resolve(target));
const P = PluginClass.PURE;

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; fails.push(name + (detail ? ' :: ' + detail : '')); }
}

// ---------- 文本 ----------
ok('countWords 中文', P.countWords('今天写了三篇笔记') === 8, P.countWords('今天写了三篇笔记'));
ok('countWords 英文', P.countWords('hello world') === 2, P.countWords('hello world'));
ok('countWords 混合', P.countWords('Obsidian 很好用') === 4, P.countWords('Obsidian 很好用'));
ok('countWords 空', P.countWords('') === 0);
ok('countLinks', P.countLinks('看 [[A]] 和 [[B]]') === 2, P.countLinks('看 [[A]] 和 [[B]]'));
ok('countLinks 0', P.countLinks('没有链接') === 0);

// ---------- frontmatter ----------
const fm1 = P.parseFrontmatter('---\nid: M000001\ncreated: 2026-07-28\ntype: meta\n---\n\n# 标题\n正文');
ok('fm 解析 id', fm1.fm.id === 'M000001', JSON.stringify(fm1.fm));
ok('fm 解析 created', fm1.fm.created === '2026-07-28');
ok('fm body 不含 ---', !fm1.body.includes('---'), fm1.body.slice(0, 20));
const fm2 = P.parseFrontmatter('没有 frontmatter 的笔记');
ok('fm 无 frontmatter', Object.keys(fm2.fm).length === 0);

// ---------- 日期 ----------
ok('parseDateStr 日期', P.parseDateStr('2026-07-29') > 0);
ok('parseDateStr 时间', P.parseDateStr('2026-07-29 13:21') > P.parseDateStr('2026-07-29'));
ok('parseDateStr 空', P.parseDateStr('') === 0);
ok('parseDateStr 垃圾', P.parseDateStr('abc') === 0);
const d0 = new Date(2026, 10, 5);
ok('dayKeyOf', P.dayKeyOf(d0.getTime()) === '2026-11-05', P.dayKeyOf(d0.getTime()));
ok('addDays 跨月', P.dayKeyOf(P.addDays(new Date(2026, 0, 31), 1).getTime()) === '2026-02-01');
ok('startOfWeek 周一', P.startOfWeek(new Date(2026, 10, 5)).getDay() === 1, P.startOfWeek(new Date(2026, 10, 5)).toDateString());
ok('startOfWeek 周日归上周', P.startOfWeek(new Date(2026, 10, 8)).getDay() === 1, P.startOfWeek(new Date(2026, 10, 8)).toDateString());
ok('parseKey', P.parseKey('2026-11-05').getMonth() === 10);

// ---------- 评分 ----------
const e1 = { words: 1000, notes: 2, links: 4, revisions: 1 };
ok('computeScore', P.computeScore(e1, 120) === 20, P.computeScore(e1, 120));
ok('computeScore 上限', P.computeScore({ words: 99999, notes: 50, links: 99, revisions: 99 }, 120) === 120, P.computeScore({ words: 99999, notes: 50, links: 99, revisions: 99 }, 120));
ok('computeScore 空', P.computeScore({}, 120) === 0);

// ---------- buildDaily ----------
const notes = [
  { path: '03_概念/A.md', title: 'A', fm: {}, wordsRaw: 500, words: 500, links: 3, createdMs: new Date(2026, 9, 1).getTime(), mtimeMs: new Date(2026, 9, 1).getTime(), bytes: 100 },
  { path: '03_概念/B.md', title: 'B', fm: {}, wordsRaw: 800, words: 800, links: 1, createdMs: new Date(2026, 9, 2).getTime(), mtimeMs: new Date(2026, 9, 5).getTime(), bytes: 200 },
  { path: '01_收件箱/C.md', title: 'C', fm: {}, wordsRaw: 99999, words: 4000, links: 0, createdMs: new Date(2026, 9, 3).getTime(), mtimeMs: new Date(2026, 9, 3).getTime(), bytes: 9000 },
];
const built = P.buildDaily(notes, { scoreCap: 120, maxWordsPerNote: 4000 });
ok('buildDaily 天数', Object.keys(built.daily).length === 4, Object.keys(built.daily).join(','));
ok('buildDaily 10-01 notes', built.daily['2026-10-01'].notes === 1);
ok('buildDaily 10-01 words', built.daily['2026-10-01'].words === 500);
ok('buildDaily 10-02 创建', built.daily['2026-10-02'].notes === 1);
ok('buildDaily 10-05 修订', built.daily['2026-10-05'].revisions === 1);
ok('buildDaily 超长截断', built.daily['2026-10-03'].words === 4000, built.daily['2026-10-03'].words);
ok('buildDaily 分数存在', built.daily['2026-10-01'].score > 0, built.daily['2026-10-01'].score);
ok('buildDaily 估算专注', built.daily['2026-10-01'].focusSec === 300, built.daily['2026-10-01'].focusSec);
ok('buildDaily noteIndex', Object.keys(built.noteIndex).length === 3);
ok('buildDaily touched 去重上限', built.daily['2026-10-02'].touched.length === 1);

// ---------- 区间 / 汇总 ----------
const dk = new Date(2026, 10, 5).getTime();
const daily = {
  '2026-11-01': { score: 10, words: 100, notes: 1, links: 1, revisions: 0, focusSec: 60, interactSec: 30, live: false, touched: [] },
  '2026-11-03': { score: 20, words: 200, notes: 2, links: 2, revisions: 1, focusSec: 120, interactSec: 60, live: false, touched: [] },
  '2026-11-05': { score: 30, words: 300, notes: 3, links: 3, revisions: 2, focusSec: 180, interactSec: 90, live: false, touched: [] },
};
const win = P.rangeWindow('7', daily, dk);
ok('rangeWindow 7 天', Math.round((win.end - win.start) / 86400000) === 6);
const list = P.daysInWindow(daily, win.start, win.end);
ok('daysInWindow 长度', list.length === 7, list.length);
const sum = P.summarize(list);
ok('summarize score', sum.score === 60, sum.score);
ok('summarize active', sum.active === 3, sum.active);
ok('summarize best', sum.best === 30);
ok('summarize bestKey', sum.bestKey === '2026-11-05', sum.bestKey);
const st = P.streaks(daily);
ok('streaks longest', st.longest === 1 || st.longest === 2, st.longest);

// ---------- 活跃日判定 ----------
ok('isActiveDay 有分', P.isActiveDay({ score: 5, words: 0, notes: 0, links: 0, revisions: 0 }) === true);
ok('isActiveDay 只有词', P.isActiveDay({ score: 0, words: 30, notes: 0, links: 0, revisions: 0 }) === true);
ok('isActiveDay 只有修订', P.isActiveDay({ score: 0, words: 0, notes: 0, links: 0, revisions: 1 }) === true);
ok('isActiveDay 全空', P.isActiveDay({ score: 0, words: 0, notes: 0, links: 0, revisions: 0 }) === false);
ok('isActiveDay 空值', P.isActiveDay(null) === false);

// ---------- 可配置权重 ----------
ok('computeScore 默认权重', P.computeScore({ words: 1000, notes: 2, links: 4, revisions: 1 }, 120) === 20);
ok('computeScore 自定义权重', P.computeScore({ words: 200, notes: 0, links: 0, revisions: 0 }, 120, { wordsPerPoint: 100 }) === 2);
ok('computeScore 权重 0 不崩', P.computeScore({ words: 200, notes: 0, links: 0, revisions: 0 }, 120, { wordsPerPoint: 0 }) === 1);
ok('computeScore 封顶', P.computeScore({ words: 99999, notes: 99, links: 99, revisions: 99 }, 120) === 120);

// ---------- frontmatter 排除 ----------
ok('isSkippedNote 空设置', P.isSkippedNote({ draft: 'true' }, {}) === false);
ok('isSkippedNote 命中', P.isSkippedNote({ draft: 'true' }, { excludeFrontmatter: ['draft'] }) === true);
ok('isSkippedNote 大小写', P.isSkippedNote({ Draft: 'true' }, { excludeFrontmatter: ['draft'] }) === true);
ok('isSkippedNote 值为 false', P.isSkippedNote({ draft: 'false' }, { excludeFrontmatter: ['draft'] }) === false);
ok('isSkippedNote 值为空', P.isSkippedNote({ draft: '' }, { excludeFrontmatter: ['draft'] }) === false);
ok('isSkippedNote 无 fm', P.isSkippedNote(null, { excludeFrontmatter: ['draft'] }) === false);

// ---------- 保留期裁剪 ----------
const pruned = P.pruneDaily({ '2020-01-01': { score: 1 }, '2026-11-05': { score: 2 } }, 30);
ok('pruneDaily 0 永久', Object.keys(P.pruneDaily({ '2020-01-01': {} }, 0)).length === 1);
ok('pruneDaily 裁掉旧数据', !pruned['2020-01-01']);
ok('pruneDaily 保留新数据', !!pruned['2026-11-05']);

// ---------- 编辑会话 ----------
const segs = P.mergeSession([], 1000, 300000);
ok('mergeSession 首段', segs.length === 1 && segs[0][0] === 1000 && segs[0][1] === 1000);
const segs2 = P.mergeSession(segs, 60000, 300000);
ok('mergeSession 同段续接', segs2.length === 1 && segs2[0][1] === 60000);
const segs3 = P.mergeSession(segs2, 900000, 300000);
ok('mergeSession 超间隔新段', segs3.length === 2);
const segs4 = P.mergeSession(segs3, 500, 300000);
ok('mergeSession 时钟回拨', segs4.length === 3 && segs4[0][0] === 500);
ok('sessionSeconds 单点按 1 分钟', P.sessionSeconds([[1000, 1000]]) === 60);
ok('sessionSeconds 多段累加', P.sessionSeconds([[0, 60000], [120000, 180000]]) === 120);

const sessDaily = { '2026-11-05': { score: 0, words: 0, notes: 0, links: 0, revisions: 0, focusSec: 0, interactSec: 0, live: false, touched: [], timeQuality: 'estimated' } };
P.applySessions(sessDaily, { '2026-11-05': [[0, 1800000]] });
ok('applySessions 实测时长', sessDaily['2026-11-05'].focusSec === 1800, sessDaily['2026-11-05'].focusSec);
ok('applySessions 标记实测', sessDaily['2026-11-05'].timeQuality === 'measured');

// ---------- 周对比 / 笔记排行 ----------
const cmp = P.weekCompare(daily, P.startOfWeek(new Date(2026, 10, 5)));
ok('weekCompare 本周分', cmp.current.score === 50, cmp.current.score);
ok('weekCompare 上周分', cmp.previous.score === 10, cmp.previous.score);
ok('weekCompare delta', cmp.delta === 40, cmp.delta);
ok('weekCompare 无 NaN', !isNaN(cmp.pct));

const ranked = P.topNotes({
  'a.md': { title: 'A', words: 100, links: 0, mtime: 3 },
  'b.md': { title: 'B', words: 200, links: 2, mtime: 1 },
  'c.md': { title: 'C', words: 200, links: 0, mtime: 2 },
}, 2);
ok('topNotes 长度限制', ranked.length === 2, ranked.length);
ok('topNotes 内链加权排第一', ranked[0].path === 'b.md', ranked[0].path);
ok('topNotes 空索引', P.topNotes({}, 5).length === 0);

// ---------- 笔记地图：标签 / 内链 / 目录 / 孤儿 / 断链 / 久未更新 / 搜索 ----------
const mapIdx = {
  'a.md': { title: 'A', words: 100, links: 1, mtime: 1000, tags: ['知识', '方法'], linkTargets: ['b.md'] },
  'b.md': { title: 'B', words: 300, links: 1, mtime: 5000, tags: ['知识'], linkTargets: ['nope.md'] },
  'dir/c.md': { title: 'C', words: 50, links: 0, mtime: 9000, tags: [], linkTargets: [] },
};

ok('parseTags 数组', P.parseTags({ tags: ['a', 'B'] }).length === 2);
ok('parseTags 单值字符串', P.parseTags({ tag: 'x' })[0] === 'x');
ok('parseTags 逗号分隔', P.parseTags({ tags: 'a, b、c' }).length === 3);
ok('parseTags 去 # 号', P.parseTags({ tags: '#tag' })[0] === 'tag');
ok('parseTags 小写去重', P.parseTags({ tags: ['A', 'a'] }).length === 1);
ok('parseTags 空 frontmatter', P.parseTags({}).length === 0);
ok('parseTags 兼容 null', P.parseTags(null).length === 0);

ok('linkTargetsOf 抽取', P.linkTargetsOf('见 [[b]] 与 [[dir/c|别名]]').length === 2);
ok('linkTargetsOf 空', P.linkTargetsOf('没有链接').length === 0);
ok('normalizeLinkTarget 去别名', P.normalizeLinkTarget('dir/c|别名') === 'dir/c.md');
ok('normalizeLinkTarget 去锚点', P.normalizeLinkTarget('b.md#小节') === 'b.md');
ok('normalizeLinkTarget 反斜杠', P.normalizeLinkTarget('dir\\c') === 'dir/c.md');

const tagList = P.collectTags(mapIdx);
ok('collectTags 条数', tagList.length === 2, tagList.length);
ok('collectTags 最高频在前', tagList[0].tag === '知识', tagList[0].tag);
ok('collectTags 计数', tagList[0].count === 2, tagList[0].count);
ok('collectTags 空索引', P.collectTags({}).length === 0);

const folders = P.folderStats(mapIdx);
ok('folderStats 顶层目录数', folders.length === 2, folders.length);
ok('folderStats 根目录名', folders[0].folder === '(根目录)', folders[0].folder);
ok('folderStats 根目录笔记数', folders[0].notes === 2, folders[0].notes);
ok('folderStats 空索引', P.folderStats({}).length === 0);

const li = P.linkIndex(mapIdx);
ok('linkIndex b 有一条入链', li.inlinks['b.md'] === 1, li.inlinks['b.md']);
ok('linkIndex 断链被记录', li.broken['nope.md'] === 1, li.broken['nope.md']);
ok('linkIndex 空索引', Object.keys(P.linkIndex({}).inlinks).length === 0);

const orphans = P.orphanNotes(mapIdx);
ok('orphanNotes 找到孤儿', orphans.length === 2, orphans.length);
ok('orphanNotes 按词数排序', orphans[0].path === 'a.md', orphans[0].path);
ok('orphanNotes 空索引', P.orphanNotes({}).length === 0);

const broken = P.brokenLinks(mapIdx);
ok('brokenLinks 一条', broken.length === 1, broken.length);
ok('brokenLinks 目标名', broken[0].target === 'nope.md', broken[0].target);
ok('brokenLinks 空索引', P.brokenLinks({}).length === 0);

const stale = P.staleNotes(mapIdx, 9000 + 100 * 86400000, 90);
ok('staleNotes 三条超期', stale.length === 3, stale.length);
ok('staleNotes 最旧在前', stale[0].path === 'a.md', stale[0].path);
ok('staleNotes 天数', stale[0].days >= 100, stale[0].days);
ok('staleNotes 零天不报', P.staleNotes(mapIdx, 9000, 0).length === 0);

ok('searchNotes 命中标题', P.searchNotes(mapIdx, 'a', 10).length >= 1);
ok('searchNotes 命中路径', P.searchNotes(mapIdx, 'dir', 10)[0].path === 'dir/c.md');
ok('searchNotes 空查询为空', P.searchNotes(mapIdx, '', 10).length === 0);
ok('searchNotes 无匹配为空', P.searchNotes(mapIdx, 'zzz', 10).length === 0);
ok('searchNotes 排序按词数', P.searchNotes(mapIdx, '.md', 10)[0].path === 'b.md', P.searchNotes(mapIdx, '.md', 10)[0].path);

const revNow = 9000 + 100 * 86400000;
const rev = P.pickReview(mapIdx, revNow, 0);
ok('pickReview 挑到最旧的', rev && rev.path === 'a.md', rev && rev.path);
ok('pickReview 带天数', rev && rev.days >= 100, rev && rev.days);
ok('pickReview 同日稳定', P.pickReview(mapIdx, revNow, 0).path === P.pickReview(mapIdx, revNow, 0).path);
ok('pickReview 太新不挑', P.pickReview(mapIdx, 9000, 0) === null);
ok('pickReview 空索引为空', P.pickReview({}, revNow, 0) === null);

const mapMd = P.mapMarkdown(mapIdx, { staleDays: 90, now: revNow, stamp: '2026-11-07' });
ok('mapMarkdown 标题', mapMd.indexOf('# 笔记地图 · 2026-11-07') === 0, mapMd.slice(0, 40));
ok('mapMarkdown 含孤儿段', mapMd.indexOf('## 孤儿笔记') > 0);
ok('mapMarkdown 含断链', mapMd.indexOf('[[nope.md]]') > 0);
ok('mapMarkdown 含目录', mapMd.indexOf('- dir：1 篇') > 0);
ok('mapMarkdown 尾部署名', mapMd.indexOf('由 Pulsewright 自动生成') > 0);
ok('mapMarkdown 空索引不炸', typeof P.mapMarkdown({}, {}) === 'string');

// ---------- 洞察 ----------
const health = P.noteHealth(mapIdx, revNow, {});
ok('noteHealth 参与篇数', health.total === 3, health.total);
ok('noteHealth 分级计数合计', health.counts.A + health.counts.B + health.counts.C + health.counts.D === 3);
ok('noteHealth 低分在前', health.items[0].path === 'dir/c.md', health.items[0].path);
ok('noteHealth 分数有上限', health.items.every((it) => it.score >= 0 && it.score <= 100));
ok('noteHealth 平均分在区间', health.average >= 0 && health.average <= 100, health.average);
ok('noteHealth 空索引', P.noteHealth({}, revNow, {}).total === 0);
ok('noteHealth 入链被计入', health.items.filter((it) => it.path === 'b.md')[0].inlinks === 1);

const simIdx = {
  'x.md': { title: '深度学习笔记', words: 100, links: 0, mtime: 1000, tags: [] },
  'y.md': { title: '深度学习笔记二', words: 100, links: 0, mtime: 1000, tags: [] },
  'z.md': { title: '完全不同的主题', words: 100, links: 0, mtime: 1000, tags: [] },
};
const sims = P.similarNotes(simIdx, {});
ok('similarNotes 找到一组', sims.length === 1, sims.length);
ok('similarNotes 成员正确', sims.length && sims[0].a === 'x.md' && sims[0].b === 'y.md');
ok('similarNotes 相似度两位', sims.length && sims[0].sim === 0.83, sims.length && sims[0].sim);
ok('similarNotes 高阈值滤掉', P.similarNotes(simIdx, { threshold: 0.95 }).length === 0);
ok('similarNotes 空索引', P.similarNotes({}, {}).length === 0);

const pairIdx = {
  'p.md': { title: 'P', words: 10, links: 0, mtime: 1, tags: ['知识', '方法'] },
  'q.md': { title: 'Q', words: 10, links: 0, mtime: 1, tags: ['知识', '方法'] },
  'r.md': { title: 'R', words: 10, links: 0, mtime: 1, tags: ['知识'] },
};
const pairs = P.tagPairs(pairIdx, {});
ok('tagPairs 一对', pairs.length === 1, pairs.length);
ok('tagPairs 计数', pairs.length && pairs[0].count === 2, pairs.length && pairs[0].count);
ok('tagPairs 词序固定', pairs.length && pairs[0].a < pairs[0].b, pairs.length && pairs[0].a);
ok('tagPairs 空索引', P.tagPairs({}, {}).length === 0);

const emptyGrid = P.hourGrid({});
ok('hourGrid 七行', emptyGrid.length === 7, emptyGrid.length);
ok('hourGrid 每行 24 列', emptyGrid[0].length === 24, emptyGrid[0].length);
ok('hourGrid 空会话全零', emptyGrid.every((row) => row.every((v) => v === 0)));

const hgStart = new Date(2026, 10, 5, 10, 30).getTime();
const hgGrid = P.hourGrid({ '2026-11-05': [[hgStart, hgStart + 7200000]] });
const hgSum = hgGrid.reduce((a, row) => a + row.reduce((x, y) => x + y, 0), 0);
ok('hourGrid 总秒数守恒', hgSum === 7200, hgSum);
ok('hourGrid 落到正确小时', hgGrid[3][10] === 1800, hgGrid[3][10]);

const hgSvg = P.svgHourGrid(hgGrid, {});
ok('svgHourGrid 是字符串', typeof hgSvg === 'string');
ok('svgHourGrid 带容器类', hgSvg.indexOf('kp-hourgrid') >= 0);
ok('svgHourGrid 有格子', hgSvg.indexOf('kp-hour-cell') >= 0);
ok('svgHourGrid 无 NaN', hgSvg.indexOf('NaN') < 0);
ok('svgHourGrid 空网格不炸', P.svgHourGrid(emptyGrid, {}).indexOf('kp-hourgrid') >= 0);

// ---------- 品牌与分享卡 ----------
const mark = P.brandMarkSvg();
ok('brandMarkSvg 是字符串', typeof mark === 'string' && mark.length > 200);
ok('brandMarkSvg 带类名', mark.indexOf('kp-mark') >= 0);
ok('brandMarkSvg 画布 512', mark.indexOf('viewBox="0 0 512 512"') >= 0);
ok('brandMarkSvg 有渐变环', mark.indexOf('kpMarkRing') >= 0 && mark.indexOf('kpMarkPulse') >= 0);
ok('brandMarkSvg 尺寸可调', P.brandMarkSvg(64).indexOf('width="64"') >= 0);
ok('brandMarkSvg 无 NaN', mark.indexOf('NaN') < 0);
ok('brandMarkSvg 两条路径带描边类名', mark.indexOf('kp-mark-ring') >= 0 && mark.indexOf('kp-mark-pulse') >= 0);
ok('brandMarkSvg 路径已归一化', (mark.match(/pathLength="1"/g) || []).length === 2);

// ---------- v1.0.1 入场动画 ----------
const intro = P.introDelay;
ok('introDelay 是函数', typeof intro === 'function');
ok('introDelay 首项等于 base', intro(0, 26, 120, 520) === 120, String(intro(0, 26, 120, 520)));
ok('introDelay 逐项递增', intro(3, 26, 120, 520) === 198, String(intro(3, 26, 120, 520)));
ok('introDelay 受 cap 封顶', intro(100, 40, 260, 900) === 900, String(intro(100, 40, 260, 900)));
ok('introDelay 默认 cap 600', intro(1000, 10, 0) === 600, String(intro(1000, 10, 0)));
ok('introDelay 负数归零', intro(-5, 26, 0, 520) === 0, String(intro(-5, 26, 0, 520)));
ok('introDelay 非法下标退化为 base', intro(NaN, 26, 120, 520) === 120, String(intro(NaN, 26, 120, 520)));
ok('introDelay 返回整数', Number.isInteger(intro(2.7, 26.9, 120.4, 520)));

const sigBase = {
  daily: { '2026-11-01': { score: 20, words: 400, notes: 1, links: 2, revisions: 1, focusSec: 300 } },
  noteCache: { a: {}, b: {} },
  memos: [{ text: 'x' }],
  tab: 'board', range: '30', metric: 'score', scene: 'pixel', settingsVersion: 2
};
const sig1 = P.viewSignature(sigBase);
ok('viewSignature 是字符串', typeof sig1 === 'string' && sig1.length > 10);
ok('viewSignature 稳定', P.viewSignature(sigBase) === sig1);
ok('viewSignature 含页签', sig1.indexOf('board') >= 0);
ok('viewSignature 换页签会变', P.viewSignature(Object.assign({}, sigBase, { tab: 'memo' })) !== sig1);
ok('viewSignature 换画风会变', P.viewSignature(Object.assign({}, sigBase, { scene: 'ink' })) !== sig1);
ok('viewSignature 分数变化会变', P.viewSignature(Object.assign({}, sigBase, {
  daily: { '2026-11-01': { score: 21, words: 400, notes: 1, links: 2, revisions: 1, focusSec: 300 } }
})) !== sig1);
ok('viewSignature 空数据不炸', typeof P.viewSignature({}) === 'string');
ok('viewSignature 无 NaN', P.viewSignature({}).indexOf('NaN') < 0);

const shareSample = {
  score: 60, active: 3, days: 30, words: 1000, notes: 2, links: 4,
  streak: 5, best: 30, bestKey: '2026-11-05', range: '近 30 天', today: '2026-11-08',
  bars: [{ v: 0 }, { v: 12 }, { v: 30 }]
};
const card = P.shareCardSvg(shareSample);
ok('shareCardSvg 是字符串', typeof card === 'string' && card.length > 500);
ok('shareCardSvg 画布 1080x1440', card.indexOf('viewBox="0 0 1080 1440"') >= 0);
ok('shareCardSvg 含分数', card.indexOf('60') >= 0);
ok('shareCardSvg 含区间', card.indexOf('近 30 天') >= 0);
ok('shareCardSvg 含口号', card.indexOf('你的知识，有自己的脉搏。') >= 0);
ok('shareCardSvg 含统计标题', card.indexOf('累计贡献分') >= 0);
ok('shareCardSvg 无 NaN', card.indexOf('NaN') < 0);
ok('shareCardSvg 空 bars 不炸', P.shareCardSvg({ score: 0, bars: [] }).indexOf('1080') >= 0);
ok('shareCardSvg 转义尖括号', P.shareCardSvg({ score: 1, range: '<b>x</b>', bars: [] }).indexOf('<b>') < 0);

const stxt = P.shareText(shareSample);
ok('shareText 含分数', stxt.indexOf('· 贡献分 60') >= 0, stxt.split('\n')[2]);
ok('shareText 含活跃天数', stxt.indexOf('· 活跃 3 / 30 天') >= 0);
ok('shareText 含词数与笔记', stxt.indexOf('· 新增 1,000 词、2 篇笔记') >= 0);
ok('shareText 含连续记录', stxt.indexOf('· 已连续记录 5 天') >= 0);
ok('shareText 尾部署名', stxt.indexOf('你的知识，有自己的脉搏。') >= 0);
ok('shareText 无连续空行堆叠', stxt.indexOf('\n\n\n') < 0);
ok('shareText 缺省字段不炸', P.shareText({ score: 0 }).indexOf('贡献分 0') >= 0);

// ---------- 月相 ----------
ok('moonPhase 范围', (() => { const p = P.moonPhase(dk); return p >= 0 && p < 1; })(), P.moonPhase(dk));
ok('moonPhase 新月初', Math.abs(P.moonPhase(new Date(2026, 0, 19, 12).getTime()) ) < 0.06, P.moonPhase(new Date(2026, 0, 19, 12).getTime()));
ok('moonPath 字符串', typeof P.moonPath(10, 10, 8, 0.5) === 'string' && P.moonPath(10, 10, 8, 0.5).includes('M 10'));
ok('moonPath 无 NaN', !P.moonPath(10, 10, 8, 0.37).includes('NaN'), P.moonPath(10, 10, 8, 0.37));
ok('moonPath 边界 0', !P.moonPath(10, 10, 8, 0).includes('NaN'));
ok('moonPath 边界 1', !P.moonPath(10, 10, 8, 1).includes('NaN'));

// ---------- SVG ----------
const heat = P.svgHeatmap({ '2026-11-05': 10 }, { weeks: 53 });
ok('heatmap 有 rect', heat.includes('<rect'));
ok('heatmap 无 NaN', !heat.includes('NaN'));
ok('heatmap 有月份标签', heat.includes('1月') || heat.includes('11月'));
ok('heatmap 用 data-tip 而非原生 title', heat.includes('data-tip=') && !heat.includes('<title>'));
ok('heatmap 的 data-tip 含日期与数值', heat.includes('data-tip="2026-11-05'));
const heatDur = P.svgHeatmap({ '2026-11-05': 7200 }, { weeks: 4, format: P.fmtDur });
ok('heatmap 支持自定义格式化', heatDur.includes('2.0 小时'), heatDur.slice(0, 120));
const strata = P.svgStrata([{ label: '2026-10-01', layers: [10, 2, 3, 1] }, { label: '2026-10-08', layers: [5, 1, 2, 0] }], {});
ok('strata 有 path', strata.includes('<path'));
ok('strata 无 NaN', !strata.includes('NaN'));
const bars = P.svgBars([{ label: '周一', value: 5 }, { label: '周二', value: 9 }], {});
ok('bars 有 rect', bars.includes('<rect'));
ok('bars 无 NaN', !bars.includes('NaN'));
const line = P.svgLine([{ v: 1 }, { v: 5 }, { v: 2 }], {});
ok('line 有 path', line.includes('<path'));
ok('line 空数组', P.svgLine([], {}).includes('<svg'));

// ---------- 周复盘 ----------
const md = P.weeklyMarkdown(daily, P.startOfWeek(new Date(2026, 10, 5)));
ok('weeklyMarkdown 有标题', md.startsWith('# 知识复盘'));
ok('weeklyMarkdown 有贡献分', md.includes('贡献分'));
ok('weeklyMarkdown 无 NaN', !md.includes('NaN'));
ok('weekLabel', /^\d{4}-W\d{2}$/.test(P.weekLabel(new Date(2026, 10, 5))), P.weekLabel(new Date(2026, 10, 5)));

// ---------- 格式化 ----------
ok('fmtInt 千分位', P.fmtInt(12345) === '12,345', P.fmtInt(12345));
ok('fmtDur 秒', P.fmtDur(30) === '30 秒');
ok('fmtDur 分钟', P.fmtDur(600) === '10 分钟');
ok('fmtDur 小时', P.fmtDur(7200) === '2.0 小时');

// ---------- 插件生命周期 ----------
(async () => {
  const plugin = new PluginClass();
  plugin.app = {
    vault: { getMarkdownFiles: () => [], on: () => ({}) },
    workspace: { onLayoutReady: (fn) => fn(), getLeavesOfType: () => [], detachLeavesOfType: () => {} },
  };
  plugin.manifest = { id: 'pulsewright' };
  let threw = null;
  try {
    await plugin.onload();
  } catch (e) { threw = e; }
  ok('onload 不抛错', threw === null, threw && threw.message);
  ok('onload 后有 settings', !!plugin.settings && plugin.settings.scoreCap === 120, JSON.stringify(plugin.settings));
  ok('onload 后有 daily', typeof plugin.data.daily === 'object');

  // 空库扫描
  let scanErr = null;
  try { await plugin.rescan(true); } catch (e) { scanErr = e; }
  ok('rescan 空库不抛错', scanErr === null, scanErr && scanErr.message);

  // 伪造有文件的库
  plugin.app.vault.getMarkdownFiles = () => [
    { path: '03_概念/A.md', basename: 'A', stat: { ctime: new Date(2026, 9, 1).getTime(), mtime: new Date(2026, 9, 1).getTime(), size: 120 } },
  ];
  plugin.app.vault.cachedRead = async () => '---\nid: C000001\ncreated: 2026-10-01\ntype: concept\n---\n\n# A\n\n[[B]] 和 [[C]] 一共十个词左右的正文。';
  await plugin.rescan(true);
  ok('rescan 有文件后 daily', Object.keys(plugin.data.daily).length === 1, Object.keys(plugin.data.daily).join(','));
  ok('rescan 历史日不算 live', plugin.data.daily['2026-10-01'].live === false);
  ok('rescan noteCache', Object.keys(plugin.data.noteCache).length === 1);

  // 导出
  ok('csvText 表头', plugin.csvText().includes('date,score,words'));
  ok('csvText 行数', plugin.csvText().split('\n').filter(Boolean).length === 2);

  // ---------- v1.0.3：惦记 ----------
  const laneIdx = {
    'a/练琴/2026-11-08.md': { title: '2026-11-08', words: 120, mtime: new Date(2026, 10, 8, 21, 0).getTime(), tags: ['练琴'], path: 'a/练琴/2026-11-08.md' },
    'a/练琴/2026-11-05.md': { title: '2026-11-05', words: 90, mtime: new Date(2026, 10, 5, 20, 0).getTime(), tags: ['练琴', '巴赫'], path: 'a/练琴/2026-11-05.md' },
    'b/项目/抚州.md': { title: '抚州宣讲', words: 400, mtime: new Date(2026, 9, 20, 10, 0).getTime(), tags: ['项目/抚州'], path: 'b/项目/抚州.md' },
    'c/随手.md': { title: '随手', words: 30, mtime: new Date(2026, 10, 1, 9, 0).getTime(), tags: [], path: 'c/随手.md' },
    'd/旧.md': { title: '旧的', words: 200, mtime: new Date(2026, 9, 9, 12, 0).getTime(), tags: [], path: 'd/旧.md' }
  };
  const laneDk = new Date(2026, 10, 9, 12, 0).getTime();

  ok('laneMatch tag 命中', P.laneMatch(laneIdx['a/练琴/2026-11-08.md'], { match: 'tag:练琴' }) === true);
  ok('laneMatch tag 不误伤', P.laneMatch(laneIdx['c/随手.md'], { match: 'tag:练琴' }) === false);
  ok('laneMatch 嵌套 tag', P.laneMatch(laneIdx['b/项目/抚州.md'], { match: 'tag:项目' }) === true);
  ok('laneMatch folder', P.laneMatch(laneIdx['a/练琴/2026-11-08.md'], { match: 'folder:a' }) === true);
  ok('laneMatch folder 不越界', P.laneMatch(laneIdx['b/项目/抚州.md'], { match: 'folder:a' }) === false);
  ok('laneMatch path', P.laneMatch(laneIdx['b/项目/抚州.md'], { match: 'path:抚州' }) === true);
  ok('laneMatch 空规则', P.laneMatch(laneIdx['c/随手.md'], { match: '' }) === false);
  ok('lanePretty 去序号前缀', P.lanePretty('04_来源') === '来源', P.lanePretty('04_来源'));
  ok('lanePretty 保底', P.lanePretty('') === '', JSON.stringify(P.lanePretty('')));
  ok('lanePretty 下划转变空格', P.lanePretty('my_notes') === 'my notes', P.lanePretty('my_notes'));
  // noteCache 里没有 path 字段（路径就是 key），所以必须能用第三个参数传路径
  const noPath = { title: '无路径字段', words: 10, mtime: laneDk, tags: [] };
  ok('laneMatch folder 靠第三参', P.laneMatch(noPath, { match: 'folder:a' }, 'a/练琴/x.md') === true);
  ok('laneMatch path 靠第三参', P.laneMatch(noPath, { match: 'path:巴赫' }, 'x/巴赫平均律.md') === true);
  const stP = P.laneStats({ 'a/练琴/2026-11-08.md': { title: 't', words: 9, mtime: new Date(2026, 10, 8).getTime(), tags: [] } }, { match: 'folder:a' }, laneDk);
  ok('laneStats 无 path 字段也能命中', stP.total === 1, String(stP.total));

  const stA = P.laneStats(laneIdx, { match: 'tag:练琴' }, laneDk);
  ok('laneStats 命中两天', stA.total === 2, String(stA.total));
  ok('laneStats 本周两次', stA.weekCount === 2, String(stA.weekCount));
  ok('laneStats 最近一天', stA.lastKey === '2026-11-08', stA.lastKey);
  ok('laneStats 安静 1 天', stA.quietDays === 1, String(stA.quietDays));
  ok('laneStats 最近标题', stA.lastTitle === '2026-11-08', stA.lastTitle);

  const stB = P.laneStats(laneIdx, { match: 'tag:项目' }, laneDk);
  ok('laneStats 久未动安静 20 天', stB.quietDays === 20, String(stB.quietDays));

  const stNone = P.laneStats(laneIdx, { match: 'tag:不存在' }, laneDk);
  ok('laneStats 全是 -1', stNone.quietDays === -1, String(stNone.quietDays));

  const ser = P.laneSeries(stA, 14, laneDk);
  ok('laneSeries 长度', ser.length === 14, String(ser.length));
  ok('laneSeries 右端是今天', ser[13].key === '2026-11-09', ser[13].key);
  ok('laneSeries 命中落在点上', ser[12].hit === true && ser[11].hit === false);

  ok('laneStatus 达标', P.laneStatus({ quietDays: 1, weekCount: 3 }, { perWeek: 3 }).cls === 'ok');
  ok('laneStatus 落后', P.laneStatus({ quietDays: 9, weekCount: 0 }, { perWeek: 3 }).cls === 'warn');
  ok('laneStatus 无节奏短', P.laneStatus({ quietDays: 3 }, { perWeek: 0 }).text === '3 天前');
  ok('laneStatus 无节奏久', P.laneStatus({ quietDays: 20 }, { perWeek: 0 }).cls === 'warn');

  const sug = P.suggestLanes(laneIdx, 2);
  ok('suggestLanes 优先高频标签', sug[0].match === 'tag:练琴', sug[0].match);
  ok('suggestLanes 有结果', sug.length >= 1, String(sug.length));
  const foldIdx = {};
  for (let i = 1; i <= 4; i++) foldIdx['p/x' + i + '.md'] = { title: 'x' + i, words: 40, mtime: laneDk, tags: ['t'], path: 'p/x' + i + '.md' };
  foldIdx['q/y.md'] = { title: 'y', words: 40, mtime: laneDk, tags: ['t'], path: 'q/y.md' };
  const sug2 = P.suggestLanes(foldIdx, 2);
  ok('suggestLanes 目录优先', sug2.length === 2 && sug2[0].match === 'folder:p', JSON.stringify(sug2.map(function(x){return x.match;})));

  const parsed = P.parseLanes('# 注释\n练琴 | tag:练琴 | 3\n\n抚州 | path:抚州\n坏行\n');
  ok('parseLanes 跳过注释空行坏行', parsed.length === 2, String(parsed.length));
  ok('parseLanes 读过节奏', parsed[0].perWeek === 3, String(parsed[0].perWeek));
  ok('parseLanes 缺省节奏为 0', parsed[1].perWeek === 0, String(parsed[1].perWeek));
  ok('formatLanes 可回读', P.formatLanes(parsed) === '练琴 | tag:练琴 | 3\n抚州 | path:抚州 | 0');

  const echoes = P.echoPicks(laneIdx, laneDk, 3);
  ok('echoPicks 至少一条', echoes.length >= 1, String(echoes.length));
  ok('echoPicks 命中上个月', echoes[0].label === '上个月这个时候', echoes[0] && echoes[0].label);
  ok('echoPicks 取到那天', echoes[0].key === '2026-10-09', echoes[0] && echoes[0].key);

  ok('echoLead 取第一句', P.echoLead('今天练了三个小时。然后去吃饭。') === '今天练了三个小时。');
  ok('echoLead 去 frontmatter', P.echoLead('---\ntitle: x\n---\n正文第一句。') === '正文第一句。');
  ok('echoLead 空文本', P.echoLead('') === '');
  ok('echoLead 超长截断', P.echoLead('很长的句子'.repeat(20), 10).endsWith('…'));

  // ---------- 命令：速记一条 必须真的切到 memo 页 ----------
  const cmds = {};
  plugin.addCommand = (c) => { cmds[c.id] = c; };
  const fakeView = { tab: 'board', contentEl: new FakeElement(), render() { this.rendered = (this.rendered || 0) + 1; } };
  const fakeLeaf = { view: fakeView };
  plugin.app.workspace.getLeavesOfType = () => [fakeLeaf];
  plugin.app.workspace.revealLeaf = () => {};
  plugin.app.workspace.getLeaf = () => fakeLeaf;
  await plugin.onload();
  ok('注册了 memo 命令', !!cmds['memo']);
  ok('注册了 open 命令', !!cmds['open']);

  const leafRet = await plugin.activateView();
  ok('activateView 返回 leaf', !!leafRet && leafRet.view === fakeView);

  if (cmds['memo']) {
    cmds['memo'].callback();
    await new Promise((r) => setTimeout(r, 0));
    ok('速记命令把视图切到 memo', fakeView.tab === 'memo', String(fakeView.tab));
    ok('速记命令触发了 render', (fakeView.rendered || 0) >= 1, String(fakeView.rendered));
  }
  ok('插件实例上无 tab 字段', typeof plugin.tab === 'undefined', String(plugin.tab));

  console.log('\n===== RESULT =====');
  console.log('pass: ' + pass + '  fail: ' + fail);
  if (fail) {
    console.log('\nFAILED:');
    for (const f of fails) console.log(' - ' + f);
    process.exit(1);
  }
})();
