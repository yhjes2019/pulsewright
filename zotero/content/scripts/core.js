/*
 * Pulsewright for Zotero — core pure functions.
 *
 * Everything in this file is deliberately free of DOM, Zotero API and
 * platform globals so it can be unit-tested under plain Node.
 * The UMD wrapper lets the same file be loaded with loadSubScript()
 * inside Zotero (where it exposes window.PWCore).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PWCore = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = '0.1.0';

  // ---------------------------------------------------------------------
  // Text
  // ---------------------------------------------------------------------

  var STOPWORDS = new Set([
    // English
    'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can',
    'had', 'her', 'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him',
    'his', 'how', 'its', 'may', 'new', 'now', 'old', 'see', 'two', 'way',
    'who', 'boy', 'did', 'she', 'use', 'her', 'are', 'with', 'this', 'that',
    'from', 'they', 'have', 'were', 'been', 'than', 'them', 'then', 'some',
    'such', 'only', 'also', 'into', 'more', 'most', 'other', 'which', 'their',
    'there', 'these', 'those', 'would', 'could', 'should', 'about', 'after',
    'before', 'between', 'through', 'during', 'because', 'while', 'where',
    'when', 'what', 'each', 'both', 'same', 'very', 'much', 'many', 'well',
    'does', 'done', 'being', 'upon', 'among', 'within', 'without', 'however',
    'therefore', 'thus', 'using', 'used', 'based', 'study', 'studies', 'paper',
    'article', 'research', 'result', 'results', 'data', 'analysis', 'however',
    // Chinese function words (single characters are dropped by the tokenizer,
    // these cover the most common two-character connectives)
    '我们', '他们', '一个', '这个', '那个', '可以', '以及', '但是', '因为',
    '所以', '如果', '虽然', '而且', '并且', '或者', '对于', '关于', '通过',
    '进行', '具有', '已经', '没有', '不是', '就是', '这样', '那样', '什么',
    '这些', '那些', '一些', '其他', '其中', '以上', '以下', '之间', '之后',
    '之前', '同时', '因此', '然而', '此外', '例如', '包括', '认为', '发现'
  ]);

  /**
   * Lowercase and strip everything that is not a letter, digit or CJK
   * character. Keeps word-internal hyphens and apostrophes.
   */
  function normText(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/[\u2018\u2019\u02bc]/g, "'")
      .replace(/[\u2010-\u2015]/g, '-')
      .replace(/[^a-z0-9\u4e00-\u9fff'\-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  var LATIN_MIN = 3;

  /**
   * Tokenize mixed Latin / CJK text.
   *
   * Latin runs become words (length >= 3, stopwords dropped).
   * CJK runs become overlapping bigrams, which is the standard cheap
   * approach for Chinese without a dictionary and works well for
   * academic vocabulary ("刻意练习" -> 刻意, 意练, 练习).
   */
  function tokenize(text) {
    var out = [];
    var s = normText(text);
    if (!s) return out;
    var re = /[a-z][a-z0-9'\-]*|[\u4e00-\u9fff]+/g;
    var m;
    while ((m = re.exec(s)) !== null) {
      var tok = m[0];
      if (/^[a-z]/.test(tok)) {
        if (tok.length < LATIN_MIN) continue;
        if (STOPWORDS.has(tok)) continue;
        out.push(tok);
      } else {
        if (tok.length === 1) {
          out.push(tok);
          continue;
        }
        for (var i = 0; i < tok.length - 1; i++) {
          var bg = tok.slice(i, i + 2);
          if (STOPWORDS.has(bg)) continue;
          out.push(bg);
        }
      }
    }
    return out;
  }

  function termFreq(tokens) {
    var tf = Object.create(null);
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      tf[t] = (tf[t] || 0) + 1;
    }
    return tf;
  }

  /**
   * Build TF-IDF vectors for a list of documents.
   * @param {Array<{id:*, tokens?:string[], text?:string}>} docs
   * @returns {Array<Object>} sparse vectors, same order as docs
   */
  function tfidf(docs) {
    var list = Array.isArray(docs) ? docs : [];
    var n = list.length;
    var tfs = [];
    var dfs = Object.create(null);
    var i, k;
    for (i = 0; i < n; i++) {
      var toks = list[i].tokens || tokenize(list[i].text || '');
      var tf = termFreq(toks);
      tfs.push(tf);
      for (k in tf) dfs[k] = (dfs[k] || 0) + 1;
    }
    var out = [];
    for (i = 0; i < n; i++) {
      var cur = tfs[i];
      var total = 0;
      for (k in cur) total += cur[k];
      var vec = Object.create(null);
      if (!total) {
        out.push(vec);
        continue;
      }
      for (k in cur) {
        var idf = Math.log((n + 1) / ((dfs[k] || 1) + 0.5));
        if (idf <= 0) continue;
        vec[k] = (cur[k] / total) * idf;
      }
      out.push(vec);
    }
    return out;
  }

  function cosine(a, b) {
    if (!a || !b) return 0;
    var dot = 0;
    var na = 0;
    var nb = 0;
    var k;
    for (k in a) {
      na += a[k] * a[k];
      if (b[k]) dot += a[k] * b[k];
    }
    for (k in b) nb += b[k] * b[k];
    if (!na || !nb) return 0;
    return dot / Math.sqrt(na * nb);
  }

  /**
   * Rank every other document against targetId by cosine similarity.
   * @returns {Array<{id:*, score:number}>} descending, ties keep input order
   */
  function similarItems(docs, targetId, n) {
    var list = Array.isArray(docs) ? docs : [];
    if (!list.length) return [];
    var vecs = tfidf(list);
    var ti = -1;
    var i;
    for (i = 0; i < list.length; i++) {
      if (String(list[i].id) === String(targetId)) {
        ti = i;
        break;
      }
    }
    if (ti < 0) return [];
    var res = [];
    for (i = 0; i < list.length; i++) {
      if (i === ti) continue;
      var s = cosine(vecs[ti], vecs[i]);
      if (s > 0.0005) res.push({ id: list[i].id, score: s });
    }
    res.sort(function (x, y) {
      return y.score - x.score;
    });
    if (typeof n === 'number' && n > 0) return res.slice(0, n);
    return res;
  }

  /** Top weighted terms of a TF-IDF vector, as [{term, weight}]. */
  function topTerms(vec, n) {
    var arr = [];
    var k;
    for (k in vec || {}) arr.push({ term: k, weight: vec[k] });
    arr.sort(function (a, b) {
      return b.weight - a.weight;
    });
    return arr.slice(0, typeof n === 'number' && n > 0 ? n : 10);
  }

  // ---------------------------------------------------------------------
  // Item descriptions
  // ---------------------------------------------------------------------

  var TYPE_LABELS = {
    journalArticle: '期刊论文',
    magazineArticle: '杂志文章',
    newspaperArticle: '报纸文章',
    book: '图书',
    bookSection: '图书章节',
    conferencePaper: '会议论文',
    thesis: '学位论文',
    report: '报告',
    preprint: '预印本',
    manuscript: '手稿',
    webpage: '网页',
    blogPost: '博客',
    forumPost: '论坛帖',
    dataset: '数据集',
    patent: '专利',
    standard: '标准',
    artwork: '艺术作品',
    film: '影视',
    interview: '访谈',
    letter: '书信',
    audioRecording: '录音',
    videoRecording: '录像',
    computerProgram: '软件',
    presentation: '演示',
    document: '文档',
    attachment: '附件',
    note: '笔记',
    annotation: '批注'
  };

  function typeLabel(itemType) {
    return TYPE_LABELS[itemType] || String(itemType || '未知');
  }

  /**
   * Compose the text blob used for similarity.
   * Deliberately excludes dateAdded/dateModified so re-importing the same
   * paper does not change its fingerprint.
   */
  function docText(meta) {
    var m = meta || {};
    var parts = [];
    if (m.title) parts.push(m.title);
    if (m.abstractNote) parts.push(stripTags(m.abstractNote));
    if (m.publicationTitle) parts.push(m.publicationTitle);
    if (Array.isArray(m.tags)) parts.push(m.tags.join(' '));
    if (m.extra) parts.push(m.extra);
    return parts.join(' \n ');
  }

  /** Build {id, text, tokens} documents for a whole library. */
  function buildDocs(metas) {
    var list = Array.isArray(metas) ? metas : [];
    return list.map(function (m) {
      var text = docText(m);
      return { id: m.id, text: text, tokens: tokenize(text) };
    });
  }

  // ---------------------------------------------------------------------
  // Annotations & reading behaviour
  // ---------------------------------------------------------------------

  function pageIndexOf(ann) {
    if (!ann) return null;
    if (typeof ann.pageIndex === 'number') return ann.pageIndex;
    if (typeof ann.annotationPosition === 'string' && ann.annotationPosition) {
      try {
        var p = JSON.parse(ann.annotationPosition);
        if (typeof p.pageIndex === 'number') return p.pageIndex;
        if (Array.isArray(p) && p.length && typeof p[0].pageIndex === 'number') {
          return p[0].pageIndex;
        }
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  /**
   * Where in the document did this reader mark things up?
   * Front / middle / back thirds are a cheap proxy for
   * introduction / method+results / discussion.
   */
  function annotationProfile(anns, totalPages) {
    var out = {
      total: 0,
      front: 0,
      middle: 0,
      back: 0,
      located: 0,
      withComment: 0,
      colors: {},
      types: {}
    };
    var list = Array.isArray(anns) ? anns : [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i] || {};
      out.total++;
      var type = a.type || a.annotationType || 'highlight';
      out.types[type] = (out.types[type] || 0) + 1;
      if (a.color) out.colors[a.color] = (out.colors[a.color] || 0) + 1;
      if (a.comment) out.withComment++;
      var page = pageIndexOf(a);
      if (page != null && totalPages > 0) {
        out.located++;
        var r = page / totalPages;
        if (r < 1 / 3) out.front++;
        else if (r < 2 / 3) out.middle++;
        else out.back++;
      }
    }
    return out;
  }

  /** Ranked tag list across a set of item metas. */
  function tagProfile(metas, n) {
    var counts = Object.create(null);
    var list = Array.isArray(metas) ? metas : [];
    for (var i = 0; i < list.length; i++) {
      var tags = list[i] && list[i].tags;
      if (!Array.isArray(tags)) continue;
      for (var j = 0; j < tags.length; j++) {
        var t = String(tags[j] || '').trim();
        if (!t) continue;
        counts[t] = (counts[t] || 0) + 1;
      }
    }
    var arr = Object.keys(counts).map(function (t) {
      return { tag: t, count: counts[t] };
    });
    arr.sort(function (a, b) {
      return b.count - a.count || (a.tag < b.tag ? -1 : 1);
    });
    return arr.slice(0, typeof n === 'number' && n > 0 ? n : 20);
  }

  /** Items added per calendar month, oldest first. */
  function readingTimeline(metas) {
    var counts = Object.create(null);
    var list = Array.isArray(metas) ? metas : [];
    for (var i = 0; i < list.length; i++) {
      var d = String((list[i] && list[i].dateAdded) || '');
      var key = d.slice(0, 7);
      if (/^\d{4}-\d{2}$/.test(key)) counts[key] = (counts[key] || 0) + 1;
    }
    return Object.keys(counts)
      .sort()
      .map(function (k) {
        return { month: k, count: counts[k] };
      });
  }

  /**
   * Health check of a library — the first thing that is useful on day one,
   * before any reading history exists.
   */
  function itemHealth(metas) {
    var raw = Array.isArray(metas) ? metas : [];
    // Attachments and notes are children, not things you can read: they must
    // not count towards the total either, or every library looks bloated.
    var list = [];
    for (var j = 0; j < raw.length; j++) {
      var r = raw[j] || {};
      if (r.itemType === 'attachment' || r.itemType === 'note') continue;
      list.push(r);
    }
    var out = {
      total: list.length,
      noDoi: [],
      noAbstract: [],
      noAttachment: [],
      duplicateTitles: []
    };
    var byTitle = Object.create(null);
    for (var i = 0; i < list.length; i++) {
      var m = list[i] || {};
      var key = normText(m.title || '');
      if (key) {
        if (!byTitle[key]) byTitle[key] = [];
        byTitle[key].push(m.id);
      }
      if (m.itemType === 'journalArticle' && !m.DOI) out.noDoi.push(m.id);
      if (!m.abstractNote) out.noAbstract.push(m.id);
      if (!m.numAttachments) out.noAttachment.push(m.id);
    }
    Object.keys(byTitle).forEach(function (k) {
      if (byTitle[k].length > 1) out.duplicateTitles.push(byTitle[k]);
    });
    return out;
  }

  // ---------------------------------------------------------------------
  // Six questions
  // ---------------------------------------------------------------------

  /**
   * Question 6: what should be read next?
   * Similar to the current item, but never opened yet.
   */
  function nextCandidates(ranked, readIds, n) {
    var read = new Set();
    (readIds || []).forEach(function (id) {
      read.add(String(id));
    });
    var out = [];
    var list = Array.isArray(ranked) ? ranked : [];
    for (var i = 0; i < list.length; i++) {
      if (read.has(String(list[i].id))) continue;
      out.push(list[i]);
      if (typeof n === 'number' && n > 0 && out.length >= n) break;
    }
    return out;
  }

  /**
   * Question 1: describe the item from metadata alone.
   * Returns a sentence plus the evidence it was built from, so the UI can
   * show why it said what it said.
   */
  function describeItem(meta) {
    var m = meta || {};
    var bits = [];
    bits.push(typeLabel(m.itemType));
    if (m.publicationTitle) bits.push(m.publicationTitle);
    else if (m.bookTitle) bits.push(m.bookTitle);
    else if (m.publisher) bits.push(m.publisher);
    if (m.date) bits.push(String(m.date).slice(0, 4));
    var head = bits.filter(Boolean).join(' · ');
    var absText = stripTags(m.abstractNote || '').trim();
    var hasAbstract = !!absText;
    return {
      head: head,
      hasAbstract: hasAbstract,
      abstract: absText,
      evidence: [
        hasAbstract ? '摘要' : '无摘要',
        m.DOI ? 'DOI' : '无 DOI',
        m.numAttachments ? m.numAttachments + ' 个附件' : '无附件'
      ]
    };
  }

  // ---------------------------------------------------------------------
  // Misc
  // ---------------------------------------------------------------------

  function fmtPct(x, digits) {
    var v = typeof x === 'number' && isFinite(x) ? x : 0;
    var d = typeof digits === 'number' ? digits : 0;
    return (v * 100).toFixed(d) + '%';
  }

  function truncate(s, n) {
    var str = String(s == null ? '' : s);
    var max = typeof n === 'number' && n > 0 ? n : 80;
    if (str.length <= max) return str;
    return str.slice(0, max - 1) + '…';
  }

  /** Escape for safe innerHTML interpolation. */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ---------------------------------------------------------------------
  // Six questions
  // ---------------------------------------------------------------------

  var SIX_MARK = '<!-- pulsewright-six -->';

  function stripTags(s) {
    return String(s == null ? '' : s)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
  }

  /** Build the child-note HTML that stores answers to Q2 and Q5. */
  function sixNoteHtml(why, questions) {
    var a = String(why == null ? '' : why).trim();
    var b = String(questions == null ? '' : questions).trim();
    function para(t) {
      return t ? '<p>' + esc(t).replace(/\n/g, '<br>') + '</p>' : '<p></p>';
    }
    return [
      SIX_MARK,
      '<h2>我为什么选它</h2>',
      para(a),
      '<h2>读完的问题</h2>',
      para(b)
    ].join('\n');
  }

  /** Read back {why, questions} from a note; null when it is not ours. */
  function parseSixNote(html) {
    var s = String(html == null ? '' : html);
    if (s.indexOf(SIX_MARK) < 0) return null;
    var out = { why: '', questions: '' };
    var chunks = s.split(/<h2[^>]*>/i);
    for (var i = 1; i < chunks.length; i++) {
      var chunk = chunks[i];
      var end = chunk.search(/<\/h2>/i);
      if (end < 0) continue;
      var title = stripTags(chunk.slice(0, end)).trim();
      var body = stripTags(chunk.slice(end + 5)).trim();
      if (title.indexOf('为什么') >= 0) out.why = body;
      else if (title.indexOf('问题') >= 0) out.questions = body;
    }
    return out;
  }

  function year4(d) {
    var s = String(d == null ? '' : d);
    var m = s.match(/(1[5-9]\d{2}|2\d{3})/);
    return m ? m[1] : '';
  }

  /**
   * Question 2: why did I pick this one?
   * Nothing here is invented — every hint is a fact from the library.
   */
  function whyHints(meta, ctx) {
    var m = meta || {};
    var c = ctx || {};
    var hints = [];
    if (m.dateAdded) hints.push('加入于 ' + String(m.dateAdded).slice(0, 10));
    if (c.collections && c.collections.length) {
      hints.push('归在「' + c.collections.slice(0, 3).join('」「') + '」');
    }
    if (m.tags && m.tags.length) hints.push('标签：' + m.tags.slice(0, 4).join('、'));
    if (c.annotationTotal) {
      hints.push(
        '已划 ' + c.annotationTotal + ' 处' +
        (c.annotationWithComment ? '，其中 ' + c.annotationWithComment + ' 处写了批注' : '')
      );
    } else if (m.numAttachments) {
      hints.push('有 PDF，还没划重点');
    } else {
      hints.push('没有 PDF 附件');
    }
    if (c.similarCount) hints.push('库内 ' + c.similarCount + ' 篇与它主题相近');
    return hints;
  }

  /** Question 4: side-by-side facts against the closest other item. */
  function compareFacts(target, other) {
    var a = target || {};
    var b = other || {};
    return [
      { label: '年份', a: year4(a.date) || '—', b: year4(b.date) || '—' },
      { label: '类型', a: typeLabel(a.itemType), b: typeLabel(b.itemType) },
      { label: '来源', a: a.publicationTitle || '—', b: b.publicationTitle || '—' },
      { label: '摘要', a: a.abstractNote ? '有' : '无', b: b.abstractNote ? '有' : '无' },
      { label: 'DOI', a: a.DOI ? '有' : '无', b: b.DOI ? '有' : '无' }
    ];
  }

  /**
   * Question 4 support: how does the current item sit among its neighbours?
   * Counts only — no judgement about which paper is "better".
   */
  function alternativeFacts(target, pool) {
    var list = Array.isArray(pool) ? pool : [];
    var y = parseInt(year4(target && target.date), 10);
    var out = { total: 0, newer: 0, older: 0, sameType: 0, withAbstract: 0 };
    for (var i = 0; i < list.length; i++) {
      var p = list[i] || {};
      if (target && String(p.id) === String(target.id)) continue;
      out.total++;
      var py = parseInt(year4(p.date), 10);
      if (isFinite(py) && isFinite(y)) {
        if (py > y) out.newer++;
        else if (py < y) out.older++;
      }
      if (p.itemType === (target && target.itemType)) out.sameType++;
      if (p.abstractNote) out.withAbstract++;
    }
    return out;
  }

  return {
    VERSION: VERSION,
    STOPWORDS: STOPWORDS,
    normText: normText,
    tokenize: tokenize,
    termFreq: termFreq,
    tfidf: tfidf,
    cosine: cosine,
    similarItems: similarItems,
    topTerms: topTerms,
    typeLabel: typeLabel,
    docText: docText,
    buildDocs: buildDocs,
    pageIndexOf: pageIndexOf,
    annotationProfile: annotationProfile,
    tagProfile: tagProfile,
    readingTimeline: readingTimeline,
    itemHealth: itemHealth,
    nextCandidates: nextCandidates,
    describeItem: describeItem,
    fmtPct: fmtPct,
    truncate: truncate,
    esc: esc,
    SIX_MARK: SIX_MARK,
    stripTags: stripTags,
    sixNoteHtml: sixNoteHtml,
    parseSixNote: parseSixNote,
    year4: year4,
    whyHints: whyHints,
    compareFacts: compareFacts,
    alternativeFacts: alternativeFacts
  };
});
