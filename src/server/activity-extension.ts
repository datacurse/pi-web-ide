import { ACTIVITY_STATUS } from "../shared/activity.ts";

interface Context {
	isIdle(): boolean;
	ui: { setStatus(key: string, text: string): void };
}
interface Pi {
	on(event: "context" | "before_provider_request" | "before_provider_headers", handler: (event: unknown, ctx: Context) => void): void;
	on(event: "after_provider_response", handler: (event: { status: number }, ctx: Context) => void): void;
}

/** Only timestamps and phase names cross RPC: never payloads or response headers. */
export default function activity(pi: Pi) {
	const phase = (ctx: Context, kind: string, status?: number) => {
		if (ctx.isIdle()) return;
		ctx.ui.setStatus(ACTIVITY_STATUS, JSON.stringify({ kind, at: Date.now(), ...(status === undefined ? {} : { status }) }));
	};
	pi.on("context", (_event, ctx) => phase(ctx, "preparing"));
	pi.on("before_provider_request", (_event, ctx) => phase(ctx, "request"));
	pi.on("before_provider_headers", (_event, ctx) => phase(ctx, "request"));
	pi.on("after_provider_response", ({ status }, ctx) => phase(ctx, "response", status));
}
