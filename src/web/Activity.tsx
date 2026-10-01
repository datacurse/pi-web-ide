import { useEffect, useRef, useState, type ReactNode } from "react";
import { Brain, ArrowUpRight, ArrowDownLeft, Wrench, ArrowClockwise, ArrowsInLineVertical, QuestionMark, CaretDown, CaretRight } from "@phosphor-icons/react";
import { activityDuration, activityGroups, activityRounds, type ActivityRound, type ActivityPhase, type ActivityPhaseGroup, type ActivityStep, type TurnActivity } from "../shared/activity.js";
import { t, plural } from "./i18n.js";

const PHASE_STYLE = {
	requesting: { icon: ArrowUpRight, text: "text-blue-400", background: "bg-blue-400/60" },
	thinking: { icon: Brain, text: "text-pink-400", background: "bg-pink-400/60" },
	receiving: { icon: ArrowDownLeft, text: "text-green-400", background: "bg-green-400/60" },
	doing: { icon: Wrench, text: "text-amber-400", background: "bg-amber-400/60" },
	retry: { icon: ArrowClockwise, text: "text-red-400", background: "bg-red-400/60" },
	compaction: { icon: ArrowsInLineVertical, text: "text-neutral-400", background: "bg-neutral-400/60" },
	input: { icon: QuestionMark, text: "text-red-400", background: "bg-red-400/60" },
};

function phaseTitle(kind: ActivityPhase): string {
	switch (kind) {
		case "requesting": return t("Requesting");
		case "thinking": return t("Thinking");
		case "receiving": return t("Receiving");
		case "doing": return t("Doing");
		case "retry": return t("Waiting to retry");
		case "compaction": return t("Compacting conversation");
		case "input": return t("Waiting for your input");
	}
}

function phaseHint(kind: ActivityPhase): string | undefined {
	if (kind === "requesting") return t("Recorded preparation up to the provider request hook. Browser delivery and exact upload completion are not measured.");
	return kind === "thinking" ? t("Waiting from the provider request hook until visible model output, including hidden reasoning and network waiting—not isolated thinking time.") : undefined;
}

function phaseLabel(step: ActivityStep): string {
	if (step.kind === "tools") return t("Running {tools}", { tools: step.label.replace(/^Running /, "") });
	const status = /^Provider responded \(HTTP (\d+)\)$/.exec(step.label);
	if (status) return t("Provider responded (HTTP {status})", { status: status[1] });
	if (step.kind === "retry") return step.label.replace("Waiting to retry", t("Waiting to retry"));
	return t(step.label);
}

