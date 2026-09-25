import { Fragment, useEffect, useRef, useState } from "react";
import { Columns, Plus, Rows, X } from "@phosphor-icons/react";
import type { Terminal as XTerm } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

import {
	activeTab,
	addTab,
	focusTerminal,
	removeTerminal,
	resizeSplit,
	selectTab,
	splitActive,
	toggleDirection,
	type TermLayout,
} from "./termLayout.js";
import { Button, IconButton } from "./ui.js";

/**
 * xterm.js, loaded on demand.
 *
 * Same trade as KaTeX (see Math.tsx): ~280KB that a session which never opens
 * the panel should not pay for, behind a module-level promise so the second
 * open is instant. The stylesheet is imported eagerly in index.css, because a
 * terminal rendered before its CSS lands is a column of unpositioned
 * characters rather than a blank.
 */
interface XTermModules {
	Terminal: typeof XTerm;
	FitAddon: typeof FitAddon;
}

let loading: Promise<XTermModules> | null = null;

function load(): Promise<XTermModules> {
	loading ??= Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]).then(
		([term, fit]) => ({ Terminal: term.Terminal, FitAddon: fit.FitAddon }),
	);
	return loading;
}

/**
 * The colors are the app's own, read from the theme at mount.
 *
 * xterm.js takes concrete colors, not CSS variables — it paints to a canvas,
 * where `var(--x)` means nothing — so the values are resolved out of the
 * document once. Without this the terminal is the one panel that ignores the
 * theme, on a black background that no theme here uses.
 */
function themeColors(host: HTMLElement) {
	const style = getComputedStyle(host);
	const pick = (name: string, fallback: string) =>
		style.getPropertyValue(name).trim() || fallback;
	return {
		background: pick("--color-neutral-950", "#0a0a0a"),
		foreground: pick("--color-neutral-200", "#e5e5e5"),
		cursor: pick("--color-amber-400", "#fbbf24"),
		selectionBackground: pick("--color-neutral-700", "#404040"),
	};
}

/**
 * A live shell for the project, in the right-hand pane.
 *
 * The socket carries JSON both ways (`input`/`resize` up, `data`/`exit`
 * down), and the process itself lives on the server — see terminals.ts. That
 * is what makes this panel disposable: unmounting it detaches, and the shell,
 * with whatever is running in it, stays.
 */
