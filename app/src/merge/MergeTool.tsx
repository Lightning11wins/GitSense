import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, WandSparkles } from "lucide-react";
import { EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import type { ConflictSide, FileContent } from "../protocol.gen";
import { call } from "../api";
import type { Session } from "../workspace/session";
import { editorTheme } from "../workspace/editorTheme";
import { ConfirmDialog } from "../workspace/ConfirmDialog";
import { merge3 } from "./merge3";
import { act, goToChange, remaining, resolveSimpleChanges, resultExtension, sideExtension, toModel, updateSides, type Model, type Pane } from "./mergeEditor";
import "../workspace/DiffView.css";
import "./MergeTool.css";

/** The merge tool for one conflicted file. */
export type MergeTab = { kind: "merge"; id: string; repo: string; path: string };

type Versions = { base: FileContent; ours: FileContent; theirs: FileContent };

/** Three panes: yours, the editable result, and theirs. Saving the result marks the file resolved. */
export function MergeTool({ session, tab }: { session: Session; tab: MergeTab }) {
  const [versions, setVersions] = useState<Versions>();
  const [error, setError] = useState<string>();
  const [counts, setCounts] = useState({ changes: 0, conflicts: 0 });
  const [confirmSave, setConfirmSave] = useState(false);
  const [busy, setBusy] = useState(false);
  const hosts = { ours: useRef<HTMLDivElement>(null), result: useRef<HTMLDivElement>(null), theirs: useRef<HTMLDivElement>(null) };
  const editor = useRef<{ model: Model; views: Record<Pane, EditorView> }>(null);

  useEffect(() => {
    const read = (stage: number) => call("file.read", { repo: tab.repo, path: tab.path, version: { kind: "index", stage } });
    Promise.all([read(1), read(2), read(3)])
      .then(([base, ours, theirs]) => setVersions({ base, ours, theirs }))
      .catch((e) => setError(String(e)));
  }, [tab.repo, tab.path]);

  const binary = !!versions && (versions.base.binary || versions.ours.binary || versions.theirs.binary);

  useEffect(() => {
    if (!versions || binary || !hosts.ours.current || !hosts.result.current || !hosts.theirs.current) return;
    const text = { base: versions.base.text ?? "", ours: versions.ours.text ?? "", theirs: versions.theirs.text ?? "" };
    const model = toModel(merge3(text.base, text.ours, text.theirs));
    const language = new Compartment();
    const separator = EditorState.lineSeparator.of(Object.values(text).some((t) => t.includes("\r\n")) ? "\r\n" : "\n");
    const common: Extension[] = [separator, lineNumbers(), highlightActiveLineGutter(), editorTheme, language.of([])];
    const onAction = (index: number, side: "ours" | "theirs", action: "apply" | "ignore") => views.result.dispatch(act(model, views.result.state, index, side, action));
    const side = (pane: "ours" | "theirs", parent: HTMLElement) =>
      new EditorView({
        parent,
        state: EditorState.create({
          doc: text[pane],
          extensions: [...common, EditorState.readOnly.of(true), EditorView.editable.of(false), sideExtension(pane, onAction)],
        }),
      });
    const ours = side("ours", hosts.ours.current);
    const theirs = side("theirs", hosts.theirs.current);
    const result = new EditorView({
      parent: hosts.result.current,
      state: EditorState.create({
        doc: text.base,
        extensions: [
          ...common,
          history(),
          highlightActiveLine(),
          keymap.of([
            { key: "F7", run: (v) => (goToChange(model, v, 1), true) },
            { key: "Shift-F7", run: (v) => (goToChange(model, v, -1), true) },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          resultExtension(model, EditorState.create({ doc: text.base, extensions: separator }).doc, () => ({ ours: ours.state, theirs: theirs.state })),
          EditorView.updateListener.of((update) => {
            if (update.transactions.length === 0) return;
            updateSides(model, views);
            setCounts(remaining(model, update.state));
          }),
        ],
      }),
    });
    const views = { ours, result, theirs };
    editor.current = { model, views };
    updateSides(model, views);
    setCounts(remaining(model, result.state));
    LanguageDescription.matchFilename(languages, tab.path)
      ?.load()
      .then((support) => {
        for (const view of [ours, result, theirs]) view.dispatch({ effects: language.reconfigure(support) });
      });
    return () => {
      for (const view of [ours, result, theirs]) view.destroy();
      editor.current = null;
    };
  }, [versions, binary, tab.path]);

  async function finish(work: () => Promise<unknown>) {
    setBusy(true);
    setError(undefined);
    try {
      await work();
      session.refreshStatus(tab.repo);
      session.closeTab(tab.id);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  const save = () =>
    finish(async () => {
      const text = editor.current!.views.result.state.sliceDoc();
      await call("file.write", { repo: tab.repo, path: tab.path, text });
      await call("files.add", { repo: tab.repo, paths: [tab.path] });
    });
  const accept = (side: ConflictSide) => finish(() => call("conflict.accept", { repo: tab.repo, paths: [tab.path], side }));
  const navigate = (direction: 1 | -1) => editor.current && goToChange(editor.current.model, editor.current.views.result, direction);

  let message;
  if (!versions) message = error ?? "Loading...";
  else if (binary) message = "Binary files can't be merged here. Accept one side instead.";

  return (
    <div className="merge-tool">
      <div className="diff-toolbar">
        <button className="icon-button" title="Previous Change (Shift+F7)" disabled={!editor.current} onClick={() => navigate(-1)}>
          <ChevronUp size={16} />
        </button>
        <button className="icon-button" title="Next Change (F7)" disabled={!editor.current} onClick={() => navigate(1)}>
          <ChevronDown size={16} />
        </button>
        <button
          className="icon-button"
          title="Resolve Simple Conflicts"
          disabled={!editor.current || counts.changes === 0}
          onClick={() => {
            const { model, views } = editor.current!;
            const spec = resolveSimpleChanges(model, views.result.state);
            if (spec) views.result.dispatch(spec);
          }}
        >
          <WandSparkles size={16} />
        </button>
        {versions && !binary && (
          <span className="secondary">
            {counts.changes === 0
              ? "All changes resolved"
              : `${plural(counts.changes, "change")} left, ${plural(counts.conflicts, "conflict")}`}
          </span>
        )}
        <span className="spacer" />
        {versions && error && <span className="error-text">{error}</span>}
        <button className="button" disabled={busy} onClick={() => accept("ours")}>
          Accept Yours
        </button>
        <button className="button" disabled={busy} onClick={() => accept("theirs")}>
          Accept Theirs
        </button>
        <button
          className="button primary"
          disabled={busy || !editor.current}
          onClick={() => (counts.changes > 0 ? setConfirmSave(true) : save())}
        >
          Apply
        </button>
      </div>
      {message ? (
        <div className={`diff-message ${error ? "error-text" : "secondary"}`}>{message}</div>
      ) : (
        <div className="merge-sides secondary">
          <span>Yours{versions!.ours.exists ? "" : ": deleted"}</span>
          <span>Result</span>
          <span>Theirs{versions!.theirs.exists ? "" : ": deleted"}</span>
        </div>
      )}
      <div className="merge-panes" hidden={!!message}>
        <div className="merge-pane" ref={hosts.ours} />
        <div className="merge-pane result" ref={hosts.result} />
        <div className="merge-pane" ref={hosts.theirs} />
      </div>
      {confirmSave && (
        <ConfirmDialog title="Apply the Result" confirmLabel="Apply" onConfirm={save} onClose={() => setConfirmSave(false)}>
          <p>
            {plural(counts.changes, "change")} {counts.changes === 1 ? "is" : "are"} not resolved. Apply the result as it is and mark
            the file resolved?
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
