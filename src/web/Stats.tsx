/**
 * Stats.tsx — usage across every pi session on this machine and the ones
 * mirrored from other machines over ssh (see server/machines.ts): the streak
 * heatmap, how long answers take, when and with what you work, and every
 * answered prompt.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowClockwise } from "@phosphor-icons/react";
import type { StatsTurn, StatsView } from "../shared/types.js";
import { Button, IconButton, PanelHeader, sectionLabel, useBatches } from "./ui.js";
import { dayKey, duration, heatmapWeeks, percentile, streaks } from "./stats.js";

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

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const monthFmt = new Intl.DateTimeFormat(undefined, { month: "short" });
const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const stampFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const num = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const usd = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });

const projectName = (cwd: string) => cwd.split("/").filter(Boolean).pop() ?? cwd;
/** Remote projects carry their machine: `~/code/foo` on two machines is two projects. */
const projectOf = (t: StatsTurn) => (t.machine ? `${t.machine}:${projectName(t.cwd)}` : projectName(t.cwd));
const THIS_PC = "This PC";

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
			const r = await fetch(`/api/stats${sync ? `?sync=${sync}` : ""}`);
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

	const turns = useMemo(
		() => (view?.turns ?? []).filter((t) => machine === null || t.machine === machine),
		[view, machine],
	);
	const remote = view?.machines ?? [];
	const filters: [string | null, string, string | undefined][] = [
		[null, "All", undefined],
		["", THIS_PC, undefined],
		...remote.map(
			(m): [string, string, string] => [
				m.name,
				m.name,
				m.error
					? `Unreachable: ${m.error}. Last synced ${stampFmt.format(new Date(m.synced))}`
					: `Synced ${stampFmt.format(new Date(m.synced))}`,
			],
		),
	];

	return (
		<section
			aria-label="Stats"
			className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-neutral-950 text-neutral-100"
		>
			<PanelHeader title="Stats" onClose={onClose}>
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
				<IconButton size="sm" label="Refresh" onClick={() => void load(true)}>
					<ArrowClockwise size={14} />
				</IconButton>
				{syncing && <span className="text-meta text-neutral-500">Syncing machines…</span>}
			</PanelHeader>

			{/* Laid out for the page dialog's width; the grids stack on a narrow window. */}
			<div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">
				{error && <p className="text-meta text-red-400">{error}</p>}
				<div className="grid gap-6 md:grid-cols-3">
					<Usage reload={reload} />
					<div className="md:col-span-2">
						{view ? (
							<Summary turns={turns} />
						) : (
							!error && <p className="text-meta text-neutral-500">Reading sessions…</p>
						)}
					</div>
				</div>
				{view && (
					<>
						<Heatmap turns={turns} />
						<div className="grid gap-6 md:grid-cols-2">
							<AnswerTimes turns={turns} />
							<Hours turns={turns} />
						</div>
						<div className={`grid gap-6 ${remote.length > 0 ? "md:grid-cols-4" : "md:grid-cols-3"}`}>
							{remote.length > 0 && (
								<Bars title="Machines" rows={top(tally(turns, (t) => t.machine || THIS_PC))} />
							)}
							<Bars title="Models" rows={top(tally(turns, (t) => t.model))} />
							<Bars title="Projects" rows={top(tally(turns, projectOf))} />
							<Bars
								title="Tools"
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
	percent: number;
	resets_at: string | null;
	scope: { model?: { display_name?: string | null } } | null;
}

function limitLabel(l: UsageLimit): string {
	if (l.kind === "session") return "Current session";
	if (l.kind === "weekly_all") return "This week";
	const model = l.scope?.model?.display_name;
	return model ? `${model} this week` : l.kind.replace(/_/g, " ");
}

function resetLabel(iso: string | null): string {
	if (!iso) return "";
	const d = new Date(iso);
	const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
	return d.getTime() - Date.now() < 86_400_000
		? `Resets at ${time}`
		: `Resets ${d.toLocaleDateString([], { weekday: "long" })} ${time}`;
}

function Usage({ reload }: { reload: number }) {
	const [limits, setLimits] = useState<UsageLimit[] | null>(null);
	const [usageError, setUsageError] = useState<string | null>(null);
	useEffect(() => {
		void (async () => {
			const r = await fetch("/api/usage").catch(() => null);
			const body = (await r?.json().catch(() => null)) as {
				limits?: UsageLimit[];
				error?: string;
			} | null;
			if (r?.ok && Array.isArray(body?.limits)) {
				setLimits(body.limits);
				setUsageError(null);
			} else setUsageError(body?.error ?? "could not load usage");
		})();
	}, [reload]);
	return (
		<div>
			<h3 className={`mb-2 ${sectionLabel}`}>Usage remaining</h3>
			{usageError ? (
				<p className="text-meta text-red-400">{usageError}</p>
			) : !limits ? (
				<p className="text-meta text-neutral-500">loading…</p>
			) : (
				<div className="flex flex-col gap-3">
					{limits.map((l) => {
						const left = Math.max(0, Math.min(100, 100 - l.percent));
						return (
							<div key={`${l.kind}-${limitLabel(l)}`} className="text-ui">
								<div className="flex items-baseline justify-between gap-2">
									<span>{limitLabel(l)}</span>
									<span className="text-meta text-neutral-300">{left}% left</span>
								</div>
								<div
									role="meter"
									aria-label={`${limitLabel(l)} remaining`}
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
				</div>
			)}
		</div>
	);
}

function Summary({ turns }: { turns: StatsTurn[] }) {
	const days = new Set(turns.map((t) => dayKey(t.start)));
	const { current, longest } = streaks(days);
	const ms = turns.map((t) => t.ms).sort((a, b) => a - b);
	const tiles: [string, string][] = [
		["Prompts", num.format(turns.length)],
		["Sessions", num.format(new Set(turns.map((t) => t.session)).size)],
		["Active days", num.format(days.size)],
		["Current streak", `${current}d`],
		["Longest streak", `${longest}d`],
		["Median answer", duration(percentile(ms, 0.5))],
		["Output tokens", num.format(turns.reduce((s, t) => s + t.outputTokens, 0))],
		["Tool calls", num.format(turns.reduce((s, t) => s + Object.values(t.tools).reduce((a, b) => a + b, 0), 0))],
		["Cost", usd.format(turns.reduce((s, t) => s + t.cost, 0))],
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
		e.currentTarget.title = day ? `${dayFmt.format(day)}: ${n} prompt${n === 1 ? "" : "s"}` : "";
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
		months.push({ x, text: monthFmt.format(first) + year });
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
			<h3 className={`mb-2 ${sectionLabel}`}>Last {WEEKS} weeks</h3>
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
								{weeks[0]?.[d] && weekdayFmt.format(weeks[0][d])}
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
							aria-label={`Prompts per day, last ${WEEKS} weeks`}
							onMouseMove={hover}
							className="block"
							style={{ width: w / dpr, height: h / dpr }}
						/>
						<div
							ref={legend}
							className="mt-1.5 flex items-center justify-end gap-1 text-caption text-neutral-500"
						>
							Less
							{HEAT.map((c) => (
								<span key={c} className={`size-2.5 ${c}`} />
							))}
							More
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
		return [label, ms.filter((m) => m >= lower && m < limit).length] as [string, number];
	});
	return (
		<div>
			<h3 className={`mb-2 ${sectionLabel}`}>Answer time</h3>
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
						<dt className="text-neutral-500">{label}</dt>
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
		e.currentTarget.title = n === undefined ? "" : `${i}:00 – ${n} prompt${n === 1 ? "" : "s"}`;
	};

	return (
		<div>
			<h3 className={`mb-2 ${sectionLabel}`}>By hour</h3>
			<div className="flex gap-2 text-caption text-neutral-500 tabular-nums">
				<div className="relative w-8 shrink-0" style={{ height: h / dpr }}>
					{ticks.map((v) => (
						<span
							key={v}
							className="absolute right-0 translate-y-1/2 leading-none"
							style={{ bottom: y(v) / dpr }}
						>
							{num.format(v)}
						</span>
					))}
				</div>
				<div ref={box} className="min-w-0 flex-1">
					<canvas
						ref={canvas}
						role="img"
						aria-label={`Prompts by hour of day: ${hours.map((n, i) => `${i}h ${n}`).join(", ")}`}
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
			{rows.length === 0 && <p className="text-meta text-neutral-500">None yet.</p>}
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
							{num.format(n)}
						</span>
					</div>
				))}
			</div>
		</div>
	);
}

function Answers({ turns }: { turns: StatsTurn[] }) {
	const { shown, end, more } = useBatches(turns.length);

	return (
		<div>
			<h3 className={`mb-2 ${sectionLabel}`}>All answers ({turns.length})</h3>
			<ul className="flex flex-col">
				{turns.slice(0, shown).map((t) => {
					const tools = Object.values(t.tools).reduce((a, b) => a + b, 0);
					return (
						<li key={`${t.session}-${t.start}`} className="border-b border-neutral-900 py-1.5">
							<div className="flex items-center gap-2">
								<span className="min-w-0 flex-1 truncate text-neutral-200" title={t.prompt}>
									{t.prompt || "(image)"}
								</span>
								{(t.outcome === "error" || t.outcome === "aborted") && (
									<span
										className={`shrink-0 text-caption ${t.outcome === "error" ? "text-red-400" : "text-neutral-500"}`}
									>
										{t.outcome}
									</span>
								)}
								{t.machine && <span className="shrink-0 text-caption text-neutral-400">{t.machine}</span>}
								<span className="shrink-0 text-caption text-neutral-400 tabular-nums">{duration(t.ms)}</span>
							</div>
							<div className="truncate text-meta text-neutral-500">
								{stampFmt.format(new Date(t.start))} · {projectName(t.cwd)} · {t.model || "?"}
								{tools > 0 && ` · ${tools} tool${tools === 1 ? "" : "s"}`}
								{t.cost > 0 && ` · ${usd.format(t.cost)}`}
							</div>
						</li>
					);
				})}
			</ul>
			{more && <div ref={end} className="h-4" />}
		</div>
	);
}
