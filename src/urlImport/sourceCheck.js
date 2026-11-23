// urlImport/sourceCheck.js
// Reads a service's own description for the source editor: what the service is called, whether the address starts a
// job, and whether it needs an access token. Starts no job.

import { discoverFromAddress, findOperation, asyncMapping, authOf } from './openApiDiscovery.js';
import { httpFetch } from './openFromUrl.js';

/** @returns {Promise<{title: string, needsToken: boolean}>} or throws an Error that says what is wrong */
export async function checkApiSource(template) {
    const address = template.replace(/\$s|\$token/g, 'x');
    let url;
    try { url = new URL(address); } catch { throw new Error('That is not a web address.'); }
    const { spec } = await discoverFromAddress(url.origin + '/', httpFetch());
    const found = findOperation(spec, address);
    if (!found) throw new Error('The service description does not list that address.');
    const { mapping, error } = asyncMapping(found.operation);
    if (!mapping) throw new Error(error);
    return { title: String(spec.info?.title || url.host), needsToken: authOf(spec, found.operation).required };
}
