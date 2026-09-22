/**
 * registry.ts — session cache + server-authoritative message state.
 *
 * Two invariants live here, and everything else is bookkeeping:
 *
 *   1. NEVER evict a streaming session, attached or not. "No client attached"
 *      must not imply "idle" — a detached session that is still working is
 *      exactly the case we promised keeps running. Violating this means
 *      closing a browser tab silently kills the run.
 *
 *   2. The SERVER owns the message list. Clients get a full snapshot on
 *      attach and apply deltas after; on any doubt they refetch. The session
 *      JSONL is the source of truth — we never build a second one in React
 *      and then debug why they disagree.
 *
 * Eviction is lossless: everything is on disk, so dropping an entry is a cache
 * decision, not data loss. Reopening costs one `pi` spawn, against the ~30
 * minutes of idleness that triggers eviction.
 */

import { emptyPartial, openSession, type AskAnswer, type PiSession } from "./agent.js";
import { currentEpoch } from "./packages.js";
import type { PiEvent, PiImage, PiNotice, PiPartial, Snapshot } from "../shared/types.js";

export type { Snapshot };

/** Evict untouched, non-streaming sessions after this long. Hygiene, not memory pressure. */
const IDLE_EVICT_MS = 30 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;

/**
 * How many slash-command output lines to keep per session. `/help` prints
 * dozens; the last screenful is what anyone reads.
 */
const MAX_NOTICES = 40;

/**
 * Prewarming is the whole reason `+ New` feels instant; set PWI_PREWARM=0 to
 * trade that back for one fewer idle `pi` child.
 */
const PREWARM = process.env.PWI_PREWARM !== "0";

interface Entry {
	session: PiSession;
	/** Server-side accumulation so a mid-stream reattach sees partial text, not a hole. */
	partial: PiPartial;
	streaming: boolean;
	error: string | null;
	/**
	 * What local slash commands answered, newest last. Accumulated server-side
	 * for the same reason as `partial`: the output arrives once, and a client
	 * that reloads or reconnects would otherwise never see it. Capped, and
	 * dropped when the next prompt is accepted.
	 */
	notices: PiNotice[];
	lastActivity: number;
	/**
	 * The exact cwd string this session was prewarmed for, or null once it
	 * belongs to a client. A spare is a complete, ready session that nobody has
	 * claimed yet — see Registry.prewarm.
	 */
	spareFor: string | null;
	/**
	 * The package epoch this child was SPAWNED under. pi reads extensions,
	 * skills and prompt templates once, at startup, so a session older than
	 * the newest install cannot see what was installed — which is a thing to
	 * tell the user, not to fix behind their back.
	 */
	epoch: number;
	subscribers: Set<(e: PiEvent) => void>;
	unsubscribe: () => void;
}

export class Registry {
	private entries = new Map<string, Entry>();
	private sweeper: NodeJS.Timeout;
	/** The warm in flight, so a `+ New` mid-spawn joins it instead of spawning a second child. */
	private warming: { cwd: string; work: Promise<void> } | null = null;
	/**
	 * Bumped whenever the spares become wrong (project switch, default-model
	 * change). A warm that started under an older generation lands into a
	 * `dispose()` rather than into somebody's `+ New`.
	 */
	private spareGeneration = 0;

	constructor(
		private cwd: string,
		private defaultModel?: string,
	) {
		this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
		this.sweeper.unref();
	}

