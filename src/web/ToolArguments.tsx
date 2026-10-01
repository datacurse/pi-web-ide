import { Merge } from "./DiffView.js";
import { t } from "./i18n.js";

function valueText(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? String(value);
}

export function ToolArguments({ name, args, diff }: { name: string; args: unknown; diff?: string }) {
	if (args === undefined) return null;
	if (!args || typeof args !== "object" || Array.isArray(args)) {
		return <pre className="p-3 whitespace-pre-wrap wrap-anywhere">{valueText(args)}</pre>;
	}
	const fields = args as Record<string, unknown>;
	const path = typeof fields.path === "string" ? fields.path : undefined;
	const command = (name === "bash" || name === "powershell") && typeof fields.command === "string" ? fields.command : undefined;
	const edits = name === "edit" && Array.isArray(fields.edits) && fields.edits.every(
		(edit) => edit && typeof edit === "object" && typeof edit.oldText === "string" && typeof edit.newText === "string",
	) ? fields.edits as { oldText: string; newText: string }[] : undefined;
	const content = name === "write" && typeof fields.content === "string" ? fields.content : undefined;
	const replacementLines = name === "replace" && Array.isArray(fields.replacement_lines) && fields.replacement_lines.every((line) => typeof line === "string")
		? fields.replacement_lines as string[] : undefined;
	const rest = Object.entries(fields).filter(([key]) =>
		!(key === "path" && path !== undefined) &&
		!(key === "command" && command !== undefined) &&
		!(key === "edits" && edits !== undefined) &&
		!(key === "content" && content !== undefined) &&
		!(key === "replacement_lines" && replacementLines !== undefined) &&
		!(name === "replace" && (key === "remove_from" || key === "remove_to")),
	);
	if (command !== undefined) return <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-3 py-1 text-neutral-300">
		<pre className="min-w-0 flex-1 whitespace-pre-wrap wrap-anywhere font-mono"><span className="mr-2 select-none text-amber-400" aria-hidden>$</span>{command}</pre>
		{rest.map(([key, value]) => <div key={key} className="flex gap-2 text-meta"><span className="text-neutral-500">{key}</span><pre className="whitespace-pre-wrap wrap-anywhere">{valueText(value)}</pre></div>)}
	</div>;
	return <div className="text-neutral-300">
		{path !== undefined && <div className="border-b border-neutral-800 px-3 py-2 font-mono whitespace-pre-wrap wrap-anywhere text-blue-400">{path}</div>}

		{edits?.map((edit, i) => <div key={i} className="border-b border-neutral-800">
			<div className="px-3 py-1 text-caption text-neutral-500">{t("Changes")} · {i + 1} / {edits.length}</div>
			<div className="flex max-h-64 min-h-0 flex-col overflow-hidden">
				<Merge path={path ?? ""} before={edit.oldText} after={edit.newText} />
			</div>
		</div>)}
		{diff !== undefined ? <pre className="border-b border-neutral-800 font-mono whitespace-pre-wrap wrap-anywhere">{diff.split("\n").map((line, i) => {
			const row = line.replace(/^\s*\d+\s+│\s*/, "");
			if (name === "replace" && !row.startsWith("+") && !row.startsWith("-")) return null;
			const color = row.startsWith("+") && !row.startsWith("+++") ? "text-green-400" : row.startsWith("-") && !row.startsWith("---") ? "text-red-400" : "text-neutral-400";
			return <span key={i} className={`block px-3 ${color}`}>{name === "replace" ? row : line}</span>;
		})}</pre> : replacementLines !== undefined && <pre className="border-b border-neutral-800 p-3 font-mono whitespace-pre-wrap wrap-anywhere text-green-400">{replacementLines.join("\n")}</pre>}
		{content !== undefined && <pre className="p-3 font-mono whitespace-pre-wrap wrap-anywhere">{content}</pre>}
		{rest.length > 0 && <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 p-3">
			{rest.map(([key, value]) => <div key={key} className="contents">
				<dt className="text-meta text-neutral-500">{key}</dt>
				<dd className="min-w-0"><pre className="whitespace-pre-wrap wrap-anywhere">{valueText(value)}</pre></dd>
			</div>)}
		</dl>}
	</div>;
}
