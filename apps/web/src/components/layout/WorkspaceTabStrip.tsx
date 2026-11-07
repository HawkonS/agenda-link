import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

/** Horizontal tabs stay usable when the available header width is small. */
export function WorkspaceTabStrip({
  label,
  activeId,
  children,
}: {
  label: string;
  activeId?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({
    overflow: false,
    left: false,
    right: false,
  });
  function measure() {
    const el = ref.current;
    if (el)
      setScroll({
        overflow: el.scrollWidth > el.clientWidth + 2,
        left: el.scrollLeft > 2,
        right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2,
      });
  }
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, [children]);
  useEffect(() => {
    ref.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "center" });
    measure();
  }, [activeId, scroll.overflow]);
  return (
    <div className="topbar-tab-strip">
      {scroll.overflow && (
        <button
          type="button"
          className="tab-scroll-arrow"
          aria-label="查看前面的页面选项"
          disabled={!scroll.left}
          onClick={() =>
            ref.current?.scrollBy({ left: -180, behavior: "smooth" })
          }
        >
          <ChevronLeft />
        </button>
      )}
      <div
        ref={ref}
        onScroll={measure}
        className="topbar-context-tabs"
        role="tablist"
        aria-label={label}
      >
        {children}
      </div>
      {scroll.overflow && (
        <button
          type="button"
          className="tab-scroll-arrow"
          aria-label="查看后面的页面选项"
          disabled={!scroll.right}
          onClick={() =>
            ref.current?.scrollBy({ left: 180, behavior: "smooth" })
          }
        >
          <ChevronRight />
        </button>
      )}
    </div>
  );
}
