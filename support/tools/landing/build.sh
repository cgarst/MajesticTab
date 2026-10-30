#!/bin/sh
# Rebuild the landing page's Tailwind CSS (../../../docs/landing.css). Re-run after changing classes in index.html.
cd "$(dirname "$0")" && npx --yes tailwindcss@3.4.17 -c tailwind.config.js -i input.css -o ../../../docs/landing.css --minify
