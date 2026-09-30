import assert from "node:assert/strict";
import { parseProfile, restingKcalPerDay, setKcal } from "./calories.ts";

const man = { sex: "male", age: 30, heightCm: 180, weightKg: 80 } as const;
// 800 + 1125 - 150 + 5
assert.equal(restingKcalPerDay(man), 1780);
// 8 MET × 1780/1440 kcal/min × 20 s
assert.equal(setKcal("pushups", 10, man).toFixed(3), ((8 * 1780) / 1440 / 3).toFixed(3));
// A hold counts its seconds, not reps.
assert.equal(setKcal("plank", 20, man).toFixed(3), ((3.8 * 1780) / 1440 / 3).toFixed(3));
assert.ok(setKcal("pushups", 10, { ...man, sex: "female" }) < setKcal("pushups", 10, man));

assert.deepEqual(parseProfile(man), man);
assert.equal(parseProfile({ ...man, age: 5 }), null);
assert.equal(parseProfile({ ...man, sex: "x" }), null);
assert.equal(parseProfile({ ...man, weightKg: "80" }), null);
assert.equal(parseProfile(null), null);
console.log("calories: ok");
