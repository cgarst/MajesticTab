// Run with: node --test tests/audioSync/stemGuess.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { guessInstrument, labelsFromNames } from '../../src/audioSync/stemGuess.js';

test('an instrument is guessed from the words in a file name', () => {
    assert.equal(guessInstrument('Song - Bass.wav'), 'bass');
    assert.equal(guessInstrument('drums_stem.flac'), 'drums');
    assert.equal(guessInstrument('Lead Guitar 2.mp3'), 'guitar');
    assert.equal(guessInstrument('keys.wav'), 'keys');
    assert.equal(guessInstrument('Vox (lead).wav'), 'vocals');
    assert.equal(guessInstrument('stem7.wav'), 'other');
});

test('the title every name starts with is cut from the labels', () => {
    assert.deepEqual(labelsFromNames(['Hells Kitchen - Guitar 1.wav', 'Hells Kitchen - Bass.wav', 'Hells Kitchen - Drums.wav']), ['Guitar 1', 'Bass', 'Drums']);
});

test('names with nothing in common keep their whole name', () => {
    assert.deepEqual(labelsFromNames(['guitar.wav', 'bass.wav']), ['Guitar', 'Bass']);
});

test('a prefix is not cut through the middle of a word', () => {
    assert.deepEqual(labelsFromNames(['guitar_1.wav', 'guitar_2.wav']), ['Guitar 1', 'Guitar 2']);
});
