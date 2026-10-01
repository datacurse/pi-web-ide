/**
 * Stats.tsx — usage across every pi session on this machine and the ones
 * mirrored from other machines over ssh (see server/machines.ts): the streak
 * heatmap, how long answers take, when and with what you work, and every
 * answered prompt.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowClockwise } from "@phosphor-icons/react";
import { EXERCISES, MUSCLES, WORKOUT_KINDS, type StatsTurn, type StatsView, type ToolCost, type UsageSample, type WorkoutKind, type WorkoutPlan, type WorkoutProfile, type WorkoutSet } from "../shared/types.js";
import { setKcal } from "../shared/calories.js";
import { exerciseText, muscleName, musclesText } from "./Workout.js";
import { WorkoutFigure } from "./workoutFigures.js";
import { Button, IconButton, PanelHeader, sectionLabel, useBatches } from "./ui.js";
import { addDays, callDuration, dayKey, duration, heatmapWeeks, LIMIT_WINDOW_MS, pace, percentile, span, streaks, type Pace } from "./stats.js";
import { api } from "./api.js";
import { locale, perLocale, plural, t } from "./i18n.js";

const WEEKS = 52;
const HEAT = ["bg-neutral-800", "bg-green-900", "bg-green-700", "bg-green-500", "bg-green-300"];
/** Rough `text-caption` glyph width, only to tell whether two month labels would touch. */
const CAPTION_CHAR = 6.5;
const BUCKETS: [number, string][] = [
	[10_000, "< 10s"],
	[30_000, "10–30s"],
	[60_000, "30s–1m"],
	[120_000, "1–2m"],
	[300_000, "2–5m"],
	[900_000, "5–15m"],
	[Infinity, "15m +"],
];

const dayFmt = perLocale((l) => new Intl.DateTimeFormat(l, { weekday: "short", day: "numeric", month: "short", year: "numeric" }));
const monthFmt = perLocale((l) => new Intl.DateTimeFormat(l, { month: "short" }));
const weekdayFmt = perLocale((l) => new Intl.DateTimeFormat(l, { weekday: "short" }));
const stampFmt = perLocale(
	(l) => new Intl.DateTimeFormat(l, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }),
);
const num = perLocale((l) => new Intl.NumberFormat(l, { notation: "compact", maximumFractionDigits: 1 }));
const usd = perLocale(
	(l) => new Intl.NumberFormat(l, { style: "currency", currency: "USD", maximumFractionDigits: 2 }),
);

const projectName = (cwd: string) => cwd.split("/").filter(Boolean).pop() ?? cwd;
/** Remote projects carry their machine: `~/code/foo` on two machines is two projects. */
const projectOf = (t: StatsTurn) => (t.machine ? `${t.machine}:${projectName(t.cwd)}` : projectName(t.cwd));

