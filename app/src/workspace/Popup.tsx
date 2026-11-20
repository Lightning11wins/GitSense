import { useEffect, type ReactNode } from "react";

type Props = {
  /** Screen position of the popup's top-left corner. */
  at: { x: number; y: number };
  onClose: () => void;
  children: ReactNode;
  width?: number;
};

/** A floating panel that closes on outside click or Escape. */
export function Popup({ at, onClose, children, width }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div className="popup-backdrop" onMouseDown={onClose} />
      <div className="popup" style={{ left: at.x, top: at.y, width }}>
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
