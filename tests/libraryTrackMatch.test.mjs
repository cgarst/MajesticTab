import assert from 'node:assert/strict';
const { findTrackByRecording } = await import('../src/libraryStore.js');
const tracks = [{ recordingMbid: 'r', mediumNumber: 1, trackNumber: 4 }, { recordingMbid: 'r', mediumNumber: 2, trackNumber: 4 }];
assert.equal(findTrackByRecording(tracks, { recordingMbid: 'r', mediumNumber: 2 }).mediumNumber, 2);
assert.equal(findTrackByRecording(tracks, { recordingMbid: 'r' }).mediumNumber, 1);
assert.equal(findTrackByRecording(tracks, { recordingMbid: 'zz' }), null);
console.log("findTrackByRecording tests passed!");
