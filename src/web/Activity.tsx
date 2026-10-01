import { useEffect, useRef, useState, type ReactNode } from "react";
import { Brain, ArrowUpRight, ArrowDownLeft, Wrench, ArrowClockwise, ArrowsInLineVertical, QuestionMark, CaretDown, CaretRight, Clock } from "@phosphor-icons/react";
import { activityDuration, activityGroups, activityRounds, type ActivityRound, type ActivityPhase, type ActivityPhaseGroup, type ActivityStep, type TurnActivity } from "../shared/activity.js";
import { t, plural } from "./i18n.js";
import { readWorkExpanded } from "./prefs.js";

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

type RoundContent = (round: ActivityRound, now: number) => ReactNode;

/** The same timed steps power each round and the complete turn; never a completion estimate. */
export function ActivitySteps({ groups, now, start, onSelect, label, leading, trailing, status, showBar = true }: {
	groups: ActivityPhaseGroup[];
	now: number;
	start: number;
	onSelect?: (id: number) => void;
	label: string;
	leading?: ReactNode;
	trailing?: ReactNode;
	status?: ReactNode;
	showBar?: boolean;
}) {
	const durations = groups.map((group) => Math.max(0, (group.end ?? now) - group.start));
	const totals = new Map<ActivityPhase, number>();
	groups.forEach((group, i) => totals.set(group.kind, (totals.get(group.kind) ?? 0) + durations[i]));
	return (
		<div className={showBar ? "space-y-1" : ""}>
			<div className="flex items-center gap-3">
				{leading}
				{showBar && <div className="flex h-2 min-w-0 flex-1 overflow-hidden rounded-sm bg-neutral-800" role="group" aria-label={label}>
					{groups.map((group, i) => {
						const props = {
							title: `${phaseTitle(group.kind)} · +${activityDuration(group.start - start)} · ${activityDuration(durations[i])}${phaseHint(group.kind) ? ` · ${phaseHint(group.kind)}` : ""}`,
							"aria-label": `${phaseTitle(group.kind)} · ${activityDuration(durations[i])}`,
							"aria-current": group.end === undefined ? "step" as const : undefined,
							className: `min-w-0 overflow-hidden ring-1 ring-inset ${PHASE_STYLE[group.kind].background} ${group.end === undefined ? "ring-neutral-100" : "ring-neutral-950/30"}`,
							style: { flexGrow: durations[i], flexBasis: 0 },
						};
						return onSelect
							? <button key={group.id} type="button" data-custom="proportional elapsed phase segment" {...props} onClick={() => onSelect(group.id)} />
							: <span key={group.id} {...props} />;
					})}
				</div>}
				{!showBar && <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta">
					{[...totals].map(([kind, ms]) => <span key={kind} title={`${phaseTitle(kind)}${phaseHint(kind) ? ` · ${phaseHint(kind)}` : ""}`} aria-label={`${phaseTitle(kind)} · ${activityDuration(ms)}`} className={`flex items-center gap-1 ${PHASE_STYLE[kind].text}`}><PhaseIcon kind={kind} size={12} /><span className="tabular-nums">{activityDuration(ms)}</span></span>)}
					{status}
				</div>}
				{trailing}
			</div>
			{showBar && <div className="flex flex-wrap gap-x-3 gap-y-1 text-meta">
				{[...totals].map(([kind, ms]) => <span key={kind} title={`${phaseTitle(kind)}${phaseHint(kind) ? ` · ${phaseHint(kind)}` : ""}`} aria-label={`${phaseTitle(kind)} · ${activityDuration(ms)}`} className={`flex items-center gap-1 ${PHASE_STYLE[kind].text}`}><PhaseIcon kind={kind} size={12} /><span className="tabular-nums">{activityDuration(ms)}</span></span>)}
				{status}
			</div>}
		</div>
	);
}

function RoundGroup({ round, number, now, renderContent, roundRefs, expandedByDefault }: {
	round: ActivityRound;
	number: number;
	now: number;
	renderContent?: RoundContent;
	roundRefs?: Map<number, HTMLDetailsElement>;
	expandedByDefault: boolean;
}) {
	const [open, setOpen] = useState(expandedByDefault);
	useEffect(() => setOpen(expandedByDefault), [expandedByDefault]);
	const tools = round.groups.flatMap((group) => group.tools);
	const wrappers = tools.filter((tool) => tool.label === "codemode" && tools.some((child) => child.id.startsWith(tool.id + "/")));
	const calls = tools.filter((tool) => !wrappers.includes(tool));
	const failed = calls.filter((tool) => tool.isError).length + wrappers.filter((tool) => tool.isError && !calls.some((child) => child.id.startsWith(tool.id + "/") && child.isError)).length;
	return (
		<details ref={(element) => { if (element) roundRefs?.set(round.id, element); else roundRefs?.delete(round.id); }} className="group/round" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
			<summary className="cursor-pointer list-none px-2 py-1 hover:bg-neutral-800/30 [&::-webkit-details-marker]:hidden">
				<ActivitySteps groups={round.groups} now={now} start={round.start} label={t("Round step timings, not completion progress")} showBar={false}
					leading={<span className="flex items-center gap-1 text-meta text-neutral-300"><CaretRight size={12} className="group-open/round:rotate-90" aria-hidden />{t("Round {n}", { n: number })}<span className="ml-1 flex items-center gap-1 text-neutral-500"><Clock size={12} aria-hidden /><span className="tabular-nums">{activityDuration((round.end ?? now) - round.start)}</span></span></span>}
					status={<>{calls.length > 0 && <span className="text-neutral-500">{plural(calls.length, "1 tool", "{n} tools")}</span>}{failed > 0 && <span className="text-red-400">{t("{n} failed", { n: failed })}</span>}</>}
				/>
			</summary>
			{open && <div className="chat-nested flow-trim flow-root px-2 py-1">
				{renderContent ? renderContent(round, now) : <>
					{tools.some((tool) => tool.label === "codemode") && <p className="mb-2 text-meta text-neutral-500">{t("via codemode")}</p>}
					{calls.map((tool) => <div key={tool.id} className="flex items-baseline gap-2 py-1 text-meta">
						<span className={`min-w-0 flex-1 break-words font-mono ${tool.isError ? "text-red-400" : "text-neutral-400"}`}>{tool.label}{tool.isError ? ` · ${t("failed")}` : ""}</span>
						<span className="shrink-0 tabular-nums text-neutral-500">{activityDuration((tool.end ?? now) - tool.start)}</span>
					</div>)}
				</>}
			</div>}
		</details>
	);
}

