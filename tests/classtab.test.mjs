// Run: node tests/classtab.test.mjs
// Parser and browse logic on a small inline page shaped like the Classtab catalog (index_old.htm).
// With CLASSTAB_ZIP=/path/to/classtab.zip it also checks the real archive's counts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as fflate from 'fflate';
import { parseClasstabIndex, catalogCounts, decodeEntities } from '../src/classtab/parse.js';
import { browse, composerList, pieceFacts } from '../src/classtab/catalog.js';
import { readCatalogFromZip, diffCatalogs } from '../src/classtab/archive.js';

globalThis.fflate = fflate;

const page = `<html><body>
<b>Heading</b><br>
<b><a href="tabadd.htm">recent additions</a></b><br><br>
<a name="atab"></a>
<b>Zequinha de Abreu&#160; (Zequinha Abreu, Jos&eacute; Gomes de Abreu)</b>&#160; (1880-1935)<br>
<a href="abreu_amando.txt">Amando Sobre O Mar</a> - <a href="abreu_amando.mid">MIDI</a> - <b>LHF</b> - [vid: <a href="https://www.youtube.com/watch?v=8MmCz5APGv8">Edson Lopes</a>]<br>
<a href="abreu_tico.txt">Tico Tico</a> - [<b>easy</b>] - drop D - NEW<br><br>
<b>Jan Antonin Losy&#160; ( Johann Anton Losy (von) Losimthal, Comte Logy)</b>&#160; (1650-1721)<br>
<a href="losy_a.txt">Partita</a> - lute tuning - [audio: <a href="https://www.youtube.com/watch?v=x">Somebody</a>] - <a href="https://soundcloud.com/a/b">SC</a><br><br>
<b>anonymous / traditional</b><br>
<a href="anon_greensleeves.txt">Greensleeves</a> - duet<br>
</body></html>`;

const c = parseClasstabIndex(page);
assert.deepEqual(catalogCounts(c), { composers: 3, pieces: 4 });
assert.equal(c[0].name, 'Zequinha de Abreu');
assert.equal(c[0].aliases, 'Zequinha Abreu, José Gomes de Abreu');
assert.equal(c[0].dates, '1880-1935');
assert.equal(c[1].aliases, 'Johann Anton Losy (von) Losimthal, Comte Logy');
assert.equal(c[2].dates, undefined);
const [amando, tico] = c[0].pieces;
assert.deepEqual(amando.midi_urls, ['abreu_amando.mid']);
assert.equal(amando.has_lhf, true);
assert.equal(amando.video_links[0].performer, 'Edson Lopes');
assert.equal(tico.is_easy, true);
assert.equal(tico.tuning, 'drop D');
assert.equal(tico.is_new, true);
const partita = c[1].pieces[0];
assert.equal(partita.tuning, 'lute tuning');
assert.equal(partita.video_links, undefined);
assert.equal(partita.audio_links.length, 2);
assert.equal(c[2].pieces[0].is_duet, true);
assert.equal(decodeEntities('Pi&egrave;ces &#269; &amp; &nbsp;x').replace(/ /g, ' '), 'Pièces č &   x'.replace('   ', '  '));

// Browse
assert.deepEqual(composerList(c).map((x) => x.name), ['Zequinha de Abreu', 'anonymous / traditional', 'Jan Antonin Losy']);
const all = browse(c, {});
assert.equal(all.pieces.length, 4);
assert.equal(browse(c, { composer: 0 }).pieces.length, 2);
assert.equal(browse(c, { filters: ['easy'] }).pieces.length, 1);
assert.equal(browse(c, { query: 'jose gomes' }).pieces.length, 2, 'search folds accents and matches aliases');
assert.equal(browse(c, { query: 'green' }).pieces[0].piece.title, 'Greensleeves');
assert.deepEqual(pieceFacts(tico), ['New', 'Easy', 'Drop D']);

// Archive: a bad ZIP is refused, a good one is read
assert.throws(() => readCatalogFromZip(new Uint8Array([1, 2, 3])), /isn't the Classtab archive/);
const many = page.replace('</body>', Array.from({ length: 3000 }, (_, i) => `<a href="x${i}.txt">T${i}</a><br>`).join('') + '</body>');
const zip = fflate.zipSync({ 'classtab/index_old.htm': fflate.strToU8(many), 'classtab/abreu_tico.txt': fflate.strToU8('tab') });
const rec = readCatalogFromZip(zip);
assert.equal(rec.prefix, 'classtab/');
assert.ok(rec.counts.pieces > 3000);
assert.deepEqual(diffCatalogs(null, rec), { added: 0, changed: 0 });
assert.equal(diffCatalogs({ composers: [], sizes: {}, prefix: '' }, rec).added, rec.counts.pieces);

if (process.env.CLASSTAB_ZIP) {
  const real = readCatalogFromZip(new Uint8Array(fs.readFileSync(process.env.CLASSTAB_ZIP)));
  const flat = real.composers.flatMap((x) => x.pieces);
  assert.ok(real.counts.pieces >= 3800, `pieces ${real.counts.pieces}`);
  assert.ok(real.counts.composers >= 518);
  assert.equal(flat.filter((p) => p.midi_urls).length >= 2200, true);
  assert.equal(flat.filter((p) => p.tuning === 'drop D').length >= 550, true);
  console.log('real archive', real.counts);
}
console.log('classtab ok');
