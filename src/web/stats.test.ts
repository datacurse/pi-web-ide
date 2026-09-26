// Run: node --import tsx src/web/stats.test.ts
import assert from "node:assert/strict";
import { dayKey, heatmapWeeks, percentile, streaks } from "./stats.js";

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
