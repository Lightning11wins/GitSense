import { describe, expect, it } from "vitest";
import type { ShelfEntry } from "../protocol.gen";
import { entryRowKey, fileRowKey, shelfTargets, sortedItems } from "./shelf";

const entry = (id: string, created: number, ...paths: string[]): ShelfEntry => ({
  id,
  message: `Shelved ${id}`,
  created,
  base: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  files: paths.map((path) => ({ path, orig_path: null, kind: "modified" })),
});

const api = "/home/user/code/api";
const web = "/home/user/code/web";

describe("sortedItems", () => {
  it("merges repos newest first, breaking ties by id", () => {
    const items = sortedItems([
      [api, [entry("18f0-a", 300), entry("18e0-a", 100)]],
      [web, [entry("18f0-b", 300), entry("18e8-b", 200)]],
    ]);
    expect(items.map((i) => [i.repo, i.entry.id])).toEqual([
      [web, "18f0-b"],
      [api, "18f0-a"],
      [web, "18e8-b"],
      [api, "18e0-a"],
    ]);
  });
});

describe("shelfTargets", () => {
  const items = sortedItems([
    [api, [entry("2", 200, "src/lib.rs", "src/main.rs"), entry("1", 100, "README.md")]],
    [web, [entry("3", 300, "index.ts")]],
  ]);
  const [web3, api2, api1] = items;

  it("takes a selected entry whole, even with some of its files selected", () => {
    const selected = new Set([entryRowKey(api2), fileRowKey(api2, "src/lib.rs")]);
    expect(shelfTargets(items, selected)).toEqual([{ item: api2, paths: null }]);
  });

  it("takes selected files of entries that are not selected, in entry order", () => {
    const selected = new Set([fileRowKey(api1, "README.md"), fileRowKey(api2, "src/main.rs"), entryRowKey(web3)]);
    expect(shelfTargets(items, selected)).toEqual([
      { item: web3, paths: null },
      { item: api2, paths: ["src/main.rs"] },
      { item: api1, paths: ["README.md"] },
    ]);
  });

  it("is empty when nothing is selected", () => {
    expect(shelfTargets(items, new Set())).toEqual([]);
  });
});
