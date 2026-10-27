/**
 * Names the host shows for its peers. A host-set alias wins over the name the client sent, and
 * people who would otherwise share a name are numbered in join order. Pure, so it can be unit tested.
 */

export const MAX_ALIAS_LENGTH = 24;

export const cleanAlias = (value) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, MAX_ALIAS_LENGTH);

/** `peers` in join order, `aliases` a Map of peer id -> alias. Adds `originalName`, replaces `name`. */
export function resolveNames(peers, aliases) {
    const base = peers.map((p) => aliases.get(p.id) || p.name || 'Guest');
    const counts = new Map();
    base.forEach((name) => counts.set(name, (counts.get(name) || 0) + 1));
    const seen = new Map();
    return peers.map((p, i) => {
        const name = base[i];
        let shown = name;
        if (counts.get(name) > 1) {
            const n = (seen.get(name) || 0) + 1;
            seen.set(name, n);
            shown = `${name} (${n})`;
        }
        return { ...p, originalName: p.name, name: shown };
    });
}

/**
 * A recognizable default name for a browser guest, from its user agent. iPadOS 13+ sends a Mac user
 * agent, but a Mac with a touch screen is an iPad, so `touchPoints` (navigator.maxTouchPoints) tells them apart.
 */
export function guestNameFromUserAgent(ua, touchPoints = 0) {
    const s = String(ua || '');
    if (/iPhone/.test(s)) return 'iPhone';
    if (/iPad/.test(s)) return 'iPad';
    if (/Android/.test(s)) return /Mobile/.test(s) ? 'Android phone' : 'Android tablet';
    if (/CrOS/.test(s)) return 'Chromebook';
    if (/Windows/.test(s)) return 'Windows PC';
    if (/Macintosh|Mac OS X/.test(s)) return touchPoints > 1 ? 'iPad' : 'Mac';
    if (/Linux/.test(s)) return 'Linux PC';
    return 'Guest';
}
