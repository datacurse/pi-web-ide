import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import pkg from "./package.json" with { type: "json" };

// Stamped at build (and dev-server) start, not at runtime: the browser has no
// git. `*` marks a working tree with uncommitted changes, which is the whole
// point when comparing two machines that both claim the same commit.
//
// The PATCH number is the commit count, not package.json's: `0.1.<n commits>`.
// package.json owns major.minor (the deliberate part of a version) and git
// owns the patch (the mechanical part), so the number moves on its own and
// nobody has to remember to bump it — and crucially there is no version-bump
// COMMIT, which would increment the count it is trying to record.
function gitVersion(): string {
	try {
		const git = (args: string[]) =>
			execSync(`git ${args.join(" ")}`, { stdio: ["ignore", "pipe", "ignore"] })
				.toString()
				.trim();
		// `major.minor` from package.json; anything past it is git's to decide.
		const [major = "0", minor = "0"] = pkg.version.split(".");
		// Counts THIS branch's history, so it only goes backwards if you do —
		// and a shallow clone (CI with fetch-depth 1) counts what it has, which
		// is why the sha below is the real identity and this is only a label.
		const count = git(["rev-list", "--count", "HEAD"]);
		const sha = git(["rev-parse", "--short", "HEAD"]);
		const dirty = git(["status", "--porcelain"]);
		return `${major}.${minor}.${count}+${sha}${dirty ? "*" : ""}`;
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