	/**
	 * Get a live session, opening it from disk if it is not cached.
	 *
	 * `cwd` only matters for CREATING a session (no `file`): resuming one reads
	 * its cwd from the session header via SessionManager.open, so a project
	 * switch never needs to touch an existing file's home.
	 */
	async acquire(
		id: string | undefined,
		file?: string,
		model?: string,
		cwd?: string,
	): Promise<Entry & { id: string }> {
		if (id) {
			const existing = this.entries.get(id);
			if (existing) {
				existing.lastActivity = Date.now();
				return Object.assign(existing, { id });
			}
		}

		/*
		 * Reuse by FILE, not just by id.
		 *
		 * Opening a file always produced a fresh AgentSession, and since the id is
		 * derived from the file, `entries.set()` then overwrote the previous entry
		 * under the same key. Three things broke at once: the old session was never
		 * disposed, its SSE subscribers were orphaned (a tab that was already
		 * attached went silent forever), and two AgentSessions wrote the same
		 * JSONL.
		 *
		 * Rare when opening required a click. Routine now that a reload restores
		 * the last session automatically — every refresh in a second tab would
		 * mute the first.
		 */
		if (file) {
			for (const [existingId, entry] of this.entries) {
				if (entry.session.file !== file) continue;
				entry.lastActivity = Date.now();
				return Object.assign(entry, { id: existingId });
			}
		}

		/*
		 * A new session may already be sitting there, warm. Claiming it turns the
		 * ~2s spawn that `+ New` used to wait through into a map lookup — see
		 * prewarm. Only the plain create path qualifies: a resume needs THAT file,
		 * and an explicit model is not the one the spare booted with.
		 */
		if (!file && !model) {
			const spare = await this.takeSpare(cwd ?? this.cwd);
			if (spare) {
				// Refill at once, so the NEXT `+ New` is instant too.
				this.prewarm(cwd ?? this.cwd);
				return spare;
			}
		}

		const session = await openSession({
			cwd: cwd ?? this.cwd,
			file,
			model: model ?? this.defaultModel,
		});

		// Belt and braces: if the freshly-opened session collides with a cached id
		// anyway, keep the incumbent (it owns the live subscribers) and discard the
		// duplicate rather than silently replacing it.
		const collision = this.entries.get(session.id);
		if (collision) {
			session.dispose();
			collision.lastActivity = Date.now();
			return Object.assign(collision, { id: session.id });
		}

		return this.install(session, null);
	}

	/**
	 * Wire a freshly-opened session into the cache and start accumulating its
	 * events. Shared with prewarming, which needs the identical wiring: a spare
	 * is a real session, and the accumulation must already be running by the
	 * time a client is handed it.
	 */
	private install(session: PiSession, spareFor: string | null): Entry & { id: string } {
		const entry: Entry = {
			session,
			partial: emptyPartial(),
			streaming: false,
			error: null,
			notices: [],
			lastActivity: Date.now(),
			spareFor,
			epoch: currentEpoch(),
			subscribers: new Set(),
			unsubscribe: () => {},
		};

		// Accumulate server-side, then fan out. Order matters: a subscriber that
		// joins mid-event must never see a delta applied before the snapshot it
		// was built from.
		entry.unsubscribe = session.subscribe((e) => {
			entry.lastActivity = Date.now();
			switch (e.type) {
				case "text":
					entry.streaming = true;
					entry.partial.text += e.delta;
					break;
				case "thinking":
					entry.streaming = true;
					entry.partial.thinking += e.delta;
					break;
				case "tool_start":
					entry.partial.tools.push({ id: e.id, name: e.name, args: e.args });
					break;
				case "tool_update": {
					// Cumulative, so replace rather than append.
					const running = entry.partial.tools.find((t) => t.id === e.id);
					if (running) running.result = e.result;
					break;
				}
				case "tool_end": {
					const t = entry.partial.tools.find((t) => t.id === e.id);
					if (t) {
						t.result = e.result;
						t.isError = e.isError;
					}
					break;
				}
				case "message_done":
					// Settled into session.messages() — clear the partial so a
					// reattach does not render the same content twice.
					entry.partial = emptyPartial();
					break;
				case "notice":
					// Bounded: a chatty command must not turn one session into an
					// unbounded log that every snapshot then carries.
					entry.notices = [...entry.notices, e.notice].slice(-MAX_NOTICES);
					break;
				case "idle":
					entry.streaming = false;
					entry.partial = emptyPartial();
					break;
				case "error":
					entry.error = e.message;
					entry.streaming = false;
					break;
			}

			for (const s of entry.subscribers) {
				try {
					s(e);
				} catch {
					// One broken SSE client must not disturb the others.
				}
			}
		});

		this.entries.set(session.id, entry);
		return Object.assign(entry, { id: session.id });
	}

