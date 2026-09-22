import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Dev: Vite serves the client and proxies /api to the Node server.
// Prod: `pnpm build` emits dist/, which the Node server serves itself.
// Either way it is a single origin, so there is no CORS machinery to own.
export default defineConfig({
	plugins: [react(), tailwindcss()],
	server: {
		// Same env var the server reads to build its dev redirect (see index.ts):
		// two places deciding this independently is how you get a 302 to a port
		// nothing is listening on.
		port: Number(process.env.PIW_VITE_PORT ?? 5480),
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
				target: `http://127.0.0.1:${process.env.PIW_PORT ?? 8890}`,
				changeOrigin: true,
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
