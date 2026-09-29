/**
 * Fleet.tsx — every tailnet machine: its pwi link, a shell on it, and Start.
 *
 * The point is getting back fast: the links do not live in a browser's
 * history, and a machine whose pwi stopped is one Start away (server/fleet.ts).
 * Each machine gets one shell, shown under the list and kept on the server, so
 * reopening the page lands back in it.
 */

import { useCallback, useEffect, useState } from "react";
import { ArrowClockwise, TerminalWindow } from "@phosphor-icons/react";
import type { FleetMachine, FleetPwi } from "../shared/types.js";
import { Button, IconButton, IconLink, PanelHeader } from "./ui.js";
import { timeAgo } from "./SessionList.js";
import { Terminal } from "./Terminal.js";
import { api } from "./api.js";
import { t } from "./i18n.js";
import { ScrollPane } from "./OverlayScrollbar.js";

const PWI: Record<FleetPwi, { text: string; tone: string; hint: string }> = {
	running: { text: "pwi running", tone: "text-green-400", hint: "Open its pwi" },
	dev: {
		text: "pwi in dev mode",
		tone: "text-amber-400",
		hint: "Its dev server redirects to a Vite port only it can reach; Start switches it to the built app",
	},
	stopped: { text: "pwi stopped", tone: "text-neutral-400", hint: "Served on the tailnet, but pwi is not running" },
	unserved: { text: "pwi not on the tailnet", tone: "text-neutral-500", hint: "Nothing answers on its tailnet link" },
};

/** Machine (MagicDNS name) → its shell's id, and the machine whose shell is showing. */
const SHELLS = "pwi:fleetShells";
const SHOWN = "pwi:fleetShown";

function readShells(): Record<string, string> {
	try {
		const v = JSON.parse(localStorage.getItem(SHELLS) ?? "{}") as unknown;
		return v && typeof v === "object" ? (v as Record<string, string>) : {};
	} catch {
		return {};
	}
}

/** Tailscale's mark: nine dots, the middle row and bottom centre solid. */
function TailscaleLogo({ size = 16 }: { size?: number }) {
	const solid = new Set([3, 4, 5, 7]);
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" aria-hidden fill="currentColor">
			{Array.from({ length: 9 }, (_, i) => (
				<circle key={i} cx={4 + (i % 3) * 8} cy={4 + Math.floor(i / 3) * 8} r={2.6} opacity={solid.has(i) ? 1 : 0.25} />
			))}
		</svg>
	);
}

function Row({
	m,
	shown,
	onTerminal,
	onStarted,
}: {
	m: FleetMachine;
	/** Its shell is the one under the list. */
	shown: boolean;
	onTerminal: () => void;
	onStarted: () => void;
}) {
	const [starting, setStarting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const pwi = m.pwi && PWI[m.pwi];

	const start = async () => {
		setStarting(true);
		setError(null);
		try {
			const r = await api.fleet.start.$post({ json: { ssh: m.ssh } });
			if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? r.statusText);
			onStarted();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setStarting(false);
		}
	};

	return (
		<li className={`flex flex-col gap-1 border-b border-neutral-800 px-4 py-2 ${shown ? "bg-neutral-900" : ""}`}>
			<div className="flex items-center gap-3">
				<span
					aria-hidden
					className={`size-2 shrink-0 rounded-full ${m.online ? "bg-green-500" : "bg-neutral-700"}`}
				/>
				<div className="min-w-0 flex-1">
					<p className={`fade-end ${m.online ? "text-neutral-100" : "text-neutral-500"}`}>
						{m.name}
						{m.self && <span className="ml-2 text-caption text-neutral-500">{t("this PC")}</span>}
					</p>
					<p className="fade-end text-meta text-neutral-500">
						{[m.os, m.ip, m.self ? null : `ssh ${m.ssh}`].filter(Boolean).join(" · ")}
					</p>
				</div>
				<p className={`shrink-0 text-meta ${pwi?.tone ?? "text-neutral-500"}`} title={pwi && t(pwi.hint)}>
					{pwi ? t(pwi.text) : m.lastSeen ? t("offline, seen {ago}", { ago: timeAgo(m.lastSeen) }) : t("offline")}
				</p>
				{m.online && !m.self && m.pwi !== "running" && (
					<Button size="sm" onClick={() => void start()} disabled={starting}>
						{starting ? t("Starting…") : t("Start pwi")}
					</Button>
				)}
				<IconButton
					size="sm"
					variant={shown ? "outline" : "ghost"}
					aria-pressed={shown}
					label={m.self ? t("Terminal on this PC") : t("Terminal: ssh {alias}", { alias: m.ssh })}
					onClick={onTerminal}
					disabled={!m.online}
				>
					<TerminalWindow size={16} />
				</IconButton>
				<IconLink size="sm" href={m.url} label={`${pwi ? t(pwi.hint) : t("Open its pwi")}: ${m.url}`}>
					<TailscaleLogo />
				</IconLink>
			</div>
			{error && <p className="pl-5 text-meta text-red-400">{error}</p>}
		</li>
	);
}

