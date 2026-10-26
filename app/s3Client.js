// s3Client.js
// Minimal S3-compatible client (AWS S3, Cloudflare R2, Backblaze B2, MinIO, Wasabi, ...) using Signature V4
// through WebCrypto, so no SDK is needed. In the native app requests go through Tauri's http plugin, which
// is not subject to CORS. In a browser the bucket must allow this origin in its CORS rules (see s3CorsRules).
const CONFIG_KEY = 'majestictab_s3_config';
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const encoder = new TextEncoder();
const hex = (buffer) => Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, '0')).join('');

async function sha256Hex(data) {
    return hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? encoder.encode(data) : data));
}

async function hmac(key, data) {
    const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
}

// RFC 3986 encoding, which is what SigV4 expects (encodeURIComponent leaves !'()* alone)
const encodeRfc3986 = (value) => encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const encodeKey = (key) => key.split('/').map(encodeRfc3986).join('/');

// --- configuration ---

/** @returns {{endpoint: string, region: string, bucket: string, accessKeyId: string, secretAccessKey: string, prefix: string, pathStyle: boolean}|null} */
export function getS3Config() {
    try {
        const config = JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null');
        return config?.bucket && config.accessKeyId && config.secretAccessKey ? config : null;
    } catch (_) { return null; }
}

