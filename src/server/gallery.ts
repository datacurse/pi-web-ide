/**
 * gallery.ts — finding packages to install.
 *
 * pi's public gallery is "npm packages carrying the `pi-package` keyword",
 * with previews declared as `pi.image` / `pi.video` in package.json. There is
 * no API in front of it, so this asks npm directly — server-side, because the
 * browser reaching npm would be a third origin to allow and would leak which
 * machine is browsing what.
 *
 * Git-only packages are invisible here by construction. That is why the
 * screen also has an "add by source" box.
 *
 * Every failure is an empty list plus a reason, never a 500: a registry that
 * is down or slow must not make the Packages screen look broken, and the
 * installed list on the same screen is still perfectly usable.
 */

import { isRecord, records } from "./guards.js";

/** Long enough for npm's slow tail, short enough that a click still feels answered. */
const TIMEOUT_MS = 5_000;

/** Search results and package metadata change on the order of a publish. */
const CACHE_MS = Number(process.env.PWI_SEARCH_CACHE_MS ?? 600_000);

/** npm's own page size ceiling for this endpoint is 250; 30 is a screenful. */
const SIZE = 30;

export interface SearchHit {
	name: string;
	version: string;
	description?: string;
	publisher?: string;
	/** ISO date of the last publish. */
	published?: string;
	/** Repository URL, when the package declares one. */
	repository?: string;
}

export interface PackageInfo {
	name: string;
	/** The newest published version, which is what an install would pin to. */
	latest: string;
	description?: string;
	publisher?: string;
	published?: string;
	repository?: string;
	/** How many of each resource the `pi` manifest declares. */
	contains: { extensions: number; skills: number; prompts: number; themes: number };
	/** `pi.image` or `pi.video` from package.json, for the preview. */
	image?: string;
	video?: string;
	weeklyDownloads?: number;
}

interface Entry<T> {
	at: number;
	value: T;
}
const searchCache = new Map<string, Entry<SearchHit[]>>();
const infoCache = new Map<string, Entry<PackageInfo>>();

function fresh<T>(cache: Map<string, Entry<T>>, key: string): T | undefined {
	const hit = cache.get(key);
	if (!hit) return undefined;
	if (Date.now() - hit.at > CACHE_MS) {
		cache.delete(key);
		return undefined;
	}
	return hit.value;
}

async function getJson(url: string): Promise<unknown> {
	const res = await fetch(url, {
		signal: AbortSignal.timeout(TIMEOUT_MS),
		headers: { accept: "application/json" },
	});
	// Every URL here is npm's, so parsing one back out to name the host in the
	// message would be a throw-on-malformed call to say what we already know.
	if (!res.ok) throw new Error(`the npm registry answered ${res.status}`);
	return res.json();
}

/**
 * Search the gallery.
 *
 * The `keywords:pi-package` qualifier is what makes this the gallery rather
 * than all of npm; the user's words are appended as ordinary search terms.
 * An empty query is the gallery's own front page, which is the right thing to
 * show when the screen opens.
 */
export async function search(query: string): Promise<{ results: SearchHit[]; reason?: string }> {
	const q = query.trim().slice(0, 100);
	const cached = fresh(searchCache, q);
	if (cached) return { results: cached };

	const text = `keywords:pi-package${q ? ` ${q}` : ""}`;
	const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text)}&size=${SIZE}`;

	let data: unknown;
	try {
		data = await getJson(url);
	} catch (err) {
		return { results: [], reason: err instanceof Error ? err.message : String(err) };
	}
	if (!isRecord(data)) return { results: [], reason: "npm returned no results object" };

	const results: SearchHit[] = [];
	for (const row of records(data.objects)) {
		const p = isRecord(row.package) ? row.package : undefined;
		if (!p || typeof p.name !== "string") continue;
		// npm's fuzzy matcher will happily return packages that do not carry
		// the keyword at all; the gallery is the keyword, so filter on it.
		const keywords = Array.isArray(p.keywords) ? p.keywords : [];
		if (!keywords.includes("pi-package")) continue;
		const links = isRecord(p.links) ? p.links : undefined;
		const publisher = isRecord(p.publisher) ? p.publisher : undefined;
		results.push({
			name: p.name,
			version: typeof p.version === "string" ? p.version : "",
			...(typeof p.description === "string" ? { description: p.description } : {}),
			...(publisher && typeof publisher.username === "string"
				? { publisher: publisher.username }
				: {}),
			...(typeof p.date === "string" ? { published: p.date } : {}),
			...(links && typeof links.repository === "string" ? { repository: links.repository } : {}),
		});
	}
	searchCache.set(q, { at: Date.now(), value: results });
	return { results };
}

/**
 * One package in detail: what an install would pin to, and what it contains.
 *
 * The download count is a separate endpoint and a separate failure: a missing
 * count is worth strictly less than the manifest, so it is fetched alongside
 * and dropped on any error rather than failing the whole lookup.
 */
export async function info(name: string): Promise<PackageInfo> {
	const cached = fresh(infoCache, name);
	if (cached) return cached;

	const data = await getJson(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`);
	if (!isRecord(data) || typeof data.name !== "string" || typeof data.version !== "string") {
		throw new Error(`no such package: ${name}`);
	}

	const manifest = isRecord(data.pi) ? data.pi : undefined;
	const countOf = (key: string) => (Array.isArray(manifest?.[key]) ? manifest[key].length : 0);
	const repo = isRecord(data.repository) ? data.repository : undefined;
	const author = isRecord(data._npmUser) ? data._npmUser : undefined;

	const downloads = await getJson(
		`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(name)}`,
	).catch(() => undefined);

	const value: PackageInfo = {
		name: data.name,
		latest: data.version,
		...(typeof data.description === "string" ? { description: data.description } : {}),
		...(author && typeof author.name === "string" ? { publisher: author.name } : {}),
		...(repo && typeof repo.url === "string"
			? { repository: repo.url.replace(/^git\+/, "").replace(/\.git$/, "") }
			: {}),
		contains: {
			extensions: countOf("extensions"),
			skills: countOf("skills"),
			prompts: countOf("prompts"),
			themes: countOf("themes"),
		},
		...(manifest && typeof manifest.image === "string" ? { image: manifest.image } : {}),
		...(manifest && typeof manifest.video === "string" ? { video: manifest.video } : {}),
		...(isRecord(downloads) && typeof downloads.downloads === "number"
			? { weeklyDownloads: downloads.downloads }
			: {}),
	};
	infoCache.set(name, { at: Date.now(), value });
	return value;
}
