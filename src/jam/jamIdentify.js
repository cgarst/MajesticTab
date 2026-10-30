/** Makes this device obvious when the host taps Identify: screen flash, vibration and a short beep. */

let ctx = null;

function beep() {
    try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        ctx = ctx || new Ctx();
        ctx.resume?.();
        [0, 0.28].forEach((offset) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.frequency.value = 880;
            const t = ctx.currentTime + offset;
            gain.gain.setValueAtTime(0.0001, t);
            gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
            osc.connect(gain).connect(ctx.destination);
            osc.start(t);
            osc.stop(t + 0.22);
        });
    } catch (_) {}
}

export function runIdentify() {
    let flash = document.getElementById('jamIdentifyFlash');
    if (!flash) {
        flash = document.createElement('div');
        flash.id = 'jamIdentifyFlash';
        flash.className = 'jam-identify-flash';
        flash.setAttribute('aria-hidden', 'true');
        flash.innerHTML = '<div class="jam-identify-label"><i class="bi-broadcast"></i> The host is finding you</div>';
        document.body.appendChild(flash);
    }
    // Restart the animation if Identify is tapped again while it is still running.
    flash.classList.remove('show');
    void flash.offsetWidth;
    flash.classList.add('show');
    clearTimeout(runIdentify.timer);
    runIdentify.timer = setTimeout(() => flash.classList.remove('show'), 2400);
    try { navigator.vibrate?.([200, 100, 200, 100, 200]); } catch (_) {}
    beep();
}
