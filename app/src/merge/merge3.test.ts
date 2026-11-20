import { describe, expect, it } from "vitest";
import { buildResult, chunkText, merge3, resolveSimple, resolutionText, splitLines } from "./merge3";
import type { Chunk, ChunkKind, Resolution } from "./merge3";

const kinds = (base: string, ours: string, theirs: string): ChunkKind[] =>
  merge3(base, ours, theirs).chunks.map((chunk) => chunk.kind);

/** Result of running the magic wand and building the text. */
function wand(base: string, ours: string, theirs: string): string {
  const merge = merge3(base, ours, theirs);
  return buildResult(merge, resolveSimple(merge));
}

const lines = (...items: string[]) => items.map((item) => item + "\n").join("");

describe("splitLines", () => {
  it("keeps line endings and a missing final newline", () => {
    expect(splitLines("a\r\nb\nc")).toEqual(["a\r\n", "b\n", "c"]);
    expect(splitLines("a\n\n")).toEqual(["a\n", "\n"]);
  });

  it("returns no lines for empty text", () => {
    expect(splitLines("")).toEqual([]);
  });
});

describe("merge3 chunks", () => {
  it("reports identical texts as one unchanged chunk", () => {
    const text = lines("a", "b", "c");
    const { chunks } = merge3(text, text, text);
    expect(chunks).toEqual([
      { kind: "unchanged", base: { from: 0, to: 3 }, ours: { from: 0, to: 3 }, theirs: { from: 0, to: 3 } },
    ]);
  });

  it("finds a change made only by ours", () => {
    const merge = merge3(lines("a", "b", "c"), lines("a", "B", "c"), lines("a", "b", "c"));
    expect(merge.chunks.map((chunk) => chunk.kind)).toEqual(["unchanged", "ours", "unchanged"]);
    const changed = merge.chunks[1];
    expect(changed.base).toEqual({ from: 1, to: 2 });
    expect(changed.ours).toEqual({ from: 1, to: 2 });
    expect(changed.theirs).toEqual({ from: 1, to: 2 });
    expect(chunkText(merge, changed, "ours")).toBe("B\n");
  });

  it("finds a change made only by theirs", () => {
    expect(kinds(lines("a", "b", "c"), lines("a", "b", "c"), lines("a", "b", "C"))).toEqual(["unchanged", "theirs"]);
  });

  it("finds separate changes from each side", () => {
    expect(kinds(lines("a", "b", "c", "d", "e"), lines("A", "b", "c", "d", "e"), lines("a", "b", "c", "d", "E"))).toEqual(
      ["ours", "unchanged", "theirs"],
    );
  });

  it("finds an identical change by both sides", () => {
    expect(kinds(lines("a", "b", "c"), lines("a", "X", "c"), lines("a", "X", "c"))).toEqual([
      "unchanged",
      "both",
      "unchanged",
    ]);
  });

  it("finds a conflict when both sides change a line differently", () => {
    expect(kinds(lines("a", "b", "c"), lines("a", "X", "c"), lines("a", "Y", "c"))).toEqual([
      "unchanged",
      "conflict",
      "unchanged",
    ]);
  });

  it("treats adjacent edits as a conflict", () => {
    const merge = merge3(lines("a", "b", "c", "d"), lines("a", "B", "c", "d"), lines("a", "b", "C", "d"));
    expect(merge.chunks.map((chunk) => chunk.kind)).toEqual(["unchanged", "conflict", "unchanged"]);
    expect(merge.chunks[1].base).toEqual({ from: 1, to: 3 });
    expect(chunkText(merge, merge.chunks[1], "ours")).toBe(lines("B", "c"));
    expect(chunkText(merge, merge.chunks[1], "theirs")).toBe(lines("b", "C"));
  });

  it("treats overlapping edits as a conflict", () => {
    expect(kinds(lines("a", "b", "c", "d"), lines("a", "X", "d"), lines("a", "b", "Y", "d"))).toEqual([
      "unchanged",
      "conflict",
      "unchanged",
    ]);
  });

  it("keeps edits one unchanged line apart separate", () => {
    expect(kinds(lines("a", "b", "c", "d"), lines("A", "b", "c", "d"), lines("a", "b", "C", "d"))).toEqual([
      "ours",
      "unchanged",
      "theirs",
      "unchanged",
    ]);
  });

  it("handles insertions at the start and end", () => {
    const base = lines("a", "b");
    const merge = merge3(base, lines("top", "a", "b"), lines("a", "b", "bottom"));
    expect(merge.chunks.map((chunk) => chunk.kind)).toEqual(["ours", "unchanged", "theirs"]);
    expect(merge.chunks[0].base).toEqual({ from: 0, to: 0 });
    expect(merge.chunks[0].ours).toEqual({ from: 0, to: 1 });
    expect(merge.chunks[2].base).toEqual({ from: 2, to: 2 });
    expect(merge.chunks[2].theirs).toEqual({ from: 2, to: 3 });
    expect(buildResult(merge, resolveSimple(merge))).toBe(lines("top", "a", "b", "bottom"));
  });

  it("finds a conflict between insertions at the same position", () => {
    expect(kinds(lines("a", "b"), lines("a", "X", "b"), lines("a", "Y", "b"))).toEqual([
      "unchanged",
      "conflict",
      "unchanged",
    ]);
  });

  it("finds identical insertions at the same position", () => {
    expect(kinds(lines("a", "b"), lines("a", "X", "b"), lines("a", "X", "b"))).toEqual([
      "unchanged",
      "both",
      "unchanged",
    ]);
  });

  it("handles deletions", () => {
    const base = lines("a", "b", "c");
    const merge = merge3(base, lines("a", "c"), base);
    expect(merge.chunks.map((chunk) => chunk.kind)).toEqual(["unchanged", "ours", "unchanged"]);
    expect(merge.chunks[1].ours).toEqual({ from: 1, to: 1 });
    expect(buildResult(merge, resolveSimple(merge))).toBe(lines("a", "c"));
  });

  it("finds a conflict between a deletion and an edit of the same line", () => {
    expect(kinds(lines("a", "b", "c"), lines("a", "c"), lines("a", "B", "c"))).toEqual([
      "unchanged",
      "conflict",
      "unchanged",
    ]);
  });

  it("covers every version completely and in order", () => {
    const merge = merge3(
      lines("a", "b", "c", "d", "e", "f"),
      lines("a", "X", "c", "d", "e", "f", "g"),
      lines("a", "Y", "c", "e", "f"),
    );
    for (const side of ["base", "ours", "theirs"] as const) {
      let pos = 0;
      for (const chunk of merge.chunks) {
        expect(chunk[side].from).toBe(pos);
        pos = chunk[side].to;
      }
      expect(pos).toBe(merge.lines[side].length);
    }
  });
});

