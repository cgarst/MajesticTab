#!/usr/bin/env node
// Builds the user guide at docs/guide/ from support/guide/.
//
//   node support/tools/guide/build.mjs
//
// Inputs:  support/guide/site.json        section and page order, titles, descriptions
//          support/guide/pages/<slug>.html  the body of each page (plain HTML plus three shorthands)
// Outputs: docs/guide/index.html, docs/guide/<slug>.html, docs/guide/search.json and docs/sitemap.xml
//
// Shorthands in a page body:
//   <fig src="reader" alt="...">caption</fig>   a screenshot from docs/img/app/<src>.webp with a caption
//   <key>Space</key>                            a keyboard key (becomes <kbd>)
//   <note>...</note>                            a tone-step aside
// h2 headings get an id and feed the "on this page" list. There are no dependencies and no CSS build step:
// the look is docs/site.css plus docs/guide.css, and the behavior is docs/guide.js.
// Edit the sources, run this, and commit docs/guide/ with them (GitHub Pages serves docs/ as it is).

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const srcDir = join(root, 'support', 'guide');
const outDir = join(root, 'docs', 'guide');
const site = JSON.parse(readFileSync(join(srcDir, 'site.json'), 'utf8'));

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slugify = (s) => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const plain = (html) => html.replace(/<pre[\s\S]*?<\/pre>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

const pages = [];
for (const section of site.sections) for (const p of section.pages) pages.push({ ...p, section: section.title });

// Fail loudly when pages and the site map disagree.
const files = readdirSync(join(srcDir, 'pages')).filter((f) => f.endsWith('.html')).map((f) => f.slice(0, -5));
for (const p of pages) if (!files.includes(p.slug)) throw new Error('missing page file for ' + p.slug);
for (const f of files) if (!pages.some((p) => p.slug === f)) throw new Error('page file not in site.json: ' + f);

function expand(body, slug) {
  let out = body
    .replace(/<fig src="([^"]+)" alt="([^"]*)">([\s\S]*?)<\/fig>/g, (_, src, alt, cap) =>
      `<figure class="shot"><img src="../img/app/${src}.webp" alt="${alt}" width="2880" height="1800" loading="lazy" decoding="async"><figcaption>${cap.trim()}</figcaption></figure>`)
    .replace(/<key>/g, '<kbd>').replace(/<\/key>/g, '</kbd>')
    .replace(/<note>([\s\S]*?)<\/note>/g, '<aside class="note">$1</aside>');
  const toc = [];
  const seen = new Set();
  out = out.replace(/<h2>([\s\S]*?)<\/h2>/g, (_, text) => {
    let id = slugify(text), n = 2;
    while (seen.has(id)) id = slugify(text) + '-' + n++;
    seen.add(id);
    toc.push({ id, text: plain(text) });
    return `<h2 id="${id}">${text}</h2>`;
  });
  // Every internal link must point at a real page.
  for (const m of out.matchAll(/href="([a-z0-9-]+)\.html(#[^"]*)?"/g)) {
    if (!pages.some((p) => p.slug === m[1])) throw new Error(`${slug}: link to unknown page ${m[1]}.html`);
  }
  return { html: out, toc };
}

const brand = `<a class="brand" href="../" aria-label="MajesticTab home"><span class="tile"><img src="../icons/mark.svg" width="24" height="25" alt=""></span><span>Majestic<b>Tab</b></span></a>`;

function head({ title, desc, url }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}">
  <meta name="theme-color" content="#1e2636">
  <link rel="canonical" href="${site.base}/guide/${url}">
  <meta name="robots" content="index, follow, max-image-preview:large">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="MajesticTab">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(desc)}">
  <meta property="og:url" content="${site.base}/guide/${url}">
  <meta property="og:image" content="${site.base}/img/app/og.jpg">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="icon" type="image/png" sizes="32x32" href="../icons/favicon-32x32.png">
  <link rel="apple-touch-icon" href="../icons/apple-touch-icon.png">
  <link rel="preload" href="../fonts/barlow-condensed-latin-600-normal.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="../site.css">
  <link rel="stylesheet" href="../guide.css">
  <script>document.documentElement.classList.add('js');</script>
</head>`;
}

function header() {
  return `<a class="skip" href="#main">Skip to content</a>
<header class="top">
  <div class="wrap gwrap">
    ${brand}
    <nav class="nav" aria-label="Site">
      <button class="gmenu" type="button" aria-expanded="false" aria-controls="gside">Contents</button>
      <a href="../">Home</a>
      <a href="./" aria-current="true">Guide</a>
      <a href="../#download" class="btn">Download</a>
    </nav>
  </div>
</header>`;
}

function sidebar(currentSlug) {
  const groups = site.sections.map((s) => `
        <div class="gsec">
          <h2 class="gsec-title">${esc(s.title)}</h2>
          <ul>
${s.pages.map((p) => `            <li><a href="${p.slug}.html"${p.slug === currentSlug ? ' aria-current="page"' : ''}>${esc(p.title)}</a></li>`).join('\n')}
          </ul>
        </div>`).join('');
  return `<aside class="gside" id="gside" aria-label="Guide contents">
      <form class="gsearch" role="search" onsubmit="return false">
        <label class="sr" for="gq">Search the guide</label>
        <input id="gq" type="search" placeholder="Search the guide" autocomplete="off" spellcheck="false" aria-controls="gresults">
      </form>
      <div class="gresults" id="gresults" role="region" aria-label="Search results" aria-live="polite" hidden></div>
      <nav class="gnav" id="gnav" aria-label="Guide">${groups}
      </nav>
    </aside>`;
}

function footer() {
  return `<footer class="foot">
  <div class="wrap gwrap">
    ${brand.replace('class="brand"', 'class="brand"')}
    <nav class="foot-links" aria-label="Footer">
      <a href="../">Home</a>
      <a href="https://github.com/cgarst/MajesticTab">Source code</a>
      <a href="https://github.com/cgarst/MajesticTab/releases/latest">Latest release</a>
      <a href="https://github.com/cgarst/MajesticTab/issues">Report an issue</a>
      <a href="../privacy.html">Privacy</a>
    </nav>
    <p class="legal">© MajesticTab<span class="dot">·</span>Guitar tab reader and practice app</p>
  </div>
