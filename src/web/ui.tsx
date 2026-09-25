/*
 * Shared UI primitives. Rules and when to use which: docs/ui.md.
 * Tune a control here, not at its call sites. `className` is for layout
 * (margins, flex, width) only; restyling through it fights these classes.
 */
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { X } from "@phosphor-icons/react";

const EASE = "transition-colors duration-150 ease-out motion-reduce:transition-none";
const FOCUS =
	"focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-neutral-400";

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
			className={`inline-flex shrink-0 items-center justify-center rounded-sm ${BUTTON_SIZE[size]} ${BUTTON_VARIANT[variant]} ${EASE} ${FOCUS} ${className}`}
			{...rest}
		/>
	);
}

const ICON_VARIANT = {
	ghost: "text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100",
	outline: "border border-neutral-700 bg-neutral-900 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100",
	/* The send button: inverted, the strongest mark in the composer. */
	solid: "bg-neutral-100 text-neutral-900 hover:bg-neutral-200",
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
			className={`flex shrink-0 items-center justify-center ${ICON_SIZE[size]} ${round ? "rounded-full" : "rounded-sm"} ${ICON_VARIANT[variant]} disabled:text-neutral-600 disabled:hover:bg-transparent ${EASE} ${FOCUS} ${className}`}
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
	type = "button",
	className = "",
	...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { selected?: boolean; muted?: boolean }) {
	const tone = selected ? "bg-neutral-800 text-amber-400" : muted ? "text-neutral-500" : "text-neutral-300";
	return (
		<button
			type={type}
			className={`flex w-full min-w-0 items-center gap-1.5 py-0.5 pr-3 pl-3 text-left text-ui hover:bg-neutral-800 focus-visible:bg-neutral-800 focus-visible:outline-none ${tone} ${className}`}
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

/* Uppercase group heading. A string, not a component, because it lands on
   <legend>, <summary>, <th> and <div> alike. */
export const sectionLabel = "text-caption tracking-wide text-neutral-500 uppercase";

/* Text inputs and textareas. A class rather than a component so refs pass
   straight through. */
export const inputClass = {
	sm: "rounded-sm border border-neutral-800 bg-neutral-950 px-2 py-1 text-meta text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-neutral-600",
	md: "rounded-sm border border-neutral-800 bg-neutral-950 px-3 py-2 text-ui text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-neutral-600",
};

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
			className={`flex items-center gap-3 rounded-sm px-2 py-2 text-ui has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-neutral-400 ${state} ${EASE} ${className}`}
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
