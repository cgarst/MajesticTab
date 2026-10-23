// soundFontSanitize.js
// Clamp out-of-spec generators in a SoundFont before AlphaTab's synth sees it.

const GEN_INITIAL_ATTENUATION = 48;

/**
 * SF2 limits initialAttenuation to 0 or more (centibels), and most synths clamp the result. AlphaTab does not, so a
 * negative value (some fonts use -960, i.e. +96 dB) plays at roughly 100,000x volume. Rewrites those to 0 in place.
 * @param {Uint8Array} bytes SoundFont file contents (modified in place)
 * @returns {number} how many generators were clamped
 */
export function clampNegativeAttenuation(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tag = (o) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
    if (bytes.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'sfbk') return 0;
    let fixed = 0;
    let o = 12;
    while (o + 8 <= bytes.byteLength) {
        const size = view.getUint32(o + 4, true);
        if (tag(o) === 'LIST' && tag(o + 8) === 'pdta') {
            let p = o + 12;
            const end = Math.min(o + 8 + size, bytes.byteLength);
            while (p + 8 <= end) {
                const chunkSize = view.getUint32(p + 4, true);
                if (tag(p) === 'pgen' || tag(p) === 'igen') {
                    // 4-byte records: u16 operator, i16 amount
                    for (let r = p + 8; r + 4 <= p + 8 + chunkSize; r += 4) {
                        if (view.getUint16(r, true) === GEN_INITIAL_ATTENUATION && view.getInt16(r + 2, true) < 0) {
                            view.setInt16(r + 2, 0, true);
                            fixed++;
                        }
                    }
                }
                p += 8 + chunkSize + (chunkSize & 1);
            }
            break;
        }
        o += 8 + size + (size & 1);
    }
    return fixed;
}
