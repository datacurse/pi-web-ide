import { useEffect, useState } from "react";
import type { WorkoutKind } from "../shared/types.js";

/**
 * Stick figures for the workout dialog, drawn here rather than fetched: no
 * network, no licence. A figure flips between its poses to show the movement;
 * a hold (plank, wall sit) has one. viewBox 0 -8 120 82, floor at y 72.
 */

type P = [number, number];
interface Pose {
  head: P;
  lines: P[][];
}

function pose(
  head: P,
  neck: P,
  hip: P,
  legs: [P, P][],
  arms: [P, P][],
  more: P[][] = [],
): Pose {
  return {
    head,
    lines: [
      [neck, hip],
      ...legs.map(([knee, foot]) => [hip, knee, foot]),
      ...arms.map(([elbow, hand]) => [neck, elbow, hand]),
      ...more,
    ],
  };
}

const HANG: [P, P] = [
  [62, 27],
  [63, 38],
];
const STAND = pose(
  [60, 9],
  [60, 16],
  [60, 38],
  [
    [
      [60, 54],
      [60, 70],
    ],
  ],
  [HANG],
);
const PUSH_UP = pose(
  [87, 47],
  [80, 50],
  [55, 59],
  [
    [
      [38, 65],
      [22, 70],
    ],
  ],
  [
    [
      [80, 60],
      [80, 70],
    ],
  ],
);
const LYING = {
  head: [19, 66] as P,
  neck: [26, 68] as P,
  knee: [66, 54] as P,
  foot: [78, 70] as P,
};

const FIGURES: Record<WorkoutKind, { poses: Pose[]; wall?: boolean }> = {
  pushups: {
    poses: [
      PUSH_UP,
      pose(
        [88, 59],
        [81, 62],
        [55, 65],
        [
          [
            [38, 68],
            [22, 70],
          ],
        ],
        [
          [
            [72, 66],
            [80, 70],
          ],
        ],
      ),
    ],
  },
  situps: {
    poses: [
      pose(
        LYING.head,
        LYING.neck,
        [52, 68],
        [[LYING.knee, LYING.foot]],
        [
          [
            [37, 69],
            [48, 70],
          ],
        ],
      ),
      pose(
        [37, 41],
        [40, 47],
        [52, 68],
        [[LYING.knee, LYING.foot]],
        [
          [
            [50, 50],
            [60, 52],
          ],
        ],
      ),
    ],
  },
  squats: {
    poses: [
      pose(
        [60, 9],
        [60, 16],
        [60, 38],
        [
          [
            [60, 54],
            [60, 70],
          ],
        ],
        [
          [
            [71, 17],
            [82, 17],
          ],
        ],
      ),
      pose(
        [66, 29],
        [63, 35],
        [54, 55],
        [
          [
            [70, 58],
            [60, 70],
          ],
        ],
        [
          [
            [74, 35],
            [85, 35],
          ],
        ],
      ),
    ],
  },
  lunges: {
    poses: [
      STAND,
      pose(
        [58, 21],
        [58, 28],
        [58, 50],
        [
          [
            [73, 54],
            [74, 70],
          ],
          [
            [52, 65],
            [37, 68],
          ],
        ],
        [
          [
            [58, 39],
            [58, 50],
          ],
        ],
      ),
    ],
  },
  burpees: {
    poses: [
      PUSH_UP,
      pose(
        [60, 4],
        [60, 11],
        [60, 33],
        [
          [
            [60, 49],
            [60, 64],
          ],
        ],
        [
          [
            [53, 4],
            [48, -4],
          ],
          [
            [67, 4],
            [72, -4],
          ],
        ],
      ),
    ],
  },
  jumpingJacks: {
    poses: [
      pose(
        [60, 9],
        [60, 16],
        [60, 38],
        [
          [
            [58, 54],
            [57, 70],
          ],
          [
            [62, 54],
            [63, 70],
          ],
        ],
        [
          [
            [55, 26],
            [53, 37],
          ],
          [
            [65, 26],
            [67, 37],
          ],
        ],
      ),
      pose(
        [60, 9],
        [60, 16],
        [60, 38],
        [
          [
            [53, 54],
            [46, 70],
          ],
          [
            [67, 54],
            [74, 70],
          ],
        ],
        [
          [
            [51, 8],
            [45, -1],
          ],
          [
            [69, 8],
            [75, -1],
          ],
        ],
      ),
    ],
  },
  calfRaises: {
    poses: [
      pose(
        [60, 9],
        [60, 16],
        [60, 38],
        [
          [
            [60, 54],
            [60, 70],
          ],
        ],
        [HANG],
        [
          [
            [57, 70],
            [68, 70],
          ],
        ],
      ),
      pose(
        [60, 3],
        [60, 10],
        [60, 32],
        [
          [
            [60, 48],
            [60, 64],
          ],
        ],
        [
          [
            [62, 21],
            [63, 32],
          ],
        ],
        [
          [
            [60, 64],
            [68, 70],
          ],
        ],
      ),
    ],
  },
  gluteBridges: {
    poses: [
      pose(
        LYING.head,
        LYING.neck,
        [52, 68],
        [[LYING.knee, LYING.foot]],
        [
          [
            [37, 69],
            [48, 70],
          ],
        ],
      ),
      pose(
        LYING.head,
        LYING.neck,
        [50, 58],
        [[[68, 50], LYING.foot]],
        [
          [
            [37, 69],
            [48, 70],
          ],
        ],
      ),
    ],
  },
  plank: {
    poses: [
      pose(
        [89, 57],
        [82, 58],
        [56, 63],
        [
          [
            [39, 67],
            [22, 70],
          ],
        ],
        [
          [
            [82, 70],
            [93, 70],
          ],
        ],
      ),
    ],
  },
  wallSit: {
    poses: [
      pose(
        [43, 27],
        [43, 34],
        [43, 55],
        [
          [
            [60, 55],
            [60, 70],
          ],
        ],
        [
          [
            [46, 45],
            [55, 52],
          ],
        ],
      ),
    ],
    wall: true,
  },
};

export function WorkoutFigure({
  kind,
  className = "",
}: {
  kind: WorkoutKind;
  className?: string;
}) {
  const { poses, wall } = FIGURES[kind];
  const [i, setI] = useState(0);
  useEffect(() => {
    setI(0);
    if (poses.length < 2) return;
    const id = setInterval(() => setI((n) => (n + 1) % poses.length), 900);
    return () => clearInterval(id);
  }, [poses]);
  const p = poses[i] ?? poses[0];
  return (
    <svg
      viewBox="0 -8 120 82"
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <line
        x1={8}
        y1={72}
        x2={112}
        y2={72}
        strokeWidth={2}
        className="text-neutral-700"
      />
      {wall && (
        <line
          x1={38}
          y1={0}
          x2={38}
          y2={72}
          strokeWidth={2}
          className="text-neutral-700"
        />
      )}
      {p.lines.map((l, k) => (
        <polyline key={k} points={l.map((pt) => pt.join(",")).join(" ")} />
      ))}
      <circle cx={p.head[0]} cy={p.head[1]} r={5} fill="currentColor" />
    </svg>
  );
}
