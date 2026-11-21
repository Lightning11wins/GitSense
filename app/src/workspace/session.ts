// State of one connected machine: repos, their statuses, and the Git Console.
import { useSyncExternalStore } from "react";
import { call, getSettings, onSettings, onWindowEvent, type ConnectedInfo, type Settings } from "../api";
import type { Changelists, FileChange, GitCommandLog, Repo, RepoStatus } from "../protocol.gen";
import type { DiffTab } from "./DiffView";
import type { MergeTab } from "../merge/MergeTool";
import type { CompareTab } from "../log/CompareView";
import { keyedChunks, pruneChunks, toDoc, toggleChunk } from "./partial";

/** The push tab. `branch` limits it to one branch of one repo; otherwise it lists every repo's current branch. */
export type PushTab = { kind: "push"; id: "push"; branch?: { repo: string; name: string }; version: number };
export type CenterTab = DiffTab | PushTab | MergeTab | CompareTab;

/** A repo's status. `status` and `changelists` are loaded together; each tracked change is in one of the lists. */
export type StatusEntry = { status?: RepoStatus; changelists?: Changelists; error?: string; loading: boolean };

export type SessionState = {
  info: ConnectedInfo;
  repos: Repo[];
  reposLoading: boolean;
  reposError?: string;
  statuses: Record<string, StatusEntry>;
  console: GitCommandLog[];
  notices: string[];
  /** Background tasks in progress, shown in the status bar. */
  tasks: Task[];
  settings?: Settings;
  disconnected?: string;
  /** Center editor tabs. */
  tabs: CenterTab[];
  activeTab?: string;
  /** Increments to ask the commit panel to focus its message box. */
  commitFocusRequests: number;
  /** Tracked changes left out of the next commit, by `fileKey`. Other tracked changes are included. */
  excludedFiles: ReadonlySet<string>;
  /**
   * Keys of chunks left out of the next commit, by `fileKey`, for included files. Lists are never empty
   * and never hold every chunk of their file.
   */
  excludedChunks: Readonly<Record<string, readonly string[]>>;
};

export type Task = { id: number; label: string };

const CONSOLE_LIMIT = 500;
/** Repos fetched or pulled at once. */
const PARALLEL_REPOS = 4;

export class Session {
  private state: SessionState;
  private listeners = new Set<() => void>();
  private stopEvents?: () => void;
  /** Repos with a status refresh in flight, and whether another is wanted after it. */
  private refreshing = new Map<string, boolean>();
  private nextTask = 0;
  private fetching = false;
  private autoFetchTimer?: ReturnType<typeof setInterval>;
  private stopSettings?: () => void;

  constructor(
    info: ConnectedInfo,
    private reconnect: () => Promise<ConnectedInfo>,
  ) {
    this.state = { info, repos: [], reposLoading: true, statuses: {}, console: [], notices: [], tasks: [], tabs: [], commitFocusRequests: 0, excludedFiles: new Set(), excludedChunks: {} };
  }

  start() {
    this.stopEvents = onWindowEvent((e) => {
      if (e.type === "disconnected") {
        this.set({ disconnected: e.reason });
        return;
      }
      const event = e.event;
      switch (event.kind) {
        case "repo_changed":
          this.refreshStatus(event.repo);
          break;
        case "git_command":
          this.set({ console: [...this.state.console, event].slice(-CONSOLE_LIMIT) });
          break;
        case "notice":
          this.set({ notices: [...this.state.notices, event.text] });
          break;
      }
    });
    window.addEventListener("focus", this.refreshAll);
    this.loadRepos("repos.list");
    this.stopSettings = onSettings((settings) => this.applySettings(settings));
    getSettings().then((settings) => this.applySettings(settings));
  }

  dispose() {
    this.stopEvents?.();
    this.stopSettings?.();
    clearInterval(this.autoFetchTimer);
    window.removeEventListener("focus", this.refreshAll);
  }