	/**
	 * Have one new session ready before anybody asks for one.
	 *
	 * `+ New` is a single `pi` spawn away from a snapshot, and that spawn pays
	 * for package, extension and skill discovery before it answers anything.
	 * Nothing makes it faster ON the click, so pay it before the click: an
	 * unprompted child writes no messages to its JSONL, which makes a spare
	 * invisible to the session list and free to throw away.
	 *
	 * Called from the list poll, so the spare follows the project on screen and
	 * its idle clock is reset for as long as that page is open; close the page
	 * and it ages out through the ordinary sweep. Fire-and-forget: a failed warm
	 * costs the next `+ New` full price and nothing else.
	 */
	prewarm(cwd: string): void {
		if (!PREWARM) return;

		const spare = this.findSpare(cwd);
		if (spare) {
			spare.entry.lastActivity = Date.now();
			return;
		}
		if (this.warming?.cwd === cwd) return;

		// One spare, for the project being looked at. A spare for a project the
		// user has left is a held process with no click coming.
		this.discardSpares();

		const warming: { cwd: string; work: Promise<void> } = {
			cwd,
			work: Promise.resolve(),
		};
		warming.work = this.warm(cwd, this.spareGeneration)
			.catch((err) => {
				console.error(
					`[pwi] prewarm failed for ${cwd}:`,
					err instanceof Error ? err.message : err,
				);
			})
			.finally(() => {
				if (this.warming === warming) this.warming = null;
			});
		this.warming = warming;
	}

	private async warm(cwd: string, generation: number): Promise<void> {
		const session = await openSession({ cwd, model: this.defaultModel });

		/*
		 * Two seconds is long enough for the spare to have become wrong — the
		 * project changed, or the default model did. Nobody is handed a session
		 * they did not ask for; drop it and let the next poll warm a correct one.
		 */
		if (generation !== this.spareGeneration || this.entries.has(session.id)) {
			session.dispose();
			return;
		}

		this.install(session, cwd);
	}

	/**
	 * Claim this project's spare, waiting out a warm that is already in flight:
	 * joining a spawn half-done beats starting a second one.
	 */
	private async takeSpare(cwd: string): Promise<(Entry & { id: string }) | undefined> {
		if (this.warming?.cwd === cwd) await this.warming.work;

		const spare = this.findSpare(cwd);
		if (!spare) return undefined;

		// Claimed: an ordinary entry from here on, and no longer discardable.
		spare.entry.spareFor = null;
		spare.entry.lastActivity = Date.now();
		return Object.assign(spare.entry, { id: spare.id });
	}

	private findSpare(cwd: string): { id: string; entry: Entry } | undefined {
		for (const [id, entry] of this.entries) {
			if (entry.spareFor === cwd) return { id, entry };
		}
		return undefined;
	}

	/**
	 * Drop every unclaimed spare and cancel the warm in flight. Needed when the
	 * default model changes: a spare booted under the old default would hand the
	 * user a session running the model they just changed away from.
	 */
	discardSpares(): void {
		this.spareGeneration++;
		this.warming = null;
		for (const [id, entry] of this.entries) {
			if (entry.spareFor === null) continue;
			entry.unsubscribe();
			entry.session.dispose();
			this.entries.delete(id);
		}
	}

	snapshot(entry: Entry, id: string): Snapshot {
		const partial = entry.partial;
		const hasPartial = partial.text || partial.thinking || partial.tools.length > 0;
		return {
			id,
			file: entry.session.file,
			cwd: entry.session.cwd,
			model: entry.session.model,
			messages: entry.session.messages(),
			partial: hasPartial ? partial : null,
			isStreaming: entry.streaming || entry.session.isStreaming,
			error: entry.error,
			notices: entry.notices,
			ask: entry.session.ask,
			commands: entry.session.commands,
			supportsImages: entry.session.supportsImages,
			thinkingLevel: entry.session.thinkingLevel,
			thinkingLevels: entry.session.thinkingLevels,
			contextTokens: entry.session.contextTokens,
			contextWindow: entry.session.contextWindow,
			/**
			 * This child was spawned before the newest package install, so it
			 * cannot see what was installed. The UI offers a restart; nothing
			 * here acts on it.
			 */
			stale: entry.epoch !== currentEpoch(),
		};
	}

