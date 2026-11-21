// CodeMirror pieces of the merge tool: chunk tracking in the result, aligned panes, and per-chunk actions.
import { Decoration, EditorView, GutterMarker, WidgetType, gutter, type DecorationSet } from "@codemirror/view";
import { EditorState, RangeSet, StateEffect, StateField, type Extension, type Text, type TransactionSpec } from "@codemirror/state";
import { invertedEffects } from "@codemirror/commands";
import { chunkText, resolutionText, resolveSimple, type Chunk, type ChunkKind, type LineRange, type Merge } from "./merge3";

export type Pane = "ours" | "result" | "theirs";
export type ChangeSide = "ours" | "theirs";
type Handled = "applied" | "ignored";
/** What the user did with each side of a change. */
export type ChunkState = { ours?: Handled; theirs?: Handled };
type Range = { from: number; to: number };
type Tracked = { ranges: Range[]; states: ChunkState[] };

/** A merge and its changed chunks, the ones the merge tool shows. */
export type Model = { merge: Merge; changes: Chunk[] };

export function toModel(merge: Merge): Model {
  return { merge, changes: merge.chunks.filter((c) => c.kind !== "unchanged") };
}

/** A conflict needs both sides handled; any other change needs one. */
export function isResolved(kind: ChunkKind, state: ChunkState) {
  return kind === "conflict" ? !!(state.ours && state.theirs) : !!(state.ours || state.theirs);
}

/** Sides with something to apply for a chunk. */
function changedSides(kind: ChunkKind): ChangeSide[] {
  return kind === "ours" ? ["ours"] : kind === "theirs" ? ["theirs"] : ["ours", "theirs"];
}

const LINE_HEIGHT = 20;

const setChunk = StateEffect.define<{ index: number; state: ChunkState }>();

/** Each change's range in the result, mapped through edits, and what was done with it. */
const tracked = StateField.define<Tracked>({
  create: () => ({ ranges: [], states: [] }),
  update(value, tr) {
    let { ranges, states } = value;
    if (tr.docChanged) ranges = ranges.map((r) => ({ from: tr.changes.mapPos(r.from, -1), to: tr.changes.mapPos(r.to, 1) }));
    for (const e of tr.effects) {
      if (!e.is(setChunk)) continue;
      states = states.slice();
      states[e.value.index] = e.value.state;
    }
    return ranges === value.ranges && states === value.states ? value : { ranges, states };
  },
});

/** Undoing an edit also restores what was done with its chunks. */
const undoChunkStates = invertedEffects.of((tr) => {
  const before = tr.startState.field(tracked);
  return tr.effects.filter((e) => e.is(setChunk)).map((e) => setChunk.of({ index: e.value.index, state: before.states[e.value.index] }));
});

/** Document position of the start of 0-based line `line`, or the document end. */
function linePos(doc: Text, line: number) {
  return line < doc.lines ? doc.line(line + 1).from : doc.length;
}

function toRange(doc: Text, lines: LineRange): Range {
  return { from: linePos(doc, lines.from), to: linePos(doc, lines.to) };
}

function lineCount(doc: Text, r: Range) {
  if (r.to <= r.from) return 0;
  const end = doc.lineAt(r.to);
  return end.number - doc.lineAt(r.from).number + (r.to === end.from ? 0 : 1);
}

/** How one pane draws a change. */
type PaneChunk = Range & { index: number; kind: ChunkKind; spacer: number; resolved: boolean; actions: boolean };

class Spacer extends WidgetType {
  constructor(
    readonly chunk: PaneChunk,
    readonly empty: boolean,
  ) {
    super();
  }
  eq(other: Spacer) {
    const a = this.chunk;
    const b = other.chunk;
    return a.spacer === b.spacer && a.kind === b.kind && a.resolved === b.resolved && a.actions === b.actions && a.index === b.index && this.empty === other.empty;
  }
  toDOM() {
    const div = document.createElement("div");
    div.className = `cm-merge3-spacer ${this.empty ? `cm-merge3-empty ${chunkClass(this.chunk)}` : ""}`;
    div.style.height = `${this.chunk.spacer * LINE_HEIGHT}px`;
    return div;
  }
  get estimatedHeight() {
    return this.chunk.spacer * LINE_HEIGHT;
  }
}

function chunkClass(chunk: PaneChunk) {
  return chunk.resolved ? "cm-merge3-resolved" : chunk.kind === "conflict" ? "cm-merge3-conflict" : "cm-merge3-change";
}

