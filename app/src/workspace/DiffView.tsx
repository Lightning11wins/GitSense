import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { MergeView, goToNextChunk, goToPreviousChunk } from "@codemirror/merge";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from "@codemirror/view";
import { Annotation, Compartment, EditorState, Transaction, type Extension } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import type { FileContent } from "../protocol.gen";
import { call } from "../api";
import { useSession, type Session } from "./session";
import { editorTheme, mergeTheme } from "./editorTheme";
import "./DiffView.css";

export type DiffTab = { id: string; repo: string; path: string; origPath: string | null };

type Loaded = { head: FileContent; work: FileContent };

/** Marks transactions that load text from the machine, as opposed to user edits. */
const fromDisk = Annotation.define<boolean>();
const SAVE_DELAY_MS = 300;

/** Side-by-side diff of HEAD against the working tree, whose side is editable and saved back. */
export function DiffView({ session, tab }: { session: Session; tab: DiffTab }) {
  const status = useSession(session, (s) => s.statuses[tab.repo]?.status);
  const [loaded, setLoaded] = useState<Loaded>();
  const [error, setError] = useState<string>();
  const [saveError, setSaveError] = useState<string>();
  const [chunkCount, setChunkCount] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  const merge = useRef<MergeView>(null);
  const saver = useRef<Saver>(null);

  // Reload both sides whenever the repo's status changes, which covers edits, commits, and rollbacks.
  useEffect(() => {
    let stale = false;
    const read = (version: Parameters<typeof call<"file.read">>[1]["version"], path: string) =>
      call("file.read", { repo: tab.repo, path, version });
    Promise.all([read({ kind: "revision", rev: "HEAD" }, tab.origPath ?? tab.path), read({ kind: "working_tree" }, tab.path)])
      .then(([head, work]) => {
        if (stale) return;
        setError(undefined);
        setLoaded((old) => (old && same(old.head, head) && same(old.work, work) ? old : { head, work }));
      })
      .catch((e) => !stale && setError(String(e)));
    return () => {
      stale = true;
    };
  }, [tab.repo, tab.path, tab.origPath, status]);

  const editable = !!loaded?.work.exists && !loaded.work.binary;
  const showText = !!loaded && !loaded.head.binary && !loaded.work.binary;

  // Build the editors once per tab and editability; later loads update their text in place.
  useEffect(() => {
    if (!showText || !host.current || !loaded) return;
    const language = new Compartment();
    const headText = loaded.head.text ?? "";
    const workText = loaded.work.text ?? "";
    const base = (text: string): Extension[] => [
      EditorState.lineSeparator.of(text.includes("\r\n") ? "\r\n" : "\n"),
      lineNumbers(),
      highlightActiveLineGutter(),
      editorTheme,
      mergeTheme,
      language.of([]),
      keymap.of([
        { key: "F7", run: goToNextChunk },
        { key: "Shift-F7", run: goToPreviousChunk },
      ]),
    ];
    const saverNow = new Saver(tab.repo, tab.path, workText, setSaveError);
    saver.current = saverNow;
    const view = new MergeView({
      a: { doc: headText, extensions: [...base(headText), EditorState.readOnly.of(true), EditorView.editable.of(false)] },
      b: {
        doc: workText,
        extensions: [
          ...base(workText),
          editable ? [history(), highlightActiveLine(), keymap.of([...defaultKeymap, ...historyKeymap])] : [],
          EditorState.readOnly.of(!editable),
          EditorView.editable.of(editable),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !update.transactions.some((tr) => tr.annotation(fromDisk))) {
              saverNow.schedule(update.state.sliceDoc());
            }
            if (merge.current) setChunkCount(merge.current.chunks.length);
          }),
        ],
      },
      parent: host.current,
      revertControls: editable ? "a-to-b" : undefined,
      renderRevertControl: revertButton,
      gutter: true,
      collapseUnchanged: { margin: 4, minSize: 8 },
    });
    merge.current = view;
    setChunkCount(view.chunks.length);
    const first = view.chunks[0];
    if (first) {
      const pos = Math.min(first.fromB, view.b.state.doc.length);
      view.b.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    }
    const desc = LanguageDescription.matchFilename(languages, tab.path);
    desc?.load().then((support) => {
      for (const editor of [view.a, view.b]) editor.dispatch({ effects: language.reconfigure(support) });
    });
    return () => {
      saverNow.flush();
      view.destroy();
      merge.current = null;
    };
    // Text changes are applied by the effect below, without rebuilding the editors.
  }, [showText, editable, tab.repo, tab.path]);

  useEffect(() => {
    const view = merge.current;
    if (!view || !loaded) return;
    replaceText(view.a, loaded.head.text ?? "");
    // Keep the user's unsaved edits; disk changes apply once the editor matches what was last saved.
    if (saver.current?.isClean(view.b.state.sliceDoc())) {
      replaceText(view.b, loaded.work.text ?? "");
      saver.current.markLoaded(view.b.state.sliceDoc());
    }
    setChunkCount(view.chunks.length);
  }, [loaded]);

  const navigate = (command: typeof goToNextChunk) => {
    const view = merge.current;
    if (!view) return;
    const editor = view.a.hasFocus ? view.a : view.b;
    command(editor);
    editor.focus();
  };

  let body;
  if (error) body = <div className="diff-message error-text">{error}</div>;
  else if (!loaded) body = <div className="diff-message secondary">Loading...</div>;
  else if (!showText) body = <div className="diff-message secondary">Binary files differ</div>;
  return (
    <div className="diff-view">
      <div className="diff-toolbar">
        <button className="icon-button" title="Previous Difference (Shift+F7)" onClick={() => navigate(goToPreviousChunk)}>
          <ChevronUp size={16} />
        </button>
        <button className="icon-button" title="Next Difference (F7)" onClick={() => navigate(goToNextChunk)}>
          <ChevronDown size={16} />
        </button>
        <span className="secondary">
          {loaded && showText && (chunkCount === 0 ? "No differences" : chunkCount === 1 ? "1 difference" : `${chunkCount} differences`)}
        </span>
        <span className="spacer" />
        {saveError && <span className="error-text">{saveError}</span>}
      </div>
      {showText && (
        <div className="diff-sides secondary">
          <span>{loaded.head.exists ? `HEAD: ${tab.origPath ?? tab.path}` : "HEAD: no file"}</span>
          <span>{loaded.work.exists ? "Your version" : "Your version: deleted"}</span>
        </div>
      )}
      {body}
      <div className="diff-host" ref={host} hidden={!showText} />
    </div>
  );
}

