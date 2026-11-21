/**
 * What the Practice panel can offer for what is open. Pure, so tests/practiceCaps.test.mjs can walk every case
 * (Guitar Pro, text, PDF; Synth, Original or Off; local, embedded or YouTube sound; auto-scroll).
 *
 * `beatSource` says where the click gets its beats, and the Tempo row appears only for 'free':
 *   'score'  a score (Guitar Pro, or a MIDI file's virtual score) with its own tempo map and the synth or a synced recording
 *   'free'   nothing has a tempo of its own (a PDF, text with no MIDI, a recording with no map, auto-scroll): BPM and beats
 *   Click and Count-in always work, so they have no flag.
 *
 * @param {object} s
 * @param {boolean} s.hasScore       a score with bars is attached (Guitar Pro, or a MIDI file on a text tab)
 * @param {boolean} s.auto           auto-scroll is the transport (no sound and no map points)
 * @param {boolean} s.freeClick      the free click is the click source
 * @param {boolean} s.onRecording    Original is the selected sound
 * @param {'local'|'embedded'|'youtube'|null} s.originalKind
 * @param {boolean} s.originalAttached  the Original slot has a recording to play
 * @param {boolean} s.hasPresets     the Original panel offers speed presets (a video)
 */
export function practiceCaps(s) {
    const recording = s.onRecording && s.originalAttached
        && (s.originalKind === 'local' || s.originalKind === 'embedded' || (s.originalKind === 'youtube' && s.hasPresets));
    let speed = null;
    if (s.auto) speed = 'pace';
    else if (s.hasScore && !s.onRecording) speed = 'synth';
    else if (recording) speed = s.originalKind === 'youtube' ? 'presets' : 'percent';
    return {
        speed,                        // null | 'pace' | 'synth' | 'presets' | 'percent'
        loopBars: Boolean(s.hasScore),
        parts: Boolean(s.hasScore),   // still hidden by gpPlayer until the score has sections
        tempo: Boolean(s.freeClick),
        beatSource: s.freeClick ? 'free' : 'score'
    };
}
