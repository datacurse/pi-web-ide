import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X } from "@phosphor-icons/react";
import type {
	AskAnswer,
	PiAsk,
	PiEvent,
	PiImage,
	PiPartial,
	PiSessionInfo,
	Snapshot,
} from "../shared/types.js";
import { SessionList, type Projects } from "./SessionList.js";
import { ActivityBar } from "./ActivityBar.js";
import { SessionTabs, tabDomId } from "./SessionTabs.js";
import { Chat } from "./Chat.js";
import { TerminalPane } from "./Terminal.js";
import { Review } from "./Review.js";
import { Explorer } from "./Explorer.js";
import { FileEditor } from "./FileEditor.js";
import { fileTab, isFileTab, moveTab, tabPath } from "./tabs.js";
import { EMPTY_LAYOUT, reconcile, type TermLayout } from "./termLayout.js";
import { Settings } from "./Settings.js";
import { Packages } from "./Packages.js";
import {
	applyTheme,
	readNotify,
	readSessionSort,
	readShortNames,
	readShowThinking,
	readTerminalLayout,
	readTerminalOpen,
	readTerminalWidth,
	readTheme,
	readToolMode,
	TERMINAL_MAX_PERCENT,
	TERMINAL_MIN_PERCENT,
	writeNotify,
	writeSessionSort,
	writeShortNames,
	writeShowThinking,
	writeTerminalLayout,
	writeTerminalOpen,
	writeTerminalWidth,
	writeToolMode,
	type SessionSort,
	type ThemeId,
	type ToolMode,
} from "./prefs.js";
import { pulseFavicon } from "./favicon.js";

const emptyPartial = (): PiPartial => ({ text: "", thinking: "", tools: [] });

/**
 * What a panel shows when the thing it needs is missing.
 *
 * The rail's buttons stay enabled in that case on purpose: a button that does
 * nothing when pressed reads as broken, while a panel saying "pick a project
 * first" is an answer. It carries the same header and close button as a real
 * panel so the column does not visibly change shape.
 */
function PanelEmpty({
	title,
	onClose,
	children,
}: {
	title: string;
	onClose: () => void;
	children: React.ReactNode;
}) {
	return (
		<section
			aria-label={title}
			className="flex min-h-0 min-w-0 flex-1 flex-col bg-neutral-950"
		>
			<div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2">
				<span className="text-sm text-neutral-300">{title}</span>
				<button
					onClick={onClose}
					aria-label={`Close ${title.toLowerCase()}`}
					className="ml-auto rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
				>
					<X size={16} />
				</button>
			</div>
			<p className="p-4 text-sm text-neutral-500">{children}</p>
		</section>
	);
}

/**
 * The panel column's share of the panel+chat row, kept inside the bounds
 * prefs.ts advertises — a pane narrower than the minimum is one the divider
 * cannot be grabbed back from.
 */
const clampPanel = (percent: number): number =>
	Math.min(TERMINAL_MAX_PERCENT, Math.max(TERMINAL_MIN_PERCENT, percent));

/**
 * The side panels, which are mutually exclusive: one column, one divider,
 * and the rail switches between them the way an activity bar does.
 */
export type Panel = "editor" | "review" | "terminal" | "packages" | null;

/**
 * The server's JSON, made safe to render.
 *
 * An open browser tab holds whatever bundle it loaded for as long as it
 * stays open, and the server process outlives that bundle or predates it —
 * a long-running server still answering a freshly built client is the normal
 * state of this app during development. A field added on one side therefore
 * arrives absent on the other, and every consumer downstream trusts the
 * `Snapshot` type: one missing number becomes `undefined.toLocaleString()`
 * inside render, React unmounts the tree, and the whole app goes blank over
 * a tooltip.
 *
 * So the JSON is coerced exactly once, here, at the only place it enters
 * React state. Downstream code keeps reading non-optional fields, and a
 * skewed server costs the feature it is missing — no meter, no thinking
 * picker — instead of the window.
 */
function toSnapshot(raw: Partial<Snapshot>): Snapshot {
	return {
		...raw,
		id: String(raw.id),
		file: typeof raw.file === "string" ? raw.file : undefined,
		// An older server sends none, and the git button simply does not appear.
		cwd: typeof raw.cwd === "string" ? raw.cwd : "",
		model: typeof raw.model === "string" ? raw.model : undefined,
		messages: Array.isArray(raw.messages) ? raw.messages : [],
		partial: raw.partial ?? null,
		isStreaming: raw.isStreaming === true,
		error: typeof raw.error === "string" ? raw.error : null,
		notices: Array.isArray(raw.notices) ? raw.notices : [],
		ask: raw.ask ?? null,
		// An older server sends none, and the review pane simply stays empty.
		hunks: Array.isArray(raw.hunks) ? raw.hunks : [],
		// An older server sends none, and the picker simply has nothing to offer.
		commands: Array.isArray(raw.commands) ? raw.commands : [],
		// Absent means an older server that has no opinion; assume support
		// rather than silently disabling attachments the backend would accept.
		supportsImages: raw.supportsImages !== false,
		thinkingLevel: typeof raw.thinkingLevel === "string" ? raw.thinkingLevel : undefined,
		thinkingLevels: Array.isArray(raw.thinkingLevels) ? raw.thinkingLevels : [],
		contextTokens: typeof raw.contextTokens === "number" ? raw.contextTokens : 0,
		contextWindow: typeof raw.contextWindow === "number" ? raw.contextWindow : 0,
		stale: raw.stale === true,
	};
}

/**
 * What a "finished" notification says: the opening line of the answer that
 * just landed, which is the part worth reading from a desktop corner. A run
 * that ended in tool calls and no prose has nothing to quote, so it falls
 * back to saying so rather than showing an empty notification.
 */
function replyLine(snapshot: Snapshot | undefined): string {
	const message = [...(snapshot?.messages ?? [])]
		.reverse()
		.find((m) => m.role === "assistant");
	let text = "";
	for (const block of message?.blocks ?? []) {
		if (block.kind === "text") text = block.text;
	}
	const line =
		text
			.trim()
			.split("\n")
			.find((l) => l.trim()) ?? "";
	if (!line) return "Finished.";
	return line.length > 140 ? `${line.slice(0, 140)}…` : line;
}

/**
 * What a "needs you" notification says. The question itself, because that is
 * the one thing that decides whether it is worth walking back to: the agent
 * is blocked until it is answered.
 */
function askLine(ask: PiAsk): string {
	const line = (ask.message || ask.title || "pi is waiting for an answer").trim();
	return line.length > 140 ? `${line.slice(0, 140)}…` : line;
}

/** The chat panel the tab strip controls; `aria-controls` needs a real id. */
const CHAT_PANEL_ID = "chat-panel";

/*
 * Open tabs are remembered across reloads under `pwi:tabs:<project cwd>`.
 *
 * One key per project rather than one map of every project: the strip only
 * ever shows one project's sessions, so a per-project key is read and written
 * whole, and switching projects cannot corrupt the other project's entry.
 *
 * A tab is identified by its session FILE. The file is the stable identity on
 * disk, is exactly what /api/sessions/open takes, and survives a server
 * restart or an idle eviction that invalidates the in-memory id — so a
 * restored tab reopens through the same path a click would take.
 *
 * localStorage rather than the URL: this is per-browser UI state, not a
 * shareable address, and pwi has no router.
 */

/**
 * The selected project — a cwd — remembered in TWO places on purpose.
 *
 * `sessionStorage` is the selection of THIS window: it is scoped to the tab,
 * survives a reload, an HMR refresh and a session restore, and — crucially —
 * is invisible to every other window. `localStorage` holds the same value as
 * "the project last worked on anywhere", which is what a brand-new window
 * should open on.
 *
 * One localStorage key for both jobs was a bug: two windows on two projects
 * share it, so the second selection overwrote the first, and the next reload
 * of EITHER window silently adopted the other's project — taking its tab
 * strip with it, and pointing `+ New` at a directory nobody had selected.
 */
const PROJECT_KEY = "pwi:project";
const LAST_PROJECT_KEY = "pwi:lastProject";

/**
 * A stored project. A build that managed remote machines wrote `{host,cwd}`
 * here; only the cwd survives, and a remote one resolves to nothing
 * remembered rather than throwing during the first render.
 */
