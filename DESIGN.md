# GitSense Design

GitSense is a lightweight desktop Git client for managing every repository on a machine over SSH. Its v1 goal is to replace the Git features of IntelliJ IDEA's remote development, in roughly the same UI, without IntelliJ's multi-GB install and slow connection setup. IntelliJ is the starting point, not the ceiling: later versions may go beyond it.

Changes to this design are made by agreement with the project owner, then recorded here.

## Goals

These two goals drive every decision. When they conflict, bring the trade-off and its costs to the owner to decide.

1. **Features**: good Git management, with IntelliJ's Git features as the baseline.
   - Feel familiar to an IntelliJ user: New UI layout, dark theme, IntelliJ's default Linux keymap.
   - Show all repos on a machine in one window (typically 2 to 25 repos).
2. **Lightweight**: faster, with less RAM and disk, on both the client and the server, than running a large editor like IntelliJ.
   - Connect to a machine in seconds, not minutes.
   - About 5 MB on the server, tens of MB on the client.

## Platforms

- Linux only, x86_64 first, for both client and servers.
- The app is used on Linux Mint desktops. Development and tests run on a headless Rocky Linux machine, so everything must be testable without a desktop session.

## Architecture

```
Client (desktop app)                        Server (or this computer)
+-------------------------------+           +---------------------------+
| UI (TypeScript, React, Vite)  |           | gitsense-helper           |
|   CodeMirror 6 diff/merge     |  JSON     |   runs the git CLI        |
| Tauri core (Rust)             | <-------> |   discovers repos         |
|   connection, protocol client | stdin/out |   watches files           |
+-------------------------------+           |   stores changelists,     |
         | spawns `ssh <host>`              |   shelf, repo list        |
         | or a local `sh`                  +---------------------------+
```

### Components

- **App**: a Tauri 2 desktop app. The Rust core owns the connection and protocol; the UI is TypeScript + React built with Vite and pnpm.
- **Helper** (`gitsense-helper`): a statically linked Rust binary (musl). It is the only thing installed on the server. It runs git, scans for repos, watches files, and stores per-machine state.
- **Protocol crate**: request, response, and event types shared by the app core and the helper.

### Transports

A transport is a command that runs a shell script and gives the app its stdin/stdout:

- **SSH**: `ssh <host> sh -s`, using the system `ssh`, so `~/.ssh/config`, keys, and ssh-agent work unchanged.
- **This computer**: `sh -s`, run locally.

Everything after starting that shell is identical for both: the same bootstrap script, the same helper upload, the same protocol. Features tested in local mode should therefore behave the same over SSH. Code outside the transport must not branch on which transport is in use.

### Helper deployment

1. The app starts the transport and sends a bootstrap script.
2. The script reports the server's architecture and git version, and whether `<cache>/helper-<hash>` exists, where `<hash>` is the content hash of the helper binary embedded in this app build.
3. If missing, the app streams the binary through the same connection; the script writes it to a temp file, checks its hash, marks it executable, and renames it into place.
4. The script `exec`s the helper, which then speaks the protocol on stdin/stdout.

Because helpers are named by content hash, the app always talks to the exact helper it was built with: there is no protocol version negotiation, and builds from different worktrees or versions can coexist. The helper touches its file on start and deletes other `helper-*` files unused for 30 days.

Requirements on the server: POSIX `sh`, coreutils, and git 2.34 or newer. The bootstrap fails loudly with the found version or architecture otherwise.

### Protocol

Newline-delimited JSON over stdin/stdout:

- Requests from the app carry an `id`; the helper replies with a result or error for that `id`.
- The helper pushes events without an `id` (repo changed, fetch finished, progress).
- Long operations (fetch, push, rebase) stream progress and git's output as events.
- stderr from the helper is diagnostic only and is shown in the app's log.

### Running git

The helper calls the `git` CLI for everything that reads or changes a repo, so hooks, config, credentials, and output match a terminal session on that machine. Git authentication for fetch and push uses the server's own credentials. Every git command the helper runs is reported as an event for the Git Console tab.

### State

Per-machine state lives on the machine, owned by the helper:

| What | Default location |
| --- | --- |
| Helper binaries | `~/.cache/gitsense/` |
| Repo list, changelists, shelf | `~/.local/share/gitsense/` |

Client state (known machines, last machine, window layout, settings such as the auto-fetch interval) lives in the app's config dir.

`GITSENSE_HOME` overrides all helper paths (cache and state under one dir). `GITSENSE_CONFIG_DIR` overrides the app's config dir. Tests and per-worktree dev runs set both.

### Live updates

The helper watches each repo's working tree and `.git` dir with inotify, debounces changes, and pushes "repo changed" events; the app then refreshes that repo's status. If watch limits are hit, the helper falls back to polling that repo and reports it once. The app also refreshes on window focus.

## UI

Modeled on IntelliJ's New UI with the dark theme.

- **Top bar**: machine name and connection state, branch widget (current repo and branch; opens the branches popup), Update Project, Commit, Push.
- **Left tool window**: Commit (changes tree, message box, Amend checkbox, Commit and Commit and Push buttons) and Shelf tabs.
- **Bottom tool window**: Git, with Log and Console tabs.
- **Center**: tabs for diffs, the merge tool, branch comparisons, and pushes in progress. There is no general code editor.
- **Status bar**: background tasks (fetching, pushing) and errors.
- **Welcome screen**: machine picker listing "This computer" and hosts from `~/.ssh/config`. The last machine reopens automatically on launch.
- One machine per window. Tabs for several machines may come later.

