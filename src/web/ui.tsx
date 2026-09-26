/*
 * Shared UI primitives. Rules and when to use which: docs/ui.md.
 * Tune a control here, not at its call sites. `className` is for layout
 * (margins, flex, width) only; restyling through it fights these classes.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { X } from "@phosphor-icons/react";

const EASE = "transition-colors duration-150 ease-out motion-reduce:transition-none";

const BUTTON_VARIANT = {
	/* The one main action of a dialog or panel. */
	primary:
		"bg-amber-500 font-medium text-neutral-950 hover:bg-amber-400 disabled:bg-neutral-800 disabled:text-neutral-500",
	/* Cancel, and actions beside a primary. */
	secondary:
		"border border-neutral-700 text-neutral-200 hover:bg-neutral-800 disabled:text-neutral-600 disabled:hover:bg-transparent",
	/* Standalone utility actions inside pickers (Open, Add, Up). */
	subtle: "bg-neutral-800 text-neutral-200 hover:bg-neutral-700 disabled:text-neutral-500",
	/* An action inside an amber notice or banner. */
	warning:
		"border border-amber-700 text-amber-200 hover:bg-amber-900/40 disabled:opacity-50 disabled:hover:bg-transparent",
	/* Low-emphasis actions in toolbars. */
	ghost:
		"text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 disabled:text-neutral-600 disabled:hover:bg-transparent",
};
const BUTTON_SIZE = {
	sm: "h-control-sm gap-1 px-2 text-meta",
	md: "h-control-md gap-1.5 px-3 text-ui",
};

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
	variant?: keyof typeof BUTTON_VARIANT;
	size?: keyof typeof BUTTON_SIZE;
};

export function Button({
	variant = "secondary",
	size = "md",
	type = "button",
	className = "",
	...rest
}: ButtonProps) {
	return (
		<button
			type={type}
			className={`inline-flex shrink-0 items-center justify-center rounded-sm ${BUTTON_SIZE[size]} ${BUTTON_VARIANT[variant]} ${EASE} ${className}`}
			{...rest}
		/>
	);
}

const ICON_VARIANT = {
	ghost: "text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 disabled:text-neutral-600 disabled:hover:bg-transparent",
	outline:
		"border border-neutral-700 bg-neutral-900 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 disabled:text-neutral-600 disabled:hover:bg-transparent",
	/* The send button: inverted, the strongest mark in the composer. Disabled
	   drops to a flat grey disc so it lights up only when there is a message. */
	solid: "bg-neutral-100 text-neutral-900 enabled:hover:bg-neutral-200 disabled:bg-neutral-800 disabled:text-neutral-500",
	/* A toggle that is on (aria-pressed): amber disc, dark icon. */
	on: "bg-amber-400 text-neutral-950 hover:bg-amber-300",
};
const ICON_SIZE = { sm: "size-control-sm", md: "size-control-md" };

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
	/* Required: an icon has no text, so this is its accessible name and tooltip. */
	label: string;
	variant?: keyof typeof ICON_VARIANT;
	size?: keyof typeof ICON_SIZE;
	/* Pills in the composer toolbar; square everywhere else. */
	round?: boolean;
};

export function IconButton({
	label,
	variant = "ghost",
	size = "md",
	round = false,
	type = "button",
	className = "",
	...rest
}: IconButtonProps) {
	return (
		<button
			type={type}
			aria-label={label}
			title={label}
			className={`flex shrink-0 items-center justify-center ${ICON_SIZE[size]} ${round ? "rounded-full" : "rounded-sm"} ${ICON_VARIANT[variant]} ${EASE} ${className}`}
			{...rest}
		/>
	);
}

/*
 * A row in a tree or flat list (Explorer, Source Control, directory picker).
 * 22px, as in VS Code. Indent with `style={{ paddingLeft }}`. Focus shows as the
 * hover highlight rather than a ring: a ring on a wall of rows is loud.
 */
