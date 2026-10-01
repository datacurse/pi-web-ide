import { automaticModel, autoCompactionEnabled } from "./automaticModelConfig.ts";

interface Pi {
	on(event: "session_before_compact", handler: (
		event: {
			preparation: { fileOps: { read: Set<string>; edited: Set<string> } };
			branchEntries?: { type: string; details?: { readFiles?: unknown; modifiedFiles?: unknown } }[];
			customInstructions?: string;
			reason: "manual" | "threshold" | "overflow";
			signal: AbortSignal;
		},
		ctx: {
			modelRegistry: {
				find(provider: string, id: string): { id: string; provider: string } | undefined;
				streamSimple(model: unknown, context: unknown, options: unknown): { result(): Promise<{ content: object[]; stopReason: string }> };
			};
			ui: { notify(message: string, level: "error"): void };
		},
	) => Promise<unknown>): void;
}

export default function compaction(pi: Pi) {
	pi.on("session_before_compact", async (event, ctx) => {
		try {
			if (event.reason !== "manual" && !autoCompactionEnabled()) return { cancel: true };
			const selector = automaticModel("compaction");
			const slash = selector.indexOf("/");
			const model = ctx.modelRegistry.find(selector.slice(0, slash), selector.slice(slash + 1));
			if (!model) throw new Error(`unknown compaction model: ${selector}`);
			// pi skips cumulative file lists for hook-generated summaries; retain our standard details.
			const previous = event.branchEntries?.findLast((entry) => entry.type === "compaction")?.details;
			for (const [key, target] of [["readFiles", event.preparation.fileOps.read], ["modifiedFiles", event.preparation.fileOps.edited]] as const) {
				const files = previous?.[key];
				if (Array.isArray(files)) for (const file of files) if (typeof file === "string") target.add(file);
			}
			// pi supplies this package to its extension loader; it is not a pwi dependency.
			const packageName = "@earendil-works/pi-coding-agent";
			const { compact } = await import(packageName);
			const result = await compact(
				event.preparation, model, undefined, undefined, event.customInstructions, event.signal, "off",
				(m: unknown, context: unknown, options: unknown) => ctx.modelRegistry.streamSimple(m, context, options),
			);
			return { compaction: result };
		} catch (err) {
			ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
			return { cancel: true };
		}
	});
}
