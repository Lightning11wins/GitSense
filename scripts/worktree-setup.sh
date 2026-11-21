#!/usr/bin/env bash
# Sets up a new worktree: reflink-copies the main checkout's Cargo build output, so
# only this branch's changes rebuild, then installs the UI's dependencies.
# Run from anywhere inside the worktree. Safe to re-run.
#
# Reflinks (XFS, Btrfs) share disk with main until a file is rewritten. Without
# them, target/ is skipped and cargo builds from scratch.
set -euo pipefail

WT="$(git rev-parse --show-toplevel)"
MAIN="$(dirname "$(cd "$WT" && cd "$(git rev-parse --git-common-dir)" && pwd)")"

if [ "$WT" = "$MAIN" ]; then
    echo "In the main checkout; nothing to copy."
elif [ -e "$WT/target" ]; then
    echo "target: already present"
elif [ ! -e "$MAIN/target" ]; then
    echo "target: not in the main checkout, skipped"
elif cp -a --reflink=always "$MAIN/target" "$WT/target" 2>/dev/null; then
    echo "target: copied (reflink)"
else
    rm -rf "${WT:?}/target"
    echo "target: no reflink support, skipped"
fi

cd "$WT/app"
pnpm install --frozen-lockfile
