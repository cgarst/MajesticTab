// Run: node tests/tabTuningMeta.test.mjs
// The tuning bridge for PDF and text tabs (source order, the classical archive's flags, header text) and the
// per-song hidden tunings filter.
import assert from 'node:assert/strict';
import { resolveTabTuning, tuningFromHeaderText, tuningFromFirstSystem, capoFromHeaderText, tuningFromClassicalFlag, canReplaceTuning, LUTE_TUNING } from '../src/utils/tabTuningMeta.js';
import { resolveTabTempoAndMeter, bpmFromHeaderText, tempoWordFromHeaderText, timeSigFromHeaderText } from '../src/classtab/tabTempoMeta.js';
import { getTuningInfo, tuningKeyOf, visibleTuningsForSong, isTuningHiddenForSong, allSongTunings, visibleTuningLabel } from '../src/utils/tuningUtils.js';
import { parseCustomTuning } from '../src/utils/songTuningMenu.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('classical flags', () => {
    assert.equal(tuningFromClassicalFlag('drop D'), 'Drop D');
    assert.equal(tuningFromClassicalFlag('lute tuning'), 'E A D F# B E');
    assert.equal(tuningFromClassicalFlag('other tuning'), null);
    assert.equal(tuningFromClassicalFlag(undefined), null);
});

t('lute tuning is a named tuning', () => {
    const info = getTuningInfo(LUTE_TUNING);
    assert.equal(info.displayName, 'Lute tuning');
    assert.equal(info.stringCount, 6);
    assert.equal(info.key, 'EADF#BE');
});

t('source order: classtab, header, filename', () => {
    assert.deepEqual(resolveTabTuning({ classtabFlag: 'drop D', headerText: 'tuning: E A D G B E', fileName: 'x.txt' }), { tuning: 'Drop D', source: 'classtab' });
    assert.equal(resolveTabTuning({ classtabFlag: 'other tuning', headerText: 'tuning: D A D G B E' }).source, 'header');
    assert.equal(resolveTabTuning({ fileName: 'Song (Drop C).pdf' }).source, 'filename');
    assert.deepEqual(resolveTabTuning({ classtabFlag: 'other tuning', headerText: 'Prelude', fileName: 'bwv999.txt' }), { tuning: null, source: null });
});

t('header text', () => {
    assert.equal(tuningFromHeaderText('Title\nTuning: D A D G B E\n'), 'D A D G B E');
    assert.equal(tuningFromHeaderText('tuned DADGBE'), 'D A D G B E');
    assert.equal(tuningFromHeaderText('6th string to D'), 'D A D G B E');
    assert.equal(tuningFromHeaderText('(6=D) (3=F#)'), 'D A D F# B E');
    assert.equal(tuningFromHeaderText('sixth string tuned down to D'), 'D A D G B E');
    assert.equal(tuningFromHeaderText('Transcribed for drop D guitar'), 'Drop D');
    assert.equal(tuningFromHeaderText('standard notation below'), null);
    assert.equal(tuningFromHeaderText('Lute Suite'), null);
    assert.equal(tuningFromHeaderText('past the first 30 lines\n'.repeat(40) + 'Tuning: D A D G B E'), null);
});

t('user choice is never replaced; stronger sources replace weaker', () => {
    assert.equal(canReplaceTuning('user', 'classtab'), false);
    assert.equal(canReplaceTuning('classtab', 'header'), false);
    assert.equal(canReplaceTuning('filename', 'header'), true);
    assert.equal(canReplaceTuning(undefined, 'filename'), true);
    assert.equal(canReplaceTuning('header', null), false);
});

t('hiding is per song and by key', () => {
    const odd = 'C D E F G A B C D E';
    const song = { tunings: ['Drop D', odd, '8-String Standard'], hiddenTunings: [tuningKeyOf(odd)] };
    assert.deepEqual(visibleTuningsForSong(song), ['Drop D', '8-String Standard']);
    assert.equal(isTuningHiddenForSong(song, odd), true);
    assert.equal(isTuningHiddenForSong(song, 'Drop D'), false);
    // another song with the same tuning is not affected
    assert.deepEqual(visibleTuningsForSong({ tunings: [odd] }), [odd]);
    // a renamed spelling of the same notes is the same key
    assert.equal(tuningKeyOf('D A D G B E'), tuningKeyOf('Drop D'));
    assert.equal(visibleTuningLabel(song, odd), '');
    assert.equal(visibleTuningLabel(song, 'Drop D'), 'Drop D');
});

