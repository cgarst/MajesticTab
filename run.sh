#!/bin/bash
# Runs the desktop app in dev mode (tauri dev).
#
#   ./run.sh                          start the app
#   ./run.sh --restore-backup         also restore the newest .mtbackup in ~/Downloads (MAJESTICTAB_BACKUP_DIR to
#                                     look elsewhere) into the app, adding what it is missing
#   ./run.sh --restore-backup=FILE    restore that file instead
#   ./run.sh --restore-backup --wipe  replace the app's data with the backup's instead of adding to it
# The restore happens once per run, before the library opens; the dev watcher's relaunches don't repeat it.
#
# On immutable systems (SteamOS, Fedora Atomic, Bazzite, other ostree images) the host has no Node, Rust or WebKitGTK
# headers and its root is read-only, so this re-runs itself inside the GNOME SDK Flatpak, the same runtime (and WebKitGTK)
# the Flathub build uses. Everywhere else it runs directly and needs Node, Rust and Tauri's Linux libraries installed.
set -e
cd "$(dirname "$(readlink -f "$0")")"
ROOT="$PWD"

usage() {
  sed -n '2,/^$/p' "$0" | sed -e 's/^# \{0,1\}//' -e '/^$/d' | sed -n '1,/The restore happens/p'
}

RESTORE=""
WIPE=""
for arg in "$@"; do
  case "$arg" in
    --restore-backup) RESTORE=newest ;;
    --restore-backup=*) RESTORE="${arg#*=}" ;;
    --wipe) WIPE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage >&2; exit 2 ;;
  esac
done
if [ -n "$WIPE" ] && [ -z "$RESTORE" ]; then
  echo "--wipe only applies together with --restore-backup." >&2
  exit 2
fi

# Resolve the backup on the host, before any Flatpak re-exec, so the sandbox is given the file and its folder.
# (Inside the Flatpak this script runs again with no options and the resolved values already in the environment.)
if [ -n "$RESTORE" ]; then
  if [ "$RESTORE" = newest ]; then
    BACKUP_DIR="${MAJESTICTAB_BACKUP_DIR:-$HOME/Downloads}"
    RESTORE="$(ls -t "$BACKUP_DIR"/*.mtbackup 2>/dev/null | head -n 1)"
    if [ -z "$RESTORE" ]; then
      echo "No .mtbackup file found in $BACKUP_DIR." >&2
      exit 1
    fi
  fi
  if [ ! -f "$RESTORE" ]; then
    echo "Backup file not found: $RESTORE" >&2
    exit 1
  fi
  RESTORE="$(cd "$(dirname "$RESTORE")" && pwd)/$(basename "$RESTORE")"
  export MAJESTICTAB_RESTORE_BACKUP="$RESTORE"
  export MAJESTICTAB_RESTORE_MODE="$([ -n "$WIPE" ] && echo wipe || echo merge)"
  export MAJESTICTAB_RESTORE_TOKEN="$$-$(date +%s)"
  echo "Will restore $RESTORE ($([ -n "$WIPE" ] && echo 'replacing all data' || echo 'adding what is missing')) when the app starts."
fi

# Debugging hooks for the WebKitGTK webview (override or set to empty to disable):
#  - remote inspector: open inspector://127.0.0.1:9222 in GNOME Web or MiniBrowser (WebKit protocol, not CDP)
#  - GStreamer logging for <audio>/<video> playback issues (underruns, rebuffering)
export WEBKIT_INSPECTOR_SERVER="${WEBKIT_INSPECTOR_SERVER-127.0.0.1:9222}"
export GST_DEBUG="${GST_DEBUG-2,playbin:4,audiobasesink:5}"

is_immutable() {
  [ -e /run/ostree-booted ] && return 0
  grep -qiE '^(ID|ID_LIKE)=.*steamos' /etc/os-release 2>/dev/null
}

if [ ! -e /.flatpak-info ] && [ "$(uname -s)" = Linux ] && is_immutable; then
  RUNTIME=org.gnome.Sdk//51
  if ! flatpak info "$RUNTIME" >/dev/null 2>&1 \
    || ! flatpak list --columns=application | grep -qx org.freedesktop.Sdk.Extension.node22 \
    || ! flatpak list --columns=application | grep -qx org.freedesktop.Sdk.Extension.rust-stable; then
    echo "Missing Flatpak SDK pieces. Install them with:" >&2
    echo "  flatpak install flathub org.gnome.Sdk//51 org.freedesktop.Sdk.Extension.node22 org.freedesktop.Sdk.Extension.rust-stable" >&2
    exit 1
  fi
  CACHE="$HOME/.cache/majestictab-dev"   # Cargo and npm downloads, so the next run isn't cold
  mkdir -p "$CACHE/cargo" "$CACHE/npm"
  echo "Immutable system detected: running inside the GNOME SDK Flatpak."
  RESTORE_ARGS=()
  if [ -n "${MAJESTICTAB_RESTORE_BACKUP:-}" ]; then
    RESTORE_ARGS=(
      --filesystem="$(dirname "$MAJESTICTAB_RESTORE_BACKUP"):ro"
      --env=MAJESTICTAB_RESTORE_BACKUP="$MAJESTICTAB_RESTORE_BACKUP"
      --env=MAJESTICTAB_RESTORE_MODE="$MAJESTICTAB_RESTORE_MODE"
      --env=MAJESTICTAB_RESTORE_TOKEN="$MAJESTICTAB_RESTORE_TOKEN"
    )
  fi
  exec flatpak run "${RESTORE_ARGS[@]}" \
    --share=network --share=ipc --socket=wayland --socket=fallback-x11 --socket=pulseaudio --device=dri --device=input \
    --filesystem="$ROOT" --filesystem="$CACHE" \
    --env=PATH=/usr/lib/sdk/rust-stable/bin:/usr/lib/sdk/node22/bin:/usr/bin \
    --env=CARGO_HOME="$CACHE/cargo" --env=npm_config_cache="$CACHE/npm" \
    --env=WEBKIT_INSPECTOR_SERVER="$WEBKIT_INSPECTOR_SERVER" --env=GST_DEBUG="$GST_DEBUG" \
    --command=bash "$RUNTIME" -c "cd '$ROOT' && ./run.sh"
fi

cd build/tauri
[ -d node_modules ] || npm ci
npm run tauri:dev -- --features debug-tools
