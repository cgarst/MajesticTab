document.querySelectorAll('div').forEach(div => {
    const text = div.textContent.trim();

    // Target leaf nodes containing just "Official", "Pro", or "Power"
    if (div.children.length === 0 && ['Official', 'Pro', 'Power'].includes(text)) {
        const row = div.parentElement;
        if (row) {
            // Check if this row holds the artist link
            const artistLink = row.querySelector('a[href*="/artist/"]');

            if (artistLink && row.nextElementSibling) {
                // Shift the artist name down to the next row so it isn't lost
                const nextRowFirstCell = row.nextElementSibling.firstElementChild;
                if (nextRowFirstCell && !nextRowFirstCell.querySelector('a[href*="/artist/"]')) {
                    nextRowFirstCell.innerHTML = artistLink.outerHTML;
                }
            }

            // Hide the row entirely (collapses the grid space)
            row.style.display = 'none';
        }
    }
});

// Remove any sticky players
document.querySelectorAll('.is_sticky_player').forEach(player => {
    player.remove();
});
