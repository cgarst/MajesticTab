#!/bin/sh
# Regenerates cargo-sources.json and node-sources.json from the lockfiles and records the lockfile hashes
# (check-sources.mjs, run in CI, fails when they drift). Run after any change to Cargo.lock or package-lock.json.
#
# Needs flatpak-builder-tools (https://github.com/flatpak/flatpak-builder-tools):
#   flatpak-node-generator on PATH (pip install ./node), and flatpak-cargo-generator.py
#   (set FLATPAK_CARGO_GENERATOR, default: flatpak-cargo-generator.py on PATH).
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/../.."
"${FLATPAK_CARGO_GENERATOR:-flatpak-cargo-generator.py}" src-tauri/Cargo.lock -o "$here/cargo-sources.json"
flatpak-node-generator npm package-lock.json -o "$here/node-sources.json"
if command -v sha256sum >/dev/null 2>&1; then sum=sha256sum; else sum="shasum -a 256"; fi
$sum src-tauri/Cargo.lock package-lock.json > "$here/lockfiles.sha256"
echo "Updated sources in $here"
