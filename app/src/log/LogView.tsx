import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { ChevronDown, GitBranch, RefreshCw, Search, X } from "lucide-react";
import type { LogCommit, LogParams } from "../protocol.gen";
import { call } from "../api";
import { useSession, type Session } from "../workspace/session";
import { repoName } from "../workspace/repos";
import { Menu, Popup, below, type MenuAction, type Point } from "../workspace/Popup";
import { Splitter, startDrag } from "../workspace/Splitter";
import { InputDialog } from "../workspace/InputDialog";
import { layoutGraph, type GraphRow, type Segment } from "./graph";
import { interleave, type LogRow } from "./interleave";
import { CommitDetails } from "./CommitDetails";
import { BranchesPanel } from "./BranchesPanel";
import { ResetDialog, RewordDialog } from "./CommitDialogs";
import "./LogView.css";

const PAGE = 200;
const ROW_HEIGHT = 24;
/** Half a row, so a one-lane change fits in a row at 45 degrees. */
const LANE_WIDTH = ROW_HEIGHT / 2;
const MAX_LANES = 16;
/** Columns in row order. The subject takes the space the others leave. */
const COLUMNS = ["graph", "subject", "author", "date", "hash"] as const;
type Widths = Record<Exclude<(typeof COLUMNS)[number], "subject">, number>;
const MIN_COLUMN_WIDTH = 24;
const LANE_COLORS = ["#56a8f5", "#73bd79", "#e5a14e", "#c77dbb", "#5fb8b3", "#e06c75", "#b0a160", "#8f9be8"];
export const REPO_COLORS = ["#3d7bd9", "#5a9e4b", "#c7853a", "#a2569a", "#3f9c98", "#c4545e", "#8f8440", "#6c76c9"];
const DATES = [
  { label: "Last 24 hours", days: 1 },
  { label: "Last 7 days", days: 7 },
  { label: "Last 30 days", days: 30 },
  { label: "Last year", days: 365 },
];

type Filters = { text: string; branch?: string; author?: string; days?: number; path?: string; excluded: string[] };
type RepoLog = { commits: LogCommit[]; complete: boolean; loading: boolean; error?: string };
type Query = { revs: Record<string, string[]>; params: Omit<LogParams, "repo" | "revs" | "skip"> };
type FilterPopup = { kind: "branch" | "author" | "date" | "repo"; at: Point };
type Dialog = { kind: "path" } | { kind: "branch" | "reset" | "reword"; row: LogRow };

/** Moves the boundary after column `index` by `delta`, resizing only the two columns beside it. */
function resizeColumns(widths: Widths, index: number, delta: number): Widths {
  const [left, right] = [COLUMNS[index], COLUMNS[index + 1]];
  const next = { ...widths };
  if (left !== "subject") next[left] = Math.max(MIN_COLUMN_WIDTH, widths[left] + delta);
  const moved = left === "subject" ? delta : next[left] - widths[left];
  if (right !== "subject") next[right] = Math.max(MIN_COLUMN_WIDTH, widths[right] - moved);
  if (left !== "subject" && right !== "subject") next[left] = widths[left] + widths[right] - next[right];
  return next;
}

/** Rows are keyed by repo and hash, since separate clones share commits. */
const rowKey = (row: LogRow) => `${row.repo}\0${row.commit.hash}`;

type Props = { session: Session; showBranches: boolean; onShowBranches: (show: boolean) => void };

