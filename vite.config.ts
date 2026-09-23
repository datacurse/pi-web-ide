import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import pkg from "./package.json" with { type: "json" };

// Stamped at build (and dev-server) start, not at runtime: the browser has no
// git. `*` marks a working tree with uncommitted changes, which is the whole
// point when comparing two machines that both claim the same commit.
function gitVersion(): string {
	try {
		const sha = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
			.toString()
			.trim();
		const dirty = execSync("git status --porcelain", { stdio: ["ignore", "pipe", "ignore"] })
			.toString()
			.trim();
		return `${pkg.version}+${sha}${dirty ? "*" : ""}`;
	} catch {
		// No git (tarball, Docker build context without .git). The version alone
		// is still more than nothing.
		return pkg.version;
	}
}

// Dev: Vite serves the client and proxies /api to the Node server.
// Prod: `pnpm build` emits dist/, which the Node server serves itself.
// Either way it is a single origin, so there is no CORS machinery to own.
export default defineConfig({
	plugins: [react(), tailwindcss()],
	define: { __APP_VERSION__: JSON.stringify(gitVersion()) },
	server: {
		// Same env var the server reads to build its dev redirect (see index.ts):
		// two places deciding this independently is how you get a 302 to a port
		// nothing is listening on.
		port: Number(process.env.PWI_VITE_PORT ?? 5480),
		// A dev server that silently moves to the next free port makes that
		// redirect wrong, which is worse than failing to start.
		strictPort: true,
		// Loopback only. Windows reaches 127.0.0.1 inside WSL via localhost
		// forwarding (NAT) or mirrored networking (see ~/.wslconfig). Do NOT set
		// `host: true` to work around a networking problem — that exposes the dev
		// server to the LAN to fix something that belongs in WSL config.
		host: "127.0.0.1",
		proxy: {
			"/api": {
				target: `http://127.0.0.1:${process.env.PWI_PORT ?? 8890}`,
				changeOrigin: true,
				// `changeOrigin` rewrites Host but NOT Origin, so the server sees
				// Origin: <vite> against Host: <server> and refuses the terminal's
				// upgrade (originAllowed in server/index.ts) — a pane stuck on
				// [reconnecting…] beside a shell that is running fine. The server
				// can allow the Vite origin itself, but only when started with
				// PWI_DEV=1; rewriting Origin here makes the proxy consistent about
				// which origin it claims to be, so the client works against a
				// server started either way. Dev-only, and no wider than PWI_DEV
				// already is — both are this same loopback port.
				headers: { Origin: `http://127.0.0.1:${process.env.PWI_PORT ?? 8890}` },
				// The terminal is a WebSocket on /api/terminal/socket, and a proxy
				// entry without this answers its upgrade with a 200 and no socket
				// — which in the browser is a terminal that connects, says
				// nothing, and closes.
				ws: true,
			},
		},
	},
	build: { outDir: "dist" },
});
