import type { PointerEvent } from "react";

type Direction = "vertical" | "horizontal";

type Props = {
  /** "vertical" splits side by side; "horizontal" stacks. */
  direction: Direction;
  onResize: (delta: number) => void;
};

/** A draggable divider between two panels. Reports pixel deltas while dragging. */
export function Splitter({ direction, onResize }: Props) {
  return <div className={`splitter splitter-${direction}`} onPointerDown={(e) => startDrag(e, direction, onResize)} />;
}

/** Starts dragging from a pointer press on a divider, reporting pixel deltas across it until release. */
export function startDrag(e: PointerEvent<HTMLElement>, direction: Direction, onResize: (delta: number) => void) {
  e.preventDefault();
  const target = e.currentTarget;
  target.setPointerCapture(e.pointerId);
  let last = direction === "vertical" ? e.clientX : e.clientY;
  const move = (m: globalThis.PointerEvent) => {
    const pos = direction === "vertical" ? m.clientX : m.clientY;
    onResize(pos - last);
    last = pos;
  };
  const stop = () => {
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", stop);
  };
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", stop);
}
