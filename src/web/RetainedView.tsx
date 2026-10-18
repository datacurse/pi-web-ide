import { memo, useEffect, useState, type ReactNode } from "react";

// An inactive chat must not receive the selected chat's props or callbacks.
const FrozenView = memo(
  function FrozenView({ children }: { active: boolean; children: ReactNode }) {
    return children;
  },
  (_previous, next) => !next.active,
);

/**
 * Mount on first use, then keep the view and its measurements alive until close.
 * visibility (not display:none) preserves virtual-list geometry and scroll state.
 */
export function RetainedView({
  active,
  visible = active,
  children,
  freeze = false,
  preloadDelay,
}: {
  active: boolean;
  visible?: boolean;
  children: ReactNode;
  freeze?: boolean;
  preloadDelay?: number;
}) {
  const [visited, setVisited] = useState(active);
  useEffect(() => {
    if (visited || preloadDelay === undefined) return;
    const timer = setTimeout(() => setVisited(true), preloadDelay);
    return () => clearTimeout(timer);
  }, [visited, preloadDelay]);
  if (active && !visited) setVisited(true);
  if (!active && !visited) return null;
  return (
    <div
      inert={!visible}
      aria-hidden={!visible}
      className={`absolute inset-0 flex min-h-0 min-w-0 flex-col ${visible ? "" : "invisible pointer-events-none"}`}
    >
      {freeze ? <FrozenView active={active}>{children}</FrozenView> : children}
    </div>
  );
}
