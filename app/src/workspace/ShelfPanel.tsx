import { useEffect, useState, type ReactNode } from "react";
import { Archive, ChevronDown, ChevronRight, FileText, RefreshCw } from "lucide-react";
import type { FileChange, ShelfEntry } from "../protocol.gen";
import { call } from "../api";
import { useSession, type Session } from "./session";
import { baseName, dirName, repoName } from "./repos";
import { Menu, type Point } from "./Popup";
import { ConfirmDialog } from "./ConfirmDialog";
import { entryRowKey, fileRowKey, shelfTargets, sortedItems, type ShelfItem, type ShelfTarget } from "./shelf";
import { formatTime } from "../log/LogView";
import "./CommitPanel.css";

type Row = { key: string; depth: number; item: ShelfItem; file?: FileChange; open?: boolean };
type Dialog = { kind: "unshelve"; targets: ShelfTarget[]; remove: boolean } | { kind: "delete"; items: ShelfItem[] };

/** The Shelf tab: shelved changes of every visible repo, newest first. `tabs` switches the tool window's tab. */
export function ShelfPanel({ session, tabs }: { session: Session; tabs: ReactNode }) {
  const repos = useSession(session, (s) => s.repos);
  const shelves = useSession(session, (s) => s.shelves);
  const home = useSession(session, (s) => s.info.home);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string>();
  const [menuAt, setMenuAt] = useState<Point>();
  const [dialog, setDialog] = useState<Dialog>();
  const [error, setError] = useState<string>();

  const visible = repos.filter((r) => !r.hidden);
  const visibleKey = visible.map((r) => r.path).join("\0");
  const refresh = () => visible.forEach((r) => session.refreshShelf(r.path));
  useEffect(refresh, [session, visibleKey]);

  const items = sortedItems(visible.flatMap((r) => (shelves[r.path]?.entries ? [[r.path, shelves[r.path].entries!]] : [])));
  const errors = visible.flatMap((r) => (shelves[r.path]?.error ? [shelves[r.path].error!] : []));
  const rows: Row[] = [];
  for (const item of items) {
    const key = entryRowKey(item);
    const open = expanded.has(key);
    rows.push({ key, depth: 0, item, open });
    if (open) for (const file of item.entry.files) rows.push({ key: fileRowKey(item, file.path), depth: 1, item, file });
  }

  const targets = shelfTargets(items, selected);
  const wholeEntries = targets.filter((t) => t.paths === null).map((t) => t.item);

  function toggle(key: string) {
    setExpanded((old) => {
      const next = new Set(old);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  function select(key: string, e: { ctrlKey: boolean; shiftKey: boolean }) {
    if (e.shiftKey && anchor) {
      const a = rows.findIndex((r) => r.key === anchor);
      const b = rows.findIndex((r) => r.key === key);
      if (a >= 0 && b >= 0) {
        setSelected(new Set(rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((r) => r.key)));
        return;
      }
    }
    if (e.ctrlKey) {
      setSelected((old) => {
        const next = new Set(old);
        if (!next.delete(key)) next.add(key);
        return next;
      });
    } else {
      setSelected(new Set([key]));
    }
    setAnchor(key);
  }

  /** Shows the first selected file's diff, or the first file of the first selected entry. */
  function showDiff() {
    const target = targets[0];
    if (!target) return;
    const path = target.paths?.[0];
    const file = target.item.entry.files.find((f) => path === undefined || f.path === path);
    if (!file) return;
    setError(undefined);
    session.openShelvedDiff(target.item.repo, target.item.entry, file).catch((e) => setError(String(e)));
  }

  async function unshelve(targets: ShelfTarget[], remove: boolean) {
    setError(undefined);
    const failures: string[] = [];
    for (const { item, paths } of targets) {
      try {
        await call("shelf.unshelve", { repo: item.repo, id: item.entry.id, paths, keep: !remove });
      } catch (e) {
        failures.push(String(e));
      }
      session.refreshStatus(item.repo);
      session.refreshShelf(item.repo);
    }
    // Failed unshelves may have changed the working tree, such as by leaving conflicts, so they show here.
    if (failures.length) setError(failures.join("\n"));
  }

  async function remove(items: ShelfItem[]) {
    const failures: string[] = [];
    for (const item of items) {
      try {
        await call("shelf.delete", { repo: item.repo, id: item.entry.id });
      } catch (e) {
        failures.push(String(e));
      }
      session.refreshShelf(item.repo);
    }
    if (failures.length) throw new Error(failures.join("\n"));
  }

  const askUnshelve = () => targets.length && setDialog({ kind: "unshelve", targets, remove: true });
  const askDelete = () => wholeEntries.length && setDialog({ kind: "delete", items: wholeEntries });

  function onKey(e: React.KeyboardEvent) {
    const index = rows.findIndex((r) => r.key === anchor);
    const row = rows[index];
    const key = e.key.toLowerCase();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const next = rows[Math.max(0, Math.min(rows.length - 1, index + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next) select(next.key, { ctrlKey: false, shiftKey: e.shiftKey });
    } else if ((e.key === "ArrowRight" && row?.open === false) || (e.key === "ArrowLeft" && row?.open)) {
      toggle(row.key);
    } else if (e.key === "Enter" || (e.ctrlKey && !e.altKey && key === "d")) {
      showDiff();
    } else if (e.key === "Delete") {
      askDelete();
    } else {
      return;
    }
    e.preventDefault();
  }

  function openMenu(e: React.MouseEvent, key: string) {
    e.preventDefault();
    if (!selected.has(key)) {
      setSelected(new Set([key]));
      setAnchor(key);
    }
    setMenuAt({ x: e.clientX, y: e.clientY });
  }

  const severalRepos = visible.length > 1;
  return (
    <div className="commit-panel">
      <div className="tool-window-header">
        {tabs}
        <span className="spacer" />
        <button className="icon-button" title="Refresh" onClick={refresh}>
          <RefreshCw size={16} />
        </button>
      </div>
      <div className="tree changes-tree" tabIndex={0} onKeyDown={onKey}>
        {errors.map((message, i) => (
          <div key={i} className="error-text tree-message">
            {message}
          </div>
        ))}
        {rows.map((row) => (
          <div
            key={row.key}
            className={`tree-row ${selected.has(row.key) ? "selected" : ""}`}
            style={{ paddingLeft: 4 + row.depth * 16 }}
            title={row.file ? `${row.item.repo}/${row.file.path}` : row.item.entry.message}
            onMouseDown={(e) => e.button === 0 && select(row.key, e)}
            onDoubleClick={() => (row.file ? showDiff() : toggle(row.key))}
            onContextMenu={(e) => openMenu(e, row.key)}
          >
            <span
              className="chevron"
              onMouseDown={(e) => {
                e.stopPropagation();
                if (row.open !== undefined) toggle(row.key);
              }}
            >
              {row.open === undefined ? null : row.open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </span>
            {row.file ? (
              <>
                <FileText size={14} className="secondary" />
                <span className={`label status-${row.file.kind}`}>{baseName(row.file.path)}</span>
                <span className="hint">{dirName(row.file.path)}</span>
              </>
            ) : (
              <EntryLabel entry={row.item.entry} repo={severalRepos ? repoName({ path: row.item.repo }, home) : undefined} />
            )}
          </div>
        ))}
        {items.length === 0 && errors.length === 0 && <div className="secondary tree-message">No shelved changes</div>}
      </div>
      {error && <div className="error-text commit-error tree-message">{error}</div>}
      {menuAt && (
        <Menu
          at={menuAt}
          onClose={() => setMenuAt(undefined)}
          actions={[
            { label: "Unshelve...", disabled: targets.length ? undefined : "Select shelved changes", run: askUnshelve },
            { label: "Show Diff", hint: "Ctrl+D", disabled: targets.length ? undefined : "Select shelved changes", run: showDiff },
            "separator",
            {
              label: "Delete...",
              hint: "Delete",
              disabled: wholeEntries.length ? undefined : "Select whole shelved changelists to delete",
              run: askDelete,
            },
            "separator",
            { label: "Refresh", run: refresh },
          ]}
        />
      )}
      {dialog?.kind === "unshelve" && (
        <ConfirmDialog
          title="Unshelve Changes"
          confirmLabel="Unshelve"
          onClose={() => setDialog(undefined)}
          onConfirm={() => unshelve(dialog.targets, dialog.remove)}
        >
          <p>Apply these shelved changes to the working tree?</p>
          <div className="dialog-list">
            {dialog.targets.map(({ item, paths }) => (
              <div key={entryRowKey(item)} className="check-row">
                <EntryLabel
                  entry={item.entry}
                  repo={severalRepos ? repoName({ path: item.repo }, home) : undefined}
                  count={paths?.length}
                />
              </div>
            ))}
          </div>
          <label>
            <input type="checkbox" checked={dialog.remove} onChange={(e) => setDialog({ ...dialog, remove: e.target.checked })} />
            Remove successfully unshelved files from the shelf
          </label>
        </ConfirmDialog>
      )}
      {dialog?.kind === "delete" && (
        <ConfirmDialog title="Delete Shelved Changes" confirmLabel="Delete" onClose={() => setDialog(undefined)} onConfirm={() => remove(dialog.items)}>
          <p>
            Delete {dialog.items.length === 1 ? "this shelved changelist" : `these ${dialog.items.length} shelved changelists`}? Their
            changes will be lost.
          </p>
          <div className="dialog-list">
            {dialog.items.map((item) => (
              <div key={entryRowKey(item)} className="check-row">
                <EntryLabel entry={item.entry} repo={severalRepos ? repoName({ path: item.repo }, home) : undefined} />
              </div>
            ))}
          </div>
        </ConfirmDialog>
      )}
    </div>
  );
}

/** An entry's message, time, repo when given, and file count, or `count` of its files when given. */
function EntryLabel({ entry, repo, count }: { entry: ShelfEntry; repo?: string; count?: number }) {
  const total = entry.files.length;
  const files = count === undefined ? (total === 1 ? "1 file" : `${total} files`) : `${count} of ${total} files`;
  return (
    <>
      <Archive size={14} className="secondary" />
      <span className="label">{entry.message}</span>
      <span className="hint">
        {[repo, formatTime(entry.created), files].filter(Boolean).join(" · ")}
      </span>
    </>
  );
}
