// assets/search.js — small, private site search (no outside services).
// Reads data/search-index.json. Each entry:
//   { "name": "Title", "href": "/page/", "slug": "Page", "tags": [], "place": "", "keywords": [], "date": "YYYY-MM-DD", "exact": false }
//   "exact": true = secret page, only found when the whole search equals its name or a keyword.
// Handles: capitals/accents, partial words, typos, any word order,
// and ranks title > tags/place > keywords. Newer dated entries rank a little higher.

(function (root) {
  const WEIGHT = { title: 3, slug: 2, tag: 2, place: 2, keyword: 1 };

  function norm(s) {
    return String(s || '')
      .normalize('NFKD').replace(/[̀-ͯ]/g, '')   // accents
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[_\-]+/g, ' ')
      .replace(/([a-z])([0-9])/g, '$1 $2')
      .replace(/[^a-z0-9+ ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  // Split CamelCase slugs ("HumanDesign") before normalizing
  function splitCamel(s) { return String(s || '').replace(/([a-z])([A-Z])/g, '$1 $2'); }

  // Levenshtein distance with an early exit once it exceeds `max`
  function lev(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      let rowMin = i;
      for (let j = 1; j <= b.length; j++) {
        const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        cur.push(v);
        if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return max + 1;
      prev = cur;
    }
    return prev[b.length];
  }
  function typoAllowance(len) { return len >= 8 ? 2 : len >= 4 ? 1 : 0; }

  // How well one query word matches one indexed word (0..1)
  function wordMatch(q, w) {
    if (q === w) return 1;
    if (q.length >= 2 && w.startsWith(q)) return 0.85;
    const allow = typoAllowance(q.length);
    if (allow && lev(q, w, allow) <= allow) return 0.65;
    if (allow && q.length < w.length && lev(q, w.slice(0, q.length), 1) <= 1 && q.length >= 5) return 0.55; // typo in a partial word
    if (q.length >= 4 && w.includes(q)) return 0.5;
    return 0;
  }

  function prepare(entries) {
    // Dated entries: the newest gets the biggest boost (up to +30%), older ones less
    const dates = [...new Set(entries.filter((e) => e.date).map((e) => String(e.date)))].sort();
    const recency = (d) => (!d ? 0 : dates.length < 2 ? 1 : dates.indexOf(String(d)) / (dates.length - 1));
    return entries.map((e) => {
      const fields = [];
      const add = (text, kind) => {
        const n = norm(text);
        if (n) fields.push({ kind, phrase: n, words: n.split(' ') });
      };
      add(e.name, 'title');
      add(splitCamel(e.slug || ''), 'slug');
      (e.tags || []).forEach((t) => add(t, 'tag'));
      if (e.place) add(e.place, 'place');
      (e.keywords || []).forEach((k) => add(k, 'keyword'));
      return { entry: e, fields, boost: e.date ? 1 + 0.3 * recency(e.date) : 1 };
    });
  }

  function scoreEntry(p, qPhrase, qWords) {
    let total = 0;
    let matched = 0;
    let exactPhrase = false;
    let phraseLevel = 0;
    let wordLevel = Infinity;
    for (const f of p.fields) {
      if (f.phrase === qPhrase) { exactPhrase = true; total += 6 * WEIGHT[f.kind]; phraseLevel = Math.max(phraseLevel, WEIGHT[f.kind]); }
    }
    for (const q of qWords) {
      let best = 0;
      let strong = 0;
      for (const f of p.fields) {
        for (const w of f.words) {
          const m = wordMatch(q, w);
          if (m) best = Math.max(best, m * WEIGHT[f.kind]);
          if (m >= 0.85) strong = Math.max(strong, WEIGHT[f.kind]);
        }
      }
      if (best > 0) { matched++; total += best; }
      wordLevel = Math.min(wordLevel, strong);
    }
    if (!matched && !exactPhrase) return null;
    const coverage = qWords.length ? matched / qWords.length : 1;
    if (coverage < 0.5 && !exactPhrase) return null;
    const level = Math.max(phraseLevel, wordLevel === Infinity ? 0 : wordLevel);
    return { score: total * coverage, exactPhrase, level };
  }

  function search(index, query) {
    const qPhrase = norm(query);
    const qWords = qPhrase.split(' ').filter((w) => w && !STOP.has(w));
    if (!qPhrase) return [];
    const words = qWords.length ? qWords : qPhrase.split(' ');
    const out = [];
    for (const p of index) {
      if (p.entry.exact) {
        if (p.fields.some((f) => f.phrase === qPhrase)) out.push({ entry: p.entry, score: 100, exact: true, level: 3 });
        continue;
      }
      const s = scoreEntry(p, qPhrase, words);
      if (s) out.push({ entry: p.entry, score: s.score * (p.boost || 1), exact: s.exactPhrase, level: s.level });
    }
    return out.sort((a, b) => b.score - a.score || String(b.entry.date || '').localeCompare(String(a.entry.date || '')));
  }

  // "Did you mean…" — loose match on titles and tags only (secret pages never suggested)
  function closest(index, query, limit = 3) {
    const qPhrase = norm(query);
    if (!qPhrase) return [];
    const scored = index.filter((p) => !p.entry.exact).map((p) => {
      let best = Infinity;
      for (const f of p.fields) {
        if (f.kind === 'keyword') continue;
        best = Math.min(best, lev(qPhrase, f.phrase, 4));
        for (const w of f.words) best = Math.min(best, lev(qPhrase, w, 4));
      }
      return { entry: p.entry, d: best };
    });
    const maxD = Math.max(1, Math.floor(qPhrase.length / 3));
    return scored.filter((s) => s.d <= maxD).sort((a, b) => a.d - b.d).slice(0, limit).map((s) => s.entry);
  }

  // Decide: go straight to a page, or show a list
  function decide(results) {
    if (!results.length) return { type: 'none' };
    if (results.length === 1) return { type: 'go', entry: results[0].entry };
    const [a] = results;
    const topLevel = a.level;
    const rivalLevel = Math.max(...results.slice(1).map((r) => r.level));
    if (topLevel > 0) return topLevel > rivalLevel ? { type: 'go', entry: a.entry } : { type: 'list', results };
    if (rivalLevel > 0) return { type: 'list', results };
    const b = results[1];
    if (a.score >= b.score * 2.5) return { type: 'go', entry: a.entry };
    return { type: 'list', results };
  }

  const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'in', 'at', 'on', 'for', 'to', 'my', 'page']);

  root.SiteSearch = { norm, prepare, search, closest, decide };
  if (typeof module !== 'undefined') module.exports = root.SiteSearch;
})(typeof window !== 'undefined' ? window : globalThis);
