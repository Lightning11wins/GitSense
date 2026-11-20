#!/bin/sh
# Screenshots the app on a private headless display, connected to this computer.
# Usage: scripts/screenshot.sh OUT.png [SECONDS] [BINARY]
# Build first with `pnpm tauri build --debug --no-bundle`. Needs weston and ImageMagick.
set -eu
out=$(realpath -m "$1")
wait=${2:-6}
root=$(cd "$(dirname "$0")/../.." && pwd)
bin=${3:-$root/target/debug/gitsense}
dev="$root/.dev/screenshot"
mkdir -p "$dev/config"
printf '{"last_machine":"local"}\n' > "$dev/config/settings.json"
export GITSENSE_CONFIG_DIR="$dev/config" GITSENSE_HOME="$dev/gitsense"
# Render through X so `import` sees the window, without GPU buffers.
export GDK_BACKEND=x11 WEBKIT_DISABLE_DMABUF_RENDERER=1
xwfb-run -c weston -z=--width=1500 -z=--height=950 -s=-geometry -s=1500x950 -- sh -c "\"$bin\" & app=\$!; sleep $wait; import -window root \"$out\"; kill \$app"
