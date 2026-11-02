// peaks.js
// Waveform peaks for a recording: the largest absolute sample in each short bin, as bytes. The decoded PCM of a
// long track is large (a 5 minute stereo track is about 100 MB), so it is decoded once, reduced to peaks and
// dropped. `computePeaks` is pure (unit tested in Node, tests/audioSync/peaks.test.mjs); `decodePeaks` needs a
// browser's decoder.

export const PEAKS_PER_SECOND = 50;

/**
 * @param {Float32Array[]} channels decoded channel data (all the same length)
 * @param {number} sampleRate
 * @returns {Uint8Array} one byte per bin, 0 to 255, the loudest channel's peak in the bin
 */
export function computePeaks(channels, sampleRate, peaksPerSecond = PEAKS_PER_SECOND) {
    const length = channels[0]?.length || 0;
    const binSize = Math.max(1, Math.round(sampleRate / peaksPerSecond));
    const bins = Math.ceil(length / binSize);
    const out = new Uint8Array(bins);
    for (const data of channels) {
        for (let b = 0; b < bins; b++) {
            const end = Math.min(length, (b + 1) * binSize);
            let peak = 0;
            for (let i = b * binSize; i < end; i++) {
                const v = data[i] < 0 ? -data[i] : data[i];
                if (v > peak) peak = v;
            }
            const byte = Math.min(255, Math.round(peak * 255));
            if (byte > out[b]) out[b] = byte;
        }
    }
    return out;
}

/** Decodes `arrayBuffer` and returns `{ peaks, durationMs }`, or null when the platform can't decode this format. */
export async function decodePeaks(arrayBuffer, peaksPerSecond = PEAKS_PER_SECOND) {
    const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctx) return null;
    const ctx = new Ctx();
    try {
        // decodeAudioData detaches the buffer it is given, so decode a copy and keep the original for storage
        const audio = await ctx.decodeAudioData(arrayBuffer.slice(0));
        const channels = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i));
        return { peaks: computePeaks(channels, audio.sampleRate, peaksPerSecond), durationMs: Math.round(audio.duration * 1000) };
    } catch {
        return null;
    } finally {
        ctx.close?.().catch?.(() => {});
    }
}