export function PhaseIcon({ kind, size = 14, onBar = false }: { kind: ActivityPhase; size?: number; onBar?: boolean }) {
	const { icon: Icon, text } = PHASE_STYLE[kind];
	return <Icon size={size} className={`shrink-0 ${onBar ? "text-neutral-950" : text}`} aria-hidden />;
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

type PhaseContent = (group: ActivityPhaseGroup, now: number) => ReactNode;

function PhaseGroup({ group, now, renderContent, detailsRefs }: {
	group: ActivityPhaseGroup;
	now: number;
	renderContent?: PhaseContent;
	detailsRefs?: Map<number, HTMLDetailsElement>;
}) {
	const [open, setOpen] = useState(false);
	const failed = group.tools.filter((tool) => tool.isError).length;
	return (
		<details ref={(element) => { if (element) detailsRefs?.set(group.id, element); else detailsRefs?.delete(group.id); }} className="group/phase" onToggle={(event) => setOpen(event.currentTarget.open)}>
			<summary title={phaseHint(group.kind)} className="flex cursor-pointer list-none items-center gap-2 text-body text-neutral-400 hover:text-neutral-300 [&::-webkit-details-marker]:hidden">
				<CaretRight size={14} className="shrink-0 group-open/phase:rotate-90" aria-hidden />
				<PhaseIcon kind={group.kind} />
				<span className={group.kind === "thinking" ? PHASE_STYLE[group.kind].text : undefined}>{phaseTitle(group.kind)}</span>
				{group.tools.length > 0 && <span className="text-meta">· {plural(group.tools.length, "1 tool", "{n} tools")}</span>}
				{failed > 0 && <span className="text-meta text-red-400">· {t("{n} failed", { n: failed })}</span>}
				<span className="ml-auto shrink-0 text-meta tabular-nums">{activityDuration((group.end ?? now) - group.start)}</span>
				{group.end === undefined && <span className="text-meta">{t("now")}</span>}
			</summary>
			{open && (
				<div className="chat-nested flow-trim mt-2 flow-root border-l border-neutral-700 pl-3 text-meta text-neutral-400">
					{group.steps.filter((step) => !renderContent || step.kind !== "tools").map((step, i) => (
						<div key={i} className="flex items-baseline gap-2 py-0.5">
							<span className="min-w-0 flex-1 break-words">{phaseLabel(step)}</span>
							<span className="shrink-0 tabular-nums">{activityDuration((step.end ?? group.end ?? now) - step.start)}</span>
						</div>
					))}
					{renderContent ? renderContent(group, now) : group.tools.map((tool) => (
						<div key={tool.id} className="flex items-baseline gap-2 py-0.5">
							<span className="min-w-0 flex-1 break-words font-mono">{tool.label}{tool.isError ? ` · ${t("failed")}` : ""}</span>
							<span className="shrink-0 tabular-nums">{activityDuration((tool.end ?? now) - tool.start)}</span>
						</div>
					))}
				</div>
			)}
		</details>
	);
}

function RoundGroup({ round, number, now, renderContent, detailsRefs, roundRefs }: {
	round: ActivityRound;
	number: number;
	now: number;
	renderContent?: PhaseContent;
	detailsRefs?: Map<number, HTMLDetailsElement>;
	roundRefs?: Map<number, HTMLDetailsElement>;
}) {
	const tools = round.groups.flatMap((group) => group.tools);
	const failed = tools.filter((tool) => tool.isError).length;
	const current = round.groups.at(-1)!;
	return (
		<details ref={(element) => { if (element) roundRefs?.set(round.id, element); else roundRefs?.delete(round.id); }} className="group/round">
			<summary className="flex cursor-pointer list-none items-center gap-2 text-body text-neutral-400 hover:text-neutral-300 [&::-webkit-details-marker]:hidden">
				<CaretRight size={14} className="shrink-0 group-open/round:rotate-90" aria-hidden />
				<span>{t("Round {n}", { n: number })}</span>
				{tools.length > 0 && <span className="text-meta">· {plural(tools.length, "1 tool", "{n} tools")}</span>}
				{failed > 0 && <span className="text-meta text-red-400">· {t("{n} failed", { n: failed })}</span>}
				{round.end === undefined && <span className={`flex items-center gap-1 text-meta ${current.kind === "thinking" ? PHASE_STYLE[current.kind].text : ""}`}><PhaseIcon kind={current.kind} size={12} />{phaseTitle(current.kind)}</span>}
				<span className="ml-auto shrink-0 text-meta tabular-nums">{activityDuration((round.end ?? now) - round.start)}</span>
			</summary>
			<div className="chat-nested mt-2 space-y-2 border-l border-neutral-800 pl-3">
				{round.groups.map((group) => <PhaseGroup key={group.id} group={group} now={now} renderContent={renderContent} detailsRefs={detailsRefs} />)}
			</div>
		</details>
	);
}

export function ActivityBreakdown({ activity, now = Date.now(), renderContent, detailsRefs, roundRefs }: {
	activity: TurnActivity;
	now?: number;
	renderContent?: PhaseContent;
	detailsRefs?: Map<number, HTMLDetailsElement>;
	roundRefs?: Map<number, HTMLDetailsElement>;
}) {
	return (
		<div className="mt-2 space-y-3">
			<ol className="space-y-2" aria-label={t("Turn timeline")}>
				{activityRounds(activityGroups(activity)).map((round, i) => <li key={round.id}><RoundGroup round={round} number={i + 1} now={now} renderContent={renderContent} detailsRefs={detailsRefs} roundRefs={roundRefs} /></li>)}
			</ol>
			<p className="text-meta text-neutral-500">{t("Observed timings. Sending includes connection setup and waiting; provider processing and network delivery cannot be separated.")}</p>
		</div>
	);
}

export function ActivityHistory({ activity, now = Date.now(), onSelect }: { activity: TurnActivity; now?: number; onSelect: (id: number) => void }) {
	const groups = activityGroups(activity);
	const totals = new Map<ActivityPhase, number>();
	const durations = groups.map((group) => Math.max(0, (group.end ?? now) - group.start));
	const total = Math.max(1, durations.reduce((sum, ms) => sum + ms, 0));
	groups.forEach((group, i) => totals.set(group.kind, (totals.get(group.kind) ?? 0) + durations[i]));
	return (
		<div className="mt-2 space-y-1">
			<div className="flex h-4 overflow-hidden rounded-sm" aria-label={t("Elapsed activity history, not completion progress")}>
				{groups.map((group, i) => (
					<button key={group.id} type="button" data-custom="proportional elapsed phase segment" onClick={() => onSelect(group.id)} title={`${phaseTitle(group.kind)} · +${activityDuration(group.start - activity.start)} · ${activityDuration(durations[i])}${phaseHint(group.kind) ? ` · ${phaseHint(group.kind)}` : ""}`} aria-label={`${phaseTitle(group.kind)} · ${activityDuration(durations[i])}`} aria-current={group.end === undefined ? "step" : undefined} className={`flex min-w-0 items-center justify-center overflow-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-neutral-100 ${PHASE_STYLE[group.kind].background} ${group.end === undefined ? "ring-1 ring-inset ring-neutral-100" : ""}`} style={{ flexGrow: durations[i], flexBasis: 0 }}>
						{durations[i] / total >= 0.04 && <PhaseIcon kind={group.kind} size={12} onBar />}
					</button>
				))}
			</div>
			<div className="flex flex-wrap gap-x-3 gap-y-1 text-meta text-neutral-500">
				{[...totals].map(([kind, ms]) => <span key={kind} title={phaseHint(kind)} className={`flex items-center gap-1 ${kind === "thinking" ? PHASE_STYLE[kind].text : ""}`}><PhaseIcon kind={kind} size={12} />{phaseTitle(kind)} <span className="tabular-nums">{activityDuration(ms)}</span></span>)}
			</div>
		</div>
	);
}

/** One disclosure owns the strip and its phase folds, optionally with transcript content. */
export function ActivityPanel({ activity, renderContent, controls, waitingForInput = false }: {
	activity: TurnActivity;
	renderContent?: PhaseContent;
	controls?: ReactNode;
	waitingForInput?: boolean;
}) {
	const [open, setOpen] = useState(!!renderContent);
	const roundRefs = useRef(new Map<number, HTMLDetailsElement>());
	const refs = useRef(new Map<number, HTMLDetailsElement>());
	const now = useClock(activity.end === undefined);
	const step = activity.steps.at(-1);
	const current = activityGroups(activity).at(-1);
	const streaming = step && ["thinking", "text", "toolcall"].includes(step.kind);
	const silence = streaming && activity.lastOutputAt !== undefined ? now - activity.lastOutputAt : 0;
	const breakdown = open ? <ActivityBreakdown activity={activity} now={now} renderContent={renderContent} detailsRefs={refs.current} roundRefs={roundRefs.current} /> : null;
	const select = (id: number) => {
		setOpen(true);
		requestAnimationFrame(() => {
			const round = activityRounds(activityGroups(activity)).find((item) => item.groups.some((group) => group.id === id));
			const roundDetail = round && roundRefs.current.get(round.id);
			if (roundDetail) roundDetail.open = true;
			const detail = refs.current.get(id);
			if (!detail) return;
			detail.open = true;
			detail.scrollIntoView({ block: "nearest", behavior: "smooth" });
		});
	};
	return (
		<div>
			{renderContent && breakdown}
			{activity.end === undefined && current && step && (
				<div className="mt-2 flex items-baseline gap-2 text-body text-neutral-400">
					<PhaseIcon kind={waitingForInput ? "input" : current.kind} />
					<span title={waitingForInput ? undefined : phaseHint(current.kind)} className={`min-w-0 flex-1 break-words ${!waitingForInput && current.kind === "thinking" ? PHASE_STYLE[current.kind].text : ""}`} role="status">{waitingForInput ? t("Waiting for your input") : ["requesting", "thinking"].includes(current.kind) ? phaseTitle(current.kind) : phaseLabel(step)}</span>
					<span className="shrink-0 tabular-nums">{activityDuration(now - current.start)}</span>
				</div>
			)}
			<div className="mt-2 flex flex-wrap items-center gap-1 text-meta text-neutral-500">
				{controls}
				<button type="button" data-custom="inline timing disclosure" className="flex items-center gap-1 hover:text-neutral-300" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={t("Toggle timing breakdown")}>
					{open ? <CaretDown size={12} /> : <CaretRight size={12} />}{t("Timing")} · {t("Total")} <span className="tabular-nums">{activityDuration((activity.end ?? now) - activity.start)}</span>
				</button>
				{activity.end === undefined && silence >= 3000 && <span> · {t("No new output for")} <span className="tabular-nums">{activityDuration(silence)}</span></span>}
			</div>
			<ActivityHistory activity={activity} now={now} onSelect={select} />
			{!renderContent && breakdown}
		</div>
	);
}

export function CompletedActivity({ activity }: { activity: TurnActivity }) {
	return <div className="chat-gutter my-3"><div className="chat-measure"><ActivityPanel activity={activity} /></div></div>;
}

export function TurnStatus({ activity, since, waitingForInput = false }: { activity?: TurnActivity; since?: number; waitingForInput?: boolean }) {
	const [mounted] = useState(Date.now);
	const now = useClock(!activity);
	return (
		<div className="chat-gutter my-3">
			<div className="chat-measure">
				{activity ? <ActivityPanel activity={activity} waitingForInput={waitingForInput} /> : (
					<div className="text-body text-neutral-400" role="status">{waitingForInput ? t("Waiting for your input") : t("Waiting for pi activity")} · {activityDuration(now - (since ?? mounted))}</div>
				)}
			</div>
		</div>
	);
}
