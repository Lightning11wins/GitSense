// CodeMirror styling after IntelliJ's New UI Dark editor scheme.
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

const theme = EditorView.theme(
  {
    "&": { color: "#bcbec4", backgroundColor: "var(--bg-editor)" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { fontFamily: "var(--font-mono)", fontSize: "13px", lineHeight: "20px" },
    ".cm-content": { caretColor: "#ced0d6" },
    ".cm-cursor": { borderLeftColor: "#ced0d6" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "#214283" },
    ".cm-activeLine": { backgroundColor: "#26282e" },
    ".cm-gutters": { backgroundColor: "var(--bg-editor)", color: "#4b5059", border: "none" },
    ".cm-activeLineGutter": { backgroundColor: "#26282e", color: "#a1a3ab" },
    ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 12px" },
  },
  { dark: true },
);

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword, t.definitionKeyword], color: "#cf8e6d" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#6aab73" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "#2aacb8" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#7a7e85" },
  { tag: t.docComment, color: "#5f826b" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#56a8f5" },
  { tag: [t.propertyName, t.attributeName], color: "#c77dbb" },
  { tag: [t.typeName, t.className, t.namespace], color: "#bcbec4" },
  { tag: [t.meta, t.annotation], color: "#b3ae60" },
  { tag: [t.tagName], color: "#d5b778" },
  { tag: t.heading, color: "#cf8e6d", fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.link, color: "#56a8f5", textDecoration: "underline" },
  { tag: t.invalid, color: "#f75464" },
]);

export const editorTheme = [theme, syntaxHighlighting(highlight)];

/** Diff colors for a side-by-side merge view. */
export const mergeTheme = EditorView.theme(
  {
    "&.cm-merge-a .cm-changedLine, .cm-deletedChunk": { backgroundColor: "#3f2a2c" },
    "&.cm-merge-b .cm-changedLine": { backgroundColor: "#29372b" },
    "&.cm-merge-a .cm-changedText": { background: "#6e3a3e" },
    "&.cm-merge-b .cm-changedText": { background: "#3d5a40" },
    ".cm-changeGutter": { width: "3px", paddingLeft: "0" },
    "&.cm-merge-a .cm-changedLineGutter": { background: "#9a4f52" },
    "&.cm-merge-b .cm-changedLineGutter": { background: "#549159" },
    ".cm-collapsedLines": {
      color: "var(--text-secondary)",
      background: "#2b2d30",
      padding: "2px 12px",
      cursor: "pointer",
    },
  },
  { dark: true },
);