Keyboard shortcuts follow IntelliJ's default Linux keymap for every implemented action (for example Ctrl+K commit, Ctrl+Shift+K push, Ctrl+T update, Ctrl+D show diff, Ctrl+Alt+Z rollback, F7 / Shift+F7 next / previous difference).

## v1 Features

### Machines and repos

- Connect over SSH or to this computer; auto-reconnect after drops, keeping UI state.
- On first connect, scan the home dir for repos and worktrees, skipping heavy dirs (`node_modules`, caches, build output; list is configurable). Remember the result; rescan on demand. Manually add or hide repos.
- Repos are independent: branch operations target one repo, while the commit panel and log can show all repos together. Worktrees appear as repos grouped under their main repo.
- Background fetch of all repos every few minutes (interval configurable, can be turned off).

### Changes and committing

- Changes tree grouped by changelist, then repo; Unversioned Files node.
- **Changelists** (IntelliJ default mode, no staging area): named changelists, one active; move files and individual chunks between them. Changelists are app state stored by the helper.
- **Partial commits**: tick files or chunks to commit; unticked changes stay in the working tree untouched. Committing uses a temporary index so the user's working tree and other changes are not modified.
- Commit, Commit and Push, Amend; commit message box with recent-message history.
- Diff viewer: side by side, syntax highlighted, working-copy side editable (small edits with undo, saved back to the server), chunk navigation, chunk checkboxes, per-chunk rollback.
- Rollback files or chunks, with confirmation.
- Unversioned files: add to git, delete, add to a `.gitignore` (choose which one).

### Branches

- Branches popup per repo, IntelliJ style: local, remote, and worktrees, with ahead/behind counts. Actions: Checkout, New Branch from..., Checkout and Rebase onto Current, Compare with Current, Show Diff with Working Tree, Rebase Current onto Selected, Merge into Current, Update, Push, Rename, Delete.
- **Update Project**: for each repo, `git pull --autostash`, so merge versus rebase follows the user's git config (`pull.rebase`, `branch.<name>.rebase`).
- **Push dialog**: outgoing commits per repo with their diffs, editable target branch, set upstream, force push (with lease).
- **Branch comparison**: commits only on one side, with a swap toggle, plus the combined file diff; cherry-pick from it.
- **Worktrees**: listed with branch-level detail (path, branch, ahead/behind, uncommitted changes). Safe delete: refuses when there are uncommitted changes or unpushed commits unless forced; optionally deletes the branch.

### Log

- Commit graph across all repos (repo color markers) or filtered to some.
- Filters: branch, author, date, path/repo, and text or hash search.
- Commit details: message, author, changed files; diff per file.
- Select several commits to review their combined changes.
- Commit actions: Cherry-Pick, Checkout Revision, New Branch here, Reset Current Branch to Here, Edit Commit Message, Undo Commit, Revert, Create Patch, Copy Hash. Disabled actions say why.

### Merging and conflicts

- Merge, rebase, and cherry-pick with a banner for an operation in progress (Continue, Abort, Skip).
- Conflicts dialog: conflicted files with Accept Yours, Accept Theirs, Merge...
- Three-pane merge tool: yours, editable result, theirs; base available. Per-chunk accept/ignore buttons.
- **Magic wand** (Resolve Simple Conflicts): applies every change that only one side made, including non-overlapping changes inside a conflict at line and word level, leaving true conflicts for the user.
- Saving the result marks the file resolved (`git add`).

### Shelf and patches

- Shelf: shelve files, changelists, or chunks (reverting them from the working tree); view shelved diffs; unshelve with a three-way apply; delete. Stored as patch files plus metadata in the helper's state dir.
- Create Patch from changes or commits, to the local clipboard or a file.
- Apply Patch from the clipboard or a file, with a preview diff, three-way when possible.

### Blame

- Annotate in the diff viewer's working-copy side: author, date, and commit per line; click to open the commit in the log.

### Git Console

- Bottom tab listing every git command the helper ran, with its output and exit code.

## Not in v1

Interactive rebase, tags, remote management, submodules, pull requests, file/folder history, Compare with Branch for a path, Local History, review aids (viewed marks, notes), several machines per window.

## Development

- Rust workspace: `crates/protocol`, `crates/helper`, `app/src-tauri`; UI in `app/` (pnpm).
- The helper is built for `x86_64-unknown-linux-musl` and embedded in the app at build time.

### Worktree isolation

Several agents work in separate worktrees on one machine at once. Building, running, and testing in one worktree must not affect the main checkout or other worktrees:

- No fixed ports: the Vite dev server and anything else picks a free port.
- No shared state paths: dev runs and tests set `GITSENSE_HOME` and `GITSENSE_CONFIG_DIR` to dirs inside the worktree or a temp dir.
- Build output stays inside the worktree.

### Testing

- Helper and protocol: Rust integration tests that start the helper through the local transport (including the upload step) and drive it with protocol requests against temporary repos made with real git.
- SSH: the same suite runs over `ssh localhost` when available and is skipped otherwise.
- UI: unit tests with Vitest; end-to-end tests drive the app under a headless display.

## Build Order

1. Workspace skeleton, protocol, helper, both transports with deployment, test harness; app shell with machine picker and repo list.
2. Status and Commit tool window with whole-file commits, diff viewer (then editable), amend, rollback, unversioned files and `.gitignore`.
3. Branches popup, fetch and auto-fetch, Update Project, push dialog, worktree list and safe delete.
4. Log: graph, filters, commit details, multi-commit review, commit actions.
5. Merge, rebase, cherry-pick, conflicts dialog, merge tool with magic wand; branch comparison.
6. Changelists and partial commits.
7. Shelf, patches, blame, Git Console.