function decorations(doc: Text, chunks: PaneChunk[]): DecorationSet {
  const ranges = [];
  for (const chunk of chunks) {
    const line = Decoration.line({ class: chunkClass(chunk) });
    for (let pos = chunk.from; pos < chunk.to; ) {
      const l = doc.lineAt(pos);
      ranges.push(line.range(l.from));
      pos = l.to + 1;
    }
    if (chunk.spacer > 0) {
      const afterLastLine = chunk.to === doc.length && doc.lineAt(chunk.to).from !== chunk.to;
      const widget = new Spacer(chunk, chunk.to === chunk.from);
      ranges.push(Decoration.widget({ widget, block: true, side: afterLastLine ? 1 : -1 }).range(chunk.to));
    }
  }
  return Decoration.set(ranges, true);
}

const setLayout = StateEffect.define<PaneChunk[]>();

/** The chunks a pane draws, fed by `setLayout` or, for the result, computed from its own state. */
const layoutField = StateField.define<PaneChunk[]>({
  create: () => [],
  update: (value, tr) => tr.effects.reduce((v, e) => (e.is(setLayout) ? e.value : v), value),
});

/** Lays out every pane's chunks for the result's current state, padding the shorter sides so chunks line up. */
export function layout(model: Model, panes: Record<Pane, EditorState>): Record<Pane, PaneChunk[]> {
  const { ranges, states } = panes.result.field(tracked);
  const out: Record<Pane, PaneChunk[]> = { ours: [], result: [], theirs: [] };
  model.changes.forEach((chunk, index) => {
    const range: Record<Pane, Range> = {
      ours: toRange(panes.ours.doc, chunk.ours),
      result: ranges[index],
      theirs: toRange(panes.theirs.doc, chunk.theirs),
    };
    const lines: Record<Pane, number> = {
      ours: chunk.ours.to - chunk.ours.from,
      result: lineCount(panes.result.doc, ranges[index]),
      theirs: chunk.theirs.to - chunk.theirs.from,
    };
    const height = Math.max(lines.ours, lines.result, lines.theirs);
    const state = states[index];
    const resolved = isResolved(chunk.kind, state);
    for (const pane of ["ours", "result", "theirs"] as const) {
      const actions = pane !== "result" && !resolved && !state[pane] && changedSides(chunk.kind).includes(pane);
      out[pane].push({ ...range[pane], index, kind: chunk.kind, spacer: height - lines[pane], resolved, actions });
    }
  });
  return out;
}

/** Called when a chunk's apply or ignore button is clicked. */
export type OnAction = (index: number, side: ChangeSide, action: "apply" | "ignore") => void;

class ActionMarker extends GutterMarker {
  constructor(
    readonly index: number,
    readonly side: ChangeSide,
    readonly onAction: OnAction,
  ) {
    super();
  }
  eq(other: ActionMarker) {
    return other.index === this.index && other.side === this.side;
  }
  toDOM() {
    const div = document.createElement("div");
    div.className = "cm-merge3-buttons";
    const button = (text: string, title: string, action: "apply" | "ignore") => {
      const b = document.createElement("button");
      b.textContent = text;
      b.title = title;
      b.onmousedown = (e) => e.preventDefault();
      b.onclick = () => this.onAction(this.index, this.side, action);
      return b;
    };
    const apply = button(this.side === "ours" ? "»" : "«", "Accept", "apply");
    const ignore = button("×", "Ignore", "ignore");
    div.append(...(this.side === "ours" ? [ignore, apply] : [apply, ignore]));
    return div;
  }
}

/** Highlighting, alignment spacers, and (for a side) accept and ignore buttons. */
function paneExtension(side: ChangeSide | undefined, onAction: OnAction, field: StateField<PaneChunk[]>): Extension {
  const marker = (chunk: PaneChunk) => new ActionMarker(chunk.index, side!, onAction);
  return [
    EditorView.decorations.compute([field], (state) => decorations(state.doc, state.field(field))),
    side
      ? gutter({
          class: "cm-merge3-actions",
          side: side === "ours" ? "after" : "before",
          markers: (view) =>
            RangeSet.of(
              view.state
                .field(field)
                .filter((c) => c.actions && c.to > c.from)
                .map((c) => marker(c).range(c.from)),
              true,
            ),
          widgetMarker: (_view, widget) => (widget instanceof Spacer && widget.empty && widget.chunk.actions ? marker(widget.chunk) : null),
          initialSpacer: () => new ActionMarker(0, side, onAction),
        })
      : [],
  ];
}

