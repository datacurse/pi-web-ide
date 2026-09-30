/**
 * pwiExtensions.ts — the switches on the Packages page's pwi extensions tab:
 * the tool-metrics collector, one of the pi extensions pwi loads into the
 * sessions it starts (on unless turned off), and the workout gate, which the
 * browser applies before each send (off unless turned on). The page shows them
 * beside the personality (personality.ts).
 */

import type { PwiExtensions } from "../shared/types.js";
import { readStateFile, statePath, writeStateFile } from "./state.js";

const FILE = "pwi-extensions.json";

function read(): Record<string, unknown> {
	try {
		return JSON.parse(readStateFile(statePath(FILE)) ?? "{}");
	} catch {
		return {};
	}
}

export function readToolMetrics(): boolean {
	return read().toolMetrics !== false;
}

export function pwiExtensions(): PwiExtensions {
	const s = read();
	return { toolMetrics: s.toolMetrics !== false, workout: s.workout === true };
}

export function writePwiExtension(key: keyof PwiExtensions, on: boolean): PwiExtensions {
	const next = { ...pwiExtensions(), [key]: on };
	writeStateFile(statePath(FILE), `${JSON.stringify(next)}\n`);
	return next;
}
