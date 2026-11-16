// tests/storage/fakeS3Server.mjs
// A small S3-compatible HTTP server for the adapter tests: list-type 2 with pagination, GET (with Range), HEAD, PUT and
// DELETE, with If-Match / If-None-Match like AWS S3 and R2. It does not check signatures, only that one is present.
import http from 'node:http';
import crypto from 'node:crypto';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function startFakeS3({ bucket = 'bkt', pageSize = 2, conditional = true } = {}) {
    const objects = new Map(); // key -> { bytes, etag, modified }
    const log = [];
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://x');
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = Buffer.concat(chunks);
        log.push(`${req.method} ${url.pathname}${url.search}`);
        if (!/^AWS4-HMAC-SHA256 /.test(req.headers.authorization || '')) { res.writeHead(403).end('<Error><Code>AccessDenied</Code></Error>'); return; }
        const parts = decodeURIComponent(url.pathname).split('/').filter(Boolean);
        if (parts[0] !== bucket) { res.writeHead(404).end('<Error><Code>NoSuchBucket</Code></Error>'); return; }
        const key = parts.slice(1).join('/');
        if (!key && req.method === 'GET') {
            const prefix = url.searchParams.get('prefix') || '';
            const max = Math.min(Number(url.searchParams.get('max-keys')) || pageSize, pageSize);
            const after = url.searchParams.get('continuation-token') || '';
            const keys = [...objects.keys()].filter((k) => k.startsWith(prefix) && k > after).sort();
            const page = keys.slice(0, max);
            const more = keys.length > page.length;
            const xml = `<?xml version="1.0"?><ListBucketResult><IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${esc(page[page.length - 1])}</NextContinuationToken>` : ''}${page.map((k) => {
                const o = objects.get(k);
                return `<Contents><Key>${esc(k)}</Key><LastModified>${o.modified.toISOString()}</LastModified><ETag>&quot;${o.etag}&quot;</ETag><Size>${o.bytes.length}</Size></Contents>`;
            }).join('')}</ListBucketResult>`;
            res.writeHead(200, { 'Content-Type': 'application/xml' }).end(xml);
            return;
        }
        const obj = objects.get(key);
        const quoted = (o) => `"${o.etag}"`;
        if (req.method === 'PUT') {
            const inm = req.headers['if-none-match'];
            const im = req.headers['if-match'];
            if ((inm || im) && !conditional) { res.writeHead(501).end('<Error><Code>NotImplemented</Code><Message>no conditional writes</Message></Error>'); return; }
            if (inm === '*' && obj) { res.writeHead(412).end('<Error><Code>PreconditionFailed</Code></Error>'); return; }
            if (im && (!obj || quoted(obj) !== im)) { res.writeHead(412).end('<Error><Code>PreconditionFailed</Code></Error>'); return; }
            const etag = crypto.createHash('md5').update(body).digest('hex');
            objects.set(key, { bytes: body, etag, modified: new Date() });
            res.writeHead(200, { ETag: `"${etag}"` }).end();
            return;
        }
        if (!obj) { res.writeHead(404).end(req.method === 'HEAD' ? undefined : '<Error><Code>NoSuchKey</Code></Error>'); return; }
        if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204).end(); return; }
        const headers = { ETag: quoted(obj), 'Last-Modified': obj.modified.toUTCString(), 'Accept-Ranges': 'bytes' };
        if (req.method === 'HEAD') { res.writeHead(200, { ...headers, 'Content-Length': obj.bytes.length }).end(); return; }
        const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
        if (range) {
            const start = Number(range[1]);
            const end = range[2] === '' ? obj.bytes.length - 1 : Math.min(Number(range[2]), obj.bytes.length - 1);
            if (start >= obj.bytes.length) { res.writeHead(416).end('<Error><Code>InvalidRange</Code></Error>'); return; }
            res.writeHead(206, headers).end(obj.bytes.subarray(start, end + 1));
            return;
        }
        res.writeHead(200, headers).end(obj.bytes);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { endpoint: `http://127.0.0.1:${server.address().port}`, bucket, objects, log, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