t('all tunings of a song, one per key', () => {
    const song = { tunings: ['Drop D'], tabOptions: [{ tuning: 'D A D G B E' }, { tunings: ['E Standard'] }] };
    assert.deepEqual(allSongTunings(song), ['Drop D', 'E Standard']);
});

t('hand-typed tunings', () => {
    assert.equal(parseCustomTuning('D A D F# B E'), 'D A D F# B E');
    assert.equal(parseCustomTuning('dadgbe'), 'D A D G B E');
    assert.equal(parseCustomTuning('D A Eb G'), 'D A Eb G');
    assert.equal(parseCustomTuning('D A D X B E'), null);
    assert.equal(parseCustomTuning('D A'), null);
    assert.equal(parseCustomTuning(''), null);
});

t('first-system vertical string labels, shorthand equations, and capo detection', () => {
    assert.equal(tuningFromHeaderText('6th = D, 5th = G'), 'D G D G B E');
    assert.equal(tuningFromHeaderText('Tune 6th to D'), 'D A D G B E');
    assert.equal(tuningFromHeaderText('Key Signature: Dm\n6=D\n'), 'D A D G B E');
    const dropDSys = [
        'Title',
        'E-|---7---|',
        'B-|---7---|',
        'G-|---4---|',
        'D-|---0---|',
        'A-|---0---|',
        'D-|---0---|'
    ].join('\n');
    assert.equal(tuningFromFirstSystem(dropDSys), 'D A D G B E');
    assert.equal(resolveTabTuning({ headerText: dropDSys }).tuning, 'D A D G B E');
    assert.equal(capoFromHeaderText('Capo 2'), 2);
    assert.equal(capoFromHeaderText('capo on 3rd fret'), 3);
    assert.equal(capoFromHeaderText('Capo: IV'), 4);
    assert.equal(capoFromHeaderText('3rd fret capo'), 3);
    assert.equal(capoFromHeaderText('no capo'), null);
});

t('tempo and time signature resolution from text header, MIDI, and ruler', () => {
    assert.equal(bpmFromHeaderText('tuning: E A D G B E   time: 4/4   tempo: 96 bpm')?.bpm, 96);
    assert.equal(bpmFromHeaderText('Tempo: Allegro (fairly fast) - 184 (quarter notes) bpm')?.bpm, 184);
    assert.equal(bpmFromHeaderText('q. = 60')?.beatUnit, 'dotted-quarter');
    assert.deepEqual(tempoWordFromHeaderText('Tempo: Allegretto\nTime Signature: 2/4'), { bpm: 112, word: 'Allegretto' });
    assert.deepEqual(timeSigFromHeaderText('Time Signature: 6/8'), { num: 6, den: 8 });
    assert.deepEqual(timeSigFromHeaderText('2/4 time'), { num: 2, den: 4 });
    // Priority: header numeric BPM > MIDI > header Italian word > 100
    assert.equal(resolveTabTempoAndMeter({
        headerText: 'Allegro\ntempo: 108 bpm',
        midiMeta: { primaryBpm: 120 }
    }).baseBpm, 108);
    assert.equal(resolveTabTempoAndMeter({
        headerText: 'Allegro',
        midiMeta: { primaryBpm: 120 }
    }).baseBpm, 120);
    assert.equal(resolveTabTempoAndMeter({
        headerText: 'Andante\nTime Signature: 3/4'
    }).baseBpm, 76);
    assert.deepEqual(resolveTabTempoAndMeter({
        headerText: 'Andante\nTime Signature: 3/4'
    }).timeSig, { num: 3, den: 4 });
});

console.log(`${n} passed`);
