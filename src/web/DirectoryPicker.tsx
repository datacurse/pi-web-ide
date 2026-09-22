import { useCallback, useEffect, useRef, useState } from "react";
import { Star, X } from "@phosphor-icons/react";
import type { PiwDirListing } from "../shared/types.js";

/**
 * The project directory picker: a folder explorer over the SERVER's
 * filesystem.
 *
 * It exists because the browser's own file picker cannot help here. A project
 * is a cwd on the machine running piw, and `<input type="file" webkitdirectory>`
 * would offer the directories of whatever machine the browser is on — which is
 * the wrong filesystem the moment the page is opened through an ssh forward,
 * and even on one machine it hands back file lists rather than a path. So the
 * listing comes from `GET /api/browse` and this component is the explorer for
 * it: breadcrumb, up, click-to-enter, and a path field for people who already
 * know where they are going.
 *
 * Clicking a row ENTERS it; adding is always the explicit footer button on the
 * directory currently listed. One rule, no double-click, and the thing you are
 * about to add is the thing named in the breadcrumb above it.
 *
 * The path field does double duty. A complete path navigates; a path that is
 * the listed directory plus a partial name FILTERS the rows, because that is
 * what typing into a path bar means to anyone who has used a shell — and
 * `~/code` here holds 90 directories, where scrolling to `trans` is the whole
 * cost of the picker. Filtering is local: the listing is already in memory,
 * so the rows narrow on the keystroke rather than on a round trip.
 */
