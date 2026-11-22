#!/usr/bin/env bash
# Turns automatic deploys on or off. While on, pulling or switching branches in the
# checkout that turned it on runs scripts/deploy.sh in the background, logging to
# target/auto-deploy.log there. A newer trigger cancels a deploy still running.
# Other worktrees of the repo are unaffected.
#
# Usage: scripts/auto-deploy.sh on|off|status
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SELF="$ROOT/scripts/auto-deploy.sh"
HOOKS=(post-checkout post-merge post-rewrite)
MARKER="# Installed by GitSense's scripts/auto-deploy.sh."
LOG="$ROOT/target/auto-deploy.log"
LOCK="$ROOT/target/auto-deploy.lock"
# Process group of the deploy holding the lock.
RUNNING="$ROOT/target/auto-deploy.pid"
# Newest deploy request; older ones waiting for the lock give way to it.
LATEST="$ROOT/target/auto-deploy.latest"

hooks_dir() {
    git -C "$ROOT" rev-parse --path-format=absolute --git-path hooks
}

is_ours() {
    [ -f "$1" ] && grep -qxF "$MARKER" "$1"
}

cmd_on() {
    local dir h
    dir="$(hooks_dir)"
    for h in "${HOOKS[@]}"; do
        if [ -e "$dir/$h" ] && ! is_ours "$dir/$h"; then
            echo "Failed to install the $h hook: $dir/$h already exists." >&2
            exit 1
        fi
    done
    mkdir -p "$dir"
    for h in "${HOOKS[@]}"; do
        cat >"$dir/$h" <<EOF
#!/usr/bin/env bash
$MARKER
script=$(printf %q "$SELF")
if [ -x "\$script" ]; then exec "\$script" hook $h "\$@"; fi
echo "GitSense auto-deploy: \$script is missing; remove this hook with auto-deploy.sh off." >&2
EOF
        chmod +x "$dir/$h"
    done
    echo "Auto-deploy is on for $ROOT."
}

cmd_off() {
    local dir h
    dir="$(hooks_dir)"
    for h in "${HOOKS[@]}"; do
        if is_ours "$dir/$h"; then rm "$dir/$h"; fi
    done
    echo "Auto-deploy is off."
}

cmd_status() {
    local hook
    hook="$(hooks_dir)/post-merge"
    if is_ours "$hook"; then
        echo "Auto-deploy is on for $(sed -n 's|^script=\(.*\)/scripts/auto-deploy.sh$|\1|p' "$hook")."
    else
        echo "Auto-deploy is off."
    fi
}

# Runs from the installed hooks with the hook's name and arguments.
cmd_hook() {
    local hook="$1"
    shift
    [ "$(git rev-parse --show-toplevel)" = "$ROOT" ] || return 0
    case "$hook" in
        post-checkout)
            # Only branch checkouts that change HEAD, outside a rebase (post-rewrite covers it).
            [ "$3" = 1 ] && [ "$1" != "$2" ] || return 0
            [ ! -d "$(git rev-parse --git-path rebase-merge)" ] || return 0
            [ ! -d "$(git rev-parse --git-path rebase-apply)" ] || return 0
            ;;
        post-rewrite)
            [ "$1" = rebase ] || return 0
            ;;
    esac
    mkdir -p "$ROOT/target"
    setsid "$SELF" run </dev/null >/dev/null 2>&1 &
    echo "GitSense auto-deploy started; log: $LOG" >&2
}

notify() {
    if command -v notify-send >/dev/null; then notify-send "$@" || true; fi
}

# Deploys in the background. Holds the lock until the build's processes exit.
cmd_run() {
    echo $$ >"$LATEST"
    exec 9>"$LOCK"
    if ! flock -n 9; then
        kill -TERM -- "-$(cat "$RUNNING")" 2>/dev/null || true
        flock 9
    fi
    [ "$(cat "$LATEST")" = $$ ] || exit 0
    echo $$ >"$RUNNING"

    exec >"$LOG" 2>&1
    # Git's hook environment would point the build's git commands at this repo.
    unset $(env | sed -n 's/^\(GIT_[A-Za-z_]*\)=.*/\1/p')
    echo "Deploying $(git -C "$ROOT" rev-parse --short HEAD) at $(date)."
    if "$ROOT/scripts/deploy.sh"; then
        echo "Deployed."
        notify "GitSense deployed" "Restart GitSense to use the new build."
    else
        echo "Failed to deploy."
        notify "GitSense deploy failed" "See $LOG."
        exit 1
    fi
}

case "${1:-}" in
    on) cmd_on ;;
    off) cmd_off ;;
    status) cmd_status ;;
    hook) shift; cmd_hook "$@" ;;
    run) cmd_run ;;
    *) echo "Usage: $0 on|off|status" >&2; exit 2 ;;
esac
