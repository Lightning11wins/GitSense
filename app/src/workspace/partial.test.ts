import { describe, expect, it } from "vitest";
import { keyedChunks, partialText, pruneChunks, toDoc, toggleChunk } from "./partial";

const lines = (...items: string[]) => items.map((item) => item + "\n").join("");
const chunks = (head: string, work: string) => keyedChunks(toDoc(head), toDoc(work));
const keys = (head: string, work: string) => chunks(head, work).map((c) => c.key);

const head = lines("fn main() {", "    let a = 1;", "    let b = 2;", "    let c = 3;", "    let d = 4;", "    println!();", "}");
// Changes line 2 and line 6, with unchanged lines between.
const work = lines("fn main() {", "    let a = 10;", "    let b = 2;", "    let c = 3;", "    let d = 4;", "    println!(\"{a}\");", "}");

describe("keyedChunks", () => {
  it("finds separate chunks with their line ranges", () => {
    const found = chunks(head, work);
    expect(found.map((c) => [c.a, c.b])).toEqual([
      [{ from: 1, to: 2 }, { from: 1, to: 2 }],
      [{ from: 5, to: 6 }, { from: 5, to: 6 }],
    ]);
  });

  it("keeps a chunk's key when other parts of the file change", () => {
    const [first, second] = keys(head, work);
    const edited = work.replace("    let c = 3;\n", "    let c = 30;\n    let e = 5;\n");
    const after = keys(head, edited);
    expect(after).toHaveLength(3);
    expect(after[0]).toBe(first);
    expect(after[2]).toBe(second);
  });

  it("changes a chunk's key when its own text changes", () => {
    const [first] = keys(head, work);
    expect(keys(head, work.replace("a = 10", "a = 11"))).not.toContain(first);
  });

  it("gives identical chunks distinct keys", () => {
    const found = keys(lines("a", "x", "b", "x", "c"), lines("a", "y", "b", "y", "c"));
    expect(found).toHaveLength(2);
    expect(new Set(found).size).toBe(2);
  });

  it("finds insertions and deletions", () => {
    const found = chunks(lines("a", "b", "c", "d"), lines("a", "c", "d", "e"));
    expect(found.map((c) => [c.a, c.b])).toEqual([
      [{ from: 1, to: 2 }, { from: 1, to: 1 }],
      [{ from: 4, to: 4 }, { from: 3, to: 4 }],
    ]);
  });
});

describe("partialText", () => {
  it("applies every chunk when none is excluded", () => {
    expect(partialText(head, work, new Set())).toBe(work);
  });

  it("keeps HEAD's text for excluded chunks", () => {
    const [first, second] = keys(head, work);
    expect(partialText(head, work, new Set([second]))).toBe(head.replace("a = 1;", "a = 10;"));
    expect(partialText(head, work, new Set([first]))).toBe(head.replace("println!()", 'println!("{a}")'));
    expect(partialText(head, work, new Set([first, second]))).toBe(head);
  });

  it("applies insertions and deletions separately", () => {
    const before = lines("a", "b", "c", "d");
    const after = lines("a", "c", "d", "e");
    const [deletion, insertion] = keys(before, after);
    expect(partialText(before, after, new Set([insertion]))).toBe(lines("a", "c", "d"));
    expect(partialText(before, after, new Set([deletion]))).toBe(lines("a", "b", "c", "d", "e"));
  });

  it("handles a missing final newline on either side", () => {
    const [change] = keys("a\nb", "a\nB\n");
    expect(partialText("a\nb", "a\nB\n", new Set())).toBe("a\nB\n");
    expect(partialText("a\nb", "a\nB\n", new Set([change]))).toBe("a\nb");
    const before = lines("a", "b", "c");
    const after = "A\nb\nc\nd";
    const [first, last] = keys(before, after);
    expect(partialText(before, after, new Set([last]))).toBe(lines("A", "b", "c"));
    expect(partialText(before, after, new Set([first]))).toBe("a\nb\nc\nd");
  });

  it("keeps each side's line endings", () => {
    const before = "a\r\nb\r\nc\r\n";
    const after = "A\r\nb\r\nC\r\n";
    const [, last] = keys(before, after);
    expect(partialText(before, after, new Set([last]))).toBe("A\r\nb\r\nc\r\n");
  });

  it("builds a new file from nothing", () => {
    expect(partialText("", lines("a", "b"), new Set())).toBe(lines("a", "b"));
  });
});

describe("toggleChunk", () => {
  const all = ["k1", "k2", "k3"];

  it("excludes and includes one chunk", () => {
    expect(toggleChunk([], all, "k2", false)).toEqual(["k2"]);
    expect(toggleChunk(["k1", "k2"], all, "k2", true)).toEqual(["k1"]);
  });

  it("reports the whole file excluded when every chunk is", () => {
    expect(toggleChunk(["k1", "k2"], all, "k3", false)).toBe("all");
  });

  it("includes one chunk of an excluded file", () => {
    expect(toggleChunk("all", all, "k1", true)).toEqual(["k2", "k3"]);
  });
});

describe("pruneChunks", () => {
  it("drops keys of chunks that no longer exist", () => {
    expect(pruneChunks(["k1", "gone"], ["k1", "k2"])).toEqual(["k1"]);
  });

  it("reports the whole file excluded when the rest cover every chunk", () => {
    expect(pruneChunks(["k1", "gone"], ["k1"])).toBe("all");
  });

  it("keeps nothing when the file has no chunks", () => {
    expect(pruneChunks(["k1"], [])).toEqual([]);
  });
});
