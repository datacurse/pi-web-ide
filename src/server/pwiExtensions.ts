/**
 * pwiExtensions.ts — the pi extensions pwi loads into the sessions it starts
 * that a user can switch: the tool-metrics collector (on unless turned off)
 * and the personality reminder (personality.ts). The Packages page lists them.
 */

import type { PwiExtensions } from "../shared/types.js";
import { readPersonality, readRemind } from "./personality.js";
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
	return {
		toolMetrics: readToolMetrics(),
		remind: readRemind(),
		personality: readPersonality().content.trim() !== "",
	};
}
