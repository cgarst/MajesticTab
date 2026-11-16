// tests/storage/fakeDriveServer.mjs
// A small Google Drive v3 stand-in for the adapter tests. It implements only what the adapter calls: files.list with the
// query forms it builds, folder create, multipart create, media update, alt=media download with Range, and delete.
// Like the real thing it lets two files share a name, compares `name =` without regard to case, pages its listings,
// and bumps a per-file `version` on every content change.
import http from 'node:http';

export async function startFakeDrive({ pageSize = 2 } = {}) {
    const items = new Map();   // id -> { id, name, mimeType, parents:[id], bytes, version, createdTime, modifiedTime }
    const log = [];
    let n = 0;
    let clock = Date.parse('2026-01-01T00:00:00Z');
    const stamp = () => new Date(clock += 1000).toISOString();
    const meta = (f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, size: f.bytes ? String(f.bytes.length) : undefined, version: String(f.version), modifiedTime: f.modifiedTime, createdTime: f.createdTime });
    const make = (name, mimeType, parents, bytes) => {
        const f = { id: `id${++n}`, name, mimeType, parents, bytes, version: 1, createdTime: stamp(), modifiedTime: '' };
        f.modifiedTime = f.createdTime;
        items.set(f.id, f);
        return f;
    };
    const unq = (s) => s.replace(/\\(['\\])/g, '$1');

    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = Buffer.concat(chunks);
        const url = new URL(req.url, 'http://x');
        log.push(`${req.method} ${url.pathname}`);
        const send = (status, obj, headers = {}) => res.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(obj === undefined ? undefined : JSON.stringify(obj));
        if (!/^Bearer /.test(req.headers.authorization || '')) return send(401, { error: { code: 401 } });
        const path = url.pathname;

        if (req.method === 'GET' && path === '/drive/v3/files') {
            const q = url.searchParams.get('q') || '';
            let list = [...items.values()];
            const parent = /'((?:[^'\\]|\\.)*)' in parents/.exec(q);
            if (parent) list = list.filter((f) => f.parents.includes(unq(parent[1])));
            const name = /name = '((?:[^'\\]|\\.)*)'/.exec(q);
            if (name) list = list.filter((f) => f.name.toLowerCase() === unq(name[1]).toLowerCase());
            if (/trashed = false/.test(q)) list = list.filter((f) => !f.trashed);
            list.sort((a, b) => (a.id.length - b.id.length) || (a.id < b.id ? -1 : 1));
            const size = Math.min(Number(url.searchParams.get('pageSize')) || pageSize, pageSize);
            const from = Number(url.searchParams.get('pageToken')) || 0;
            const page = list.slice(from, from + size);
            return send(200, { files: page.map(meta), ...(from + size < list.length ? { nextPageToken: String(from + size) } : {}) });
        }
        if (req.method === 'POST' && path === '/drive/v3/files') {
            const m = JSON.parse(body.toString());
            if (m.parents?.[0] !== 'root' && !items.has(m.parents?.[0])) return send(404, { error: { code: 404 } });
            return send(200, meta(make(m.name, m.mimeType, m.parents, null)));
        }
        if (req.method === 'POST' && path === '/upload/drive/v3/files') {
            const boundary = /boundary=(.+)$/.exec(req.headers['content-type'])[1];
            const raw = body.toString('latin1');
            const parts = raw.split(`--${boundary}`).slice(1, -1).map((p) => p.replace(/^\r\n/, '').replace(/\r\n$/, ''));
            const split = (p) => { const i = p.indexOf('\r\n\r\n'); return p.slice(i + 4); };
            const m = JSON.parse(Buffer.from(split(parts[0]), 'latin1').toString('utf8'));
            if (m.parents?.[0] !== 'root' && !items.has(m.parents?.[0])) return send(404, { error: { code: 404 } });
            return send(200, meta(make(m.name, 'application/octet-stream', m.parents, Buffer.from(split(parts[1]), 'latin1'))));
        }
        const m = /^\/(upload\/)?drive\/v3\/files\/([^/]+)$/.exec(path);
        const f = m && items.get(m[2]);
        if (!f) return send(404, { error: { code: 404, message: 'File not found' } });
        if (req.method === 'PATCH') {
            f.bytes = body; f.version += 1; f.modifiedTime = stamp();
            return send(200, meta(f));
        }
        if (req.method === 'DELETE') {
            for (const x of [...items.values()]) if (x.id === f.id || (f.mimeType.endsWith('folder') && x.parents.includes(f.id))) items.delete(x.id);
            return res.writeHead(204).end();
        }
        if (req.method === 'GET' && url.searchParams.get('alt') === 'media') {
            const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
            if (range) {
                const start = Number(range[1]);
                const end = range[2] === '' ? f.bytes.length - 1 : Math.min(Number(range[2]), f.bytes.length - 1);
                if (start >= f.bytes.length) return res.writeHead(416).end();
                return res.writeHead(206).end(f.bytes.subarray(start, end + 1));
            }
            return res.writeHead(200).end(f.bytes);
        }
        return send(400, { error: { code: 400 } });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    return {
        items, log, make,
        // the adapter calls the real Google hosts; the test rewrites them to this server
        fetch: (url, options = {}) => fetch(url.replace('https://www.googleapis.com', base), { ...options, headers: { ...(options.headers || {}), Authorization: 'Bearer t' } }),
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
    };
}
