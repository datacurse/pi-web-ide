import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChatCircle, CircleNotch, MagnifyingGlass, X } from "@phosphor-icons/react";
import type { PiSessionHit, PiSessionInfo } from "../shared/types.js";
import { sessionLabel } from "./sessionName.js";
import { timeAgo } from "./SessionList.js";
import { IconButton } from "./ui.js";

const RECENT = 50;

/** Wrap every occurrence of any term in a bold mark. */
function highlight(text: string, terms: string[]): ReactNode {
	if (!terms.length) return text;
	const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
	// split with a capture group puts the matches at the odd indexes.
	return text.split(re).map((part, i) =>
		i % 2 ? (
			<mark key={i} className="bg-transparent font-semibold text-neutral-100">
				{part}
			</mark>
		) : (
			part
		),
	);
}

/**
 * Ctrl+O popup: full-text search over the open project's sessions. With no
 * query it lists the most recently active ones, so it doubles as a switcher.
 */
export function SessionSearch({
	open,
	project,
	sessions,
	shortNames,
	onSelect,
	onClose,
}: {
	open: boolean;
	project: string;
	sessions: PiSessionInfo[];
	shortNames: boolean;
	onSelect: (s: PiSessionInfo) => void;
	onClose: () => void;
}) {
	const ref = useRef<HTMLDialogElement>(null);
	const list = useRef<HTMLDivElement>(null);
	const [query, setQuery] = useState("");
	/** The last answered query and its hits. Kept on screen until the next answer lands, so typing never flashes an empty list. */
	const [result, setResult] = useState<{ query: string; hits: PiSessionHit[] }>({ query: "", hits: [] });
	const [error, setError] = useState<string | null>(null);
	const [active, setActive] = useState(0);
	/** Only the newest query may write results; responses can land out of order. */
	const seq = useRef(0);

	useEffect(() => {
		const dialog = ref.current;
		if (!dialog) return;
		if (open && !dialog.open) {
			setQuery("");
			setResult({ query: "", hits: [] });
			setActive(0);
			dialog.showModal();
		} else if (!open && dialog.open) dialog.close();
	}, [open]);

	useEffect(() => {
		const q = query.trim();
		const ticket = ++seq.current;
		if (!q) {
			setResult({ query: "", hits: [] });
			setError(null);
			return;
		}
		const timer = setTimeout(async () => {
			const r = await fetch(
				`/api/sessions/search?cwd=${encodeURIComponent(project)}&q=${encodeURIComponent(q)}`,
			).catch(() => null);
			const body = (await r?.json().catch(() => null)) as { hits?: PiSessionHit[]; error?: string } | null;
			if (ticket !== seq.current) return;
			if (!r?.ok || !body?.hits) {
				setError(body?.error ?? "Search failed");
				return;
			}
			setError(null);
			setResult({ query: q, hits: body.hits });
			setActive(0);
		}, 150);
		return () => clearTimeout(timer);
	}, [query, project]);

	const pending = query.trim() !== result.query && !error;
	const terms = result.query.split(/\s+/).filter(Boolean);
	const rows: PiSessionHit[] = terms.length
		? result.hits
		: [...sessions]
				.sort((a, b) => b.lastActive.localeCompare(a.lastActive))
				.slice(0, RECENT)
				.map((session) => ({ session, snippet: "" }));

	useEffect(() => {
		list.current?.children[active]?.scrollIntoView({ block: "nearest" });
	}, [active]);

	const pick = (s: PiSessionInfo) => {
		onSelect(s);
		onClose();
	};

	return (
		<dialog
			ref={ref}
			aria-label="Search sessions"
			onClose={onClose}
			onClick={(e) => {
				if (e.target === ref.current) onClose();
			}}
			// `hidden open:flex`: see DirectoryPicker — a bare `flex` would paint the closed dialog.
			className="mx-auto mt-[12vh] hidden max-h-[76vh] w-[min(44rem,92vw)] flex-col overflow-hidden rounded-md border border-neutral-800 bg-neutral-950 p-0 text-neutral-100 shadow-2xl backdrop:bg-black/50 backdrop:backdrop-blur-sm open:flex"
		>
			<div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2">
				{pending ? (
					<CircleNotch size={18} className="shrink-0 animate-spin text-neutral-500" aria-label="Searching" />
				) : (
					<MagnifyingGlass size={18} className="shrink-0 text-neutral-500" />
				)}
				<input
					data-custom="search field"
					autoFocus
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "ArrowDown" || e.key === "ArrowUp") {
							e.preventDefault();
							const step = e.key === "ArrowDown" ? 1 : -1;
							setActive((a) => Math.min(Math.max(a + step, 0), Math.max(rows.length - 1, 0)));
						} else if (e.key === "Enter" && rows[active]) {
							e.preventDefault();
							pick(rows[active].session);
						}
					}}
					placeholder="Search sessions in this project…"
					aria-label="Search sessions"
					className="min-w-0 flex-1 bg-transparent text-title text-neutral-100 outline-none placeholder:text-neutral-500"
				/>
				<IconButton onClick={onClose} label="Close search">
					<X size={13} />
				</IconButton>
			</div>

			<div ref={list} role="listbox" aria-label="Sessions" className="min-h-0 flex-1 overflow-y-auto p-1.5">
				{error ? (
					<p className="px-3 py-4 text-ui text-red-400" role="alert">
						{error}
					</p>
				) : (
					rows.length === 0 && (
						<p className="px-3 py-4 text-ui text-neutral-400">
							{terms.length ? "No sessions match." : "No sessions yet."}
						</p>
					)
				)}
				{rows.map(({ session: s, snippet }, i) => (
					<button
						data-custom="search result"
						key={s.path}
						role="option"
						aria-selected={i === active}
						onMouseMove={() => setActive(i)}
						onClick={() => pick(s)}
						title={s.name || s.firstMessage || s.path}
						className={`flex w-full min-w-0 items-center gap-3 rounded-sm px-3 py-2 text-left ${
							i === active ? "bg-neutral-800" : ""
						}`}
					>
						<ChatCircle size={18} className="shrink-0 text-neutral-500" />
						<span className="max-w-[60%] shrink-0 truncate text-body text-neutral-200">
							{highlight(sessionLabel(s, shortNames), terms)}
						</span>
						<span className="min-w-0 flex-1 truncate text-ui text-neutral-500">
							{snippet && highlight(snippet, terms)}
						</span>
						<span className="shrink-0 text-ui text-neutral-500">{timeAgo(s.lastActive)}</span>
					</button>
				))}
			</div>
		</dialog>
	);
}