describe("empty files", () => {
  it("merges three empty files into no chunks", () => {
    const merge = merge3("", "", "");
    expect(merge.chunks).toEqual([]);
    expect(buildResult(merge, new Map())).toBe("");
  });

  it("handles an empty base", () => {
    expect(kinds("", lines("a"), "")).toEqual(["ours"]);
    expect(kinds("", lines("a"), lines("b"))).toEqual(["conflict"]);
    expect(kinds("", lines("a"), lines("a"))).toEqual(["both"]);
    expect(wand("", lines("a"), "")).toBe(lines("a"));
  });

  it("handles a side that deletes everything", () => {
    const base = lines("a", "b");
    expect(kinds(base, "", base)).toEqual(["ours"]);
    expect(wand(base, "", base)).toBe("");
  });
});

describe("line endings", () => {
  it("round-trips CRLF text through the base result", () => {
    const base = "a\r\nb\r\nc\r\n";
    const merge = merge3(base, "a\r\nB\r\nc\r\n", base);
    expect(buildResult(merge, new Map())).toBe(base);
    expect(buildResult(merge, resolveSimple(merge))).toBe("a\r\nB\r\nc\r\n");
  });

  it("keeps CRLF in a word-level resolution", () => {
    const base = "let x = 1;\r\nlet y = 2;\r\n";
    expect(wand(base, "let x = 10;\r\nlet y = 2;\r\n", "let x = 1;\r\nlet y = 20;\r\n")).toBe(
      "let x = 10;\r\nlet y = 20;\r\n",
    );
  });

  it("round-trips a missing final newline", () => {
    const base = "a\nb";
    const merge = merge3(base, "a\nb", "a\nb");
    expect(buildResult(merge, new Map())).toBe("a\nb");
  });

  it("treats a changed final newline as a change to the last line", () => {
    expect(kinds("a\nb", "a\nb\n", "a\nb")).toEqual(["unchanged", "ours"]);
    expect(wand("a\nb", "a\nb\n", "a\nb")).toBe("a\nb\n");
  });

  it("keeps a missing final newline that only ours edits around", () => {
    expect(wand("a\nb\nc", "A\nb\nc", "a\nb\nC")).toBe("A\nb\nC");
  });

  it("starts a new line when 'both' joins a last line without a newline", () => {
    const merge = merge3("a\n", "a\nx", "a\ny");
    const conflict = merge.chunks.find((chunk) => chunk.kind === "conflict") as Chunk;
    expect(resolutionText(merge, conflict, "both")).toBe("x\ny");
  });
});

