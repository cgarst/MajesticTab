#!/bin/sh
# When running under Gamescope (Steam Deck Gaming Mode), use X11 backend for native 1:1 fullscreen rendering
if [ -n "$GAMESCOPE_WAYLAND_DISPLAY" ] || [ -n "$STEAM_DECK" ]; then
    export GDK_BACKEND=x11
    export GDK_SCALE=1
fi
exec /app/bin/majestictab.bin "$@"
