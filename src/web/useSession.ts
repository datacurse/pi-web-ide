import type { Tabs } from "./tabStore.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { addNotice, ASK_ONLY } from "../shared/types.js";
import type {
	AskAnswer,
	PiAsk,
	PiEvent,
	PiImage,
	PiMessage,
	PiPartial,
	PiSessionInfo,
	Snapshot,
} from "../shared/types.js";
import { gitChanged } from "./GitActions.js";
import { groupOf, sideOfTab, withGroup } from "./tabs.js";
import type { Side } from "./tabs.js";
import { api } from "./api.js";

const emptyPartial = (): PiPartial => ({ text: "", thinking: "", tools: [] });

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
		// An older server sends none, and diff tabs show no hunk decisions.
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

/**
 * How long a local slash command may claim to be running before the row stops
 * saying so. A command that answers nothing (`/model`, `/thinking`) emits no
 * `command_output`, so nothing else would ever stop the spinner, and
 * `/compact` on a full context legitimately takes minutes. The command itself
 * stays on screen either way — it is the record of what was sent.
 */
const COMMAND_RUNNING_MAX_MS = 120_000;
/** What a session hook needs from App: the tab strip, and the listing it keeps fresh. */
interface SessionEnv {
	side: Side;
	project: string;
	scope: string;
	tabsRef: React.MutableRefObject<Tabs>;
	commitTabs: (tabs: Tabs) => void;
	/** Close a tab in whichever column holds it: how a vanished session leaves. */
	closeRef: React.MutableRefObject<(file: string) => void>;
	refreshSessions: () => Promise<void>;
	announce: (file: string | undefined, body: string) => void;
	opened: React.MutableRefObject<Set<string>>;
	setPending: React.Dispatch<React.SetStateAction<PiSessionInfo[]>>;
}

/**
 * One attached session: its snapshot, its EventSource, its composer actions.
 *
 * Called once per editor column, so each column shows its own conversation.
 */
