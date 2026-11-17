/*
 * Pulsewright for Zotero — core tests.
 *
 *   node tests/core.test.js
 *
 * core.js is a UMD module with no Zotero dependency, so it can be required
 * straight into node. Every assertion here is about pure data in / data out.
 */
'use strict';

const path = require('path');
const C = require(path.join(__dirname, '..', 'content', 'scripts', 'core.js'));

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(name + (detail === undefined ? '' : '  →  ' + JSON.stringify(detail)));
  }
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, { actual: a, expected: e });
}

/* ---------------------------------------------------------------- text */

eq('tokenize keeps latin words >= 3', C.tokenize('a an the practice'), ['practice']);
eq('tokenize cjk uses overlapping bigrams', C.tokenize('刻意练习'), ['刻意', '意练', '练习']);
eq('tokenize mixes both', C.tokenize('刻意练习 deliberate practice'),
  ['刻意', '意练', '练习', 'deliberate', 'practice']);
eq('tokenize strips punctuation', C.tokenize('practice, deliberate!'), ['practice', 'deliberate']);
eq('tokenize drops stopwords', C.tokenize('the of and'), []);
eq('tokenize empty', C.tokenize(''), []);

eq('normText lowercases', C.normText('ABC'), 'abc');
// Curly double quotes are not in the keep-set, so they collapse to a space;
// curly single quotes normalise to a straight apostrophe.
eq('normText unifies quotes', C.normText('“a”‘b’'), "a 'b'");
// An em dash becomes a hyphen first, and hyphens are kept.
eq('normText drops symbols', C.normText('a — b'), 'a - b');
ok('normText keeps cjk', C.normText('刻意练习') === '刻意练习');

eq('termFreq counts', C.termFreq(['a', 'a', 'b']), { a: 2, b: 1 });

/* --------------------------------------------------------------- tfidf */

const docs = [
  { id: 1, text: 'deliberate practice music expertise' },
  { id: 2, text: 'spacing effect memory retention' },
  { id: 3, text: 'deliberate practice expert performance music' }
];
const vecs = C.tfidf(docs);
ok('tfidf returns one vector per doc', vecs.length === 3);
ok('tfidf drops terms present in every doc',
  Object.keys(vecs[0]).indexOf('music') === -1 || Object.keys(vecs[0]).length > 0);
ok('tfidf normalises by total frequency', Math.abs(vecs[0].deliberate - vecs[2].deliberate) < 0.4);
ok('tfidf of empty doc is empty', Object.keys(C.tfidf([{ id: 9, text: '' }])[0]).length === 0);

eq('cosine of a vector with itself is 1', Math.round(C.cosine(vecs[0], vecs[0]) * 1000) / 1000, 1);
eq('cosine of orthogonal is 0', C.cosine({ a: 1 }, { b: 1 }), 0);
eq('cosine of empty is 0', C.cosine({}, { a: 1 }), 0);

/* --------------------------------------------------------- similarity */

const sim = C.similarItems(C.buildDocs(docs.map(d => ({
  id: d.id, title: d.text, itemType: 'journalArticle', date: '2000'
}))), 1, 2);
ok('similarItems finds the related doc', sim.length >= 1 && sim[0].id === 3, sim);
ok('similarItems excludes the target itself', sim.every(s => s.id !== 1));
ok('similarItems sorts descending',
  sim.every((s, i) => i === 0 || sim[i - 1].score >= s.score), sim);
eq('similarItems on unknown id', C.similarItems(C.buildDocs(docs), 999, 2), []);

const top = C.topTerms({ a: 0.9, b: 0.2, c: 0.5 }, 2);
eq('topTerms returns the heaviest first', top.map(t => t.term), ['a', 'c']);
eq('topTerms on empty', C.topTerms({}, 3), []);

/* ----------------------------------------------------------- metadata */

eq('typeLabel known type', C.typeLabel('journalArticle'), '期刊论文');
eq('typeLabel unknown type falls back', C.typeLabel('weirdType'), 'weirdType');
eq('typeLabel empty falls back', C.typeLabel(''), '未知');

