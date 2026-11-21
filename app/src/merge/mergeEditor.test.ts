import { describe, expect, it } from "vitest";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import { merge3 } from "./merge3";
import { act, layout, remaining, resolveSimpleChanges, resultExtension, toModel, type Model } from "./mergeEditor";

const base = "one\ntwo\nthree\nfour\nfive\nsix\n";
const ours = "ONE\ntwo ours\nthree\nfour\nfive\nsix\n";
const theirs = "one\ntwo theirs\nthree\nfour\nfive\nsix theirs\nseven\n";

function setup(b = base, o = ours, t = theirs) {
  const model = toModel(merge3(b, o, t));
  const sides = { ours: EditorState.create({ doc: o }), theirs: EditorState.create({ doc: t }) };
  let result = EditorState.create({ doc: b, extensions: [history(), resultExtension(model, EditorState.create({ doc: b }).doc, () => sides)] });
  const run = (spec: TransactionSpec | undefined) => {
    expect(spec).toBeDefined();
    result = result.update(spec!).state;
  };
  return { model, sides, run, get result() { return result; }, undo: () => undo({ state: result, dispatch: (tr) => (result = tr.state) }) };
}

/** Each change's height in lines in every pane, padding included. */
function heights(model: Model, panes: ReturnType<typeof setup>) {
  const all = layout(model, { ...panes.sides, result: panes.result });
  return model.changes.map((_, i) =>
    (["ours", "result", "theirs"] as const).map((pane) => {
      const c = all[pane][i];
      const doc = pane === "result" ? panes.result.doc : panes.sides[pane].doc;
      const lines = c.to > c.from ? doc.lineAt(c.to).number - doc.lineAt(c.from).number + (c.to === doc.lineAt(c.to).from ? 0 : 1) : 0;
      return lines + c.spacer;
    }),
  );
}

describe("merge editor", () => {
  it("starts from base with every change open", () => {
    const m = setup();
    expect(m.result.sliceDoc()).toBe(base);
    expect(m.model.changes.map((c) => c.kind)).toEqual(["conflict", "theirs"]);
    expect(remaining(m.model, m.result)).toEqual({ changes: 2, conflicts: 1 });
  });

  it("pads panes so each change has the same height everywhere", () => {
    const m = setup();
    for (const row of heights(m.model, m)) expect(new Set(row).size).toBe(1);
    m.run(act(m.model, m.result, 1, "theirs", "apply"));
    for (const row of heights(m.model, m)) expect(new Set(row).size).toBe(1);
  });

  it("applies one side of a conflict, then appends the other", () => {
    const m = setup();
    m.run(act(m.model, m.result, 0, "ours", "apply"));
    expect(m.result.sliceDoc()).toBe("ONE\ntwo ours\nthree\nfour\nfive\nsix\n");
    expect(remaining(m.model, m.result)).toEqual({ changes: 2, conflicts: 1 });
    m.run(act(m.model, m.result, 0, "theirs", "apply"));
    expect(m.result.sliceDoc()).toBe("ONE\ntwo ours\none\ntwo theirs\nthree\nfour\nfive\nsix\n");
    expect(remaining(m.model, m.result)).toEqual({ changes: 1, conflicts: 0 });
  });

  it("ignoring a change keeps base and resolves it", () => {
    const m = setup();
    m.run(act(m.model, m.result, 1, "theirs", "ignore"));
    expect(m.result.sliceDoc()).toBe(base);
    expect(remaining(m.model, m.result)).toEqual({ changes: 1, conflicts: 1 });
  });

  it("keeps tracking changes through the user's edits", () => {
    const m = setup();
    m.run({ changes: { from: 0, insert: "// header\n" } });
    m.run(act(m.model, m.result, 1, "theirs", "apply"));
    expect(m.result.sliceDoc()).toBe("// header\none\ntwo\nthree\nfour\nfive\nsix theirs\nseven\n");
  });

  it("undo restores the text and reopens the change", () => {
    const m = setup();
    m.run(act(m.model, m.result, 1, "theirs", "apply"));
    expect(m.undo()).toBe(true);
    expect(m.result.sliceDoc()).toBe(base);
    expect(remaining(m.model, m.result)).toEqual({ changes: 2, conflicts: 1 });
  });

  it("the magic wand resolves simple changes and leaves true conflicts", () => {
    const m = setup();
    m.run(resolveSimpleChanges(m.model, m.result));
    expect(m.result.sliceDoc()).toBe("one\ntwo\nthree\nfour\nfive\nsix theirs\nseven\n");
    expect(remaining(m.model, m.result)).toEqual({ changes: 1, conflicts: 1 });
    expect(resolveSimpleChanges(m.model, m.result)).toBeUndefined();
  });

  it("the magic wand merges a conflict whose sides changed different words", () => {
    const m = setup("a b c\n", "A b c\n", "a b C\n");
    m.run(resolveSimpleChanges(m.model, m.result));
    expect(m.result.sliceDoc()).toBe("A b C\n");
    expect(remaining(m.model, m.result)).toEqual({ changes: 0, conflicts: 0 });
  });
});
