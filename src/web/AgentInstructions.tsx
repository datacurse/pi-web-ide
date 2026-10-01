import { useEffect, useState } from "react";
import { api, unwrap } from "./api.js";
import { t } from "./i18n.js";

type Instructions = Awaited<ReturnType<typeof load>>;
const load = (cwd?: string) => unwrap(api["agent-instructions"].$get({ query: { cwd } }));

export function AgentInstructions({ cwd, open }: { cwd?: string; open: boolean }) {
	const [data, setData] = useState<Instructions | null>(null);
	const [error, setError] = useState("");
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setData(null);
		setError("");
		void load(cwd).then(
			(result) => { if (!cancelled) setData(result); },
			(err) => { if (!cancelled) setError(String(err)); },
		);
		return () => { cancelled = true; };
	}, [cwd, open]);

	if (error) return <p role="alert" className="text-ui text-red-400">{error}</p>;
	if (!data) return <p className="text-ui text-neutral-500">{t("Loading…")}</p>;
	return (
		<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
			{([["global", t("Global AGENTS.md")], ["local", t("Project AGENTS.md")]] as const).map(([key, label]) => {
				const file = data[key];
				return (
					<section key={key} aria-label={label} className="min-w-0">
						<h3 className="text-ui text-neutral-200">{label}</h3>
						<p className="mb-2 break-all font-mono text-meta text-neutral-500">{file.path}</p>
						{file.error ? (
							<p role="alert" className="text-ui text-red-400">{file.error}</p>
						) : file.content === null ? (
							<p className="text-ui text-neutral-500">{t("File not found.")}</p>
						) : (
							<pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-neutral-800 bg-neutral-900 p-3 font-mono text-body text-neutral-200">{file.content || t("File is empty.")}</pre>
						)}
					</section>
				);
			})}
		</div>
	);
}
