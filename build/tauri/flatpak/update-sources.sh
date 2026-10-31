#!/bin/sh
# Regenerates cargo-sources.json and node-sources.json from the lockfiles. The Flatpak build (manifest.yml, and Flathub's
# copy of it) runs offline from these files, so run this after any change to Cargo.lock or package-lock.json; CI's
# Linux build fails when they are stale. Copy the result to the Flathub submission as well.
#
# Needs flatpak-builder-tools (https://github.com/flatpak/flatpak-builder-tools):
#   flatpak-node-generator on PATH (pip install ./node), and flatpak-cargo-generator.py
#   (set FLATPAK_CARGO_GENERATOR, default: flatpak-cargo-generator.py on PATH).
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/.."
"${FLATPAK_CARGO_GENERATOR:-flatpak-cargo-generator.py}" src-tauri/Cargo.lock -o "$here/cargo-sources.json"
flatpak-node-generator npm package-lock.json -o "$here/node-sources.json"
echo "Updated sources in $here"
