// State of one connected machine: repos, their statuses, and the Git Console.
import { useSyncExternalStore } from "react";
import { call, onWindowEvent, type ConnectedInfo } from "../api";
import type { FileChange, GitCommandLog, Repo, RepoStatus } from "../protocol.gen";
import type { DiffTab } from "./DiffView";

export type StatusEntry = { status?: RepoStatus; error?: string; loading: boolean };

export type SessionState = {
  info: ConnectedInfo;
  repos: Repo[];
  reposLoading: boolean;
  reposError?: string;
  statuses: Record<string, StatusEntry>;
  console: GitCommandLog[];
  notices: string[];
  disconnected?: string;
  /** Center editor tabs. */
  tabs: DiffTab[];
  activeTab?: string;
};

const CONSOLE_LIMIT = 500;

export class Session {
  private state: SessionState;
  private listeners = new Set<() => void>();
  private stopEvents?: () => void;
  /** Repos with a status refresh in flight, and whether another is wanted after it. */
  private refreshing = new Map<string, boolean>();

  constructor(
    info: ConnectedInfo,
    private reconnect: () => Promise<ConnectedInfo>,
  ) {
    this.state = { info, repos: [], reposLoading: true, statuses: {}, console: [], notices: [], tabs: [] };
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
  }

  dispose() {
    this.stopEvents?.();
    window.removeEventListener("focus", this.refreshAll);
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
      this.patchStatus(repo, { status, error: undefined, loading: false });
    } catch (e) {
      this.patchStatus(repo, { error: String(e), loading: false });
    }
    const again = this.refreshing.get(repo);
    this.refreshing.delete(repo);
    if (again) this.refreshStatus(repo);
  }

  private patchStatus(repo: string, patch: Partial<StatusEntry>) {
    const old = this.state.statuses[repo] ?? { loading: false };
    this.set({ statuses: { ...this.state.statuses, [repo]: { ...old, ...patch } } });
  }

  async reconnectNow() {
    const info = await this.reconnect();
    this.set({ info, disconnected: undefined });
    await this.loadRepos("repos.list");
  }

  /** Opens a file's diff in a center tab, reusing its tab if open. */
  openDiff(repo: string, change: FileChange) {
    const id = `diff:${repo}:${change.path}`;
    const tab: DiffTab = { id, repo, path: change.path, origPath: change.orig_path };
    const tabs = this.state.tabs.some((t) => t.id === id) ? this.state.tabs : [...this.state.tabs, tab];
    this.set({ tabs, activeTab: id });
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

/** Subscribes to part of the session state. `select` must return stored values, not new objects. */
export function useSession<T>(session: Session, select: (state: SessionState) => T): T {
  return useSyncExternalStore(session.subscribe, () => select(session.getState()));
}
