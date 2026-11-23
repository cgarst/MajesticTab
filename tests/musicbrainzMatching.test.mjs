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
    assert.deepEqual(SUPPORTED_TAB_EXTENSIONS, ['gp', 'gp3', 'gp4', 'gp5', 'gpx', 'pdf', 'txt', 'mpak']);
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