export function ActivityBreakdown({ activity, now = Date.now(), renderContent, roundRefs, expandedByDefault = readWorkExpanded() }: {
	activity: TurnActivity;
	now?: number;
	renderContent?: RoundContent;
	roundRefs?: Map<number, HTMLDetailsElement>;
	expandedByDefault?: boolean;
}) {
	return (
		<ol className="mt-1 space-y-2" aria-label={t("Turn timeline")}>
			{activityRounds(activityGroups(activity)).map((round, i) => <li key={round.id}><RoundGroup round={round} number={i + 1} now={now} renderContent={renderContent} roundRefs={roundRefs} expandedByDefault={expandedByDefault} /></li>)}
		</ol>
	);
}

export function ActivityHistory({ activity, now = Date.now(), onSelect }: { activity: TurnActivity; now?: number; onSelect: (id: number) => void }) {
	return <ActivitySteps groups={activityGroups(activity)} now={now} start={activity.start} onSelect={onSelect} label={t("Elapsed activity history, not completion progress")} showBar={false} />;
}

/** Round cards own their text and tools; the complete turn keeps one chronological strip. */
export function ActivityPanel({ activity, renderContent, controls, stickyLeading, waitingForInput = false, expandedByDefault = readWorkExpanded() }: {
	activity: TurnActivity;
	renderContent?: RoundContent;
	controls?: ReactNode;
	stickyLeading?: ReactNode;
	waitingForInput?: boolean;
	expandedByDefault?: boolean;
}) {
	const [open, setOpen] = useState(expandedByDefault || !!renderContent);
	useEffect(() => setOpen(expandedByDefault || !!renderContent), [expandedByDefault]);
	const roundRefs = useRef(new Map<number, HTMLDetailsElement>());
	const now = useClock(activity.end === undefined);
	const step = activity.steps.at(-1);
	const current = activityGroups(activity).at(-1);
	const streaming = step && ["thinking", "text", "toolcall"].includes(step.kind);
	const silence = streaming && activity.lastOutputAt !== undefined ? now - activity.lastOutputAt : 0;
	const breakdown = open ? <ActivityBreakdown activity={activity} now={now} renderContent={renderContent} roundRefs={roundRefs.current} expandedByDefault={expandedByDefault} /> : null;
	const select = (id: number) => {
		setOpen(true);
		requestAnimationFrame(() => {
			const round = activityRounds(activityGroups(activity)).find((item) => item.groups.some((group) => group.id === id));
			const detail = round && roundRefs.current.get(round.id);
			if (!detail) return;
			detail.open = true;
			detail.scrollIntoView({ block: "nearest", behavior: "smooth" });
		});
	};
	const status = activity.end === undefined && current && step ? (
		<div className="mt-2 flex items-baseline gap-2 text-body text-neutral-400">
			<PhaseIcon kind={waitingForInput ? "input" : current.kind} />
			<span title={waitingForInput ? undefined : phaseHint(current.kind)} className={`min-w-0 flex-1 break-words ${!waitingForInput && current.kind === "thinking" ? PHASE_STYLE[current.kind].text : ""}`} role="status">{waitingForInput ? t("Waiting for your input") : ["requesting", "thinking"].includes(current.kind) ? phaseTitle(current.kind) : phaseLabel(step)}</span>
			<span className="shrink-0 tabular-nums">{activityDuration(now - current.start)}</span>
		</div>
	) : null;
	const summary = (
		<div className="mt-2 flex flex-wrap items-center gap-1 text-meta text-neutral-500">
			{controls}
			<button type="button" data-custom="inline timing disclosure" className="flex items-center gap-1 hover:text-neutral-300" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={t("Toggle breakdown")}>
				{open ? <CaretDown size={12} /> : <CaretRight size={12} />}{t("Breakdown")} <Clock size={12} aria-hidden /> <span className="tabular-nums">{activityDuration((activity.end ?? now) - activity.start)}</span>
			</button>
			<ActivityHistory activity={activity} now={now} onSelect={select} />
			{activity.end === undefined && silence >= 3000 && <span> · {t("No new output for")} <span className="tabular-nums">{activityDuration(silence)}</span></span>}
		</div>
	);
	return (
		<div>
			{stickyLeading ? <div className="sticky top-0 z-10 bg-neutral-950">{stickyLeading}{status}{summary}</div> : <>{status}{summary}</>}
			{renderContent && breakdown}
			{!renderContent && breakdown}
		</div>
	);
}

export function CompletedActivity({ activity, expandedByDefault }: { activity: TurnActivity; expandedByDefault?: boolean }) {
	return <div className="chat-gutter my-3"><div className="chat-measure"><ActivityPanel activity={activity} expandedByDefault={expandedByDefault} /></div></div>;
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
