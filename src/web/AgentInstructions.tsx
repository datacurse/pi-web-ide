import { useEffect, useRef, useState } from "react";
import { api, unwrap } from "./api.js";
import { t } from "./i18n.js";
import { Button } from "./ui.js";

type Instructions = Awaited<ReturnType<typeof load>>;
const load = (cwd?: string) => unwrap(api["agent-instructions"].$get({ query: { cwd } }));

export function AgentInstructions({ cwd, open }: { cwd?: string; open: boolean }) {
	const [data, setData] = useState<Instructions | null>(null);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const generation = useRef(0);
	useEffect(() => {
		const request = ++generation.current;
		if (!open) return;
		setData(null);
		setError("");
		setBusy(false);
		void load(cwd).then(
			(result) => { if (request === generation.current) setData(result); },
			(err) => { if (request === generation.current) setError(String(err)); },
		);
		return () => { generation.current++; };
	}, [cwd, open]);

	async function activate(scope: "global" | "local", version: string | null) {
		if (!data || busy) return;
		const request = generation.current;
		setBusy(true);
		setError("");
		try {
			const result = await unwrap(api["agent-instructions"].$post({
				query: { cwd },
				json: { scope, version, expected: data[scope].content },
			}));
			if (request === generation.current) setData(result);
		} catch (err) {
			if (request === generation.current) setError(String(err));
		} finally {
			if (request === generation.current) setBusy(false);
		}
	}

	return (
		<div className="space-y-3">
			<p className="text-meta text-neutral-500">{t("Start a fresh session after switching instructions. Existing sessions keep their loaded context.")}</p>
			{error && <p role="alert" className="text-ui text-red-400">{error}</p>}
			{!data && !error && <p className="text-ui text-neutral-500">{t("Loading…")}</p>}
			{data && <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
				{([["global", t("Global AGENTS.md")], ["local", t("Project AGENTS.md")]] as const).map(([key, label]) => {
					const file = data[key];
					return (
						<section key={key} aria-label={label} className="min-w-0 space-y-2">
							<div className="flex items-center justify-between gap-2">
								<h3 className="text-ui text-neutral-200">{label}</h3>
								<Button size="sm" disabled={busy || !!file.error} onClick={() => void activate(key, null)}>{t("New empty")}</Button>
							</div>
							<p className="break-all font-mono text-meta text-neutral-500">{file.path}</p>
							<p className="text-meta text-neutral-400">{t("Current")}</p>
							{file.error && <p role="alert" className="text-ui text-red-400">{file.error}</p>}
							{!file.error && file.content === null && <p className="text-ui text-neutral-500">{t("File not found.")}</p>}
							{!file.error && file.content !== null && <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-neutral-800 bg-neutral-900 p-3 font-mono text-body text-neutral-200">{file.content || t("File is empty.")}</pre>}
							<h4 className="text-ui text-neutral-400">{t("Backlog")}</h4>
							{data.backlog[key].length === 0 && <p className="text-meta text-neutral-500">{t("No previous versions.")}</p>}
							{data.backlog[key].map((version) => (
								<details key={version.id} className="rounded-sm border border-neutral-800 p-2">
									<summary className="cursor-pointer text-ui text-neutral-400">{new Date(version.createdAt).toLocaleString()}</summary>
									<div className="mt-2 space-y-2">
										<pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-body text-neutral-200">{version.content || t("File is empty.")}</pre>
										<Button size="sm" disabled={busy || !!file.error} onClick={() => void activate(key, version.id)}>{t("Use as current")}</Button>
									</div>
								</details>
							))}
						</section>
					);
				})}
			</div>}
		</div>
	);
}
