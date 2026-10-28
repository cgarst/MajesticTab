/**
 * What one device sees and hears, from the host's track assignments.
 * A person is Assigned (has tracks), Listening (host marked them, no tracks) or Not set
 * (neither: unrestricted). Pure so it can be unit tested without the player.
 */

export const LISTENING_HEARS = ['all', 'backing'];
export const LISTENING_SEES = ['all', 'backing'];

export const normAudioMode = (m) => (m === 'assigned' || m === 'backing' ? m : 'all');
export const normListening = (v) => (v === 'backing' ? 'backing' : 'all');

/** 'assigned' | 'listening' | 'unset' for one client id (or 'host'). */
export function trackStateFor(state, selfKey) {
    const mine = state?.trackAssignments?.[selfKey];
    if (Array.isArray(mine) && mine.length) return 'assigned';
    return state?.listeners?.includes(selfKey) ? 'listening' : 'unset';
}

/**
 * `mute`: silence these tracks. `audio`: only these tracks are audible.
 * `view`: only show these tracks. `viewHide`: show everything except these tracks.
 */
export function trackPolicyFor(state, selfKey) {
    const kind = trackStateFor(state, selfKey);
    const none = { mute: null, audio: null, view: null, viewHide: null };
    if (kind === 'unset') return none;
    if (kind === 'assigned') {
        const mine = state.trackAssignments[selfKey];
        return {
            ...none,
            mute: state.assignedAudioMode === 'backing' ? mine : null,
            audio: state.assignedAudioMode === 'assigned' ? mine : null,
            view: state.assignedViewOnly ? mine : null
        };
    }
    const taken = [...new Set(Object.values(state.trackAssignments || {}).flat())];
    if (!taken.length) return none;
    return {
        ...none,
        mute: normListening(state.listeningHears) === 'backing' ? taken : null,
        viewHide: normListening(state.listeningSees) === 'backing' ? taken : null
    };
}