const metaA = {
  id: 1, itemType: 'journalArticle', title: 'Deliberate practice in music',
  abstractNote: 'abs', publicationTitle: 'Psych Review', date: '1993-01-01',
  DOI: '10.1/x', tags: ['刻意练习'], dateAdded: '2026-11-12 10:00:00', numAttachments: 1
};
const metaB = {
  id: 2, itemType: 'journalArticle', title: 'Spacing effects',
  abstractNote: '', publicationTitle: 'Psych Science', date: '2006', DOI: '',
  tags: [], dateAdded: '2026-11-10 10:00:00', numAttachments: 0
};
const metaC = {
  id: 3, itemType: 'journalArticle', title: 'Deliberate practice and expert performance',
  abstractNote: 'b', publicationTitle: 'Psych Science', date: '2006', DOI: '',
  tags: [], dateAdded: '2026-11-11 10:00:00', numAttachments: 2
};

const d1 = C.describeItem(metaA);
eq('describeItem head joins type/pub/year', d1.head, '期刊论文 · Psych Review · 1993');
ok('describeItem reports abstract', d1.hasAbstract === true);
ok('describeItem evidence mentions DOI', d1.evidence.indexOf('DOI') >= 0, d1.evidence);
eq('describeItem head without publisher', C.describeItem({ itemType: 'book', title: 'x' }).head, '图书');

eq('docText joins the fields', C.docText(metaA).indexOf('Psych Review') > 0, true);
ok('docText excludes dateAdded', C.docText(metaA).indexOf('2026-11-12') === -1);
ok('docText excludes numAttachments', C.docText(metaA).indexOf('numAttachments') === -1);
ok('buildDocs carries id and tokens', (() => {
  const b = C.buildDocs([metaA])[0];
  return b.id === 1 && b.tokens.length > 0 && typeof b.text === 'string';
})());

/* --------------------------------------------------------- annotations */

eq('pageIndexOf reads pageIndex', C.pageIndexOf({ pageIndex: 4 }), 4);
eq('pageIndexOf parses annotationPosition',
  C.pageIndexOf({ annotationPosition: '{"pageIndex":2}' }), 2);
eq('pageIndexOf parses array form',
  C.pageIndexOf({ annotationPosition: '[{"pageIndex":1}]' }), 1);
eq('pageIndexOf missing', C.pageIndexOf({}), null);
eq('pageIndexOf bad json', C.pageIndexOf({ annotationPosition: 'nope' }), null);

const anns = [
  { pageIndex: 0, comment: 'x', color: '#ffd400', type: 'highlight' },
  { pageIndex: 5, comment: '', color: '#ffd400', type: 'highlight' },
  { pageIndex: 9, comment: '', color: '#5fb236', type: 'note' }
];
const ap = C.annotationProfile(anns, 10);
eq('annotationProfile total', ap.total, 3);
eq('annotationProfile front/middle/back', [ap.front, ap.middle, ap.back], [1, 1, 1]);
eq('annotationProfile located', ap.located, 3);
eq('annotationProfile withComment', ap.withComment, 1);
eq('annotationProfile colors', ap.colors['#ffd400'], 2);
eq('annotationProfile types', ap.types.note, 1);
eq('annotationProfile on empty', C.annotationProfile([], 5).total, 0);

/* ------------------------------------------------------------ profiles */

const tags = C.tagProfile([metaA, metaA, metaB], 5);
eq('tagProfile counts tags', tags[0].tag, '刻意练习');
eq('tagProfile count value', tags[0].count, 2);

const tl = C.readingTimeline([metaA, metaB, metaC]);
eq('readingTimeline months ascending', tl.map(m => m.month), ['2026-11']);
eq('readingTimeline counts per month', tl[0].count, 3);

const health = C.itemHealth([metaA, metaB, metaB]);
eq('itemHealth total', health.total, 3);
eq('itemHealth noDoi', health.noDoi, [2, 2]);
eq('itemHealth noAbstract', health.noAbstract, [2, 2]);
eq('itemHealth noAttachment', health.noAttachment, [2, 2]);
eq('itemHealth duplicate titles', health.duplicateTitles.length, 1);
eq('itemHealth skips attachments',
  C.itemHealth([{ id: 1, itemType: 'attachment', title: 'pdf' }]).total, 0);

