import { describe, expect, it } from "vitest";
import { layoutGraph, type GraphRow } from "./graph";

const c = (hash: string, ...parents: string[]) => ({ hash, parents });

/** Lines leaving each row downward, as "from>to". */
const down = (row: GraphRow) =>
  row.segments
    .filter((s) => s.part !== "top")
    .map((s) => `${s.from}>${s.to}`)
    .sort();

describe("layoutGraph", () => {
  it("keeps a linear history in one lane and color", () => {
    const rows = layoutGraph([c("c", "b"), c("b", "a"), c("a")]);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(new Set(rows.map((r) => r.color)).size).toBe(1);
    expect(rows[1].segments).toContainEqual({ from: 0, to: 0, part: "top", color: rows[0].color });
    expect(rows[2].segments.filter((s) => s.part === "bottom")).toEqual([]);
  });

  it("opens a lane for a merge's second parent and joins it back at the fork", () => {
    // m merges t into b; both come from a.
    const rows = layoutGraph([c("m", "b", "t"), c("t", "a"), c("b", "a"), c("a")]);
    expect(down(rows[0])).toEqual(["0>0", "0>1"]);
    expect(rows[1].lane).toBe(1);
    expect(rows[1].color).not.toBe(rows[0].color);
    expect(rows[2].lane).toBe(0);
    // b's line passes t's row, and t's line moves over to b's lane in b's row, so a stays in the first lane.
    expect(rows[1].segments).toContainEqual(expect.objectContaining({ from: 0, to: 0, part: "through" }));
    expect(rows[2].segments).toContainEqual(expect.objectContaining({ from: 1, to: 0, part: "through" }));
    expect(rows[3].lane).toBe(0);
  });

  it("gives separate branch tips their own lanes and colors", () => {
    const rows = layoutGraph([c("x", "a"), c("y", "a"), c("a")]);
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 0]);
    expect(rows[0].color).not.toBe(rows[1].color);
  });

  it("reuses a freed lane", () => {
    const rows = layoutGraph([c("x", "a"), c("y", "a"), c("a", "z"), c("w", "z"), c("z")]);
    expect(rows[3].lane).toBe(1);
  });

  it("joins a parent that another lane already waits for", () => {
    // y's parent a is already expected by x's lane.
    const rows = layoutGraph([c("x", "a"), c("y", "a"), c("a")]);
    expect(down(rows[1])).toEqual(["0>0", "1>0"]);
  });

  it("keeps the line of a parent outside the list running", () => {
    const rows = layoutGraph([c("b", "a"), c("q", "p")]);
    expect(rows[1].lane).toBe(1);
    expect(rows[1].segments).toContainEqual(expect.objectContaining({ from: 0, to: 0, part: "through" }));
  });
});