export function Terminal({
	id,
	focused,
	onFocus,
	onExit,
}: {
	id: string;
	/** The layout's focused pane, so a split can be pointed at by keyboard. */
	focused?: boolean;
	onFocus?: () => void;
	onExit?: () => void;
}) {
	const host = useRef<HTMLDivElement | null>(null);
	const view = useRef<XTerm | null>(null);
	const [error, setError] = useState<string | null>(null);

	/*
	 * Keyed on the terminal id, and everything below is torn down when it
	 * changes: a pane showing a different shell is a different socket, a
	 * different scrollback and a different xterm, never a reset one.
	 */
	useEffect(() => {
		const node = host.current;
		if (!node) return;

		let live = true;
		let term: XTerm | null = null;
		let socket: WebSocket | null = null;
		let observer: ResizeObserver | null = null;
		let retry: ReturnType<typeof setTimeout> | null = null;
		let attempt = 0;
		/*
		 * Set when the server has told us this terminal will never answer again
		 * (it is gone, or its shell exited). Retrying then is a loop that can
		 * only ever print the same error, so the socket stays closed.
		 */
		let finished = false;
		/*
		 * Whether this pane has EVER had a socket open. A shell that attached
		 * once and dropped is a transient failure worth retrying quietly; one
		 * that has never attached at all is usually a refused upgrade, which no
		 * amount of retrying fixes — see the diagnosis in `explain` below.
		 */
		let everOpened = false;

		/**
		 * Say why the socket will not open, once retrying has clearly failed.
		 *
		 * `[reconnecting…]` forever is the worst of both worlds: the shell is
		 * fine, the server is fine, and the pane looks merely slow. The one
		 * question that separates the causes is whether the server answers HTTP
		 * at all — if it does, and the upgrade still never opens, the upgrade is
		 * being refused rather than lost.
		 */
		const explain = async () => {
			const healthy = await fetch("/api/health")
				.then((r) => r.ok)
				.catch(() => false);
			if (!live || everOpened) return;
			setError(
				healthy
					? // originAllowed() in server/index.ts refuses an upgrade whose
					  // Origin is not its own, and the Vite proxy rewrites Host but
					  // not Origin — so a dev page served from Vite is refused unless
					  // the server was started with PWI_DEV=1 to allow it.
					  `The server is up but refused the terminal connection. If this page is Vite's (${location.host}), start the server with \`pnpm dev\` rather than \`pnpm start\`, or open it directly instead.`
					: "Cannot reach the server. Still retrying.",
			);
		};

		void load().then(({ Terminal: XTermCtor, FitAddon: Fit }) => {
			if (!live || !host.current) return;

			term = new XTermCtor({
				fontFamily:
					'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
				// The `text-body` token: terminal output is content. xterm wants
				// a number, so it is read from the CSS rather than duplicated.
				fontSize:
					parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--text-body")) ||
					14,
				// Enough that a reload is not the only way to see what scrolled
				// past, and small enough that it is not a memory decision.
				scrollback: 5000,
				cursorBlink: true,
				theme: themeColors(host.current),
				// The pane is resizable, so a fixed width would either clip or
				// leave a gutter. Reflow keeps wrapped output readable after a
				// drag instead of leaving it wrapped at the old width.
				allowProposedApi: true,
			});
			const fit = new Fit();
			term.loadAddon(fit);
			term.open(host.current);
			fit.fit();
			view.current = term;
			// A split that is created focused should take the keyboard without a
			// click: the gesture that made it was already a decision to use it.
			if (focused) term.focus();

			/*
			 * Attach, and keep attaching.
			 *
			 * A socket dies for reasons that have nothing to do with the shell —
			 * the server restarted, the laptop slept, WSL dropped the loopback —
			 * and the shell survives every one of them (see terminals.ts: close
			 * is a detach). A pane that gave up on the first close was therefore
			 * permanently dead next to a process that was still running, with no
			 * way back short of a reload.
			 */
			const connect = () => {
				if (!live || !term || finished) return;
				// The shell is this server's, so the socket is same-origin:
				// `location` is the whole address, and wss: follows from https.
				const proto = location.protocol === "https:" ? "wss:" : "ws:";
				const url = `${proto}//${location.host}/api/terminal/socket?id=${encodeURIComponent(id)}&cols=${term.cols}&rows=${term.rows}`;
				const ws = new WebSocket(url);
				socket = ws;

				ws.onopen = () => {
					// The server replays its whole scrollback on attach, so a
					// reattach without this prints the session twice. It owns the
					// buffer; the pane just shows what it is sent.
					if (attempt > 0) term?.reset();
					attempt = 0;
					everOpened = true;
					setError(null);
				};

				ws.onmessage = (ev) => {
					let msg: { type?: string; data?: string; message?: string; code?: number };
					try {
						msg = JSON.parse(ev.data as string);
					} catch {
						return;
					}
					if (msg.type === "data" && typeof msg.data === "string") term?.write(msg.data);
					else if (msg.type === "exit") {
						// The shell itself ended. Nothing to reattach to.
						finished = true;
						term?.write(`\r\n\x1b[90m[shell exited${msg.code ? ` (${msg.code})` : ""}]\x1b[0m\r\n`);
						onExit?.();
					} else if (msg.type === "error") {
						// "no such terminal": the id in the restored layout is not on
						// this server. Retrying cannot conjure it.
						finished = true;
						setError(msg.message ?? "terminal failed");
					}
				};

				ws.onclose = () => {
					if (!live || finished) return;
					// Backoff to 5s: the common case is a dev-server restart, back
					// within a second, and the uncommon one must not spin.
					const wait = Math.min(250 * 2 ** attempt, 5000);
					attempt += 1;
					if (attempt === 1) term?.write("\r\n\x1b[90m[reconnecting…]\x1b[0m\r\n");
					// Three failures without ever opening is no longer a blip. Once,
					// not per attempt: the banner would otherwise refetch forever.
					if (attempt === 3 && !everOpened) void explain();
					retry = setTimeout(connect, wait);
				};
			};
			connect();

			term.onData((data) => {
				if (socket?.readyState === WebSocket.OPEN)
					socket.send(JSON.stringify({ type: "input", data }));
			});

			/*
			 * The PTY has to be told the size or full-screen programs draw at
			 * 80x24 inside a 200-column pane. ResizeObserver rather than a window
			 * listener, because the pane is resized by dragging the divider,
			 * which is not a window resize.
			 */
			observer = new ResizeObserver(() => {
				if (!live || !term) return;
				fit.fit();
				if (socket?.readyState === WebSocket.OPEN)
					socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
			});
			observer.observe(node);
		});

		return () => {
			live = false;
			if (retry) clearTimeout(retry);
			observer?.disconnect();
			socket?.close();
			term?.dispose();
			view.current = null;
		};
		// `focused` is deliberately absent: it decides the INITIAL focus, and
		// re-running this on every focus change would tear down the socket and
		// the scrollback with it. The effect below moves focus instead.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [id, origin, onExit]);

	// Focus follows the layout, so clicking one pane and then splitting puts
	// the keyboard in the new shell without a second click.
	useEffect(() => {
		if (focused) view.current?.focus();
	}, [focused]);

	return (
		<div
			// Mousedown, not click: a drag that selects text in a pane is also a
			// decision about which pane is current, and it ends outside.
			onMouseDown={onFocus}
			className="flex min-h-0 min-w-0 flex-1 flex-col bg-neutral-950"
		>
			{error && (
				<div className="border-b border-red-900 bg-red-950/40 px-3 py-2 text-meta text-red-300">
					{error}
				</div>
			)}
			{/* The padding is on this wrapper, never on the xterm host: xterm
			    measures its own element to decide how many columns fit, and
			    padding there makes the last column fall off the right edge. */}
			<div className="min-h-0 flex-1 overflow-hidden p-2">
				<div ref={host} className="h-full w-full" />
			</div>
		</div>
	);
}

/**
 * The right-hand pane: a strip of terminal tabs, and the active tab's splits
 * under it.
 *
 * Three separate exits, and keeping them separate is the point:
 *
 *   - **Hide** (the tab-strip toggle, or `×` here) leaves every shell
 *     running. That is the whole reason the processes live on the server.
 *   - **Close a split/tab** kills that one shell (SIGHUP) and drops its pane.
 *   - Nothing here kills a shell implicitly. A reload, a lost socket and a
 *     closed browser are all just detaches.
 *
 * The layout is the client's (termLayout.ts) and the shells are the
 * server's, which is why a split can be opened, hidden and restored after a
 * reload without the process noticing.
 */
export function TerminalPane({
	cwd,
	ready,
	layout,
	onLayout,
	onClose,
}: {
	cwd: string;
	/**
	 * Whether the layout has been reconciled with the server's terminal list.
	 * The first shell is only started after that: starting one earlier would
	 * mint a second shell next to the one the stored layout already names.
	 */
	ready: boolean;
	layout: TermLayout;
	onLayout: (next: TermLayout) => void;
	onClose: () => void;
}) {
	const [error, setError] = useState<string | null>(null);
	/** The splits row, measured while dragging one of its dividers. */
	const splits = useRef<HTMLDivElement | null>(null);
	/** Guards the auto-start against React's double-invoked effects. */
	const starting = useRef(false);
	const tab = activeTab(layout);

	/**
	 * Ask the server for a shell, then put it somewhere.
	 *
	 * Creation is one call for both gestures — a tab and a split are the same
	 * process, differing only in where the layout draws it — so `place` is the
	 * whole difference between them.
	 */
	const spawn = async (place: (l: TermLayout, id: string) => TermLayout) => {
		setError(null);
		const r = await fetch(`/api/terminals`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ cwd }),
		});
		const body = (await r.json().catch(() => ({}))) as { id?: string; error?: string };
		// A refusal (the MAX_TERMINALS cap, a cwd that stopped existing) has to
		// surface here: there is no shell to print it in.
		if (!r.ok || !body.id) {
			setError(body.error ?? `could not start a shell (${r.status})`);
			return;
		}
		onLayout(place(layout, body.id));
	};

	/*
	 * Opening the pane with nothing in it starts one shell. The pane exists to
	 * be typed in, so "here is an empty pane, now click Start" is a step with
	 * no decision in it — the manual button below is only for the case where
	 * this failed.
	 */
	useEffect(() => {
		if (!ready || layout.tabs.length > 0 || starting.current) return;
		starting.current = true;
		void spawn(addTab).finally(() => {
			starting.current = false;
		});
		// `spawn` closes over the layout, which is exactly the empty one this
		// condition already checked; re-running on every layout change would
		// be a second shell.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ready, layout.tabs.length]);

	/**
	 * Killing the shell and dropping the pane, in that order.
	 *
	 * The DELETE is not awaited before the layout changes: the pane is gone
	 * from the user's point of view the moment they click, and a slow kill
	 * would otherwise leave a dead-looking split on screen.
	 */
	const closeTerm = (id: string) => {
		onLayout(removeTerminal(layout, id));
		void fetch(`/api/terminals/${encodeURIComponent(id)}`, { method: "DELETE" });
	};

	/**
	 * Divider drag between two splits.
	 *
	 * Same shape as the chat/terminal divider in App: capture the pointer,
	 * measure the track once, and convert to a percentage of it — a 1px-per-
	 * pixel model would break the moment the pane itself is resized.
	 */
	const startDrag = (index: number) => (event: React.PointerEvent<HTMLDivElement>) => {
		if (event.button !== 0 || !tab) return;
		const box = splits.current?.getBoundingClientRect();
		if (!box || box.width === 0 || box.height === 0) return;
		const handle = event.currentTarget;
		handle.setPointerCapture(event.pointerId);
		event.preventDefault();

		const vertical = tab.direction === "column";
		const total = vertical ? box.height : box.width;
		const start = vertical ? box.top : box.left;
		// The share of the track that everything BEFORE this pair occupies:
		// the drag only redistributes the pair, so the offset is fixed.
		const before = tab.sizes.slice(0, index).reduce((sum, s) => sum + s, 0);

		const move = (moved: PointerEvent) => {
			const at = ((vertical ? moved.clientY : moved.clientX) - start) / total;
			onLayout(resizeSplit(layout, index, at * 100 - before));
		};
		const end = () => {
			handle.removeEventListener("pointermove", move);
			handle.removeEventListener("pointerup", end);
			handle.removeEventListener("pointercancel", end);
		};
		handle.addEventListener("pointermove", move);
		handle.addEventListener("pointerup", end);
		handle.addEventListener("pointercancel", end);
	};

	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col border-l border-neutral-800">
			<div className="flex items-stretch gap-1 border-b border-neutral-800 bg-neutral-950 px-1">
				{/* Tabs are numbered, not named: a shell has no title until it is
				    running something, and `bash` on all of them is noise. The
				    number is the position, which is what a hand reaches for. */}
				<div className="flex min-w-0 flex-1 items-stretch gap-0.5 overflow-x-auto">
					{layout.tabs.map((t, i) => (
						<button
							data-custom="tab"
							key={i}
							onClick={() => onLayout(selectTab(layout, i))}
							aria-current={i === layout.active}
							title={`Terminal tab ${i + 1}${t.terminals.length > 1 ? ` (${t.terminals.length} splits)` : ""}`}
							className={`shrink-0 rounded-t-sm px-2 py-1 font-mono text-ui transition-colors duration-150 ease-out hover:text-neutral-100 motion-reduce:transition-none ${
								i === layout.active
									? "bg-neutral-800 text-amber-400"
									: "text-neutral-400 hover:bg-neutral-900"
							}`}
						>
							{i + 1}
							{t.terminals.length > 1 && (
								<span className="text-neutral-500">{`·${t.terminals.length}`}</span>
							)}
						</button>
					))}
					<IconButton
						size="sm"
						className="self-center"
						onClick={() => void spawn(addTab)}
						label="New terminal tab"
					>
						<Plus size={13} />
					</IconButton>
				</div>

				<IconButton
					size="sm"
					className="self-center"
					onClick={() => void spawn(splitActive)}
					label="Split terminal"
					title="Split: another shell beside this one"
				>
					{/* The icon shows the direction the new pane will appear in. */}
					{tab?.direction === "column" ? <Rows size={14} /> : <Columns size={14} />}
				</IconButton>
				{tab && tab.terminals.length > 1 && (
					<IconButton
						size="sm"
						className="self-center"
						onClick={() => onLayout(toggleDirection(layout))}
						label="Change split direction"
						title={
							tab.direction === "row"
								? "Stack the splits vertically"
								: "Put the splits side by side"
						}
					>
						{tab.direction === "row" ? <Rows size={14} /> : <Columns size={14} />}
					</IconButton>
				)}
				<IconButton
					size="sm"
					className="self-center"
					onClick={onClose}
					label="Hide terminal"
					title="Hide (every shell keeps running)"
				>
					<X size={13} />
				</IconButton>
			</div>

			{error && (
				<div className="border-b border-red-900 bg-red-950/40 px-3 py-2 text-meta text-red-300">
					{error}
				</div>
			)}

			{!tab ? (
				<div className="flex flex-1 items-center justify-center p-4 text-center text-meta text-neutral-500">
					No shell yet.
					<Button variant="subtle" size="sm" className="ml-2" onClick={() => void spawn(addTab)}>
						Start one
					</Button>
				</div>
			) : (
				<div
					ref={splits}
					className={`flex min-h-0 min-w-0 flex-1 ${tab.direction === "column" ? "flex-col" : "flex-row"}`}
				>
					{tab.terminals.map((id, i) => (
						<Fragment key={id}>
							{i > 0 && (
								<div
									role="separator"
									aria-orientation={tab.direction === "column" ? "horizontal" : "vertical"}
									aria-label="Resize split"
									onPointerDown={startDrag(i - 1)}
									className={`relative shrink-0 bg-neutral-800 hover:bg-amber-600 ${
										tab.direction === "column"
											? "h-1 cursor-row-resize after:absolute after:inset-x-0 after:-top-1 after:-bottom-1 after:content-['']"
											: "w-1 cursor-col-resize after:absolute after:inset-y-0 after:-left-1 after:-right-1 after:content-['']"
									}`}
								/>
							)}
							{/* The share goes through a custom property so one rule
							    covers both directions: `flex-basis` is along the
							    main axis whichever way the row is pointing. */}
							<div
								className={`relative flex min-h-0 min-w-0 flex-col [flex:0_0_var(--split)] ${
									tab.focus === id && tab.terminals.length > 1
										? "ring-1 ring-amber-700/60 ring-inset"
										: ""
								}`}
								style={{ "--split": `${tab.sizes[i] ?? 100 / tab.terminals.length}%` } as React.CSSProperties}
							>
								<Terminal
									id={id}
									focused={tab.focus === id}
									onFocus={() => onLayout(focusTerminal(layout, id))}
								/>
								{/* On the pane, not in the strip: with four splits open
								    a single close button in the header would be
								    ambiguous about which shell it ends. */}
								<IconButton
									size="sm"
									className="absolute top-1 right-2 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 [div:hover>&]:opacity-100"
									onClick={() => closeTerm(id)}
									label="Close this shell"
									title="Close this shell (SIGHUP)"
								>
									<X size={13} />
								</IconButton>
							</div>
						</Fragment>
					))}
				</div>
			)}
		</div>
	);
}
