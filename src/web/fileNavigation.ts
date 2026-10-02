import { createContext } from "react";
import type { EditorView } from "@codemirror/view";
import type { CmModules } from "./codemirror.js";

export type OpenSourceFile = (path: string, line?: number) => void;
export const FileNavigationContext = createContext<OpenSourceFile | undefined>(undefined);

export interface FileLocation {
	path: string;
	line: number;
	request: number;
}

/** A fresh request also makes clicking the same location again re-focus and re-scroll its editor. */
export function fileLocation(previous: FileLocation | undefined, path: string, line?: number): FileLocation | undefined {
	if (line === undefined || !Number.isFinite(line) || line < 1) return;
	return { path, line: Math.floor(line), request: (previous?.request ?? 0) + 1 };
}

/** The file can have shortened since the recorded edit. Clamp, without changing its contents. */
export function revealFileLine(view: EditorView, cm: Pick<CmModules, "EditorView">, requested: number): void {
	const number = Number.isFinite(requested) ? Math.max(1, Math.min(view.state.doc.lines, Math.floor(requested))) : 1;
	const line = view.state.doc.line(number);
	view.dispatch({ selection: { anchor: line.from }, effects: cm.EditorView.scrollIntoView(line.from, { y: "center" }) });
	view.focus();
}
