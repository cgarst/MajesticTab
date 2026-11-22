#!/bin/bash
# Builds the Linux Flatpak (the same build as `node build/build-tauri.mjs linux`) and installs it on this machine,
# as an upgrade when MajesticTab is already installed (in the same user or system installation), otherwise as a new
# user install. The bundle is also left in dist/.
#
#   build/build-linux.sh              build, install and start the app
#   build/build-linux.sh --no-run     build and install only
#   build/build-linux.sh --no-install build the bundle only
#   build/build-linux.sh --no-build   install the bundle already in dist/ without rebuilding
#   build/build-linux.sh --dev        (alias --debug) a debug build: web inspector and the debug bridge on port 9555.
#                                     Same app ID, so it installs over the normal one and keeps its data
#   other options (--channel=<id>, ...) go to build-tauri.mjs
#
# Needs flatpak, plus either node and flatpak-builder on the host or, on immutable systems (SteamOS, Bazzite, other
# ostree images), the Flatpak apps org.flatpak.Builder and org.gnome.Sdk with the node22 extension, which this script
# then uses to run Node and flatpak-builder.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_ID="net.zathu.majestictab"

RUN=1
INSTALL=1
BUILD=1
ARGS=()
for arg in "$@"; do
    case "$arg" in
        --no-run) RUN=0 ;;
        --no-install) INSTALL=0; RUN=0 ;;
        --no-build) BUILD=0 ;;
        --dev|--debug) ARGS+=("--debug-tools") ;;
        -h|--help) sed -n '2,/^set -/p' "$0" | sed -e '/^set -/d' -e 's/^# \{0,1\}//'; exit 0 ;;
        *) ARGS+=("$arg") ;;
    esac
done

command -v flatpak >/dev/null || { echo "Error: flatpak is not installed." >&2; exit 1; }

# The updater public key, as in build-macos.sh, so this build can verify signed in-app updates.
if [ -z "${TAURI_UPDATER_PUBKEY:-}" ]; then
    PUBKEY_FILE="$HOME/.tauri/majestictab-updater.key.pub"
    if [ -f "$PUBKEY_FILE" ]; then
        TAURI_UPDATER_PUBKEY="$(tr -d '\n' < "$PUBKEY_FILE")"
    else
        TAURI_UPDATER_PUBKEY="dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEVDRUZEMURFMUExRTI4MzUKUldRMUtCNGEzdEh2N0hhVmg3UXVEYzY5ZGNyWlBvc3pHempXR2djQWdYN1JUSmd3TEt0K2QvVzQK"
    fi
fi
export TAURI_UPDATER_PUBKEY

if [ "$BUILD" = 0 ]; then
    echo "Skipping the build (--no-build)."
elif command -v node >/dev/null && command -v flatpak-builder >/dev/null; then
    node "$ROOT_DIR/build/build-tauri.mjs" linux ${ARGS[@]+"${ARGS[@]}"}
else
    # Node from the GNOME SDK's node22 extension; flatpak and flatpak-builder (the org.flatpak.Builder app) are run on
    # the host through flatpak-spawn, via small shims that build-tauri.mjs finds on PATH.
    SDK="$(flatpak list --runtime --columns=application,branch | awk '$1=="org.gnome.Sdk"{print $1"//"$2; exit}')"
    flatpak list --columns=application | grep -qx org.freedesktop.Sdk.Extension.node22 && [ -n "$SDK" ] \
        && flatpak info org.flatpak.Builder >/dev/null 2>&1 || {
        echo "Error: need node and flatpak-builder, or the Flatpaks org.gnome.Sdk, org.freedesktop.Sdk.Extension.node22 and org.flatpak.Builder." >&2
        exit 1
    }
    SHIMS="$(mktemp -d)"
    trap 'rm -rf "$SHIMS" "$ROOT_DIR/build/tauri/flatpak/manifest.limited.yml"' EXIT
    printf '#!/bin/sh\nexec flatpak-spawn --host --directory="$PWD" flatpak "$@"\n' > "$SHIMS/flatpak"
    # flatpak-builder: state dir outside the repo (a repo-local one made the source download fail with "Error renaming
    # temporary file"), and cargo limited to MAJESTICTAB_BUILD_JOBS (default 4) jobs, since a full-width compile is
    # killed for memory on 16 GB machines. The limit is added to a copy of the manifest that sits beside the original.
    cat > "$SHIMS/flatpak-builder" <<'SHIM'
