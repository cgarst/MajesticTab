#!/usr/bin/env bash
# Download the latest MajesticTab canary DMG and install it into /Applications.
# The repo is private, so this needs the GitHub CLI signed in (gh auth login).
set -euo pipefail

command -v gh >/dev/null || { echo "GitHub CLI (gh) is required: brew install gh && gh auth login" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Not signed in to gh. Run: gh auth login" >&2; exit 1; }

REPO="cgarst/MajesticTab"
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
gh release download canary --repo "$REPO" --pattern '*_aarch64.dmg' --dir "$WORK/dl"
DMG="$(find "$WORK/dl" -maxdepth 1 -name '*.dmg' -print -quit)"
[ -n "$DMG" ] || { echo "No aarch64 DMG in canary release" >&2; exit 1; }

echo "Mounting..."
mkdir -p "$MOUNT"
hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$MOUNT" -quiet

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
