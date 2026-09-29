import { PI_MARK } from "./piMark.js";

/**
 * A breathing favicon for "the agent is working", green for "a reply is ready"
 * and a red dot for "waiting on you".
 *
 * Browsers ignore animation inside a favicon: SMIL and CSS in an SVG icon are
 * never ticked, and APNG support is nowhere near universal. The only portable
 * way to move a tab icon is to keep handing the browser a new icon, which
 * turns out to have three separate catches, all of them found the hard way
 * against a real Chrome tab strip:
 *
 *  - Rewriting `href` on the existing `<link>` is not enough, and neither is
 *    re-inserting the element that was already there. Each frame has to be a
 *    *new* link element.
 *  - The icon URL has to be one this tab has never seen. A fixed set of
 *    pre-rendered frames animates for exactly one lap and then freezes, which
 *    looks precisely like the feature not working. Hence the frame counter
 *    baked into the markup: it makes every URL unique.
 *  - `blob:` URLs are refused outright by the favicon loader, so the frames
 *    are `data:` URLs.
 *
 * Frames are SVG rather than canvas PNGs: the π is a vector, so wrapping
 * it in a scaled group keeps every frame sharp at any device pixel ratio and
 * needs no rasterising at all.
 */

/**
 * How long a full breath takes, and how often a frame is offered.
 *
 * Chrome throttles timers in a hidden tab to roughly once a second — and a
 * tab-strip indicator is for a tab nobody is looking at, so that is the rate
 * that matters. A one-second breath sampled once a second is not a breath,
 * it is jitter, so the cycle is slow enough that even four surviving frames
 * read as in-out. The phase comes from the clock rather than a frame count,
 * so dropped ticks slow the animation down instead of desynchronising it: a
 * foreground tab gets twelve frames per breath, a background one gets three
 * or four of the same breath.
 */
const PERIOD_MS = 3000;
const STEP_MS = 250;

/**
 * How much size and opacity the π gives up at the bottom of the breath.
 * Both are large for an icon: the target is 16 device pixels in a tab strip
 * the user is not looking at, where a tasteful 10% wobble is invisible.
 */
const SCALE_DIP = 0.34;
const ALPHA_DIP = 0.35;

/**
 * "A session wants you": a reply turns the π green (`green-400`), a question
 * adds a red corner dot (`red-400`), drawn outside the breathing π so it holds
 * still, with a dark ring so it separates from the π at 16px.
 */
export type Badge = "needs" | "ready" | null;

/** The mark's scale at rest: public/favicon.svg's, 56 of the icon's 64 units. */
const MARK_SCALE = 0.1;

function frame(k: number, badge: Badge, tick: number): string {
	const scale = MARK_SCALE * (1 - SCALE_DIP * k);
	// Scale about the middle of the icon, so the π breathes in place
	// instead of drifting towards the origin.
	const doc =
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
		`<!--${tick}-->` +
		`<path fill="${badge === "ready" ? "#4ade80" : "#fff"}" opacity="${(1 - ALPHA_DIP * k).toFixed(3)}"` +
		` transform="translate(32 32) scale(${scale.toFixed(4)}) translate(-280 -280)" d="${PI_MARK}"/>` +
		(badge === "needs" ? '<circle cx="49" cy="15" r="13" fill="#f87171" stroke="#000" stroke-width="4"/>' : "") +
		"</svg>";
	return `data:image/svg+xml,${encodeURIComponent(doc)}`;
}

/** The page's own icon link, captured before the first frame replaces it. */
let original: HTMLLinkElement | null | undefined;
let live: HTMLLinkElement | null = null;
let timer: number | undefined;
let tick = 0;

function show(k: number, badge: Badge) {
	const next = document.createElement("link");
	next.rel = "icon";
	next.type = "image/svg+xml";
	next.href = frame(k, badge, tick++);
	// Appended, then the previous one dropped: with two icon links in the
	// head Chrome renders the first, so the old frame must not outlive the
	// new one.
	document.head.appendChild(next);
	live?.remove();
	live = next;
}

/**
 * Show the app's state in the tab icon: breathing while anything works,
 * green or a corner dot while anything waits. Call again whenever either changes.
 */
export function setFavicon(working: boolean, badge: Badge): void {
	if (timer !== undefined) window.clearInterval(timer);
	timer = undefined;

	if (original === undefined) original = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
	// Nothing to say and the page's icon still up: leave it be.
	if (!working && !badge && !live) return;

	// The original link has to go: it is first in the head, so Chrome
	// would keep drawing it and ignore every frame.
	original?.remove();
	show(0, badge);
	// Someone who asked the OS for less motion gets a still icon; the
	// title already says "working" for them. Settling is a fresh rest
	// frame rather than the original link, because Chrome ignores a
	// return to an icon URL this tab has already loaded.
	if (!working || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
	const started = Date.now();
	timer = window.setInterval(() => {
		const phase = ((Date.now() - started) % PERIOD_MS) / PERIOD_MS;
		// Cosine, so the breath eases at both ends instead of bouncing.
		show(0.5 - 0.5 * Math.cos(phase * 2 * Math.PI), badge);
	}, STEP_MS);
}
