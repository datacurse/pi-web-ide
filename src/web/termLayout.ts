/**
 * The terminal pane's layout: tabs, and a row or column of splits inside
 * each one.
 *
 * Deliberately NOT a split tree. A tree is what tmux and every editor grew
 * into, and it brings a whole vocabulary with it — focus traversal, promoting
 * a pane when its sibling closes, serialising nested sizes. One level of
 * splits per tab covers "server here, tests there, shell to poke around in",
 * and the tab strip handles the dimension a tree would be for.
 *
 * The SERVER owns the shells (terminals.ts) and this owns where they are
 * drawn. That separation is what makes a shell survivable: it can be moved
 * between tabs, hidden, or restored after a reload without its process
 * noticing.
 *
 * Pure and serialisable on purpose: it goes into localStorage per project and
 * comes back through `parseLayout` and `reconcile`, which is where a stored
 * arrangement meets the shells that actually still exist.
 */

/** A row of splits (side by side) or a column (stacked). */
export type SplitDirection = "row" | "column";

export interface TermTab {
	/** Terminal ids, in draw order. Never empty in a stored layout. */
	terminals: string[];
	direction: SplitDirection;
	/**
	 * Percentages, one per terminal, summing to 100. Stored rather than
	 * derived so dragging a divider survives a reload — and kept as shares of
	 * the pane, not pixels, so the same layout fits a phone and a monitor.
	 */
	sizes: number[];
	/**
	 * The focused pane WITHIN this tab, which is what "split" and "close" act
	 * on. Per tab and not one field on the layout, because switching away and
	 * back has to land on the pane you left: a single focus would make every
	 * return to a tab jump to its first split.
	 */
	focus: string;
}

export interface TermLayout {
	tabs: TermTab[];
	/** Index into `tabs`. Clamped by every operation here, never by callers. */
	active: number;
}

export const EMPTY_LAYOUT: TermLayout = { tabs: [], active: 0 };

/** A pane narrower than this is not a pane, it is a seam. */
export const MIN_SPLIT_PERCENT = 10;

const clampIndex = (i: number, length: number) =>
	length === 0 ? 0 : Math.min(length - 1, Math.max(0, i));

/** Equal shares. Used whenever the number of splits changes. */
function evenSizes(n: number): number[] {
	return Array.from({ length: n }, () => 100 / n);
}

function newTab(id: string): TermTab {
	return { terminals: [id], direction: "row", sizes: [100], focus: id };
}

export function activeTab(layout: TermLayout): TermTab | undefined {
	return layout.tabs[layout.active];
}

/** The pane the keyboard is in, or null when there is no terminal at all. */
export function focusedTerminal(layout: TermLayout): string | null {
	return activeTab(layout)?.focus ?? null;
}

/** Every terminal the layout references, across all tabs. */
export function allTerminals(layout: TermLayout): string[] {
	return layout.tabs.flatMap((t) => t.terminals);
}

/**
 * A new tab holding one terminal, made active.
 *
 * Opening a tab and splitting are the same server call — a new shell — and
 * differ only here, which is why both paths take an id that already exists.
 */
export function addTab(layout: TermLayout, id: string): TermLayout {
	const tabs = [...layout.tabs, newTab(id)];
	return { tabs, active: tabs.length - 1 };
}

/**
 * Add a terminal beside the focused one, in the active tab.
 *
 * Inserted AFTER the focused pane rather than appended: a split appears next
 * to the thing you split, which is the only placement that matches the
 * gesture. Sizes are reset to even shares — taking the new pane's room out of
 * the focused one alone would make each split of a tab progressively thinner
 * for no reason the user could see.
 */
export function splitActive(layout: TermLayout, id: string): TermLayout {
	const tab = activeTab(layout);
	if (!tab) return addTab(layout, id);
	const at = tab.terminals.indexOf(tab.focus);
	const terminals = [...tab.terminals];
	terminals.splice(at < 0 ? terminals.length : at + 1, 0, id);
	const tabs = layout.tabs.map((t, i) =>
		i === layout.active
			? { ...t, terminals, sizes: evenSizes(terminals.length), focus: id }
			: t,
	);
	return { ...layout, tabs };
}

/**
 * Remove a terminal from wherever it is.
 *
 * A tab that loses its last split is closed with it: an empty tab shows
 * nothing and cannot be filled. Focus moves to a neighbour in the same tab,
 * so closing a split leaves the keyboard somewhere real.
 */
export function removeTerminal(layout: TermLayout, id: string): TermLayout {
	const tabs: TermTab[] = [];
	let removedFrom = -1;

	for (const [i, tab] of layout.tabs.entries()) {
		const at = tab.terminals.indexOf(id);
		if (at < 0) {
			tabs.push(tab);
			continue;
		}
		removedFrom = i;
		const terminals = tab.terminals.filter((t) => t !== id);
		if (terminals.length === 0) continue;
		tabs.push({
			...tab,
			terminals,
			sizes: evenSizes(terminals.length),
			focus: tab.focus === id ? terminals[Math.min(at, terminals.length - 1)] : tab.focus,
		});
	}

	if (removedFrom < 0) return layout;

	// A closed tab shifts every later index down, so an active index past it
	// would render whichever tab slid into that slot.
	const closedTab = tabs.length < layout.tabs.length;
	const active = closedTab && removedFrom <= layout.active ? layout.active - 1 : layout.active;
	return { tabs, active: clampIndex(active, tabs.length) };
}

