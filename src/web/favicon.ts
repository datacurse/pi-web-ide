/**
 * A breathing favicon for "the agent is working".
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
 * Frames are SVG rather than canvas PNGs: the brain is a vector, so wrapping
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
 * How much size and opacity the brain gives up at the bottom of the breath.
 * Both are large for an icon: the target is 16 device pixels in a tab strip
 * the user is not looking at, where a tasteful 10% wobble is invisible.
 */
const SCALE_DIP = 0.34;
const ALPHA_DIP = 0.35;

/** The static icon's markup, fetched once and reused by every run. */
let artwork: Promise<string> | null = null;

function frame(inner: string, k: number, tick: number): string {
	const scale = 1 - SCALE_DIP * k;
	// Scale about the middle of the viewBox, so the brain breathes in place
	// instead of drifting towards the origin.
	const doc =
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
		`<!--${tick}-->` +
		`<g transform="translate(32 32) scale(${scale.toFixed(3)}) translate(-32 -32)"` +
		` opacity="${(1 - ALPHA_DIP * k).toFixed(3)}">${inner}</g></svg>`;
	return `data:image/svg+xml,${encodeURIComponent(doc)}`;
}

export function pulseFavicon(): () => void {
	const original = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
	if (!original) return () => {};

	// Someone who asked the OS for less motion gets the static brain; the
	// title already says "working" for them.
	if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return () => {};

	const source = original.href;
	if (!source) return () => {};

	let timer: number | undefined;
	let live: HTMLLinkElement | null = null;
	let stopped = false;
	let tick = 0;

	const show = (inner: string, k: number) => {
		const next = document.createElement("link");
		next.rel = "icon";
		next.type = "image/svg+xml";
		next.href = frame(inner, k, tick++);
		// Appended, then the previous one dropped: with two icon links in the
		// head Chrome renders the first, so the old frame must not outlive the
		// new one.
		document.head.appendChild(next);
		live?.remove();
		live = next;
	};

	artwork ??= fetch(source)
		.then((r) => r.text())
		// The file is ours, and the comments in it are worth a third of every
		// frame's URL.
		.then((text) => text.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " "));

	artwork
		.then((inner) => {
			// Stopped while the artwork was still in flight: nothing to undo,
			// because no frame was ever inserted.
			if (stopped) return;
			// The original link has to go: it is first in the head, so Chrome
			// would keep drawing it and ignore every frame.
			original.remove();
			const started = Date.now();
			show(inner, 0);
			timer = window.setInterval(() => {
				const phase = ((Date.now() - started) % PERIOD_MS) / PERIOD_MS;
				// Cosine, so the breath eases at both ends instead of bouncing.
				show(inner, 0.5 - 0.5 * Math.cos(phase * 2 * Math.PI));
			}, STEP_MS);
		})
		.catch(() => {
			// A favicon is not worth a console error. Let the static one stand,
			// and do not keep a rejected promise around to poison later runs.
			artwork = null;
		});

	return () => {
		if (stopped) return;
		stopped = true;
		if (timer !== undefined) window.clearInterval(timer);
		if (!live) return;
		// Settle on a frame at full size instead of putting the original link
		// back: Chrome ignores a return to an icon URL this tab has already
		// loaded, which would leave the tab stuck on whatever half-breath
		// frame happened to be live. A rest frame is the same artwork at
		// scale 1, and it is a URL Chrome has not seen.
		void artwork?.then((inner) => {
			if (live) show(inner, 0);
		});
	};
}
