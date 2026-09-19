/**
 * models.ts — the model catalog and the startup default, both read out of the
 * `omp` CLI.
 *
 * piw no longer links the agent SDK, so there is no in-process ModelRuntime to
 * ask. `omp models --json` is the equivalent question and it answers with the
 * models that actually have usable credentials — the same set the TUI offers.
 *
 * The default model is read and written here rather than being left to omp's
 * own startup resolution, for the reason the SDK version documented: piw wants
 * to know and change the persisted default independently of any session, and
 * an rpc-ui subprocess only ever reports the model it ended up with.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { OMP_BIN } from "./omp.js";

const run = promisify(execFile);

// One definition of "which omp", shared with the RPC boundary: a deployment
// that needs PIW_OMP_BIN (a systemd unit whose PATH omits ~/.local/bin) needs
// it for the catalog too, and this module used to hardcode "omp" — which
// showed up as `spawn omp ENOENT` from /api/models on a host where the
// sessions themselves worked fine.

/**
 * A cold `omp models` can pay for a catalog fetch (~7s observed); warm runs off
 * ~/.omp/models.db are ~2s. 60s leaves room for a slow network without hanging
 * a request forever.
 */
const TIMEOUT_MS = 60_000;

/**
 * Measured at ~310 bytes per model in the JSON output, so even a machine with
 * every provider authenticated lands in the low hundreds of KB. 8 MiB is a
 * ceiling, not an allocation, and it is what stops a runaway child from eating
 * the heap.
 */
const MAX_BUFFER = 8 * 1024 * 1024;

/** Models change when credentials change, which happens outside this process. */
const TTL_MS = 10 * 60_000;

export interface ModelMeta {
	selector: string;
	provider: string;
	id: string;
	name: string;
	/** Modalities, e.g. ["text", "image"]. Carried through verbatim: the UI
	 * decides whether to offer image attachment off this array. */
	input: string[];
	contextWindow: number;
}

let cached: { at: number; catalog: Map<string, ModelMeta> } | undefined;
let inFlight: Promise<Map<string, ModelMeta>> | undefined;

/**
 * The catalog, keyed by "provider/id".
 *
 * One in-flight fetch is shared by all callers — two concurrent `omp models`
 * processes would cost seconds each and produce the same answer. A failure
 * clears the in-flight promise and propagates, so the next caller retries
 * instead of inheriting a permanently poisoned cache.
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
 * Cache-only lookup for synchronous callers (snapshot assembly, mostly).
 *
 * `undefined` means "not primed yet", never "no such model" — a caller must
 * treat it as unknown rather than as "this model rejects images", or a
 * pre-warm-up snapshot would silently disable attachments.
 *
 * The TTL deliberately does not apply: it governs when to re-ask omp, not when
 * a model's metadata stops being true. An entry that exists is still the best
 * answer available without blocking.
 */
export function peekModel(selector: string): ModelMeta | undefined {
	return cached?.catalog.get(selector);
}

/**
 * The shapes piw reads out of omp's JSON, with every field typed `unknown`.
 * omp is a separate program on its own release cadence, so these declarations
 * claim only "this is the object we asked for" — the compiler still forces a
 * `typeof` check at each use, which is where the real validation lives.
 */
interface RawCatalog {
	models?: unknown;
}
interface RawModel {
	provider?: unknown;
	id?: unknown;
	selector?: unknown;
	name?: unknown;
	input?: unknown;
	contextWindow?: unknown;
}
interface RawConfigValue {
	value?: unknown;
}

async function fetchCatalog(): Promise<Map<string, ModelMeta>> {
	const { stdout } = await run(OMP_BIN, ["models", "--json"], { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER });
	const parsed = JSON.parse(stdout) as RawCatalog;
	if (!Array.isArray(parsed.models)) throw new Error("omp models --json: expected { models: [...] }");

	const catalog = new Map<string, ModelMeta>();
	for (const raw of parsed.models) {
		const { provider, id, selector, name, input, contextWindow } = raw as RawModel;
		// A row without provider+id has no selector, so it cannot be named,
		// chosen, or persisted. Skipping one bad row beats failing the catalog.
		if (typeof provider !== "string" || typeof id !== "string") continue;
		const key = typeof selector === "string" ? selector : `${provider}/${id}`;
		catalog.set(key, {
			selector: key,
			provider,
			id,
			name: typeof name === "string" ? name : id,
			input: Array.isArray(input) ? input.filter((i): i is string => typeof i === "string") : [],
			contextWindow: typeof contextWindow === "number" ? contextWindow : 0,
		});
	}
	return catalog;
}

// ---------------------------------------------------------------------------
// Default model — the "default" entry of omp's modelRoles record
// ---------------------------------------------------------------------------

/**
 * omp stores model-selector assignments as a record of role → "provider/id"
 * under the `modelRoles` config key (`{"default":"anthropic/claude-opus-5"}`);
 * the startup model is the `default` role. There is no dotted
 * `modelRoles.default` key — `omp config get modelRoles.default` answers
 * "Unknown setting" — so the whole record is the unit of read and write.
 *
 * Reads are cwd-sensitive: a project's .omp/config.yml shadows the global
 * value, and `omp config get` reports the merged result. Writes always land in
 * the global config.yml regardless of cwd. So a project override stays visible
 * after setDefaultModel — that is omp's own behaviour, and reporting what omp
 * would actually use beats reporting what we just wrote.
 */
async function modelRoles(): Promise<Record<string, string>> {
	const { stdout } = await run(OMP_BIN, ["config", "get", "modelRoles", "--json"], { timeout: TIMEOUT_MS });
	const { value } = JSON.parse(stdout) as RawConfigValue;
	if (typeof value !== "object" || value === null) return {};
	const roles: Record<string, string> = {};
	for (const [role, spec] of Object.entries(value)) {
		if (typeof spec === "string") roles[role] = spec;
	}
	return roles;
}

/** The persisted startup model as "provider/id", or undefined if none is set. */
export async function defaultModelSpec(): Promise<string | undefined> {
	return (await modelRoles()).default || undefined;
}

/**
 * The `smol` role: omp's cheap model for one-shot chores, used here to name a
 * commit. Undefined when the role is unset, in which case the caller says
 * nothing about the model and omp picks its own — naming a commit with the
 * big model is slower and dearer, but it is never wrong, and inventing a
 * hardcoded "some cheap model" here would rot the first time a provider
 * renames one.
 */
export async function smolModelSpec(): Promise<string | undefined> {
	return (await modelRoles()).smol || undefined;
}

/**
 * Persist "provider/id" as omp's default model role.
 *
 * `omp config set` replaces a record wholesale rather than merging, so the
 * other roles (smol, slow, advisor, ...) have to be read back and resent or
 * they are silently dropped.
 *
 * The catalog check is not ceremony: omp accepts any string here, so a typo
 * would persist happily and then fail at the start of every future session,
 * far from the mistake.
 */
export async function setDefaultModel(spec: string): Promise<void> {
	const slash = spec.indexOf("/");
	if (slash <= 0 || slash === spec.length - 1) throw new Error(`model must be "provider/id", got: ${spec}`);
	const catalog = await modelCatalog();
	if (!catalog.has(spec)) throw new Error(`unknown model: ${spec}`);

	const roles = { ...(await modelRoles()), default: spec };
	await run(OMP_BIN, ["config", "set", "modelRoles", JSON.stringify(roles)], { timeout: TIMEOUT_MS });
}
