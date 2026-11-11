import { GitBranch, Tag } from "@phosphor-icons/react";
/** Lay out topologically ordered commits in lanes, retaining parent connections. */
interface GraphCommit {
  hash: string;
  parents: string[];
}
interface Edge {
  from: number;
  to: number;
}
interface GraphRow {
  lane: number;
  incoming: Edge[];
  outgoing: Edge[];
  continuing: number[];
  width: number;
}

export function commitGraph<T extends GraphCommit>(commits: T[]) {
  let lanes: string[] = [];
  let width = 1;
  const rows = commits.map((commit) => {
    const before = [...lanes];
    let lane = lanes.indexOf(commit.hash);
    if (lane < 0) {
      lane = lanes.length;
      lanes.push(commit.hash);
    }
    const parents = commit.parents ?? [];
    lanes.splice(lane, 1, ...parents.filter((p) => !lanes.includes(p)));
    const incoming = before.map((hash, from) => ({
      from,
      to: hash === commit.hash ? lane : from,
    }));
    const outgoing = before.flatMap((hash, from) =>
      hash === commit.hash ? [] : [{ from, to: lanes.indexOf(hash) }],
    );
    for (const parent of parents) {
      outgoing.push({ from: lane, to: lanes.indexOf(parent) });
    }
    width = Math.max(width, before.length, lanes.length, lane + 1);
    return {
      commit,
      lane,
      incoming,
      outgoing,
      continuing: lanes.map((_, i) => i),
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
  incoming,
  outgoing,
  continuing,
  width,
}: GraphRow) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none relative shrink-0"
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
          fill="var(--color-neutral-950)"
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
    </div>
  );
}

/** Each ref gets its own readable badge, even when several share a commit. */
export function CommitRefs({ refs, lane }: { refs: string[]; lane: number }) {
  if (!refs.length) return null;
  return (
    <span className="flex flex-wrap gap-1 py-1">
      {refs.map((ref) => {
        const current = ref.startsWith("HEAD -> ");
        const name = current ? ref.slice(8) : ref;
        const tag = name.startsWith("tag: ");
        const Icon = tag ? Tag : GitBranch;
        return (
          <span
            key={ref}
            title={current ? `Current branch: ${name}` : ref}
            className={`inline-flex max-w-full items-center gap-1 rounded-sm border px-1.5 py-0.5 text-caption ${
              current
                ? "border-amber-400/50 bg-amber-950/60 text-amber-400"
                : `border-neutral-700 bg-neutral-900 ${tones[lane % tones.length]}`
            }`}
          >
            <Icon size={12} className="shrink-0" />
            <span className="min-w-0 break-all font-mono">
              {tag ? name.slice(5) : name}
            </span>
            {current && <span className="shrink-0 font-semibold">HEAD</span>}
          </span>
        );
      })}
    </span>
  );
}