function top(counts: Map<string, number>, n = 6): [string, number][] {
	return [...counts].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function tally<T>(items: T[], key: (t: T) => string | undefined, by: (t: T) => number = () => 1) {
	const m = new Map<string, number>();
	for (const i of items) {
		const k = key(i);
		if (k) m.set(k, (m.get(k) ?? 0) + by(i));
	}
	return m;
}

export function Stats({ open, revision, onClose }: { open: boolean; revision?: unknown; onClose: () => void }) {
	const [view, setView] = useState<StatsView | null>(null);
	const [error, setError] = useState<string | null>(null);
	/** null for all machines, "" for this one, else an ssh alias. */
	const [machine, setMachine] = useState<string | null>(null);
	const [syncing, setSyncing] = useState(false);
	const [reload, setReload] = useState(0);
	const [tab, setTab] = useState<"overview" | "workouts">("overview");

	const get = useCallback(async (sync?: "1" | "force") => {
		try {
			const r = await api.stats.$get({ query: sync ? { sync } : {} });
			if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? r.statusText);
			setView((await r.json()) as StatsView);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, []);

	// What is on disk first, then again once the other machines have synced.
	const load = useCallback(
		async (force = false) => {
			setReload((n) => n + 1);
			await get();
			setSyncing(true);
			await get(force ? "force" : "1");
			setSyncing(false);
		},
		[get],
	);

	// Re-read after every reply (a finished answer is a new row), but only while
	// showing: the page stays mounted after the dialog closes.
	useEffect(() => {
		if (open) void load();
	}, [load, revision, open]);
	const usage = useUsage(reload);

	const turns = useMemo(
		() => (view?.turns ?? []).filter((t) => machine === null || t.machine === machine),
		[view, machine],
	);
	// Memoised like `turns`: Workouts re-reads the body whenever this array changes.
	const workouts = useMemo(
		() => (view?.workouts ?? []).filter((s) => machine === null || s.machine === machine),
		[view, machine],
	);
	const remote = view?.machines ?? [];
	const filters: [string | null, string, string | undefined][] = [
		[null, t("All"), undefined],
		["", t("This PC"), undefined],
		...remote.map(
			(m): [string, string, string] => [
				m.name,
				m.name,
				m.error
					? t("Unreachable: {error}. Last synced {when}", {
							error: m.error,
							when: stampFmt().format(new Date(m.synced)),
						})
					: t("Synced {when}", { when: stampFmt().format(new Date(m.synced)) }),
			],
		),
	];

	return (
		<section
			aria-label={t("Stats")}
			className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-neutral-950 text-neutral-100"
		>
			<PanelHeader title={t("Stats")} onClose={onClose}>
				<div className="flex gap-1">
					{(
						[
							["overview", t("Overview")],
							["workouts", t("Workouts")],
						] as const
					).map(([id, label]) => (
						<Button
							key={id}
							variant={tab === id ? "subtle" : "ghost"}
							size="sm"
							onClick={() => setTab(id)}
							aria-pressed={tab === id}
						>
							{label}
						</Button>
					))}
				</div>
				{/* Only once there is another machine: until then All and This PC are the same. */}
				{remote.length > 0 && (
					<div className="flex gap-1">
						{filters.map(([m, label, title]) => (
							<Button
								key={label}
								variant={machine === m ? "subtle" : "ghost"}
								size="sm"
								onClick={() => setMachine(m)}
								aria-pressed={machine === m}
								title={title}
							>
								{label}
							</Button>
						))}
					</div>
				)}
				<IconButton size="sm" label={t("Refresh")} onClick={() => void load(true)}>
					<ArrowClockwise size={14} />
				</IconButton>
				{syncing && <span className="text-meta text-neutral-500">{t("Syncing machines…")}</span>}
			</PanelHeader>

			{tab === "workouts" &&
				// A server older than the page sends no plan: say so rather than render nothing.
				(view?.workoutPlan ? (
					<Workouts sets={workouts} plan={view.workoutPlan} profile={view.workoutProfile} />
				) : (
					<p className={`p-4 text-meta ${error ? "text-red-400" : "text-neutral-500"}`}>
						{error ?? (view ? t("The server is older than this page. Restart pwi.") : t("Reading sessions…"))}
					</p>
				))}
			{/* Laid out for the page dialog's width; the grids stack on a narrow window. */}
			<div className={`${tab === "overview" ? "flex" : "hidden"} min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4`}>
				{error && <p className="text-meta text-red-400">{error}</p>}
				<div className="grid gap-6 md:grid-cols-3">
					<Usage usage={usage} />
					<div className="md:col-span-2">
						{view ? (
							<Summary turns={turns} />
						) : (
							!error && <p className="text-meta text-neutral-500">{t("Reading sessions…")}</p>
						)}
					</div>
				</div>
				{usage.limits && <Paces limits={usage.limits} history={usage.history} turns={view?.turns ?? []} />}
				{view && (
					<>
						<Heatmap turns={turns} />
						<div className="grid gap-6 md:grid-cols-2">
							<AnswerTimes turns={turns} />
							<Hours turns={turns} />
						</div>
						<div className={`grid gap-6 ${remote.length > 0 ? "md:grid-cols-4" : "md:grid-cols-3"}`}>
							{remote.length > 0 && (
								<Bars title={t("Machines")} rows={top(tally(turns, (turn) => turn.machine || t("This PC")))} />
							)}
							<Bars title={t("Models")} rows={top(tally(turns, (t) => t.model))} />
							<Bars title={t("Projects")} rows={top(tally(turns, projectOf))} />
							<Bars
								title={t("Tools")}
								rows={top(
									tally(
										turns.flatMap((t) => Object.entries(t.tools)),
										([k]) => k,
										([, n]) => n,
									),
									8,
								)}
							/>
						</div>
						<ToolCosts turns={turns} />
						<div className="grid gap-6 md:grid-cols-3">
							<Outliers title={t("Slowest calls")} by="ms" turns={turns} />
							<Outliers title={t("Largest calls")} by="tokens" turns={turns} />
							<Background turns={turns} />
						</div>
						<Answers turns={turns} />
					</>
				)}
			</div>
		</section>
	);
}

/** The subset of /api/usage (Anthropic's oauth/usage) this panel reads. */
interface UsageLimit {
	kind: string;
	/** `session` (5 hours) or `weekly`. */
	group?: string;
	percent: number;
	resets_at: string | null;
	scope: { model?: { display_name?: string | null } } | null;
}

function limitLabel(l: UsageLimit): string {
	if (l.kind === "session") return t("Current session");
	if (l.kind === "weekly_all") return t("This week");
	const model = l.scope?.model?.display_name;
	return model ? t("{model} this week", { model }) : l.kind.replace(/_/g, " ");
}

function resetLabel(iso: string | null): string {
	if (!iso) return "";
	const d = new Date(iso);
	const time = d.toLocaleTimeString(locale(), { hour: "numeric", minute: "2-digit" });
	return d.getTime() - Date.now() < 86_400_000
		? t("Resets at {time}", { time })
		: t("Resets {day} {time}", { day: d.toLocaleDateString(locale(), { weekday: "long" }), time });
}

/** From Anthropic's oauth/profile; it has no end date, only when the plan started. */
interface Subscription {
	plan: string | null;
	status: string | null;
	since: string | null;
}

/** The next monthly anniversary of `since`, assuming monthly billing. */
function nextRenewal(since: string, now = new Date()): Date | null {
	const s = new Date(since);
	if (Number.isNaN(s.getTime())) return null;
	for (let m = now.getMonth(), y = now.getFullYear(); ; m++) {
		const last = new Date(y, m + 1, 0).getDate();
		const d = new Date(y, m, Math.min(s.getDate(), last), s.getHours(), s.getMinutes());
		if (d > now && d > s) return d;
	}
}

function SubscriptionLine({ sub }: { sub: Subscription }) {
	const plan = (sub.plan ?? "Claude").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
	if (sub.status && sub.status !== "active") {
		return <p className="text-meta text-red-400">
				{t("{plan} subscription {status}", { plan, status: sub.status.replace(/_/g, " ") })}
			</p>;
	}
	const next = sub.since ? nextRenewal(sub.since) : null;
	if (!next) return null;
	const days = Math.ceil((next.getTime() - Date.now()) / 86_400_000);
	return (
		<p
			className="text-meta text-neutral-500"
			title={t("Estimated from the start date ({date}), assuming monthly billing", {
				date: new Date(sub.since!).toLocaleDateString(locale()),
			})}
		>
			{plural(days, "{plan} renews {date} (in {n} day)", "{plan} renews {date} (in {n} days)", {
				plan,
				date: next.toLocaleDateString(locale(), { day: "numeric", month: "short" }),
			})}
		</p>
	);
}

interface UsageState {
	limits: UsageLimit[] | null;
	subscription: Subscription | null;
	history: UsageSample[];
	error: string | null;
}

function useUsage(reload: number): UsageState {
	const [state, setState] = useState<UsageState>({ limits: null, subscription: null, history: [], error: null });
	useEffect(() => {
		void (async () => {
			const r = await api.usage.$get().catch(() => null);
			const body = (await r?.json().catch(() => null)) as {
				limits?: UsageLimit[];
				subscription?: Subscription;
				history?: UsageSample[];
				error?: string;
			} | null;
			if (r?.ok && Array.isArray(body?.limits)) {
				setState({
					limits: body.limits,
					subscription: body.subscription ?? null,
					history: body.history ?? [],
					error: null,
				});
			} else setState((s) => ({ ...s, error: body?.error ?? t("could not load usage") }));
		})();
	}, [reload]);
	return state;
}

function Usage({ usage: { limits, subscription, error: usageError } }: { usage: UsageState }) {
	return (
		<div>
			<h3 className={`mb-2 ${sectionLabel}`}>{t("Usage remaining")}</h3>
			{usageError ? (
				<p className="text-meta text-red-400">{usageError}</p>
			) : !limits ? (
				<p className="text-meta text-neutral-500">{t("loading…")}</p>
			) : (
				<div className="flex flex-col gap-3">
					{limits.map((l) => {
						const left = Math.max(0, Math.min(100, 100 - l.percent));
						return (
							<div key={`${l.kind}-${limitLabel(l)}`} className="text-ui">
								<div className="flex items-baseline justify-between gap-2">
									<span>{limitLabel(l)}</span>
									<span className="text-meta text-neutral-300">{t("{n}% left", { n: left })}</span>
								</div>
								<div
									role="meter"
									aria-label={t("{limit} remaining", { limit: limitLabel(l) })}
									aria-valuenow={left}
									aria-valuemin={0}
									aria-valuemax={100}
									className="mt-1 h-1.5 overflow-hidden rounded-full bg-neutral-800"
								>
									<div
										className="h-full rounded-full bg-green-400"
										style={{ width: `${left}%` }}
									/>
								</div>
								<span className="mt-0.5 block text-meta text-neutral-500">
									{resetLabel(l.resets_at)}
								</span>
							</div>
						);
					})}
					{subscription && <SubscriptionLine sub={subscription} />}
				</div>
			)}
		</div>
	);
}

const clockFmt = perLocale((l) => new Intl.DateTimeFormat(l, { hour: "numeric", minute: "2-digit" }));
const weekClockFmt = perLocale(
	(l) => new Intl.DateTimeFormat(l, { weekday: "short", hour: "numeric", minute: "2-digit" }),
);

/** Every limit with a live window, extrapolated to its reset. */
function Paces({ limits, history, turns }: { limits: UsageLimit[]; history: UsageSample[]; turns: StatsTurn[] }) {
	const now = Date.now();
	const rows = limits.flatMap((l) => {
		const windowMs = LIMIT_WINDOW_MS[l.group ?? ""];
		const end = l.resets_at ? Date.parse(l.resets_at) : NaN;
		const p = windowMs && Number.isFinite(end) ? pace(l.percent, end, windowMs, now) : null;
		return p ? [{ l, p }] : [];
	});
	if (!rows.length) return null;
	return (
		<div>
			<h3 className={`mb-2 ${sectionLabel}`}>{t("Pace")}</h3>
			<div className="grid gap-6 md:grid-cols-3">
				{rows.map(({ l, p }) => (
					<PaceCard key={`${l.kind}-${limitLabel(l)}`} limit={l} pace={p} history={history} turns={turns} now={now} />
				))}
			</div>
		</div>
	);
}

/**
 * One limit's window as a chart: use so far (solid, from the recorded samples),
 * the window's average pace carried to the reset (dashed, red when it crosses
 * 100%), and the even pace that would land exactly on 100% (grey diagonal).
 */
function PaceCard({
	limit,
	pace: p,
	history,
	turns,
	now,
}: {
	limit: UsageLimit;
	pace: Pace;
	history: UsageSample[];
	turns: StatsTurn[];
	now: number;
}) {
	const model = limit.scope?.model?.display_name ?? null;
	const weekly = limit.group === "weekly";
	const fmt = weekly ? weekClockFmt() : clockFmt();
	const unitMs = weekly ? 86_400_000 : 3_600_000;
	const unit = weekly ? t("day") : t("h");
	const used = limit.percent;

	// Samples of this very window: the same limit, resetting at the same time.
	const points = useMemo(() => {
		const out: [number, number][] = [[p.start, 0]];
		for (const s of history) {
			if (s.at <= p.start || s.at >= now) continue;
			const x = s.limits.find(
				(x) =>
					x.kind === limit.kind &&
					x.model === model &&
					x.resets_at &&
					Math.abs(Date.parse(x.resets_at) - p.end) < 600_000,
			);
			if (x) out.push([s.at, x.percent]);
		}
		out.push([now, used]);
		return out;
	}, [history, limit.kind, model, p.start, p.end, now, used]);

	// Prompts in this window, to turn "percent left" into "prompts left".
	const prompts = turns.filter(
		(t) =>
			t.start >= p.start &&
			(model ? t.model.toLowerCase().includes(model.toLowerCase()) : /claude/i.test(t.model)),
	).length;
	const promptsLeft = used >= 1 && prompts >= 3 ? Math.round((prompts * (100 - used)) / used) : null;

	const box = useRef<HTMLDivElement>(null);
	const canvas = useRef<HTMLCanvasElement>(null);
	const width = useWidth(box);
	const dpr = window.devicePixelRatio || 1;
	const w = Math.floor(width * dpr);
	const h = Math.round(80 * dpr);
	const line = Math.max(1, Math.round(dpr));
	/** Device-pixel position of a percent, 100% one line below the top. */
	const y = (v: number) => line + (1 - Math.min(v, 100) / 100) * (h - 2 * line);

	useEffect(() => {
		const ctx = canvas.current?.getContext("2d");
		if (!ctx || !w || !box.current) return;
		ctx.canvas.width = w;
		ctx.canvas.height = h;
		const x = (t: number) => ((t - p.start) / (p.end - p.start)) * w;
		const color = (c: string) => bgColor(box.current!, c);
		const stroke = (style: string, dash: number[], pts: [number, number][]) => {
			ctx.strokeStyle = style;
			ctx.lineWidth = 2 * line;
			ctx.setLineDash(dash.map((d) => d * dpr));
			ctx.beginPath();
			pts.forEach(([t, v], i) => (i ? ctx.lineTo(x(t), y(v)) : ctx.moveTo(x(t), y(v))));
			ctx.stroke();
		};
		ctx.fillStyle = color("bg-neutral-800");
		for (const v of [0, 50, 100]) ctx.fillRect(0, Math.round(y(v) - line / 2), w, line);
		ctx.fillRect(Math.round(x(now)), 0, line, h);
		stroke(color("bg-neutral-600"), [3, 3], [
			[p.start, 0],
			[p.end, 100],
		]);
		const over = color("bg-red-400");
		stroke(p.runsOut ? over : color("bg-amber-500"), [4, 3], [
			[now, used],
			p.runsOut ? [p.runsOut, 100] : [p.end, p.projected],
		]);
		stroke(color("bg-amber-500"), [], points);
		if (p.runsOut) {
			ctx.fillStyle = over;
			ctx.beginPath();
			ctx.arc(x(p.runsOut), y(100), 3 * dpr, 0, 2 * Math.PI);
			ctx.fill();
		}
	}, [points, p, w, h, line, dpr, now, used]);

	const rate = `${(p.rate * unitMs).toFixed(1)}%/${unit}`;
	const budget = `${((100 - used) / ((p.end - now) / unitMs)).toFixed(1)}%/${unit}`;
	const [tone, verdict] =
		used >= 100
			? (["text-red-400", t("Limit reached. Resets in {span}.", { span: span(p.end - now) })] as const)
			: p.early
				? (["text-neutral-400", t("Too early in the window to extrapolate.")] as const)
				: p.runsOut
					? ([
							"text-red-400",
							t("Runs out {when}, {span} before reset. Slow to {pct}% of this pace.", {
								when: fmt.format(p.runsOut),
								span: span(p.end - p.runsOut),
								pct: Math.round(p.room * 100),
							}),
						] as const)
					: ([
							"text-green-400",
							p.room === Infinity
								? t("Nothing used yet.")
								: t("On pace for {pct}% at reset. Room for {room}\u00d7 this pace.", {
										pct: Math.round(p.projected),
										room: p.room.toFixed(1),
									}),
						] as const);

	return (
		<div>
			<div className="mb-1 text-ui">{limitLabel(limit)}</div>
			<div className="flex gap-2 text-caption text-neutral-500 tabular-nums">
				<div className="relative w-8 shrink-0" style={{ height: h / dpr }}>
					{[0, 50, 100].map((v) => (
						<span
							key={v}
							className="absolute right-0 -translate-y-1/2 leading-none"
							style={{ top: y(v) / dpr }}
						>
							{v}%
						</span>
					))}
				</div>
				<div ref={box} className="min-w-0 flex-1">
					<canvas
						ref={canvas}
						role="img"
						aria-label={t("{limit}: {used}% used, {verdict}", { limit: limitLabel(limit), used, verdict })}
						title={t("Solid: used so far. Dashed: this pace until the reset. Grey: an even pace to 100%.")}
						className="block"
						style={{ width: w / dpr, height: h / dpr }}
					/>
					<div className="mt-1 flex justify-between">
						<span>{fmt.format(p.start)}</span>
						<span>{fmt.format(p.end)}</span>
					</div>
				</div>
			</div>
			<p className={`mt-1 text-meta ${tone}`}>{verdict}</p>
			<p className="text-meta text-neutral-500">
				{t("Averaging {rate}, budget {budget}", { rate, budget })}
				{promptsLeft !== null &&
					` \u00b7 \u2248 ${plural(promptsLeft, "{count} more prompt", "{count} more prompts", { count: num().format(promptsLeft) })}`}
			</p>
		</div>
	);
}

function Summary({ turns }: { turns: StatsTurn[] }) {
	const days = new Set(turns.map((t) => dayKey(t.start)));
	const { current, longest } = streaks(days);
	const ms = turns.map((t) => t.ms).sort((a, b) => a - b);
	const tiles: [string, string][] = [
		[t("Prompts"), num().format(turns.length)],
		[t("Sessions"), num().format(new Set(turns.map((turn) => turn.session)).size)],
		[t("Active days"), num().format(days.size)],
		[t("Current streak"), t("{n}d", { n: current })],
		[t("Longest streak"), t("{n}d", { n: longest })],
		[t("Median answer"), duration(percentile(ms, 0.5))],
		[t("Output tokens"), num().format(turns.reduce((s, turn) => s + turn.outputTokens, 0))],
		[
			t("Tool calls"),
			num().format(turns.reduce((s, turn) => s + Object.values(turn.tools).reduce((a, b) => a + b, 0), 0)),
		],
		[t("Cost"), usd().format(turns.reduce((s, turn) => s + turn.cost, 0))],
	];
	return (
		<div className="grid grid-cols-3 gap-2">
			{tiles.map(([label, value]) => (
				<div key={label} className="rounded-sm border border-neutral-800 px-2 py-1.5">
					<div className="text-title text-neutral-100 tabular-nums">{value}</div>
					<div className="text-meta text-neutral-500">{label}</div>
				</div>
			))}
		</div>
	);
}

/** The sets done for the workout gate (web/Workout.tsx), filtered like Overview by machine. */
function Workouts({
	sets,
	plan,
	profile,
}: {
	sets: WorkoutSet[];
	plan: WorkoutPlan;
	profile: WorkoutProfile | null;
}) {
	const plannedToday = plan.planned.filter((p) => dayKey(new Date(p.at)) === dayKey(new Date()));
	const kcal = (list: WorkoutSet[]) => (profile ? list.reduce((n, s) => n + setKcal(s.kind, s.amount, profile), 0) : 0);
	const day = (s: WorkoutSet) => dayKey(new Date(s.at));
	const today = dayKey(new Date());
	const weekAgo = dayKey(addDays(new Date(), -6));
	const activeDays = new Set(sets.map(day)).size;
	const doneToday = sets.filter((s) => day(s) === today);
	/** Today's planned sets as sets, so kcal and amounts add up the same way. */
	const aheadToday: WorkoutSet[] = plannedToday.map((p) => ({ ...p, amount: EXERCISES[p.kind].amount }));
	const tiles: [string, string][] = [
		[t("Sets this week"), num().format(sets.filter((s) => day(s) >= weekAgo).length)],
		[t("Sets in total"), num().format(sets.length)],
		[t("Active days"), num().format(activeDays)],
		...(profile
			? ([
					[t("kcal this week"), num().format(kcal(sets.filter((s) => day(s) >= weekAgo)))],
					[t("kcal in total"), num().format(kcal(sets))],
					[t("kcal per active day"), num().format(activeDays ? kcal(sets) / activeDays : 0)],
				] as [string, string][])
			: []),
	];
	const sum = (kind: WorkoutKind, from?: string, list = sets) =>
		list.filter((s) => s.kind === kind && (!from || day(s) >= from)).reduce((n, s) => n + s.amount, 0);
	const amount = (kind: WorkoutKind, n: number) =>
		EXERCISES[kind].unit === "seconds" ? t("{n}s", { n: num().format(n) }) : num().format(n);

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">
			{sets.length === 0 && (
				<p className="text-meta text-neutral-500">
					{t("No sets yet. Turn on Workout under Packages > pwi extensions.")}
				</p>
			)}
			<div className="grid gap-2 md:grid-cols-2">
				<TodayProgress
					label={t("Sets today")}
					done={doneToday.length}
					ahead={aheadToday.length}
					format={(n) => num().format(n)}
				/>
				{profile && (
					<TodayProgress
						label={t("kcal today")}
						done={kcal(doneToday)}
						ahead={kcal(aheadToday)}
						format={(n) => num().format(n)}
					/>
				)}
			</div>
			<div className="grid grid-cols-2 gap-2 md:grid-cols-3">
				{tiles.map(([label, value]) => (
					<div key={label} className="rounded-sm border border-neutral-800 px-2 py-1.5">
						<div className="text-title text-neutral-100 tabular-nums">{value}</div>
						<div className="text-meta text-neutral-500">{label}</div>
					</div>
				))}
			</div>
			{!profile && sets.length > 0 && (
				<p className="text-meta text-neutral-500">
					{t("Enter your sex, age, height and weight under Packages > pwi extensions > Workout to see calories.")}
				</p>
			)}
			<WorkoutDays sets={sets} profile={profile} plan={plan} />
			<div className="grid gap-6 md:grid-cols-2">
				<UpNext plan={plan} />
				<div>
					<Bars
						title={t("Muscle load now")}
						rows={MUSCLES.map((m) => [muscleName(m), Math.round(plan.fatigue[m] * 10) / 10])}
					/>
					<p className="mt-2 text-meta text-neutral-500">
						{t("Each set adds 1 to the groups it works, halving every 45 minutes. The next set works the freshest.")}
					</p>
				</div>
			</div>
			<div className="max-w-2xl">
				<h3 className={`mb-2 ${sectionLabel}`}>{t("Exercises")}</h3>
				<table className="w-full text-meta tabular-nums">
					<thead className="text-neutral-500">
						<tr>
							<th />
							<th className="text-left font-normal">{t("Exercise")}</th>
							<th className="text-right font-normal">{t("Today")}</th>
							<th className="text-right font-normal">{t("Planned")}</th>
							<th className="text-right font-normal">{t("This week")}</th>
							<th className="text-right font-normal">{t("Total")}</th>
							{profile && <th className="text-right font-normal">{t("kcal")}</th>}
						</tr>
					</thead>
					<tbody>
						{WORKOUT_KINDS.map((kind) => (
							<tr key={kind} className="border-t border-neutral-800">
								<td className="w-12 py-1">
									<WorkoutFigure kind={kind} className="w-12 text-neutral-400" />
								</td>
								<td className="text-neutral-300">
									{/* The swatch is the chart's legend. */}
									<span className={`mr-2 inline-block size-2.5 rounded-full ${EX_COLOR[kind]}`} />
									{exerciseText(kind).name}
								</td>
								<td className="text-right text-neutral-300">{amount(kind, sum(kind, today))}</td>
								<td className="text-right text-neutral-500">{amount(kind, sum(kind, undefined, aheadToday))}</td>
								<td className="text-right text-neutral-300">{amount(kind, sum(kind, weekAgo))}</td>
								<td className="text-right text-neutral-200">{amount(kind, sum(kind))}</td>
								{profile && (
									<td className="text-right text-neutral-200">
										{num().format(kcal(sets.filter((s) => s.kind === kind)))}
									</td>
								)}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}

/** Today so far against today's whole plan: done, then what the schedule still has planned. */
function TodayProgress({
	label,
	done,
	ahead,
	format,
}: {
	label: string;
	done: number;
	ahead: number;
	format: (n: number) => string;
}) {
	const all = done + ahead;
	return (
		<div className="rounded-sm border border-neutral-800 px-3 py-2">
			<div className="flex items-baseline gap-2">
				<span className="text-title text-neutral-100 tabular-nums">{format(done)}</span>
				<span className="text-ui text-neutral-500 tabular-nums">/ {format(all)}</span>
				<span className="ml-auto text-meta text-neutral-500">{label}</span>
			</div>
			<div className="mt-2 h-2 rounded-full bg-neutral-800">
				<div className="h-full rounded-full bg-amber-500" style={{ width: `${all ? (done / all) * 100 : 0}%` }} />
			</div>
			<div className="mt-1 text-meta text-neutral-500">
				{t("{done} done, {ahead} planned", { done: format(done), ahead: format(ahead) })}
			</div>
		</div>
	);
}

const UP_NEXT = 8;
const timeFmt = perLocale((l) => new Intl.DateTimeFormat(l, { hour: "2-digit", minute: "2-digit" }));

/** The next sets the schedule has planned, with when and what they work. */
function UpNext({ plan }: { plan: WorkoutPlan }) {
	const today = dayKey(new Date());
	const rest = plan.planned.filter((p) => dayKey(new Date(p.at)) === today).length - UP_NEXT;
	const when = (at: string) => {
		const d = new Date(at);
		if (d.getTime() <= Date.now()) return t("now");
		return dayKey(d) === today ? timeFmt().format(d) : stampFmt().format(d);
	};
	return (
		<div>
			<h3 className={`mb-2 ${sectionLabel}`}>{t("Up next")}</h3>
			{!plan.on && <p className="text-meta text-neutral-500">{t("Workout is off. Turn it on under Packages > pwi extensions.")}</p>}
			<div className="flex flex-col gap-1 text-meta">
				{plan.planned.slice(0, UP_NEXT).map((p) => (
					<div key={p.at} className="flex items-center gap-2">
						<span className="w-24 shrink-0 text-neutral-500 tabular-nums">{when(p.at)}</span>
						<span className={`inline-block size-2.5 shrink-0 rounded-full ${EX_COLOR[p.kind]}`} />
						<span className="text-neutral-200">{exerciseText(p.kind).name}</span>
						<span className="text-neutral-500">{musclesText(p.kind)}</span>
					</div>
				))}
			</div>
			{rest > 0 && <p className="mt-1 text-meta text-neutral-500">{t("+{n} more planned today", { n: rest })}</p>}
		</div>
	);
}

/** Days before today and after it in the workout chart; today sits between them. */
const CHART_BACK = 15;
const CHART_AHEAD = 14;
const CHART_DAYS = CHART_BACK + 1 + CHART_AHEAD;
/** Literal classes so Tailwind emits them; the chart reads the colours back through bgColor. */
const EX_COLOR: Record<WorkoutKind, string> = {
	pushups: "bg-ex-pushups",
	situps: "bg-ex-situps",
	squats: "bg-ex-squats",
	lunges: "bg-ex-lunges",
	burpees: "bg-ex-burpees",
	jumpingJacks: "bg-ex-jumping-jacks",
	calfRaises: "bg-ex-calf-raises",
	gluteBridges: "bg-ex-glute-bridges",
	plank: "bg-ex-plank",
	wallSit: "bg-ex-wall-sit",
};
const shortDayFmt = perLocale((l) => new Intl.DateTimeFormat(l, { day: "numeric", month: "short" }));

/**
 * Sets, or kcal once a body is entered, per day: CHART_BACK days back, today,
 * CHART_AHEAD ahead. One column a day stacked by exercise, like By hour; what
 * was done is solid, what the schedule plans (the rest of today, whole days
 * after it) is the same colours faded, on top.
 */
function WorkoutDays({
	sets,
	profile,
	plan,
}: {
	sets: WorkoutSet[];
	profile: WorkoutProfile | null;
	plan: WorkoutPlan;
}) {
	const [by, setBy] = useState<"sets" | "kcal">("sets");
	const metric = profile ? by : "sets";
	const days = useMemo(
		() => Array.from({ length: CHART_DAYS }, (_, i) => addDays(new Date(), i - CHART_BACK)),
		[sets, plan],
	);
	const value = useCallback(
		(kind: WorkoutKind, amount: number) => (metric === "kcal" && profile ? setKcal(kind, amount, profile) : 1),
		[metric, profile],
	);
	/** Per day, per exercise: [done, planned]. */
	const perDay = useMemo(() => {
		const byDay = new Map<string, Map<WorkoutKind, [number, number]>>();
		const add = (at: Date, kind: WorkoutKind, v: number, planned: boolean) => {
			const d = dayKey(at);
			const kinds = byDay.get(d) ?? new Map<WorkoutKind, [number, number]>();
			const cell = kinds.get(kind) ?? [0, 0];
			cell[planned ? 1 : 0] += v;
			kinds.set(kind, cell);
			byDay.set(d, kinds);
		};
		for (const s of sets) add(new Date(s.at), s.kind, value(s.kind, s.amount), false);
		for (const p of plan.planned) add(new Date(p.at), p.kind, value(p.kind, EXERCISES[p.kind].amount), true);
		for (const d of plan.ahead)
			for (const [k, n] of Object.entries(d.kinds) as [WorkoutKind, number][])
				add(new Date(d.at), k, n * value(k, EXERCISES[k].amount), true);
		return days.map((d) => byDay.get(dayKey(d)) ?? new Map<WorkoutKind, [number, number]>());
	}, [sets, plan, days, value]);
	const format = (n: number) => (metric === "kcal" ? t("{n} kcal", { n: num().format(n) }) : num().format(n));
	const sums = perDay.map((k) => {
		let done = 0;
		let planned = 0;
		for (const [d, p] of k.values()) {
			done += d;
			planned += p;
		}
		return { done, planned };
	});
	const { unit, top, ticks } = axis(Math.max(1, ...sums.map((x) => x.done + x.planned)));

	const box = useRef<HTMLDivElement>(null);
	const canvas = useRef<HTMLCanvasElement>(null);
	const width = useWidth(box);
	const dpr = window.devicePixelRatio || 1;
	const gap = Math.max(1, Math.round(4 * dpr));
	const bar = Math.max(1, Math.floor((Math.floor(width * dpr) - gap * (CHART_DAYS - 1)) / CHART_DAYS));
	const step = bar + gap;
	const w = CHART_DAYS * step - gap;
	const h = Math.round(160 * dpr);
	const line = Math.max(1, Math.round(dpr));
	const y = (v: number) => Math.round((v / top) * h);

	useEffect(() => {
		const ctx = canvas.current?.getContext("2d");
		if (!ctx || !width || !box.current) return;
		ctx.canvas.width = w;
		ctx.canvas.height = h;
		ctx.fillStyle = bgColor(box.current, "bg-neutral-800");
		for (let v = 0; v <= top; v += unit) ctx.fillRect(0, Math.min(h - line, h - y(v)), w, line);
		const colors = Object.fromEntries(WORKOUT_KINDS.map((k) => [k, bgColor(box.current!, EX_COLOR[k])]));
		perDay.forEach((kinds, i) => {
			const total = sums[i]!.done + sums[i]!.planned;
			let below = 0;
			// Done first, then planned; each in table order, bottom up, a line of ground between segments.
			for (const phase of [0, 1] as const) {
				ctx.globalAlpha = phase === 0 ? 1 : 0.35;
				for (const k of WORKOUT_KINDS) {
					const n = kinds.get(k)?.[phase];
					if (!n) continue;
					const y0 = y(below);
					const y1 = y(below + n);
					ctx.fillStyle = colors[k] ?? "";
					ctx.fillRect(i * step, h - y1, bar, y1 - y0 - (below + n < total ? line : 0));
					below += n;
				}
			}
			ctx.globalAlpha = 1;
		});
	}, [perDay, sums, width, w, h, step, bar, line, top, unit]);

	const hover = (e: React.MouseEvent<HTMLCanvasElement>) => {
		const i = Math.floor((e.nativeEvent.offsetX * dpr) / step);
		const day = days[i];
		const kinds = perDay[i];
		const sum = sums[i];
		if (!day || !kinds || !sum) return void (e.currentTarget.title = "");
		const parts = WORKOUT_KINDS.filter((k) => kinds.get(k)).map((k) => {
			const [d, p] = kinds.get(k)!;
			return `${exerciseText(k).name} ${format(d)}${p ? ` + ${format(p)}` : ""}`;
		});
		const head =
			metric === "kcal"
				? t("{done} done, {ahead} planned", { done: format(sum.done), ahead: format(sum.planned) })
				: t("{done} done, {ahead} planned", { done: num().format(sum.done), ahead: num().format(sum.planned) });
		e.currentTarget.title = `${dayFmt().format(day)}: ${head}${parts.length ? `\n${parts.join("\n")}` : ""}`;
	};

	return (
		<div>
			<div className="mb-2 flex items-center gap-3">
				<h3 className={sectionLabel}>{metric === "kcal" ? t("kcal per day, done and planned") : t("Sets per day, done and planned")}</h3>
				{profile && (
					<div className="flex gap-1">
						{(
							[
								["sets", t("Sets")],
								["kcal", t("kcal")],
							] as const
						).map(([m, label]) => (
							<Button
								key={m}
								size="sm"
								variant={by === m ? "subtle" : "ghost"}
								aria-pressed={by === m}
								onClick={() => setBy(m)}
							>
								{label}
							</Button>
						))}
					</div>
				)}
			</div>
			<div className="flex gap-2 text-caption text-neutral-500 tabular-nums">
				<div className="relative w-8 shrink-0" style={{ height: h / dpr }}>
					{ticks.map((v) => (
						<span key={v} className="absolute right-0 translate-y-1/2 leading-none" style={{ bottom: y(v) / dpr }}>
							{num().format(v)}
						</span>
					))}
				</div>
				<div ref={box} className="min-w-0 flex-1">
					<canvas
						ref={canvas}
						role="img"
						aria-label={t("Workout sets per day, done and planned")}
						onMouseMove={hover}
						className="block"
						style={{ width: w / dpr, height: h / dpr }}
					/>
					{/* Today, and every fifth day either side of it, centred under its column; today brighter. */}
					<div className="relative mt-1 h-4" style={{ width: w / dpr }}>
						{days.map((d, i) =>
							(i - CHART_BACK) % 5 === 0 ? (
								<span
									key={i}
									className={`absolute top-0 -translate-x-1/2 whitespace-nowrap leading-none ${
										i === CHART_BACK ? "text-neutral-200" : ""
									}`}
									style={{ left: (i * step + bar / 2) / dpr }}
								>
									{i === CHART_BACK ? t("Today") : shortDayFmt().format(d)}
								</span>
							) : null,
						)}
					</div>
				</div>
			</div>
		</div>
	);
}

/**
 * The charts are canvases so every bar, cell and gap is a whole number of
 * DEVICE pixels: fractional flex and grid tracks, snapped under Windows display
 * scaling, gave gaps of visibly different widths. This is the CSS width they
 * divide up; it is 0 while hidden, and changes on reshow, so they redraw then.
 */
function useWidth(ref: React.RefObject<HTMLElement | null>): number {
	const [width, setWidth] = useState(0);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
		observer.observe(el);
		return () => observer.disconnect();
	}, [ref]);
	return width;
}

/** A `bg-*` class's color right now, resolved: themes define them with var() and color-mix. */
function bgColor(parent: Element, className: string): string {
	const probe = document.createElement("span");
	probe.className = className;
	parent.append(probe);
	const color = getComputedStyle(probe).backgroundColor;
	probe.remove();
	return color;
}

function Heatmap({ turns }: { turns: StatsTurn[] }) {
	const counts = useMemo(() => tally(turns, (t) => dayKey(t.start)), [turns]);
	const weeks = useMemo(() => heatmapWeeks(WEEKS), [turns]);
	const box = useRef<HTMLDivElement>(null);
	const canvas = useRef<HTMLCanvasElement>(null);
	const legend = useRef<HTMLDivElement>(null);
	const width = useWidth(box);

	const dpr = window.devicePixelRatio || 1;
	const gap = Math.max(1, Math.round(2 * dpr));
	const cell = Math.max(1, Math.floor((Math.floor(width * dpr) - gap * (WEEKS - 1)) / WEEKS));
	const step = cell + gap;
	const w = WEEKS * step - gap;
	const h = 7 * step - gap;

	useEffect(() => {
		const ctx = canvas.current?.getContext("2d");
		if (!ctx || !width || !legend.current) return;
		// The legend swatches carry the theme's colors; the canvas copies them.
		const colors = [...legend.current.querySelectorAll("span")].map((s) => getComputedStyle(s).backgroundColor);
		const max = Math.max(1, ...counts.values());
		ctx.canvas.width = w;
		ctx.canvas.height = h;
		weeks.forEach((week, x) =>
			week.forEach((day, y) => {
				if (!day) return;
				const n = counts.get(dayKey(day)) ?? 0;
				ctx.fillStyle = colors[n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4))] ?? "";
				ctx.fillRect(x * step, y * step, cell, cell);
			}),
		);
	}, [counts, weeks, width, w, h, step, cell]);

	/** The hovered day's count, as the canvas tooltip. */
	const hover = (e: React.MouseEvent<HTMLCanvasElement>) => {
		const day = weeks[Math.floor((e.nativeEvent.offsetX * dpr) / step)]?.[
			Math.floor((e.nativeEvent.offsetY * dpr) / step)
		];
		const n = day ? (counts.get(dayKey(day)) ?? 0) : 0;
		e.currentTarget.title = day ? `${dayFmt().format(day)}: ${plural(n, "{n} prompt", "{n} prompts")}` : "";
	};

	/*
	 * Month labels start exactly over the column holding the month's 1st (the
	 * first column is labelled too, for its partial month). January and the
	 * first label carry the year. Walking right to left, a label that would run
	 * into the next one is dropped, so the partial month gives way, not a whole one.
	 */
	const months: { x: number; text: string }[] = [];
	weeks.forEach((week, x) => {
		const first = week.find((d) => d?.getDate() === 1) ?? (x === 0 ? week[0] : undefined);
		if (!first) return;
		const year = x === 0 || first.getMonth() === 0 ? ` ${first.getFullYear()}` : "";
		months.push({ x, text: monthFmt().format(first) + year });
	});
	const labels: typeof months = [];
	let limit = Infinity;
	for (const m of months.reverse()) {
		const left = (m.x * step) / dpr;
		if (left + m.text.length * CAPTION_CHAR + 6 > limit) continue;
		labels.unshift(m);
		limit = left;
	}

	return (
		<div>
			<h3 className={`mb-2 ${sectionLabel}`}>{t("Last {n} weeks", { n: WEEKS })}</h3>
			<div className="flex gap-2 text-caption text-neutral-500">
				{/* Every weekday, each centred on its row. */}
				<div className="w-8 shrink-0">
					<div className="mb-1 h-4" />
					<div className="relative" style={{ height: h / dpr }}>
						{[0, 1, 2, 3, 4, 5, 6].map((d) => (
							<span
								key={d}
								className="absolute right-0 -translate-y-1/2 leading-none"
								style={{ top: (d * step + cell / 2) / dpr }}
							>
								{weeks[0]?.[d] && weekdayFmt().format(weeks[0][d])}
							</span>
						))}
					</div>
				</div>
				<div ref={box} className="min-w-0 flex-1">
					<div style={{ width: w / dpr }}>
						<div className="relative mb-1 h-4">
							{labels.map((m) => (
								<span
									key={m.x}
									className="absolute bottom-0 whitespace-nowrap leading-none"
									style={{ left: (m.x * step) / dpr }}
								>
									{m.text}
								</span>
							))}
						</div>
						<canvas
							ref={canvas}
							role="img"
							aria-label={t("Prompts per day, last {n} weeks", { n: WEEKS })}
							onMouseMove={hover}
							className="block"
							style={{ width: w / dpr, height: h / dpr }}
						/>
						<div
							ref={legend}
							className="mt-1.5 flex items-center justify-end gap-1 text-caption text-neutral-500"
						>
							{t("Less")}
							{HEAT.map((c) => (
								<span key={c} className={`size-2.5 ${c}`} />
							))}
							{t("More")}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

function AnswerTimes({ turns }: { turns: StatsTurn[] }) {
	const ms = turns.map((t) => t.ms).sort((a, b) => a - b);
	const mean = ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : 0;
	const longest = turns.reduce<StatsTurn | undefined>((a, t) => (!a || t.ms > a.ms ? t : a), undefined);
	const buckets = BUCKETS.map(([limit, label], i) => {
		const lower = i === 0 ? 0 : (BUCKETS[i - 1]?.[0] ?? 0);
		return [t(label), ms.filter((m) => m >= lower && m < limit).length] as [string, number];
	});
	return (
		<div>
			<h3 className={`mb-2 ${sectionLabel}`}>{t("Answer time")}</h3>
			<dl className="mb-3 grid grid-cols-4 gap-2 text-meta">
				{(
					[
						["Median", percentile(ms, 0.5)],
						["Mean", mean],
						["p90", percentile(ms, 0.9)],
						["Longest", longest?.ms ?? 0],
					] as const
				).map(([label, v]) => (
					<div key={label} title={label === "Longest" ? longest?.prompt : undefined}>
						<dt className="text-neutral-500">{t(label)}</dt>
						<dd className="text-ui text-neutral-200 tabular-nums">{duration(v)}</dd>
					</div>
				))}
			</dl>
			<Bars rows={buckets} />
		</div>
	);
}

/**
 * A round unit (1, 2 or 5 times a power of 10) giving at most four gridlines
 * above zero; bars scale to the top gridline, not to the tallest bar.
 */
function axis(max: number): { unit: number; top: number; ticks: number[] } {
	const raw = max / 4;
	const mag = 10 ** Math.floor(Math.log10(raw));
	const unit = Math.max(1, ([1, 2, 5, 10].find((s) => s * mag >= raw) ?? 10) * mag);
	const top = Math.ceil(max / unit) * unit;
	return { unit, top, ticks: Array.from({ length: top / unit + 1 }, (_, i) => i * unit) };
}

function Hours({ turns }: { turns: StatsTurn[] }) {
	const hours = useMemo(() => {
		const out = Array.from({ length: 24 }, () => 0);
		for (const t of turns) out[new Date(t.start).getHours()]! += 1;
		return out;
	}, [turns]);
	const { unit, top, ticks } = axis(Math.max(1, ...hours));

	const box = useRef<HTMLDivElement>(null);
	const canvas = useRef<HTMLCanvasElement>(null);
	const width = useWidth(box);
	// Device pixels throughout; divided by dpr only where CSS positions a label.
	const dpr = window.devicePixelRatio || 1;
	const gap = Math.max(1, Math.round(2 * dpr));
	const bar = Math.max(1, Math.floor((Math.floor(width * dpr) - gap * 23) / 24));
	const step = bar + gap;
	const w = 24 * step - gap;
	const h = Math.round(128 * dpr);
	const line = Math.max(1, Math.round(dpr));
	/** Height above the baseline, in device pixels. */
	const y = (v: number) => Math.round((v / top) * h);

	useEffect(() => {
		const ctx = canvas.current?.getContext("2d");
		if (!ctx || !width || !box.current) return;
		ctx.canvas.width = w;
		ctx.canvas.height = h;
		ctx.fillStyle = bgColor(box.current, "bg-neutral-800");
		for (let v = 0; v <= top; v += unit) ctx.fillRect(0, Math.min(h - line, h - y(v)), w, line);
		ctx.fillStyle = bgColor(box.current, "bg-amber-500");
		hours.forEach((n, i) => {
			if (!n) return;
			const bh = Math.max(y(n), line * 2);
			ctx.fillRect(i * step, h - bh, bar, bh);
		});
	}, [hours, width, w, h, step, bar, line, top, unit]);

	const hover = (e: React.MouseEvent<HTMLCanvasElement>) => {
		const i = Math.floor((e.nativeEvent.offsetX * dpr) / step);
		const n = hours[i];
		e.currentTarget.title = n === undefined ? "" : `${i}:00 – ${plural(n, "{n} prompt", "{n} prompts")}`;
	};

	return (
		<div>
			<h3 className={`mb-2 ${sectionLabel}`}>{t("By hour")}</h3>
			<div className="flex gap-2 text-caption text-neutral-500 tabular-nums">
				<div className="relative w-8 shrink-0" style={{ height: h / dpr }}>
					{ticks.map((v) => (
						<span
							key={v}
							className="absolute right-0 translate-y-1/2 leading-none"
							style={{ bottom: y(v) / dpr }}
						>
							{num().format(v)}
						</span>
					))}
				</div>
				<div ref={box} className="min-w-0 flex-1">
					<canvas
						ref={canvas}
						role="img"
						aria-label={t("Prompts by hour of day: {hours}", { hours: hours.map((n, i) => `${i}:00 ${n}`).join(", ") })}
						onMouseMove={hover}
						className="block"
						style={{ width: w / dpr, height: h / dpr }}
					/>
					{/* Every third hour, centred under its own bar. */}
					<div className="relative mt-1 h-4" style={{ width: w / dpr }}>
						{hours.map((_, i) =>
							i % 3 === 0 ? (
								<span
									key={i}
									className="absolute top-0 -translate-x-1/2 leading-none"
									style={{ left: (i * step + bar / 2) / dpr }}
								>
									{i}
								</span>
							) : null,
						)}
					</div>
				</div>
			</div>
		</div>
	);
}

function Bars({ title, rows }: { title?: string; rows: [string, number][] }) {
	const max = Math.max(1, ...rows.map(([, n]) => n));
	return (
		<div>
			{title && <h3 className={`mb-2 ${sectionLabel}`}>{title}</h3>}
			{rows.length === 0 && <p className="text-meta text-neutral-500">{t("None yet.")}</p>}
			<div className="flex flex-col gap-1">
				{rows.map(([label, n]) => (
					<div key={label} className="flex items-center gap-2 text-meta">
						<span className="w-28 shrink-0 fade-end text-neutral-300" title={label}>
							{label}
						</span>
						<div className="h-2 min-w-0 flex-1">
							<div className="h-full rounded-full bg-amber-500" style={{ width: `${(n / max) * 100}%` }} />
						</div>
						<span className="w-10 shrink-0 text-right text-caption text-neutral-500 tabular-nums">
							{num().format(n)}
						</span>
					</div>
				))}
			</div>
		</div>
	);
}

type Metric = "tokens" | "ms" | "calls";
const METRICS: [Metric, string][] = [
	["tokens", "Tokens"],
	["ms", "Time"],
	["calls", "Calls"],
];
const TOOL_ROWS = 15;

/** Each tool, bash by program, ranked by what its calls cost in tokens, time or count. */
function ToolCosts({ turns }: { turns: StatsTurn[] }) {
	const [by, setBy] = useState<Metric>("tokens");
	const costs = useMemo(() => {
		const m = new Map<string, ToolCost>();
		for (const turn of turns)
			for (const [k, c] of Object.entries(turn.costs)) {
				const a = m.get(k) ?? { calls: 0, tokens: 0, ms: 0, hookMs: 0, measured: 0 };
				a.calls += c.calls;
				a.tokens += c.tokens;
				a.ms += c.ms;
				a.hookMs += c.hookMs;
				a.measured += c.measured;
				m.set(k, a);
			}
		return m;
	}, [turns]);
	const all = [...costs.values()];
	const calls = all.reduce((n, c) => n + c.calls, 0);
	const measured = calls ? Math.round((all.reduce((n, c) => n + c.measured, 0) / calls) * 100) : 0;
	const rows = [...costs].sort((a, b) => b[1][by] - a[1][by]).slice(0, TOOL_ROWS);
	const max = Math.max(1, ...rows.map(([, c]) => c[by]));
	const cell = (m: Metric | "avg") =>
		`w-14 shrink-0 text-right tabular-nums ${m === by ? "text-neutral-200" : "text-neutral-500"}`;
	return (
		<div>
			<div className="mb-2 flex items-center gap-2">
				<h3 className={sectionLabel}>{t("Tool calls")}</h3>
				<div className="ml-auto flex gap-1">
					{METRICS.map(([m, label]) => (
						<Button
							key={m}
							size="sm"
							variant={by === m ? "subtle" : "ghost"}
							aria-pressed={by === m}
							onClick={() => setBy(m)}
						>
							{t(label)}
						</Button>
					))}
				</div>
			</div>
			{rows.length === 0 ? (
				<p className="text-meta text-neutral-500">{t("None yet.")}</p>
			) : (
				<div className="flex flex-col gap-1 text-meta">
					<div className="flex items-center gap-2 text-caption text-neutral-500">
						<span className="min-w-0 flex-1" />
						<span className="w-14 shrink-0 text-right">{t("Calls")}</span>
						<span className="w-14 shrink-0 text-right">{t("Tokens")}</span>
						<span className="w-14 shrink-0 text-right">{t("Time")}</span>
						<span className="w-14 shrink-0 text-right">{t("Per call")}</span>
						<span className="w-14 shrink-0 text-right">{t("Hooks")}</span>
					</div>
					{rows.map(([key, c]) => (
						<div key={key} className="flex items-center gap-2">
							<span className="w-48 shrink-0 fade-end font-mono text-neutral-300" title={key}>
								{key}
							</span>
							<div className="h-2 min-w-0 flex-1">
								<div
									className="h-full rounded-full bg-amber-500"
									style={{ width: `${(c[by] / max) * 100}%` }}
								/>
							</div>
							<span className={cell("calls")}>{num().format(c.calls)}</span>
							<span className={cell("tokens")}>{num().format(c.tokens)}</span>
							<span className={cell("ms")}>{callDuration(c.ms)}</span>
							<span className={cell("avg")}>{callDuration(c.ms / c.calls)}</span>
							<span className={cell("avg")}>{c.measured ? callDuration(c.hookMs) : "\u2013"}</span>
						</div>
					))}
				</div>
			)}
			<p className="mt-2 text-meta text-neutral-500">
				{t(
					"Tokens are arguments plus result, about 4 characters each. Time is measured for {pct}% of calls; the rest is estimated from session timestamps, with calls sent together splitting their wait evenly. Hooks is the part of Time other extensions (pi-lens) spent on the result. A measured bash call counts per command; bash: (shell) is its time outside them.",
					{ pct: measured },
				)}
			</p>
		</div>
	);
}

const OUTLIER_ROWS = 10;

/** The single calls that cost the most, across the turns shown. */
function Outliers({ title, by, turns }: { title: string; by: "ms" | "tokens"; turns: StatsTurn[] }) {
	const rows = useMemo(
		() =>
			turns
				.flatMap((turn) => turn.outliers.map((o) => ({ ...o, turn })))
				.sort((a, b) => b[by] - a[by])
				.slice(0, OUTLIER_ROWS),
		[turns, by],
	);
	return (
		<div>
			<h3 className={`mb-2 ${sectionLabel}`}>{title}</h3>
			{rows.length === 0 && <p className="text-meta text-neutral-500">{t("None yet.")}</p>}
			<ul className="flex flex-col gap-1 text-meta">
				{rows.map((o, i) => (
					<li
						key={i}
						className="flex items-center gap-2"
						title={`${o.preview}\n${stampFmt().format(new Date(o.turn.start))} · ${projectName(o.turn.cwd)} · ${o.turn.prompt}`}
					>
						<span className="w-12 shrink-0 fade-end font-mono text-neutral-500">{o.key.split(":")[0]}</span>
						<span className="min-w-0 flex-1 fade-end font-mono text-neutral-300">{o.preview}</span>
						<span className="w-14 shrink-0 text-right tabular-nums text-neutral-200">
							{by === "ms" ? callDuration(o.ms) : num().format(o.tokens)}
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}

/** The longest-lived jobs commands left running with `&`, measured by the tool-metrics collector. */
function Background({ turns }: { turns: StatsTurn[] }) {
	const rows = useMemo(
		() =>
			turns
				.flatMap((turn) => turn.background.map((b) => ({ ...b, turn })))
				.sort((a, b) => b.ms - a.ms)
				.slice(0, OUTLIER_ROWS),
		[turns],
	);
	return (
		<div>
			<h3 className={`mb-2 ${sectionLabel}`}>{t("Background jobs")}</h3>
			{rows.length === 0 && <p className="text-meta text-neutral-500">{t("None yet.")}</p>}
			<ul className="flex flex-col gap-1 text-meta">
				{rows.map((b, i) => (
					<li
						key={i}
						className="flex items-center gap-2"
						title={`${b.text}\n${stampFmt().format(new Date(b.turn.start))} \u00b7 ${projectName(b.turn.cwd)} \u00b7 ${b.turn.prompt}`}
					>
						<span className="min-w-0 flex-1 fade-end font-mono text-neutral-300">{b.text}</span>
						<span className="w-14 shrink-0 text-right tabular-nums text-neutral-200">{callDuration(b.ms)}</span>
					</li>
				))}
			</ul>
		</div>
	);
}

function Answers({ turns }: { turns: StatsTurn[] }) {
	const { shown, end, more } = useBatches(turns.length);

	return (
		<div>
			<h3 className={`mb-2 ${sectionLabel}`}>{t("All answers ({n})", { n: turns.length })}</h3>
			<ul className="flex flex-col">
				{turns.slice(0, shown).map((turn) => {
					const tools = Object.values(turn.tools).reduce((a, b) => a + b, 0);
					return (
						<li key={`${turn.session}-${turn.start}`} className="border-b border-neutral-800 py-1.5">
							<div className="flex items-center gap-2">
								<span className="min-w-0 flex-1 fade-end text-neutral-200" title={turn.prompt}>
									{turn.prompt || t("(image)")}
								</span>
								{(turn.outcome === "error" || turn.outcome === "aborted") && (
									<span
										className={`shrink-0 text-caption ${turn.outcome === "error" ? "text-red-400" : "text-neutral-500"}`}
									>
										{turn.outcome === "error" ? t("error") : t("aborted")}
									</span>
								)}
								{turn.machine && <span className="shrink-0 text-caption text-neutral-400">{turn.machine}</span>}
								<span className="shrink-0 text-caption text-neutral-400 tabular-nums">{duration(turn.ms)}</span>
							</div>
							<div className="fade-end text-meta text-neutral-500">
								{stampFmt().format(new Date(turn.start))} · {projectName(turn.cwd)} · {turn.model || "?"}
								{tools > 0 && ` · ${plural(tools, "{n} tool", "{n} tools")}`}
								{turn.cost > 0 && ` · ${usd().format(turn.cost)}`}
							</div>
						</li>
					);
				})}
			</ul>
			{more && <div ref={end} className="h-4" />}
		</div>
	);
}
