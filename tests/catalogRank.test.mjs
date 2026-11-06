// Run: node tests/catalogRank.test.mjs
// Fixture mirrors real MusicBrainz responses for the query "Metallica".
import assert from 'node:assert/strict';
import { rankCatalogArtists, rankCatalogAlbums, rankCatalogSongs, splitCatalogArtists } from '../src/catalogRank.js';

const artists = [
  { id: 'x2', name: 'Metallica 2', disambiguation: 'Chilean tribal ambient/metal', score: 61, tagCount: 3 },
  { id: 'x3', name: 'Metallica Reloaded', disambiguation: 'Metallica tribute band', score: 60, tagCount: 0 },
  { id: 'dup', name: 'Metallica', disambiguation: 'cover act', score: 100, tagCount: 0 },
  { id: 'real', name: 'Metallica', disambiguation: '', score: 100, tagCount: 65 },
];
const ranked = rankCatalogArtists(artists, 'Metallica');
assert.equal(ranked[0].id, 'real');
assert.equal(ranked.at(-1).id, 'x3');

const albums = [
  { id: 'a1', title: 'Metallica', artist: 'Cloutchaser', artistMbid: 'c', score: 100, primaryType: 'Album' },
  { id: 'a2', title: 'Metallica (8-bit Tribute)', artist: 'Chiptune', score: 100, primaryType: 'Album' },
  { id: 'a3', title: 'Metallica', artist: 'Metallica', artistMbid: 'real', score: 100, primaryType: 'Album' },
];
assert.equal(rankCatalogAlbums(albums, 'Metallica', ranked[0])[0].id, 'a3');

const songs = [
  { title: 'Metallica', artist: 'Unrelated Band', score: 300 },
  { title: 'Enter Sandman', artist: 'Metallica', artistMbid: 'real', score: 150 },
];
assert.equal(rankCatalogSongs(songs, 'Metallica', ranked[0])[0].title, 'Enter Sandman');

// Song-title query: the title match stays on top, junk covers sink.
const s2 = [
  { title: 'Shape of You (8-bit cover)', artist: 'Chip', score: 300 },
  { title: 'Shape of You', artist: 'Ed Sheeran', score: 280 },
];
assert.equal(rankCatalogSongs(s2, 'Shape of You', null)[0].artist, 'Ed Sheeran');
// Weak partial-name artists trail the real artist's albums and songs.
const many = rankCatalogArtists([
  { id: 'x2', name: 'Metallica 2', score: 100, tagCount: 3 },
  { id: 'sk', name: 'Some Kind of Metallica', score: 100, tagCount: 1 },
  { id: 'real', name: 'Metallica', score: 100, tagCount: 65 },
], 'Metallica');
const sp = splitCatalogArtists(many, 'Metallica');
assert.deepEqual(sp.lead.map(a => a.id), ['real']);
assert.deepEqual(sp.rest.map(a => a.id).sort(), ['sk', 'x2']);
assert.equal(splitCatalogArtists(many, 'Metal').rest.length, 0);
console.log('catalogRank ok');
