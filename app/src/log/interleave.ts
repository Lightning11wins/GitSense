import type { LogCommit } from "../protocol.gen";

/** One repo's loaded commits. `complete` means none are left to load. */
export type RepoLog = { repo: string; commits: readonly LogCommit[]; complete: boolean };

export type LogRow = { repo: string; commit: LogCommit };

/**
 * Interleaves repos' commits newest first by commit date, keeping each repo's own order. Stops where an incomplete
 * repo runs out of loaded commits, since its next one could be newer than the rest; `blocked` names that repo.
 */
export function interleave(logs: readonly RepoLog[]): { rows: LogRow[]; blocked?: string } {
  const next = logs.map(() => 0);
  const rows: LogRow[] = [];
  for (;;) {
    const blocked = logs.find((log, i) => !log.complete && next[i] === log.commits.length);
    if (blocked) return { rows, blocked: blocked.repo };
    let pick = -1;
    logs.forEach((log, i) => {
      if (next[i] === log.commits.length) return;
      if (pick < 0 || log.commits[next[i]].commit_time > logs[pick].commits[next[pick]].commit_time) pick = i;
    });
    if (pick < 0) return { rows };
    rows.push({ repo: logs[pick].repo, commit: logs[pick].commits[next[pick]++] });
  }
}
