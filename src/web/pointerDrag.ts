import type { PointerEvent as ReactPointerEvent } from "react";

/** Capture one pointer and release every listener when it ends, is cancelled, or loses capture. */
export function startPointerDrag(
	event: ReactPointerEvent<HTMLElement>,
	onMove: (event: PointerEvent) => void,
	onEnd: () => void,
): void {
	if (event.button !== 0) return;
	const target = event.currentTarget;
	const id = event.pointerId;
	target.setPointerCapture(id);
	event.preventDefault();
	const move = (next: PointerEvent) => {
		if (next.pointerId === id) onMove(next);
	};
	const end = (next: PointerEvent) => {
		if (next.pointerId !== id) return;
		target.removeEventListener("pointermove", move);
		target.removeEventListener("pointerup", end);
		target.removeEventListener("pointercancel", end);
		target.removeEventListener("lostpointercapture", end);
		onEnd();
	};
	target.addEventListener("pointermove", move);
	target.addEventListener("pointerup", end);
	target.addEventListener("pointercancel", end);
	target.addEventListener("lostpointercapture", end);
}