export function DirectoryPicker({
	open,
	start,
	projects,
	onPick,
	onClose,
}: {
	open: boolean;
	/** Where to open: normally the active project, so navigation starts nearby. */
	start: string;
	/** Already-added projects, marked in the list so they are not added twice. */
	projects: string[];
	onPick: (path: string) => void;
	onClose: () => void;
}) {
	const ref = useRef<HTMLDialogElement>(null);
	const [listing, setListing] = useState<PiwDirListing | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	/** The path field, which is free text until it is submitted. */
	const [draft, setDraft] = useState("");
	/** Pinned directories, from the server: these are ITS filesystem's paths. */
	const [favorites, setFavorites] = useState<string[]>([]);

	/*
	 * Only the newest navigation may write state. Clicking three folders
	 * quickly is normal and the responses can land out of order; without this
	 * the list would settle on whichever request the server finished last.
	 */
	const seq = useRef(0);

	const go = useCallback(async (path: string) => {
		const ticket = ++seq.current;
		setBusy(true);
		const r = await fetch(`/api/browse?path=${encodeURIComponent(path)}`).catch(
			() => null,
		);
		const body = (await r?.json().catch(() => null)) as
			(PiwDirListing & { error?: string }) | null;
		if (ticket !== seq.current) return;
		setBusy(false);
		if (!r?.ok || !body?.entries) {
			// Staying put on failure is the point: an unreadable directory must
			// not blank the list you were successfully browsing a moment ago.
			setError(body?.error ?? "could not read that directory");
			return;
		}
		setError(null);
		setListing(body);
		setDraft(body.path);
	}, []);

	// showModal() is imperative — the `open` ATTRIBUTE renders a non-modal
	// dialog, which is a different (and here, wrong) thing.
	useEffect(() => {
		const dialog = ref.current;
		if (!dialog) return;
		if (open && !dialog.open) dialog.showModal();
		else if (!open && dialog.open) dialog.close();
	}, [open]);

	// Re-read on every open rather than caching: directories are created
	// outside piw constantly, and a stale listing is a list of folders that
	// may no longer be there.
	useEffect(() => {
		if (!open) return;
		void go(start);
	}, [open, start, go]);

	// Favourites are read on open for the same reason the listing is: they can
	// be pinned from another window, and a pinned directory can be deleted.
	useEffect(() => {
		if (!open) return;
		void (async () => {
			const r = await fetch(`/api/favorites`).catch(() => null);
			if (!r?.ok) return;
			const body = (await r.json().catch(() => null)) as { favorites?: string[] } | null;
			setFavorites(body?.favorites ?? []);
		})();
	}, [open]);

	/**
	 * Pin or unpin the directory being listed. One button, because "this
	 * folder is a shortcut" is a single piece of state and a separate unpin
	 * control would sit disabled most of the time.
	 */
	const togglePin = useCallback(async (path: string, pinned: boolean) => {
		const r = await fetch(`/api/favorites`, {
			method: pinned ? "DELETE" : "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path }),
		}).catch(() => null);
		const body = (await r?.json().catch(() => null)) as {
			favorites?: string[];
			error?: string;
		} | null;
		if (!r?.ok) {
			setError(body?.error ?? "could not change the pinned folders");
			return;
		}
		setError(null);
		setFavorites(body?.favorites ?? []);
	}, []);

	/*
	 * Breadcrumb segments, each with the absolute path it stands for. Built
	 * from the SERVER's answer, so it always describes a path that resolved —
	 * never the half-typed text in the field.
	 */
	const crumbs: { label: string; path: string }[] = [{ label: "/", path: "/" }];
	if (listing) {
		let acc = "";
		for (const part of listing.path.split("/").filter(Boolean)) {
			acc += `/${part}`;
			crumbs.push({ label: part, path: acc });
		}
	}

	const current = listing?.path ?? "";
	const already = current !== "" && projects.includes(current);
	const pinned = current !== "" && favorites.includes(current);

	/*
	 * The filter fragment: what the field holds BEYOND the directory being
	 * listed. `/home/loki/code/tra` while listing `/home/loki/code` filters to
	 * names matching `tra`; anything containing another `/` is a path being
	 * typed, not a name being filtered, and is left to navigation.
	 *
	 * Derived from the field rather than kept as its own state, so there is
	 * exactly one thing to clear: navigating rewrites the field, which empties
	 * the fragment by construction.
	 */
	const prefix = current === "/" ? "/" : `${current}/`;
	const fragment =
		current && draft.startsWith(prefix) && !draft.slice(prefix.length).includes("/")
			? draft.slice(prefix.length)
			: "";
	// Case-insensitive and anywhere in the name: `db` should find `ftp-db`,
	// which a prefix match would hide.
	const entries = (listing?.entries ?? []).filter(
		(e) => !fragment || e.name.toLowerCase().includes(fragment.toLowerCase()),
	);
	/*
	 * What Enter does while filtering: take the exact name if it exists, else
	 * the first row shown. Submitting the typed text instead would 400 on a
	 * partial name, which is the one thing the filter exists to make cheap.
	 */
	const submitTarget = fragment
		? (entries.find((e) => e.name === fragment) ?? entries[0])?.path
		: undefined;

	return (
		<dialog
			ref={ref}
			aria-labelledby="picker-title"
			onClose={onClose}
			// Clicking the backdrop targets the dialog itself; a click anywhere
			// on its contents targets a descendant.
			onClick={(e) => {
				if (e.target === ref.current) onClose();
			}}
			/*
			 * `hidden open:flex`, not a bare `flex`: a <dialog> is hidden by the UA
			 * rule `dialog:not([open]) { display: none }`, and ANY author
			 * `display` beats a UA stylesheet regardless of specificity — so a
			 * plain `flex` here leaves the closed dialog painted on the page,
			 * minus its backdrop. The column layout is what makes the entry list
			 * the only part that scrolls, so it has to be conditional instead.
			 */
			className="m-auto hidden h-[min(34rem,88vh)] w-[min(34rem,92vw)] flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950 p-0 text-neutral-100 shadow-2xl backdrop:bg-black/60 open:flex"
		>
			<div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
				<h2 id="picker-title" className="text-sm font-semibold tracking-tight">
					Add project
				</h2>
				<button
					onClick={onClose}
					aria-label="Close directory picker"
					className="size-8 rounded text-neutral-300 transition-colors duration-150 ease-out hover:bg-neutral-800 hover:text-neutral-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-neutral-400 motion-reduce:transition-none"
				>
					<X size={13} />
				</button>
			</div>

			{/*
			  The path field is a real form: Enter submits, which is what anyone
			  who pastes a path expects, and it doubles as both the "I know where I
			  am going" escape hatch and the filter over the rows below.
			*/}
			<form
				onSubmit={(e) => {
					e.preventDefault();
					void go(submitTarget ?? draft);
				}}
				className="flex items-center gap-1 border-b border-neutral-800 px-2 py-1.5"
			>
				<button
					type="button"
					onClick={() => void go(listing?.home ?? "~")}
					title="Home directory"
					className="shrink-0 rounded bg-neutral-800 px-2 py-1 text-xs transition-colors duration-150 ease-out hover:bg-neutral-700 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-neutral-400 motion-reduce:transition-none"
				>
					{/* "~" rather than a house glyph: this row is a path field, the
					    server expands it, and no font is missing it. */}
					<span aria-hidden>~</span>
				</button>
				<button
					type="button"
					onClick={() => listing?.parent && void go(listing.parent)}
					// Disabled only at the filesystem root, where the server
					// reports no parent — not while a request is in flight, since
					// that would make the button flicker under a fast clicker.
					disabled={!listing?.parent}
					title="Parent directory"
					aria-label="Parent directory"
					className="shrink-0 rounded bg-neutral-800 px-2 py-1 text-xs transition-colors duration-150 ease-out hover:bg-neutral-700 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-neutral-400 disabled:opacity-40 disabled:hover:bg-neutral-800 motion-reduce:transition-none"
				>
					<span aria-hidden>{"\u2191"}</span>
				</button>
				<button
					type="button"
					onClick={() => current && void togglePin(current, pinned)}
					disabled={!current}
					title={pinned ? "Unpin this folder" : "Pin this folder"}
					aria-label={pinned ? "Unpin this folder" : "Pin this folder"}
					aria-pressed={pinned}
					className={`shrink-0 rounded bg-neutral-800 px-2 py-1.5 transition-colors duration-150 ease-out hover:bg-neutral-700 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-neutral-400 disabled:opacity-40 disabled:hover:bg-neutral-800 motion-reduce:transition-none ${
						pinned ? "text-amber-400" : "text-neutral-400"
					}`}
				>
					<Star size={13} weight={pinned ? "fill" : "regular"} />
				</button>
				<input
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					spellCheck={false}
					autoComplete="off"
					aria-label="Directory path"
					placeholder="/absolute/path, ~/path, or type to filter"
					className="min-w-0 flex-1 rounded border border-neutral-800 bg-neutral-900 px-2 py-1 font-mono text-xs text-neutral-200 outline-none focus-visible:border-neutral-600"
				/>
				<button
					type="submit"
					title="Go to this path"
					className="shrink-0 rounded bg-neutral-800 px-2 py-1 text-xs transition-colors duration-150 ease-out hover:bg-neutral-700 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-neutral-400 motion-reduce:transition-none"
				>
					Go
				</button>
			</form>

			{/* Breadcrumb: the only place that says what "Add this folder" will
			    add, so it wraps rather than truncates. */}
			<div className="flex flex-wrap items-center gap-0.5 border-b border-neutral-800 px-2 py-1 text-xs">
				{crumbs.map((c, i) => (
					<span key={c.path} className="flex items-center gap-0.5">
						{/* From the second real segment on: the root crumb IS the
						    separator, so `i > 0` would print "/ / home". */}
						{i > 1 && <span className="text-neutral-600">/</span>}
						<button
							onClick={() => void go(c.path)}
							className="rounded px-1 py-0.5 text-neutral-400 transition-colors duration-150 ease-out hover:bg-neutral-800 hover:text-neutral-100 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-neutral-400 motion-reduce:transition-none"
						>
							{c.label}
						</button>
					</span>
				))}
			</div>

			{/*
			  Pinned folders: the shortcut row. `~/code` is where 90 projects
			  live, and clicking through `/home/loki` to reach it every time is
			  the cost this removes. Rendered only when there are any — an empty
			  strip would be a row of chrome explaining itself.
			*/}
			{favorites.length > 0 && (
				<div className="flex flex-wrap items-center gap-1 border-b border-neutral-800 px-2 py-1.5">
					{favorites.map((path) => (
						<span
							key={path}
							className="group flex items-center rounded bg-neutral-900 text-xs"
						>
							<button
								onClick={() => void go(path)}
								title={path}
								className={`max-w-40 truncate rounded-l px-1.5 py-0.5 transition-colors duration-150 ease-out hover:bg-neutral-800 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-neutral-400 motion-reduce:transition-none ${
									path === current ? "text-amber-400" : "text-neutral-300"
								}`}
							>
								{path.split("/").filter(Boolean).pop() || path}
							</button>
							<button
								onClick={() => void togglePin(path, true)}
								aria-label={`Unpin ${path}`}
								title="Unpin"
								className="rounded-r px-1 py-0.5 text-neutral-600 transition-colors duration-150 ease-out hover:bg-neutral-800 hover:text-neutral-200 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-neutral-400 motion-reduce:transition-none"
							>
								<X size={9} />
							</button>
						</span>
					))}
				</div>
			)}

			{/* min-h-0 so this scrolls instead of stretching the dialog past the
			    viewport and stranding the footer. */}
			<div className="min-h-0 flex-1 overflow-y-auto">
				{listing && entries.length === 0 && (
					<p className="px-3 py-4 text-xs text-neutral-400">
						{fragment
							? `Nothing here matches “${fragment}”.`
							: "No subdirectories here. Add this folder, or go up."}
					</p>
				)}
				{entries.map((e) => (
					<button
						key={e.path}
						onClick={() => void go(e.path)}
						title={e.path}
						className="flex w-full items-center gap-2 border-b border-neutral-900 px-3 py-1.5 text-left text-xs transition-colors duration-150 ease-out hover:bg-neutral-900 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-neutral-400 motion-reduce:transition-none"
					>
						{/* A triangle, not a folder pictograph: U+1F5C1 is absent from
						    the fonts this chrome actually gets and renders as tofu. It
						    reads as "opens into", which is what clicking a row does. */}
						<span
							aria-hidden
							className={e.hidden ? "text-neutral-600" : "text-neutral-500"}
						>
							{"\u25b8"}
						</span>
						<span
							className={`truncate ${e.hidden ? "text-neutral-500" : "text-neutral-200"}`}
						>
							{e.name}
						</span>
						{/* A checkout is what you are almost always looking for, so it
						    is the one thing a row says beyond its name. */}
						{e.repo && (
							<span
								title="Git repository"
								className="shrink-0 rounded bg-neutral-800 px-1 text-[10px] text-amber-400/90"
							>
								git
							</span>
						)}
						{projects.includes(e.path) && (
							<span className="ml-auto shrink-0 text-[10px] text-neutral-500">added</span>
						)}
					</button>
				))}
			</div>

			<div className="flex items-center gap-2 border-t border-neutral-800 px-2 py-2">
				<button
					onClick={() => current && onPick(current)}
					// Adding an already-listed project is a no-op on the server, so
					// the button says so instead of pretending to work.
					disabled={!current || already || busy}
					className="rounded bg-neutral-800 px-2 py-1 text-xs transition-colors duration-150 ease-out hover:bg-neutral-700 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-neutral-400 disabled:opacity-50 disabled:hover:bg-neutral-800 motion-reduce:transition-none"
				>
					{already ? "Already added" : "Add this folder"}
				</button>
				<span className="min-w-0 flex-1 truncate font-mono text-[10px] text-neutral-500">
					{error ? <span className="text-red-400">{error}</span> : current}
				</span>
			</div>
		</dialog>
	);
}