describe("buildResult", () => {
  const base = lines("a", "b", "c");
  const merge = merge3(base, lines("a", "X", "c"), lines("a", "Y", "c"));
  const conflict = merge.chunks[1];

  it("uses base text for chunks without a resolution", () => {
    expect(buildResult(merge, new Map())).toBe(base);
  });

  it.each<[Resolution, string]>([
    ["base", lines("a", "b", "c")],
    ["ours", lines("a", "X", "c")],
    ["theirs", lines("a", "Y", "c")],
    ["both", lines("a", "X", "Y", "c")],
    [{ text: "custom\n" }, lines("a", "custom", "c")],
  ])("applies the resolution %j to a chunk", (resolution, expected) => {
    expect(buildResult(merge, new Map([[conflict, resolution]]))).toBe(expected);
  });
});

describe("resolveSimple", () => {
  it("applies changes made by one side or identically by both", () => {
    const base = lines("a", "b", "c", "d", "e");
    const result = wand(base, lines("A", "b", "c", "X", "e"), lines("a", "b", "C", "X", "e"));
    expect(result).toBe(lines("A", "b", "C", "X", "e"));
  });

  it("leaves real conflicts unresolved", () => {
    const merge = merge3(lines("a", "b", "c"), lines("a", "X", "c"), lines("a", "Y", "c"));
    const resolutions = resolveSimple(merge);
    expect(resolutions.has(merge.chunks[1])).toBe(false);
    expect(buildResult(merge, resolutions)).toBe(lines("a", "b", "c"));
  });

  it("does not resolve unchanged chunks", () => {
    const text = lines("a", "b");
    expect(resolveSimple(merge3(text, text, text)).size).toBe(0);
  });

  it("resolves non-overlapping edits inside a conflict at word level", () => {
    const base = "const total = price + tax;\n";
    const ours = "const sum = price + tax;\n";
    const theirs = "const total = price * 2 + tax;\n";
    const merge = merge3(base, ours, theirs);
    expect(merge.chunks.map((chunk) => chunk.kind)).toEqual(["conflict"]);
    expect(buildResult(merge, resolveSimple(merge))).toBe("const sum = price * 2 + tax;\n");
  });

  it("resolves changes on adjacent lines at word level", () => {
    const base = lines("name: old", "color: red", "size: 1");
    const ours = lines("name: new", "color: red", "size: 1");
    const theirs = lines("name: old", "color: blue", "size: 1");
    expect(kinds(base, ours, theirs)).toEqual(["conflict", "unchanged"]);
    expect(wand(base, ours, theirs)).toBe(lines("name: new", "color: blue", "size: 1"));
  });

  it("resolves a conflict where both sides made the same word change plus another", () => {
    const base = "a b c\n";
    expect(wand(base, "a X c\n", "a X Z\n")).toBe("a X Z\n");
  });

  it("leaves a conflict when both sides change the same word differently", () => {
    const merge = merge3("let x = 1;\n", "let x = 2;\n", "let x = 3;\n");
    const resolutions = resolveSimple(merge);
    expect(resolutions.size).toBe(0);
    expect(buildResult(merge, resolutions)).toBe("let x = 1;\n");
  });

  it("leaves a conflict when word edits touch", () => {
    const merge = merge3("foo bar\n", "foo\n", "fox bar\n");
    expect(merge.chunks.map((chunk) => chunk.kind)).toEqual(["conflict"]);
    expect(resolveSimple(merge).size).toBe(0);
  });

  it("leaves a conflict when both sides change the same word", () => {
    const merge = merge3("hello world\n", "hellos world\n", "help world\n");
    expect(resolveSimple(merge).size).toBe(0);
  });

  it("leaves a conflict when both sides insert different text at one position", () => {
    const merge = merge3("a b\n", "a x b\n", "a y b\n");
    expect(resolveSimple(merge).size).toBe(0);
  });

  it("resolves some conflicts and leaves others in one merge", () => {
    const base = lines("let a = 1;", "keep", "let b = 1;");
    const ours = lines("let a = 2;", "keep", "let b = 2;");
    const theirs = lines("let a = 1; // one", "keep", "let b = 3;");
    const merge = merge3(base, ours, theirs);
    const resolutions = resolveSimple(merge);
    expect(buildResult(merge, resolutions)).toBe(lines("let a = 2; // one", "keep", "let b = 1;"));
  });
});
