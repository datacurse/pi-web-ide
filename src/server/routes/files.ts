import { Hono, type Context } from "hono";
import { getMimeType } from "hono/utils/mime";
import { createStreamBody } from "@hono/node-server/utils/stream";
import { basename, join } from "node:path";
import { createReadStream, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
	copyEntry,
	createEntry,
	listDir,
	moveEntry,
	readFile as readReviewFile,
	safePath,
	saveUpload,
	trashEntry,
	writeFile,
} from "../files.js";
import { query, json, type Deps, type Env } from "../http.js";

/** Project files: read, save, upload, download, and the explorer's file operations. */
export function filesRoutes({ cwd: CWD }: Deps) {
	/**
	 * The explorer's file operations. Each takes paths the browser names, so all
	 * of them go through files.ts's project check; none overwrites an existing
	 * target, and delete moves to the desktop Trash rather than unlinking.
	 */
	/**
	 * `Content-Disposition` for a download: an ASCII `filename` every browser
	 * reads, plus RFC 5987 `filename*` carrying the real name when it is not ASCII.
	 */
	function attachment(name: string): string {
		const ascii = name.replace(/[^\x20-\x7e]/g, "?").replace(/["\\]/g, "\\$&");
		if (!/[^\x20-\x7e]/.test(name)) return `attachment; filename="${ascii}"`;
		const encoded = encodeURIComponent(name).replace(
			/['()*]/g,
			(ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
		);
		return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
	}

	const str = (v: unknown) => (typeof v === "string" ? v : "");

	const fileOp = (c: Context<Env>, run: () => string | void) => {
		try {
			return c.json({ ok: true, path: run() || null }, 200);
		} catch (err) {
			return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
		}
	};

	return new Hono<Env>()
		/**
		 * The file behind a hunk, as it is RIGHT NOW.
		 *
		 * The pane diffs against live contents rather than anything remembered: the
		 * agent may have edited the same file again, or the user in their own editor,
		 * and a review rendered from a stale copy would offer to revert text that is
		 * no longer there.
		 */
		.get("/file", query<{ path?: string }>(), (c) => {
			const path = c.req.query("path") ?? "";
			try {
				return c.json({ path, content: readReviewFile(CWD, path) }, 200);
			} catch (err) {
				return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
			}
		})

		/**
		 * Save a file the user edited.
		 *
		 * `expect` is what the editor had when it opened the buffer, and a mismatch is
		 * a 409 rather than a write. The agent edits these same files, so "someone
		 * else saved while this tab was open" is the NORMAL case here, not a rare
		 * race — and the only safe answer is to refuse and let the UI offer a reload.
		 */
		.put("/file", json<{ path: string; content: string; expect: string }>(), async (c) => {
			const b = c.req.valid("json");
			const path = typeof b.path === "string" ? b.path : "";
			const content = typeof b.content === "string" ? b.content : null;
			const expect = typeof b.expect === "string" ? b.expect : null;
			if (content === null || expect === null) {
				return c.json({ error: "path, content and expect are required" }, 400);
			}
			try {
				writeFile(CWD, path, expect, content);
				return c.json({ ok: true }, 200);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				// A stale buffer is a conflict the client can resolve by reloading; a bad
				// path is the client's bug. Different statuses so the UI can tell them
				// apart without parsing the message.
				return c.json({ error: message }, message.includes("changed on disk") ? 409 : 400);
			}
		})

		/**
		 * A file picked in the browser, which may be on another machine than pi.
		 * Saved under the temp dir so the agent can read it by path; each upload gets
		 * its own folder so the original name is kept without collisions.
		 *
		 * With `dir` it is a drop on the explorer instead: written into that project
		 * folder, `name` may carry subfolders, and nothing is overwritten.
		 */
		.post("/upload", async (c) => {
			const dir = c.req.query("dir");
			if (dir) {
				const data = Buffer.from(await c.req.arrayBuffer());
				return fileOp(c, () => saveUpload(CWD, dir, c.req.query("name") ?? "", data));
			}
			const name = basename(c.req.query("name") ?? "");
			if (!name || name === "." || name === "..") return c.json({ error: "name required" }, 400);
			const data = Buffer.from(await c.req.arrayBuffer());
			try {
				const dir = join(tmpdir(), "pwi-uploads", randomUUID());
				mkdirSync(dir, { recursive: true });
				const path = join(dir, name);
				writeFileSync(path, data);
				return c.json({ path }, 200);
			} catch (err) {
				return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
			}
		})

		/**
		 * A file as a download, for the explorer's "Download". Raw bytes and no size
		 * cap: unlike /api/file it is streamed to disk, never rendered.
		 */
		.get("/download", (c) => {
			try {
				const full = safePath(CWD, c.req.query("path") ?? "");
				const stat = statSync(full);
				if (!stat.isFile()) throw new Error(`not a file: ${full}`);
				const name = basename(full);
				return c.body(createStreamBody(createReadStream(full)), 200, {
					"Content-Type": getMimeType(name) ?? "application/octet-stream",
					"Content-Length": String(stat.size),
					"Content-Disposition": attachment(name),
				});
			} catch (err) {
				return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
			}
		})

		.post("/files/create", json<{ path: string; dir?: boolean }>(), (c) => {
			const b = c.req.valid("json");
			return fileOp(c, () => createEntry(CWD, str(b.path), b.dir === true));
		})

		.post("/files/move", json<{ from: string; to: string }>(), (c) => {
			const b = c.req.valid("json");
			return fileOp(c, () => moveEntry(CWD, str(b.from), str(b.to)));
		})

		.post("/files/copy", json<{ from: string; toDir: string }>(), (c) => {
			const b = c.req.valid("json");
			return fileOp(c, () => copyEntry(CWD, str(b.from), str(b.toDir)));
		})

		.post("/files/trash", json<{ path: string }>(), (c) => {
			const b = c.req.valid("json");
			return fileOp(c, () => trashEntry(CWD, str(b.path)));
		})

		/** One directory's files and subdirectories, for the editor's tree. */
		.get("/files", query<{ path?: string }>(), (c) => {
			const path = c.req.query("path") ?? "";
			try {
				return c.json({ path, entries: listDir(CWD, path || CWD) }, 200);
			} catch (err) {
				return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
			}
		});
}
