// tests/storage/fakeDavServer.mjs
// A small WebDAV server for the adapter tests: PROPFIND (Depth 0 and 1), MKCOL, PUT, GET with Range, DELETE, ETags and
// If-Match / If-None-Match. `caseInsensitive` makes names compare folded, like Windows and Synology shares.
import http from 'node:http';
import crypto from 'node:crypto';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function startFakeDav({ caseInsensitive = false, etags = true, prefix = '/dav' } = {}) {
    const files = new Map();   // key -> { bytes, etag, modified }
    const dirs = new Set(['']);
    const log = [];
    const k = (p) => (caseInsensitive ? p.toLowerCase() : p);
    const parentOf = (p) => p.split('/').slice(0, -1).join('/');
    const find = (map, p) => (map instanceof Set ? [...map] : [...map.keys()]).find((x) => k(x) === k(p));
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = Buffer.concat(chunks);
        const url = new URL(req.url, 'http://x');
        log.push(`${req.method} ${url.pathname}`);
        if (!url.pathname.startsWith(prefix)) { res.writeHead(404).end(); return; }
        const path = decodeURIComponent(url.pathname.slice(prefix.length)).split('/').filter(Boolean).join('/');
        const dirKey = find(dirs, path);
        const fileKey = find(files, path);
        const href = (p, isDir) => `${prefix}/${p.split('/').filter(Boolean).map(encodeURIComponent).join('/')}${isDir ? '/' : ''}`;
        const entry = (p, isDir, f) => `<d:response><d:href>${href(p, isDir)}</d:href><d:propstat><d:prop>${isDir ? '<d:resourcetype><d:collection/></d:resourcetype>' : `<d:resourcetype/><d:getcontentlength>${f.bytes.length}</d:getcontentlength><d:getlastmodified>${f.modified.toUTCString()}</d:getlastmodified>${etags ? `<d:getetag>&quot;${f.etag}&quot;</d:getetag>` : ''}`}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
        switch (req.method) {
        case 'PROPFIND': {
            if (dirKey === undefined && fileKey === undefined) { res.writeHead(404).end(); return; }
            let out = '';
            if (dirKey !== undefined) {
                out += entry(dirKey, true);
                if (req.headers.depth === '1') {
                    for (const d of dirs) if (d && parentOf(d) === dirKey) out += entry(d, true);
                    for (const [fk, f] of files) if (parentOf(fk) === dirKey) out += entry(fk, false, f);
                }
            } else out += entry(fileKey, false, files.get(fileKey));
            res.writeHead(207, { 'Content-Type': 'application/xml' }).end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${out}</d:multistatus>`);
            return;
        }
        case 'MKCOL':
            if (dirKey !== undefined || fileKey !== undefined) { res.writeHead(405).end(); return; }
            if (find(dirs, parentOf(path)) === undefined) { res.writeHead(409).end(); return; }
            dirs.add(path); res.writeHead(201).end(); return;
        case 'PUT': {
            if (dirKey !== undefined) { res.writeHead(405).end(); return; }
            if (find(dirs, parentOf(path)) === undefined) { res.writeHead(409).end(); return; }
            const cur = fileKey === undefined ? undefined : files.get(fileKey);
            const inm = req.headers['if-none-match'];
            const im = req.headers['if-match'];
            if (inm === '*' && cur) { res.writeHead(412).end(); return; }
            if (im && (!cur || `"${cur.etag}"` !== im)) { res.writeHead(412).end(); return; }
            const etag = crypto.createHash('md5').update(body).digest('hex') + (cur ? '' : '');
            files.set(fileKey ?? path, { bytes: body, etag, modified: new Date() });
            res.writeHead(cur ? 204 : 201, etags ? { ETag: `"${etag}"` } : {}).end();
            return;
        }
        case 'GET': {
            if (fileKey === undefined) { res.writeHead(404).end(); return; }
            const f = files.get(fileKey);
            const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
            if (range) {
                const start = Number(range[1]);
                const end = range[2] === '' ? f.bytes.length - 1 : Math.min(Number(range[2]), f.bytes.length - 1);
                if (start >= f.bytes.length) { res.writeHead(416).end(); return; }
                res.writeHead(206).end(f.bytes.subarray(start, end + 1)); return;
            }
            res.writeHead(200).end(f.bytes); return;
        }
        case 'DELETE':
            if (fileKey !== undefined) { files.delete(fileKey); res.writeHead(204).end(); return; }
            if (dirKey !== undefined && dirKey !== '') {
                for (const d of [...dirs]) if (d === dirKey || d.startsWith(`${dirKey}/`)) dirs.delete(d);
                for (const fk of [...files.keys()]) if (fk.startsWith(`${dirKey}/`)) files.delete(fk);
                res.writeHead(204).end(); return;
            }
            res.writeHead(404).end(); return;
        default: res.writeHead(405).end();
        }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}${prefix}`, files, dirs, log, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
