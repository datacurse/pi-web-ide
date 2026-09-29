/**
 * Stats.tsx — usage across every pi session on this machine and the ones
 * mirrored from other machines over ssh (see server/machines.ts): the streak
 * heatmap, how long answers take, when and with what you work, and every
 * answered prompt.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowClockwise } from "@phosphor-icons/react";
import type { StatsTurn, StatsView, ToolCost, UsageSample } from "../shared/types.js";
import { Button, IconButton, PanelHeader, sectionLabel, useBatches } from "./ui.js";
import { callDuration, dayKey, duration, heatmapWeeks, LIMIT_WINDOW_MS, pace, percentile, span, streaks, type Pace } from "./stats.js";
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

			{/* Laid out for the page dialog's width; the grids stack on a narrow window. */}
			<div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">
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
						<div className="grid gap-6 md:grid-cols-2">
							<Outliers title={t("Slowest calls")} by="ms" turns={turns} />
							<Outliers title={t("Largest calls")} by="tokens" turns={turns} />
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

function Hours({ turns }: { turns: StatsTurn[] }) {
	const hours = useMemo(() => {
		const out = Array.from({ length: 24 }, () => 0);
		for (const t of turns) out[new Date(t.start).getHours()]! += 1;
		return out;
	}, [turns]);
	// A round unit (1, 2 or 5 times a power of 10) giving at most four gridlines
	// above zero; the bars scale to the top gridline, not to the tallest bar.
	const raw = Math.max(1, ...hours) / 4;
	const mag = 10 ** Math.floor(Math.log10(raw));
	const unit = Math.max(1, ([1, 2, 5, 10].find((s) => s * mag >= raw) ?? 10) * mag);
	const top = Math.ceil(Math.max(1, ...hours) / unit) * unit;
	const ticks = Array.from({ length: top / unit + 1 }, (_, i) => i * unit);

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
						<span className="w-28 shrink-0 truncate text-neutral-300" title={label}>
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

type Metric = keyof ToolCost;
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
				const a = m.get(k) ?? { calls: 0, tokens: 0, ms: 0 };
				a.calls += c.calls;
				a.tokens += c.tokens;
				a.ms += c.ms;
				m.set(k, a);
			}
		return m;
	}, [turns]);
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
					</div>
					{rows.map(([key, c]) => (
						<div key={key} className="flex items-center gap-2">
							<span className="w-48 shrink-0 truncate font-mono text-neutral-300" title={key}>
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
						</div>
					))}
				</div>
			)}
			<p className="mt-2 text-meta text-neutral-500">
				{t(
					"Tokens are arguments plus result, about 4 characters each. Time is the wait for the result; calls sent together split their wait evenly.",
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
						<span className="w-12 shrink-0 truncate font-mono text-neutral-500">{o.key.split(":")[0]}</span>
						<span className="min-w-0 flex-1 truncate font-mono text-neutral-300">{o.preview}</span>
						<span className="w-14 shrink-0 text-right tabular-nums text-neutral-200">
							{by === "ms" ? callDuration(o.ms) : num().format(o.tokens)}
						</span>
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
								<span className="min-w-0 flex-1 truncate text-neutral-200" title={turn.prompt}>
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
							<div className="truncate text-meta text-neutral-500">
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
