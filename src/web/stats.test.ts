// Run: node --import tsx src/web/stats.test.ts
import assert from "node:assert/strict";
import { dayKey, heatmapWeeks, pace, percentile, span, streaks } from "./stats.js";

const today = new Date(2026, 2, 10); // Tue 10 Mar 2026
const days = (...ds: number[]) => new Set(ds.map((d) => dayKey(new Date(2026, 2, d))));

// Today active: counts back from today. Month boundaries are plain days.
assert.deepEqual(streaks(days(8, 9, 10), today), { current: 3, longest: 3 });
// Today empty: the streak is still alive from yesterday.
assert.deepEqual(streaks(days(8, 9), today), { current: 2, longest: 2 });
// A gap yesterday ends it; longest remembers the older run.
assert.deepEqual(streaks(new Set([...days(1, 2, 3, 4), ...days(7)]), today), { current: 0, longest: 4 });
assert.deepEqual(streaks(new Set(["2026-02-28", "2026-03-01"]), today).longest, 2);

assert.equal(percentile([1, 2, 3, 4], 0.5), 3);
assert.equal(percentile([], 0.5), 0);

const weeks = heatmapWeeks(2, today);
assert.equal(weeks.length, 2);
assert.equal(dayKey(weeks[1]![0]!), "2026-03-09"); // Monday of this week
assert.equal(weeks[1]![2], null); // Wednesday, still ahead

// Pace: 2h into a 5h window at 20% averages 10%/h, so 50% at reset.
const H = 3_600_000;
const on = pace(20, 5 * H, 5 * H, 2 * H)!;
assert.equal(on.projected, 50);
assert.equal(on.runsOut, null);
assert.equal(on.room, 80 / 30);
// 60% in 2h runs out at 100% after 3h20m, 1h40m before the reset.
const over = pace(60, 5 * H, 5 * H, 2 * H)!;
assert.equal(over.runsOut, (10 / 3) * H);
assert.ok(over.room < 1);
assert.equal(pace(0, 5 * H, 5 * H, 2 * H)!.room, Infinity);
assert.equal(pace(10, 5 * H, 5 * H, 6 * H), null); // already reset
assert.equal(span(100 * 60_000), "1h 40m");
assert.equal(span(27 * H), "1d 3h");