#!/bin/bash
args=()
for a in "$@"; do
    case "$a" in
        *.yml)
            copy="$(dirname "$a")/manifest.limited.yml"
            sed "s/^\( *\)CARGO_NET_OFFLINE: 'true'/&\n\1CARGO_BUILD_JOBS: '${MAJESTICTAB_BUILD_JOBS:-4}'/" "$a" > "$copy"
            a="$copy" ;;
    esac
    args+=("$a")
done
exec flatpak-spawn --host --directory="$PWD" flatpak run org.flatpak.Builder --state-dir="$HOME/.cache/majestictab-dev/flatpak-builder" "${args[@]}"
SHIM
    chmod +x "$SHIMS/flatpak" "$SHIMS/flatpak-builder"
    CACHE="$HOME/.cache/majestictab-dev"
    mkdir -p "$CACHE/npm" "$CACHE/flatpak-builder"
    EXTRA=""
    [ ${#ARGS[@]} -gt 0 ] && EXTRA="$(printf '%q ' "${ARGS[@]}")"
    echo "No host node or flatpak-builder: running Node in $SDK."
    flatpak run --talk-name=org.freedesktop.Flatpak --share=network \
        --filesystem="$ROOT_DIR" --filesystem="$SHIMS" --filesystem="$CACHE" \
        --env=PATH="$SHIMS:/usr/lib/sdk/node22/bin:/usr/bin" --env=npm_config_cache="$CACHE/npm" \
        --env=MAJESTICTAB_BUILD_JOBS="${MAJESTICTAB_BUILD_JOBS:-4}" --env=HOME="$HOME" \
        --env=TAURI_UPDATER_PUBKEY="$TAURI_UPDATER_PUBKEY" \
        --command=bash "$SDK" -c "cd '$ROOT_DIR' && node build/build-tauri.mjs linux $EXTRA"
fi

ARCH="$(uname -m)"
BUNDLE="$ROOT_DIR/dist/MajesticTab-$ARCH.flatpak"
[ -f "$BUNDLE" ] || { echo "Error: $BUNDLE was not created." >&2; exit 1; }
echo "Built $BUNDLE"
[ "$INSTALL" = 1 ] || exit 0

# Install where it already is (the system installation may ask for authentication), else for this user.
WHERE="$(flatpak list --app --columns=application,installation | awk -v id="$APP_ID" '$1==id{print $2; exit}')"
case "$WHERE" in
    system) SCOPE=--system ;;
    *) SCOPE=--user ;;
esac

if flatpak ps --columns=application | grep -qx "$APP_ID"; then
    echo "Closing MajesticTab..."
    flatpak kill "$APP_ID" || true
fi

if [ -n "$WHERE" ]; then echo "Upgrading the installed MajesticTab ($WHERE)..."; else echo "Installing MajesticTab (user)..."; fi
if ! flatpak install $SCOPE --bundle --noninteractive -y "$BUNDLE"; then
    if [ "$SCOPE" = --system ]; then
        # No permission to change the system installation (it needs an administrator). A user installation of the same
        # app takes precedence over the system one, so install there instead.
        echo "Cannot change the system installation as this user: installing for this user instead." >&2
        echo "(The system copy stays; remove it with 'flatpak uninstall --system $APP_ID' as an administrator to avoid two.)" >&2
        flatpak install --user --bundle --noninteractive -y "$BUNDLE"
        SCOPE=--user
    else
        exit 1
    fi
fi
echo "Installed MajesticTab $(flatpak info $SCOPE "$APP_ID" | awk -F': *' '/Version:/{print $2}')"

[ "$RUN" = 1 ] && { flatpak run "$APP_ID" >/dev/null 2>&1 & disown; }
exit 0
