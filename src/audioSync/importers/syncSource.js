// importers/syncSource.js
// Runs an extension's sync source (see `registerSyncSource` in extensionSandbox/frame.js). The extension runs in a
// sandbox with no network, so it is a step function: given the address and the response texts so far it returns either
// `{ fetch: [addresses] }`, which are fetched here and appended to the responses before the next call, or `{ text }`.
// The extension decides where the data is; this decides what it may fetch: https only, the same origin as the address
// the user gave, a few rounds and requests, and a size cap. Pure apart from the injected `step` and `fetchText`; unit
// tested in tests/audioSync/syncSource.test.mjs.

const MAX_ROUNDS = 5;
const MAX_PER_ROUND = 5;
const MAX_CHARS = 5_000_000;

/**
 * @param {object} opts
 * @param {string} opts.url the address the user gave
 * @param {(url: string, responses: string[]) => Promise<{text?: string, fetch?: string[]}>} opts.step
 * @param {(url: string) => Promise<string>} opts.fetchText
 * @returns {Promise<string>} the text the extension produced
 */
export async function runSyncSteps({ url, step, fetchText }) {
    const origin = new URL(url).origin;
    const responses = [];
    for (let round = 0; round < MAX_ROUNDS; round++) {
        const out = await step(url, responses);
        if (typeof out?.text === 'string') return out.text;
        const wanted = out?.fetch;
        if (!Array.isArray(wanted) || !wanted.length) throw new Error('The converter returned nothing to fetch or read.');
        if (wanted.length > MAX_PER_ROUND) throw new Error(`The converter asked for ${wanted.length} addresses at once; the limit is ${MAX_PER_ROUND}.`);
        for (const address of wanted) {
            let target;
            try { target = new URL(address); } catch { throw new Error('The converter asked for something that is not a web address.'); }
            if (target.protocol !== 'https:') throw new Error('The converter may only fetch https addresses.');
            if (target.origin !== origin) throw new Error(`The converter asked for ${target.host}, which is not the site you gave (${new URL(origin).host}).`);
            const text = await fetchText(target.href);
            if (text.length > MAX_CHARS) throw new Error('A response was too large.');
            responses.push(text);
        }
    }
    throw new Error('The converter needed too many steps.');
}
