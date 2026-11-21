import { describe, expect, it } from "vitest";
import type { LogCommit } from "../protocol.gen";
import { interleave } from "./interleave";

const commit = (hash: string, commit_time: number): LogCommit => ({
  hash,
  parents: [],
  author_name: "Ann",
  author_email: "ann@example.com",
  author_time: commit_time,
  commit_time,
  subject: `Commit ${hash}.`,
  head: false,
  refs: [],
});

const hashes = (result: ReturnType<typeof interleave>) => result.rows.map((r) => `${r.repo}:${r.commit.hash}`);

describe("interleave", () => {
  it("merges repos newest first", () => {
    const result = interleave([
      { repo: "api", commits: [commit("a2", 50), commit("a1", 10)], complete: true },
      { repo: "web", commits: [commit("w2", 40), commit("w1", 20)], complete: true },
    ]);
    expect(hashes(result)).toEqual(["api:a2", "web:w2", "web:w1", "api:a1"]);
    expect(result.blocked).toBeUndefined();
  });

  it("keeps a repo's own order even when its dates are out of order", () => {
    const result = interleave([{ repo: "api", commits: [commit("child", 10), commit("parent", 30)], complete: true }]);
    expect(hashes(result)).toEqual(["api:child", "api:parent"]);
  });

  it("stops where an incomplete repo runs out", () => {
    const result = interleave([
      { repo: "api", commits: [commit("a2", 50), commit("a1", 10)], complete: true },
      { repo: "web", commits: [commit("w2", 40)], complete: false },
    ]);
    expect(hashes(result)).toEqual(["api:a2", "web:w2"]);
    expect(result.blocked).toBe("web");
  });

  it("is blocked before any rows when an incomplete repo has nothing loaded", () => {
    const result = interleave([
      { repo: "api", commits: [commit("a1", 10)], complete: true },
      { repo: "web", commits: [], complete: false },
    ]);
    expect(result).toEqual({ rows: [], blocked: "web" });
  });
});
