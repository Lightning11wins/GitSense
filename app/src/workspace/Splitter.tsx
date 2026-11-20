import type { PointerEvent } from "react";

type Props = {
  /** "vertical" splits side by side; "horizontal" stacks. */
  direction: "vertical" | "horizontal";
  onResize: (delta: number) => void;
};

/** A draggable divider between two panels. Reports pixel deltas while dragging. */
export function Splitter({ direction, onResize }: Props) {
  function start(e: PointerEvent<HTMLDivElement>) {
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
  return <div className={`splitter splitter-${direction}`} onPointerDown={start} />;
}
