// Run with: node --test tests/jam/jamTrackPolicy.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { trackPolicyFor, trackStateFor } from '../../app/jam/jamTrackPolicy.js';

const none = { mute: null, audio: null, view: null, viewHide: null };
const base = { trackAssignments: { sam: [1], alex: [2, 3] }, listeners: ['jordan'] };

test('Not set people are unrestricted whatever the rules say', () => {
    const state = { ...base, assignedAudioMode: 'assigned', assignedViewOnly: true, listeningHears: 'backing', listeningSees: 'backing' };
    assert.equal(trackStateFor(state, 'riley'), 'unset');
    assert.deepEqual(trackPolicyFor(state, 'riley'), none);
    assert.deepEqual(trackPolicyFor(undefined, 'riley'), none);
});

test('Assigned people follow the assigned-audio and view rules', () => {
    assert.deepEqual(trackPolicyFor(base, 'sam'), none);
    assert.deepEqual(trackPolicyFor({ ...base, assignedAudioMode: 'assigned' }, 'alex'), { ...none, audio: [2, 3] });
    assert.deepEqual(trackPolicyFor({ ...base, assignedAudioMode: 'backing' }, 'sam'), { ...none, mute: [1] });
    assert.deepEqual(trackPolicyFor({ ...base, assignedViewOnly: true }, 'sam'), { ...none, view: [1] });
});

test('Listening people follow the listening rules and ignore the assigned rules', () => {
    assert.equal(trackStateFor(base, 'jordan'), 'listening');
    assert.deepEqual(trackPolicyFor({ ...base, assignedAudioMode: 'assigned', assignedViewOnly: true }, 'jordan'), none);
    assert.deepEqual(trackPolicyFor({ ...base, listeningHears: 'backing' }, 'jordan'), { ...none, mute: [1, 2, 3] });
    assert.deepEqual(trackPolicyFor({ ...base, listeningSees: 'backing' }, 'jordan'), { ...none, viewHide: [1, 2, 3] });
});

test('Listening rules do nothing while no tracks are assigned', () => {
    const state = { trackAssignments: {}, listeners: ['jordan'], listeningHears: 'backing', listeningSees: 'backing' };
    assert.deepEqual(trackPolicyFor(state, 'jordan'), none);
});

test('A person with tracks is Assigned even if also listed as a listener', () => {
    assert.equal(trackStateFor({ trackAssignments: { sam: [1] }, listeners: ['sam'] }, 'sam'), 'assigned');
});
