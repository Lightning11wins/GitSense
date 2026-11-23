// Commit graph layout: assigns each commit a lane and lists the lines drawn below it.

/** A line from lane `from` at this row's commit height to lane `to` at the next row's. Coordinates are lanes, not pixels. */
export type Segment = {
  from: number;
  to: number;
  color: number;
  /** The line runs from a merge commit to a parent other than its first. */
  merge: boolean;
};

export type GraphRow = { lane: number; color: number; segments: Segment[] };

/**
 * Lays out commits listed children before parents. Each row has the commit's lane and color, and the segments leaving
 * it downward: edges to parents and lines passing by. A parent missing from the list keeps its line running to the
 * bottom.
 */
export function layoutGraph(commits: readonly { hash: string; parents: readonly string[] }[]): GraphRow[] {
  /** The hash each lane is waiting for, or null when free. */
  const lanes: (string | null)[] = [];
  const colors: number[] = [];
  let nextColor = 0;
  const free = () => {
    const index = lanes.indexOf(null);
    return index >= 0 ? index : lanes.length;
  };

  return commits.map((commit) => {
    const incoming = lanes.flatMap((hash, i) => (hash === commit.hash ? [i] : []));
    const lane = incoming.length > 0 ? incoming[0] : free();
    const color = incoming.length > 0 ? colors[lane] : nextColor++;
    for (const i of incoming) lanes[i] = null;
    // A first parent already waited for in a lane to the right moves over, keeping first-parent chains straight.
    const [first, ...others] = commit.parents;
    const moved = first === undefined ? -1 : lanes.indexOf(first);
    const segments: Segment[] = [];
    lanes.forEach((hash, i) => {
      if (hash !== null) segments.push({ from: i, to: i === moved && moved > lane ? lane : i, color: colors[i], merge: false });
    });

    if (first !== undefined) {
      if (moved >= 0 && moved < lane) {
        segments.push({ from: lane, to: moved, color: colors[moved], merge: false });
      } else {
        if (moved > lane) lanes[moved] = null;
        lanes[lane] = first;
        colors[lane] = color;
        segments.push({ from: lane, to: lane, color, merge: false });
      }
    }
    for (const parent of others) {
      const existing = lanes.indexOf(parent);
      if (existing >= 0) {
        segments.push({ from: lane, to: existing, color: colors[existing], merge: true });
        continue;
      }
      const target = free();
      lanes[target] = parent;
      colors[target] = nextColor++;
      segments.push({ from: lane, to: target, color: colors[target], merge: true });
    }
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
    return { lane, color, segments };
  });
}
