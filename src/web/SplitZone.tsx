/**
 * SplitZone.tsx — the half-width drop targets that turn one editor column
 * into two.
 *
 * VS Code's gesture: drag a tab over the editor body and its left or right
 * half lights up, showing where the tab would land. Dropping on the right
 * half of a single column splits it; dropping on the left half of the second
 * column merges back.
 *
 * An overlay that exists only DURING a drag, rather than two permanent
 * invisible halves, because a permanent absolutely-positioned layer over the
 * editor swallows clicks, text selection and the editor's own drag handles —
 * every pointer bug this could have is avoided by not being there when no
 * drag is in flight.
 *
 * Why halves and not VS Code's full four edges: a top/bottom drop means a
 * horizontal split, which is a second axis in the layout, a second stored
 * dimension and a second divider. Left/right is the split people actually use
 * for "file beside the conversation".
 */

import { useState } from "react";
import type { DragEvent, ReactNode } from "react";
import { isTabDrag, TAB_DRAG_TYPE } from "./SessionTabs.js";

/** Which half of the body the pointer is over. */
type Side = "left" | "right";

/**
 * Which half of a box an x coordinate falls in.
 *
 * Split out from the handlers so the rule is testable without a DOM — it is
 * the whole decision this gesture makes, and it is read from the event twice:
 * once to paint the target, and again to honour the drop.
 */
export function halfOf(x: number, left: number, width: number): Side {
	return x < left + width / 2 ? "left" : "right";
}

export function SplitZone({
	children,
	onDrop,
	splits = true,
	className = "",
}: {
	children: ReactNode;
	/** Take this tab into the column on `side` of this one. */
	onDrop: (entry: string, side: Side) => void;
	/**
	 * Whether a drop here can create a column, which is what makes the two
	 * halves mean different things.
	 *
	 * False for the rightmost column: there is nothing further right to make,
	 * so both halves mean "put it here" and the highlight covers the WHOLE
	 * body. A half-lit overlay there promises a split that cannot happen.
	 */
	splits?: boolean;
	className?: string;
}) {
	/**
	 * Null when no tab drag is over the body, which is also what makes the
	 * overlay absent rather than transparent.
	 */
	const [side, setSide] = useState<Side | null>(null);

	const sideOf = (e: DragEvent<HTMLDivElement>): Side => {
		const box = e.currentTarget.getBoundingClientRect();
		return halfOf(e.clientX, box.left, box.width);
	};

	return (
		<div
			className={`relative ${className}`}
			onDragOver={(e) => {
				// Only our tabs. A file dragged in from the desktop, or a text
				// selection, must not paint a split target it cannot honour.
				if (!isTabDrag(e.dataTransfer.types)) return;
				e.preventDefault();
				e.dataTransfer.dropEffect = "move";
				const next = sideOf(e);
				if (next !== side) setSide(next);
			}}
			/*
			 * `relatedTarget` outside this subtree is what distinguishes LEAVING
			 * the body from crossing between its own children: dragleave fires on
			 * every internal boundary, and clearing on all of them makes the
			 * highlight flicker off under a moving pointer.
			 */
			onDragLeave={(e) => {
				if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
				setSide(null);
			}}
			/*
			 * The side is recomputed from THIS event rather than read back from the
			 * highlight's state, and that is the whole bug this once had: a
			 * `dragleave` fires on the drop target immediately BEFORE `drop`, with
			 * a null relatedTarget — indistinguishable from the pointer genuinely
			 * leaving. It cleared `side` a beat before the drop read it, which
			 * presented as a split that highlighted correctly and then did nothing
			 * on release.
			 */
			onDrop={(e) => {
				const entry = e.dataTransfer.getData(TAB_DRAG_TYPE);
				setSide(null);
				if (!entry) return;
				e.preventDefault();
				onDrop(entry, sideOf(e));
			}}
			// A drag that ends anywhere (Escape, a drop elsewhere) has to clear
			// the highlight, or it stays lit until the next drag enters.
			onDragEnd={() => setSide(null)}
		>
			{children}

			{side && (
				<div
					aria-hidden
					/*
					 * Transitioned so the target SLIDES between halves instead of
					 * teleporting as the pointer crosses the midpoint — the movement is
					 * what tells you the two halves are one control with two positions.
					 * inset-x-0 rather than a width swap so it animates at all.
					 */
					className={`pointer-events-none absolute inset-y-0 rounded bg-amber-400/15 ring-2 ring-inset ring-amber-400/60 transition-[left,right] duration-150 ease-out motion-reduce:transition-none ${
						!splits ? "inset-x-0" : side === "left" ? "left-0 right-1/2" : "left-1/2 right-0"
					}`}
				/>
			)}
		</div>
	);
}
