import { useEffect, useState } from "react";
import { FileText } from "lucide-react";
import type { FileChange } from "../protocol.gen";
import { call } from "../api";
import { useSession, type Session } from "../workspace/session";
import { baseName, dirName, repoName } from "../workspace/repos";
import type { LogRow } from "./interleave";
import { formatTime } from "./LogView";

/**
 * Changes of a chain of selected commits in one repo: from the oldest's first parent (None for a root commit) to the
 * newest. `label` heads the range's files when the selection has several ranges or commits.
 */
type Range = { repo: string; oldest: string; from?: string; to: string; count: number; label?: string };

/**
 * The selection's changed files and, for one commit, its message. Several commits in one repo show their combined
 * changes when each one's first parent is the next; otherwise each commit's files show separately.
 */
export function CommitDetails({ session, rows, multiRepo }: { session: Session; rows: LogRow[]; multiRepo: boolean }) {
  const home = useSession(session, (s) => s.info.home);
  const ranges = toRanges(rows);
  const key = ranges.map(rangeKey).join("\n");
  const [files, setFiles] = useState<Record<string, FileChange[] | string>>({});
  const [message, setMessage] = useState<string>();
  const single = rows.length === 1 ? rows[0] : undefined;

  useEffect(() => {
    setFiles({});
    let stale = false;
    for (const range of ranges) {
      const load =
        range.count === 1
          ? call("commit.files", { repo: range.repo, rev: range.to })
          : call("diff.files", { repo: range.repo, from: range.from ?? null, to: range.to });
      load
        .then((list) => !stale && setFiles((f) => ({ ...f, [rangeKey(range)]: list })))
        .catch((e) => !stale && setFiles((f) => ({ ...f, [rangeKey(range)]: String(e) })));
    }
    return () => {
      stale = true;
    };
  }, [key]);

  useEffect(() => {
    setMessage(undefined);
    if (!single) return;
    let stale = false;
    call("commit.message", { repo: single.repo, rev: single.commit.hash })
      .then((text) => !stale && setMessage(text))
      .catch((e) => !stale && setMessage(String(e)));
    return () => {
      stale = true;
    };
  }, [single?.repo, single?.commit.hash]);

  if (rows.length === 0) return <div className="secondary tree-message">Select a commit to see its changes</div>;

  function open(range: Range, change: FileChange) {
    if (range.count === 1) session.openCommitDiff(range.repo, range.to, change);
    else session.openRevDiff(range.repo, range.from ?? `${range.oldest}^1`, range.to, change);
  }

  return (
    <div className="commit-details">
      <div className="tree commit-files" tabIndex={-1}>
        {ranges.map((range) => {
          const list = files[rangeKey(range)];
          return (
            <div key={rangeKey(range)}>
              {(multiRepo || range.label) && (
                <div className="tree-row commit-range secondary">
                  {multiRepo && <span>{repoName({ path: range.repo }, home)}</span>}
                  {range.label && <span className="commit-range-label">{range.label}</span>}
                </div>
              )}
              {list === undefined && <div className="secondary tree-message">Loading...</div>}
              {typeof list === "string" && <div className="error-text tree-message">{list}</div>}
              {Array.isArray(list) &&
                list.map((f) => (
                  <div
                    key={f.path}
                    className="tree-row"
                    title={f.orig_path ? `Renamed from ${f.orig_path}` : f.path}
                    onDoubleClick={() => open(range, f)}
                  >
                    <FileText size={14} className="secondary" />
                    <span className={`status-${f.kind}`}>{baseName(f.path)}</span>
                    <span className="secondary">{dirName(f.path)}</span>
                  </div>
                ))}
            </div>
          );
        })}
      </div>
      {single && (
        <div className="commit-message">
          <div className="commit-message-text">{message ?? single.commit.subject}</div>
          <div className="secondary">
            <span className="mono">{single.commit.hash.slice(0, 8)}</span> {single.commit.author_name} &lt;
            {single.commit.author_email}&gt; on {formatTime(single.commit.author_time)}
          </div>
          {single.commit.refs.length > 0 && (
            <div className="commit-refs">
              {single.commit.refs.map((r) => (
                <span key={`${r.kind}:${r.name}`} className={`log-ref ${r.kind}`}>
                  {r.name}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Groups selected rows (newest first) by repo, into one range per first-parent chain or else one per commit. */
function toRanges(rows: LogRow[]): Range[] {
  const byRepo = new Map<string, LogRow[]>();
  for (const row of rows) byRepo.set(row.repo, [...(byRepo.get(row.repo) ?? []), row]);
  const several = rows.length > 1;
  return [...byRepo].flatMap(([repo, list]): Range[] => {
    const chain = list.every((row, i) => i === list.length - 1 || row.commit.parents[0] === list[i + 1].commit.hash);
    if (chain) {
      const oldest = list[list.length - 1].commit;
      const label = several ? (list.length > 1 ? `${list.length} commits` : list[0].commit.subject) : undefined;
      return [{ repo, oldest: oldest.hash, from: oldest.parents[0], to: list[0].commit.hash, count: list.length, label }];
    }
    return list.map(({ commit: c }) => ({ repo, oldest: c.hash, from: c.parents[0], to: c.hash, count: 1, label: c.subject }));
  });
}

function rangeKey(range: Range) {
  return `${range.repo}\0${range.from}\0${range.to}`;
}
