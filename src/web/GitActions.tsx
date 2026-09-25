import { useEffect, useRef, useState } from "react";
import { CaretDown, Check, GitBranch, Sparkle } from "@phosphor-icons/react";
import { readGitAutoName, writeGitAutoName } from "./prefs.js";

/** What `GET /api/git` answers with. See src/server/git.ts. */
interface GitState {
	repo: boolean;
	branch: string;
	changed: number;
	ahead: number;
	behind: number;
	upstream: string;
	remote: string;
	gh: boolean;
	/** A starting point for the commit message: the changed file list. */
	suggestion: string;
}

interface GitResult {
	ok: boolean;
	steps: Array<{ step: string; output: string }>;
	error?: string;
	url?: string;
}



/**
 * The actions, as compositions of the four steps the server runs in order.
 *
 * One table rather than seven endpoints: every combination anybody asks for
 * is a subset of branch → commit → push → PR, and naming them here keeps the
 * menu and the request in one place. `needsBranch`/`needsMessage` are what
 * the dialog asks for; nothing else varies.
 */
const ACTIONS = [
	{ label: "Commit & Push", branch: false, commit: true, push: true, pr: false },
	{ label: "Commit", branch: false, commit: true, push: false, pr: false },
	{ label: "Push", branch: false, commit: false, push: true, pr: false },
	{ label: "Create Branch & Commit", branch: true, commit: true, push: false, pr: false },
	{ label: "Create Branch, Commit & Push", branch: true, commit: true, push: true, pr: false },
	{ label: "Create Branch", branch: true, commit: false, push: false, pr: false },
	{ label: "Commit & Create PR", branch: false, commit: true, push: true, pr: true },
	{ label: "Create PR", branch: false, commit: false, push: false, pr: true },
] as const;

type Action = (typeof ACTIONS)[number];

