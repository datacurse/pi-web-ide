/**
 * SourceControl.tsx — the source-control panel, in the shape every editor's is.
 *
 * Two halves, because they answer two different questions. The TOP is "what
 * have I changed and what do I call it": the working tree's files, a commit
 * message, and the one button that moves the work off this machine. The
 * BOTTOM is "what happened before": recent commits, collapsed, each opening
 * to the files it touched.
 *
 * Neither half renders a diff. It used to — the old Changes panel stacked
 * every file's merge view in a 300px column — and that was both the least
 * readable width available and a response carrying two copies of every
 * changed file to draw a list of names. Clicking a row opens a diff TAB
 * instead (`onOpenDiff`), in the editor column you last used, where a diff
 * has the width to be read.
 *
 * The commit row is deliberately not a second GitActions: that button lives
 * in the chat's status row and owns the eight-way branch/PR menu. This is the
 * one-click path — message, name it, send it — and everything it does goes
 * through the same two endpoints.
 */

import { useCallback, useEffect, useState } from "react";
import {
	ArrowsClockwise,
	CaretDown,
	CaretRight,
	GitCommit,
	Sparkle,
	X,
} from "@phosphor-icons/react";
import { FileGlyph } from "./fileIcon.js";
import { GIT_CHANGED, busyLabel, gitChanged, setGitBusy, useGitBusy } from "./GitActions.js";
import { readGitAutoName, writeGitAutoName } from "./prefs.js";
import { Button, IconButton, inputClass } from "./ui.js";

async function getJson<T>(url: string): Promise<T> {
	const r = await fetch(url);
	if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? `${r.status}`);
	return (await r.json()) as T;
}

/** `/home/me/proj/src/web/App.tsx` → `src/web/App.tsx` when it is under `cwd`. */
function shortPath(path: string, cwd: string): string {
	return cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
}

/** Mirrors GitChange in src/server/git.ts. */
interface Change {
	path: string;
	status: string;
}

/** Mirrors GitCommit in src/server/git.ts. */
interface Commit {
	hash: string;
	subject: string;
	author: string;
	when: string;
	files: Change[];
}

/** Mirrors the GET /api/git answer. */
interface GitState {
	repo: boolean;
	branch: string;
	changed: number;
	ahead: number;
	behind: number;
	upstream: string;
	remote: string;
	gh: boolean;
	suggestion: string;
}

/**
 * The letter in the right margin, as git means it.
 *
 * Colour and not words: the list is one line per file at 300px, and "modified"
 * spelled out is the thing that truncates the filename. Same letters git's own
 * porcelain uses, so there is nothing new to learn.
 */
function StatusMark({ status }: { status: string }) {
	const code = status.trim() || "M";
	const letter = code === "??" ? "U" : code[0];
	/*
	 * Only the four tokens the theme actually re-points. `blue-400` is mapped
	 * (to the flavor's blue) and `green-400`/`red-400` are the same pair the
	 * diff gutters use, so a rename here is the same blue as a link and an add
	 * is the same green as an added line.
	 */
	const tone =
		letter === "A" || letter === "U"
			? "text-green-400"
			: letter === "D"
				? "text-red-400"
				: letter === "R"
					? "text-blue-400"
					: "text-amber-400";
	return <span className={`shrink-0 font-mono text-meta ${tone}`}>{letter}</span>;
}

/** One file row, in either half. The whole row is the button. */
function FileRow({
	change,
	cwd,
	depth,
	onOpen,
}: {
	change: Change;
	cwd: string;
	/** Indent, in rem. Commit children sit under their commit. */
	depth: number;
	onOpen: () => void;
}) {
	const short = shortPath(change.path, cwd);
	const name = short.split("/").pop() ?? short;
	const dir = short.slice(0, short.length - name.length).replace(/\/$/, "");
	return (
		<button
			onClick={onOpen}
			title={`${short} — open diff`}
			style={{ paddingLeft: `${0.75 + depth}rem` }}
			className="flex w-full items-center gap-1.5 py-1 pr-3 text-left text-meta text-neutral-300 hover:bg-neutral-800/70"
		>
			<FileGlyph name={name} size={13} />
			<span className="truncate">{name}</span>
			{/* The directory is context, not identity: dimmed, and the first
			    thing to be given up when the panel is narrow. */}
			{dir && <span className="min-w-0 truncate text-neutral-500">{dir}</span>}
			<span className="ml-auto flex shrink-0 items-center pl-1">
				<StatusMark status={change.status} />
			</span>
		</button>
	);
}

