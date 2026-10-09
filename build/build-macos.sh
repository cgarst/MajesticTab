#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

ARGS=()
for arg in "$@"; do
    if [ "$arg" = "--debug" ]; then
        ARGS+=("--debug-tools")
    else
        ARGS+=("$arg")
    fi
done

# Run macOS Tauri build
node "$ROOT_DIR/build/build-tauri.mjs" macos "${ARGS[@]+"${ARGS[@]}"}"

# Find the generated DMG in dist/
DMG_PATH=$(find "$ROOT_DIR/dist" -maxdepth 1 -name "MajesticTab*.dmg" ! -name "rw.*" -print | sort | tail -n 1)

if [ -z "$DMG_PATH" ] || [ ! -f "$DMG_PATH" ]; then
    echo "Error: No DMG found in $ROOT_DIR/dist" >&2
    exit 1
fi

echo "Mounting $DMG_PATH..."
MOUNT_POINT=$(mktemp -d /tmp/majestictab-dmg.XXXXXX)

hdiutil attach "$DMG_PATH" -mountpoint "$MOUNT_POINT" -nobrowse -readonly -quiet

cleanup() {
    if [ -d "$MOUNT_POINT" ]; then
        echo "Unmounting $MOUNT_POINT..."
        hdiutil detach "$MOUNT_POINT" -force -quiet || true
        rm -rf "$MOUNT_POINT"
    fi
}
trap cleanup EXIT

if [ -d "$MOUNT_POINT/MajesticTab.app" ]; then
    echo "Installing MajesticTab.app to /Applications/..."
    rm -rf /Applications/MajesticTab.app
    cp -R "$MOUNT_POINT/MajesticTab.app" /Applications/
    xattr -cr /Applications/MajesticTab.app
    echo "Successfully installed MajesticTab.app to /Applications/"
else
    echo "Error: MajesticTab.app not found in mounted volume at $MOUNT_POINT" >&2
    exit 1
fi

open /Applications/MajesticTab.app
