// assets/finder.js — hidden search on the landing page.
// Nothing shows until someone starts typing. Then the page fades to 50% and the
// search box appears in the exact middle, with live suggestions.
// Empty the box (or press Esc / click outside) and everything fades back.
// On phones (no keyboard until you tap), tapping the page opens it.
// Search engine: assets/search.js. Pages to find: data/search-index.json.

(function () {
  const isExternal = (href) => /^https?:\/\//i.test(href);
  const body = document.body;
  const form = document.getElementById('search-form');
  const input = document.getElementById('q');
  const out = document.getElementById('search-results');

  let INDEX = [];
  let t;               // typing timer
  let current = [];
  let active = -1;

  async function getJSON(url) {
    const res = await fetch(`${url}?v=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  }

  // ---------- open / close ----------
  const isOpen = () => body.classList.contains('finding');
  function open() { body.classList.add('finding'); }
  function close() {
    body.classList.remove('finding');
    input.value = '';
    clearList();
    // keep focus in the hidden box so the next keystroke opens it again
    requestAnimationFrame(() => input.focus({ preventScroll: true }));
  }

  // ---------- results ----------
  function address(href) {
    if (isExternal(href)) return new URL(href).hostname;
    return 'viceadvice.com' + href;
  }

  function go(entry) {
    if (isExternal(entry.href)) window.open(entry.href, '_blank', 'noopener');
    else window.location.href = entry.href;
  }

  function rowEl(entry, i) {
    const a = document.createElement('a');
    a.href = entry.href;
    a.className = 'result';
    a.setAttribute('role', 'option');
    a.id = 'result-' + i;
    if (isExternal(entry.href)) { a.target = '_blank'; a.rel = 'noopener'; }
    const name = document.createElement('span');
    name.className = 'result-name';
    name.textContent = entry.name;
    const addr = document.createElement('span');
    addr.className = 'result-addr';
    addr.textContent = address(entry.href);
    a.append(name, addr);
    return a;
  }

  function note(text) {
    const p = document.createElement('p');
    p.className = 'note';
    p.textContent = text;
    return p;
  }

  function showList(entries, lead) {
    current = entries;
    active = -1;
    out.replaceChildren(...(lead ? [note(lead)] : []), ...entries.map(rowEl));
    out.scrollTop = 0;
    input.setAttribute('aria-expanded', entries.length ? 'true' : 'false');
  }
  function clearList() { showList([]); }

  function highlight(i) {
    const rows = out.querySelectorAll('.result');
    rows.forEach((r, j) => r.classList.toggle('active', j === i));
    if (rows[i]) rows[i].scrollIntoView({ block: 'nearest' });
    active = i;
    if (i >= 0 && rows[i]) input.setAttribute('aria-activedescendant', rows[i].id);
    else input.removeAttribute('aria-activedescendant');
  }

  // While typing: live suggestions (closest 8)
  function suggest(raw) {
    if (!raw.trim()) return clearList();
    showList(SiteSearch.search(INDEX, raw).slice(0, 8).map((r) => r.entry));
  }

  // Enter: highlighted row, or one clear match, opens it.
  // Otherwise list all matches, then "did you mean…", then "nothing here".
  function submit(raw) {
    clearTimeout(t);
    if (active >= 0 && current[active]) return go(current[active]);
    if (!raw.trim()) return;
    const results = SiteSearch.search(INDEX, raw);
    const decision = SiteSearch.decide(results);
    if (decision.type === 'go') return go(decision.entry);
    if (decision.type === 'list') return showList(results.map((r) => r.entry));
    const near = SiteSearch.closest(INDEX, raw);
    if (near.length) return showList(near, 'did you mean…');
    out.replaceChildren(note('nothing here… yet.'));
    current = [];
  }

  // ---------- wiring ----------
  input.addEventListener('input', () => {
    if (input.value) open();
    else { body.classList.remove('finding'); clearList(); return; }
    clearTimeout(t);
    t = setTimeout(() => suggest(input.value), 80);
  });

  form.addEventListener('submit', (e) => { e.preventDefault(); submit(input.value); });

  input.addEventListener('keydown', (e) => {
    const n = out.querySelectorAll('.result').length;
    if (e.key === 'ArrowDown' && n) { e.preventDefault(); highlight((active + 1) % n); }
    else if (e.key === 'ArrowUp' && n) { e.preventDefault(); highlight(active <= 0 ? n - 1 : active - 1); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });

  // Typing anywhere on the page goes into the hidden box
  document.addEventListener('keydown', (e) => {
    if (e.target === input || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key.length === 1) input.focus({ preventScroll: true });
  });

  // Click outside the box while searching: close. Tap the page when closed (phones): open.
  document.addEventListener('click', (e) => {
    if (isOpen()) { if (!form.contains(e.target)) close(); return; }
    if (matchMedia('(hover: none)').matches) { open(); input.focus({ preventScroll: true }); }
  });

  // Coming back with the Back button: start fresh
  window.addEventListener('pageshow', (e) => { if (e.persisted) close(); });

  input.value = '';
  input.focus({ preventScroll: true });
  getJSON('data/search-index.json')
    .then((list) => { INDEX = SiteSearch.prepare(Array.isArray(list) ? list : []); })
    .catch((e) => console.error('Search index failed to load', e));
})();
