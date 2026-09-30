import { Hono } from "hono";
import {
	apply,
	init as gitInit,
	changes as gitChanges,
	log as gitLog,
	repos as gitRepos,
	show as gitShow,
	status as gitStatus,
	suggestMessage,
	type GitPlan,
} from "../git.js";
import { nameCommit } from "../autoname.js";
import { query, json, type Deps, type Env } from "../http.js";

/** Git: status, changes, log, one file's diff, commit naming, and the commit/push/PR plan. */
export function gitRoutes({ cwd: CWD }: Deps) {
	return new Hono<Env>()
		/**
		 * Git: what the commit button can offer, and doing it.
		 *
		 * `cwd` is the project, not the server's own: the button belongs to the
		 * session on screen, and a pwi serving several projects would otherwise
		 * commit in whichever one it was started in.
		 */
		.get("/git", query<{ cwd?: string }>(), async (c) => {
			const cwd = c.req.query("cwd") || CWD;
			const [state, message] = await Promise.all([gitStatus(cwd), suggestMessage(cwd)]);
			return c.json({ ...state, suggestion: message }, 200);
		})

		/**
		 * Which paths are uncommitted, and how. NAMES only, no content.
		 *
		 * What the source-control panel's top half reads. Deliberately git and not
		 * the session's own hunk list: hunks only exist for edits THIS server process
		 * watched a tool make, so they miss anything from another session, from
		 * before a restart, or from your own editor — while the commit button counts
		 * all of it. One source for both, and the panel stops disagreeing with the
		 * button.
		 */
		.get("/git/changes", query<{ cwd?: string }>(), async (c) => {
			const cwd = c.req.query("cwd") || CWD;
			return c.json({ files: await gitChanges(cwd) }, 200);
		})

		/** Repositories one folder down, for a project folder that is not one itself. */
		.get("/git/repos", query<{ cwd?: string }>(), async (c) => {
			const cwd = c.req.query("cwd") || CWD;
			return c.json({ repos: await gitRepos(cwd) }, 200);
		})

		/**
		 * Recent commits with the paths each touched: the panel's bottom half.
		 *
		 * A fixed window rather than a paged log, because this is a tree you glance
		 * at to find the change you just made — scrolling back through a repo's
		 * history is what a real git client is for.
		 */
		.get("/git/log", query<{ cwd?: string; limit?: string }>(), async (c) => {
			const cwd = c.req.query("cwd") || CWD;
			const limit = Number(c.req.query("limit"));
			return c.json({ commits: await gitLog(cwd, Number.isFinite(limit) ? limit : undefined) }, 200);
		})

		/**
		 * One file's two sides, for a diff tab.
		 *
		 * Per file and not per panel: the list shows names, and only an opened diff
		 * pays for content. `ref` empty is the working tree; a sha is that commit
		 * against its parent.
		 */
		.get("/git/show", query<{ cwd?: string; path?: string; ref?: string }>(), async (c) => {
			const cwd = c.req.query("cwd") || CWD;
			const path = c.req.query("path") ?? "";
			const ref = c.req.query("ref") ?? "";
			if (!path) return c.json({ error: "path required" }, 400);
			try {
				return c.json(await gitShow(cwd, path, ref), 200);
			} catch (err) {
				return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
			}
		})

		/**
		 * The commit message, written by a model that read the diff.
		 *
		 * Its own endpoint rather than a flag on the POST above, because `apply` is
		 * deterministic git and stays that way: the name is chosen, shown and
		 * editable BEFORE anything is staged, and a plan that quietly spawned a
		 * model mid-commit would be a surprise inside the one operation here that
		 * must not have any.
		 *
		 * 502, not 500: the failure is always the model or its credentials, and the
		 * UI offers the file-list suggestion instead.
		 */
		.post("/git/name", json<{ cwd?: string }>(), async (c) => {
			const b = c.req.valid("json");
			const cwd = typeof b.cwd === "string" && b.cwd ? b.cwd : CWD;
			try {
				return c.json({ message: await nameCommit(cwd) }, 200);
			} catch (err) {
				return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
			}
		})

		/** `git init`, from the panel's not-a-repository state. */
		.post("/git/init", json<{ cwd?: string }>(), async (c) => {
			const b = c.req.valid("json");
			const cwd = typeof b.cwd === "string" && b.cwd ? b.cwd : CWD;
			return c.json(await gitInit(cwd), 200);
		})

		.post("/git", json<{ cwd?: string; branch?: string; message?: string; push?: boolean; pr?: boolean }>(), async (c) => {
			const b = c.req.valid("json");
			const cwd = typeof b.cwd === "string" && b.cwd ? b.cwd : CWD;
			const plan: GitPlan = {
				branch:
					typeof b.branch === "string" && b.branch
						? b.branch
						: undefined,
				message: typeof b.message === "string" ? b.message : undefined,
				push: b.push === true,
				pr: b.pr === true,
			};
			if (!plan.branch && plan.message === undefined && !plan.push && !plan.pr)
				return c.json({ error: "nothing to do" }, 400);

			const result = await apply(cwd, plan);
			// 200 either way: a refused commit ("nothing to commit") is an answer the
			// UI shows verbatim, not a transport failure.
			return c.json(result, 200);
		});
}