/** `pwi/2026-09-17-1432`: sortable, obviously machine-made, never colliding. */
function suggestBranch(): string {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `pwi/${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/**
 * Commit, push, branch and PR for the project on screen.
 *
 * A split button: the primary action on the left, the rest behind the chevron
 * — the shape this has in every editor, because "commit and push" is what you
 * want nine times out of ten and the other seven combinations are worth
 * exactly one click each, not seven buttons.
 *
 * The state (branch, how many files changed, whether there is an upstream) is
 * re-read on every open rather than polled: the tree changes constantly while
 * an agent is working, and a count that is thirty seconds stale is worse than
 * one fetched when you looked.
 *
 * Auto-naming is the other half of the button. The dialog exists to ask two
 * questions — the commit message and the branch name — and both have machine
 * answers: a model that reads the diff, and a dated `pwi/` branch. With the
 * toggle on, the dialog stops appearing and `Commit & Push` is one click.
 */
export function GitActions({
	cwd,
	onDone,
}: {
	cwd: string;
	onDone?: () => void;
}) {
	const [state, setState] = useState<GitState | null>(null);
	const [menuOpen, setMenuOpen] = useState(false);
	const [pending, setPending] = useState<Action | null>(null);
	const [message, setMessage] = useState("");
	const [branch, setBranch] = useState("");
	const [running, setRunning] = useState(false);
	const [result, setResult] = useState<GitResult | null>(null);
	/** Toggle in the menu: name commits with the model and skip the dialog. */
	const [autoName, setAutoName] = useState(readGitAutoName);
	const [naming, setNaming] = useState(false);
	const [nameError, setNameError] = useState<string | null>(null);
	const root = useRef<HTMLDivElement | null>(null);

	const refresh = async () => {
		const r = await fetch(`/api/git?cwd=${encodeURIComponent(cwd)}`);
		if (!r.ok) return;
		setState((await r.json()) as GitState);
	};

	useEffect(() => {
		setState(null);
		setResult(null);
		void refresh();
		// Only on a project switch: everything else re-reads on open, and
		// polling a repo whose tree an agent is rewriting would be a fetch per
		// interval forever for a number nobody is looking at.
	}, [cwd]);

	// A menu that outlives a click elsewhere is a menu you have to dismiss
	// twice. Pointerdown, not click: it has to close before whatever was
	// clicked reacts.
	useEffect(() => {
		if (!menuOpen) return;
		const onDown = (e: PointerEvent) => {
			if (!root.current?.contains(e.target as Node)) setMenuOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setMenuOpen(false);
		};
		window.addEventListener("pointerdown", onDown);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("pointerdown", onDown);
			window.removeEventListener("keydown", onKey);
		};
	}, [menuOpen]);

	/**
	 * Ask the model for a subject line. Null on failure, with the reason left
	 * in `nameError` for the dialog to show: a name that could not be written
	 * is never a reason to commit nothing, only a reason to type one.
	 */
	const requestName = async (): Promise<string | null> => {
		setNaming(true);
		setNameError(null);
		try {
			const r = await fetch(`/api/git/name`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ cwd }),
			});
			const body = (await r.json().catch(() => ({}))) as { message?: string; error?: string };
			if (!r.ok || !body.message) {
				setNameError(body.error ?? "could not name this commit");
				return null;
			}
			return body.message;
		} catch (err) {
			setNameError(err instanceof Error ? err.message : String(err));
			return null;
		} finally {
			setNaming(false);
		}
	};

	const start = async (action: Action) => {
		setMenuOpen(false);
		setResult(null);
		setNameError(null);
		await refresh();
		/*
		 * An action that needs nothing from the user runs on the click. Only a
		 * commit message or a branch name opens the dialog, because those are
		 * the two things this host cannot invent correctly — and a confirmation
		 * step for `Push` would be a dialog whose only content is a button.
		 */
		if (!action.commit && !action.branch) {
			void execute(action, {});
			return;
		}
		const newBranch = action.branch ? suggestBranch() : "";
		setMessage("");
		setBranch(newBranch);
		/*
		 * Auto-name on: this host CAN invent both answers, so it does, and the
		 * dialog only appears when the model could not be reached — at which
		 * point it is the fallback rather than the flow.
		 */
		if (autoName) {
			const message = action.commit ? await requestName() : "";
			if (message !== null) {
				void execute(action, { message, branch: newBranch });
				return;
			}
		}
		setPending(action);
	};

	const execute = async (action: Action, fields: { message?: string; branch?: string }) => {
		setRunning(true);
		const r = await fetch(`/api/git`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				cwd,
				branch: action.branch ? fields.branch : undefined,
				message: action.commit ? fields.message : undefined,
				push: action.push,
				pr: action.pr,
			}),
		});
		const body = (await r.json().catch(() => ({}))) as GitResult & { error?: string };
		setRunning(false);
		setPending(null);
		setResult(body.ok === undefined ? { ok: false, steps: [], error: body.error } : body);
		await refresh();
		onDone?.();
	};

	// Not a repository: the button would have nothing to act on, and an
	// explanation of why it is disabled is noise in a chat window.
	if (!state?.repo) return null;

	const dirty = state.changed > 0;
	const primary = ACTIONS[0];

	return (
		<div ref={root} className="relative flex items-center gap-1.5">
			<div className="flex items-stretch overflow-hidden rounded-full border border-neutral-700 bg-neutral-900 text-meta">
				<button
					onClick={() => void start(primary)}
					disabled={running || naming}
					title={
						`${dirty ? `${state.changed} changed file${state.changed === 1 ? "" : "s"}` : "Nothing to commit"} on ${state.branch}` +
						(autoName ? " · auto-named, no dialog" : "")
					}
					className="flex items-center gap-1.5 px-3 py-1 text-neutral-200 transition-colors duration-150 ease-out hover:bg-neutral-800 disabled:text-neutral-500 motion-reduce:transition-none"
				>
					{autoName ? <Sparkle size={13} /> : <GitBranch size={13} />}
					{naming ? "Naming…" : running ? "Working…" : primary.label}
					{/* The count is the one number that decides whether to click. */}
					{dirty && <span className="text-neutral-500">{state.changed}</span>}
				</button>
				<button
					onClick={() => setMenuOpen((o) => !o)}
					aria-label="More git actions"
					aria-expanded={menuOpen}
					className="flex items-center border-l border-neutral-700 px-1.5 text-neutral-400 transition-colors duration-150 ease-out hover:bg-neutral-800 hover:text-neutral-100 motion-reduce:transition-none"
				>
					<CaretDown size={12} />
				</button>
			</div>
			{menuOpen && (
				// Right-anchored: the button sits at the right edge of the status
				// row, and a left-anchored menu ran off the window there.
				<div className="absolute right-0 bottom-full z-20 mb-1 w-60 overflow-hidden rounded-md border border-neutral-700 bg-neutral-900 py-1 shadow-xl">
					{/*
					 * Where a push would go, at the top of the menu that pushes.
					 *
					 * This used to sit permanently beside the button, which is a remote
					 * URL you read once and then look past forever. It is context for a
					 * decision, so it belongs where the decision is made — and it is
					 * the branch that matters as much as the host.
					 */}
					<p className="truncate px-3 pt-0.5 pb-1.5 text-meta text-neutral-500">
						<span className="text-neutral-400">{state.branch}</span>
						{state.remote ? ` → ${state.upstream || `${state.remote} (new)`}` : " · no remote"}
					</p>
					<div className="mb-1 border-t border-neutral-800" />
					{ACTIONS.map((action) => {
						// A PR needs `gh`; a push needs somewhere to push to. Shown
						// disabled rather than hidden, so the menu does not change
						// shape between repositories.
						const blocked =
							(action.pr && !state.gh) || (action.push && !state.remote && !action.branch);
						return (
							<button
								key={action.label}
								onClick={() => void start(action)}
								disabled={blocked}
								title={
									blocked
										? action.pr
											? "`gh` is not installed"
											: "This repository has no remote"
										: undefined
								}
								className="block w-full px-3 py-1.5 text-left text-ui text-neutral-200 transition-colors duration-150 ease-out hover:bg-neutral-800 disabled:text-neutral-600 disabled:hover:bg-transparent motion-reduce:transition-none"
							>
								{action.label}
							</button>
						);
					})}
					{/*
					 * The toggle lives with the actions it changes rather than in
					 * the settings dialog, and the menu stays open when it is
					 * flipped: the point of clicking it is to see it change.
					 */}
					<div className="my-1 border-t border-neutral-800" />
					<button
						onClick={() => {
							const next = !autoName;
							setAutoName(next);
							writeGitAutoName(next);
						}}
						role="menuitemcheckbox"
						aria-checked={autoName}
						title="Write the commit message with a model that reads the diff, and stop asking"
						className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-ui text-neutral-300 transition-colors duration-150 ease-out hover:bg-neutral-800 motion-reduce:transition-none"
					>
						<span className="flex w-3.5 shrink-0 justify-center text-neutral-400">
							{autoName && <Check size={12} weight="bold" />}
						</span>
						Auto-name commits
					</button>
				</div>
			)}

			{/*
			 * Only FAILURE gets a line, plus a PR's URL because that is a thing you
			 * click rather than a notification.
			 *
			 * A success message here was permanent clutter for information the
			 * button already carries: the changed-file count drops to nothing and
			 * the tree is clean. Announcing that a thing you clicked did what it
			 * says is noise you learn to look past — and it sat next to the
			 * composer, where it competed with the thing you were typing.
			 */}
			{result && !result.ok && (
				<button
					onClick={() => setResult(null)}
					title={result.error}
					className="max-w-60 truncate rounded-full px-2 py-1 text-meta text-red-400 hover:text-red-300"
				>
					{result.error ?? "Failed"}
				</button>
			)}
			{result?.ok && result.url && (
				<a
					href={result.url}
					target="_blank"
					rel="noreferrer"
					className="max-w-60 truncate rounded-full px-2 py-1 text-meta text-neutral-400 hover:text-neutral-200"
				>
					Pull request ↗
				</a>
			)}

			{pending && (
				<GitDialog
					action={pending}
					state={state}
					message={message}
					branch={branch}
					running={running}
					naming={naming}
					nameError={nameError}
					onAutoName={async () => {
						const named = await requestName();
						if (named) setMessage(named);
					}}
					onMessage={setMessage}
					onBranch={setBranch}
					onCancel={() => setPending(null)}
					// The box shows the suggestion as a PLACEHOLDER, so leaving it
					// untouched has to mean "use it" rather than "commit nothing".
					onRun={() => void execute(pending, { message: message.trim() || state.suggestion, branch })}
				/>
			)}
		</div>
	);
}

/**
 * The two things this host will not decide for you SILENTLY: the commit
 * message and the branch name.
 *
 * The message box is prefilled with the changed file list because that costs
 * nothing and always works; `Auto-name` replaces it with a sentence a model
 * wrote after reading the diff, which costs a few seconds and a few tokens
 * and is therefore a button rather than the default — until the menu toggle
 * says otherwise, at which point this dialog does not open at all.
 */
function GitDialog({
	action,
	state,
	message,
	branch,
	running,
	naming,
	nameError,
	onAutoName,
	onMessage,
	onBranch,
	onCancel,
	onRun,
}: {
	action: Action;
	state: GitState;
	message: string;
	branch: string;
	running: boolean;
	/** A name is being written right now: the model call is in flight. */
	naming: boolean;
	/** Why the last naming attempt failed, if it did. */
	nameError: string | null;
	onAutoName: () => void;
	onMessage: (value: string) => void;
	onBranch: (value: string) => void;
	onCancel: () => void;
	onRun: () => void;
}) {
	const field = useRef<HTMLTextAreaElement | null>(null);
	useEffect(() => field.current?.focus(), []);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onCancel();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onCancel]);

	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label={action.label}
			onClick={onCancel}
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
		>
			<form
				onClick={(e) => e.stopPropagation()}
				onSubmit={(e) => {
					e.preventDefault();
					onRun();
				}}
				className="w-full max-w-lg rounded-md border border-neutral-700 bg-neutral-900 p-4"
			>
				<div className="mb-3 flex items-baseline justify-between gap-2">
					<h2 className="text-title font-semibold text-neutral-100">{action.label}</h2>
					<span className="truncate font-mono text-meta text-neutral-500">
						{state.branch}
						{state.changed > 0 ? ` · ${state.changed} changed` : ""}
					</span>
				</div>

				{action.branch && (
					<label className="mb-3 block">
						<span className="mb-1 block text-meta text-neutral-400">New branch</span>
						<input
							value={branch}
							onChange={(e) => onBranch(e.target.value)}
							spellCheck={false}
							className="w-full rounded-sm border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-ui text-neutral-100 outline-none focus:border-neutral-600"
						/>
					</label>
				)}

				{action.commit && (
					<label className="block">
						<span className="mb-1 block text-meta text-neutral-400">Commit message</span>
						<textarea
							ref={field}
							value={message}
							onChange={(e) => onMessage(e.target.value)}
							// Room for a subject and a short body: an auto-named message
							// has both, and three rows hides the half that explains why.
							rows={10}
							placeholder={state.suggestion || "What changed"}
							// Enter submits, as it does in the composer; a message that
							// needs a second paragraph gets Shift+Enter.
							onKeyDown={(e) => {
								if (e.key === "Enter" && !e.shiftKey) {
									e.preventDefault();
									onRun();
								}
							}}
							className="w-full resize-none rounded-sm border border-neutral-800 bg-neutral-950 px-3 py-2 text-ui text-neutral-100 outline-none focus:border-neutral-600 placeholder:text-neutral-600"
						/>
					</label>
				)}

				{/* The reason the model could not be asked, where the asking was
				    done — a pill behind the dialog would be invisible. */}
				{nameError && <p className="mt-2 text-meta text-red-400">{nameError}</p>}

				<div className="mt-4 flex items-center justify-end gap-2">
					{/* `mr-auto`: an action ON the message belongs beside the box it
					    fills, not next to the button that commits it. */}
					{action.commit && (
						<button
							type="button"
							onClick={onAutoName}
							disabled={naming || running}
							title="Write the message with a model that reads the diff"
							className="mr-auto flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-ui text-neutral-400 transition-colors duration-150 ease-out hover:bg-neutral-800 hover:text-neutral-100 disabled:text-neutral-600 disabled:hover:bg-transparent motion-reduce:transition-none"
						>
							<Sparkle size={13} />
							{naming ? "Naming…" : "Auto-name"}
						</button>
					)}
					<button
						type="button"
						onClick={onCancel}
						className="rounded-sm px-3 py-1.5 text-ui text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
					>
						Cancel
					</button>
					<button
						type="submit"
						disabled={running || naming || (action.commit && !message.trim() && !state.suggestion)}
						className="rounded-sm bg-neutral-100 px-4 py-1.5 text-ui font-medium text-neutral-900 transition-colors duration-150 ease-out hover:bg-neutral-200 disabled:bg-neutral-700 disabled:text-neutral-400 motion-reduce:transition-none"
					>
						{running ? "Working…" : action.label}
					</button>
				</div>
			</form>
		</div>
	);
}
