import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "./cn";

/**
 * Portal-based Popover primitive. Renders its content into
 * document.body so it can never be clipped by an ancestor's
 * `overflow: hidden / auto` or trapped in a low stacking context.
 *
 * Positioning is computed from the trigger's getBoundingClientRect()
 * with useLayoutEffect + rAF, and recomputed on scroll (capture)
 * and window resize while the popover is open. Handles outside-click
 * (accounts for portalled content) and Escape.
 *
 * Public API is intentionally minimal so existing components (Select,
 * SingleSelectCombobox, MultiSelectPopover, MonthPicker, DateInput)
 * can wrap it without leaking Popover concepts into the pages.
 */

type Align = "start" | "end";

type Props = {
  open: boolean;
  onClose: () => void;
  /** The trigger element — Popover reads its bounding rect for
   *  positioning. Must be a stable ref (passed by the caller). */
  triggerRef: React.RefObject<HTMLElement>;
  children: ReactNode;
  /** Horizontal alignment relative to the trigger. Default: "start". */
  align?: Align;
  /** Vertical offset (px) between trigger and content. Default: 4. */
  sideOffset?: number;
  /** Force content to match the trigger's width (like a native
   *  <select> dropdown). Default: false. */
  matchTriggerWidth?: boolean;
  /** Classes applied to the outer content container. */
  contentClassName?: string;
  /** Optional min width in px (only when matchTriggerWidth is off). */
  minWidth?: number;
  /** Role for a11y — "listbox" for select-like popovers, "dialog"
   *  for calendars. Default: "dialog". */
  role?: "listbox" | "dialog" | "menu";
  /** Aria label passthrough. */
  ariaLabel?: string;
};

type Rect = { top: number; left: number; width: number };

export function Popover({
  open,
  onClose,
  triggerRef,
  children,
  align = "start",
  sideOffset = 4,
  matchTriggerWidth = false,
  contentClassName,
  minWidth,
  role = "dialog",
  ariaLabel,
}: Props) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);

  const compute = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const r = trigger.getBoundingClientRect();
    const content = contentRef.current;
    const contentWidth = content?.offsetWidth ?? 0;
    // scrollY/X so that once written into document.body's frame the
    // coords stay glued to the trigger even if the page is scrolled.
    const top = r.bottom + window.scrollY + sideOffset;
    let left: number;
    if (matchTriggerWidth) {
      left = r.left + window.scrollX;
    } else if (align === "end") {
      // Right-align to the trigger's right edge.
      const w = contentWidth || minWidth || r.width;
      left = r.right + window.scrollX - w;
    } else {
      left = r.left + window.scrollX;
    }
    // Keep the popover inside the viewport horizontally with an 8px
    // guard so it never bleeds off-screen on narrow desktops.
    const w = matchTriggerWidth
      ? r.width
      : contentWidth || minWidth || r.width;
    const viewportRight = window.scrollX + document.documentElement.clientWidth - 8;
    if (left + w > viewportRight) left = Math.max(8 + window.scrollX, viewportRight - w);
    if (left < window.scrollX + 8) left = window.scrollX + 8;
    setRect({ top, left, width: r.width });
  }, [triggerRef, sideOffset, matchTriggerWidth, align, minWidth]);

  // Position on open + whenever geometry might change.
  useLayoutEffect(() => {
    if (!open) return;
    compute();
    // Second pass on next frame after content mounts (so
    // contentWidth is accurate for align="end").
    const raf = requestAnimationFrame(compute);
    return () => cancelAnimationFrame(raf);
  }, [open, compute]);

  useEffect(() => {
    if (!open) return;
    const onScroll = () => compute();
    const onResize = () => compute();
    // Capture-phase so we hear about scroll on *any* ancestor,
    // not just window. That way the popover tracks the trigger
    // when a scrollable card underneath moves.
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, compute]);

  // Outside-click + Escape. Must account for portalled content:
  // check both the trigger and the content ref.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (contentRef.current?.contains(t)) return;
      if (triggerRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, triggerRef]);

  if (!open || typeof document === "undefined") return null;

  const style: React.CSSProperties = {
    position: "absolute",
    top: rect?.top ?? -9999,
    left: rect?.left ?? -9999,
    zIndex: "var(--z-popover)" as unknown as number,
    // Hide until we've computed a real rect to avoid a flash at 0,0.
    visibility: rect ? "visible" : "hidden",
  };
  if (matchTriggerWidth && rect) {
    style.width = rect.width;
  } else if (minWidth) {
    style.minWidth = minWidth;
  }

  return createPortal(
    <div
      ref={contentRef}
      role={role}
      aria-label={ariaLabel}
      style={style}
      className={cn("nf-popover-content", contentClassName)}
    >
      {children}
    </div>,
    document.body,
  );
}
