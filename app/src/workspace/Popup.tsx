import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export type Point = { x: number; y: number };

type Props = {
  /** Screen position of the popup's top-left corner. */
  at: Point;
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
export function below(element: Element): Point {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom + 4 };
}

/** A menu action. `disabled` says why it is unavailable. */
export type MenuAction = { label: string; hint?: string; disabled?: string; run: () => void } | "separator";

/** A popup menu of actions. Choosing one closes the menu, then runs it. */
export function Menu({ at, actions, onClose, width }: { at: Point; actions: MenuAction[]; onClose: () => void; width?: number }) {
  return (
    <Popup at={at} onClose={onClose} width={width}>
      <div className="popup-list">
        {actions.map((a, i) =>
          a === "separator" ? (
            <div key={i} className="popup-separator" />
          ) : (
            <button
              key={i}
              className="popup-item"
              disabled={!!a.disabled}
              title={a.disabled}
              autoFocus={i === 0}
              onClick={() => {
                onClose();
                a.run();
              }}
            >
              {a.label}
              {a.hint && <span className="hint">{a.hint}</span>}
            </button>
          ),
        )}
      </div>
    </Popup>
  );
}
