#!/bin/sh
# Runs the app on a private headless display, connected to this computer, and drives it with xdrive.py steps.
# Usage: scripts/drive.sh STEP...   e.g. scripts/drive.sh sleep 6 shot out.png
# Build first with `pnpm tauri build --debug --no-bundle`. Needs weston, ImageMagick, and libXtst.
# Set GITSENSE_BIN to run another binary, and HOME to scan another home directory.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
bin=${GITSENSE_BIN:-$root/target/debug/gitsense}
dev="$root/.dev/drive"
rm -rf "$dev"
mkdir -p "$dev/config"
printf '{"last_machine":"local"}\n' > "$dev/config/settings.json"
export GITSENSE_CONFIG_DIR="$dev/config" GITSENSE_HOME="$dev/gitsense"
# Render through X so XTest and `import` see the window, without GPU buffers.
export GDK_BACKEND=x11 WEBKIT_DISABLE_DMABUF_RENDERER=1
xwfb-run -c weston -z=--width=1500 -z=--height=950 -s=-geometry -s=1500x950 -- \
  sh -c 'bin=$1 drive=$2; shift 2; "$bin" & app=$!; python3 "$drive" "$@"; status=$?; kill $app; exit $status' \
  sh "$bin" "$here/xdrive.py" "$@"