/** Extensions for the read-only side panes. Their layout comes from `updateSides`. */
export function sideExtension(side: ChangeSide, onAction: OnAction): Extension {
  return [layoutField, paneExtension(side, onAction, layoutField)];
}

/** Extensions for the result pane, starting with base's text and every change unhandled. */
export function resultExtension(model: Model, base: Text, sides: () => { ours: EditorState; theirs: EditorState }): Extension {
  const initial: Tracked = {
    ranges: model.changes.map((c) => toRange(base, c.base)),
    states: model.changes.map(() => ({})),
  };
  const own = StateField.define<PaneChunk[]>({
    create: (state) => layout(model, { ...sides(), result: state }).result,
    update: (value, tr) => (tr.docChanged || tr.effects.some((e) => e.is(setChunk)) ? layout(model, { ...sides(), result: tr.state }).result : value),
  });
  return [tracked.init(() => initial), undoChunkStates, own, paneExtension(undefined, () => {}, own)];
}

/** Sends the result's layout to the side panes. */
export function updateSides(model: Model, views: Record<Pane, EditorView>) {
  const all = layout(model, { ours: views.ours.state, result: views.result.state, theirs: views.theirs.state });
  views.ours.dispatch({ effects: setLayout.of(all.ours) });
  views.theirs.dispatch({ effects: setLayout.of(all.theirs) });
}

/** Applies a side's change to the result, appending it to the other side's change in a conflict, or ignores it. */
export function act(model: Model, result: EditorState, index: number, side: ChangeSide, action: "apply" | "ignore"): TransactionSpec {
  const { ranges, states } = result.field(tracked);
  const chunk = model.changes[index];
  const before = states[index];
  const state = { ...before, [side]: action === "apply" ? "applied" : "ignored" };
  if (action === "ignore") return { effects: setChunk.of({ index, state }) };
  const r = ranges[index];
  const other = side === "ours" ? "theirs" : "ours";
  const text = chunkText(model.merge, chunk, side);
  const insert = chunk.kind === "conflict" && before[other] === "applied" ? result.sliceDoc(r.from, r.to) + text : text;
  return { changes: { from: r.from, to: r.to, insert }, effects: setChunk.of({ index, state }), userEvent: "input.merge" };
}

/**
 * The magic wand: resolves every unhandled change that one side made or both made alike, and conflicts that merge
 * by word. Undefined when there is nothing to resolve.
 */
export function resolveSimpleChanges(model: Model, result: EditorState): TransactionSpec | undefined {
  const { ranges, states } = result.field(tracked);
  const resolutions = resolveSimple(model.merge);
  const changes = [];
  const effects = [];
  for (const [index, chunk] of model.changes.entries()) {
    const resolution = resolutions.get(chunk);
    if (!resolution || states[index].ours || states[index].theirs) continue;
    changes.push({ ...ranges[index], insert: resolutionText(model.merge, chunk, resolution) });
    const state: ChunkState = Object.fromEntries(changedSides(chunk.kind).map((s) => [s, "applied"]));
    effects.push(setChunk.of({ index, state }));
  }
  return changes.length ? { changes, effects, userEvent: "input.merge" } : undefined;
}

/** Unresolved changes and, of those, conflicts. */
export function remaining(model: Model, state: EditorState) {
  const { states } = state.field(tracked);
  const open = model.changes.filter((c, i) => !isResolved(c.kind, states[i]));
  return { changes: open.length, conflicts: open.filter((c) => c.kind === "conflict").length };
}

/** Moves the result's cursor to the next (or previous) unresolved change and scrolls it into view. */
export function goToChange(model: Model, view: EditorView, direction: 1 | -1) {
  const { ranges, states } = view.state.field(tracked);
  const head = view.state.selection.main.head;
  const open = ranges.filter((_, i) => !isResolved(model.changes[i].kind, states[i]));
  const target = direction === 1 ? open.find((r) => r.from > head) ?? open[0] : [...open].reverse().find((r) => r.from < head) ?? open[open.length - 1];
  if (!target) return;
  view.dispatch({ selection: { anchor: target.from }, effects: EditorView.scrollIntoView(target.from, { y: "center" }) });
  view.focus();
}
