// Player page loaded by the native macOS and iOS YouTube webviews. It is served with an https
// base URL so YouTube accepts the embed (the app origin tauri://localhost triggers error 153).
pub const PLAYER_HTML: &str = r##"<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="referrer" content="strict-origin-when-cross-origin">
    <style>
        html, body, iframe { width: 100%; height: 100%; margin: 0; border: 0; overflow: hidden; background: #000; }
    </style>
</head>
<body>
    <iframe id="player" title="YouTube player" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>
    <script>
        const player = document.getElementById('player');
        let playerReady = false;
        let pendingMessages = [];

        window.ytLoad = (url) => {
            playerReady = false;
            pendingMessages = [];
            const embedUrl = new URL(url);
            embedUrl.searchParams.set('origin', window.location.origin);
            player.src = embedUrl.href;
        };

        window.ytCommand = (message) => {
            const serialized = typeof message === 'string' ? message : JSON.stringify(message);
            if (playerReady && player.contentWindow) {
                player.contentWindow.postMessage(serialized, '*');
            } else {
                pendingMessages.push(serialized);
            }
        };

        player.addEventListener('load', () => {
            playerReady = true;
            for (const message of pendingMessages.splice(0)) {
                player.contentWindow?.postMessage(message, '*');
            }
            window.ytCommand({ event: 'listening', id: 1 });
            window.ytCommand({ event: 'command', func: 'addEventListener', args: ['onStateChange'] });
        });

        window.addEventListener('message', (event) => {
            let data = event.data;
            if (typeof data === 'string') {
                try { data = JSON.parse(data); } catch { return; }
            }
            if (event.source !== player.contentWindow) return;
            if (data?.event === 'infoDelivery' || data?.event === 'onStateChange') {
                window.postMessage(data, '*');
            }
        });
    </script>
</body>
</html>"##;
