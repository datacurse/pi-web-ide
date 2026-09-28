import type { TabGroup } from "./tabs.js";
import { isPageTab } from "./tabs.js";

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
export const LAST_PROJECT_KEY = "pwi:lastProject";


function readStored(key: string): string | undefined {
	try {
		return localStorage.getItem(key) ?? undefined;
	} catch {
		// Private mode / disabled storage must not break the app.
		return undefined;
	}
}

export function writeStored(key: string, value: string | undefined): void {
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
export function readWindowProject(): string | undefined {
	try {
		return sessionStorage.getItem(PROJECT_KEY) ?? readStored(LAST_PROJECT_KEY);
	} catch {
		// Private mode / disabled storage: the shared key may still be readable,
		// and a window with no scope of its own is the pre-fix behaviour, which
		// is correct for a single window.
		return readStored(LAST_PROJECT_KEY);
	}
}

export function pinWindowProject(cwd: string): void {
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
export interface Tabs {
	/** The selection's storage scope (scopeOf), not a bare cwd. */
	project: string;
	files: string[];
	active?: string;
	/**
	 * The SECOND editor column, when the strip has been split.
	 *
	 * Holds files and sessions alike; each column has its own session hook.
	 *
	 * Undefined means unsplit, which is distinct from split-and-empty: the
	 * latter cannot occur, because emptying the column closes it.
	 */
	right?: TabGroup;
}

export function readTabs(project: string): Tabs {
	const raw = readStored(`pwi:tabs:${project}`);
	if (!raw) return { project, files: [] };
	try {
		const parsed = JSON.parse(raw) as { files?: unknown; active?: unknown; right?: unknown };
		// Storage is user-writable and outlives any format change, so anything
		// unexpected degrades to "no tabs" instead of throwing during render.
		const files = Array.isArray(parsed.files)
			? [...new Set(parsed.files.filter((f): f is string => typeof f === "string" && !isPageTab(f)))]
			: [];
		const active =
			typeof parsed.active === "string" && files.includes(parsed.active)
				? parsed.active
				: files[0];
		return { project, files, active, right: parseGroup(parsed.right, files) };
	} catch {
		return { project, files: [] };
	}
}

/**
 * The stored second column, or undefined.
 *
 * `taken` is the left column's files: an entry in BOTH columns would render
 * twice and be closable from either, so the left one wins and the right keeps
 * whatever is left. Storage is user-writable, so this is a validation and not
 * a cast — the same rule every other read in prefs.ts follows.
 */
function parseGroup(raw: unknown, taken: string[]): TabGroup | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const { files, active } = raw as { files?: unknown; active?: unknown };
	if (!Array.isArray(files)) return undefined;
	const kept = [
		...new Set(
			files.filter(
				(f): f is string => typeof f === "string" && !taken.includes(f) && !isPageTab(f),
			),
		),
	];
	// An empty second column is no second column: restoring one would show a
	// divider and a blank pane with no way to tell what it was for.
	if (kept.length === 0) return undefined;
	return {
		files: kept,
		active: typeof active === "string" && kept.includes(active) ? active : kept[0],
	};
}