/**
 * The source-control panel.
 *
 * Both lists are re-read on `revision` — App bumps it whenever the agent's
 * hunks change — rather than polled: the tree changes constantly while an
 * agent works, and a poll would be a request per interval forever for a list
 * nobody is looking at.
 */
export function SourceControl({
	cwd,
	revision,
	onClose,
	onOpenDiff,
	onChanges,
}: {
	cwd: string;
	/** Changes when something may have touched the tree; re-reads both lists. */
	revision: unknown;
	onClose: () => void;
	/** Show this file's diff in a tab. `ref` is "" for the working tree. */
	onOpenDiff: (ref: string, path: string) => void;
	/** Uncommitted file count after each re-read, so the rail badge follows a sync. */
	onChanges: (count: number) => void;
}) {
	const [state, setState] = useState<GitState | null>(null);
	const [files, setFiles] = useState<Change[] | null>(null);
	const [commits, setCommits] = useState<Commit[]>([]);
	const [message, setMessage] = useState("");
	const [open, setOpen] = useState<Record<string, boolean>>({});
	const [autoName, setAutoName] = useState(readGitAutoName);
	const [naming, setNaming] = useState(false);
	const busyNow = useGitBusy(cwd);
	const running = busyNow !== null;
	const [error, setError] = useState<string | null>(null);

	const reload = useCallback(async () => {
		try {
			const [git, changes, log] = await Promise.all([
				getJson<GitState>(`/api/git?cwd=${encodeURIComponent(cwd)}`),
				getJson<{ files: Change[] }>(`/api/git/changes?cwd=${encodeURIComponent(cwd)}`),
				getJson<{ commits: Commit[] }>(`/api/git/log?cwd=${encodeURIComponent(cwd)}`),
			]);
			setState(git);
			setFiles(changes.files);
			onChanges(changes.files.length);
			setCommits(log.commits);
			setError(null);
		} catch (err) {
			setFiles([]);
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [cwd, onChanges]);

	useEffect(() => {
		void reload();
	}, [reload, revision]);

	useEffect(() => {
		const on = (e: Event) => {
			if ((e as CustomEvent<string>).detail === cwd) void reload();
		};
		window.addEventListener(GIT_CHANGED, on);
		return () => window.removeEventListener(GIT_CHANGED, on);
	}, [cwd, reload]);

	/**
	 * Ask the model for a subject line, and put it in the box.
	 *
	 * Into the box rather than straight into a commit: a name you cannot read
	 * before it is written is a name you find out about in the log.
	 */
	const requestName = async (): Promise<string | null> => {
		setNaming(true);
		setGitBusy(cwd, "Naming…");
		setError(null);
		try {
			const r = await fetch(`/api/git/name`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ cwd }),
			});
			const body = (await r.json().catch(() => ({}))) as { message?: string; error?: string };
			if (!r.ok || !body.message) {
				setError(body.error ?? "could not name this commit");
				return null;
			}
			setMessage(body.message);
			return body.message;
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			return null;
		} finally {
			setNaming(false);
			setGitBusy(cwd, null);
		}
	};

	/**
	 * The one button: commit what is changed and push it, or — with nothing
	 * changed — just push what is already committed.
	 *
	 * Both are "get this off my machine", which is why they are one control
	 * whose label says which one it is about to do. The branch and PR
	 * combinations stay in the chat's GitActions menu; putting eight of them
	 * in a sidebar is how a panel becomes a git client.
	 */
	const sync = async () => {
		if (!state) return;
		const dirty = state.changed > 0;
		let text = message.trim();
		if (dirty && !text && autoName) {
			const named = await requestName();
			if (!named) return;
			text = named;
		}
		setGitBusy(cwd, busyLabel({ commit: dirty, push: true }));
		setError(null);
		try {
			const r = await fetch(`/api/git`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				// The suggestion is the fallback, as it is in the dialog: an
				// untouched box means "use it", never "commit nothing".
				body: JSON.stringify({
					cwd,
					message: dirty ? text || state.suggestion : undefined,
					push: true,
				}),
			});
			const body = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
			if (!body.ok) setError(body.error ?? "failed");
			else setMessage("");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setGitBusy(cwd, null);
			gitChanged(cwd);
		}
	};

	if (state && !state.repo) {
		return (
			<div className="flex min-h-0 min-w-0 flex-1 flex-col bg-neutral-950">
				<Header onClose={onClose} branch="" />
				<p className="p-4 text-ui text-neutral-500">
					Not a git repository. `git init` in a terminal and this fills in.
				</p>
			</div>
		);
	}

	const dirty = (state?.changed ?? 0) > 0;
	const ahead = state?.ahead ?? 0;
	const behind = state?.behind ?? 0;

	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col bg-neutral-950">
			<Header onClose={onClose} branch={state?.branch ?? ""} />

			{/* TOP HALF: the working tree, and what to call it. */}
			<div className="flex min-h-0 shrink-0 flex-col border-b border-neutral-800">
				<div className="flex items-start gap-1.5 p-2">
					<textarea
						value={message}
						onChange={(e) => setMessage(e.target.value)}
						rows={2}
						placeholder={state?.suggestion || "Message (Ctrl+Enter to commit)"}
						onKeyDown={(e) => {
							if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
								e.preventDefault();
								void sync();
							}
						}}
						className={`min-w-0 flex-1 resize-none ${inputClass.sm}`}
					/>
					<button
						onClick={() => void requestName()}
						disabled={naming || running || !dirty}
						title="Write the message with a model that reads the diff"
						aria-label="Auto-name this commit"
						className="shrink-0 rounded-sm p-1.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 disabled:text-neutral-600 disabled:hover:bg-transparent"
					>
						<Sparkle size={14} className={naming ? "animate-pulse" : undefined} />
					</button>
				</div>

				<Button
					variant="primary"
					size="sm"
					className="mx-2 mb-2"
					onClick={() => void sync()}
					disabled={running || naming || (!dirty && ahead === 0 && behind === 0)}
					title={
						dirty
							? `Commit ${state?.changed} file${state?.changed === 1 ? "" : "s"} and push`
							: "Push what is already committed"
					}
					/*
					 * The app's primary button, not a blue one: `amber-500` under
					 * `neutral-950` text is what Chat.tsx's confirm buttons already
					 * use, and VS Code's blue here would be the one control in the
					 * window ignoring the active theme.
					 */
				>
					<ArrowsClockwise size={13} className={running ? "animate-spin" : undefined} />
					{busyNow ?? (dirty ? `Commit & Push ${state?.changed}` : "Sync Changes")}
					{/* What a sync would actually move, the way git counts it. */}
					{!dirty && (ahead > 0 || behind > 0) && (
						// Dimmed against the button's OWN ground rather than given a
						// palette color: nothing else in the app sits on amber, so there
						// is no themed token that is correct here.
						<span className="opacity-70">
							{ahead > 0 && `${ahead}↑`}
							{behind > 0 && ` ${behind}↓`}
						</span>
					)}
				</Button>

				{/* Auto-name is shared with GitActions' menu: one preference, so
				    flipping it in either place changes both. */}
				<label className="flex cursor-pointer items-center gap-2 px-3 pb-2 text-meta text-neutral-500 hover:text-neutral-300">
					<input
						type="checkbox"
						checked={autoName}
						onChange={(e) => {
							setAutoName(e.target.checked);
							writeGitAutoName(e.target.checked);
						}}
						// The accent every other checkbox in the app uses (Settings.tsx).
						className="size-3.5 accent-amber-400"
					/>
					Auto-name commits
				</label>
			</div>

			{error && (
				<div className="border-b border-red-900 bg-red-950/40 px-3 py-2 text-meta text-red-300">
					{error}
				</div>
			)}

			{/* Two scrollers, not one: scanning fifty commits used to push the
			    changed files off the top, and they are the half you act on. Equal
			    halves (flex-1 basis-0) so neither list can starve the other. */}
			<div className="min-h-0 flex-1 basis-0 overflow-auto">
				<p className="sticky top-0 z-10 bg-neutral-950 px-3 py-1.5 text-caption font-semibold tracking-wide text-neutral-400 uppercase">
					Changes{dirty && <span className="ml-1 text-neutral-500">{state?.changed}</span>}
				</p>
				{files === null ? (
					<p className="px-3 py-2 text-meta text-neutral-500">Reading the working tree…</p>
				) : files.length === 0 ? (
					<p className="px-3 py-2 text-meta text-neutral-500">
						Nothing changed. Uncommitted edits — the agent's or your own — show up here.
					</p>
				) : (
					files.map((f) => (
						<FileRow
							key={f.path}
							change={f}
							cwd={cwd}
							depth={0}
							onOpen={() => onOpenDiff("", f.path)}
						/>
					))
				)}

			</div>

			{/* BOTTOM HALF: history. Collapsed, because a commit is a row you
			    scan and only sometimes open. */}
			<div className="min-h-0 flex-1 basis-0 overflow-auto border-t border-neutral-800">
				<p className="sticky top-0 z-10 bg-neutral-950 px-3 py-1.5 text-caption font-semibold tracking-wide text-neutral-400 uppercase">
					Commits
				</p>
				{commits.map((c) => {
					const expanded = open[c.hash] === true;
					return (
						<div key={c.hash}>
							<button
								onClick={() => setOpen((o) => ({ ...o, [c.hash]: !expanded }))}
								aria-expanded={expanded}
								title={`${c.subject}\n${c.author} · ${c.when} · ${c.hash.slice(0, 7)}`}
								className="flex w-full items-center gap-1 py-1 pr-3 pl-1 text-left text-meta text-neutral-300 hover:bg-neutral-800/70"
							>
								<span className="shrink-0 text-neutral-600">
									{expanded ? <CaretDown size={11} /> : <CaretRight size={11} />}
								</span>
								<GitCommit size={13} className="shrink-0 text-neutral-600" />
								<span className="truncate">{c.subject}</span>
								{/*
								 * "3 hours ago" on all fifty rows is the same three words
								 * repeated down a 300px column, which crowds out the subject
								 * — the only part that differs. Dropping "ago" keeps the
								 * ordering legible at a glance; the full stamp, the author and
								 * the sha are in the tooltip.
								 */}
								<span className="ml-auto shrink-0 pl-2 text-caption text-neutral-600">
									{c.when.replace(/ ago$/, "")}
								</span>
							</button>
							{expanded &&
								c.files.map((f) => (
									<FileRow
										key={f.path}
										change={f}
										cwd={cwd}
										depth={1}
										onOpen={() => onOpenDiff(c.hash, f.path)}
									/>
								))}
						</div>
					);
				})}
			</div>
		</div>
	);
}

/** The panel's title row. Its own component only because two returns use it. */
function Header({ branch, onClose }: { branch: string; onClose: () => void }) {
	return (
		<div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2">
			<span className="text-ui text-neutral-300">Source Control</span>
			{/* The branch is a LABEL, not an action: same dim mono the rest of the
			    app uses for paths, rather than the accent, which in this window
			    means "working" and would read as a live session. */}
			{branch && (
				<span
					title={`On branch ${branch}`}
					className="min-w-0 truncate font-mono text-meta text-neutral-500"
				>
					{branch}
				</span>
			)}
			<IconButton
				size="sm"
				className="ml-auto"
				onClick={onClose}
				label="Close source control"
			>
				<X size={16} />
			</IconButton>
		</div>
	);
}
