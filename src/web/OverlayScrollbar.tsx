import { forwardRef, useEffect, useRef, useState, type HTMLAttributes, type RefObject } from "react";

/** How long a scrollbar stays after the last scroll before it fades. */
const SHOW_MS = 500;
/** How long the pointer must rest on the track before it shows, so passing over it does not. */
const HOVER_MS = 300;

/**
 * Native scrollbars: marks whichever element scrolls with `data-scrolling`
 * until SHOW_MS after its last scroll event; index.css shows the thumb then.
 */
export function showScrollbarsWhileScrolling(): void {
	const timers = new WeakMap<Element, number>();
	document.addEventListener(
		"scroll",
		(e) => {
			const el = e.target instanceof Element ? e.target : document.documentElement;
			if (!el.hasAttribute("data-scrolling")) el.setAttribute("data-scrolling", "");
			clearTimeout(timers.get(el));
			timers.set(el, window.setTimeout(() => el.removeAttribute("data-scrolling"), SHOW_MS));
		},
		{ capture: true, passive: true },
	);
}

/**
 * A scrollbar drawn OVER a pane instead of beside it, for the transcript.
 *
 * A native scrollbar owns a strip at the pane's edge that no content can paint
 * into, so the full-width turn separators stopped 8px short of it. The pane
 * hides its own (`.no-scrollbar`) and this draws a 6px `neutral-700` thumb
 * on top, flush right, in an 8px track. Drag the thumb to scroll; click the track to
 * page. Place it in a `relative` parent that the pane fills.
 *
 * Like macOS and mobile overlay scrollbars, it shows only while you scroll
 * (wheel, touch, keys), hover its track or drag, and fades out a second later.
 * Auto-scroll while a reply streams does not show it.
 */
export function OverlayScrollbar({ target }: { target: RefObject<HTMLElement | null> }) {
	const [thumb, setThumb] = useState<{ top: number; height: number } | null>(null);
	const drag = useRef<{ y: number; top: number } | null>(null);
	const [shown, setShown] = useState(false);
	const hovered = useRef(false);
	const hideTimer = useRef(0);
	const hoverTimer = useRef(0);
	const reveal = useRef(() => {});
	reveal.current = () => {
		setShown(true);
		clearTimeout(hideTimer.current);
		hideTimer.current = window.setTimeout(() => {
			if (!hovered.current && !drag.current) setShown(false);
		}, SHOW_MS);
	};

	useEffect(() => {
		const el = target.current;
		if (!el) return;
		let frame = 0;
		const measure = () => {
			frame = 0;
			const { scrollTop, scrollHeight, clientHeight } = el;
			if (scrollHeight <= clientHeight + 1) {
				setThumb(null);
				return;
			}
			const height = Math.max(24, (clientHeight * clientHeight) / scrollHeight);
			const top = (scrollTop / (scrollHeight - clientHeight)) * (clientHeight - height);
			setThumb((t) => (t && t.top === top && t.height === height ? t : { top, height }));
		};
		// Content grows while a reply streams and when a group opens, neither of
		// which scrolls or resizes the pane itself.
		const schedule = () => {
			if (!frame) frame = requestAnimationFrame(measure);
		};
		// User input only: programmatic scrolls (follow the stream) stay hidden.
		const onInput = () => reveal.current();
		const inputs = ["wheel", "touchmove", "keydown"] as const;
		for (const type of inputs) el.addEventListener(type, onInput, { passive: true });
		measure();
		el.addEventListener("scroll", schedule, { passive: true });
		const resize = new ResizeObserver(schedule);
		resize.observe(el);
		const mutate = new MutationObserver(schedule);
		mutate.observe(el, { childList: true, subtree: true, characterData: true, attributes: true });
		return () => {
			cancelAnimationFrame(frame);
			clearTimeout(hideTimer.current);
			clearTimeout(hoverTimer.current);
			for (const type of inputs) el.removeEventListener(type, onInput);
			el.removeEventListener("scroll", schedule);
			resize.disconnect();
			mutate.disconnect();
		};
	}, [target]);

	if (!thumb) return null;

	/** Pixels of scroll per pixel of thumb travel. */
	const ratio = () => {
		const el = target.current;
		if (!el) return 0;
		return (el.scrollHeight - el.clientHeight) / Math.max(1, el.clientHeight - thumb.height);
	};

	return (
		<div
			aria-hidden
			className={`overlay-scrollbar absolute inset-y-0 right-0 w-2 transition-opacity ${shown ? "opacity-100 duration-100" : "opacity-0 duration-500"}`}
			onPointerEnter={() => {
				hovered.current = true;
				hoverTimer.current = window.setTimeout(() => reveal.current(), HOVER_MS);
			}}
			onPointerLeave={() => {
				hovered.current = false;
				clearTimeout(hoverTimer.current);
				if (shown) reveal.current();
			}}
			onPointerDown={(e) => {
				// The track pages toward the click, like a native one.
				const el = target.current;
				if (!el || e.target !== e.currentTarget) return;
				const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
				el.scrollBy({ top: (y < thumb.top ? -1 : 1) * el.clientHeight * 0.9 });
			}}
		>
			<div
				className="absolute right-0 w-1.5 rounded-sm bg-neutral-700 hover:bg-neutral-600"
				style={{ top: thumb.top, height: thumb.height }}
				onPointerDown={(e) => {
					const el = target.current;
					if (!el) return;
					e.preventDefault();
					e.currentTarget.setPointerCapture(e.pointerId);
					drag.current = { y: e.clientY, top: el.scrollTop };
				}}
				onPointerMove={(e) => {
					const el = target.current;
					if (!el || !drag.current) return;
					el.scrollTop = drag.current.top + (e.clientY - drag.current.y) * ratio();
				}}
				onPointerUp={() => {
					drag.current = null;
					reveal.current();
				}}
				onPointerCancel={() => {
					drag.current = null;
					reveal.current();
				}}
			/>
		</div>
	);
}

/**
 * A scrolling list whose rows span its full width: the native scrollbar is
 * hidden and OverlayScrollbar draws over the rows instead of beside them.
 * `className` sizes the outer box (e.g. `min-h-0 flex-1`); everything else,
 * `ref` included, goes to the scrolling element.
 */
export const ScrollPane = forwardRef<
	HTMLDivElement,
	HTMLAttributes<HTMLDivElement> & { innerClassName?: string }
>(function ScrollPane({ className = "", innerClassName = "", ...props }, ref) {
	const pane = useRef<HTMLDivElement | null>(null);
	return (
		<div className={`relative flex flex-col ${className}`}>
			<div
				{...props}
				ref={(el) => {
					pane.current = el;
					if (typeof ref === "function") ref(el);
					else if (ref) ref.current = el;
				}}
				className={`no-scrollbar scroll-fade-y min-h-0 flex-1 overflow-auto ${innerClassName}`}
			/>
			<OverlayScrollbar target={pane} />
		</div>
	);
});
