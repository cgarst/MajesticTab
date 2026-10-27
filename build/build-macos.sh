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

# Embed the updater public key so this local build can verify signed in-app updates from GitHub
# releases. Precedence: existing env var, then ~/.tauri/majestictab-updater.key.pub, then the
# project's public key (public by design; the private key stays in the TAURI_SIGNING_PRIVATE_KEY secret).
if [ -z "${TAURI_UPDATER_PUBKEY:-}" ]; then
    PUBKEY_FILE="$HOME/.tauri/majestictab-updater.key.pub"
    if [ -f "$PUBKEY_FILE" ]; then
        TAURI_UPDATER_PUBKEY="$(tr -d '\n' < "$PUBKEY_FILE")"
    else
        TAURI_UPDATER_PUBKEY="dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEVDRUZEMURFMUExRTI4MzUKUldRMUtCNGEzdEh2N0hhVmg3UXVEYzY5ZGNyWlBvc3pHempXR2djQWdYN1JUSmd3TEt0K2QvVzQK"
    fi
fi
export TAURI_UPDATER_PUBKEY

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
    APP_NAME="MajesticTab"
    # The binary is lowercase ("majestictab"), so match on the bundle path instead of the process name
    APP_PROC_PATTERN="/${APP_NAME}.app/Contents/MacOS/"
    if pgrep -f "$APP_PROC_PATTERN" >/dev/null; then
        echo "Closing ${APP_NAME}..."
        osascript -e "tell application \"${APP_NAME}\" to quit" 2>/dev/null || true
        for _ in $(seq 1 20); do
            pgrep -f "$APP_PROC_PATTERN" >/dev/null || break
            sleep 0.5
        done
        pkill -f "$APP_PROC_PATTERN" 2>/dev/null || true
    fi

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
