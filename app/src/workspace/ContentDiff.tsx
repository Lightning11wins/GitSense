import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { MergeView, goToNextChunk, goToPreviousChunk } from "@codemirror/merge";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { Compartment, EditorState } from "@codemirror/state";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import type { FileContent } from "../protocol.gen";
import { DIFF_CONFIG } from "./partial";
import { editorTheme, mergeTheme } from "./editorTheme";
import "./DiffView.css";

/** One side of a fixed diff: a caption and the file's content. */
export type ContentSide = { label: string; content: FileContent };

/** A center tab with a read-only diff of given contents, such as a shelved change. */
export type ContentDiffTab = { kind: "content-diff"; id: string; path: string; title: string; left: ContentSide; right: ContentSide };

/** Read-only side-by-side diff of two given file contents. `path` picks the syntax highlighting. */
export function ContentDiff({ path, left, right }: { path: string; left: ContentSide; right: ContentSide }) {
  const [chunkCount, setChunkCount] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  const merge = useRef<MergeView>(null);
  const showText = !left.content.binary && !right.content.binary;

  useEffect(() => {
    if (!showText || !host.current) return;
    const language = new Compartment();
    const side = (text: string) => ({
      doc: text,
      extensions: [
        EditorState.lineSeparator.of(text.includes("\r\n") ? "\r\n" : "\n"),
        lineNumbers(),
        editorTheme,
        mergeTheme,
        language.of([]),
        keymap.of([
          { key: "F7", run: goToNextChunk },
          { key: "Shift-F7", run: goToPreviousChunk },
        ]),
        EditorState.readOnly.of(true),
      ],
    });
    const view = new MergeView({
      a: side(left.content.text ?? ""),
      b: side(right.content.text ?? ""),
      parent: host.current,
      gutter: true,
      diffConfig: DIFF_CONFIG,
      collapseUnchanged: { margin: 4, minSize: 8 },
    });
    merge.current = view;
    setChunkCount(view.chunks.length);
    const first = view.chunks[0];
    if (first) view.b.dispatch({ effects: EditorView.scrollIntoView(Math.min(first.fromB, view.b.state.doc.length), { y: "center" }) });
    LanguageDescription.matchFilename(languages, path)
      ?.load()
      .then((support) => {
        for (const editor of [view.a, view.b]) editor.dispatch({ effects: language.reconfigure(support) });
      });
    return () => {
      view.destroy();
      merge.current = null;
    };
  }, [showText, path, left.content, right.content]);

  const navigate = (command: typeof goToNextChunk) => {
    const view = merge.current;
    if (!view) return;
    const editor = view.a.hasFocus ? view.a : view.b;
    command(editor);
    editor.focus();
  };

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
          {showText && (chunkCount === 0 ? "No differences" : chunkCount === 1 ? "1 difference" : `${chunkCount} differences`)}
        </span>
      </div>
      {showText ? (
        <div className="diff-sides secondary">
          <span>{left.content.exists ? left.label : `${left.label}: no file`}</span>
          <span>{right.content.exists ? right.label : `${right.label}: no file`}</span>
        </div>
      ) : (
        <div className="diff-message secondary">Binary files differ</div>
      )}
      <div className="diff-host" ref={host} hidden={!showText} />
    </div>
  );
}
