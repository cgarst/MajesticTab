// Run with: node --test tests/urlImport.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileNameFor, parseWebAddress } from '../src/urlImport/urlImport.js';

test('file names come from the header, then the path', () => {
    assert.equal(fileNameFor('https://x.org/a/b.gp5', 'attachment; filename="My Song.gp"'), 'My Song.gp');
    assert.equal(fileNameFor('https://x.org/a/Duo%20No%202.gp5'), 'Duo No 2.gp5');
    assert.equal(fileNameFor('https://x.org/'), 'tab-from-url');
});

test('addresses must be http or https', () => {
    assert.throws(() => parseWebAddress('nope'), /not a web address/);
    assert.throws(() => parseWebAddress('ftp://x.org/a'), /Only http/);
    assert.equal(parseWebAddress(' https://x.org/a ').host, 'x.org');
});