function parseSelection(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	if (!raw.startsWith("{")) return raw;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && "cwd" in parsed && typeof parsed.cwd === "string") {
			const host = "host" in parsed && typeof parsed.host === "string" ? parsed.host : "";
			return host ? undefined : parsed.cwd;
		}
	} catch {
		/* fall through */
	}
	return undefined;
}

/**
 * How long a local slash command may claim to be running before the row stops
 * saying so. A command that answers nothing (`/model`, `/thinking`) emits no
 * `command_output`, so nothing else would ever stop the spinner, and
 * `/compact` on a full context legitimately takes minutes. The command itself
 * stays on screen either way — it is the record of what was sent.
 */
const COMMAND_RUNNING_MAX_MS = 120_000;

function readStored(key: string): string | undefined {
	try {
		return localStorage.getItem(key) ?? undefined;
	} catch {
		// Private mode / disabled storage must not break the app.
		return undefined;
	}
}

function writeStored(key: string, value: string | undefined): void {
	try {
		if (value) localStorage.setItem(key, value);
		else localStorage.removeItem(key);
	} catch {
		/* ignore */
	}
}

/**
 * This window's own selection. The read falls back to the shared key, so a
 * brand-new window still opens where you last worked; the write is
 * sessionStorage ONLY, because the shared key must keep meaning "the last
 * project someone explicitly selected" — a window merely restoring itself is
 * not a selection.
 */
function readWindowProject(): string | undefined {
	try {
		return parseSelection(sessionStorage.getItem(PROJECT_KEY) ?? readStored(LAST_PROJECT_KEY));
	} catch {
		// Private mode / disabled storage: the shared key may still be readable,
		// and a window with no scope of its own is the pre-fix behaviour, which
		// is correct for a single window.
		return parseSelection(readStored(LAST_PROJECT_KEY));
	}
}

function pinWindowProject(cwd: string): void {
	try {
		sessionStorage.setItem(PROJECT_KEY, cwd);
	} catch {
		/* ignore */
	}
}

/**
 * The open tabs of ONE project.
 *
 * `project` is part of the state rather than tracked alongside it, because the
 * dangerous bug here is writing one project's tabs under another project's
 * key: with the project inside the value, every read and write is consistent
 * by construction and a stale render cannot mix them.
 *
 * An entry is a session file, except for a session the server has not
 * persisted yet, where it is the session id (Snapshot.file is legitimately
 * optional). Such a key cannot be reopened, so it is placeholder-only: it is
 * upgraded to the file as soon as the server reports one, and a persisted one
 * is dropped on restore like any other session that is not on disk.
 */
interface Tabs {
	/** The selection's storage scope (scopeOf), not a bare cwd. */
	project: string;
	files: string[];
	active?: string;
}

function readTabs(project: string): Tabs {
	const raw = readStored(`pwi:tabs:${project}`);
	if (!raw) return { project, files: [] };
	try {
		const parsed = JSON.parse(raw) as { files?: unknown; active?: unknown };
		// Storage is user-writable and outlives any format change, so anything
		// unexpected degrades to "no tabs" instead of throwing during render.
		const files = Array.isArray(parsed.files)
			? [...new Set(parsed.files.filter((f): f is string => typeof f === "string"))]
			: [];
		const active =
			typeof parsed.active === "string" && files.includes(parsed.active)
				? parsed.active
				: files[0];
		return { project, files, active };
	} catch {
		return { project, files: [] };
	}
}

