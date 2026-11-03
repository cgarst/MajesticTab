// importers/builtinSource.js
// Reads point lists from pages whose path starts with /a/wsa/.

const SONG_ID = /(?:-|\/)s(\d+)(?=\/|$)/;

export const builtinSource = {
    matches(url) {
        try { const u = new URL(url); return u.pathname.startsWith('/a/wsa/') && SONG_ID.test(u.pathname); } catch { return false; }
    },
    step(url, responses) {
        const u = new URL(url);
        const song = SONG_ID.exec(u.pathname)[1];
        const revisions = [...u.pathname.matchAll(/(?:\/|\.\.\.)r(\d+)/g)].map(m => m[1]);
        let revision = revisions.length ? revisions[revisions.length - 1] : null;
        let used = 0;
        if (!revision) {
            if (responses.length === used) return { fetch: [`${u.origin}/api/meta/${song}/revisions`] };
            let list;
            try { list = JSON.parse(responses[used]); } catch { list = null; }
            revision = String(list?.[0]?.revisionId || '');
            used++;
            if (!revision) throw new Error('Could not find the latest revision of that song.');
        }
        if (responses.length === used) return { fetch: [`${u.origin}/api/video-points/${song}/${revision}/list`] };
        return { text: responses[used] };
    }
};
