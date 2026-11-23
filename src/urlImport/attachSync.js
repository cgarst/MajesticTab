// urlImport/attachSync.js
// The played bars of a score read straight from its file, without opening it.

/**
 * Extract played bars directly from a file buffer in memory without mounting to DOM.
 * @param {File|Blob|Uint8Array|ArrayBuffer} file
 * @returns {Promise<Array<{barIndex:number, occurrence:number, startTick:number, endTick:number}>>}
 */
export async function extractPlayedBarsFromFile(file) {
    if (!file) return [];
    try {
        const at = typeof alphaTab !== 'undefined' ? alphaTab : (await import('@coderline/alphatab')).default || (await import('@coderline/alphatab'));
        if (!at?.importer?.ScoreLoader || !at?.midi?.MidiFileGenerator) return [];
        let bytes;
        if (file instanceof Uint8Array) {
            bytes = file;
        } else if (file instanceof ArrayBuffer) {
            bytes = new Uint8Array(file);
        } else if (typeof file.arrayBuffer === 'function') {
            bytes = new Uint8Array(await file.arrayBuffer());
        } else {
            return [];
        }
        const settings = new at.Settings();
        const score = at.importer.ScoreLoader.loadScoreFromBytes(bytes, settings);
        if (!score) return [];
        const midiFile = new at.midi.MidiFile();
        const handler = new at.midi.AlphaSynthMidiFileHandler(midiFile);
        const generator = new at.midi.MidiFileGenerator(score, settings, handler);
        generator.applyTranspositionPitches = false;
        generator.generate();
        if (!generator.tickLookup?.masterBars?.length) return [];
        const { buildBeatMap } = await import('../audioSync/beatMap.js');
        return buildBeatMap(generator.tickLookup).bars || [];
    } catch {
        return [];
    }
}
