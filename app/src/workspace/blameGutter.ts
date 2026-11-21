// Git blame in a gutter: the commit that last changed each line, kept on its line through edits.
import { RangeSet, StateEffect, StateField, type Extension, type Range } from "@codemirror/state";
import { GutterMarker, gutter } from "@codemirror/view";
import type { BlameCommit, BlameResult } from "../protocol.gen";

/** Sets the blame for the editor's current lines. */
export const setBlame = StateEffect.define<BlameResult>();

class BlameMarker extends GutterMarker {
  constructor(readonly commit: BlameCommit) {
    super();
  }
  eq(other: BlameMarker) {
    return other.commit.hash === this.commit.hash;
  }
  toDOM() {
    const div = document.createElement("div");
    const date = new Date(this.commit.author_time * 1000);
    div.textContent = `${date.toLocaleDateString(undefined, { year: "2-digit", month: "numeric", day: "numeric" })} ${this.commit.author_name}`;
    div.title = `${this.commit.hash.slice(0, 8)} ${this.commit.author_name}, ${date.toLocaleString()}\n${this.commit.summary}\n\nClick to show the commit in the log`;
    return div;
  }
}

const spacer = new BlameMarker({ hash: "", author_name: "00/00/00 Firstname Lastn", author_time: 0, summary: "" });

const blameField = StateField.define<RangeSet<BlameMarker>>({
  create: () => RangeSet.empty,
  update(markers, tr) {
    markers = markers.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setBlame)) continue;
      const doc = tr.state.doc;
      const ranges: Range<BlameMarker>[] = [];
      e.value.lines.forEach((index, i) => {
        if (index !== null && i < doc.lines) ranges.push(new BlameMarker(e.value.commits[index]).range(doc.line(i + 1).from));
      });
      markers = RangeSet.of(ranges);
    }
    return markers;
  },
});

/** A gutter showing each line's commit date and author. Clicking one calls `onOpen` with its hash. */
export function blameGutter(onOpen: (hash: string) => void): Extension {
  return [
    blameField,
    gutter({
      class: "cm-blame-gutter",
      markers: (view) => view.state.field(blameField),
      initialSpacer: () => spacer,
      domEventHandlers: {
        mousedown(view, line) {
          let hash: string | undefined;
          view.state.field(blameField).between(line.from, line.from, (_from, _to, marker) => {
            hash = marker.commit.hash;
          });
          if (hash) onOpen(hash);
          return !!hash;
        },
      },
    }),
  ];
}
