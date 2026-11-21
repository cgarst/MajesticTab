// Run with: node --test tests/audioSync/stemRepair.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { planStemRepair } from '../../src/audioSync/stemRepair.js';

const stems = [{ audioId: 'a', label: 'Guitar', instrument: 'guitar' }, { audioId: 'b', label: 'Bass', instrument: 'bass' }, { audioId: 'c', label: 'Drums', instrument: 'drums' }];
const lead = { role: 'original', label: 'All stems', stems };

test('a part still listed as an alternate becomes a stem of the lead', () => {
    const fixes = planStemRepair({
        local_a: lead,
        local_b: { role: 'alternate', label: 'bass take' },
        local_c: { role: 'stem', stemOf: 'local_a', label: 'Drums', instrument: 'drums' },
    });
    assert.equal(fixes.length, 1);
    assert.deepEqual(fixes[0].meta, { role: 'stem', stemOf: 'local_a', label: 'bass take', instrument: 'bass' });
    assert.equal(fixes[0].was, 'alternate');
});

test('a set that is already right gives nothing, and the lead is never changed', () => {
    assert.deepEqual(planStemRepair({
        local_a: lead,
        local_b: { role: 'stem', stemOf: 'local_a', label: 'Bass' },
        local_c: { role: 'stem', stemOf: 'local_a', label: 'Drums' },
    }), []);
});

test('a part with no meta, or one that two sets claim, is left alone', () => {
    assert.deepEqual(planStemRepair({ local_a: lead }), []);
    const other = { role: 'original', stems: [{ audioId: 'x', label: 'X' }, { audioId: 'b', label: 'Bass' }] };
    assert.deepEqual(planStemRepair({ local_a: lead, local_x: other, local_b: { role: 'alternate' } }), []);
});

test('a stem pointing at the wrong parent is pointed at its set', () => {
    const fixes = planStemRepair({ local_a: lead, local_b: { role: 'stem', stemOf: 'local_zzz', label: 'Bass' } });
    assert.equal(fixes[0].meta.stemOf, 'local_a');
});
