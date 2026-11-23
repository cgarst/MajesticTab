// audioSync/slotKeys.js
// The localStorage keys under which a song's audio slots are filed. A song is known by its key ("Artist - Title"),
// the same key the Sound panel files its audio under.

const enc = (songKey) => encodeURIComponent(String(songKey).toLowerCase());
export const slotFileKey = (songKey, slot) => `audio_file_${enc(songKey)}_${slot}`;
export const slotSourceKey = (songKey, slot) => `real_audio_source_${enc(songKey)}_${slot}`;
