// practiceSpeed.js
// The Practice menu's plus and minus on a local audio file: one percent a press, within the speeds the player holds.

export const MIN_PERCENT = 25;
export const MAX_PERCENT = 200;

/** The speed one percent below (dir < 0) or above (dir > 0) `rate`, as a multiplier. */
export function nextPercentRate(rate, dir) {
    const pct = Math.round((Number(rate) || 1) * 100);
    const next = Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, pct + (dir < 0 ? -1 : 1)));
    return next / 100;
}
