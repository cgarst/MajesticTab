// The playability model lives in src/utils/chordPlayability.js because the app's movable shape generator uses it
// too (support/ is not shipped). This re-export keeps check.mjs and repair.mjs importing it from here.
export * from '../../../src/utils/chordPlayability.js';
