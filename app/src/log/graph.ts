// Commit graph layout: assigns each commit a lane and lists the line segments drawn in its row.

/** A line in one row, from lane `from` to lane `to`. Coordinates are lanes, not pixels. */
export type Segment = {
  from: number;
  to: number;
  /** `top` runs from the row's top edge to its middle, `bottom` from the middle to the bottom edge, `through` the full height. */
  part: "top" | "bottom" | "through";
  color: number;
};

export type GraphRow = { lane: number; color: number; segments: Segment[] };

/**
 * Lays out commits listed children before parents. Each row has the commit's lane and color, and its segments: edges
 * from children above, edges to parents below, and lines passing by. A parent missing from the list keeps its line
 * running to the bottom.
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
      if (hash !== null) segments.push({ from: i, to: i === moved && moved > lane ? lane : i, part: "through", color: colors[i] });
    });
    for (const i of incoming) segments.push({ from: i, to: lane, part: "top", color: colors[i] });

    if (first !== undefined) {
      if (moved >= 0 && moved < lane) {
        segments.push({ from: lane, to: moved, part: "bottom", color: colors[moved] });
      } else {
        if (moved > lane) lanes[moved] = null;
        lanes[lane] = first;
        colors[lane] = color;
        segments.push({ from: lane, to: lane, part: "bottom", color });
      }
    }
    for (const parent of others) {
      const existing = lanes.indexOf(parent);
      if (existing >= 0) {
        segments.push({ from: lane, to: existing, part: "bottom", color: colors[existing] });
        continue;
      }
      const target = free();
      lanes[target] = parent;
      colors[target] = nextColor++;
      segments.push({ from: lane, to: target, part: "bottom", color: colors[target] });
    }
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
    return { lane, color, segments };
  });
}
