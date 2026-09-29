/**
 * The app-wide keyboard shortcuts and their bindings, set in Settings > Shortcuts.
 *
 * A binding is `Ctrl+Alt+Shift+Meta+<code>` (modifiers in that order, any
 * subset) or "" for none. `<code>` is `KeyboardEvent.code`, the physical key,
 * because Alt+digit and the backquote key produce different characters on
 * other layouts while the key pressed is the same. `Digit` stands for
 * Digit1–9, so Go to Tab is one binding for nine keys.
 *
 * The defaults avoid every key a browser keeps for itself (`RESERVED`).
 */

import { readStored, writeStored } from "./prefs.js";

export const SHORTCUTS = [
	{ id: "tab.reopen", label: "Reopen Closed Tab", keys: "Alt+Shift+KeyT" },
	{ id: "session.new", label: "New AI Session", keys: "Alt+KeyN" },
	{ id: "session.search", label: "Search Sessions", keys: "Ctrl+KeyO" },
	{ id: "palette", label: "Command Palette", keys: "Ctrl+KeyP" },
	{ id: "view.terminal", label: "Toggle Terminal", keys: "Ctrl+Backquote" },
	{ id: "session.nextWaiting", label: "Go to Next Waiting Session", keys: "Alt+KeyJ" },
	{ id: "tab.select", label: "Go to Tab 1\u20139", keys: "Alt+Digit" },
] as const;
export type ShortcutId = (typeof SHORTCUTS)[number]["id"];
export type Bindings = Record<ShortcutId, string>;

/**
 * Keys Chrome or Firefox handle before the page sees them (new/close/restore
 * tab or window, switch tab, quit), so a binding to one never fires.
 */
const RESERVED = new Set([
	"Ctrl+KeyN",
	"Ctrl+Shift+KeyN",
	"Ctrl+KeyT",
	"Ctrl+Shift+KeyT",
	"Ctrl+KeyW",
	"Ctrl+Shift+KeyW",
	"Ctrl+Shift+KeyP",
	"Ctrl+KeyQ",
	"Ctrl+Shift+KeyQ",
	"Ctrl+Tab",
	"Ctrl+Shift+Tab",
	"Ctrl+PageUp",
	"Ctrl+PageDown",
	"Ctrl+F4",
	"Alt+F4",
]);

export const isReserved = (combo: string): boolean => RESERVED.has(combo);

type KeyLike = Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">;

/** The binding a key press spells, or null for a modifier on its own. `digits` folds Digit1–9 into `Digit`. */
export function comboOf(e: KeyLike, digits = false): string | null {
	if (/^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/.test(e.code)) return null;
	const code = digits && /^Digit[1-9]$/.test(e.code) ? "Digit" : e.code;
	return [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Meta", code]
		.filter(Boolean)
		.join("+");
}

/** Which shortcut a key press triggers, with the tab number for Go to Tab. */
export function matchShortcut(e: KeyLike, bindings: Bindings): { id: ShortcutId; digit: number } | null {
	const exact = comboOf(e);
	if (!exact) return null;
	const folded = comboOf(e, true);
	for (const s of SHORTCUTS) {
		const keys = bindings[s.id];
		if (!keys) continue;
		if (s.id === "tab.select" ? keys === folded && folded !== exact : keys === exact)
			return { id: s.id, digit: Number(e.code.slice(5)) || 0 };
	}
	return null;
}

const KEY_NAMES: Record<string, string> = {
	Digit: "1\u20139",
	Backquote: "`",
	Minus: "-",
	Equal: "=",
	BracketLeft: "[",
	BracketRight: "]",
	Backslash: "\\",
	Semicolon: ";",
	Quote: "'",
	Comma: ",",
	Period: ".",
	Slash: "/",
	Space: "Space",
	ArrowUp: "\u2191",
	ArrowDown: "\u2193",
	ArrowLeft: "\u2190",
	ArrowRight: "\u2192",
};

/** `Alt+Shift+KeyT` as people write it: `Alt+Shift+T`. */
export function formatCombo(combo: string): string {
	return combo
		.split("+")
		.map((k) => KEY_NAMES[k] ?? k.replace(/^(Key|Digit|Numpad)(?=.)/, ""))
		.join("+");
}

const SHORTCUTS_KEY = "pwi:shortcuts";

/** Every binding: the user's changes over the defaults. Storage is user-writable, so only strings for known ids count. */
export function readBindings(): Bindings {
	const out = Object.fromEntries(SHORTCUTS.map((s) => [s.id, s.keys])) as Bindings;
	try {
		const saved: unknown = JSON.parse(readStored(SHORTCUTS_KEY) ?? "{}");
		if (saved && typeof saved === "object")
			for (const s of SHORTCUTS) {
				const keys = (saved as Record<string, unknown>)[s.id];
				if (typeof keys === "string") out[s.id] = keys;
			}
	} catch {
		/* corrupt: defaults */
	}
	return out;
}

/** Bind `id` to `keys` ("" for none), taking the keys away from any other shortcut that had them. */
export function writeBinding(id: ShortcutId, keys: string): Bindings {
	const next = readBindings();
	for (const s of SHORTCUTS) if (keys && next[s.id] === keys) next[s.id] = "";
	next[id] = keys;
	const changed = Object.fromEntries(SHORTCUTS.filter((s) => next[s.id] !== s.keys).map((s) => [s.id, next[s.id]]));
	writeStored(SHORTCUTS_KEY, JSON.stringify(changed));
	return next;
}

/** The keys to show for `id` (in the palette), or undefined when it has none. */
export const shortcutKeys = (id: ShortcutId): string | undefined => {
	const keys = readBindings()[id];
	return keys ? formatCombo(keys) : undefined;
};

/** Set while Settings records a new binding, so the keys pressed go to the recorder and trigger nothing. */
export const recorder = { active: false };
