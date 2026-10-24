// updater.js - checks GitHub Releases for newer native builds (Tauri only)
const REPO = 'cgarst/MajesticTab';
const CHANNEL_KEY = 'updateChannel';
const LAST_CHECK_KEY = 'updateLastCheck';
const DISMISSED_KEY = 'updateDismissed';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CHANNELS = ['none', 'nightly', 'stable'];
let defaultChannel = 'stable';

export function getUpdateChannel() {
    const saved = localStorage.getItem(CHANNEL_KEY);
    return CHANNELS.includes(saved) ? saved : defaultChannel;
}

function parseVersion(tag) {
    const match = /(\d+)\.(\d+)\.(\d+)/.exec(tag || '');
    return match ? match.slice(1).map(Number) : null;
}

function isNewerVersion(candidate, current) {
    const a = parseVersion(candidate);
    const b = parseVersion(current);
    if (!a || !b) return false;
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] > b[i];
    }
    return false;
}

function platformAssetPattern() {
    const ua = navigator.userAgent;
    if (/android/i.test(ua)) return /\.apk$/i;
    if (/Win/i.test(navigator.platform)) return /\.exe$/i;
    if (/Mac/i.test(navigator.platform)) return /\.dmg$/i;
    return /\.flatpak$/i;
}

async function fetchRelease(channel) {
    const path = channel === 'nightly' ? 'releases/tags/nightly' : 'releases/latest';
    const response = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
        headers: { Accept: 'application/vnd.github+json' },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    return response.json();
}

// Returns { label, url } when a newer build exists on the selected channel, otherwise null.
export async function checkForUpdate(buildInfo, channel = getUpdateChannel()) {
    if (channel === 'none') return null;
    const release = await fetchRelease(channel);
    if (!release) return null;

    let label;
    if (channel === 'nightly') {
        // Nightly releases are named "Nightly <buildId>".
        const id = (release.name || '').replace(/^Nightly\s+/i, '').trim();
        if (!id || id === buildInfo.buildId) return null;
        if (buildInfo.channel === 'dev') {
            // Local builds have no nightly id: compare the release time to the build's commit time instead.
            if (!buildInfo.commit || !buildInfo.commitDate) return null;
            if (id.endsWith(buildInfo.commit)) return null;
            if (!(Date.parse(release.published_at) > Date.parse(buildInfo.commitDate))) return null;
        }
        label = `Nightly ${id}`;
    } else {
        if (!isNewerVersion(release.tag_name, buildInfo.version)) return null;
        label = release.tag_name;
    }
    const pattern = platformAssetPattern();
    const matches = (release.assets || []).filter((a) => pattern.test(a.name));
    // Tauri names Intel macOS bundles "x64" and Apple Silicon ones "aarch64".
    const archPattern = buildInfo.arch === 'x86_64' ? /x64|x86_64/i : buildInfo.arch === 'aarch64' ? /aarch64|arm64/i : null;
    const asset = (archPattern && matches.find((a) => archPattern.test(a.name))) || matches[0];
    return { label, url: asset?.browser_download_url || release.html_url, releaseUrl: release.html_url };
}

async function openExternal(url) {
    const opener = window.__TAURI__?.opener;
    if (opener?.openUrl) await opener.openUrl(url);
    else window.open(url, '_blank', 'noopener');
}

// 'native' (Tauri updater replaces the app and relaunches), 'android' (download the APK and open the
// system installer) or 'manual' (open the download page).
let installModePromise;
function getInstallMode() {
    installModePromise ??= (async () => {
        if (window.AndroidUpdater) return 'android';
        try {
            return await window.__TAURI__.core.invoke('update_install_mode');
        } catch {
            return 'manual';
        }
    })();
    return installModePromise;
}

async function installNatively(update, button, status) {
    const setLabel = (label) => {
        button.textContent = label;
        if (status) status.textContent = label;
    };
    button.disabled = true;
    setLabel('Downloading...');
    let unlisten;
    try {
        unlisten = await window.__TAURI__.event.listen('update-progress', ({ payload }) => {
            if (payload.total) setLabel(`Downloading ${Math.min(100, Math.round((payload.downloaded / payload.total) * 100))}%`);
        });
        // Resolves only if the app fails to restart; on success the process is replaced.
        await window.__TAURI__.core.invoke('install_update', { channel: getUpdateChannel() });
    } catch (error) {
        console.warn('[Updater] In-app install failed:', error);
        button.disabled = false;
        button.textContent = 'Download';
        if (status) status.textContent = 'Could not install automatically. Opening the download page.';
        openExternal(update.url);
    } finally {
        unlisten?.();
    }
}

