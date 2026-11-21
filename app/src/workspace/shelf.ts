// Shelf entries across repos, and what a selection of them unshelves.
import type { ShelfEntry } from "../protocol.gen";

/** A shelf entry and the repo it belongs to. */
export type ShelfItem = { repo: string; entry: ShelfEntry };

/** Files of a shelf entry to unshelve, or null for the whole entry. */
export type ShelfTarget = { item: ShelfItem; paths: string[] | null };

/** Tree row key of an entry. */
export function entryRowKey(item: ShelfItem): string {
  return `entry\0${item.repo}\0${item.entry.id}`;
}

/** Tree row key of one of an entry's files. */
export function fileRowKey(item: ShelfItem, path: string): string {
  return `file\0${item.repo}\0${item.entry.id}\0${path}`;
}

/** Entries of every repo, newest first. */
export function sortedItems(shelves: [string, ShelfEntry[]][]): ShelfItem[] {
  const items = shelves.flatMap(([repo, entries]) => entries.map((entry) => ({ repo, entry })));
  return items.sort((a, b) => b.entry.created - a.entry.created || (a.entry.id < b.entry.id ? 1 : a.entry.id > b.entry.id ? -1 : 0));
}

/** What the selected rows stand for, in entry order: whole entries for entry rows, else their selected files. */
export function shelfTargets(items: ShelfItem[], selected: ReadonlySet<string>): ShelfTarget[] {
  return items.flatMap((item): ShelfTarget[] => {
    if (selected.has(entryRowKey(item))) return [{ item, paths: null }];
    const paths = item.entry.files.map((f) => f.path).filter((path) => selected.has(fileRowKey(item, path)));
    return paths.length ? [{ item, paths }] : [];
  });
}