export function ListRow({
	selected = false,
	muted = false,
	size = "ui",
	type = "button",
	className = "",
	...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { selected?: boolean; muted?: boolean; size?: "ui" | "body" }) {
	const tone = selected ? "bg-neutral-800 text-amber-400" : muted ? "text-neutral-500" : "text-neutral-300";
	return (
		<button
			type={type}
			className={`flex w-full min-w-0 items-center gap-1.5 py-0.5 pr-3 pl-3 text-left ${size === "body" ? "text-body" : "text-ui"} hover:bg-neutral-800 focus-visible:bg-neutral-800 focus-visible:outline-none ${tone} ${className}`}
			{...rest}
		/>
	);
}

/* A row in a dropdown or context menu. The parent sets `role="menu"`. */
export function MenuItem({ type = "button", className = "", ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
	return (
		<button
			type={type}
			className={`block w-full px-3 py-1.5 text-left text-ui text-neutral-200 hover:bg-neutral-800 focus-visible:bg-neutral-800 focus-visible:outline-none disabled:text-neutral-600 disabled:hover:bg-transparent ${EASE} ${className}`}
			{...rest}
		/>
	);
}

/* A rule between groups of MenuItems. */
export function MenuSeparator() {
	return <div role="separator" className="my-1 border-t border-neutral-800" />;
}

/*
 * A right-click menu at the pointer. `fixed`, so the panel it came from cannot
 * clip it, and pulled back inside the window once its real size is known.
 * Closes on anything that would make its position a lie: a click elsewhere,
 * Escape, a scroll, a resize. Items close it themselves after acting.
 */
export function ContextMenu({
	x,
	y,
	label,
	width = 220,
	onClose,
	children,
}: {
	x: number;
	y: number;
	label: string;
	width?: number;
	onClose: () => void;
	children: ReactNode;
}) {
	const box = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState({ left: x, top: y });
	const close = useRef(onClose);
	close.current = onClose;

	useLayoutEffect(() => {
		const el = box.current;
		if (!el) return;
		setPos({
			left: Math.max(8, Math.min(x, window.innerWidth - el.offsetWidth - 8)),
			top: Math.max(8, Math.min(y, window.innerHeight - el.offsetHeight - 8)),
		});
	}, [x, y]);

	useEffect(() => {
		const dismiss = () => close.current();
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") dismiss();
		};
		// `capture` on scroll: a scroll inside a panel does not bubble.
		window.addEventListener("pointerdown", dismiss);
		window.addEventListener("scroll", dismiss, true);
		window.addEventListener("resize", dismiss);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("pointerdown", dismiss);
			window.removeEventListener("scroll", dismiss, true);
			window.removeEventListener("resize", dismiss);
			window.removeEventListener("keydown", onKey);
		};
	}, []);

	return (
		<div
			ref={box}
			role="menu"
			aria-label={label}
			// The dismiss listener is on the window, so keep the menu's own clicks.
			onPointerDown={(e) => e.stopPropagation()}
			style={{ ...pos, width }}
			className="fixed z-40 overflow-hidden rounded-md border border-neutral-700 bg-neutral-900 py-1 shadow-2xl"
		>
			{children}
		</div>
	);
}

/* Uppercase group heading. A string, not a component, because it lands on
   <legend>, <summary>, <th> and <div> alike. */
export const sectionLabel = "text-caption tracking-wide text-neutral-500 uppercase";

/* Text inputs and textareas. A class rather than a component so refs pass
   straight through. */
export const inputClass = {
	sm: "rounded-sm border border-neutral-800 bg-neutral-950 px-2 py-1 text-meta text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-neutral-600",
	md: "rounded-sm border border-neutral-800 bg-neutral-950 px-3 py-2 text-ui text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-neutral-600",
};

/*
 * A tab in a strip (editor/session tabs, terminal tabs). A class, not a
 * component, because tabs carry refs and roving-tabindex props. The caller
 * adds right padding: `pr-7` when a close button overlays the tab, else `pr-3`.
 */
export const tabClass = (active: boolean, focused = true) =>
	`flex h-bar max-w-52 shrink-0 items-center gap-1.5 border-b-2 pl-3 text-ui ${EASE} ${
		active
			? focused
				? "border-amber-400 text-neutral-50"
				: "border-neutral-600 text-neutral-200"
			: "border-transparent text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100"
	}`;

/* A labelled group of settings rows. */
export function Section({ title, className = "", children }: { title: string; className?: string; children: ReactNode }) {
	return (
		<fieldset className={`m-0 border-0 p-0 ${className}`}>
			<legend className={`mb-2 ${sectionLabel}`}>{title}</legend>
			{children}
		</fieldset>
	);
}

/*
 * A clickable settings row wrapping a radio or checkbox. The native input
 * keeps keyboard and screen-reader behavior; the row carries hover, selection
 * and the focus ring.
 */
export function OptionRow({
	selected = false,
	disabled = false,
	className = "",
	children,
}: {
	selected?: boolean;
	disabled?: boolean;
	className?: string;
	children: ReactNode;
}) {
	const state = selected
		? "cursor-pointer bg-neutral-800"
		: disabled
			? "opacity-60"
			: "cursor-pointer hover:bg-neutral-900";
	return (
		<label
			className={`flex items-center gap-3 rounded-sm px-2 py-2 text-ui ${state} ${EASE} ${className}`}
		>
			{children}
		</label>
	);
}

/*
 * The top row of a panel or editor tab. Fixed height so panels side by side
 * line up. `title` is plain text; anything richer goes in `children`.
 */
export function PanelHeader({
	title,
	onClose,
	closeLabel = `Close ${title?.toLowerCase() ?? "panel"}`,
	children,
}: {
	title?: string;
	onClose?: () => void;
	closeLabel?: string;
	children?: ReactNode;
}) {
	return (
		<div className="flex h-bar shrink-0 items-center gap-2 border-b border-neutral-800 px-3">
			{title && <span className="shrink-0 text-ui text-neutral-300">{title}</span>}
			{children}
			{onClose && (
				<IconButton size="sm" className="ml-auto" onClick={onClose} label={closeLabel}>
					<X size={16} />
				</IconButton>
			)}
		</div>
	);
}
