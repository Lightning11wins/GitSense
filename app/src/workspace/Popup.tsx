import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

type Props = {
  /** Screen position of the popup's top-left corner. */
  at: { x: number; y: number };
  onClose: () => void;
  children: ReactNode;
  width?: number;
};

/** A floating panel that closes on outside click or Escape, kept inside the window. */
export function Popup({ at, onClose, children, width }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);
  useLayoutEffect(() => {
    const rect = ref.current!.getBoundingClientRect();
    setPos({
      x: Math.max(0, Math.min(at.x, window.innerWidth - rect.width - 4)),
      y: Math.max(0, Math.min(at.y, window.innerHeight - rect.height - 4)),
    });
  }, [at.x, at.y]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div className="popup-backdrop" onMouseDown={onClose} />
      <div ref={ref} className="popup" style={{ left: pos.x, top: pos.y, width }}>
        {children}
      </div>
    </>
  );
}

/** Position just below an element, for opening a popup from a button. */
export function below(element: Element): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom + 4 };
}
