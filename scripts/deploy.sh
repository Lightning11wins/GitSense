#!/usr/bin/env bash
# Builds this checkout's .deb and installs it, so GitSense runs this code from its
# next launch. Installing asks for an admin password through pkexec.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE="$ROOT/target/release/bundle/deb"

cd "$ROOT/app"
pnpm install --frozen-lockfile
rm -rf "$BUNDLE"
pnpm build --bundles deb

debs=("$BUNDLE"/*.deb)
if [ "${#debs[@]}" -ne 1 ] || [ ! -f "${debs[0]}" ]; then
    echo "Failed to find exactly one .deb in $BUNDLE: ${debs[*]}" >&2
    exit 1
fi
pkexec dpkg -i "${debs[0]}"
