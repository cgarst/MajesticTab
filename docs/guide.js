/* MajesticTab user guide: search, the contents sheet on small screens and the "on this page" marker.
   Everything here is an addition; the pages read fine without it. */
(function () {
  var body = document.body;

  // Contents sheet (screens narrower than 900px)
  var btn = document.querySelector('.gmenu');
  var side = document.getElementById('gside');
  var narrow = window.matchMedia('(max-width: 899px)');
  function setOpen(open, focusBack) {
    body.classList.toggle('gopen', open);
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) { var q = document.getElementById('gq'); if (q) q.focus(); }
    else if (focusBack && btn) btn.focus();
  }
  if (btn && side) {
    btn.addEventListener('click', function () { setOpen(!body.classList.contains('gopen')); });
    narrow.addEventListener('change', function () { if (!narrow.matches) setOpen(false); });
    side.addEventListener('click', function (e) { if (e.target.closest('a')) setOpen(false); });
  }

  // Search over search.json (built with the pages)
  var index = null, loading = null;
  function load() {
    if (index) return Promise.resolve(index);
    if (!loading) loading = fetch('search.json').then(function (r) { return r.json(); }).then(function (d) { index = d; return d; });
    return loading;
  }
  function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function mark(text, tokens) {
    var out = esc(text);
    tokens.forEach(function (t) { out = out.replace(new RegExp('(' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig'), '<mark>$1</mark>'); });
    return out;
  }
  function search(q) {
    var tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return [];
    var hits = [];
    index.forEach(function (p) {
      var title = p.t.toLowerCase(), heads = p.h.map(function (h) { return h.t.toLowerCase(); }), text = p.x.toLowerCase();
      var score = 0, ok = true;
      tokens.forEach(function (t) {
        var s = 0;
        if (title.indexOf(t) > -1) s += 10;
        heads.forEach(function (h) { if (h.indexOf(t) > -1) s += 5; });
        if (text.indexOf(t) > -1) s += 1;
        if (!s) ok = false;
        score += s;
      });
      if (!ok) return;
      var head = null;
      for (var i = 0; i < p.h.length; i++) { if (tokens.some(function (t) { return heads[i].indexOf(t) > -1; })) { head = p.h[i]; break; } }
      var at = text.indexOf(tokens[0]), snippet = '';
      if (at > -1) { var from = Math.max(0, at - 50); snippet = (from ? '…' : '') + p.x.slice(from, at + 90) + '…'; }
      hits.push({ p: p, head: head, snippet: snippet, score: score });
    });
    hits.sort(function (a, b) { return b.score - a.score; });
    return hits.slice(0, 8);
  }
  function wire(input, out, nav) {
    if (!input || !out) return;
    function render() {
      var q = input.value.trim();
      if (!q) { out.hidden = true; out.innerHTML = ''; if (nav) nav.hidden = false; return; }
      load().then(function () {
        if (input.value.trim() !== q) return;
        var tokens = q.toLowerCase().split(/\s+/).filter(Boolean), hits = search(q);
        if (nav) nav.hidden = true;
        out.hidden = false;
        out.innerHTML = hits.length ? hits.map(function (h) {
          var href = h.p.u + (h.head ? '#' + h.head.i : '');
          var line = h.head ? h.head.t : h.snippet;
          return '<a href="' + href + '"><strong>' + mark(h.p.t, tokens) + '</strong><span>' + (h.head ? esc(h.p.s) + ' · ' : '') + mark(line || h.p.s, tokens) + '</span></a>';
        }).join('') : '<p class="none">No pages match “' + esc(q) + '”. Try a shorter or different word.</p>';
      }, function () { out.hidden = false; out.innerHTML = '<p class="none">Search could not load. The contents list still works.</p>'; });
    }
    input.addEventListener('input', render);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { var a = out.querySelector('a'); if (a) { e.preventDefault(); a.focus(); } }
      if (e.key === 'Escape' && input.value) { input.value = ''; render(); e.stopPropagation(); }
    });
    out.addEventListener('keydown', function (e) {
      var a = document.activeElement;
      if (e.key === 'ArrowDown' && a.nextElementSibling) { e.preventDefault(); a.nextElementSibling.focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); (a.previousElementSibling || input).focus(); }
    });
  }
  wire(document.getElementById('gq'), document.getElementById('gresults'), document.getElementById('gnav'));
  wire(document.getElementById('gq-home'), document.getElementById('gresults-home'), null);

  // "/" jumps to search; Escape closes the sheet
  document.addEventListener('keydown', function (e) {
    var t = e.target, typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
      var q = document.getElementById('gq-home') || document.getElementById('gq');
      if (q) { e.preventDefault(); if (narrow.matches && btn && q.id === 'gq') setOpen(true); else q.focus(); }
    } else if (e.key === 'Escape' && body.classList.contains('gopen')) { setOpen(false, true); }
  });

  // Mark the section being read in "On this page"
  var toc = document.querySelector('.gtoc');
  if (toc && 'IntersectionObserver' in window) {
    var links = {};
    toc.querySelectorAll('a').forEach(function (a) { links[a.getAttribute('href').slice(1)] = a; });
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (!e.isIntersecting) return;
        Object.keys(links).forEach(function (k) { links[k].removeAttribute('aria-current'); });
        if (links[e.target.id]) links[e.target.id].setAttribute('aria-current', 'true');
      });
    }, { rootMargin: '0px 0px -70% 0px' });
    document.querySelectorAll('.gdoc h2[id]').forEach(function (h) { io.observe(h); });
  }
})();
