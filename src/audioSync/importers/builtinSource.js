// importers/builtinSource.js
// Reads point lists from pages whose path starts with /a/wsa/.

import { detectSets } from './detect.js';

const MAX_REVISIONS = 4;
const hasSets = (text) => { try { return detectSets(text).length > 0; } catch { return false; } };

const SONG_ID = /(?:-|\/)s(\d+)(?=\/|$)/;

export const builtinSource = {
    matches(url) {
        try { const u = new URL(url); return u.pathname.startsWith('/a/wsa/') && SONG_ID.test(u.pathname); } catch { return false; }
    },
    step(url, responses) {
        const u = new URL(url);
        const song = SONG_ID.exec(u.pathname)[1];
        const revisions = [...u.pathname.matchAll(/(?:\/|\.\.\.)r(\d+)/g)].map(m => m[1]);
        const revision = revisions.length ? revisions[revisions.length - 1] : null;
        if (revision) {
            if (!responses.length) return { fetch: [`${u.origin}/api/video-points/${song}/${revision}/list`] };
            return { text: responses[0] };
        }
        if (!responses.length) return { fetch: [`${u.origin}/api/meta/${song}/revisions`] };
        let list;
        try { list = JSON.parse(responses[0]); } catch { list = null; }
        // Newest first, whatever the order served: the points are often only on an older version of the tab
        const ids = (Array.isArray(list) ? list : [])
            .map(r => String(r?.revisionId ?? '')).filter(Boolean)
            .sort((a, b) => Number(b) - Number(a)).slice(0, MAX_REVISIONS);
        if (!ids.length) throw new Error('Could not find the latest revision of that song.');
        for (let k = 0; k < ids.length; k++) {
            if (responses.length === 1 + k) return { fetch: [`${u.origin}/api/video-points/${song}/${ids[k]}/list`] };
            if (hasSets(responses[1 + k])) return { text: responses[1 + k] };
        }
        throw new Error('No sync points have been added to this tab (or its recent versions) yet.');
    }
};
