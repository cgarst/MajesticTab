// Songs filed under another album's slot: found by a shared recording, confirmed by the album's track list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { findSharedRecordings, misfiledIn, findMisfiledSongs } from '../src/libraryMixedAlbums.js';

const ADTOE = 'adtoe';
const song = (id, title, recordingMbid, extra = {}) => ({ id, title, recordingMbid, albumMbid: ADTOE, album: 'A Dramatic Turn of Events', year: 2011, ...extra });
const library = [
    song('a', 'On the Backs of Angels', 'r1'),
    song('b', '6:00', 'r1'),
    song('c', 'Build Me Up, Break Me Down', 'r2'),
    song('d', 'Caught in a Web', 'r2'),
    song('e', 'Outcry', 'r3'),
    song('f', 'Same title twice', 'r4'), song('g', 'Same title twice', 'r4'),
    song('h', 'Tour cut', 'r5', { isCustom: true }), song('i', 'Other', 'r5', { isCustom: true })
];
const tracks = ['On the Backs of Angels', 'Build Me Up, Break Me Down', 'Outcry'];

test('a recording shared by differently titled songs on one album is found', () => {
    const groups = findSharedRecordings(library);
    assert.deepEqual(groups.map((g) => g.recordingMbid).sort(), ['r1', 'r2']);
});

test('the song missing from the track list is the misfiled one', () => {
    const g = findSharedRecordings(library).find((x) => x.recordingMbid === 'r1');
    assert.deepEqual(misfiledIn(g, tracks).map((s) => s.id), ['b']);
});

test('nothing is flagged when the track list is unknown or no song is on it', () => {
    const g = findSharedRecordings(library)[0];
    assert.deepEqual(misfiledIn(g, null), []);
    assert.deepEqual(misfiledIn(g, ['Something else']), []);
});

test('the scan returns the misfiled songs with the album they sit on', async () => {
    const out = await findMisfiledSongs(library, async () => tracks);
    assert.deepEqual(out.map((o) => o.song.id).sort(), ['b', 'd']);
    assert.equal(out[0].year, 2011);
});
