#!/bin/bash
# Serves the web app for local development.
#
#   ./run_web.sh          serve the repo on http://localhost:8000/src/
#   ./run_web.sh 9000     use another port
#
# Sends CORS and no-store headers. Converters (extensions) run in a sandboxed iframe with an opaque origin that loads
# frame.js with crossorigin="anonymous", so a plain `python3 -m http.server` makes every converter fail to load.
# no-store keeps a cached ES module from making new exports look missing.
set -e
cd "$(dirname "$(readlink -f "$0")")"
PORT="${1:-8000}"
echo "Serving $PWD on http://localhost:$PORT/src/"
exec python3 -I - "$PORT" <<'PY'
import http.server, sys

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

http.server.test(HandlerClass=Handler, port=int(sys.argv[1]), bind='::')
PY
