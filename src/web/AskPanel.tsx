import { useEffect, useRef, useState } from "react";
import type { AskAnswer, PiAsk } from "../shared/types.js";
import { Button, inputClass } from "./ui.js";

/**
 * Text written for a terminal, made safe for a browser.
 *
 * A pi extension's dialogs carry Nerd Font glyphs — the radio marks in front
 * of a picker's options, U+F10C and friends. Those are PRIVATE USE
 * codepoints: they mean something only to a font the terminal has and the
 * browser does not, so every one of them renders as a tofu box. The trailing
 * space goes with the glyph, or each line would start with a stray indent.
 */
const GLYPHS = /[\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]+[ \t]?/gu;

function plain(text: string): string {
	return text.replace(GLYPHS, "");
}

/**
 * The question pi is blocked on, put to the user.
 *
 * This is the `ask` tool's whole point and it used to be unreachable from a
 * browser: the host cancelled every blocking `extension_ui_request`, so the
 * tool call failed with "Ask tool was cancelled by the user" and the question
 * itself — the one thing the agent actually needed — was never shown.
 *
 * Rendered in the transcript rather than as a modal. A modal would have to be
 * dismissable to be honest about the agent still waiting, and a dismissed
 * question is a session stalled with nothing on screen saying why. Here it
 * sits where the answer belongs, under the work that led to it.
 *
 * `Cancel` is kept, and it is not a close button: it sends pi a real
 * cancellation, which fails the `ask` call and lets the turn end. That is the
 * only way out of a question the user does not want to answer, and hiding it
 * would leave the only escape hatch being to abort the turn.
 */
export function AskPanel({
	ask,
	onAnswer,
}: {
	ask: PiAsk;
	onAnswer: (askId: string, answer: AskAnswer) => void;
}) {
	const [text, setText] = useState(ask.value ?? "");
	const field = useRef<HTMLTextAreaElement | null>(null);

	/*
	 * Remounted per question via the `key` at the call site, so this runs once
	 * per question: the field starts focused because answering is the only
	 * thing to do here, and a second question in a row must not inherit the
	 * previous one's draft.
	 */
	useEffect(() => {
		field.current?.focus();
	}, []);

	return (
		<div className="chat-gutter my-3">
			<div className="chat-measure rounded-sm border border-amber-900/70 bg-amber-950/20 px-3 py-3">
				{/*
				 * The title is NOT a short label. The extension that asks composes
				 * it in the TUI's terms: the `editor` that follows a picker's
				 * "Other" carries the whole rendered picker — question, every
				 * option, its description, "Enter your response:" — as one
				 * multi-line string. Uppercasing that shouted a paragraph, and
				 * collapsing the newlines ran it into one line, so it is rendered
				 * as the text it is.
				 */}
				{ask.title && (
					<div className="text-body whitespace-pre-wrap text-amber-200/90">
						{plain(ask.title)}
					</div>
				)}
				{ask.message && (
					<div className="mt-1 text-body whitespace-pre-wrap text-neutral-200">
						{plain(ask.message)}
					</div>
				)}

				{ask.kind === "select" && (
					<div className="mt-3 space-y-1">
						{ask.options?.map((o) => (
							<button
								data-custom="choice card"
								key={o.label}
								onClick={() => onAnswer(ask.id, { value: o.label })}
								className="block w-full rounded-sm border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-left text-body transition-colors duration-150 ease-out hover:border-amber-800 hover:bg-neutral-900 motion-reduce:transition-none"
							>
								<span className="text-neutral-100">{o.label}</span>
							</button>
						))}
					</div>
				)}

				{ask.kind === "confirm" && (
					<div className="mt-3 flex gap-2">
						<Button variant="primary" onClick={() => onAnswer(ask.id, { confirmed: true })}>
							Yes
						</Button>
						<Button onClick={() => onAnswer(ask.id, { confirmed: false })}>No</Button>
					</div>
				)}

				{ask.kind === "text" && (
					<form
						onSubmit={(e) => {
							e.preventDefault();
							onAnswer(ask.id, { value: text });
						}}
						className="mt-3"
					>
						<textarea
							ref={field}
							value={text}
							onChange={(e) => setText(e.target.value)}
							onKeyDown={(e) => {
								// Enter answers, as it does in the composer. A multiline
								// question (an `editor` dialog) needs newlines, so there it takes
								// the modifier that the composer uses for the opposite.
								if (e.key !== "Enter") return;
								if (ask.multiline && !(e.metaKey || e.ctrlKey)) return;
								if (!ask.multiline && e.shiftKey) return;
								e.preventDefault();
								onAnswer(ask.id, { value: text });
							}}
							rows={ask.multiline ? 5 : 2}
							className={`w-full resize-none ${inputClass.md}`}
						/>
						<div className="mt-2 flex items-center gap-2">
							<Button type="submit" variant="primary">
								Answer
							</Button>
							<span className="text-meta text-neutral-500">
								{ask.multiline ? "Ctrl+Enter to send" : "Enter to send"}
							</span>
						</div>
					</form>
				)}

				<Button
					variant="ghost"
					size="sm"
					className="mt-3"
					onClick={() => onAnswer(ask.id, { cancelled: true })}
				>
					Cancel — fails the tool call and ends the turn
				</Button>
			</div>
		</div>
	);
}
