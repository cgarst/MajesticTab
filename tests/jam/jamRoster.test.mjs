// Run with: node --test tests/jam/jamRoster.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveNames, cleanAlias, guestNameFromUserAgent, MAX_ALIAS_LENGTH } from '../../app/jam/jamRoster.js';

const peers = (...names) => names.map((name, i) => ({ id: `p${i}`, name }));

test('unique names are left alone', () => {
    const out = resolveNames(peers('Sam', 'Alex'), new Map());
    assert.deepEqual(out.map((p) => p.name), ['Sam', 'Alex']);
    assert.deepEqual(out.map((p) => p.originalName), ['Sam', 'Alex']);
});

test('shared names are numbered in join order', () => {
    const out = resolveNames(peers('MajesticTab', 'Sam', 'MajesticTab'), new Map());
    assert.deepEqual(out.map((p) => p.name), ['MajesticTab (1)', 'Sam', 'MajesticTab (2)']);
});

test('an alias replaces the name and resolves a clash', () => {
    const out = resolveNames(peers('MajesticTab', 'MajesticTab'), new Map([['p1', 'Riley']]));
    assert.deepEqual(out.map((p) => p.name), ['MajesticTab', 'Riley']);
    assert.equal(out[1].originalName, 'MajesticTab');
});

test('two aliases that match are numbered too', () => {
    const out = resolveNames(peers('a', 'b'), new Map([['p0', 'Sam'], ['p1', 'Sam']]));
    assert.deepEqual(out.map((p) => p.name), ['Sam (1)', 'Sam (2)']);
});

test('cleanAlias trims, collapses spaces and caps the length', () => {
    assert.equal(cleanAlias('  Sam   B  '), 'Sam B');
    assert.equal(cleanAlias(''), '');
    assert.equal(cleanAlias(null), '');
    assert.equal(cleanAlias('x'.repeat(100)).length, MAX_ALIAS_LENGTH);
});

test('guestNameFromUserAgent names the device kind', () => {
    const ua = {
        iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
        ipad: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
        phone: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
        tablet: 'Mozilla/5.0 (Linux; Android 14; SM-X900) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15',
        chromebook: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
    };
    assert.deepEqual(Object.values(ua).map((s) => guestNameFromUserAgent(s)),
        ['iPhone', 'iPad', 'Android phone', 'Android tablet', 'Windows PC', 'Mac', 'Chromebook', 'Linux PC']);
    assert.equal(guestNameFromUserAgent(''), 'Guest');
});

test('an iPad that sends a Mac user agent is still an iPad', () => {
    const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15';
    assert.equal(guestNameFromUserAgent(mac, 5), 'iPad');
    assert.equal(guestNameFromUserAgent(mac, 0), 'Mac');
});
