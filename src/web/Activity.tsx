import { useEffect, useState } from "react";
import { CaretDown, CaretRight } from "@phosphor-icons/react";
import { activityDuration, activityLabel, activityTotals, type ActivityStep, type TurnActivity } from "../shared/activity.js";
import { t } from "./i18n.js";

function phaseLabel(step: ActivityStep): string {
	if (step.kind === "tools") return t("Running {tools}", { tools: step.label.replace(/^Running /, "") });
	const status = /^Provider responded \(HTTP (\d+)\)$/.exec(step.label);
	if (status) return t("Provider responded (HTTP {status})", { status: status[1] });
	if (step.kind === "retry") return step.label.replace("Waiting to retry", t("Waiting to retry"));
	return t(step.label);
}

function useClock(active: boolean): number {
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		if (!active) return;
		const timer = setInterval(() => setNow(Date.now()), 250);
		return () => clearInterval(timer);
	}, [active]);
	return now;
}

export function ActivityBreakdown({ activity, now = Date.now() }: { activity: TurnActivity; now?: number }) {
	const end = activity.end ?? now;
	const total = Math.max(1, end - activity.start);
	const totals = activityTotals(activity, now);
	return (
		<div className="mt-2 space-y-3 border-l border-neutral-700 pl-3 text-meta text-neutral-400">
			<div className="flex flex-wrap gap-x-4 gap-y-1">
				{Object.entries(totals).map(([kind, ms]) => (
					<span key={kind}>{t(activityLabel(kind as keyof typeof totals))}: <span className="tabular-nums text-neutral-300">{activityDuration(ms)}</span></span>
				))}
			</div>
			<ol className="space-y-1" aria-label={t("Turn timeline")}>
				{activity.steps.map((step, i) => {
					const duration = Math.max(0, (step.end ?? end) - step.start);
					return (
						<li key={i} className="space-y-1">
							<div className="flex items-baseline gap-2">
								<span className="w-12 shrink-0 tabular-nums text-neutral-500" title={new Date(step.start).toLocaleTimeString()}>+{activityDuration(step.start - activity.start)}</span>
								<span className="min-w-0 flex-1 break-words">{phaseLabel(step)}{step.end === undefined && activity.end === undefined ? ` · ${t("now")}` : ""}</span>
								<span className="shrink-0 tabular-nums">{activityDuration(duration)}</span>
							</div>
							<div className="h-0.5 bg-neutral-800" aria-hidden>
								<div className="h-full bg-amber-400/60" style={{ marginLeft: `${Math.max(0, (step.start - activity.start) / total * 100)}%`, width: `${Math.min(100, duration / total * 100)}%` }} />
							</div>
						</li>
					);
				})}
			</ol>
			{activity.tools.length > 0 && (
				<div className="space-y-1">
					<div className="text-neutral-500">{t("Tool calls (parallel calls overlap; totals use wall time)")}</div>
					{activity.tools.map((tool) => (
						<div key={tool.id} className="flex items-baseline gap-2">
							<span className="min-w-0 flex-1 break-words font-mono">{tool.label}{tool.isError ? ` · ${t("failed")}` : ""}</span>
							<span className="shrink-0 tabular-nums">{activityDuration((tool.end ?? end) - tool.start)}</span>
						</div>
					))}
				</div>
			)}
			<p className="text-neutral-500">{t("Observed timings. Sending includes connection setup and waiting; provider processing and network delivery cannot be separated.")}</p>
		</div>
	);
}

export function CompletedActivity({ activity }: { activity: TurnActivity }) {
	return (
		<div className="chat-gutter my-3">
			<details className="chat-measure text-meta text-neutral-500">
				<summary className="cursor-pointer hover:text-neutral-300">{t("Timing")} · {activityDuration((activity.end ?? activity.start) - activity.start)}</summary>
				<ActivityBreakdown activity={activity} />
			</details>
		</div>
	);
}

export function TurnStatus({ activity, since, waitingForInput = false }: { activity?: TurnActivity; since?: number; waitingForInput?: boolean }) {
	const [open, setOpen] = useState(false);
	const [mounted] = useState(Date.now);
	const now = useClock(true);
	const step = activity?.steps.at(-1);
	const start = activity?.start ?? since ?? mounted;
	const phase = waitingForInput ? t("Waiting for your input") : step ? phaseLabel(step) : t("Waiting for pi activity");
	const streaming = step && ["thinking", "text", "toolcall"].includes(step.kind);
	const silence = streaming && activity?.lastOutputAt !== undefined ? now - activity.lastOutputAt : 0;
	return (
		<div className="chat-gutter my-3">
			<div className="chat-measure">
				<button type="button" data-custom="live phase disclosure with wrapping status and clocks" className="flex w-full items-baseline gap-2 text-left text-body text-neutral-400 hover:text-neutral-300 disabled:cursor-default" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={t("Toggle timing breakdown")} disabled={!activity}>
					<span className="shrink-0 self-center text-amber-400" aria-hidden>{open ? <CaretDown size={14} /> : <CaretRight size={14} />}</span>
					<span className="min-w-0 flex-1 break-words" role="status">{phase}</span>
					<span className="shrink-0 tabular-nums">{activityDuration(now - (step?.start ?? start))}</span>
				</button>
				<div className="mt-1 pl-6 text-meta text-neutral-500">
					{t("Total")} <span className="tabular-nums">{activityDuration(now - start)}</span>
					{silence >= 3000 && <span> · {t("No new output for")} <span className="tabular-nums">{activityDuration(silence)}</span></span>}
				</div>
				{open && activity && <ActivityBreakdown activity={activity} now={now} />}
			</div>
		</div>
	);
}
