import { GitBranch, Tag } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
/** Lay out topologically ordered commits in lanes, retaining parent connections. */
interface GraphCommit {
  hash: string;
  parents: string[];
  refs?: string[];
}
interface Edge {
  from: number;
  to: number;
}
interface GraphRow {
  lane: number;
  head: boolean;
  incoming: Edge[];
  outgoing: Edge[];
  continuing: number[];
  width: number;
  columnTitles: string[];
}

export function commitGraph<T extends GraphCommit>(commits: T[]) {
  // Git lanes are commit paths, not unique branches: shared history can belong
  // to several refs. Carry the known refs through ancestry rather than guessing
  // a branch from the lane's color (lane positions can be reused).
  const refsByHash = new Map<string, Set<string>>();
  for (const commit of commits) {
    refsByHash.set(commit.hash, new Set(commit.refs ?? []));
  }
  for (const commit of commits) {
    const refs = refsByHash.get(commit.hash)!;
    for (const parent of commit.parents ?? []) {
      const inherited = refsByHash.get(parent) ?? new Set<string>();
      for (const ref of refs) inherited.add(ref);
      refsByHash.set(parent, inherited);
    }
  }
  const describe = (hashes: string[]) => {
    if (!hashes.length) return "";
    const refs = new Set(
      hashes.flatMap((hash) => [...(refsByHash.get(hash) ?? [])]),
    );
    return refs.size
      ? [...refs].join("\n")
      : `Commit ${hashes[0]?.slice(0, 7) ?? "unknown"} (no named ref in loaded history)`;
  };
  let lanes: (string | null)[] = [];
  let width = 1;
  const rows = commits.map((commit) => {
    const before = [...lanes];
    let lane = lanes.indexOf(commit.hash);
    const head = (commit.refs ?? []).some(
      (ref) => ref === "HEAD" || ref.startsWith("HEAD -> "),
    );
    const branchTip = (commit.refs ?? []).some(
      (ref) =>
        ref !== "HEAD" && !ref.startsWith("tag: ") && !ref.endsWith("/HEAD"),
    );
    // Give an ancestor branch tip a distinct lane, even in linear history.
    // A vacant slot keeps the previous branch's incoming edge intact without
    // drawing a duplicate commit or inventing a parallel ancestry path.
    if (lane >= 0 && branchTip && !head) {
      const previous = lane;
      const vacant = lanes.indexOf(null);
      lane = vacant < 0 ? lanes.length : vacant;
      lanes[previous] = null;
      lanes[lane] = commit.hash;
    }
    if (lane < 0) {
      lane = lanes.length;
      lanes.push(commit.hash);
    }
    const parents = commit.parents ?? [];
    lanes.splice(lane, 1, ...parents.filter((p) => !lanes.includes(p)));
    const incoming = before.flatMap((hash, from) =>
      hash ? [{ from, to: hash === commit.hash ? lane : from }] : [],
    );
    const outgoing = before.flatMap((hash, from) =>
      !hash || hash === commit.hash ? [] : [{ from, to: lanes.indexOf(hash) }],
    );
    for (const parent of parents) {
      outgoing.push({ from: lane, to: lanes.indexOf(parent) });
    }
    width = Math.max(width, before.length, lanes.length, lane + 1);
    return {
      commit,
      lane,
      head,
      incoming,
      outgoing,
      continuing: lanes.flatMap((hash, i) => (hash ? [i] : [])),
      columnTitles: Array.from({ length: width }, (_, column) =>
        describe(
          [
            before[column],
            column === lane ? commit.hash : undefined,
            lanes[column],
          ].filter((hash): hash is string => Boolean(hash)),
        ),
      ),
    };
  });
  return rows.map((row) => ({ ...row, width }));
}

const tones = [
  "text-amber-400",
  "text-blue-400",
  "text-green-400",
  "text-red-400",
];
const x = (lane: number) => 8 + lane * 16;

export function CommitGraph({
  lane,
  head,
  incoming,
  outgoing,
  continuing,
  width,
  columnTitles,
}: GraphRow) {
  return (
    <div
      aria-hidden="true"
      className="relative shrink-0"
      style={{ width: width * 16 }}
    >
      <svg width="100%" height="22" className="block">
        {incoming.map(({ from, to }, i) => (
          <path
            key={i}
            d={`M ${x(from)} 0 C ${x(from)} 5.5 ${x(to)} 5.5 ${x(to)} 11`}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className={tones[from % tones.length]}
          />
        ))}
        {outgoing.map(({ from, to }, i) => (
          <path
            key={i}
            d={`M ${x(from)} 11 C ${x(from)} 16.5 ${x(to)} 16.5 ${x(to)} 22`}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className={tones[to % tones.length]}
          />
        ))}
        <circle
          cx={x(lane)}
          cy="11"
          r="3.5"
          fill={head ? "currentColor" : "var(--color-neutral-950)"}
          stroke="currentColor"
          strokeWidth="1.5"
          className={tones[lane % tones.length]}
        />
      </svg>
      <svg
        width="100%"
        height="100%"
        className="absolute left-0"
        style={{ top: 22, height: "calc(100% - 22px)" }}
      >
        {continuing.map((column) => (
          <line
            key={column}
            x1={x(column)}
            x2={x(column)}
            y1="0"
            y2="100%"
            stroke="currentColor"
            strokeWidth="1.5"
            className={tones[column % tones.length]}
          />
        ))}
      </svg>
      {columnTitles.map((title, column) =>
        title ? (
          <GraphLaneTooltip key={column} label={title} column={column} />
        ) : null,
      )}
    </div>
  );
}

function GraphLaneTooltip({
  label,
  column,
}: {
  label: string;
  column: number;
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const popup = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = popup.current;
    if (!anchor || !element) return;
    const bounds = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(anchor.right + 8, window.innerWidth - bounds.width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(anchor.top, window.innerHeight - bounds.height - 8))}px`;
  }, [anchor, label]);
  useEffect(() => {
    if (!anchor) return;
    const close = () => setAnchor(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [anchor]);
  return (
    <span
      className="absolute inset-y-0"
      style={{ left: column * 16, width: 16 }}
      onPointerEnter={(event) => {
        if (event.pointerType !== "touch") {
          setAnchor(event.currentTarget.getBoundingClientRect());
        }
      }}
      onPointerLeave={() => setAnchor(null)}
      onPointerDown={() => setAnchor(null)}
    >
      {anchor &&
        createPortal(
          <div
            ref={popup}
            role="tooltip"
            className="pointer-events-none fixed z-50 max-w-[calc(100vw-1rem)] rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-ui text-neutral-200 shadow-lg"
            style={{ left: anchor.right + 8, top: anchor.top }}
          >
            <p className="mb-1 text-caption uppercase tracking-wide text-neutral-500">
              Branch / ref
            </p>
            {label.split("\n").map((ref) => {
              const current = ref.startsWith("HEAD -> ");
              const tag = ref.startsWith("tag: ");
              const Icon = tag ? Tag : GitBranch;
              return (
                <div key={ref} className="flex items-start gap-2 py-0.5">
                  <Icon
                    size={13}
                    className={`mt-0.5 shrink-0 ${current ? "text-amber-400" : tones[column % tones.length]}`}
                  />
                  <span className="min-w-0 break-words font-mono text-meta">
                    {current ? ref.slice(8) : tag ? ref.slice(5) : ref}
                  </span>
                  {current && (
                    <span className="text-caption font-semibold text-amber-400">
                      HEAD
                    </span>
                  )}
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </span>
  );
}
