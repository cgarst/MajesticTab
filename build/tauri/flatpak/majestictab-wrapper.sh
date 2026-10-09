#!/bin/sh
# When running under Gamescope (Steam Deck Gaming Mode), ensure native 1:1 pixel scaling
if [ -n "$GAMESCOPE_WAYLAND_DISPLAY" ] || [ -n "$STEAM_DECK" ]; then
    export GDK_SCALE=1
fi
exec /app/bin/majestictab.bin "$@"