function revertButton() {
  const button = document.createElement("button");
  button.textContent = "\u00bb";
  button.title = "Revert this change to HEAD";
  return button;
}

function same(a: FileContent, b: FileContent) {
  return a.exists === b.exists && a.binary === b.binary && a.text === b.text;
}

function replaceText(view: EditorView, text: string) {
  if (view.state.sliceDoc() === text) return;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    annotations: [fromDisk.of(true), Transaction.addToHistory.of(false)],
  });
}

/** Writes the working-tree side back to the machine, debounced and in order. */
class Saver {
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: string;
  private chain = Promise.resolve();

  constructor(
    private repo: string,
    private path: string,
    /** Text last written or loaded. */
    private saved: string,
    private onError: (error: string | undefined) => void,
  ) {}

  isClean(text: string) {
    return this.pending === undefined && text === this.saved;
  }

  markLoaded(text: string) {
    this.saved = text;
  }

  schedule(text: string) {
    this.pending = text;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
  }

  flush() {
    clearTimeout(this.timer);
    const text = this.pending;
    if (text === undefined) return;
    this.pending = undefined;
    this.chain = this.chain.then(async () => {
      try {
        await call("file.write", { repo: this.repo, path: this.path, text });
        this.saved = text;
        this.onError(undefined);
      } catch (e) {
        this.onError(`Failed to save: ${e}`);
      }
    });
  }
}
