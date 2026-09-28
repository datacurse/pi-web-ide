/**
 * terminals.ts — login shells on real PTYs, addressed by id.
 *
 * The thing this replaces is a second window: an agent session is half the
 * work, and the other half is running the tests it just changed, reading a
 * log, hitting `git diff`. Over an ssh forward from a phone or another
 * machine there is no terminal to switch to, which is exactly when it is
 * needed most.
 *
 * A real PTY, not a piped `bash`: without one there is no job control, no
 * `clear`, no line editing, no `stty size`, and `vim`, `htop` and every
 * progress bar break. That means a native binding — see package.json for why
 * it is the prebuilt fork — and it is the only native dependency here.
 *
 * Shape mirrors registry.ts on purpose: the server owns the process and its
 * scrollback, clients attach and detach freely, and a detached terminal keeps
 * running. Closing a tab does not kill the shell, and neither does closing
 * the browser — a build you started stays started.
 *
 * Keyed by an OPAQUE ID, not by cwd. One shell per project was the first
 * shape, and it could not express the thing terminals are actually used for:
 * a server running in one, tests in another, a shell to poke around in. The
 * id is the server's, minted here, so the client can persist a layout of
 * them and get the same shells back after a reload.
 */

import { spawn, type IPty } from "@homebridge/node-pty-prebuilt-multiarch";
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";

/**
 * How much output to keep per terminal for replay on attach.
 *
 * A reload has to land you back in the same terminal, which means the server
 * has to remember what was on the screen. 256KB is a few thousand lines of
 * ordinary output — enough that a reload during a long build does not lose
 * the context, bounded enough that ten idle terminals cannot cost real
 * memory. It is a byte cap and not a line cap because one `find /` line can
 * be longer than a screenful.
 */
const MAX_SCROLLBACK = 256 * 1024;

/**
 * Ceiling on live shells, across all projects.
 *
 * Terminals are never swept — a killed shell takes its running command with
 * it, so idleness is not evidence that it is disposable — which means the
 * only bound is the one the client asks for. Sixteen is far past any real
 * layout and still cheap; without a cap a loop in a client could fork shells
 * until the machine stopped.
 */
const MAX_TERMINALS = 16;

export interface Term {
	id: string;
	/** Where the shell was started. Never changes; the shell may `cd` freely. */
	cwd: string;
	pty: IPty;
	/** Most recent output, capped at MAX_SCROLLBACK bytes. */
	scrollback: string;
	cols: number;
	rows: number;
	/** Set once the shell exits. An exited terminal is kept until closed. */
	exit: { code: number; signal?: number } | null;
	listeners: Set<(e: TermEvent) => void>;
	/** A Fleet page shell: listed only there, never in a project's dock. */
	fleet: boolean;
}

export type TermEvent =
	| { type: "data"; data: string }
	| { type: "exit"; code: number; signal?: number };

/** What a client needs to render a terminal it is not attached to yet. */
export interface TermInfo {
	id: string;
	cwd: string;
	running: boolean;
}

/**
 * The shell to run. `$SHELL` is the user's own choice and the right default;
 * a systemd user unit does not always carry it, hence the fallback chain.
 */
function shellPath(): string {
	const candidates = [process.env.SHELL, "/bin/bash", "/bin/sh"];
	for (const c of candidates) if (c && existsSync(c)) return c;
	return "/bin/sh";
}

/**
 * Server-wide tmux options, set before each session is made. Invisible on
 * purpose: no status bar, no prefix key to steal Ctrl+B, no Esc delay for vim,
 * and no alternate screen, so output still lands in xterm's own scrollback.
 */
const TMUX_OPTIONS = [
	["status", "off"],
	["prefix", "None"],
	["prefix2", "None"],
	["escape-time", "0"],
	["history-limit", "50000"],
	["terminal-overrides", "*:smcup@:rmcup@"],
];

export class Terminals {
	private terms = new Map<string, Term>();
	/**
	 * The tmux socket each shell lives on, so a shell outlives this server and
	 * the next one re-attaches it. Undefined without tmux: shells are then
	 * plain PTYs that die with the server.
	 */
	private socket: string | undefined;

	constructor(socket?: string) {
		try {
			if (socket) execFileSync("tmux", ["-V"], { stdio: "ignore" });
			this.socket = socket;
		} catch {
			this.socket = undefined;
		}
		this.adopt();
	}