export default function App() {
	const [sessions, setSessions] = useState<PiSessionInfo[]>([]);
	/**
	 * The project whose session list we have actually SEEN, successfully. It
	 * gates dropping remembered tabs: absence from a list we never received is
	 * not evidence of absence, and pruning on a failed or restarting-server
	 * fetch would wipe the whole strip on a transient error.
	 */
	const [listedProject, setListedProject] = useState("");
	/** Why the last session listing failed, shown in place of an empty list. */
	const [listError, setListError] = useState<string | null>(null);
	const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
	/**
	 * Whether the pane is waiting for a session to open.
	 *
	 * `busy` is "the agent is working"; this is "there is not even a
	 * transcript yet", which is a different thing to show and a different
	 * thing to end.
	 */
	const [opening, setOpening] = useState(false);
	/**
	 * The snapshot read synchronously, because attach() has to decide whether
	 * it is switching sessions or reattaching to the one on screen — and a
	 * dependency on `snapshot` would rebuild the callback (and with it the
	 * EventSource wiring) on every streamed delta.
	 */
	const snapshotRef = useRef<Snapshot | null>(null);
	snapshotRef.current = snapshot;
	const [partial, setPartial] = useState<PiPartial>(emptyPartial);
	const [busy, setBusy] = useState(false);
	/**
	 * The local slash command last sent, and whether it is still working.
	 *
	 * pi appends no message for a local command, so nothing in the transcript
	 * records that it was sent at all; and the prompt ack is acceptance, not
	 * completion — an extension command is acked at once and whatever it has
	 * to say arrives later as a notification, with nothing streaming between.
	 */
	const [command, setCommand] = useState<{ text: string; running: boolean } | null>(null);
	const [modelError, setModelError] = useState<string | null>(null);
	const [listOpen, setListOpen] = useState(false);
	/**
	 * Which side panel is showing, if any — one value, because they are
	 * mutually exclusive the way VS Code's activity bar is: one column, one
	 * divider, and clicking the lit icon closes it.
	 *
	 * A single value rather than a boolean each is what makes "two panels open
	 * at once" unreachable instead of merely avoided by remembering to reset
	 * the other three.
	 *
	 * Only the terminal's openness is persisted, and only because its shells
	 * outlive the page; the rest are views over things that reload in a fetch.
	 */
	const [panel, setPanel] = useState<Panel>(() => (readTerminalOpen() ? "terminal" : null));
	/** True once the server's terminal list has been folded in; see below. */
	const [termsReady, setTermsReady] = useState(false);
	/** One width for the one panel column, whichever panel is in it. */
	const [panelWidth, setPanelWidth] = useState(readTerminalWidth);
	/**
	 * The terminal pane's arrangement for the CURRENT project: its tabs,
	 * splits and their shares. Per project, restored from storage and then
	 * reconciled against the shells the server actually has — see the effect
	 * below and termLayout.ts.
	 */
	const [termLayout, setTermLayout] = useState<TermLayout>(EMPTY_LAYOUT);
	/** The row holding the panel, the chat and the divider between them. */
	const splitRow = useRef<HTMLDivElement | null>(null);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [theme, setTheme] = useState<ThemeId>(readTheme);
	const [showThinking, setShowThinking] = useState(readShowThinking);
	const [toolMode, setToolMode] = useState<ToolMode>(readToolMode);
	const [notify, setNotify] = useState(readNotify);
	const [shortNames, setShortNames] = useState(readShortNames);
	const esRef = useRef<EventSource | null>(null);
	/**
	 * Ticket for the newest attach. An attach whose ticket is no longer the
	 * current one has been superseded by a later selection, and may not move
	 * the selection or the pane; see attach().
	 */
	const attachSeq = useRef(0);
	// attach() reconnects by calling itself; a useCallback cannot reference itself.
	const attachRef = useRef<(file?: string) => Promise<void>>(async () => {});
	/** This pwi's project list: its directories plus the cwd it was launched against. */
	const [projects, setProjects] = useState<Projects>({ projects: [], seed: "" });
	const [project, setProject] = useState<string>(() => readWindowProject() ?? "");
	/** Tabs and the terminal layout are stored per project, keyed by its cwd. */
	const scope = project;
	const [sessionSort, setSessionSort] = useState<SessionSort>(readSessionSort);

	/*
	 * index.html applies the stored theme before the first paint, so this is
	 * not what dresses the app initially — it is the single writer afterwards,
	 * and on mount it also normalises an attribute that storage set to
	 * something no longer recognised.
	 */
	useEffect(() => applyTheme(theme), [theme]);

	const changeShowThinking = useCallback((show: boolean) => {
		setShowThinking(show);
		writeShowThinking(show);
	}, []);

	const changeToolMode = useCallback((mode: ToolMode) => {
		setToolMode(mode);
		writeToolMode(mode);
	}, []);

	const changeShortNames = useCallback((on: boolean) => {
		setShortNames(on);
		writeShortNames(on);
	}, []);

	/**
	 * Turning notifications on is what asks the browser for permission: the
	 * click is the user gesture the prompt requires, and a refused prompt must
	 * not leave a switch that claims to be on and silently does nothing.
	 */
	const changeNotify = useCallback(async (on: boolean) => {
		if (!on) {
			setNotify(false);
			writeNotify(false);
			return;
		}
		if (typeof Notification === "undefined") return;
		const permission =
			Notification.permission === "default"
				? await Notification.requestPermission()
				: Notification.permission;
		const granted = permission === "granted";
		setNotify(granted);
		writeNotify(granted);
	}, []);

	/**
	 * The terminal pane: open/closed, and the divider that sizes it.
	 *
	 * Both preferences are written on change rather than in an effect, so a
	 * pane closed and a window closed in the same second still agree.
	 */
	const showTerminal = useCallback((open: boolean) => {
		setPanel((p) => (open ? "terminal" : p === "terminal" ? null : p));
		writeTerminalOpen(open);
	}, []);

	const closeTerminal = useCallback(() => showTerminal(false), [showTerminal]);

	/**
	 * The rail's one action: show a panel, or close it if it is already the
	 * one showing — the behaviour of every activity bar, and the reason the
	 * state is a single value.
	 *
	 * The terminal's openness is mirrored to storage on every switch, not just
	 * its own button, because switching away from it is also closing it.
	 */
	const selectPanel = useCallback((next: Panel) => {
		setPanel((current) => {
			const resolved = current === next ? null : next;
			writeTerminalOpen(resolved === "terminal");
			return resolved;
		});
	}, []);

	/**
	 * Restore this project's terminal layout, then intersect it with the
	 * shells the server has.
	 *
	 * Both halves are load-bearing. A stored layout can name terminals that
	 * are gone (the server was restarted, or another window closed one), which
	 * would render panes wired to nothing; and the server can have terminals
	 * the layout does not mention (another window opened one), which without
	 * adoption would be unreachable — no pane referencing them, so nothing
	 * able to close them either.
	 *
	 * Runs on project switch, not only on mount: the shells are per project.
	 */
	useEffect(() => {
		setTermsReady(false);
		if (!project) {
			setTermLayout(EMPTY_LAYOUT);
			return;
		}
		setTermLayout(readTerminalLayout(scope));

		let live = true;
		void (async () => {
			const r = await fetch(`/api/terminals?cwd=${encodeURIComponent(project)}`).catch(
				() => null,
			);
			if (!r?.ok || !live) return;
			const body = (await r.json()) as { terminals?: Array<{ id?: unknown }> };
			const ids = (body.terminals ?? [])
				.map((t) => t.id)
				.filter((id): id is string => typeof id === "string");
			setTermLayout((current) => reconcile(current, ids));
			// Gates the pane's "start the first shell" — spawning before the
			// server has been asked would mint a second shell next to the one
			// the stored layout was already pointing at.
			setTermsReady(true);
		})();
		return () => {
			live = false;
		};
	}, [project, scope]);

	/**
	 * Every layout change is written through, so a reload, a crash and a
	 * second window all see the same arrangement. Not debounced: a divider
	 * drag is the only high-frequency source and it is already one write per
	 * pointer event's worth of state, which localStorage handles at a cost
	 * nobody can measure.
	 */
	const changeTermLayout = useCallback(
		(next: TermLayout) => {
			setTermLayout(next);
			if (project) writeTerminalLayout(scope, next);
		},
		[project, scope],
	);

	/** Clamped here, not at the call sites: every path in is a raw number. */
	const resizePanel = useCallback((percent: number) => {
		setPanelWidth(clampPanel(percent));
	}, []);

	/**
	 * Drag the divider.
	 *
	 * The row is measured once, at pointerdown: it cannot change width while
	 * the pointer is down, and measuring per move would be a forced layout on
	 * every frame of the drag. Pointer capture is what keeps the move events
	 * arriving once the cursor is over the terminal's canvas or outside the
	 * window, and it ends the gesture for us if the pointer is cancelled.
	 *
	 * The width is persisted on release, not per move: a drag is one decision,
	 * and writing localStorage a hundred times to record it is waste.
	 */
	const startDrag = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			if (event.button !== 0) return;
			const row = splitRow.current?.getBoundingClientRect();
			if (!row || row.width === 0) return;
			const divider = event.currentTarget;
			divider.setPointerCapture(event.pointerId);
			// Or the browser starts a text selection across both panes instead.
			event.preventDefault();
			let latest = panelWidth;
			const move = (moved: PointerEvent) => {
				// The panel is on the LEFT, so its width grows from the row's left
				// edge. This read `row.right - clientX` when the terminal was the
				// only thing in this track and sat on the right.
				latest = ((moved.clientX - row.left) / row.width) * 100;
				resizePanel(latest);
			};
			const end = () => {
				divider.removeEventListener("pointermove", move);
				divider.removeEventListener("pointerup", end);
				divider.removeEventListener("pointercancel", end);
				writeTerminalWidth(clampPanel(latest));
			};
			divider.addEventListener("pointermove", move);
			divider.addEventListener("pointerup", end);
			divider.addEventListener("pointercancel", end);
		},
		[resizePanel, panelWidth],
	);

	/**
	 * Keyboard resize, because a separator that only responds to a pointer is
	 * one that a keyboard user cannot move at all. Right grows the panel — it
	 * is on the left, so this is the opposite of what it was when the terminal
	 * owned this divider. Home/End go to the advertised bounds.
	 */
	const dividerKeys = useCallback(
		(event: React.KeyboardEvent<HTMLDivElement>) => {
			const step = event.shiftKey ? 10 : 2;
			const next =
				event.key === "ArrowRight"
					? panelWidth + step
					: event.key === "ArrowLeft"
						? panelWidth - step
						: event.key === "Home"
							? TERMINAL_MIN_PERCENT
							: event.key === "End"
								? TERMINAL_MAX_PERCENT
								: undefined;
			if (next === undefined) return;
			event.preventDefault();
			resizePanel(next);
			writeTerminalWidth(clampPanel(next));
		},
		[resizePanel, panelWidth],
	);

	/*
	 * Read through refs inside the SSE handler: `attach` is memoized, and
	 * making it depend on a preference would tear down and rebuild a live
	 * EventSource every time one is toggled.
	 */
	const notifyRef = useRef(notify);
	notifyRef.current = notify;
	const sessionsRef = useRef(sessions);
	sessionsRef.current = sessions;

	/**
	 * Announce a finished run — only when the page is not being watched.
	 *
	 * On screen and focused, the status line and the tab title already said
	 * it, and a notification would be a second copy of news you are looking
	 * at. `tag` is the session, so a session that finishes twice replaces its
	 * own notification instead of stacking.
	 */
	const announce = useCallback((file: string | undefined, body: string) => {
		if (!notifyRef.current) return;
		if (typeof Notification === "undefined" || Notification.permission !== "granted")
			return;
		if (document.visibilityState === "visible" && document.hasFocus()) return;
		const info = sessionsRef.current.find((s) => s.path === file);
		const title = info?.name || info?.firstMessage || "pwi";
		const n = new Notification(title, { body, tag: file ?? "pwi" });
		n.onclick = () => {
			window.focus();
			n.close();
		};
	}, []);

	const [tabs, setTabs] = useState<Tabs>({ project: "", files: [] });
	/**
	 * Tab edits are computed from the CURRENT tabs and then committed, so they
	 * read through a ref rather than a setState updater: closing a tab has to
	 * know synchronously which neighbour to attach to, and a queued updater
	 * cannot tell the caller that.
	 */
	const tabsRef = useRef(tabs);
	const commitTabs = useCallback((next: Tabs) => {
		tabsRef.current = next;
		setTabs(next);
	}, []);

	/**
	 * Sessions this page has opened successfully, which are therefore live
	 * server-side whether or not they are on disk. `+ New` creates exactly such
	 * a session: the JSONL is written lazily, so a brand-new session is absent
	 * from the listing and must not be mistaken for a deleted one.
	 */
	const opened = useRef<Set<string>>(new Set());

	/**
	 * Sessions opened this page that the listing cannot see yet, keyed the same
	 * way tabs are. `+ New` writes its JSONL lazily, so its row would otherwise
	 * exist only while it is the attached session and disappear the moment
	 * another one is selected. Entries are dropped by `shown` once the real
	 * on-disk entry arrives or the tab is closed.
	 */
	const [pending, setPending] = useState<PiSessionInfo[]>([]);

	/**
	 * This pwi's project list.
	 *
	 * A failed read keeps `error` set rather than emptying the list: a
	 * dropdown that is merely shorter looks exactly like "no projects here",
	 * and the difference is the thing worth showing.
	 */
	const loadProjects = useCallback(async (): Promise<void> => {
		const r = await fetch("/api/projects").catch(() => null);
		if (!r?.ok) {
			setProjects({ projects: [], seed: "", error: r ? `HTTP ${r.status}` : "not answering" });
			return;
		}
		const body: unknown = await r.json().catch(() => null);
		const list =
			body && typeof body === "object" && "projects" in body && Array.isArray(body.projects)
				? body.projects.filter((p): p is string => typeof p === "string")
				: [];
		const seed =
			body && typeof body === "object" && "active" in body && typeof body.active === "string"
				? body.active
				: "";
		setProjects({ projects: list, seed });
	}, []);

	// Once: it seeds the list with this server's startup cwd, which is also
	// the fallback selection on a first visit.
	useEffect(() => {
		void loadProjects();
	}, [loadProjects]);

	/*
	 * Keep the selection pointing at a project that exists.
	 *
	 * A remembered project can vanish from the list (removed elsewhere); fall
	 * back rather than polling a cwd that is no longer offered. Whatever
	 * resolves here is then PINNED to this window, including the value it
	 * inherited from the shared "last project anywhere" key: a window that
	 * never touches the dropdown must still keep the project it opened on
	 * when another window selects something else.
	 */
	useEffect(() => {
		if (projects.error) return;
		if (project && projects.projects.includes(project)) return;
		if (!projects.seed) return;
		setProject(projects.seed);
		pinWindowProject(projects.seed);
	}, [project, projects]);

	// Switching projects clears the session list immediately, so the previous
	// project's sessions never linger under the new project's name.
	const selectProject = useCallback((next: string) => {
		setProject(next);
		pinWindowProject(next);
		writeStored(LAST_PROJECT_KEY, next);
		setSessions([]);
		setListedProject("");
		setListError(null);
	}, []);

	const addProject = useCallback(
		async (path: string) => {
			const r = await fetch("/api/projects", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path }),
			}).catch(() => null);
			const body = (await r?.json().catch(() => ({}))) as {
				error?: string;
				projects?: string[];
			};
			if (!r?.ok) {
				alert(body?.error ?? "could not add project");
				return;
			}
			const list = body.projects ?? [];
			setProjects((p) => ({ ...p, projects: list }));
			// Select what was just added — adding it and then hunting for it in the
			// dropdown is a pointless second step.
			const added = list.at(-1);
			if (added) selectProject(added);
		},
		[selectProject],
	);

	/**
	 * Forget a project. The directory and its sessions are untouched — this is
	 * the view, and pi's session store is keyed by cwd either way, so re-adding
	 * the path brings every session back.
	 */
	const removeProject = useCallback(
		async (path: string) => {
			const r = await fetch("/api/projects", {
				method: "DELETE",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path }),
			}).catch(() => null);
			if (!r?.ok) return;
			// Same shape as the POST response; typed once, then read.
			const body = (await r.json().catch(() => ({}))) as { projects?: string[] };
			const list = body.projects ?? [];
			setProjects((p) => ({ ...p, projects: list }));
			// Removing what you are looking at has to move the selection, or the
			// panel keeps polling a cwd that is no longer offered.
			if (!list.includes(path)) selectProject(list[0] ?? projects.seed);
		},
		[selectProject, projects.seed],
	);

	const refreshSessions = useCallback(async () => {
		if (!project) return;
		const r = await fetch(`/api/sessions?cwd=${encodeURIComponent(project)}`).catch(() => null);
		if (!r?.ok) {
			// Said out loud, not left as an empty list: no sessions and no answer
			// look the same in a list, and only one of them is the machine's fault.
			setListError(r ? `HTTP ${r.status}` : "pwi is not answering");
			return;
		}
		setListError(null);
		setSessions((await r.json()).sessions);
		setListedProject(scope);
	}, [project, scope]);

	/**
	 * Rename a session. pi owns the name (PiSession.setName in
	 * src/server/agent.ts sends `set_session_name`), which is why this is a
	 * request and not a local edit: the name has to end up in the session
	 * file, so the TUI and every other pwi window read the same one.
	 *
	 * Applied optimistically because the server may have to spawn a pi child
	 * for a session nobody had open — a rename that takes two seconds to appear
	 * reads as one that did not work. The refetch afterwards is what makes the
	 * displayed name the stored one either way.
	 */
	const renameSession = useCallback(
		async (session: PiSessionInfo, name: string) => {
			setSessions((list) =>
				list.map((s) => (s.path === session.path ? { ...s, name } : s)),
			);
			const r = await fetch(`/api/sessions/rename`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ file: session.path, id: session.id, name }),
			}).catch(() => null);
			if (!r?.ok) {
				const body = (await r?.json().catch(() => null)) as { error?: string } | null;
				alert(body?.error ?? "could not rename this session");
			}
			await refreshSessions();
		},
		[refreshSessions],
	);

	/**
	 * Let the server name the session: a one-shot `pi -p` child turns the
	 * session's opening request into a title, which the server writes with
	 * `set_session_name`.
	 *
	 * No optimistic update, because nothing here knows the answer — the server
	 * waits for that child and answers with the name it produced. It can take
	 * seconds, so the row says "Naming…" while this is in flight.
	 */
	const autoNameSession = useCallback(
		async (session: PiSessionInfo) => {
			const r = await fetch(`/api/sessions/autoname`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ file: session.path, id: session.id }),
			}).catch(() => null);
			const body = (await r?.json().catch(() => null)) as {
				name?: string;
				error?: string;
			} | null;
			if (!r?.ok) {
				alert(body?.error ?? "could not name this session");
				return;
			}
			if (body?.name) {
				setSessions((list) =>
					list.map((s) => (s.path === session.path ? { ...s, name: body.name } : s)),
				);
			}
			await refreshSessions();
		},
		[refreshSessions],
	);

	useEffect(() => {
		void refreshSessions();
		// Poll so a session working in the background (not attached, not this
		// tab's active one) still shows its live indicator without user action.
		const id = setInterval(() => void refreshSessions(), 5_000);
		return () => clearInterval(id);
	}, [refreshSessions]);

	/** Stop streaming and show the empty pane. Not an abort: see closeTab. */
	const detach = useCallback(() => {
		esRef.current?.close();
		esRef.current = null;
		setSnapshot(null);
		setPartial(emptyPartial());
		setBusy(false);
		setModelError(null);
		// Closing the last tab is not a pending open: the pane must fall back to
		// "Select a session", not sit on "Opening session…".
		setOpening(false);
	}, []);

	/**
	 * Close a TAB — never the session.
	 *
	 * The run keeps going server-side (the first invariant: a detached session
	 * that is still working is exactly the case that must keep running), the
	 * JSONL stays on disk, and the session list still lists it. This is also
	 * the silent-drop path for a remembered session that turned out to be gone,
	 * because the bookkeeping is identical.
	 *
	 * Closing the active tab selects the tab that slid into its slot, so
	 * closing the rightmost one lands on its left neighbour rather than
	 * dumping the user on the empty pane.
	 */
	const closeTab = useCallback(
		(file: string) => {
			const current = tabsRef.current;
			const index = current.files.indexOf(file);
			if (index < 0) return;
			const files = current.files.filter((f) => f !== file);
			if (current.active !== file) {
				commitTabs({ ...current, files });
				return;
			}
			const next: string | undefined = files[Math.min(index, files.length - 1)];
			commitTabs({ ...current, files, active: next });
			// A file tab has no session to attach to, and the attached one is left
			// alone: closing a file must not detach the conversation behind it.
			if (next && !isFileTab(next)) void attachRef.current(next);
			else if (!next) detach();
		},
		[commitTabs, detach],
	);

	/**
	 * Attach to a session. The server is authoritative: we GET the full state
	 * and only then start applying deltas. On any doubt we refetch rather than
	 * trying to repair local state.
	 */
	const attach = useCallback(
		async (file?: string) => {
			/*
			 * Creating a session needs a project, and the project list arrives
			 * asynchronously: pressing `+ New` before it does used to POST a blank
			 * cwd, which the server resolved to its OWN directory — so the session
			 * was created against a directory the user never selected. Resuming is
			 * unaffected (the session header carries the cwd), so only the create
			 * path waits.
			 */
			if (!file && !project) return;

			/*
			 * Every attach takes a ticket, and a stale ticket may not touch the
			 * screen.
			 *
			 * Opening is slow enough to switch tabs during — so `+ New`, or a
			 * click on a big session, used to land its answer seconds later and
			 * yank the user out of whatever they had selected meanwhile. The
			 * session itself is fine (it exists server-side and gets its tab); it
			 * is the FOCUS that must not move after the user has moved it.
			 */
			const seq = ++attachSeq.current;
			const superseded = () => attachSeq.current !== seq;

			esRef.current?.close();
			esRef.current = null;
			setPartial(emptyPartial());
			setModelError(null);

			/*
			 * Blank the pane when this attach is for a DIFFERENT session.
			 *
			 * Opening spawns a pi child and reads the whole transcript, so on a
			 * big session it is seconds. Leaving the previous conversation on
			 * screen for those seconds made a click in the session list look like
			 * it had done nothing at all — the tab strip changed, the thing filling
			 * the window did not. A reattach to the SAME session (an EventSource
			 * that dropped, a server restart) deliberately keeps its transcript:
			 * there is nothing new to wait for and blanking it would be a flicker.
			 */
			const showing = snapshotRef.current;
			const same = showing && file && (showing.file === file || showing.id === file);
			if (!same) {
				setSnapshot(null);
				setBusy(false);
				setOpening(true);
			}

			const r = await fetch(`/api/sessions/open`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				// Never a blank string: the server rejects that, precisely because it
				// used to mean "the server's own cwd" and silently misfiled sessions.
				body: JSON.stringify({ file, cwd: project || undefined }),
			}).catch(() => null);

			// Server unreachable (restarting, or not up yet) is TEMPORARY — keep
			// trying, and keep the tab. Only a 404 below means the session is gone.
			if (!r) {
				// "The server is restarting" resolves by waiting, so this one retries
				// — unless the user has since asked for a different session, in which
				// case retrying would eventually steal the pane back.
				if (!superseded()) setTimeout(() => void attachRef.current(file), 1_000);
				return;
			}
			if (!r.ok) {
				if (superseded()) return;
				/*
				 * Two positive answers cost this tab its slot, and nothing else
				 * does: 404 means neither the registry nor the disk knows this file,
				 * and 409 means the file belongs to another project — a session
				 * remembered under the wrong project's key, which must not be shown
				 * under the selected one. It keeps running server-side and is
				 * reachable by selecting its real project. Any other status is the
				 * server having a bad time, not a missing session, and must not cost
				 * the user a tab.
				 */
				// The retry path above keeps `opening` set, because it really is
				// still opening. This one is over: the session is gone or is not
				// this project's, and the pane goes back to its resting text.
				setOpening(false);
				if (file && (r.status === 404 || r.status === 409)) closeTab(file);
				return;
			}

			const snap = toSnapshot(await r.json());

			/*
			 * Open the tab from the SERVER's answer, not from the requested file:
			 * `+ New` passes no file and only the response knows which session was
			 * created. One code path therefore covers new sessions, list clicks and
			 * restores. The id is the fallback key for a session with no file yet,
			 * so two unsaved sessions cannot collide on `undefined`.
			 *
			 * The tab is registered even for a superseded attach — the session was
			 * created, and a created session with no tab is unreachable — but it is
			 * only SELECTED when this attach is still the one the user is waiting
			 * for.
			 */
			const key = snap.file ?? snap.id;
			opened.current.add(key);
			setPending((list) => {
				if (list.some((s) => s.path === key)) return list;
				const now = new Date().toISOString();
				return [
					...list,
					{
						id: snap.id,
						path: key,
						created: now,
						lastActive: now,
						messageCount: 0,
						firstMessage: "",
					},
				];
			});
			const current = tabsRef.current;
			if (current.project === scope) {
				// Replace a placeholder id-keyed tab once the file exists, rather
				// than ending up with two tabs for one session.
				const files = current.files.filter((f) => f !== snap.id || f === key);
				commitTabs({
					...current,
					files: files.includes(key) ? files : [...files, key],
					active: superseded() ? current.active : key,
				});
			}

			/*
			 * Past here is the attached state — transcript, deltas, composer — and
			 * a superseded attach must claim none of it. Installing its
			 * EventSource would be the worst of it: the stream of a session nobody
			 * is looking at, writing into the pane of the one they are.
			 */
			if (superseded()) return;

			setOpening(false);
			setSnapshot(snap);
			// A mid-stream reattach gets the in-flight message from the server, so
			// there is never a hole where streamed text should be.
			setPartial(snap.partial ?? emptyPartial());
			setBusy(snap.isStreaming);

			const es = new EventSource(`/api/sessions/${snap.id}/events`);
			esRef.current = es;

			/*
			 * The id is a handle on a LIVE session and the server can lose it —
			 * restart, crash, idle eviction. The FILE is the durable identity, so
			 * reopen through it instead of leaving a tab wired to a dead id. Retry
			 * on a delay because "server is down" and "server just restarted" look
			 * identical from here, and only one of them resolves by waiting.
			 */
			const reattach = () => {
				if (esRef.current !== es) return; // superseded by a newer attach
				es.close();
				setTimeout(() => {
					if (esRef.current === es) void attachRef.current(snap.file);
				}, 1_000);
			};

			const refetch = async (): Promise<Snapshot | undefined> => {
				const rr = await fetch(`/api/sessions/${snap.id}`).catch(() => null);
				if (!rr || rr.status === 404) {
					reattach();
					return undefined;
				}
				if (!rr.ok) return undefined;
				const s = toSnapshot(await rr.json());
				setSnapshot(s);
				setPartial(s.partial ?? emptyPartial());
				setBusy(s.isStreaming);
				return s;
			};

			/*
			 * Did this attachment actually WATCH a run? An `idle` also arrives
			 * for a session that was already finished when we attached, and
			 * announcing that would mean a notification for merely opening a
			 * tab. Seeded from the snapshot so a mid-stream reattach still
			 * counts as watching.
			 */
			let worked = snap.isStreaming;

			es.onmessage = (raw) => {
				let e: PiEvent;
				try {
					e = JSON.parse(raw.data);
				} catch {
					// A malformed frame must not kill the handler for every later event.
					void refetch();
					return;
				}
				switch (e.type) {
					case "text":
						setBusy(true);
						// A command that turned into a real turn (`/review`) is no
						// longer waiting on anything — the turn itself is the answer,
						// and the transcript now shows it.
						setCommand(null);
						worked = true;
						setPartial((p) => ({ ...p, text: p.text + e.delta }));
						break;
					case "thinking":
						setBusy(true);
						worked = true;
						setPartial((p) => ({ ...p, thinking: p.thinking + e.delta }));
						break;
					case "tool_start":
						worked = true;
						setPartial((p) => ({
							...p,
							tools: [...p.tools, { id: e.id, name: e.name, args: e.args }],
						}));
						break;
					case "tool_end":
						setPartial((p) => ({
							...p,
							tools: p.tools.map((t) =>
								t.id === e.id ? { ...t, result: e.result, isError: e.isError } : t,
							),
						}));
						break;
					case "message_done":
						// Refetch rather than appending: the server already settled this
						// into the session, and its copy is the one that matters.
						void refetch();
						break;
					case "notice":
						// Appended locally rather than refetched: the answer to a
						// command is the whole event, and a refetch of a long
						// transcript to learn one line is the wrong trade.
						setSnapshot((s) => (s ? { ...s, notices: [...s.notices, e.notice] } : s));
						// This IS the answer a local command was waiting for; the
						// command itself stays, as the record of what was asked.
						setCommand((c) => (c ? { ...c, running: false } : c));
						break;
					case "ask":
						// The agent is blocked on this until it is answered, so it is
						// also the one event worth a notification: nothing else moves
						// until the user comes back.
						setSnapshot((s) => (s ? { ...s, ask: e.ask } : s));
						if (e.ask) announce(snap.file, askLine(e.ask));
						break;
					case "tool_update":
						// Cumulative output: replace, never append.
						setPartial((p) => ({
							...p,
							tools: p.tools.map((t) => (t.id === e.id ? { ...t, result: e.result } : t)),
						}));
						break;
					case "idle":
						setBusy(false);
						void (async () => {
							const settled = await refetch();
							if (worked) announce(snap.file, replyLine(settled));
							worked = false;
						})();
						void refreshSessions();
						break;
					case "error":
						setBusy(false);
						setCommand((c) => (c ? { ...c, running: false } : c));
						if (worked) {
							worked = false;
							announce(snap.file, `Failed: ${e.message}`);
						}
						setSnapshot((s) => (s ? { ...s, error: e.message } : s));
						break;
				}
			};

			// The browser retries a dropped SSE connection on its own, but gives up
			// for good on an HTTP error — exactly what a restarted server returns for
			// an id it no longer has. CLOSED means only we can recover it.
			es.onerror = () => {
				if (es.readyState === EventSource.CLOSED) reattach();
				else void refetch();
			};
		},
		[refreshSessions, project, scope, commitTabs, closeTab],
	);

	attachRef.current = attach;

	useEffect(() => () => esRef.current?.close(), []);

	/**
	 * Adopt the tab set of the selected project.
	 *
	 * One effect covers both "restore on reload" and "switch project": tabs are
	 * per-project state, so the only correct reaction to the project changing
	 * is to swap the whole strip and reattach to its active session. A first
	 * visit remembers nothing and lands on the empty pane rather than inventing
	 * a session.
	 *
	 * The ref guard is load-bearing under StrictMode, which deliberately
	 * double-invokes effects in development: without it the restore fires twice
	 * and the second EventSource replaces the first mid-attach.
	 */
	const adopted = useRef("");
	useEffect(() => {
		if (!project || adopted.current === scope) return;
		adopted.current = scope;
		const next = readTabs(scope);
		commitTabs(next);
		detach();
		// A restored FILE tab has no session behind it. Attach to nothing and let
		// the file render; attaching would treat `file:/path` as a session path.
		if (next.active && !isFileTab(next.active)) void attach(next.active);
	}, [project, scope, attach, commitTabs, detach]);

	useEffect(() => {
		// Never persist the placeholder state that precedes the first adoption;
		// it belongs to no project.
		if (tabs.project) {
			writeStored(
				`pwi:tabs:${tabs.project}`,
				JSON.stringify({ files: tabs.files, active: tabs.active }),
			);
		}
	}, [tabs]);

	/**
	 * Drop remembered tabs whose session no longer exists, so a deleted session
	 * does not come back as a permanently broken tab.
	 *
	 * Gated on positive evidence: a session list we actually received for THIS
	 * project. Sessions this page opened are exempt because the JSONL is
	 * written lazily — a `+ New` session that has not been prompted yet is
	 * legitimately absent from the listing while being perfectly alive.
	 */
	useEffect(() => {
		if (!listedProject || listedProject !== tabs.project) return;
		for (const file of tabs.files) {
			// A file tab is not a session and is not in the session listing; only
			// the sessions are checked for having gone away.
			if (isFileTab(file)) continue;
			if (opened.current.has(file)) continue;
			if (sessions.some((s) => s.path === file)) continue;
			closeTab(file);
		}
	}, [sessions, listedProject, tabs, closeTab]);

	/**
	 * Switch tabs: a chat session, or a file.
	 *
	 * Only a session attaches — a file tab is rendered from its own state and
	 * has no server session behind it. Selecting one deliberately leaves the
	 * attached session alone, so switching to a file and back does not tear
	 * down a live EventSource or interrupt a streaming turn.
	 */
	const selectTab = useCallback(
		(file: string) => {
			const current = tabsRef.current;
			if (current.active === file) return;
			commitTabs({
				...current,
				files: current.files.includes(file) ? current.files : [...current.files, file],
				active: file,
			});
			// Already attached to this session (switched away to a file and back):
			// re-attaching would tear down a live EventSource for no reason.
			if (isFileTab(file) || (snapshotRef.current?.file === file && esRef.current)) return;
			void attachRef.current(file);
		},
		[commitTabs],
	);

	/**
	 * Move a tab within the strip.
	 *
	 * Order is the only thing that changes: no attach, no detach, no selection
	 * change. Dragging the tab you are reading must not reload it, and it must
	 * not steal the selection from the one you are streaming.
	 */
	const reorderTabs = useCallback(
		(from: number, to: number) => {
			const current = tabsRef.current;
			const files = moveTab(current.files, from, to);
			if (files === current.files) return;
			commitTabs({ ...current, files });
		},
		[commitTabs],
	);

	/** Open a file from the explorer into a tab, or focus the tab it already has. */
	const openFile = useCallback(
		(path: string) => {
			selectTab(fileTab(path));
		},
		[selectTab],
	);

	/**
	 * Which open files have unsaved edits, so the strip can dot them.
	 *
	 * Held here rather than in FileEditor because the strip is rendered from
	 * here and cannot see into a tab's body — without it a modified file would
	 * look exactly like a saved one from the outside.
	 */
	const [dirtyFiles, setDirtyFiles] = useState<Record<string, boolean>>({});
	const onFileDirty = useCallback((path: string, dirty: boolean) => {
		setDirtyFiles((current) =>
			// Same value: return the SAME object. A fresh one on every keystroke
			// would re-render the whole strip while typing.
			(current[path] ?? false) === dirty ? current : { ...current, [path]: dirty },
		);
	}, []);

	/**
	 * Alt+1..9 selects the Nth tab.
	 *
	 * Alt and not Ctrl/Cmd: Ctrl/Cmd+1..9 and Ctrl/Cmd+W are the browser's own
	 * tab bindings, and a web app stealing them is hostile. `code` rather than
	 * `key` because Alt+digit produces a different character on several
	 * keyboard layouts (macOS Alt+1 is "¡"), while the physical digit key is
	 * what the user pressed. preventDefault only once a tab has matched, so
	 * Alt+7 with three tabs open still reaches the browser.
	 */
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
			const digit = /^Digit([1-9])$/.exec(e.code);
			if (!digit) return;
			const file = tabs.files[Number(digit[1]) - 1];
			if (!file) return;
			e.preventDefault();
			selectTab(file);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [tabs.files, selectTab]);

	/**
	 * Ctrl+` toggles the terminal — the binding VS Code, Windows Terminal and
	 * every editor with a panel already use, so it is the one a hand reaches
	 * for without being told. `code` again, because the backquote key produces
	 * a different character on non-US layouts.
	 *
	 * Not captured while the terminal itself has focus: Ctrl+` there is a
	 * keystroke for the shell. Except that closing it from inside is exactly
	 * what the binding is for in an editor, so it stays global and the shell
	 * loses one obscure control character it has no binding for anyway.
	 */
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.code !== "Backquote" || !e.ctrlKey || e.metaKey || e.altKey) return;
			e.preventDefault();
			selectPanel("terminal");
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [selectPanel]);

	// Tab title reflects activity so switching away doesn't lose the signal —
	// the one thing a background terminal gives you for free.
	useEffect(() => {
		document.title = busy ? "\u25cf pwi \u2014 working\u2026" : "pwi";
	}, [busy]);

	// The same signal in the icon, for a tab narrow enough that the title is
	// clipped to nothing — which is every tab, once a few are open.
	useEffect(() => {
		if (!busy) return;
		return pulseFavicon();
	}, [busy]);

	/*
	 * Notice when the server we are talking to is not the one that served this
	 * page.
	 *
	 * The session layer already survives a restart — the EventSource reattaches
	 * through the file — so this is about the BUNDLE: the JS and CSS in this tab
	 * are from the old build, and a page left open across a deploy runs code
	 * that no longer matches the server. The failures that produces are quiet
	 * and confusing, so say it plainly instead.
	 *
	 * A banner and not an automatic reload: a reload mid-run would throw away
	 * the transcript on screen for a reason the user never asked about. Drafts
	 * are written on every keystroke, so taking it is cheap whenever they like.
	 */
	const [restarted, setRestarted] = useState(false);
	useEffect(() => {
		let boot: string | undefined;
		let live = true;
		const check = async () => {
			const r = await fetch("/api/health").catch(() => null);
			if (!live || !r?.ok) return; // down is not restarted; say nothing yet
			const body: unknown = await r.json().catch(() => null);
			const seen =
				body && typeof body === "object" && "boot" in body && typeof body.boot === "string"
					? body.boot
					: undefined;
			// An older server has no `boot` at all, and cannot be compared. Saying
			// nothing is right: it is exactly the case this banner is wrong about.
			if (!seen) return;
			if (boot === undefined) boot = seen;
			else if (seen !== boot) setRestarted(true);
		};
		void check();
		// Slow on purpose. This is a background fact, not a thing to poll hard:
		// the cost of noticing a minute late is a stale tab for a minute.
		const t = setInterval(() => void check(), 30_000);
		return () => {
			live = false;
			clearInterval(t);
		};
	}, []);

	// The spinner stops on its own: `/model` and friends change the session
	// without printing anything, so no answer is ever coming for them and
	// nothing else would ever take the "running" off.
	useEffect(() => {
		if (!command?.running) return;
		const t = setTimeout(
			() => setCommand((c) => (c ? { ...c, running: false } : c)),
			COMMAND_RUNNING_MAX_MS,
		);
		return () => clearTimeout(t);
	}, [command]);

	const send = useCallback(
		async (text: string, images?: PiImage[]) => {
			if (!snapshot) return;
			setBusy(true);
			// A local command appends no message: this row IS the record that it
			// was sent. And the ack below is acceptance, not completion — the
			// answer arrives later as a notice, so it starts out running.
			const trimmed = text.trim();
			setCommand(trimmed.startsWith("/") ? { text: trimmed, running: true } : null);
			const r = await fetch(`/api/sessions/${snapshot.id}/prompt`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ text, images }),
			});

			// A rejected prompt (unsupported type, too large, 413) never reaches the
			// session, so no SSE error is coming — surface it here or it is lost and
			// the UI just sits on a spinner that will never resolve.
			if (!r.ok) {
				const body = await r.json().catch(() => ({}) as { error?: string });
				setBusy(false);
				setCommand(null);
				setSnapshot((s) =>
					s ? { ...s, error: body.error ?? `prompt failed (${r.status})` } : s,
				);
				return;
			}

			const rr = await fetch(`/api/sessions/${snapshot.id}`);
			if (rr.ok) setSnapshot(toSnapshot(await rr.json()));
		},
		[snapshot],
	);

	const abort = useCallback(async () => {
		if (!snapshot) return;
		await fetch(`/api/sessions/${snapshot.id}/abort`, { method: "POST" });
	}, [snapshot]);

	/**
	 * Fold the conversation. The transcript and the meter move when
	 * `compaction_end` arrives over SSE, not here — a compaction takes a model
	 * call, and pretending otherwise would blank the meter before the summary
	 * exists. A refusal (mid-turn) is shown where every other session error is.
	 */
	const compact = useCallback(async () => {
		if (!snapshot) return;
		const r = await fetch(`/api/sessions/${snapshot.id}/compact`, { method: "POST" });
		if (r.ok) return;
		const body = await r.json().catch(() => ({}) as { error?: string });
		setSnapshot((s) => (s ? { ...s, error: body.error ?? "could not compact" } : s));
	}, [snapshot]);

	/**
	 * Replace this session's pi child so it picks up a newly installed
	 * package. The transcript comes back from the server's fresh snapshot —
	 * the conversation is on disk, only the process changed.
	 */
	const restart = useCallback(async () => {
		if (!snapshot) return;
		const r = await fetch(`/api/sessions/${snapshot.id}/restart`, { method: "POST" });
		const body: unknown = await r.json().catch(() => null);
		if (r.ok && body && typeof body === "object") {
			setSnapshot(toSnapshot(body as Partial<Snapshot>));
			return;
		}
		const reason =
			body && typeof body === "object" && "error" in body && typeof body.error === "string"
				? body.error
				: "could not restart this session";
		setSnapshot((s) => (s ? { ...s, error: reason } : s));
	}, [snapshot]);

	/**
	 * Re-read the open session's snapshot.
	 *
	 * For facts that change OUTSIDE the event stream — a package installed
	 * from the Packages screen makes this session stale, and nothing in the
	 * session's own frames will ever say so.
	 */
	const reloadSnapshot = useCallback(async () => {
		if (!snapshot) return;
		const r = await fetch(`/api/sessions/${snapshot.id}`);
		if (r.ok) setSnapshot(toSnapshot(await r.json()));
	}, [snapshot]);

	/**
	 * Re-read the slash command catalog when the composer's picker opens.
	 *
	 * pi pushes nothing when the set changes, and it does change under a live
	 * session: installing a package, or dropping a file in `.pi/prompts`, adds
	 * commands the child only sees when asked. Asking on every `/` keystroke
	 * would be a round trip per character, so the answer is good for half a
	 * minute — a package install is not a keystroke.
	 */
	const commandsFetchedAt = useRef<{ id: string; at: number } | null>(null);
	const refreshCommands = useCallback(async () => {
		if (!snapshot) return;
		const last = commandsFetchedAt.current;
		if (last && last.id === snapshot.id && Date.now() - last.at < 30_000) return;
		commandsFetchedAt.current = { id: snapshot.id, at: Date.now() };
		const r = await fetch(`/api/sessions/${snapshot.id}/commands`, {
			method: "POST",
		}).catch(() => null);
		if (!r?.ok) return;
		const body: unknown = await r.json().catch(() => null);
		if (!body || typeof body !== "object" || !("commands" in body)) return;
		const commands = body.commands;
		if (!Array.isArray(commands)) return;
		setSnapshot((s) => (s && s.id === snapshot.id ? { ...s, commands } : s));
	}, [snapshot]);

	/**
	 * Answer the question pi is blocked on.
	 *
	 * The panel is cleared optimistically: the `ask` event that confirms it
	 * comes back over SSE, and leaving the question on screen until it arrives
	 * would invite a second click on a dialog that is already answered. A 409
	 * means it was gone before the click landed (timed out, or the turn was
	 * aborted), which the refetch below then reflects.
	 */
	const answerAsk = useCallback(
		async (askId: string, answer: AskAnswer) => {
			if (!snapshot) return;
			setSnapshot((s) => (s ? { ...s, ask: null } : s));
			const r = await fetch(`/api/sessions/${snapshot.id}/ask`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ askId, ...answer }),
			});
			if (r.ok) return;
			const rr = await fetch(`/api/sessions/${snapshot.id}`);
			if (rr.ok) setSnapshot(toSnapshot(await rr.json()));
		},
		[snapshot],
	);

	const changeModel = useCallback(
		async (model: string) => {
			if (!snapshot) return;
			setModelError(null);
			const r = await fetch(`/api/sessions/${snapshot.id}/model`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model }),
			});
			if (!r.ok) {
				const body = await r.json().catch(() => ({}));
				setModelError(body.error ?? "failed to switch model");
				return;
			}
			const rr = await fetch(`/api/sessions/${snapshot.id}`);
			if (rr.ok) setSnapshot(await rr.json());
		},
		[snapshot],
	);

	/**
	 * Reasoning effort. Shares `modelError` with the model switch: both are
	 * the same control group saying "the session refused that", and a second
	 * error slot would be a second thing to render in the same corner.
	 */
	const changeThinking = useCallback(
		async (level: string) => {
			if (!snapshot) return;
			setModelError(null);
			const r = await fetch(`/api/sessions/${snapshot.id}/thinking`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ level }),
			});
			if (!r.ok) {
				const body = await r.json().catch(() => ({}));
				setModelError(body.error ?? "failed to set thinking level");
				return;
			}
			const rr = await fetch(`/api/sessions/${snapshot.id}`);
			if (rr.ok) setSnapshot(await rr.json());
		},
		[snapshot],
	);

	// A session created by `+ New` has no JSONL until its first prompt, so
	// /api/sessions (which lists disk) cannot see it. Show it anyway — in the
	// list and as a tab title — for as long as it has a tab and no on-disk
	// entry. Tab membership is the lifetime: closing the tab drops the row, and
	// tabs are per-project, so another project's unsaved session never leaks in.
	const shown = useMemo(() => {
		const extra = pending.filter(
			(p) => tabs.files.includes(p.path) && !sessions.some((s) => s.path === p.path),
		);
		return extra.length ? [...extra, ...sessions] : sessions;
	}, [sessions, pending, tabs.files]);

	const activeIndex = tabs.active ? tabs.files.indexOf(tabs.active) : -1;

	return (
		<div ref={splitRow} className="flex h-full bg-neutral-950 text-neutral-100">
			{/*
			  Fixed, and above everything: the point is that it is visible whichever
			  pane you are looking at. Dismissible because a tab you are only reading
			  does not have to act on it.
			*/}
			{restarted && (
				<div className="fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-3 border-b border-amber-800 bg-amber-950/95 px-3 py-1.5 text-sm text-amber-200">
					<span>pwi restarted — this page is running the previous build.</span>
					<button
						type="button"
						onClick={() => location.reload()}
						className="rounded border border-amber-700 px-2 py-0.5 hover:bg-amber-900"
					>
						Reload
					</button>
					<button
						type="button"
						onClick={() => setRestarted(false)}
						className="text-amber-400 hover:text-amber-200"
						aria-label="Dismiss"
					>
						✕
					</button>
				</div>
			)}
			{/* The rail owns every panel toggle, and never scrolls. */}
			<ActivityBar
				panel={panel}
				onSelect={selectPanel}
				pendingHunks={snapshot?.hunks.filter((h) => h.state === "pending").length ?? 0}
				onSettings={() => setSettingsOpen(true)}
				version={__APP_VERSION__}
			/>

			{/*
			 * THE panel column — one column, whichever panel the rail selected,
			 * sitting immediately right of the button that opened it.
			 *
			 * Each panel states its own requirement rather than the rail hiding
			 * the button: the editor and the terminal need a project, changes
			 * needs a SESSION (hunks belong to one, and decisions post against its
			 * id), and packages needs neither. A button that silently does nothing
			 * is worse than one that opens a panel explaining what is missing.
			 */}
			{panel !== null && (
				<>
					<div
						className="flex min-h-0 min-w-0 flex-col narrow:flex-1 wide:[flex:0_0_var(--panel-w)]"
						style={{ "--panel-w": `${panelWidth}%` } as React.CSSProperties}
					>
						{panel === "editor" &&
							(project || snapshot ? (
								<Explorer
									cwd={snapshot?.cwd || project || ""}
									openPath={
										tabs.active && isFileTab(tabs.active) ? tabPath(tabs.active) : null
									}
									onOpen={openFile}
									onClose={() => setPanel(null)}
								/>
							) : (
								<PanelEmpty title="Explorer" onClose={() => setPanel(null)}>
									Pick a project first — the file tree is rooted at it.
								</PanelEmpty>
							))}

						{panel === "review" &&
							(snapshot ? (
								<Review
									sessionId={snapshot.id}
									cwd={snapshot.cwd}
									hunks={snapshot.hunks}
									onClose={() => setPanel(null)}
									onChanged={() => void reloadSnapshot()}
								/>
							) : (
								<PanelEmpty title="Changes" onClose={() => setPanel(null)}>
									Open a session to review what the agent changed.
								</PanelEmpty>
							))}

						{/*
						 * Kept MOUNTED while another panel shows, because the shells
						 * are live processes and xterm's fit is measured from a visible
						 * box — unmounting would tear down a terminal you only switched
						 * away from, and remounting would re-measure at zero width.
						 */}
						{panel === "terminal" &&
							(project ? (
								<TerminalPane
									cwd={project}
									ready={termsReady}
									layout={termLayout}
									onLayout={changeTermLayout}
									onClose={closeTerminal}
								/>
							) : (
								<PanelEmpty title="Terminal" onClose={() => setPanel(null)}>
									Pick a project first — a shell has to start somewhere.
								</PanelEmpty>
							))}

						{panel === "packages" && (
							<Packages
								onChanged={() => void reloadSnapshot()}
								cwd={project}
								onClose={() => setPanel(null)}
							/>
						)}
					</div>
					{/* Hidden on narrow, where the panel IS the view and there is
					    nothing beside it to resize. */}
					<div
						role="separator"
						aria-orientation="vertical"
						aria-label="Resize panel"
						aria-valuenow={Math.round(panelWidth)}
						aria-valuemin={TERMINAL_MIN_PERCENT}
						aria-valuemax={TERMINAL_MAX_PERCENT}
						tabIndex={0}
						onPointerDown={startDrag}
						onKeyDown={dividerKeys}
						// The `after` box is the real hit area: a 4px line is a target
						// you miss, and there is nothing else to aim at.
						className="relative w-1 shrink-0 cursor-col-resize bg-neutral-800 transition-colors duration-150 ease-out after:absolute after:inset-y-0 after:-left-1 after:-right-1 after:content-[''] hover:bg-amber-600 focus-visible:bg-amber-500 focus-visible:outline-none motion-reduce:transition-none narrow:hidden"
					/>
				</>
			)}

			{/* On a phone the panel IS the view: two columns there is three words
			    per line each. Same rule the session list follows. */}
			<div
				className={`flex min-h-0 min-w-0 flex-1 flex-col ${panel !== null ? "narrow:hidden" : ""}`}
			>
				<SessionTabs
					tabs={tabs.files}
					sessions={shown}
					active={tabs.active}
					panelId={CHAT_PANEL_ID}
					listOpen={listOpen}
					onSelect={selectTab}
					shortNames={shortNames}
					onClose={closeTab}
					onNew={() => void attach(undefined)}
					onToggleList={() => setListOpen((o) => !o)}
					dirtyFiles={dirtyFiles}
					onReorder={reorderTabs}
				/>
				<div className="flex min-h-0 min-w-0 flex-1">
					<div
						id={CHAT_PANEL_ID}
						role="tabpanel"
						aria-labelledby={activeIndex >= 0 ? tabDomId(activeIndex) : undefined}
						className="flex min-h-0 min-w-0 flex-1 flex-col"
					>
						{/*
						 * A file tab shows its editor; anything else shows the chat.
						 *
						 * Chat stays MOUNTED underneath rather than being swapped out,
						 * because it holds the live EventSource and the transcript's
						 * scroll position: unmounting to look at a file would drop a
						 * streaming turn and lose your place in it. `hidden` costs a
						 * hidden subtree; remounting costs the session.
						 */}
						{tabs.active && isFileTab(tabs.active) && (
							<FileEditor
								// Keyed by path: switching files must build a new editor
								// rather than reuse one holding another file's undo history.
								key={tabs.active}
								path={tabPath(tabs.active)}
								cwd={snapshot?.cwd || project || ""}
								onDirty={onFileDirty}
							/>
						)}
						<div
							className={`flex min-h-0 min-w-0 flex-1 flex-col ${
								tabs.active && isFileTab(tabs.active) ? "hidden" : ""
							}`}
						>
							<Chat
								snapshot={snapshot}
								partial={partial}
								busy={busy}
								opening={opening}
								showThinking={showThinking}
								toolMode={toolMode}
								command={command}
								modelError={modelError}
								onSend={send}
								onAnswerAsk={answerAsk}
								onAbort={abort}
								onModelChange={changeModel}
								onThinkingChange={changeThinking}
								onCommandMenu={refreshCommands}
								onCompact={compact}
								onRestart={restart}
							/>
						</div>
					</div>
				</div>
			</div>

			{/* The session list moved to the RIGHT edge, opposite the rail: the two
			    pieces of persistent chrome now bracket the window instead of
			    stacking on one side. It keeps its narrow-viewport drawer
			    behaviour, which now slides in from the right. */}
			<SessionList
				sessions={shown}
				listError={listError}
				onRemoveProject={(p) => void removeProject(p)}
				activeFile={snapshot?.file}
				openFiles={tabs.files}
				projects={projects}
				project={project}
				sort={sessionSort}
				onSort={(next) => {
					setSessionSort(next);
					writeSessionSort(next);
				}}
				open={listOpen}
				onToggle={() => setListOpen((o) => !o)}
				onProject={selectProject}
				onAddProject={(p) => void addProject(p)}
				onSelect={(s) => {
					selectTab(s.path);
					// On a narrow viewport the list is a drawer over the chat; having
					// picked a session, the chat is what you want to see.
					setListOpen(false);
				}}
				onRename={(s, name) => void renameSession(s, name)}
				onAutoName={autoNameSession}
				shortNames={shortNames}
				onNew={() => void attach(undefined)}
			/>
			<Settings
				open={settingsOpen}
				theme={theme}
				onTheme={setTheme}
				showThinking={showThinking}
				onShowThinking={changeShowThinking}
				toolMode={toolMode}
				onToolMode={changeToolMode}
				notify={notify}
				onNotify={(on) => void changeNotify(on)}
				shortNames={shortNames}
				onShortNames={changeShortNames}
				onClose={() => setSettingsOpen(false)}
			/>
		</div>
	);
}