/** The Log tab: commits of every repo, or filtered ones, with a branches tree, a graph, filters, and the selection's details. */
export function LogView({ session, showBranches, onShowBranches }: Props) {
  const allRepos = useSession(session, (s) => s.repos);
  const statuses = useSession(session, (s) => s.statuses);
  const home = useSession(session, (s) => s.info.home);
  const [filters, setFilters] = useState<Filters>({ text: "", excluded: [] });
  const [search, setSearch] = useState("");
  const [logs, setLogs] = useState<Record<string, RepoLog>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [anchor, setAnchor] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewHeight, setViewHeight] = useState(400);
  const [detailsWidth, setDetailsWidth] = useState(380);
  const [branchesWidth, setBranchesWidth] = useState(220);
  const [widths, setWidths] = useState<Widths>({ graph: 5 * LANE_WIDTH, author: 140, date: 140, hash: 70 });
  const [version, setVersion] = useState(0);
  const [popup, setPopup] = useState<FilterPopup>();
  const [menu, setMenu] = useState<Point>();
  const [dialog, setDialog] = useState<Dialog>();
  const [focus, setFocus] = useState<{ key: string; hash: string }>();
  const logFocus = useSession(session, (s) => s.logFocus);
  const query = useRef<Query>(undefined);
  const list = useRef<HTMLDivElement>(null);

  // One log per repo group: worktrees share their main repo's commits and branches.
  const repos = useMemo(() => {
    const groups = new Map<string, string>();
    for (const r of allRepos.filter((r) => !r.hidden)) {
      if (!groups.has(r.common_dir) || !r.is_worktree) groups.set(r.common_dir, r.path);
    }
    return [...groups.values()].sort();
  }, [allRepos]);
  const repoColor = (repo: string) => REPO_COLORS[repos.indexOf(repo) % REPO_COLORS.length];
  const included = repos.filter((r) => !filters.excluded.includes(r));

  // Reload when refs may have moved: any repo's HEAD, branch, or upstream counts.
  const refsKey = allRepos
    .map((r) => {
      const s = statuses[r.path]?.status;
      return s ? `${r.path}:${s.branch}:${s.head}:${s.ahead}:${s.behind}` : r.path;
    })
    .join("\n");

  useEffect(() => {
    const timer = setTimeout(() => setFilters((f) => (f.text === search ? f : { ...f, text: search })), 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    reload();
  }, [included.join("\n"), filters, refsKey, version]);

  async function reload() {
    const now = Math.floor(Date.now() / 1000);
    const params = {
      author: filters.author ?? null,
      text: filters.text.trim() || null,
      since: filters.days ? now - filters.days * 86400 : null,
      until: null,
      paths: filters.path ? [filters.path] : [],
      limit: PAGE,
    };
    let revs: Record<string, string[]> = Object.fromEntries(included.map((r) => [r, []]));
    const branch = filters.branch;
    if (branch) {
      // Repos without the branch drop out.
      const lists = await Promise.all(included.map((repo) => call("branches.list", { repo }).catch(() => undefined)));
      revs = {};
      included.forEach((repo, i) => {
        const b = lists[i];
        const has =
          branch === "HEAD" ||
          (b && (b.local.some((l) => l.name === branch) || b.remote.some((r) => `${r.remote}/${r.name}` === branch)));
        if (has) revs[repo] = [branch];
      });
    }
    const q: Query = { revs, params };
    query.current = q;
    const fresh = Object.fromEntries(Object.keys(revs).map((r) => [r, { commits: [], complete: false, loading: true }]));
    setLogs(fresh);
    Object.keys(revs).forEach((repo) => fetchPage(q, repo, 0));
  }

  async function fetchPage(q: Query, repo: string, skip: number) {
    try {
      const commits = await call("log", { repo, revs: q.revs[repo], ...q.params, skip });
      if (q !== query.current) return;
      setLogs((l) => ({
        ...l,
        [repo]: { commits: [...(l[repo]?.commits.slice(0, skip) ?? []), ...commits], complete: commits.length < PAGE, loading: false },
      }));
    } catch (e) {
      if (q !== query.current) return;
      setLogs((l) => ({ ...l, [repo]: { commits: l[repo]?.commits ?? [], complete: true, loading: false, error: String(e) } }));
    }
  }

  const { rows, blocked } = useMemo(
    () =>
      interleave(
        repos.filter((r) => logs[r]).map((r) => ({ repo: r, commits: logs[r].commits, complete: logs[r].complete })),
      ),
    [logs, repos],
  );
  const filtered = !!(filters.text.trim() || filters.author || filters.days || filters.path);
  const graph = useMemo(
    () =>
      filtered
        ? undefined
        : layoutGraph(rows.map((r) => ({ hash: rowKey(r), parents: r.commit.parents.map((p) => `${r.repo}\0${p}`) }))),
    [rows, filtered],
  );

  // Load the next page of the repo that holds the list back, once the view nears the end.
  const lastVisible = Math.ceil((scrollTop + viewHeight) / ROW_HEIGHT);
  useEffect(() => {
    const log = blocked ? logs[blocked] : undefined;
    if (!blocked || !log || log.loading || !query.current || rows.length - lastVisible > 100) return;
    setLogs((l) => ({ ...l, [blocked]: { ...l[blocked], loading: true } }));
    fetchPage(query.current, blocked, log.commits.length);
  }, [blocked, lastVisible, rows.length, logs]);

  useEffect(() => {
    const el = list.current!;
    const observer = new ResizeObserver(() => setViewHeight(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const selectedRows = useMemo(() => {
    const keys = new Set(selected);
    return rows.filter((r) => keys.has(rowKey(r)));
  }, [rows, selected]);

  function click(e: MouseEvent, index: number) {
    const key = rowKey(rows[index]);
    if (e.shiftKey) {
      const [from, to] = [Math.min(anchor, index), Math.max(anchor, index)];
      setSelected(rows.slice(from, to + 1).map(rowKey));
      return;
    }
    setAnchor(index);
    if (e.ctrlKey) setSelected((s) => (s.includes(key) ? s.filter((k) => k !== key) : [...s, key]));
    else setSelected([key]);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "c" && e.ctrlKey) {
      copyHashes(selectedRows);
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const current = rows.findIndex((r) => rowKey(r) === selected.at(-1));
    const index = Math.max(0, Math.min(rows.length - 1, current + (e.key === "ArrowDown" ? 1 : -1)));
    if (!rows[index]) return;
    if (e.shiftKey) {
      const [from, to] = [Math.min(anchor, index), Math.max(anchor, index)];
      const range = rows.slice(from, to + 1).map(rowKey);
      // Keep the moving end last, so the next arrow continues from it.
      setSelected([...range.filter((k) => k !== rowKey(rows[index])), rowKey(rows[index])]);
    } else {
      setAnchor(index);
      setSelected([rowKey(rows[index])]);
    }
    const el = list.current!;
    const top = index * ROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
  }

  function copyHashes(rows: LogRow[]) {
    if (rows.length === 0) return;
    navigator.clipboard
      .writeText(rows.map((r) => r.commit.hash).join(" "))
      .catch((e) => session.notify(`Failed to copy: ${e}`));
  }

  async function run(label: string, repo: string, work: () => Promise<unknown>) {
    try {
      await session.track(label, work);
    } catch (e) {
      session.notify(String(e));
    }
    session.refreshStatus(repo);
  }

  function actions(): MenuAction[] {
    const one = selectedRows.length === 1 ? selectedRows[0] : undefined;
    const needOne = one ? undefined : "Select one commit";
    const repo = new Set(selectedRows.map((r) => r.repo)).size === 1 ? selectedRows[0].repo : undefined;
    const status = repo ? statuses[repo]?.status : undefined;
    const busy = status?.operation ? `A ${status.operation.replace("_", "-")} is in progress` : undefined;
    const oneRepo = repo ? busy : "Select commits of one repository";
    const merge = selectedRows.some((r) => r.commit.parents.length > 1) ? "Merge commits can't be applied here" : undefined;
    // Commits apply oldest first, and revert newest first.
    const oldestFirst = selectedRows.map((r) => r.commit.hash).reverse();
    return [
      { label: "Copy Hash", hint: "Ctrl+C", run: () => copyHashes(selectedRows) },
      {
        label: "Create Patch",
        disabled: repo ? undefined : "Select commits of one repository",
        run: () =>
          repo &&
          call("patch.create_from_commits", { repo, revs: oldestFirst })
            .then((patch) => navigator.clipboard.writeText(patch))
            .then(() => session.notify("Copied the patch to the clipboard."))
            .catch((e) => session.notify(`Failed to create the patch: ${e}`)),
      },
      "separator",
      {
        label: "Cherry-Pick",
        disabled: oneRepo ?? merge,
        run: () => repo && run("Cherry-picking...", repo, () => call("cherry_pick", { repo, revs: oldestFirst })),
      },
      {
        label: "Revert Commit",
        disabled: oneRepo ?? merge,
        run: () =>
          repo && run("Reverting...", repo, () => call("revert", { repo, revs: selectedRows.map((r) => r.commit.hash) })),
      },
      {
        label: "Undo Commit",
        disabled:
          needOne ??
          (one!.commit.head ? undefined : "Only the commit at HEAD can be undone") ??
          (one!.commit.parents.length === 1 ? undefined : "Only a commit with one parent can be undone") ??
          busy,
        run: () => one && run("Undoing the commit...", one.repo, () => call("commit.undo", { repo: one.repo })),
      },
      {
        label: "Edit Commit Message...",
        disabled: needOne ?? (one!.commit.parents.length > 1 ? "Merge commits can't be edited" : busy),
        run: () => one && setDialog({ kind: "reword", row: one }),
      },
      "separator",
      {
        label: "Checkout Revision",
        disabled: needOne,
        run: () =>
          one &&
          run("Checking out...", one.repo, () =>
            call("checkout", { repo: one.repo, target: { kind: "revision", rev: one.commit.hash } }),
          ),
      },
      { label: "New Branch...", disabled: needOne, run: () => one && setDialog({ kind: "branch", row: one }) },
      {
        label: `Reset ${status?.branch ?? "HEAD"} to Here...`,
        disabled: needOne ?? busy,
        run: () => one && setDialog({ kind: "reset", row: one }),
      },
    ];
  }

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 10);
  const visible = rows.slice(first, lastVisible + 10);
  const loading = Object.values(logs).some((l) => l.loading);

  useEffect(() => {
    if (!logFocus) return;
    session.clearLogFocus();
    const commonDir = allRepos.find((r) => r.path === logFocus.repo)?.common_dir;
    const group = repos.find((g) => allRepos.find((r) => r.path === g)?.common_dir === commonDir) ?? logFocus.repo;
    setFocus({ key: `${group}\0${logFocus.hash}`, hash: logFocus.hash });
  }, [logFocus]);

  // Select the focused commit once loaded, searching for it by hash when the current filters hide it.
  useEffect(() => {
    if (!focus) return;
    const index = rows.findIndex((r) => rowKey(r) === focus.key);
    if (index >= 0) {
      setFocus(undefined);
      setAnchor(index);
      setSelected([focus.key]);
      const el = list.current!;
      el.scrollTop = Math.max(0, index * ROW_HEIGHT - el.clientHeight / 2);
    } else if (loading || Object.keys(logs).length === 0) {
      return;
    } else if (filters.text === focus.hash) {
      setFocus(undefined);
      session.notify(`Failed to find commit ${focus.hash.slice(0, 8)} in the log`);
    } else {
      setSearch(focus.hash);
      setFilters({ text: focus.hash, excluded: [] });
    }
  }, [focus, rows, loading]);
  const errors = Object.entries(logs).filter(([, l]) => l.error);
  const authors = useMemo(() => [...new Set(rows.map((r) => r.commit.author_name))].sort(), [rows]);
  const multiRepo = included.length > 1;
  // The gap after column `index`, which drags to resize the columns beside it.
  const resizer = (index: number) => (
    <span
      className="log-column-resizer"
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => startDrag(e, "vertical", (d) => setWidths((w) => resizeColumns(w, index, d)))}
    />
  );

  return (
    <div className="log-view">
      <div className="log-toolbar">
        <button
          className={`icon-button ${showBranches ? "active" : ""}`}
          title="Show Branches"
          aria-pressed={showBranches}
          onClick={() => onShowBranches(!showBranches)}
        >
          <GitBranch size={16} />
        </button>
        <label className="log-search">
          <Search size={14} className="secondary" />
          <input
            placeholder="Text or hash"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && setFilters((f) => ({ ...f, text: search }))}
          />
        </label>
        <FilterButton
          label="Branch"
          value={filters.branch}
          onOpen={(at) => setPopup({ kind: "branch", at })}
          onClear={() => setFilters((f) => ({ ...f, branch: undefined }))}
        />
        <FilterButton
          label="User"
          value={filters.author}
          onOpen={(at) => setPopup({ kind: "author", at })}
          onClear={() => setFilters((f) => ({ ...f, author: undefined }))}
        />
        <FilterButton
          label="Date"
          value={DATES.find((d) => d.days === filters.days)?.label}
          onOpen={(at) => setPopup({ kind: "date", at })}
          onClear={() => setFilters((f) => ({ ...f, days: undefined }))}
        />
        <FilterButton
          label="Path"
          value={filters.path}
          onOpen={() => setDialog({ kind: "path" })}
          onClear={() => setFilters((f) => ({ ...f, path: undefined }))}
        />
        {repos.length > 1 && (
          <FilterButton
            label="Repositories"
            value={filters.excluded.length ? `${included.length} of ${repos.length}` : undefined}
            onOpen={(at) => setPopup({ kind: "repo", at })}
            onClear={() => setFilters((f) => ({ ...f, excluded: [] }))}
          />
        )}
        <span className="spacer" />
        {loading && <RefreshCw size={14} className="secondary spin" />}
        <button className="icon-button" title="Refresh" onClick={() => setVersion((v) => v + 1)}>
          <RefreshCw size={16} />
        </button>
      </div>
      <div className="log-body">
        {showBranches && (
          <>
            <div className="log-branches-pane" style={{ width: branchesWidth }}>
              <BranchesPanel
                session={session}
                repos={included}
                reloadKey={`${refsKey}\n${version}`}
                repoColor={repoColor}
                onFilter={(branch) => setFilters((f) => ({ ...f, branch }))}
              />
            </div>
            <Splitter direction="vertical" onResize={(d) => setBranchesWidth((w) => Math.max(120, Math.min(600, w + d)))} />
          </>
        )}
        <div
          ref={list}
          className="tree log-list"
          tabIndex={0}
          onKeyDown={onKeyDown}
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        >
          {errors.map(([repo, l]) => (
            <div key={repo} className="error-text tree-message">
              {repoName({ path: repo }, home)}: {l.error}
            </div>
          ))}
          {!loading && rows.length === 0 && errors.length === 0 && (
            <div className="secondary tree-message">{included.length === 0 ? "No repositories" : "No commits"}</div>
          )}
          <div style={{ height: rows.length * ROW_HEIGHT, position: "relative" }}>
            {visible.map((row, i) => {
              const index = first + i;
              const key = rowKey(row);
              const branch = statuses[row.repo]?.status?.branch;
              return (
                <div
                  key={key}
                  className={`tree-row log-row ${selected.includes(key) ? "selected" : ""}`}
                  style={{ top: index * ROW_HEIGHT }}
                  onMouseDown={(e) => e.button === 0 && click(e, index)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (!selected.includes(key)) {
                      setAnchor(index);
                      setSelected([key]);
                    }
                    setMenu({ x: e.clientX, y: e.clientY });
                  }}
                >
                  {multiRepo && (
                    <span
                      className="log-repo-marker"
                      style={{ background: repoColor(row.repo) }}
                      title={repoName({ path: row.repo }, home)}
                    />
                  )}
                  {graph && <GraphCell row={graph[index]} above={graph[index - 1]} width={widths.graph} head={row.commit.head} />}
                  {graph && resizer(0)}
                  <span className="log-subject">
                    {row.commit.head && !row.commit.refs.some((r) => r.kind === "local" && r.name === branch) && (
                      <span className="log-ref head">HEAD</span>
                    )}
                    {row.commit.refs.map((r) => (
                      <span
                        key={`${r.kind}:${r.name}`}
                        className={`log-ref ${r.kind} ${row.commit.head && r.kind === "local" && r.name === branch ? "current" : ""}`}
                      >
                        {r.name}
                      </span>
                    ))}
                    {row.commit.subject}
                  </span>
                  {resizer(1)}
                  <span className="log-author secondary" style={{ width: widths.author }}>
                    {row.commit.author_name}
                  </span>
                  {resizer(2)}
                  <span className="log-date secondary" style={{ width: widths.date }}>
                    {formatTime(row.commit.author_time)}
                  </span>
                  {resizer(3)}
                  <span className="log-hash secondary mono" style={{ width: widths.hash }}>
                    {row.commit.hash.slice(0, 8)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
        <Splitter direction="vertical" onResize={(d) => setDetailsWidth((w) => Math.max(200, Math.min(900, w - d)))} />
        <div className="log-details" style={{ width: detailsWidth }}>
          <CommitDetails session={session} rows={selectedRows} multiRepo={multiRepo} />
        </div>
      </div>
      {popup?.kind === "branch" && (
        <BranchFilter
          repos={included}
          at={popup.at}
          onPick={(branch) => setFilters((f) => ({ ...f, branch }))}
          onClose={() => setPopup(undefined)}
        />
      )}
      {popup?.kind === "author" && (
        <PickList
          at={popup.at}
          items={authors}
          placeholder="Name or email"
          onPick={(author) => setFilters((f) => ({ ...f, author }))}
          onClose={() => setPopup(undefined)}
        />
      )}
      {popup?.kind === "date" && (
        <Menu
          at={popup.at}
          onClose={() => setPopup(undefined)}
          actions={DATES.map((d) => ({ label: d.label, run: () => setFilters((f) => ({ ...f, days: d.days })) }))}
        />
      )}
      {popup?.kind === "repo" && (
        <Popup at={popup.at} onClose={() => setPopup(undefined)}>
          <div className="popup-list log-repo-list">
            {repos.map((repo) => (
              <label key={repo} className="popup-item">
                <input
                  type="checkbox"
                  checked={!filters.excluded.includes(repo)}
                  onChange={(e) =>
                    setFilters((f) => ({
                      ...f,
                      excluded: e.target.checked ? f.excluded.filter((r) => r !== repo) : [...f.excluded, repo],
                    }))
                  }
                />
                <span className="log-repo-marker" style={{ background: repoColor(repo) }} />
                {repoName({ path: repo }, home)}
              </label>
            ))}
          </div>
        </Popup>
      )}
      {menu && <Menu at={menu} actions={actions()} onClose={() => setMenu(undefined)} />}
      {dialog?.kind === "path" && (
        <InputDialog
          title="Filter by Path"
          label="Path relative to the repository root"
          initial={filters.path}
          confirmLabel="Filter"
          onConfirm={async (path) => setFilters((f) => ({ ...f, path }))}
          onClose={() => setDialog(undefined)}
        />
      )}
      {dialog?.kind === "reset" && (
        <ResetDialog
          row={dialog.row}
          branch={statuses[dialog.row.repo]?.status?.branch ?? undefined}
          onDone={() => session.refreshStatus(dialog.row.repo)}
          onClose={() => setDialog(undefined)}
        />
      )}
      {dialog?.kind === "reword" && (
        <RewordDialog
          row={dialog.row}
          onDone={() => session.refreshStatus(dialog.row.repo)}
          onClose={() => setDialog(undefined)}
        />
      )}
      {dialog?.kind === "branch" && (
        <InputDialog
          title={`New Branch from ${dialog.row.commit.hash.slice(0, 8)}`}
          label="Branch name"
          confirmLabel="Create"
          onConfirm={async (name) => {
            const repo = dialog.row.repo;
            await call("branch.create", { repo, name, start: dialog.row.commit.hash, checkout: true });
            session.refreshStatus(repo);
          }}
          onClose={() => setDialog(undefined)}
        />
      )}
    </div>
  );
}

/**
 * One row of the commit graph: the lines from the row above, the lines leaving this row, and the commit. It is `width`
 * wide, or wider when its lanes need more.
 */
function GraphCell({ row, above, width, head }: { row: GraphRow; above?: GraphRow; width: number; head: boolean }) {
  const segments = [...row.segments, ...(above?.segments ?? [])];
  const lanes = Math.min(MAX_LANES, Math.max(row.lane, ...segments.flatMap((s) => [s.from, s.to])) + 1);
  const x = (lane: number) => Math.min(lane, MAX_LANES - 1) * LANE_WIDTH + LANE_WIDTH / 2;
  const mid = ROW_HEIGHT / 2;
  const color = (c: number) => LANE_COLORS[c % LANE_COLORS.length];
  // A lane change is a 45 degree diagonal: at the start for merge lines, which leave beside the first parent's line,
  // and otherwise at the end. Changes too wide for one row run straight.
  const path = (s: Segment, y: number) => {
    const [x1, x2, y2] = [x(s.from), x(s.to), y + ROW_HEIGHT];
    const run = Math.abs(x2 - x1);
    if (run === 0 || run >= ROW_HEIGHT) return `M${x1} ${y}L${x2} ${y2}`;
    return s.merge ? `M${x1} ${y}L${x2} ${y + run}L${x2} ${y2}` : `M${x1} ${y}L${x1} ${y2 - run}L${x2} ${y2}`;
  };
  const lines = (r: GraphRow, y: number, key: string) =>
    r.segments.map((s, i) => (
      <path key={key + i} d={path(s, y)} fill="none" stroke={color(s.color)} strokeWidth={2} strokeLinejoin="round" />
    ));
  return (
    <svg className="log-graph" width={Math.max(width, lanes * LANE_WIDTH)} height={ROW_HEIGHT}>
      {above && lines(above, mid - ROW_HEIGHT, "above")}
      {lines(row, mid, "")}
      <circle
        cx={x(row.lane)}
        cy={mid}
        r={head ? 4.5 : 3.5}
        fill={head ? "var(--bg-editor)" : color(row.color)}
        stroke={color(row.color)}
        strokeWidth={head ? 2 : 0}
      />
    </svg>
  );
}

function FilterButton(props: { label: string; value?: string; onOpen: (at: Point) => void; onClear: () => void }) {
  return (
    <span className={`log-filter ${props.value ? "set" : ""}`}>
      <button onClick={(e) => props.onOpen(below(e.currentTarget))}>
        {props.label}
        {props.value && `: ${props.value}`}
        {!props.value && <ChevronDown size={14} />}
      </button>
      {props.value && (
        <button className="log-filter-clear" title={`Clear ${props.label.toLowerCase()} filter`} onClick={props.onClear}>
          <X size={12} />
        </button>
      )}
    </span>
  );
}

/** A searchable list; Enter picks the typed text when nothing matches. */
function PickList(props: {
  at: Point;
  items: string[];
  placeholder: string;
  onPick: (item: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const matches = props.items.filter((i) => i.toLowerCase().includes(text.trim().toLowerCase()));
  const pick = (item: string) => {
    props.onClose();
    props.onPick(item);
  };
  return (
    <Popup at={props.at} onClose={props.onClose}>
      <input
        className="popup-search log-pick-search"
        autoFocus
        placeholder={props.placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (matches[0] ?? text.trim())) pick(matches[0] ?? text.trim());
        }}
      />
      <div className="popup-list">
        {matches.map((item) => (
          <button key={item} className="popup-item" onClick={() => pick(item)}>
            {item}
          </button>
        ))}
        {matches.length === 0 && text.trim() && (
          <button className="popup-item" onClick={() => pick(text.trim())}>
            Use "{text.trim()}"
          </button>
        )}
      </div>
    </Popup>
  );
}

/** Branch names across the given repos, local first, then remote. */
function BranchFilter(props: { repos: string[]; at: Point; onPick: (branch: string) => void; onClose: () => void }) {
  const [names, setNames] = useState<string[]>();
  useEffect(() => {
    Promise.all(props.repos.map((repo) => call("branches.list", { repo }).catch(() => undefined))).then((lists) => {
      const local = new Set<string>();
      const remote = new Set<string>();
      for (const b of lists) {
        b?.local.forEach((l) => local.add(l.name));
        b?.remote.forEach((r) => remote.add(`${r.remote}/${r.name}`));
      }
      setNames([...[...local].sort(), ...[...remote].sort()]);
    });
  }, []);
  if (!names) {
    return (
      <Popup at={props.at} onClose={props.onClose}>
        <div className="secondary tree-message">Loading...</div>
      </Popup>
    );
  }
  return <PickList at={props.at} items={names} placeholder="Branch" onPick={props.onPick} onClose={props.onClose} />;
}

/** Time today, or the date and time. */
export function formatTime(secs: number): string {
  const date = new Date(secs * 1000);
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === new Date().toDateString()) return `Today ${time}`;
  return `${date.toLocaleDateString()} ${time}`;
}
