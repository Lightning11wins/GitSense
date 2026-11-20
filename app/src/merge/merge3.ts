// Three-way merge for the merge tool: line chunks, the magic wand, and result building.
import { diff } from "@codemirror/merge";

export type Side = "base" | "ours" | "theirs";

/** Half-open range of line (or token) indexes, 0-based. */
export interface LineRange {
  from: number;
  to: number;
}

/**
 * - `unchanged`: neither side touched the region.
 * - `ours` / `theirs`: only that side changed it.
 * - `both`: both sides changed it to the same text.
 * - `conflict`: both sides changed it differently. Edits that overlap or touch
 *   (including insertions at the same position) are one conflict.
 */
export type ChunkKind = "unchanged" | "ours" | "theirs" | "both" | "conflict";

/** One region, with its line range in each version. Ranges may be empty (an insertion or deletion). */
export interface Chunk {
  kind: ChunkKind;
  base: LineRange;
  ours: LineRange;
  theirs: LineRange;
}

/**
 * The lines of each version, with their line endings, and the ordered chunks
 * covering all three. Joining `lines[side]` gives back that side's text.
 */
export interface Merge {
  lines: Record<Side, string[]>;
  chunks: Chunk[];
}

/**
 * What goes in the result for a chunk: a side's text, `both` (ours then
 * theirs), or custom text.
 */
export type Resolution = Side | "both" | { text: string };

/** Splits text into lines that keep their line endings. The last line may lack one. */
export function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/**
 * Merges three texts line by line, as diff3 does. Throws if the texts have
 * more than about 63000 distinct lines.
 */
export function merge3(base: string, ours: string, theirs: string): Merge {
  const lines = { base: splitLines(base), ours: splitLines(ours), theirs: splitLines(theirs) };
  return { lines, chunks: mergeSequences(lines.base, lines.ours, lines.theirs) };
}

/** The text of `chunk` in the given version. */
export function chunkText(merge: Merge, chunk: Chunk, side: Side): string {
  const range = chunk[side];
  return merge.lines[side].slice(range.from, range.to).join("");
}

/**
 * The magic wand (Resolve Simple Conflicts). Returns a resolution for every
 * chunk it can settle: the changed side for one-sided and identical changes,
 * and merged text for a conflict whose word-level three-way merge has no
 * conflict. Unchanged chunks and true conflicts are absent.
 */
export function resolveSimple(merge: Merge): Map<Chunk, Resolution> {
  const resolutions = new Map<Chunk, Resolution>();
  for (const chunk of merge.chunks) {
    if (chunk.kind === "ours" || chunk.kind === "theirs") {
      resolutions.set(chunk, chunk.kind);
    } else if (chunk.kind === "both") {
      resolutions.set(chunk, "ours");
    } else if (chunk.kind === "conflict") {
      const text = mergeWords(
        chunkText(merge, chunk, "base"),
        chunkText(merge, chunk, "ours"),
        chunkText(merge, chunk, "theirs"),
      );
      if (text !== undefined) resolutions.set(chunk, { text });
    }
  }
  return resolutions;
}

/** The text of one resolution of `chunk`. */
export function resolutionText(merge: Merge, chunk: Chunk, resolution: Resolution): string {
  if (typeof resolution === "object") return resolution.text;
  if (resolution !== "both") return chunkText(merge, chunk, resolution);
  const ours = chunkText(merge, chunk, "ours");
  const theirs = chunkText(merge, chunk, "theirs");
  if (ours === "" || theirs === "" || ours.endsWith("\n")) return ours + theirs;
  return ours + (ours.endsWith("\r") || theirs.includes("\r\n") ? "\r\n" : "\n") + theirs;
}

/** The result text: each chunk takes its resolution, or its base text when it has none. */
export function buildResult(merge: Merge, resolutions: ReadonlyMap<Chunk, Resolution>): string {
  return merge.chunks.map((chunk) => resolutionText(merge, chunk, resolutions.get(chunk) ?? "base")).join("");
}

/**
 * Three-way merges words, whitespace runs, and punctuation. Returns undefined
 * when any part conflicts.
 */
