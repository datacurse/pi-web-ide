import { FAST_COMMAND, supportsFastMode } from "../shared/fastMode.ts";

interface Context {
	model?: { provider: string; id: string };
	isIdle(): boolean;
	sessionManager: { getEntries(): { type: string; customType?: string; data?: unknown }[] };
	ui: { setStatus(key: string, text: string): void };
}
interface Pi {
	on(event: "session_start", handler: (event: unknown, ctx: Context) => void): void;
	on(event: "before_provider_request", handler: (event: { payload: unknown }, ctx: Context) => unknown): void;
	registerCommand(name: string, options: { handler: (args: string, ctx: Context) => void }): void;
	appendEntry(type: string, data: unknown): void;
}

export default function fastMode(pi: Pi) {
	let enabled = false;
	pi.on("session_start", (_event, ctx) => {
		enabled = false;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== FAST_COMMAND) continue;
			const data = entry.data;
			if (data && typeof data === "object" && "enabled" in data && typeof data.enabled === "boolean") enabled = data.enabled;
		}
	});
	pi.registerCommand(FAST_COMMAND, {
		handler(args, ctx) {
			const supported = supportsFastMode(ctx.model && `${ctx.model.provider}/${ctx.model.id}`);
			let error: string | undefined;
			if (args !== "status" && args !== "on" && args !== "off") error = "expected on, off, or status";
			else if (args !== "status" && !ctx.isIdle()) error = "cannot change Fast mode while streaming";
			else if (args === "on" && !supported) error = "Fast mode is not supported for this model";
			else if (args !== "status" && enabled !== (args === "on")) {
				const next = args === "on";
				pi.appendEntry(FAST_COMMAND, { enabled: next });
				enabled = next;
			}
			ctx.ui.setStatus(FAST_COMMAND, JSON.stringify({ enabled, error }));
		},
	});
	pi.on("before_provider_request", ({ payload }, ctx) => {
		if (!supportsFastMode(ctx.model && `${ctx.model.provider}/${ctx.model.id}`)) return;
		if (!payload || typeof payload !== "object" || !("model" in payload) || payload.model !== ctx.model?.id) return;
		pi.appendEntry(FAST_COMMAND, { enabled });
		return { ...payload, service_tier: enabled ? "priority" : "default" };
	});
}
