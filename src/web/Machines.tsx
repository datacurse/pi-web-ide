import { X } from "@phosphor-icons/react";
import type { PiwHostStatus } from "../shared/types.js";

/**
 * How a host's dot is coloured, and what each colour actually claims.
 *
 * The distinction that matters is between "our ssh child is alive" and "a piw
 * answered through it": the first proves nothing about the machine at the
 * other end, so only the second is green. Amber is specifically the state
 * worth telling apart — the forward is up and the remote piw is not running,
 * which is a fix on that machine, not here. A direct host has no forward to
 * be half-up, so it is green or red.
 */
function dot(host: PiwHostStatus): { className: string; label: string } {
	if (host.reachable) return { className: "bg-emerald-400", label: "piw is answering" };
	if (host.tunnel === "direct") return { className: "bg-red-400", label: "no piw answering" };
	if (host.tunnel === "running") {
		return { className: "bg-amber-400", label: "tunnel up, no piw answering" };
	}
	if (host.tunnel === "backoff") {
		return { className: "bg-red-400", label: host.error ?? "tunnel down, retrying" };
	}
	return { className: "bg-neutral-600", label: "not reachable (tunnel not managed by piw)" };
}

/**
 * A machine whose piw or omp is not the version this page's piw has. One
 * line, both names, so the fix is obvious from the tooltip: the fleet is
 * meant to be on one version, and `omp update` on one box without a piw
 * restart is exactly how it stops being.
 */
function skew(
	host: PiwHostStatus,
	local: { piw?: string; omp?: string },
): string | undefined {
	const lines: string[] = [];
	if (host.piwVersion && local.piw && host.piwVersion !== local.piw) {
		lines.push(`piw ${host.piwVersion} here, ${local.piw} on this machine`);
	}
	if (host.ompVersion && local.omp && host.ompVersion !== local.omp) {
		lines.push(`omp ${host.ompVersion} here, ${local.omp} on this machine`);
	}
	return lines.length ? lines.join("\n") : undefined;
}

/**
 * The machine list: one row per other host running its own piw.
 *
 * Clicking a row selects that machine — its piw's own startup directory
 * lands in the project picker, and from then on the session list, the
 * shells and the chat are talking to that piw at its own origin. No new
 * window, no proxy: each machine is served by its own piw with its own
 * credentials, its own projects and its own agent processes, and this page
 * merely knows where each one answers.
 */
export function Machines({
	hosts,
	selected,
	localVersions,
	onAdd,
	onRemove,
	onSelect,
}: {
	hosts: PiwHostStatus[];
	/** The machine the project picker is on; "" for this one. */
	selected: string;
	localVersions: { piw?: string; omp?: string };
	/** An ssh destination or an http(s) origin; the server tells them apart. */
	onAdd: (value: string) => void;
	onRemove: (name: string) => void;
	onSelect: (name: string) => void;
}) {
	return (
		<div className="border-t border-neutral-800 px-1.5 py-1">
			<div className="flex items-center justify-between px-1">
				<span className="text-[10px] uppercase tracking-wide text-neutral-500">
					Machines
				</span>
				<button
					onClick={() => {
						// A text prompt for the same reason project-adding uses one: the
						// browser cannot read ~/.ssh/config, and the server validates
						// what it is handed.
						const value = prompt(
							"Machine: an ssh destination (alias, or user@host), or the origin its piw answers at (https://host.tail.ts.net):",
						);
						if (value?.trim()) onAdd(value.trim());
					}}
					title="Add a machine by ssh destination or piw origin"
					className="rounded px-1.5 text-xs text-neutral-400 transition-colors duration-150 ease-out hover:bg-neutral-800 hover:text-neutral-200 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-neutral-400 motion-reduce:transition-none"
				>
					+
				</button>
			</div>
			{hosts.map((host) => {
				const { className, label } = dot(host);
				const drift = skew(host, localVersions);
				const where = "ssh" in host ? `${host.ssh} → ${host.url}` : host.url;
				return (
					<div key={host.name} className="group flex items-center gap-1">
						<button
							onClick={() => onSelect(host.name)}
							aria-pressed={host.name === selected}
							title={`${where}${host.remoteCwd ? ` · ${host.remoteCwd}` : ""} · ${label}${
								drift ? `\n${drift}` : ""
							}`}
							className={`flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1 text-left text-xs transition-colors duration-150 ease-out hover:bg-neutral-900 hover:text-neutral-100 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-neutral-400 motion-reduce:transition-none ${
								host.name === selected ? "bg-neutral-900 text-neutral-100" : "text-neutral-300"
							}`}
						>
							<span className={`size-1.5 shrink-0 rounded-full ${className}`} />
							<span className="truncate">{host.name}</span>
							{drift && (
								<span
									aria-label="Version differs from this machine"
									className="shrink-0 text-[10px] text-amber-400"
								>
									{"\u2260"}
								</span>
							)}
							<span className="ml-auto shrink-0 text-[10px] text-neutral-500">
								{"ssh" in host ? `:${host.port}` : "direct"}
							</span>
						</button>
						<button
							onClick={() => onRemove(host.name)}
							aria-label={`Remove ${host.name}`}
							title="Remove machine"
							className="shrink-0 rounded px-1 text-xs text-neutral-600 opacity-0 transition-opacity duration-150 ease-out hover:text-neutral-200 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-neutral-400 group-hover:opacity-100 motion-reduce:transition-none"
						>
							<X size={13} />
						</button>
					</div>
				);
			})}
		</div>
	);
}
