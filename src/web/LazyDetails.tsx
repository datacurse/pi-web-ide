import {
  memo,
  useLayoutEffect,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";

// Retain the mounted subtree after first use so nested disclosures, scroll
// positions and selections survive closing. Closed bodies do not receive
// streamed props; reopening immediately supplies the latest content.
const DisclosureBody = memo(
  function DisclosureBody({
    children,
  }: {
    active: boolean;
    children: ReactNode;
  }) {
    return <>{children}</>;
  },
  (previous, next) =>
    previous.active === next.active &&
    (!next.active || previous.children === next.children),
);

type Props = Omit<ComponentPropsWithoutRef<"details">, "children"> & {
  summary: ReactNode;
  children: ReactNode;
};

/** Native mouse/keyboard disclosure behavior, with on-demand body rendering. */
export function LazyDetails({
  summary,
  children,
  open,
  onToggle,
  ...props
}: Props) {
  const [active, setActive] = useState(!!open);
  const [visited, setVisited] = useState(!!open);
  useLayoutEffect(() => {
    // A changed default (e.g. Expand work or the codemode preference) must
    // expose its body too. Ordinary rerenders do not reset native toggles.
    setActive(!!open);
    if (open) setVisited(true);
  }, [open]);
  return (
    <details
      {...props}
      open={open}
      onToggle={(event) => {
        // React's toggle event bubbles; a nested disclosure is not this one.
        if (event.target !== event.currentTarget) return;
        const expanded = event.currentTarget.open;
        setActive(expanded);
        if (expanded) setVisited(true);
        onToggle?.(event);
      }}
    >
      {summary}
      {(visited || open) && (
        <DisclosureBody active={active}>{children}</DisclosureBody>
      )}
    </details>
  );
}
