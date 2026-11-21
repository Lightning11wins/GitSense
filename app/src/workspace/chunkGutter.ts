// Include checkboxes for the chunks of a working-tree diff, in the working-tree editor's gutter.
import { mergeViewSiblings } from "@codemirror/merge";
import { RangeSet, StateEffect, StateField, type Extension, type Range, type Text } from "@codemirror/state";
import { GutterMarker, gutter, type EditorView } from "@codemirror/view";
import { keyedChunks, type KeyedChunk } from "./partial";

/** Which chunks are checked: none when `fileExcluded`, otherwise all but `excluded`. */
export type ChunkInclusion = { fileExcluded: boolean; excluded: ReadonlySet<string> };

/** Sets which chunks the gutter shows as checked. */
export const setChunkInclusion = StateEffect.define<ChunkInclusion>();

const inclusionField = StateField.define<ChunkInclusion>({
  create: () => ({ fileExcluded: false, excluded: new Set() }),
  update: (value, tr) => tr.effects.reduce((v, e) => (e.is(setChunkInclusion) ? e.value : v), value),
});

/** Called with the keys of all the file's chunks, the toggled chunk's key, and whether it is now checked. */
type OnToggle = (keys: string[], key: string, included: boolean) => void;

class IncludeMarker extends GutterMarker {
  constructor(
    readonly key: string,
    readonly checked: boolean,
    readonly toggle?: (view: EditorView, key: string, included: boolean) => void,
  ) {
    super();
  }

  eq(other: IncludeMarker) {
    return other.key === this.key && other.checked === this.checked;
  }

  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = this.checked;
    box.title = "Include in commit";
    box.addEventListener("mousedown", (e) => e.preventDefault());
    box.addEventListener("change", () => this.toggle?.(view, this.key, box.checked));
    return box;
  }
}

/**
 * A gutter for the working-tree editor of a MergeView, with an include checkbox at the first line of each
 * chunk. Set what is checked with `setChunkInclusion`.
 */
export function chunkGutter(onToggle: OnToggle): Extension {
  let cache: { a: Text; b: Text; chunks: KeyedChunk[] } | undefined;
  const chunksOf = (view: EditorView): KeyedChunk[] => {
    const a = mergeViewSiblings(view)?.a.state.doc;
    const b = view.state.doc;
    if (!a) return [];
    if (cache?.a !== a || cache.b !== b) cache = { a, b, chunks: keyedChunks(a, b) };
    return cache.chunks;
  };
  const toggle = (view: EditorView, key: string, included: boolean) =>
    onToggle(chunksOf(view).map((c) => c.key), key, included);
  return [
    inclusionField,
    gutter({
      class: "cm-include-gutter",
      markers: (view) => {
        const { fileExcluded, excluded } = view.state.field(inclusionField);
        const doc = view.state.doc;
        const markers: Range<GutterMarker>[] = [];
        for (const chunk of chunksOf(view)) {
          const pos = doc.line(Math.min(chunk.b.from + 1, doc.lines)).from;
          if (markers.at(-1)?.from === pos) continue;
          markers.push(new IncludeMarker(chunk.key, !fileExcluded && !excluded.has(chunk.key), toggle).range(pos));
        }
        return RangeSet.of(markers);
      },
      initialSpacer: () => new IncludeMarker("", false),
    }),
  ];
}
