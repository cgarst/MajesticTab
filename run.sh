#!/bin/bash
# Runs the desktop app in dev mode (tauri dev).
#
# On immutable systems (SteamOS, Fedora Atomic, Bazzite, other ostree images) the host has no Node, Rust or WebKitGTK
# headers and its root is read-only, so this re-runs itself inside the GNOME SDK Flatpak, the same runtime (and WebKitGTK)
# the Flathub build uses. Everywhere else it runs directly and needs Node, Rust and Tauri's Linux libraries installed.
set -e
cd "$(dirname "$(readlink -f "$0")")"
ROOT="$PWD"

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
  exec flatpak run \
    --share=network --share=ipc --socket=wayland --socket=fallback-x11 --device=dri \
    --filesystem="$ROOT" --filesystem="$CACHE" \
    --env=PATH=/usr/lib/sdk/rust-stable/bin:/usr/lib/sdk/node22/bin:/usr/bin \
    --env=CARGO_HOME="$CACHE/cargo" --env=npm_config_cache="$CACHE/npm" \
    --command=bash "$RUNTIME" -c "cd '$ROOT' && ./run.sh"
fi

cd build/tauri
[ -d node_modules ] || npm ci
npm run tauri:dev -- --features debug-tools
