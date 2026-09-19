/**
 * models.ts — the model catalog and the startup default.
 *
 * The catalog comes from pi itself over RPC (`get_available_models`), because
 * pi has no `--json` model listing on the command line and the RPC answer is
 * the same object a session reports for its own model — same provider ids,
 * same `input` modalities, same context windows. Asking the agent means the
 * picker can never disagree with the session.
 *
 * The startup default is a pair of keys in pi's own `settings.json`
 * (`defaultProvider` / `defaultModel`, verified in docs/pi-facts.md §0.5), so
 * this writes that file — carefully, preserving every key it did not set.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { askOnce } from "./agent.js";
import { isRecord, records } from "./guards.js";

/** Models change when credentials change, which happens outside this process. */
const TTL_MS = 10 * 60_000;

export interface ModelMeta {
	/** "provider/id", the string every other module passes around. */
	selector: string;
	provider: string;
	id: string;
	name: string;
	/** Accepted input modalities, e.g. `["text", "image"]`. */
	input: string[];
	contextWindow: number;
}

let cached: { at: number; catalog: Map<string, ModelMeta> } | undefined;
let inFlight: Promise<Map<string, ModelMeta>> | undefined;

/**
 * The catalog, keyed by "provider/id".
 *
 * One fetch at a time and one result per TTL: the page asks on every settings
 * open, and each miss costs a `pi` spawn.
 */
export function modelCatalog(): Promise<Map<string, ModelMeta>> {
	if (cached && Date.now() - cached.at < TTL_MS) return Promise.resolve(cached.catalog);
	inFlight ??= fetchCatalog()
		.then((catalog) => {
			cached = { at: Date.now(), catalog };
			return catalog;
		})
		.finally(() => {
			inFlight = undefined;
		});
	return inFlight;
}

/** Models with usable credentials, as sorted "provider/id". */
export async function listModels(): Promise<string[]> {
	return [...(await modelCatalog()).keys()].sort();
}

/**
 * Ask a throwaway `pi --mode rpc --no-session` for the catalog.
 *
 * Deliberately not routed through a live session child: the catalog is asked
 * for at most once per TTL, a spawn is ~1s against that, and reaching into
 * the registry for a child that may be mid-turn would couple the model list
 * to whichever conversation happens to be open.
 *
 * Extensions are NOT disabled for this call. A provider can come from an
 * installed package (`npm:pi-sub-anthropic` is exactly that), so a child
 * started without extension discovery would report a smaller catalog than
 * every real session has.
 */
async function fetchCatalog(): Promise<Map<string, ModelMeta>> {
	const data = await askOnce("get_available_models", process.cwd());
	if (!isRecord(data)) throw new Error("pi returned no model catalog");

	const catalog = new Map<string, ModelMeta>();
	for (const m of records(data.models)) {
		const { provider, id, name, input, contextWindow } = m;
		// A row without provider+id has no selector, so it cannot be named,
		// chosen, or persisted. Skipping one bad row beats failing the catalog.
		if (typeof provider !== "string" || typeof id !== "string") continue;
		const key = `${provider}/${id}`;
		catalog.set(key, {
			selector: key,
			provider,
			id,
			name: typeof name === "string" ? name : id,
			input: Array.isArray(input) ? input.filter((i): i is string => typeof i === "string") : [],
			contextWindow: typeof contextWindow === "number" ? contextWindow : 0,
		});
	}
	if (catalog.size === 0) throw new Error("pi reported no models");
	return catalog;
}

// ---------------------------------------------------------------------------
// Default model — `defaultProvider` / `defaultModel` in pi's settings.json
// ---------------------------------------------------------------------------

/** pi's own settings file. `PIW_PI_SETTINGS` is the test seam. */
export function settingsPath(): string {
	return process.env.PIW_PI_SETTINGS ?? join(homedir(), ".pi", "agent", "settings.json");
}

/** pi's settings as a record, or an empty one when the file is absent. */
export function readSettings(): Record<string, unknown> {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(settingsPath(), "utf8"));
	} catch {
		// No settings yet is the normal state of a fresh install.
		return {};
	}
	return isRecord(raw) ? raw : {};
}

/**
 * Replace pi's settings file, preserving everything not being changed.
 *
 * Temp file plus rename: pi reads this file at the start of every session and
 * a truncated one would break every future spawn, not just this write. The
 * temp file is a sibling so the rename stays within one filesystem.
 */
export function writeSettings(settings: Record<string, unknown>): void {
	const path = settingsPath();
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.piw-tmp`;
	writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, path);
}

/**
 * Persist "provider/id" as pi's startup model.
 *
 * The catalog check is not ceremony: nothing validates these keys at write
 * time, so a typo would persist happily and then fail at the start of every
 * future session, far from the mistake.
 */
export async function setDefaultModel(spec: string): Promise<void> {
	const slash = spec.indexOf("/");
	if (slash <= 0 || slash === spec.length - 1) {
		throw new Error(`model must be "provider/id", got: ${spec}`);
	}
	const catalog = await modelCatalog();
	if (!catalog.has(spec)) throw new Error(`unknown model: ${spec}`);

	writeSettings({
		...readSettings(),
		defaultProvider: spec.slice(0, slash),
		defaultModel: spec.slice(slash + 1),
	});
}
