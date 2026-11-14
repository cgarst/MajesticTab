import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanTrackTitleForMatching, searchMusicBrainz } from '../src/musicbrainz.js';
import { SUPPORTED_TAB_EXTENSIONS } from '../src/utils/fileHandlingUtils.js';

test('cleanTrackTitleForMatching cleans instrumental and non-word characters', () => {
    assert.equal(cleanTrackTitleForMatching('Battery (Instrumental Version)'), 'battery');
    assert.equal(cleanTrackTitleForMatching('Master of Puppets - Instrumental'), 'master of puppets');
    assert.equal(cleanTrackTitleForMatching('Orion (Live at Wembley)'), 'orion live at wembley');
});

test('SUPPORTED_TAB_EXTENSIONS contains all expected tab formats', () => {
    assert.deepEqual(SUPPORTED_TAB_EXTENSIONS, ['gp', 'gp3', 'gp4', 'gp5', 'gpx', 'pdf', 'txt', 'mtab']);
});

test('searchMusicBrainz respects AbortController signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
        async () => {
            await searchMusicBrainz('Metallica', 'artist', { signal: controller.signal });
        },
        (err) => err.name === 'AbortError'
    );
});

test('batch queue advances to next unacquired track', () => {
    const queue = [
        { trackNumber: 1, title: 'Battery', acquired: true },
        { trackNumber: 2, title: 'Master of Puppets', acquired: true },
        { trackNumber: 3, title: 'The Thing That Should Not Be', acquired: false },
        { trackNumber: 4, title: 'Welcome Home (Sanitarium)', acquired: false }
    ];

    let currentIndex = 0;
    // Pre-flight smart positioning: find first unacquired track
    currentIndex = queue.findIndex(t => !t.acquired);
    assert.equal(currentIndex, 2);
    assert.equal(queue[currentIndex].title, 'The Thing That Should Not Be');

    // Simulate downloading track 3
    queue[currentIndex].acquired = true;

    // Advance to next unacquired track
    let nextIdx = queue.findIndex((t, i) => i > currentIndex && !t.acquired);
    if (nextIdx === -1) nextIdx = queue.findIndex(t => !t.acquired);
    assert.equal(nextIdx, 3);
    assert.equal(queue[nextIdx].title, 'Welcome Home (Sanitarium)');
});
