// Remove sticky players
document.querySelectorAll('.is_sticky_player, [class*="is_sticky_player"], [class*="sticky_player"], #pro-player-scroll-container, [id*="pro-player"]').forEach(player => {
    try {
        const container = player.closest('.is_sticky_player') || player.closest('[class*="sticky_player"]') || player;
        container.remove();
    } catch(e) {}
});

// Hide Official tab rows
document.querySelectorAll('a[href*="/pro/"], a[href*="/pro?"], a[href*="/tab/official/"], a[href*="marketing_type=official"], div, span').forEach(el => {
    let isOfficial = false;
    if (el.tagName === 'A') {
        isOfficial = true;
    } else if (el.children.length === 0) {
        const text = el.textContent.trim().toLowerCase();
        if (text === 'official' || text === 'official tab') {
            isOfficial = true;
        }
    }

    if (isOfficial) {
        let cur = el.parentElement;
        while (cur && cur !== document.body && cur !== document.documentElement) {
            const tag = cur.tagName.toLowerCase();
            if (tag === 'article' || tag === 'main' || tag === 'section' || tag === 'header' || tag === 'nav') break;
            const tabLinks = cur.querySelectorAll('a[href*="/tab/"], a[href*="/pro/"]');
            if (tabLinks.length > 3) break;

            if (tag === 'tr' || cur.nextElementSibling || cur.previousElementSibling) {
                if (tabLinks.length >= 1 && tabLinks.length <= 3) {
                    const artistLink = cur.querySelector('a[href*="/artist/"]');
                    if (artistLink && cur.nextElementSibling) {
                        const nextRowFirstCell = cur.nextElementSibling.firstElementChild;
                        if (nextRowFirstCell && !nextRowFirstCell.querySelector('a[href*="/artist/"]')) {
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
});