  private applySettings(settings: Settings) {
    this.set({ settings });
    clearInterval(this.autoFetchTimer);
    if (settings.auto_fetch_minutes > 0) {
      this.autoFetchTimer = setInterval(() => this.fetchAll(true), settings.auto_fetch_minutes * 60_000);
    }
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = () => this.state;

  private set(patch: Partial<SessionState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  visibleRepos(): Repo[] {
    return this.state.repos.filter((r) => !r.hidden);
  }

  async loadRepos(method: "repos.list" | "repos.scan") {
    this.set({ reposLoading: true, reposError: undefined });
    try {
      const repos = await call(method, {});
      this.set({ repos, reposLoading: false });
      this.refreshAll();
    } catch (e) {
      this.set({ reposLoading: false, reposError: String(e) });
    }
  }

  async setHidden(repo: string, hidden: boolean) {
    await call("repos.set_hidden", { repo, hidden });
    this.set({ repos: this.state.repos.map((r) => (r.path === repo ? { ...r, hidden } : r)) });
    if (!hidden) this.refreshStatus(repo);
  }

  refreshAll = () => {
    for (const repo of this.visibleRepos()) this.refreshStatus(repo.path);
  };

  /** Reloads a repo's status. Calls during a refresh coalesce into one more. */
  async refreshStatus(repo: string) {
    if (this.refreshing.has(repo)) {
      this.refreshing.set(repo, true);
      return;
    }
    this.refreshing.set(repo, false);
    this.patchStatus(repo, { loading: true });
    try {
      const status = await call("status", { repo });
      const changelists = await this.assignNewChanges(repo, status, await call("changelists.get", { repo }));
      this.patchStatus(repo, { status, changelists, error: undefined, loading: false });
      await this.pruneExcludedChunks(repo, status);
    } catch (e) {
      this.patchStatus(repo, { error: String(e), loading: false });
    }
    const again = this.refreshing.get(repo);
    this.refreshing.delete(repo);
    if (again) this.refreshStatus(repo);
  }

  /**
   * Assigns tracked changes that are in no changelist to the active one, so they stay in it when another
   * list becomes active. Returns the updated lists.
   */
  private async assignNewChanges(repo: string, status: RepoStatus, changelists: Changelists): Promise<Changelists> {
    const assigned = new Set(changelists.lists.flatMap((l) => l.paths));
    const paths = status.changes
      .filter((c) => c.kind !== "untracked" && !assigned.has(c.path) && !(c.orig_path && assigned.has(c.orig_path)))
      .map((c) => c.path);
    if (paths.length === 0) return changelists;
    return call("changelists.move_paths", { repo, name: changelists.active, paths });
  }

  /** Repos whose changelists are loaded, with those lists. */
  private loadedChangelists(): [string, Changelists][] {
    return this.visibleRepos().flatMap((r) => {
      const lists = this.state.statuses[r.path]?.changelists;
      return lists ? [[r.path, lists] as [string, Changelists]] : [];
    });
  }

  /**
   * Runs a changelist change on each repo, storing the lists it returns. Changelists act as one set across
   * repos, so each change applies to every repo it concerns. Rejects with every repo's failure.
   */
  private async changeLists(repos: string[], change: (repo: string, lists: Changelists) => Promise<Changelists>) {
    const failures: string[] = [];
    for (const repo of repos) {
      const lists = this.state.statuses[repo]?.changelists;
      if (!lists) continue;
      try {
        this.patchStatus(repo, { changelists: await change(repo, lists) });
        // A refresh in flight may have read the lists before this change.
        if (this.refreshing.has(repo)) this.refreshing.set(repo, true);
      } catch (e) {
        failures.push(String(e));
      }
    }
    if (failures.length) throw new Error(failures.join("\n"));
  }

  /** Adds an empty changelist to every repo, optionally making it active. */
  async createChangelist(name: string, active: boolean) {
    const repos = this.loadedChangelists();
    if (repos.some(([, lists]) => lists.lists.some((l) => l.name === name))) {
      throw new Error(`Failed to create changelist '${name}': that name is already used.`);
    }
    await this.changeLists(
      repos.map(([repo]) => repo),
      (repo) => call("changelists.create", { repo, name }),
    );
    if (active) await this.setActiveChangelist(name);
  }

  async renameChangelist(name: string, newName: string) {
    const repos = this.loadedChangelists().filter(([, lists]) => lists.lists.some((l) => l.name === name));
    if (newName !== name && repos.some(([, lists]) => lists.lists.some((l) => l.name === newName))) {
      throw new Error(`Failed to rename changelist '${name}' to '${newName}': that name is already used.`);
    }
    await this.changeLists(
      repos.map(([repo]) => repo),
      (repo) => call("changelists.rename", { repo, name, new_name: newName }),
    );
  }

  /** Deletes a changelist, moving its files to the default list, which becomes active if it was. */
  async deleteChangelist(name: string) {
    const repos = this.loadedChangelists().filter(([, lists]) => lists.lists.some((l) => l.name === name));
    await this.changeLists(
      repos.map(([repo]) => repo),
      (repo) => call("changelists.delete", { repo, name }),
    );
  }

  /** Makes a changelist active in every repo, creating it where missing. Existing changes keep their lists. */
  async setActiveChangelist(name: string) {
    await this.changeLists(
      this.loadedChangelists().map(([repo]) => repo),
      async (repo, lists) => {
        const status = this.state.statuses[repo]?.status;
        if (status) lists = await this.assignNewChanges(repo, status, lists);
        if (!lists.lists.some((l) => l.name === name)) await call("changelists.create", { repo, name });
        return call("changelists.set_active", { repo, name });
      },
    );
  }

  /** Moves files to a changelist, creating it in their repos where missing. */
  async moveToChangelist(name: string, files: { repo: string; path: string }[]) {
    const byRepo = new Map<string, string[]>();
    for (const f of files) byRepo.set(f.repo, [...(byRepo.get(f.repo) ?? []), f.path]);
    await this.changeLists([...byRepo.keys()], async (repo, lists) => {
      if (!lists.lists.some((l) => l.name === name)) await call("changelists.create", { repo, name });
      return call("changelists.move_paths", { repo, name, paths: byRepo.get(repo)! });
    });
  }

  /** Includes or excludes whole files in the next commit, clearing their chunk choices. */
  setFilesIncluded(files: { repo: string; path: string }[], included: boolean) {
    const excludedFiles = new Set(this.state.excludedFiles);
    const excludedChunks = { ...this.state.excludedChunks };
    for (const { repo, path } of files) {
      const key = fileKey(repo, path);
      if (included) excludedFiles.delete(key);
      else excludedFiles.add(key);
      delete excludedChunks[key];
    }
    this.set({ excludedFiles, excludedChunks });
  }

  /**
   * Includes or excludes one chunk of a file in the next commit. `keys` are the keys of all the file's
   * current chunks. Excluding the last included chunk excludes the file; including a chunk of an excluded
   * file includes only that chunk.
   */
  setChunkIncluded(repo: string, path: string, keys: readonly string[], key: string, included: boolean) {
    const file = fileKey(repo, path);
    const old = this.state.excludedFiles.has(file) ? "all" : (this.state.excludedChunks[file] ?? []);
    this.setExcludedChunks(file, toggleChunk(old, keys, key, included));
  }

  private setExcludedChunks(file: string, excluded: string[] | "all") {
    const excludedFiles = new Set(this.state.excludedFiles);
    const excludedChunks: Record<string, readonly string[]> = { ...this.state.excludedChunks };
    delete excludedChunks[file];
    if (excluded === "all") excludedFiles.add(file);
    else excludedFiles.delete(file);
    if (excluded !== "all" && excluded.length) excludedChunks[file] = excluded;
    this.set({ excludedFiles, excludedChunks });
  }

  /** Drops excluded chunks of a repo's files that no longer exist, excluding files left with none included. */
  private async pruneExcludedChunks(repo: string, status: RepoStatus) {
    for (const file of Object.keys(this.state.excludedChunks)) {
      if (!file.startsWith(fileKey(repo, ""))) continue;
      const change = status.changes.find((c) => fileKey(repo, c.path) === file);
      try {
        const texts = change && (await readTexts(repo, change));
        const keys = texts ? keyedChunks(toDoc(texts.head), toDoc(texts.work)).map((c) => c.key) : [];
        const excluded = this.state.excludedChunks[file];
        if (excluded) this.setExcludedChunks(file, pruneChunks(excluded, keys));
      } catch {
        // Kept as they are until a later refresh can read the file.
      }
    }
  }

  private patchStatus(repo: string, patch: Partial<StatusEntry>) {
    const old = this.state.statuses[repo] ?? { loading: false };
    this.set({ statuses: { ...this.state.statuses, [repo]: { ...old, ...patch } } });
  }

  /** Runs work as a background task shown in the status bar. */
  async track<T>(label: string, work: () => Promise<T>): Promise<T> {
    const task = { id: ++this.nextTask, label };
    this.set({ tasks: [...this.state.tasks, task] });
    try {
      return await work();
    } finally {
      this.set({ tasks: this.state.tasks.filter((t) => t !== task) });
    }
  }

  /** Fetches every visible repo once per shared git dir. `auto` skips a notice that repeats the last one. */
  async fetchAll(auto = false) {
    if (this.fetching) return;
    this.fetching = true;
    const groups = groupByCommonDir(this.visibleRepos());
    const failures: string[] = [];
    try {
      await this.track(`Fetching ${groups.length} repositories...`, () =>
        forEachLimit(groups, PARALLEL_REPOS, async (group) => {
          try {
            await call("fetch", { repo: group[0] });
          } catch (e) {
            failures.push(`${group[0]}: ${e}`);
          }
          group.forEach((repo) => this.refreshStatus(repo));
        }),
      );
    } finally {
      this.fetching = false;
    }
    if (failures.length === 0) return;
    const notice = `Failed to fetch ${failures.length} of ${groups.length} repositories. ${failures[0]}`;
    if (!auto || this.state.notices.at(-1) !== notice) this.notify(notice);
  }

  /** Pulls the current branch of every visible repo that has an upstream, like IntelliJ's Update Project. */
  async updateProject() {
    const repos = this.visibleRepos().filter((r) => this.state.statuses[r.path]?.status?.upstream);
    const failures: string[] = [];
    let updated = 0;
    // Worktrees of one repo share refs, so they update one after another.
    await this.track(`Updating ${repos.length} repositories...`, () =>
      forEachLimit(groupByCommonDir(repos), PARALLEL_REPOS, async (group) => {
        for (const repo of group) {
          try {
            const before = (await call("status", { repo })).head;
            await call("pull", { repo });
            if ((await call("status", { repo })).head !== before) updated++;
          } catch (e) {
            failures.push(`${repo}: ${e}`);
          }
          this.refreshStatus(repo);
        }
      }),
    );
    const summary = updated === 0 ? "All repositories are up to date." : `Updated ${updated} of ${repos.length} repositories.`;
    this.notify(failures.length === 0 ? summary : `${summary} Failed to update ${failures.length}. ${failures.join(" ")}`);
  }

  async reconnectNow() {
    const info = await this.reconnect();
    this.set({ info, disconnected: undefined });
    await this.loadRepos("repos.list");
  }

  /**
   * Opens a working-tree file's diff against a revision in a center tab, reusing its tab if open, or the merge tool
   * for a conflicted file.
   */
  openDiff(repo: string, change: FileChange, rev = "HEAD") {
    if (change.kind === "conflicted") return this.openMerge(repo, change.path);
    this.openTab({
      kind: "diff",
      id: rev === "HEAD" ? `diff:${repo}:${change.path}` : `diff:${repo}:${rev}:${change.path}`,
      repo,
      left: { rev, path: change.orig_path ?? change.path },
      right: { path: change.path },
    });
  }

  /** Opens the diff of a file that commit `hash` changed, against its first parent. */
  openCommitDiff(repo: string, hash: string, change: FileChange) {
    this.openRevDiff(repo, `${hash}^1`, hash, change);
  }

  /** Opens the diff of a file between two revisions. */
  openRevDiff(repo: string, from: string, to: string, change: FileChange) {
    this.openTab({
      kind: "diff",
      id: `diff:${repo}:${from}..${to}:${change.path}`,
      repo,
      left: { rev: from, path: change.orig_path ?? change.path },
      right: { rev: to, path: change.path },
    });
  }

  /** Opens a comparison of two branches, or of a branch with the working tree when `head` is null. */
  openCompare(repo: string, base: string, head: string | null) {
    this.openTab({ kind: "compare", id: `compare:${repo}:${base}:${head ?? ""}`, repo, base, head });
  }

  /** Opens the merge tool for a conflicted file. */
  openMerge(repo: string, path: string) {
    this.openTab({ kind: "merge", id: `merge:${repo}:${path}`, repo, path });
  }

  /** Opens the push tab, or reloads it when already open. */
  openPush(branch?: PushTab["branch"]) {
    const old = this.state.tabs.find((t) => t.kind === "push");
    const tab: PushTab = { kind: "push", id: "push", branch, version: (old?.kind === "push" ? old.version : 0) + 1 };
    this.set({ tabs: old ? this.state.tabs.map((t) => (t === old ? tab : t)) : [...this.state.tabs, tab], activeTab: tab.id });
  }

  private openTab(tab: CenterTab) {
    const tabs = this.state.tabs.some((t) => t.id === tab.id) ? this.state.tabs : [...this.state.tabs, tab];
    this.set({ tabs, activeTab: tab.id });
  }

  requestCommitFocus() {
    this.set({ commitFocusRequests: this.state.commitFocusRequests + 1 });
  }

  activateTab(id: string) {
    this.set({ activeTab: id });
  }

  closeTab(id: string) {
    const index = this.state.tabs.findIndex((t) => t.id === id);
    const tabs = this.state.tabs.filter((t) => t.id !== id);
    const activeTab = this.state.activeTab === id ? tabs[Math.min(index, tabs.length - 1)]?.id : this.state.activeTab;
    this.set({ tabs, activeTab });
  }

  clearConsole() {
    this.set({ console: [] });
  }

  /** Shows a message in the status bar. */
  notify(text: string) {
    this.set({ notices: [...this.state.notices, text] });
  }

  dismissNotice(index: number) {
    this.set({ notices: this.state.notices.filter((_, i) => i !== index) });
  }
}

/** Key of a file in a repo, for per-file state. */
export function fileKey(repo: string, path: string): string {
  return `${repo}\0${path}`;
}

/**
 * A change's HEAD and working-tree text, for splitting it into chunks. Undefined for a deleted or binary
 * file, which can only be committed whole.
 */
export async function readTexts(repo: string, change: FileChange): Promise<{ head: string; work: string } | undefined> {
  const [head, work] = await Promise.all([
    call("file.read", { repo, path: change.orig_path ?? change.path, version: { kind: "revision", rev: "HEAD" } }),
    call("file.read", { repo, path: change.path, version: { kind: "working_tree" } }),
  ]);
  if (head.binary || work.binary || !work.exists) return undefined;
  return { head: head.text ?? "", work: work.text ?? "" };
}

/** Subscribes to part of the session state. `select` must return stored values, not new objects. */
export function useSession<T>(session: Session, select: (state: SessionState) => T): T {
  return useSyncExternalStore(session.subscribe, () => select(session.getState()));
}

/** Repo paths grouped by shared git dir, so worktrees of one repo share a group. */
export function groupByCommonDir(repos: Repo[]): string[][] {
  const groups = new Map<string, string[]>();
  for (const repo of repos) groups.set(repo.common_dir, [...(groups.get(repo.common_dir) ?? []), repo.path]);
  return [...groups.values()];
}

/** Runs `work` on each item with at most `limit` running at once. */
async function forEachLimit<T>(items: T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await work(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
