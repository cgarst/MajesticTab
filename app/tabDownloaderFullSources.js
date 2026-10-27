// Everything specific to the curated Tab Downloader sources (Ultimate Guitar, Classical Tab) and their userscripts.
// Only imported when the channel's tabDownloader capability is 'full'; Google-only builds drop this file
// (see build/tauri/prepare-tauri-frontend.mjs).

export const UG_DEFAULT_USERSCRIPT = `
// MajesticTab UG Userscript v14-mobile
(function() {
    const isSongPage = window.location.pathname.includes('/tab/');

    // 1. Hide and remove sticky tab player strictly on song pages
    if (isSongPage) {
        const STYLE_ID = 'majestic-ug-custom-style-v14';
        if (!document.getElementById(STYLE_ID)) {
            const style = document.createElement('style');
            style.id = STYLE_ID;
            style.textContent = \`
                /* Hide the sticky tab player on Guitar Pro song pages */
                .is_sticky_player,
                [class*="is_sticky_player"],
                [class*="sticky_player"],
                #pro-player-scroll-container,
                [id*="pro-player"],
                [class*="BottomControls-fixed"],
                /* Mobile layout: inline notation canvas (tuning row and download button stay) */
                [class*="styles-containerWrapper"] {
                    display: none !important;
                }
            \`;
            (document.head || document.documentElement).appendChild(style);
        }

        document.querySelectorAll('.is_sticky_player, [class*="is_sticky_player"], [class*="sticky_player"], #pro-player-scroll-container, [id*="pro-player"], [class*="BottomControls-fixed"]').forEach(el => {
            try {
                const container = el.closest('.is_sticky_player') || el.closest('[class*="sticky_player"]') || el;
                container.remove();
            } catch(e) {}
        });
    }

    // 2. Hide "Official" tabs in search results and listings
    function hideOfficialTabRow(el) {
        let cur = el.parentElement;
        while (cur && cur !== document.body && cur !== document.documentElement) {
            const tag = cur.tagName.toLowerCase();
            if (tag === 'article' || tag === 'main' || tag === 'section' || tag === 'header' || tag === 'nav') break;
            const tabLinks = cur.querySelectorAll('a[href*="/tab/"], a[href*="/pro/"]');
            if (tabLinks.length > 3) break;

            const isRowLike = tag === 'tr' || cur.getAttribute('role') === 'row' || /\\b(row|entry|item)\\b/i.test(cur.className || '');
            if (isRowLike) {
                if (tabLinks.length >= 1 && tabLinks.length <= 3) {
                    if (cur.dataset && cur.dataset.majesticHidden === 'true') break;
                    if (cur.dataset) cur.dataset.majesticHidden = 'true';

                    const artistLink = cur.querySelector('a[href*="/artist/"]');
                    if (artistLink && cur.nextElementSibling) {
                        const nextRowFirstCell = cur.nextElementSibling.firstElementChild;
                        if (nextRowFirstCell && !nextRowFirstCell.dataset?.majesticArtistAdded && !nextRowFirstCell.querySelector('a[href*="/artist/"]')) {
                            if (nextRowFirstCell.dataset) nextRowFirstCell.dataset.majesticArtistAdded = 'true';
                            nextRowFirstCell.innerHTML = artistLink.outerHTML;
                        }
                    }
                    cur.style.setProperty('display', 'none', 'important');
                    break;
                }
            }
            cur = cur.parentElement;
        }
    }

    // Mobile layout (ugm-*): official rows link to the app store via .js-search-pro-link
    function hideMobileOfficialRows() {
        document.querySelectorAll('article.ugm-list--link').forEach(row => {
            if (row.dataset.majesticHidden === 'true' || !row.querySelector('a.js-search-pro-link')) return;
            row.dataset.majesticHidden = 'true';
            row.style.setProperty('display', 'none', 'important');
        });
    }
    if (document.querySelector('article.ugm-list--link')) {
        hideMobileOfficialRows();
        if (!window.__majesticUgMobileObserver) {
            let pending = false;
            window.__majesticUgMobileObserver = new MutationObserver(() => {
                if (pending) return;
                pending = true;
                setTimeout(() => { pending = false; hideMobileOfficialRows(); }, 150);
            });
            window.__majesticUgMobileObserver.observe(document.body, { childList: true, subtree: true });
        }
    }

    // Hide by link pattern
    document.querySelectorAll('a[href*="/pro/"], a[href*="/pro?"], a[href*="/tab/official/"], a[href*="marketing_type=official"]').forEach(hideOfficialTabRow);

    // Hide by "Official" label / badge text (targeted lookup, avoids full DOM scan)
    const candidates = document.querySelectorAll('tr span, tr div, [role="row"] span, [role="row"] div, [class*="badge"], [class*="tag"], [class*="type"], [class*="version"], [class*="label"]');
    for (let i = 0; i < candidates.length; i++) {
        const el = candidates[i];
        if (el.dataset && el.dataset.majesticChecked) continue;
        if (el.dataset) el.dataset.majesticChecked = '1';
        if (el.children.length === 0) {
            const text = el.textContent.trim().toLowerCase();
            if (text === 'official' || text === 'official tab') {
                hideOfficialTabRow(el);
            }
        }
    }
})();
`;

/** Seed sources listed after Google in the full Tab Downloader. */
export const EXTRA_SEED_SOURCES = [
    {
        id: 'ug',
        name: 'Ultimate Guitar',
        urlTemplate: 'https://www.ultimate-guitar.com/search.php?title=$s',
        defaultUrl: 'https://www.ultimate-guitar.com/search.php?title=$s',
        queryFormat: 'artist_song',
        userscriptEnabled: true,
        userscript: UG_DEFAULT_USERSCRIPT,
        defaultUserscript: UG_DEFAULT_USERSCRIPT,
        isSeed: true
    },
    {
        id: 'classtab',
        name: 'Classical Tab',
        urlTemplate: 'https://www.google.com/search?q=$s&sitesearch=https%3A%2F%2Fwww.classtab.org',
        defaultUrl: 'https://www.classtab.org/',
        queryFormat: 'artist_song',
        userscriptEnabled: false,
        userscript: '',
        defaultUserscript: '',
        isSeed: true
    }
];

/** Home page for a seed source when there is no search term. */
export const SOURCE_HOME_URLS = {
    ug: 'https://www.ultimate-guitar.com/',
    classtab: 'https://www.classtab.org/'
};

/** Used when no source is selected or a source has no usable URL. */
export const FALLBACK_HOME_URL = 'https://www.ultimate-guitar.com/';

/** Template for a new custom source. */
export const NEW_SOURCE_URL_TEMPLATE = 'https://www.ultimate-guitar.com/search.php?title=$s';

/** Seed source id for a page the downloader navigated to, or null. */
export function matchSeedSourceId(host, url) {
    if (host.includes('ultimate-guitar.com')) return 'ug';
    if (host.includes('classtab.org') || (host.includes('google.') && url.includes('classtab.org'))) return 'classtab';
    return null;
}