export function useSession({
	side,
	project,
	scope,
	tabsRef,
	commitTabs,
	closeRef,
	refreshSessions,
	announce,
	opened,
	setPending,
}: SessionEnv) {
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

	const esRef = useRef<EventSource | null>(null);
	/**
	 * Ticket for the newest attach. An attach whose ticket is no longer the
	 * current one has been superseded by a later selection, and may not move
	 * the selection or the pane; see attach().
	 */
	const attachSeq = useRef(0);
	// attach() reconnects by calling itself; a useCallback cannot reference itself.
	const attachRef = useRef<(file?: string) => Promise<void>>(async () => {});

	/**
	 * The tab this hook is showing or opening. App's `sync` compares a
	 * column's selected tab against it to decide whether to attach.
	 */
	const targetRef = useRef<string | undefined>(undefined);

	/** Stop streaming and show the empty pane. Not an abort: see closeTab. */
	const detach = useCallback(() => {
		// An attach still in flight must not land in a pane that was emptied.
		attachSeq.current++;
		targetRef.current = undefined;
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
			targetRef.current = file;

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

			const r = await api.sessions.open
				// Never a blank string: the server rejects that, precisely because it
				// used to mean "the server's own cwd" and silently misfiled sessions.
				.$post({ json: { file, cwd: project || undefined } })
				.catch(() => null);

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
				if (file && (r.status === 404 || r.status === 409)) closeRef.current(file);
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
				/*
				 * Which column this session's tab already lives in.
				 *
				 * Attaching must not ASSUME the left one. A session dragged into the
				 * second column is still the attached session, and reloading the page
				 * re-attaches it — which used to append a second tab for it on the
				 * left, so one session showed up in both columns and the left copy
				 * rendered an empty pane, because the chat can only be in one place.
				 *
				 * A session in NEITHER column is new: it goes where the chat already
				 * is, so "+" next to a session in the second column opens beside it
				 * instead of yanking the chat back to the first.
				 */
				const at: Side = sideOfTab(current, key, snap.id) ?? side;
				const group = groupOf(current, at);
				// Before the commit: `sync` runs inside it and must see this tab
				// as already ours, or it would open it a second time.
				if (!superseded()) targetRef.current = key;
				// Replace a placeholder id-keyed tab once the file exists, rather
				// than ending up with two tabs for one session.
				const files = group.files.filter((f) => f !== snap.id || f === key);
				commitTabs(
					withGroup(current, at, {
						files: files.includes(key) ? files : [...files, key],
						active: superseded() ? group.active : key,
					}),
				);
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
				const rr = await api.sessions[":id"].$get({ param: { id: snap.id } }).catch(() => null);
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
						// Any tool may have touched the tree; re-read the changed-file count now.
						gitChanged(snap.cwd || project);
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
						setSnapshot((s) => (s ? { ...s, notices: addNotice(s.notices, e.notice) } : s));
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
		[refreshSessions, project, scope, commitTabs, closeRef, announce, side, tabsRef, opened, setPending],
	);

	attachRef.current = attach;

	useEffect(() => {
		// Fast Refresh re-runs effects: an edit to this file ran the cleanup below
		// and left the tab deaf to its session. Reopen the stream it closed.
		const file = snapshotRef.current?.file;
		if (esRef.current?.readyState === EventSource.CLOSED && file) void attachRef.current(file);
		return () => esRef.current?.close();
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

	/**
	 * Fold the conversation. The POST lasts the whole compaction and returns
	 * once the server has re-read the folded transcript, so the refetch after
	 * it is what moves the transcript and the meter. A refusal (mid-turn) is
	 * shown where every other session error is.
	 */
	const [compacting, setCompacting] = useState(false);
	const compact = useCallback(async (instructions?: string) => {
		if (!snapshot) return;
		setCompacting(true);
		try {
			const r = await api.sessions[":id"].compact.$post({
				param: { id: snapshot.id },
				json: { customInstructions: instructions || undefined },
			});
			if (r.ok) {
				const fresh = await api.sessions[":id"].$get({ param: { id: snapshot.id } });
				if (fresh.ok) setSnapshot(toSnapshot(await fresh.json()));
				return;
			}
			const body = await r.json().catch(() => ({}) as { error?: string });
			setSnapshot((s) => (s ? { ...s, error: body.error ?? "could not compact" } : s));
		} finally {
			setCompacting(false);
		}
	}, [snapshot]);

	const send = useCallback(
		async (text: string, images?: PiImage[], askOnly = false) => {
			if (!snapshot) return;
			const trimmed = text.trim();
			// pi's `/compact` is TUI-only; over RPC it would reach the model as text.
			const compactCmd = /^\/compact(?:\s+([\s\S]*))?$/.exec(trimmed);
			if (compactCmd && !images?.length) return compact(compactCmd[1]?.trim());
			setBusy(true);
			// A local command appends no message: this row IS the record that it
			// was sent. And the ack below is acceptance, not completion — the
			// answer arrives later as a notice, so it starts out running.
			setCommand(trimmed.startsWith("/") ? { text: trimmed, running: true } : null);
			// Show the message now, not after pi acks it. Every refetch replaces
			// `messages` wholesale, so the server's copy supersedes this one. Not
			// while streaming: a follow-up is queued, and would jump position.
			const optimistic: PiMessage | null =
				!busy && !trimmed.startsWith("/")
					? {
							role: "user",
							blocks: [
								...(text ? [{ kind: "text" as const, text }] : []),
								...(images ?? []).map((i) => ({ kind: "image" as const, ...i })),
							],
							timestamp: Date.now(),
						}
					: null;
			if (optimistic) setSnapshot((s) => (s ? { ...s, messages: [...s.messages, optimistic] } : s));
			const r = await api.sessions[":id"].prompt.$post({
				param: { id: snapshot.id },
				// The suffix goes to pi only; toPiMessage strips it from the transcript.
				json: { text: askOnly && !trimmed.startsWith("/") ? text + ASK_ONLY : text, images },
			});

			// A rejected prompt (unsupported type, too large, 413) never reaches the
			// session, so no SSE error is coming — surface it here or it is lost and
			// the UI just sits on a spinner that will never resolve.
			if (!r.ok) {
				const body = await r.json().catch(() => ({}) as { error?: string });
				setBusy(false);
				setCommand(null);
				setSnapshot((s) =>
					s
						? {
								...s,
								messages: s.messages.filter((m) => m !== optimistic),
								error: body.error ?? `prompt failed (${r.status})`,
							}
						: s,
				);
				return;
			}

			const rr = await api.sessions[":id"].$get({ param: { id: snapshot.id } });
			if (rr.ok) setSnapshot(toSnapshot(await rr.json()));
		},
		[snapshot, busy, compact],
	);

	const abort = useCallback(async () => {
		if (!snapshot) return;
		await api.sessions[":id"].abort.$post({ param: { id: snapshot.id } });
	}, [snapshot]);

	/** Fork this session after one of its answers, and open the fork in this column. */
	const fork = useCallback(
		async (at: number) => {
			if (!snapshot) return;
			const r = await api.sessions[":id"].fork.$post({ param: { id: snapshot.id }, json: { at } }).catch(() => null);
			const body = (await r?.json().catch(() => null)) as { file?: unknown; error?: unknown } | null;
			if (r?.ok && typeof body?.file === "string") {
				void attach(body.file);
				return;
			}
			const reason = typeof body?.error === "string" ? body.error : "could not fork this session";
			setSnapshot((s) => (s ? { ...s, error: reason } : s));
		},
		[snapshot, attach],
	);

	/**
	 * Replace this session's pi child so it picks up a newly installed
	 * package. The transcript comes back from the server's fresh snapshot —
	 * the conversation is on disk, only the process changed.
	 */
	const restart = useCallback(async () => {
		if (!snapshot) return;
		const r = await api.sessions[":id"].restart.$post({ param: { id: snapshot.id } });
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
		const r = await api.sessions[":id"].$get({ param: { id: snapshot.id } });
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
		const r = await api.sessions[":id"].commands.$post({ param: { id: snapshot.id } }).catch(() => null);
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
			const r = await api.sessions[":id"].ask.$post({ param: { id: snapshot.id }, json: { askId, ...answer } });
			if (r.ok) return;
			const rr = await api.sessions[":id"].$get({ param: { id: snapshot.id } });
			if (rr.ok) setSnapshot(toSnapshot(await rr.json()));
		},
		[snapshot],
	);

	const changeModel = useCallback(
		async (model: string) => {
			if (!snapshot) return;
			setModelError(null);
			const r = await api.sessions[":id"].model.$post({ param: { id: snapshot.id }, json: { model } });
			if (!r.ok) {
				const body = (await r.json().catch(() => ({}))) as { error?: string };
				setModelError(body.error ?? "failed to switch model");
				return;
			}
			const rr = await api.sessions[":id"].$get({ param: { id: snapshot.id } });
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
			const r = await api.sessions[":id"].thinking.$post({ param: { id: snapshot.id }, json: { level } });
			if (!r.ok) {
				const body = (await r.json().catch(() => ({}))) as { error?: string };
				setModelError(body.error ?? "failed to set thinking level");
				return;
			}
			const rr = await api.sessions[":id"].$get({ param: { id: snapshot.id } });
			if (rr.ok) setSnapshot(await rr.json());
		},
		[snapshot],
	);

	return {
		snapshot,
		partial,
		busy,
		opening,
		command,
		modelError,
		targetRef,
		attach,
		detach,
		send,
		abort,
		compact,
		compacting,
		fork,
		restart,
		reloadSnapshot,
		refreshCommands,
		answerAsk,
		changeModel,
		changeThinking,
	};
}
