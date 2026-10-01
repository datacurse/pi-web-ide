export const ACTIVITY_STATUS = "pwi-activity";

export type ActivityKind = "preparing" | "request" | "response" | "thinking" | "text" | "toolcall" | "tools" | "processing" | "retry" | "compaction" | "input";

export interface ActivityStep {
	kind: ActivityKind;
	label: string;
	start: number;
	end?: number;
}

export interface ActivityTool {
	id: string;
	label: string;
	start: number;
	end?: number;
	isError?: boolean;
}

export interface TurnActivity {
	start: number;
	/** The actual user message timestamp, for matching the answer footer. */
	asked?: number;
	end?: number;
	lastOutputAt?: number;
	steps: ActivityStep[];
	tools: ActivityTool[];
}

const kinds: ActivityKind[] = ["preparing", "request", "response", "thinking", "text", "toolcall", "tools", "processing", "retry", "compaction", "input"];
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const time = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Validate both saved traces and extension frames at the trust boundary. */
export function parseActivity(value: unknown): TurnActivity | undefined {
	if (!record(value) || !time(value.start) || !Array.isArray(value.steps) || !Array.isArray(value.tools)) return;
	if (value.end !== undefined && (!time(value.end) || value.end < value.start)) return;
	if (value.asked !== undefined && !time(value.asked)) return;
	if (value.lastOutputAt !== undefined && (!time(value.lastOutputAt) || value.lastOutputAt < value.start || (value.end !== undefined && value.lastOutputAt > (value.end as number)))) return;
	const span = (v: unknown) => record(v) && time(v.start) && v.start >= (value.start as number) &&
		(v.end === undefined ? value.end === undefined : (time(v.end) && v.end >= v.start && (value.end === undefined || v.end <= (value.end as number)))) &&
		typeof v.label === "string" && v.label.length <= 240;
	if (!value.steps.every((s) => span(s) && record(s) && kinds.includes(s.kind as ActivityKind))) return;
	if (!value.tools.every((s) => span(s) && record(s) && typeof s.id === "string" && (s.isError === undefined || typeof s.isError === "boolean"))) return;
	for (let i = 1; i < value.steps.length; i++) {
		if (value.steps[i - 1].end !== value.steps[i].start) return;
	}
	// SAFETY: all fields and nested spans were validated above; TypeScript cannot retain the array predicates.
	return value as unknown as TurnActivity;
}

export function activityLabel(kind: ActivityKind): string {
	switch (kind) {
		case "preparing": return "Preparing request";
		case "request": return "Sending request / waiting for provider response";
		case "response": return "Response received · waiting for model output";
		case "thinking": return "Receiving reasoning";
		case "text": return "Receiving answer";
		case "toolcall": return "Receiving tool-call arguments";
		case "tools": return "Running tools";
		case "processing": return "Processing between requests";
		case "retry": return "Waiting to retry";
		case "compaction": return "Compacting conversation";
		case "input": return "Waiting for your input";
	}
}

/** Non-overlapping phase totals: parallel tools must not inflate wall time. */
export function activityTotals(activity: TurnActivity, now: number): Partial<Record<ActivityKind, number>> {
	const totals: Partial<Record<ActivityKind, number>> = {};
	for (const step of activity.steps) totals[step.kind] = (totals[step.kind] ?? 0) + Math.max(0, (step.end ?? activity.end ?? now) - step.start);
	return totals;
}

export function activityDuration(ms: number): string {
	const seconds = Math.max(0, ms) / 1000;
	return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(1)}s`;
}