export function selectTab(layout: TermLayout, index: number): TermLayout {
	const active = clampIndex(index, layout.tabs.length);
	return layout.tabs[active] ? { ...layout, active } : layout;
}

/** Focus a pane, switching to its tab if it is in another one. */
export function focusTerminal(layout: TermLayout, id: string): TermLayout {
	const at = layout.tabs.findIndex((t) => t.terminals.includes(id));
	if (at < 0) return layout;
	const tabs = layout.tabs.map((t, i) => (i === at ? { ...t, focus: id } : t));
	return { tabs, active: at };
}

/** Row becomes column and back, for the active tab. */
export function toggleDirection(layout: TermLayout): TermLayout {
	const tab = activeTab(layout);
	if (!tab) return layout;
	const tabs = layout.tabs.map((t, i) =>
		i === layout.active
			? { ...t, direction: t.direction === "row" ? ("column" as const) : ("row" as const) }
			: t,
	);
	return { ...layout, tabs };
}

/**
 * Resize the divider after index `at` in the active tab.
 *
 * Only the two panes either side of the divider change, which is what makes a
 * drag feel local: a proportional redistribution across every pane moves
 * panes the user is not touching. `percent` is the new share of the FIRST of
 * the pair, and the pair's total is conserved, so the rest of the tab is
 * untouched by construction.
 */
export function resizeSplit(layout: TermLayout, at: number, percent: number): TermLayout {
	const tab = activeTab(layout);
	if (!tab || at < 0 || at + 1 >= tab.terminals.length) return layout;
	const pair = tab.sizes[at] + tab.sizes[at + 1];
	const first = Math.min(pair - MIN_SPLIT_PERCENT, Math.max(MIN_SPLIT_PERCENT, percent));
	const sizes = [...tab.sizes];
	sizes[at] = first;
	sizes[at + 1] = pair - first;
	const tabs = layout.tabs.map((t, i) => (i === layout.active ? { ...t, sizes } : t));
	return { ...layout, tabs };
}

/**
 * A stored layout, intersected with the shells that exist.
 *
 * This is the whole recovery path, and it has to work in both directions. A
 * restored layout names terminals the server no longer has (it was restarted,
 * or the shell was killed from another browser) — those panes would be wired
 * to nothing. And the server has terminals the layout does not mention
 * (another window opened one) — ADOPTING those is what stops a shell from
 * becoming unreachable, since with no pane referencing it nothing could ever
 * close it either.
 */
export function reconcile(layout: TermLayout, existing: string[]): TermLayout {
	const live = new Set(existing);
	const tabs: TermTab[] = [];
	for (const tab of layout.tabs) {
		const terminals = tab.terminals.filter((t) => live.has(t));
		if (terminals.length === 0) continue;
		const sizes =
			terminals.length === tab.terminals.length ? tab.sizes : evenSizes(terminals.length);
		tabs.push({
			...tab,
			terminals,
			sizes,
			focus: terminals.includes(tab.focus) ? tab.focus : terminals[0],
		});
	}

	const known = new Set(tabs.flatMap((t) => t.terminals));
	for (const id of existing) {
		if (known.has(id)) continue;
		tabs.push(newTab(id));
	}

	return { tabs, active: clampIndex(layout.active, tabs.length) };
}

/**
 * Storage is user-writable and survives a rename, so a stored layout is
 * untrusted input: every field is checked, and anything unrenderable falls
 * back to empty rather than reaching render as a half-shaped object.
 */
export function parseLayout(raw: unknown): TermLayout {
	if (!raw || typeof raw !== "object") return EMPTY_LAYOUT;
	const value = raw as { tabs?: unknown; active?: unknown };
	if (!Array.isArray(value.tabs)) return EMPTY_LAYOUT;

	const tabs: TermTab[] = [];
	for (const entry of value.tabs) {
		if (!entry || typeof entry !== "object") continue;
		const tab = entry as {
			terminals?: unknown;
			direction?: unknown;
			sizes?: unknown;
			focus?: unknown;
		};
		const terminals = Array.isArray(tab.terminals)
			? tab.terminals.filter((t): t is string => typeof t === "string" && t !== "")
			: [];
		if (terminals.length === 0) continue;
		const stored = Array.isArray(tab.sizes)
			? tab.sizes.filter((s): s is number => typeof s === "number" && Number.isFinite(s) && s > 0)
			: [];
		// Sizes only survive if they still describe this many panes: a
		// mismatched array renders as panes of arbitrary width, which is worse
		// than even shares.
		const sizes = stored.length === terminals.length ? stored : evenSizes(terminals.length);
		const focus = typeof tab.focus === "string" && terminals.includes(tab.focus) ? tab.focus : terminals[0];
		tabs.push({
			terminals,
			direction: tab.direction === "column" ? "column" : "row",
			sizes,
			focus,
		});
	}

	if (tabs.length === 0) return EMPTY_LAYOUT;
	return {
		tabs,
		active: clampIndex(typeof value.active === "number" ? value.active : 0, tabs.length),
	};
}