	/**
	 * Restart a session's child so it picks up newly installed packages.
	 *
	 * Dispose and reopen from the file: extensions load at process start, so
	 * there is no cheaper way to make an open session see a new one. The
	 * conversation survives because it is on disk and the id is derived from
	 * the file — verified in docs/pi-facts.md §0.4.
	 *
	 * Refused mid-stream, and that refusal is the point: killing a child
	 * halfway through a turn loses the turn, and "your session picked up the
	 * package" is never worth that.
	 */
	async restart(id: string): Promise<Entry & { id: string }> {
		const entry = this.entries.get(id);
		if (!entry) throw new Error(`unknown session: ${id}`);
		if (entry.streaming || entry.session.isStreaming)
			throw new Error("cannot restart a session while it is streaming");
		const file = entry.session.file;
		if (!file) throw new Error("this session has no file yet — prompt it once first");

		// Subscribers are attached to THIS entry, so they are moved across
		// rather than dropped: a tab watching the session must not go silent
		// because the user clicked restart in another panel.
		const subscribers = entry.subscribers;
		entry.unsubscribe();
		entry.session.dispose();
		this.entries.delete(id);

		const fresh = await this.acquire(undefined, file);
		for (const s of subscribers) fresh.subscribers.add(s);
		return fresh;
	}

	/**
	 * Switch the model on an existing session. Disallowed mid-stream: pi has no
	 * defined behavior for swapping models under an in-flight request, and
	 * "stop, then switch" is a confusing implicit action to take on behalf of
	 * the user.
	 */
	async setModel(id: string, spec: string): Promise<void> {
		const entry = this.entries.get(id);
		if (!entry) throw new Error(`unknown session: ${id}`);
		if (entry.streaming || entry.session.isStreaming)
			throw new Error("cannot switch models while streaming");
		entry.lastActivity = Date.now();
		await entry.session.setModel(spec);
	}

	/**
	 * Set the reasoning effort. Allowed mid-stream, unlike a model switch:
	 * pi applies it to the next turn, there is no in-flight request to
	 * confuse, and "wait for the agent to finish before you can tell it to
	 * think harder next time" is a rule with nothing behind it.
	 */
	async setThinkingLevel(id: string, level: string): Promise<void> {
		const entry = this.entries.get(id);
		if (!entry) throw new Error(`unknown session: ${id}`);
		entry.lastActivity = Date.now();
		await entry.session.setThinkingLevel(level);
	}

	/**
	 * Rename a session, opening it from disk if it is not already live.
	 *
	 * Renaming from the session list has to work on a session nobody has
	 * attached to, and pi is the only writer of the name — so this goes
	 * through `acquire`, paying one spawn for a session that was cold. That
	 * entry then sits in the cache like any other and is idle-evicted
	 * normally; the name itself is already on disk.
	 */
	async rename(
		id: string | undefined,
		file: string | undefined,
		name: string,
	): Promise<string> {
		const entry = await this.acquire(id, file);
		entry.lastActivity = Date.now();
		await entry.session.setName(name);
		return name.trim();
	}