</footer>
<script src="../guide.js" defer></script>
</body>
</html>
`;
}

mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(outDir)) if (f.endsWith('.html') || f === 'search.json') rmSync(join(outDir, f));

const searchIndex = [];

pages.forEach((p, i) => {
  const raw = readFileSync(join(srcDir, 'pages', p.slug + '.html'), 'utf8');
  const { html, toc } = expand(raw, p.slug);
  const prev = pages[i - 1], next = pages[i + 1];
  const tocHtml = toc.length > 1
    ? `<nav class="gtoc" aria-label="On this page"><h2 class="gtoc-title">On this page</h2><ul>${toc.map((t) => `<li><a href="#${t.id}">${esc(t.text)}</a></li>`).join('')}</ul></nav>`
    : '';
  const pager = `<nav class="gpager" aria-label="Previous and next page">
        ${prev ? `<a class="prev" href="${prev.slug}.html"><span class="muted">Previous</span><strong>${esc(prev.title)}</strong></a>` : '<span></span>'}
        ${next ? `<a class="next" href="${next.slug}.html"><span class="muted">Next</span><strong>${esc(next.title)}</strong></a>` : '<span></span>'}
      </nav>`;
  const doc = `${head({ title: `${p.title} - MajesticTab guide`, desc: p.desc, url: p.slug + '.html' })}
<body>
${header()}
<div class="wrap gwrap glayout">
    ${sidebar(p.slug)}
    <main class="gmain" id="main">
      <article class="gdoc">
        <h1>${esc(p.title)}</h1>
        ${html}
      </article>
      ${pager}
      <p class="gedit small muted">If something on this page is wrong or out of date, <a href="https://github.com/cgarst/MajesticTab/edit/main/support/guide/pages/${p.slug}.html">edit this page on GitHub</a> or <a href="https://github.com/cgarst/MajesticTab/issues">report an issue</a>.</p>
    </main>
    ${tocHtml}
</div>
${footer()}`;
  writeFileSync(join(outDir, p.slug + '.html'), doc);
  searchIndex.push({ u: p.slug + '.html', t: p.title, s: p.section, h: toc.map((t) => ({ i: t.id, t: t.text })), x: plain(html) });
});

// Guide home: a list of sections with a row for each page, one picture, and the search field.
const home = `${head({ title: 'MajesticTab guide - how to use the app', desc: 'The MajesticTab user guide. Install the app, build a library, read and practice tabs, sync a tab to a recording, start a Jam and look up shortcuts.', url: '' })}
<body>
${header()}
<main id="main" class="ghome">
  <div class="wrap gwrap">
    <section class="ghome-top">
      <div>
        <h1>MajesticTab guide</h1>
        <p class="lead">Learn how to add tabs, read and practice them, and play with other people.</p>
        <form class="gsearch gsearch-home" role="search" onsubmit="return false">
          <label class="sr" for="gq-home">Search the guide</label>
          <input id="gq-home" type="search" placeholder="Search the guide" autocomplete="off" spellcheck="false" aria-controls="gresults-home">
        </form>
        <div class="gresults gresults-home" id="gresults-home" role="region" aria-label="Search results" aria-live="polite" hidden></div>
        <p class="small muted">New to MajesticTab? Start with <a class="ulink" href="first-song.html">Open your first tab</a>. To find a key, see <a class="ulink" href="shortcuts.html">Keyboard shortcuts</a>.</p>
      </div>
      <figure class="shot"><img src="../img/app/reader.webp" alt="The MajesticTab reader showing a Guitar Pro score with the fretboard and playback dock" width="2880" height="1800" decoding="async"></figure>
    </section>
    <div class="gtopics">
${site.sections.map((s) => `      <section class="gtopic">
        <h2>${esc(s.title)}</h2>
        <ul>
${s.pages.map((p) => `          <li><a href="${p.slug}.html"><strong>${esc(p.title)}</strong><span class="muted">${esc(p.desc)}</span></a></li>`).join('\n')}
        </ul>
      </section>`).join('\n')}
    </div>
  </div>
</main>
${footer()}`;
writeFileSync(join(outDir, 'index.html'), home);
writeFileSync(join(outDir, 'search.json'), JSON.stringify(searchIndex));

// Sitemap: the landing page, privacy, the guide home and every guide page.
const urls = [
  ['', 'monthly', '1.0'], ['guide/', 'monthly', '0.8'],
  ...pages.map((p) => ['guide/' + p.slug + '.html', 'monthly', '0.6']),
  ['privacy.html', 'yearly', '0.2'],
];
writeFileSync(join(root, 'docs', 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  urls.map(([u, c, pr]) => `  <url><loc>${site.base}/${u}</loc><changefreq>${c}</changefreq><priority>${pr}</priority></url>`).join('\n') +
  `\n</urlset>\n`);

console.log(`Built ${pages.length} pages, the guide home, search.json and sitemap.xml`);