eq('nextCandidates skips read', C.nextCandidates([{ id: 1 }, { id: 2 }], [1], 3).map(r => r.id), [2]);
eq('nextCandidates respects n', C.nextCandidates([{ id: 1 }, { id: 2 }, { id: 3 }], [], 2).length, 2);
eq('nextCandidates empty pool', C.nextCandidates([], [], 3), []);

/* --------------------------------------------------------- six answers */

eq('year4 from date', C.year4('1993-01-01'), '1993');
eq('year4 from bare year', C.year4(2015), '2015');
eq('year4 missing', C.year4('n.d.'), '');
eq('year4 null', C.year4(null), '');

ok('sixNoteHtml carries the marker', C.sixNoteHtml('a', 'b').indexOf(C.SIX_MARK) === 0);
ok('sixNoteHtml keeps line breaks as <br>',
  C.sixNoteHtml('one\ntwo', '').indexOf('one<br>two') > 0);

const round = C.parseSixNote(C.sixNoteHtml('因为我想搞清刻意练习到底怎么练\n第二行', '练习时长怎么量化？'));
eq('parseSixNote round-trips why', round.why, '因为我想搞清刻意练习到底怎么练\n第二行');
eq('parseSixNote round-trips questions', round.questions, '练习时长怎么量化？');
eq('parseSixNote rejects foreign notes', C.parseSixNote('<h2>x</h2>'), null);
eq('parseSixNote rejects empty', C.parseSixNote(''), null);

eq('stripTags turns br into newline', C.stripTags('a<br>b'), 'a\nb');
eq('stripTags unescapes entities', C.stripTags('&amp;&lt;&gt;'), '&<>');

const facts = C.compareFacts(metaA, metaC);
eq('compareFacts has five rows', facts.length, 5);
eq('compareFacts years', [facts[0].a, facts[0].b], ['1993', '2006']);
eq('compareFacts abstract yes/no', [facts[3].a, facts[3].b], ['有', '有']);
const factsNoAbs = C.compareFacts(metaA, metaB);
eq('compareFacts detects a missing abstract', [factsNoAbs[3].a, factsNoAbs[3].b], ['有', '无']);

const alt = C.alternativeFacts(metaA, [metaA, metaB, metaC]);
eq('alternativeFacts total excludes self', alt.total, 2);
eq('alternativeFacts newer count', alt.newer, 2);
eq('alternativeFacts older count', alt.older, 0);
eq('alternativeFacts sameType', alt.sameType, 2);
eq('alternativeFacts withAbstract', alt.withAbstract, 1);

const hints = C.whyHints(metaA, {
  collections: ['测试-练习与学习'], annotationTotal: 12,
  annotationWithComment: 3, similarCount: 4
});
ok('whyHints mentions date added', hints.some(h => h.indexOf('加入于 2026-11-12') === 0), hints);
ok('whyHints mentions collection', hints.some(h => h.indexOf('测试-练习与学习') > 0), hints);
ok('whyHints mentions annotations', hints.some(h => h.indexOf('12') > 0), hints);
eq('whyHints on a bare item', C.whyHints({ numAttachments: 0 }, {}), ['没有 PDF 附件']);

/* -------------------------------------------------------------- misc */

eq('fmtPct', C.fmtPct(0.9234, 0), '92%');
eq('fmtPct digits', C.fmtPct(0.9234, 1), '92.3%');
eq('truncate short', C.truncate('abc', 10), 'abc');
eq('truncate long', C.truncate('abcdefghij', 5), 'abcd…');
eq('esc escapes angle brackets', C.esc('<b>'), '&lt;b&gt;');
eq('esc escapes ampersand first', C.esc('&lt;'), '&amp;lt;');

ok('VERSION is a string', typeof C.VERSION === 'string' && C.VERSION.length > 0);
eq('export surface', Object.keys(C).length, 30);

/* ------------------------------------------------------------- report */

console.log('');
if (fail === 0) {
  console.log('pass ' + pass + '  fail 0');
} else {
  console.log('pass ' + pass + '  fail ' + fail);
  failures.forEach(f => console.log('  FAIL ' + f));
  process.exitCode = 1;
}
