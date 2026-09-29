/**
 * pwiExtensions.ts — the switch for the tool-metrics collector, one of the pi
 * extensions pwi loads into the sessions it starts; on unless turned off. The
 * Packages page shows it beside the personality (personality.ts).
 */

import type { PwiExtensions } from "../shared/types.js";
import { readStateFile, statePath, writeStateFile } from "./state.js";

const FILE = "pwi-extensions.json";

export function readToolMetrics(): boolean {
	try {
		return JSON.parse(readStateFile(statePath(FILE)) ?? "{}").toolMetrics !== false;
	} catch {
		return true;
	}
}

export function writeToolMetrics(on: boolean): PwiExtensions {
	writeStateFile(statePath(FILE), `${JSON.stringify({ toolMetrics: on })}\n`);
	return pwiExtensions();
}

export function pwiExtensions(): PwiExtensions {
	return { toolMetrics: readToolMetrics() };
}