function installOnAndroid(update, button, status) {
    // Only a direct APK asset can be installed; a release page URL means no APK was attached.
    if (!/\.apk$/i.test(update.url)) {
        openExternal(update.url);
        return;
    }
    const setLabel = (label) => {
        button.textContent = label;
        if (status) status.textContent = label;
    };
    button.disabled = true;
    setLabel('Downloading...');
    window.__onAndroidUpdate = (state, percent) => {
        if (state === 'downloading') {
            setLabel(`Downloading ${percent}%`);
        } else if (state === 'installing') {
            button.disabled = false;
            button.textContent = 'Install';
            if (status) status.textContent = 'Confirm the install when Android asks.';
        } else if (state === 'permission') {
            button.disabled = false;
            button.textContent = 'Install';
            if (status) status.textContent = 'Allow installs from MajesticTab in Settings, then tap Install again.';
        } else {
            button.disabled = false;
            button.textContent = 'Download';
            if (status) status.textContent = 'Could not install automatically. Opening the download page.';
            openExternal(update.url);
        }
    };
    window.AndroidUpdater.install(update.url);
}

async function showUpdateBanner(update) {
    const banner = document.getElementById('updateBanner');
    const text = document.getElementById('updateBannerText');
    if (!banner || !text) return;
    text.textContent = update.label;
    banner.hidden = false;
    const button = document.getElementById('updateDownloadBtn');
    const status = document.getElementById('updateStatus');
    const mode = await getInstallMode();
    button.disabled = false;
    button.textContent = mode === 'native' ? 'Install and Restart' : mode === 'android' ? 'Install' : 'Download';
    button.onclick = () => {
        if (mode === 'native') installNatively(update, button, status);
        else if (mode === 'android') installOnAndroid(update, button, status);
        else openExternal(update.url);
    };
    document.getElementById('updateDismissBtn').onclick = () => {
        localStorage.setItem(DISMISSED_KEY, update.label);
        banner.hidden = true;
    };
}

async function runCheck(buildInfo, { manual }) {
    const status = document.getElementById('updateStatus');
    const banner = document.getElementById('updateBanner');
    if (manual && status) status.textContent = 'Checking...';
    try {
        const update = await checkForUpdate(buildInfo);
        localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
        if (update && (manual || localStorage.getItem(DISMISSED_KEY) !== update.label)) {
            showUpdateBanner(update);
            if (status) status.textContent = `Update available: ${update.label}`;
        } else {
            if (banner) banner.hidden = true;
            if (status) status.textContent = getUpdateChannel() === 'none' ? 'Updates are off.' : 'You are up to date.';
        }
    } catch (error) {
        console.warn('[Updater] Check failed:', error);
        if (manual && status) status.textContent = 'Could not check for updates.';
    }
}

export async function initUpdater() {
    if (!window.__TAURI__) return;
    let buildInfo;
    try {
        buildInfo = (await import('./build-info.js')).default;
    } catch {
        return;
    }

    // Nightly builds follow nightly until the user picks otherwise.
    if (buildInfo.channel === 'nightly') defaultChannel = 'nightly';

    const section = document.getElementById('updateSettingsCard');
    if (section) section.hidden = false;
    const version = document.getElementById('updateCurrentVersion');
    if (version) {
        version.textContent = buildInfo.channel === 'nightly'
            ? `Version ${buildInfo.version} (nightly ${buildInfo.buildId})`
            : buildInfo.channel === 'dev' && buildInfo.commit
                ? `Version ${buildInfo.version} (local ${buildInfo.commit})`
                : `Version ${buildInfo.version}`;
    }

    const channel = getUpdateChannel();
    document.querySelectorAll('input[name="updateChannelRadio"]').forEach((radio) => {
        radio.checked = radio.value === channel;
        radio.addEventListener('change', () => {
            if (!radio.checked) return;
            localStorage.setItem(CHANNEL_KEY, radio.value);
            localStorage.removeItem(DISMISSED_KEY);
            runCheck(buildInfo, { manual: true });
        });
    });
    document.getElementById('updateCheckBtn')?.addEventListener('click', () => runCheck(buildInfo, { manual: true }));

    const last = Number(localStorage.getItem(LAST_CHECK_KEY)) || 0;
    if (getUpdateChannel() !== 'none' && Date.now() - last > CHECK_INTERVAL_MS) {
        runCheck(buildInfo, { manual: false });
    }
}
