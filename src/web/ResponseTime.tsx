import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { locale, t } from "./i18n.js";
import { timeAgo } from "./SessionList.js";

export function responseTimeDetails(at: number, durationMs?: number): { date: string; worked?: string } {
	const date = new Date(at).toLocaleString(locale(), {
		year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
	});
	const worked = durationMs === undefined ? undefined : t("Worked for {s}s", { s: Math.floor(Math.max(0, durationMs) / 1000) });
	return { date, worked };
}

/** Portal keeps the hover card out of the virtual transcript's clipping/fade. */
export function ResponseTime({ at, durationMs }: { at: number; durationMs?: number }) {
	const id = useId();
	const anchor = useRef<HTMLSpanElement>(null);
	const popup = useRef<HTMLDivElement>(null);
	const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const focused = useRef(false);
	const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
	const [, tick] = useState(0);
	const details = responseTimeDetails(at, durationMs);
	const cancelClose = () => { clearTimeout(closeTimer.current); };
	const close = () => { cancelClose(); setPosition(null); };
	const show = () => {
		cancelClose();
		const rect = anchor.current?.getBoundingClientRect();
		if (rect) setPosition({ left: rect.left, top: rect.top });
	};
	const leave = () => {
		cancelClose();
		if (!focused.current) closeTimer.current = setTimeout(() => setPosition(null), 100);
	};

	useEffect(() => {
		const timer = setInterval(() => tick((value) => value + 1), 30_000);
		return () => { clearInterval(timer); clearTimeout(closeTimer.current); };
	}, []);
	useEffect(() => {
		if (!position) return;
		const hide = () => setPosition(null);
		window.addEventListener("scroll", hide, true);
		window.addEventListener("resize", hide);
		return () => {
			window.removeEventListener("scroll", hide, true);
			window.removeEventListener("resize", hide);
		};
	}, [!!position]);
	useLayoutEffect(() => {
		if (!position || !popup.current || !anchor.current) return;
		const rect = anchor.current.getBoundingClientRect();
		const card = popup.current.getBoundingClientRect();
		const left = Math.max(8, Math.min(rect.left, window.innerWidth - card.width - 8));
		const above = rect.top - card.height - 8;
		const top = Math.max(8, Math.min(above >= 8 ? above : rect.bottom + 8, window.innerHeight - card.height - 8));
		if (position.left !== left || position.top !== top) setPosition({ left, top });
	}, [position]);

	return <>
		<span ref={anchor} tabIndex={0} className="ml-1 outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
			aria-label={[timeAgo(at), details.date, details.worked].filter(Boolean).join(" · ")}
			aria-describedby={position ? id : undefined}
			onMouseEnter={show} onMouseLeave={leave}
			onFocus={() => { focused.current = true; show(); }}
			onBlur={() => { focused.current = false; close(); }}
			onKeyDown={(event) => { if (event.key === "Escape") close(); }}>
			<time dateTime={new Date(at).toISOString()}>{timeAgo(at)}</time>
		</span>
		{position && createPortal(
			<div ref={popup} id={id} role="tooltip" data-custom="response timestamp hover card: viewport-positioned portal"
				onMouseEnter={cancelClose} onMouseLeave={leave}
				style={{ left: position.left, top: position.top }}
				className="fixed z-50 max-w-[calc(100vw-1rem)] rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-ui shadow-lg">
				<div className="text-neutral-200">{details.date}</div>
				{details.worked && <div className="mt-1 text-neutral-400">{details.worked}</div>}
			</div>, document.body
		)}
	</>;
}
