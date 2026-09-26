/**
 * Stats.tsx — usage across every pi session on this machine: the streak
 * heatmap, how long answers take, when and with what you work, and every
 * answered prompt.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowClockwise } from "@phosphor-icons/react";
import type { StatsTurn, StatsView } from "../shared/types.js";
import { Button, IconButton, PanelHeader, sectionLabel } from "./ui.js";
import { dayKey, duration, heatmapWeeks, percentile, streaks } from "./stats.js";

type Source = "all" | "web" | "terminal";
const SOURCES: [Source, string][] = [
	["all", "All"],
	["web", "Web UI"],
	["terminal", "Terminal"],
];

const WEEKS = 26;
const HEAT = ["bg-neutral-800", "bg-amber-900", "bg-amber-700", "bg-amber-500", "bg-amber-300"];
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
const stampFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const num = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const usd = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });

const projectName = (cwd: string) => cwd.split("/").filter(Boolean).pop() ?? cwd;

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

export function Stats({ revision, onClose }: { revision?: unknown; onClose: () => void }) {
	const [view, setView] = useState<StatsView | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [source, setSource] = useState<Source>("all");

	const load = useCallback(async () => {
		try {
			const r = await fetch("/api/stats");
			if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? r.statusText);
			setView((await r.json()) as StatsView);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, []);

	// Re-read after every reply: a finished answer is a new row.
	useEffect(() => {
		void load();
	}, [load, revision]);

	const turns = useMemo(
		() =>
			(view?.turns ?? []).filter((t) => source === "all" || (source === "web") === t.web),
		[view, source],
	);

	return (
		<section
			aria-label="Stats"
			className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-neutral-950 text-neutral-100"
		>
			<PanelHeader title="Stats" onClose={onClose}>
				<div className="flex gap-1">
					{SOURCES.map(([s, label]) => (
						<Button
							key={s}
							variant={source === s ? "subtle" : "ghost"}
							size="sm"
							onClick={() => setSource(s)}
							aria-pressed={source === s}
						>
							{label}
						</Button>
					))}
				</div>
				<IconButton size="sm" label="Refresh" onClick={() => void load()}>
					<ArrowClockwise size={14} />
				</IconButton>
			</PanelHeader>

			<div className="min-h-0 flex-1 overflow-y-auto p-3">
				{error && <p className="mb-3 text-meta text-red-400">{error}</p>}
				{!view && !error && <p className="text-meta text-neutral-500">Reading sessions…</p>}
				{view && (
					<div className="flex flex-col gap-6">
						{source !== "terminal" && (
							<p className="text-meta text-neutral-500">
								Web UI sessions are counted from {stampFmt.format(new Date(view.webSince))}; older
								ones show as terminal.
							</p>
						)}
						<Summary turns={turns} />
						<Heatmap turns={turns} />
						<AnswerTimes turns={turns} />
						<Hours turns={turns} />
						<Bars title="Models" rows={top(tally(turns, (t) => t.model))} />
						<Bars title="Projects" rows={top(tally(turns, (t) => projectName(t.cwd)))} />
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
						<Answers turns={turns} />
					</div>
				)}
			</div>
		</section>
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

function Heatmap({ turns }: { turns: StatsTurn[] }) {
	const counts = tally(turns, (t) => dayKey(t.start));
	const max = Math.max(1, ...counts.values());
	const level = (n: number) => (n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4)));
	return (
		<div>
			<h3 className={`mb-2 ${sectionLabel}`}>Last {WEEKS} weeks</h3>
			<div
				className="grid grid-flow-col grid-rows-7 gap-0.5"
				style={{ gridTemplateColumns: `repeat(${WEEKS}, minmax(0, 1fr))` }}
			>
				{heatmapWeeks(WEEKS).flatMap((week, w) =>
					week.map((day, d) => {
						if (!day) return <div key={`${w}-${d}`} />;
						const n = counts.get(dayKey(day)) ?? 0;
						return (
							<div
								key={`${w}-${d}`}
								title={`${dayFmt.format(day)}: ${n} prompt${n === 1 ? "" : "s"}`}
								className={`aspect-square ${HEAT[level(n)]}`}
							/>
						);
					}),
				)}
			</div>
			<div className="mt-1.5 flex items-center justify-end gap-1 text-caption text-neutral-500">
				Less
				{HEAT.map((c) => (
					<span key={c} className={`size-2.5 ${c}`} />
				))}
				More
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
	const hours = Array.from({ length: 24 }, () => 0);
	for (const t of turns) hours[new Date(t.start).getHours()]! += 1;
	const max = Math.max(1, ...hours);
	return (
		<div>
			<h3 className={`mb-2 ${sectionLabel}`}>By hour</h3>
			<div className="flex h-16 items-end gap-0.5">
				{hours.map((n, h) => (
					<div
						key={h}
						title={`${h}:00 – ${n} prompt${n === 1 ? "" : "s"}`}
						className="flex-1 bg-amber-500"
						style={{ height: `${(n / max) * 100}%`, minHeight: n ? 2 : 0 }}
					/>
				))}
			</div>
			<div className="mt-1 flex justify-between text-caption text-neutral-500 tabular-nums">
				<span>0</span>
				<span>6</span>
				<span>12</span>
				<span>18</span>
				<span>23</span>
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
	return (
		<div>
			<h3 className={`mb-2 ${sectionLabel}`}>All answers ({turns.length})</h3>
			<ul className="flex flex-col">
				{turns.map((t) => {
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
								{t.web && <span className="shrink-0 text-caption text-amber-400">web</span>}
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
		</div>
	);
}