	private tmux(args: string[]): string {
		return execFileSync("tmux", ["-L", this.socket ?? "", "-f", "/dev/null", ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	}

	/** Re-attach every shell a previous server left in tmux, with its history. */
	private adopt(): void {
		if (!this.socket) return;
		let out: string;
		try {
			out = this.tmux(["list-sessions", "-F", "#{session_name}\t#{@pwi_cwd}\t#{@pwi_fleet}\t#{window_width}\t#{window_height}"]);
		} catch {
			return; // no tmux server: nothing survived
		}
		for (const line of out.split("\n")) {
			const [id, cwd, fleet, w, h] = line.split("\t");
			if (!id || !cwd) continue;
			const rows = Number(h) || 24;
			let history = "";
			try {
				history = this.tmux(["capture-pane", "-p", "-e", "-J", "-S", "-", "-E", "-1", "-t", `=${id}:`]);
			} catch {
				/* no history is still a shell */
			}
			const term = this.open(id, cwd, Number(w) || 80, rows, "/", fleet === "1");
			// Pushed above the screen, which the attach redraws over.
			term.scrollback = (history.replaceAll("\n", "\r\n") + "\r\n".repeat(rows)).slice(-MAX_SCROLLBACK);
		}
	}

	/**
	 * Start a shell and return it.
	 *
	 * Every call is a NEW terminal: splitting and opening a tab are the same
	 * operation to the server, and the difference between them is a layout the
	 * client owns. Nothing here knows about tabs or panes, which is why one
	 * shell can be moved between them without touching its process.
	 */
	create(cwd: string, cols = 80, rows = 24, dir = cwd, fleet?: { run?: string }): Term {
		// `cwd` is the project the shell is listed under; `dir` is where it
		// starts, so "Open in Terminal" on a subfolder stays in its project.
		for (const d of [cwd, dir])
			if (!(existsSync(d) && statSync(d).isDirectory())) throw new Error(`not a directory: ${d}`);
		if (this.live().length >= MAX_TERMINALS)
			throw new Error(`too many terminals (${MAX_TERMINALS}); close one first`);

		const id = randomUUID();
		if (this.socket) {
			const set = TMUX_OPTIONS.flatMap(([k, v]) => [";", "set", "-g", k, v]);
			this.tmux([
				// set-environment, not `new-session -e`, which tmux 3.0 lacks.
				"start-server", ...set, ";", "set-environment", "-g", "PWI_TERMINAL", "1",
				";", "new-session", "-d", "-s", id, "-c", dir, "-x", String(cols), "-y", String(rows),
				shellPath(), "-l",
				";", "set", "-t", `=${id}:`, "@pwi_cwd", cwd,
				";", "set", "-t", `=${id}:`, "@pwi_fleet", fleet ? "1" : "0",
				// Typed into the shell rather than run instead of it, so leaving the
				// command (an ssh session) lands in a local shell, not a dead tab.
				...(fleet?.run ? [";", "send-keys", "-t", `=${id}:`, fleet.run, "Enter"] : []),
			]);
		}
		const term = this.open(id, cwd, cols, rows, dir, !!fleet);
		if (!this.socket && fleet?.run) term.pty.write(`${fleet.run}\r`);
		return term;
	}

	/** The PTY: a tmux client on session `id`, or the shell itself without tmux. */
	private open(id: string, cwd: string, cols: number, rows: number, dir: string, fleet: boolean): Term {
		const term: Term = {
			id,
			cwd,
			pty: spawn(
				this.socket ? "tmux" : shellPath(),
				this.socket ? ["-L", this.socket, "attach-session", "-t", `=${id}`] : ["-l"],
				{
					cwd: dir,
					cols,
					rows,
					name: "xterm-256color",
					env: {
						...(process.env as Record<string, string>),
						// Claimed by the shell's prompt and by every program that
						// asks. Lying about it (the inherited "dumb" of a systemd
						// unit, or nothing at all) is what makes colors and cursor
						// addressing silently degrade.
						TERM: "xterm-256color",
						// So a shell profile, and anything run from it, can tell.
						PWI_TERMINAL: "1",
					},
				},
			),
			scrollback: "",
			cols,
			rows,
			exit: null,
			listeners: new Set(),
			fleet,
		};

		term.pty.onData((data) => {
			term.scrollback = (term.scrollback + data).slice(-MAX_SCROLLBACK);
			for (const l of [...term.listeners]) {
				try {
					l({ type: "data", data });
				} catch {
					// One broken socket must not take the shell down.
				}
			}
		});

		/*
		 * An exited terminal is KEPT, not deleted: the last thing a failed
		 * command printed is the reason you opened the terminal, and dropping
		 * the entry would drop that with it. The client closes it explicitly.
		 */
		term.pty.onExit(({ exitCode, signal }) => {
			term.exit = { code: exitCode, signal };
			for (const l of [...term.listeners]) {
				try {
					l({ type: "exit", code: exitCode, signal });
				} catch {
					/* ignore */
				}
			}
		});

		this.terms.set(term.id, term);
		return term;
	}

	get(id: string): Term | undefined {
		return this.terms.get(id);
	}

	private live(): Term[] {
		return [...this.terms.values()].filter((t) => !t.exit);
	}

	/**
	 * The terminals of one project, or of all of them.
	 *
	 * This is how a reloaded client recovers: it persists a layout of ids, and
	 * this says which of them are still real. Without it a restored layout
	 * would render panes attached to shells that no longer exist.
	 */
	list(cwd?: string, fleet = false): TermInfo[] {
		return [...this.terms.values()]
			.filter((t) => t.fleet === fleet && (!cwd || t.cwd === cwd))
			.map((t) => ({ id: t.id, cwd: t.cwd, running: !t.exit }));
	}

	/**
	 * Attach a client: the scrollback first, then everything new.
	 *
	 * Replay before subscribe, and both inside one call, because the gap
	 * between them is where output goes missing — a line written between
	 * reading the buffer and adding the listener would be in neither.
	 */
	attach(id: string, listener: (e: TermEvent) => void): () => void {
		const term = this.terms.get(id);
		if (!term) return () => {};
		if (term.scrollback) listener({ type: "data", data: term.scrollback });
		if (term.exit) listener({ type: "exit", ...term.exit });
		term.listeners.add(listener);
		return () => term.listeners.delete(listener);
	}

	write(id: string, data: string): void {
		const term = this.terms.get(id);
		if (term && !term.exit) term.pty.write(data);
	}

	/**
	 * Resize the PTY.
	 *
	 * The size is the client's, and with several clients attached the LAST
	 * one to report wins — same as two tmux clients on one window. Ignoring
	 * resizes instead would leave a full-screen program drawing at 80x24 in a
	 * wide pane, which is the visibly broken case.
	 */
	resize(id: string, cols: number, rows: number): void {
		const term = this.terms.get(id);
		if (!term || term.exit) return;
		if (cols < 2 || rows < 2 || cols > 1000 || rows > 1000) return;
		if (term.cols === cols && term.rows === rows) return;
		term.cols = cols;
		term.rows = rows;
		term.pty.resize(cols, rows);
	}

	/**
	 * Kill a terminal and everything in it.
	 *
	 * Deliberately explicit: hiding the pane, closing the browser and losing
	 * the socket all leave the shell running, and only this ends it. SIGHUP
	 * rather than SIGKILL, so the shell tells its children the terminal went
	 * away — the same signal closing a terminal window sends, which is what
	 * `nohup` and a shell's own job handling expect.
	 */
	close(id: string): void {
		const term = this.terms.get(id);
		if (!term) return;
		this.terms.delete(id);
		if (this.socket) {
			try {
				this.tmux(["kill-session", "-t", `=${id}`]);
			} catch {
				// Already gone.
			}
		}
		if (!term.exit) {
			try {
				term.pty.kill("SIGHUP");
			} catch {
				// Already gone; the exit handler has the rest.
			}
		}
		term.listeners.clear();
	}

	/**
	 * Called on server exit. Under tmux this only detaches, so the next server
	 * adopts the shells; without it every shell is killed, so none are orphaned.
	 */
	disposeAll(): void {
		for (const [id, term] of [...this.terms]) {
			if (!this.socket) {
				this.close(id);
				continue;
			}
			this.terms.delete(id);
			term.listeners.clear();
			try {
				term.pty.kill("SIGHUP");
			} catch {
				/* already gone */
			}
		}
	}
}
