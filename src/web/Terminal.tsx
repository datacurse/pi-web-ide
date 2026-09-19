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
	origin,
	focused,
	onFocus,
	onExit,
}: {
	id: string;
	/** Where this project's piw answers: "" for this page's own server, else a machine's origin with no trailing slash. */
	origin: string;
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

		void load().then(({ Terminal: XTermCtor, FitAddon: Fit }) => {
			if (!live || !host.current) return;

			term = new XTermCtor({
				fontFamily:
					'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
				fontSize: 13,
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

			// Another machine's shell is on its own origin; same-origin keeps
			// working through `location` when there is none.
			const base = origin ? new URL(origin) : location;
			const proto = base.protocol === "https:" ? "wss:" : "ws:";
			const url = `${proto}//${base.host}/api/terminal/socket?id=${encodeURIComponent(id)}&cols=${term.cols}&rows=${term.rows}`;
			socket = new WebSocket(url);

			socket.onmessage = (ev) => {
				let msg: { type?: string; data?: string; message?: string; code?: number };
				try {
					msg = JSON.parse(ev.data as string);
				} catch {
					return;
				}
				if (msg.type === "data" && typeof msg.data === "string") term?.write(msg.data);
				else if (msg.type === "exit") {
					term?.write(`\r\n\x1b[90m[shell exited${msg.code ? ` (${msg.code})` : ""}]\x1b[0m\r\n`);
					onExit?.();
				} else if (msg.type === "error") setError(msg.message ?? "terminal failed");
			};
			// Not an error state: the server was restarted, or the page is being
			// unloaded. The scrollback stays on screen, and reopening the panel
			// reattaches to whatever is there now.
			socket.onclose = () => {
				if (live) term?.write("\r\n\x1b[90m[disconnected]\x1b[0m\r\n");
			};

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
				<div className="border-b border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">
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
	origin,
	ready,
	layout,
	onLayout,
	onClose,
}: {
	cwd: string;
	/** Where this project's piw answers: "" for this page's own server, else a machine's origin with no trailing slash. */
	origin: string;
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
		const r = await fetch(`${origin}/api/terminals`, {
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
		void fetch(`${origin}/api/terminals/${encodeURIComponent(id)}`, { method: "DELETE" });
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
							key={i}
							onClick={() => onLayout(selectTab(layout, i))}
							aria-current={i === layout.active}
							title={`Terminal tab ${i + 1}${t.terminals.length > 1 ? ` (${t.terminals.length} splits)` : ""}`}
							className={`shrink-0 rounded-t px-2 py-1 font-mono text-xs transition-colors duration-150 ease-out hover:text-neutral-100 motion-reduce:transition-none ${
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
					<button
						onClick={() => void spawn(addTab)}
						aria-label="New terminal tab"
						title="New terminal tab"
						className="flex shrink-0 items-center rounded px-1.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
					>
						<Plus size={13} />
					</button>
				</div>

				<button
					onClick={() => void spawn(splitActive)}
					aria-label="Split terminal"
					title="Split: another shell beside this one"
					className="flex shrink-0 items-center self-center rounded px-1.5 py-0.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
				>
					{/* The icon shows the direction the new pane will appear in. */}
					{tab?.direction === "column" ? <Rows size={14} /> : <Columns size={14} />}
				</button>
				{tab && tab.terminals.length > 1 && (
					<button
						onClick={() => onLayout(toggleDirection(layout))}
						aria-label="Change split direction"
						title={
							tab.direction === "row"
								? "Stack the splits vertically"
								: "Put the splits side by side"
						}
						className="flex shrink-0 items-center self-center rounded px-1.5 py-0.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
					>
						{tab.direction === "row" ? <Rows size={14} /> : <Columns size={14} />}
					</button>
				)}
				<button
					onClick={onClose}
					aria-label="Hide terminal"
					title="Hide (every shell keeps running)"
					className="shrink-0 self-center rounded px-1.5 py-0.5 text-sm leading-none text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
				>
					<X size={13} />
				</button>
			</div>

			{error && (
				<div className="border-b border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">
					{error}
				</div>
			)}

			{!tab ? (
				<div className="flex flex-1 items-center justify-center p-4 text-center text-xs text-neutral-500">
					No shell yet.
					<button
						onClick={() => void spawn(addTab)}
						className="ml-1 text-amber-400 underline hover:text-amber-300"
					>
						Start one
					</button>
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
									origin={origin}
									focused={tab.focus === id}
									onFocus={() => onLayout(focusTerminal(layout, id))}
								/>
								{/* On the pane, not in the strip: with four splits open
								    a single close button in the header would be
								    ambiguous about which shell it ends. */}
								<button
									onClick={() => closeTerm(id)}
									aria-label="Close this shell"
									title="Close this shell (SIGHUP)"
									className="absolute top-1 right-2 rounded px-1 text-xs leading-none text-neutral-600 opacity-0 transition-opacity duration-150 ease-out hover:bg-neutral-800 hover:text-neutral-100 focus-visible:opacity-100 motion-reduce:transition-none group-hover:opacity-100 [div:hover>&]:opacity-100"
								>
									<X size={13} />
								</button>
							</div>
						</Fragment>
					))}
				</div>
			)}
		</div>
	);
}
