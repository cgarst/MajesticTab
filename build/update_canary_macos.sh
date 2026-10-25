#!/usr/bin/env bash
# Download the latest MajesticTab canary DMG and install it into /Applications.
set -euo pipefail

URL="https://github.com/cgarst/MajesticTab/releases/download/canary/MajesticTab_1.0.0_aarch64.dmg"
APP_NAME="MajesticTab"
DEST="/Applications/${APP_NAME}.app"

WORK="$(mktemp -d)"
MOUNT="$WORK/mnt"
cleanup() {
  hdiutil detach "$MOUNT" -quiet 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "Closing ${APP_NAME}..."
if pgrep -x "$APP_NAME" >/dev/null; then
  osascript -e "tell application \"${APP_NAME}\" to quit" 2>/dev/null || true
  for _ in $(seq 1 20); do
    pgrep -x "$APP_NAME" >/dev/null || break
    sleep 0.5
  done
  pkill -x "$APP_NAME" 2>/dev/null || true
fi

echo "Downloading canary DMG..."
curl -fL --progress-bar -o "$WORK/$APP_NAME.dmg" "$URL"

echo "Mounting..."
mkdir -p "$MOUNT"
hdiutil attach "$WORK/$APP_NAME.dmg" -nobrowse -readonly -mountpoint "$MOUNT" -quiet

APP_SRC="$(find "$MOUNT" -maxdepth 1 -name '*.app' -print -quit)"
[ -n "$APP_SRC" ] || { echo "No .app found in DMG" >&2; exit 1; }

echo "Installing to ${DEST}..."
STAGING="/Applications/.${APP_NAME}.app.new"
rm -rf "$STAGING"
ditto "$APP_SRC" "$STAGING" || { rm -rf "$STAGING"; exit 1; }
xattr -cr "$STAGING"

# Swap only after the copy succeeded, so a failure keeps the old install.
rm -rf "$DEST"
mv "$STAGING" "$DEST"

echo "Installed ${DEST}"