function mergeWords(base: string, ours: string, theirs: string): string | undefined {
  const tokens = { base: tokenize(base), ours: tokenize(ours), theirs: tokenize(theirs) };
  const chunks = mergeSequences(tokens.base, tokens.ours, tokens.theirs);
  if (chunks.some((chunk) => chunk.kind === "conflict")) return undefined;
  return chunks
    .map((chunk) => {
      const side = chunk.kind === "theirs" ? "theirs" : chunk.kind === "unchanged" ? "base" : "ours";
      return tokens[side].slice(chunk[side].from, chunk[side].to).join("");
    })
    .join("");
}

function tokenize(text: string): string[] {
  return text.match(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu) ?? [];
}

/** Three-way merge of any three sequences of strings. */
function mergeSequences(base: string[], ours: string[], theirs: string[]): Chunk[] {
  const codes = new Map<string, string>();
  const ourEdits = diffSequences(base, ours, codes);
  const theirEdits = diffSequences(base, theirs, codes);
  const edits = [
    ...ourEdits.map((edit) => ({ ...edit, isOurs: true })),
    ...theirEdits.map((edit) => ({ ...edit, isOurs: false })),
  ].sort((a, b) => a.fromA - b.fromA || a.toA - b.toA);

  const chunks: Chunk[] = [];
  let basePos = 0;
  let oursShift = 0;
  let theirsShift = 0;
  const unchanged = (to: number) => {
    if (to > basePos) {
      chunks.push({
        kind: "unchanged",
        base: { from: basePos, to },
        ours: { from: basePos + oursShift, to: to + oursShift },
        theirs: { from: basePos + theirsShift, to: to + theirsShift },
      });
    }
  };

  for (let i = 0; i < edits.length; ) {
    const start = edits[i].fromA;
    let end = edits[i].toA;
    let hasOurs = false;
    let hasTheirs = false;
    let oursGrowth = 0;
    let theirsGrowth = 0;
    for (; i < edits.length && edits[i].fromA <= end; i++) {
      const edit = edits[i];
      end = Math.max(end, edit.toA);
      const growth = edit.toB - edit.fromB - (edit.toA - edit.fromA);
      if (edit.isOurs) {
        hasOurs = true;
        oursGrowth += growth;
      } else {
        hasTheirs = true;
        theirsGrowth += growth;
      }
    }
    unchanged(start);
    const chunk: Chunk = {
      kind: hasOurs && hasTheirs ? "conflict" : hasOurs ? "ours" : "theirs",
      base: { from: start, to: end },
      ours: { from: start + oursShift, to: end + oursShift + oursGrowth },
      theirs: { from: start + theirsShift, to: end + theirsShift + theirsGrowth },
    };
    if (chunk.kind === "conflict" && sameItems(ours, chunk.ours, theirs, chunk.theirs)) chunk.kind = "both";
    chunks.push(chunk);
    basePos = end;
    oursShift += oursGrowth;
    theirsShift += theirsGrowth;
  }
  unchanged(base.length);
  return chunks;
}

function sameItems(a: string[], rangeA: LineRange, b: string[], rangeB: LineRange): boolean {
  if (rangeA.to - rangeA.from !== rangeB.to - rangeB.from) return false;
  for (let i = 0; i < rangeA.to - rangeA.from; i++) {
    if (a[rangeA.from + i] !== b[rangeB.from + i]) return false;
  }
  return true;
}

interface Edit {
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
}

/** Edits turning `a` into `b`. `codes` assigns each distinct string a character and is shared across calls. */
function diffSequences(a: string[], b: string[], codes: Map<string, string>): readonly Edit[] {
  const encode = (items: string[]) =>
    items
      .map((item) => {
        let code = codes.get(item);
        if (code === undefined) {
          // Skip the surrogate range so every code is one character.
          const n = codes.size < 0xd800 ? codes.size : codes.size + 0x800;
          if (n > 0xffff) throw new Error(`Failed to diff: more than ${codes.size} distinct items`);
          code = String.fromCharCode(n);
          codes.set(item, code);
        }
        return code;
      })
      .join("");
  return diff(encode(a), encode(b));
}
