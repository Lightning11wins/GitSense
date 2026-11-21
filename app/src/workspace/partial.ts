// Partial commits: the changed chunks of a file, which of them to commit, and the text that results.
import { Chunk } from "@codemirror/merge";
import { Text } from "@codemirror/state";

/** Diff settings for the diff view and partial commits, so both find the same chunks. */
export const DIFF_CONFIG = { scanLimit: 500 };

/** Half-open range of line indexes, 0-based. */
export type LineRange = { from: number; to: number };

/**
 * A changed chunk between HEAD (`a`) and the working tree (`b`). `key` depends only on the chunk's own
 * text, so it stays the same when other parts of the file change.
 */
export type KeyedChunk = { key: string; a: LineRange; b: LineRange };

/** The line separator the diff view uses for `text`. */
export function lineSeparator(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** `text` as a document split the way the diff view splits it. */
export function toDoc(text: string): Text {
  return Text.of(text.split(lineSeparator(text)));
}

/** The changed chunks between two documents, as the diff view shows them, in order. */
export function keyedChunks(a: Text, b: Text): KeyedChunk[] {
  const seen = new Map<string, number>();
  return Chunk.build(a, b, DIFF_CONFIG).map((chunk) => {
    const ra = lineRange(a, chunk.fromA, chunk.toA);
    const rb = lineRange(b, chunk.fromB, chunk.toB);
    const content = JSON.stringify([rangeText(a, ra), rangeText(b, rb)]);
    // Chunks with the same text are told apart by their order.
    const n = seen.get(content) ?? 0;
    seen.set(content, n + 1);
    return { key: n ? `${content}#${n}` : content, a: ra, b: rb };
  });
}

/** HEAD text with the working tree's chunks applied, except those whose keys are in `excluded`. */
export function partialText(head: string, work: string, excluded: ReadonlySet<string>): string {
  const linesA = linesWithEndings(head);
  const linesB = linesWithEndings(work);
  let out = "";
  let at = 0;
  for (const chunk of keyedChunks(toDoc(head), toDoc(work))) {
    out += linesA.slice(at, chunk.a.from).join("");
    out += excluded.has(chunk.key)
      ? linesA.slice(chunk.a.from, chunk.a.to).join("")
      : linesB.slice(chunk.b.from, chunk.b.to).join("");
    at = chunk.a.to;
  }
  return out + linesA.slice(at).join("");
}

/**
 * Excluded chunk keys after excluding or including one chunk. `excluded` is "all" when the whole file
 * is excluded. `keys` are the file's current chunk keys. Returns "all" when every chunk ends up
 * excluded, and drops keys of chunks that no longer exist.
 */
export function toggleChunk(
  excluded: readonly string[] | "all",
  keys: readonly string[],
  key: string,
  included: boolean,
): string[] | "all" {
  const next = new Set(excluded === "all" ? keys : excluded);
  if (included) next.delete(key);
  else next.add(key);
  return pruneChunks([...next], keys);
}

/** Excluded chunk keys without those of chunks that no longer exist, or "all" when they cover every chunk. */
export function pruneChunks(excluded: readonly string[], keys: readonly string[]): string[] | "all" {
  const present = new Set(keys);
  const kept = [...new Set(excluded)].filter((k) => present.has(k));
  return kept.length > 0 && kept.length === present.size ? "all" : kept;
}

/** The lines of `text` split by its separator, each keeping it, so joining them gives `text` back. */
function linesWithEndings(text: string): string[] {
  const sep = lineSeparator(text);
  const parts = text.split(sep);
  return parts.map((part, i) => (i < parts.length - 1 ? part + sep : part));
}

/** Lines covered by a chunk's side, from the start of its first line to one past the end of its last. */
function lineRange(doc: Text, from: number, to: number): LineRange {
  const start = from > doc.length ? doc.lines : doc.lineAt(from).number - 1;
  if (to === from) return { from: start, to: start };
  return { from: start, to: to > doc.length ? doc.lines : doc.lineAt(to).number - 1 };
}

/** The text of a line range, or null when it is empty. */
function rangeText(doc: Text, range: LineRange): string | null {
  if (range.from === range.to) return null;
  return doc.sliceString(doc.line(range.from + 1).from, doc.line(range.to).to);
}