	/**
	 * Run a prompt. Every failure is contained to ONE conversation: a provider
	 * 400, an auth failure, a throwing tool, or a context overflow marks this
	 * session errored and notifies its subscribers. The server is unaffected.
	 * This try/catch is the workhorse of the crash policy — the process-level
	 * handlers are a backstop, not the plan.
	 */
	async prompt(id: string, text: string, images?: PiImage[]): Promise<void> {
		const entry = this.entries.get(id);
		if (!entry) throw new Error(`unknown session: ${id}`);

		entry.lastActivity = Date.now();
		entry.error = null;
		// The last command's answer belongs to the last command. Sending anything
		// new is the moment it stops being the thing on screen.
		entry.notices = [];
		entry.streaming = true;

		try {
			await entry.session.prompt(text, images);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			entry.error = message;
			entry.streaming = false;
			// Surface to the UI, not just stderr. A conversation that silently
			// stops updating is the worst debugging experience available.
			for (const s of entry.subscribers) {
				try {
					s({ type: "error", message });
				} catch {
					/* ignore */
				}
			}
		}
	}

	async abort(id: string): Promise<void> {
		const entry = this.entries.get(id);
		if (!entry) return;
		entry.lastActivity = Date.now();
		await entry.session.abort();
	}

	/**
	 * Compact on demand. Refused mid-stream: pi would queue it behind the
	 * running turn, and a button that appears to do nothing for two minutes
	 * is worse than one that says why it did nothing.
	 */
	async compact(id: string): Promise<void> {
		const entry = this.entries.get(id);
		if (!entry) throw new Error(`unknown session: ${id}`);
		if (entry.streaming || entry.session.isStreaming)
			throw new Error("cannot compact while streaming");
		entry.lastActivity = Date.now();
		await entry.session.compact();
	}

	/**
	 * Answer the question pi is blocked on. Not a `prompt`: the agent is
	 * inside a tool call waiting on a dialog, so this goes straight back
	 * through the UI sub-protocol and the turn continues where it stopped.
	 * False means the question is gone (timed out, withdrawn, aborted) and the
	 * client is looking at a stale panel.
	 */
	answerAsk(id: string, askId: string, answer: AskAnswer): boolean {
		const entry = this.entries.get(id);
		if (!entry) throw new Error(`unknown session: ${id}`);
		entry.lastActivity = Date.now();
		return entry.session.answerAsk(askId, answer);
	}

	/** Attach an SSE client. Detaching NEVER aborts — the run continues. */
	attach(id: string, listener: (e: PiEvent) => void): () => void {
		const entry = this.entries.get(id);
		if (!entry) return () => {};
		entry.subscribers.add(listener);
		return () => {
			entry.subscribers.delete(listener);
			entry.lastActivity = Date.now();
		};
	}

	get(id: string): Entry | undefined {
		return this.entries.get(id);
	}

	/**
	 * Whether a live session is backed by this file. Lets the open route tell
	 * "deleted" apart from "created but not yet flushed to disk" — pi writes the
	 * JSONL lazily, so a brand-new session has a path and no file.
	 */
	hasFile(file: string): boolean {
		for (const entry of this.entries.values()) {
			if (entry.session.file === file) return true;
		}
		return false;
	}

	/**
	 * IDs of sessions currently streaming, cached or not. Lets the session list
	 * show a live indicator for background work — the one thing a tab title
	 * cannot convey when you're looking at a *different* session in the same
	 * window.
	 */
	streamingIds(): Set<string> {
		const ids = new Set<string>();
		for (const [id, entry] of this.entries) {
			if (entry.streaming || entry.session.isStreaming) ids.add(id);
		}
		return ids;
	}

	private sweep(): void {
		const now = Date.now();
		for (const [id, entry] of this.entries) {
			// INVARIANT 1. Both checks matter: `streaming` is our accumulated view,
			// `isStreaming` is what the pi child last reported, and either being
			if (entry.streaming || entry.session.isStreaming) continue;
			if (entry.subscribers.size > 0) continue;
			if (now - entry.lastActivity < IDLE_EVICT_MS) continue;

			entry.unsubscribe();
			entry.session.dispose();
			this.entries.delete(id);
		}
	}

	disposeAll(): void {
		clearInterval(this.sweeper);
		for (const entry of this.entries.values()) {
			entry.unsubscribe();
			entry.session.dispose();
		}
		this.entries.clear();
	}
}