export function Fleet({ open, onClose }: { open: boolean; onClose: () => void }) {
	const [machines, setMachines] = useState<FleetMachine[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [shells, setShells] = useState(readShells);
	const [shown, setShown] = useState(() => localStorage.getItem(SHOWN) ?? "");
	/** Until the stored shells are checked against the server's, none is attached. */
	const [ready, setReady] = useState(false);

	const saveShells = useCallback((update: (s: Record<string, string>) => Record<string, string>) => {
		setShells((current) => {
			const next = update(current);
			localStorage.setItem(SHELLS, JSON.stringify(next));
			return next;
		});
	}, []);
	const show = (dns: string) => {
		setShown(dns);
		localStorage.setItem(SHOWN, dns);
	};

	const load = useCallback(async () => {
		setLoading(true);
		try {
			const r = await api.fleet.$get();
			const body = (await r.json()) as { machines?: FleetMachine[]; error?: string };
			if (!r.ok || !body.machines) throw new Error(body.error ?? r.statusText);
			setMachines(body.machines);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		if (open) void load();
	}, [open, load]);

	// Forget shells the server no longer has (it restarted, or they exited).
	useEffect(() => {
		void (async () => {
			const r = await api.terminals.$get({ query: { fleet: "1" } }).catch(() => null);
			const body = r?.ok ? ((await r.json()) as { terminals?: { id: string; running: boolean }[] }) : null;
			const live = new Set((body?.terminals ?? []).filter((t) => t.running).map((t) => t.id));
			saveShells((s) => Object.fromEntries(Object.entries(s).filter(([, id]) => live.has(id))));
			setReady(true);
		})();
	}, [saveShells]);

	const openShell = async (m: FleetMachine) => {
		setError(null);
		if (!shells[m.dns]) {
			const r = await api.terminals.$post({ json: { fleet: true, ssh: m.self ? undefined : m.ssh } });
			const body = (await r.json().catch(() => ({}))) as { id?: string; error?: string };
			if (!r.ok || !body.id) return setError(body.error ?? t("could not start a shell ({status})", { status: r.status }));
			const id = body.id;
			saveShells((s) => ({ ...s, [m.dns]: id }));
		}
		show(m.dns);
	};

	const forget = useCallback(
		(dns: string) => saveShells((s) => Object.fromEntries(Object.entries(s).filter(([k]) => k !== dns))),
		[saveShells],
	);
	const closeShell = (dns: string, id: string) => {
		void api.terminals[":id"].$delete({ param: { id } });
		forget(dns);
	};

	const shellId = ready ? shells[shown] : undefined;
	const shownName = machines?.find((m) => m.dns === shown)?.name ?? shown;

	return (
		<section aria-label={t("Fleet")} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-neutral-950 text-neutral-100">
			<PanelHeader title={t("Fleet")} onClose={onClose}>
				<IconButton size="sm" label={t("Refresh")} onClick={() => void load()}>
					<ArrowClockwise size={14} />
				</IconButton>
				{loading && <span className="text-meta text-neutral-500">{t("Checking machines…")}</span>}
			</PanelHeader>
			<ScrollPane className="max-h-1/2 shrink-0">
				{error && <p className="px-4 py-2 text-meta text-red-400">{error}</p>}
				{machines && (
					<ul>
						{machines.map((m) => (
							<Row
								key={m.dns}
								m={m}
								shown={!!shellId && m.dns === shown}
								onTerminal={() => void openShell(m)}
								onStarted={() => void load()}
							/>
						))}
					</ul>
				)}
			</ScrollPane>
			{shellId ? (
				<div
					className="flex min-h-0 flex-1 flex-col"
					// Escape belongs to the shell (vim, less), not the page dialog:
					// a cancelled keydown fires no close request on the <dialog>.
					onKeyDown={(e) => {
						if (e.key === "Escape") e.preventDefault();
					}}
				>
					<PanelHeader title={shownName} onClose={() => closeShell(shown, shellId)} closeLabel={t("Close this shell")} />
					<div className="min-h-0 flex-1">
						<Terminal key={shellId} id={shellId} focused onExit={() => forget(shown)} />
					</div>
				</div>
			) : (
				<p className="flex flex-1 items-center justify-center text-meta text-neutral-500">
					{t("A machine's terminal button opens a shell on it here.")}
				</p>
			)}
		</section>
	);
}