export function saveS3Config(config) {
    const clean = {
        endpoint: (config.endpoint || '').trim().replace(/\/+$/, ''),
        region: (config.region || '').trim() || 'us-east-1',
        bucket: (config.bucket || '').trim(),
        accessKeyId: (config.accessKeyId || '').trim(),
        secretAccessKey: (config.secretAccessKey || '').trim(),
        prefix: (config.prefix || '').trim().replace(/^\/+|\/+$/g, ''),
        pathStyle: Boolean(config.pathStyle)
    };
    if (clean.endpoint && !/^https?:\/\//i.test(clean.endpoint)) clean.endpoint = `https://${clean.endpoint}`;
    // Providers show the bucket URL (endpoint/bucket); the bucket is added when signing, so drop it here
    if (clean.bucket) clean.endpoint = clean.endpoint.replace(new RegExp(`/${clean.bucket.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), '');
    if (!clean.bucket || !clean.accessKeyId || !clean.secretAccessKey) {
        throw new Error('Enter a bucket, an access key ID and a secret access key.');
    }
    localStorage.setItem(CONFIG_KEY, JSON.stringify(clean));
    return clean;
}

export function clearS3Config() {
    try { localStorage.removeItem(CONFIG_KEY); } catch (_) {}
}

/** True in the native app, where requests bypass CORS. */
export const hasNativeHttp = () => typeof window !== 'undefined' && typeof window.__TAURI__?.http?.fetch === 'function';

/** CORS rules a bucket needs for this origin, in the JSON array form that S3 and R2 accept. */
export const s3CorsRules = (origin = window.location.origin) => JSON.stringify([{
    AllowedOrigins: [origin],
    AllowedMethods: ['GET', 'PUT', 'DELETE', 'HEAD'],
    AllowedHeaders: ['*'],
    ExposeHeaders: ['ETag'],
    MaxAgeSeconds: 3600
}], null, 2);

// --- signing ---

function buildUrl(config, key, query) {
    const base = new URL(config.endpoint || `https://s3.${config.region}.amazonaws.com`);
    // Without a custom endpoint AWS wants virtual-hosted style; custom endpoints default to path style
    const virtual = !config.pathStyle && !config.endpoint;
    const bucketPath = virtual ? '' : `/${encodeRfc3986(config.bucket)}`;
    if (virtual) base.hostname = `${config.bucket}.${base.hostname}`;
    const basePath = base.pathname.replace(/\/+$/, '');
    const path = `${basePath}${bucketPath}${key ? `/${encodeKey(key)}` : '/'}`;
    const params = Object.entries(query || {}).sort(([a], [b]) => (a < b ? -1 : 1));
    const queryString = params.map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(String(v))}`).join('&');
    return { url: `${base.origin}${path}${queryString ? `?${queryString}` : ''}`, host: base.host, path, queryString };
}

async function signedFetch(config, method, key, { query, body, headers = {} } = {}) {
    const { url, host, path, queryString } = buildUrl(config, key, query);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const date = amzDate.slice(0, 8);
    const payloadHash = body ? await sha256Hex(body) : EMPTY_SHA256;

    const signed = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
    const signedNames = Object.keys(signed).sort();
    const canonicalHeaders = signedNames.map(n => `${n}:${signed[n]}\n`).join('');
    const canonicalRequest = [method, path, queryString, canonicalHeaders, signedNames.join(';'), payloadHash].join('\n');

    const scope = `${date}/${config.region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');
    let signingKey = encoder.encode(`AWS4${config.secretAccessKey}`);
    for (const part of [date, config.region, 's3', 'aws4_request']) signingKey = await hmac(signingKey, part);
    const signature = hex(await hmac(signingKey, stringToSign));

    return (hasNativeHttp() ? window.__TAURI__.http.fetch : fetch)(url, {
        method,
        body,
        headers: {
            ...headers,
            'x-amz-content-sha256': payloadHash,
            'x-amz-date': amzDate,
            Authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedNames.join(';')}, Signature=${signature}`
        }
    });
}

async function failure(res, action) {
    let detail = '';
    try {
        const doc = new DOMParser().parseFromString(await res.text(), 'application/xml');
        detail = doc.querySelector('Message')?.textContent || doc.querySelector('Code')?.textContent || '';
    } catch (_) {}
    return new Error(`${action} failed (${res.status})${detail ? `: ${detail}` : ''}`);
}

/** Wraps fetch's opaque network error, which for a bucket without CORS rules is the usual cause. */
async function request(config, method, key, options) {
    try {
        return await signedFetch(config, method, key, options);
    } catch (err) {
        throw new Error(hasNativeHttp()
            ? 'Could not reach the bucket. Check the endpoint.'
            : 'Could not reach the bucket. Check the endpoint and that the bucket allows this origin in its CORS rules.');
    }
}

// --- operations ---

/** Lists objects under `prefix`. With `delimiter` set, also returns the sub-"folders". Follows pagination. */
export async function s3List(config, prefix = '', { delimiter = '' } = {}) {
    const objects = [];
    const folders = [];
    let token = null;
    do {
        const query = { 'list-type': 2, prefix };
        if (delimiter) query.delimiter = delimiter;
        if (token) query['continuation-token'] = token;
        const res = await request(config, 'GET', '', { query });
        if (!res.ok) throw await failure(res, 'Listing the bucket');
        const doc = new DOMParser().parseFromString(await res.text(), 'application/xml');
        for (const node of doc.getElementsByTagName('Contents')) {
            const text = (tag) => node.getElementsByTagName(tag)[0]?.textContent || '';
            objects.push({ key: text('Key'), size: Number(text('Size')) || 0, modifiedTime: text('LastModified') });
        }
        for (const node of doc.getElementsByTagName('CommonPrefixes')) {
            folders.push(node.getElementsByTagName('Prefix')[0]?.textContent || '');
        }
        token = doc.getElementsByTagName('IsTruncated')[0]?.textContent === 'true'
            ? doc.getElementsByTagName('NextContinuationToken')[0]?.textContent || null
            : null;
    } while (token);
    return { objects, folders };
}

export async function s3Get(config, key) {
    const res = await request(config, 'GET', key);
    if (!res.ok) throw await failure(res, `Downloading ${key.split('/').pop()}`);
    return res;
}

export async function s3Put(config, key, body, contentType = 'application/octet-stream') {
    const res = await request(config, 'PUT', key, { body, headers: { 'Content-Type': contentType } });
    if (!res.ok) throw await failure(res, `Uploading ${key.split('/').pop()}`);
}

export async function s3Delete(config, key) {
    const res = await request(config, 'DELETE', key);
    // 404 means it is already gone, which is the outcome we wanted
    if (!res.ok && res.status !== 404) throw await failure(res, `Deleting ${key.split('/').pop()}`);
}

/** Resolves when the credentials and bucket work, throws with the reason otherwise. */
export async function s3Check(config) {
    const res = await request(config, 'GET', '', { query: { 'list-type': 2, 'max-keys': 1, prefix: config.prefix ? `${config.prefix}/` : '' } });
    if (!res.ok) throw await failure(res, 'Connecting to the bucket');
}

/** Key prefix (with trailing slash, or empty) that holds everything MajesticTab writes. */
export const s3BasePrefix = (config) => (config.prefix ? `${config.prefix}/` : '');
