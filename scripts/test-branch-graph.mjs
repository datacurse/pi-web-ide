import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gitRoutes } from "../src/server/routes/git.ts";
import { branchGraph } from "../src/web/CommitGraph.tsx";

// Run with: node --import tsx --test scripts/test-branch-graph.mjs
test("local branch tracks follow tips independently of parent edges", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pwi-branch-graph-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    }).trim();
  const commit = (subject) => {
    git("commit", "--allow-empty", "-m", subject);
    return git("rev-parse", "HEAD");
  };
  const routes = gitRoutes({ cwd });
  const load = async (query = "") => {
    const response = await routes.request(`/git/log${query}`);
    assert.equal(response.status, 200);
    const { commits, branches } = await response.json();
    return branchGraph(commits, branches);
  };
  const tipsAt = (graph, hash) =>
    graph.rows
      .find(({ commit }) => commit.hash === hash)
      .branches.tracks.filter(({ atTip }) => atTip)
      .map(({ column }) => graph.columns[column].name);

  git("init", "-b", "main");
  git("config", "user.name", "Branch Graph Test");
  git("config", "user.email", "test@example.invalid");
  const parent = commit("Older commit");
  const base = commit("Shared tip");
  git("checkout", "-b", "loki");
  git("update-ref", "refs/remotes/origin/main", base);
  const before = await load();
  assert.deepEqual(
    before.columns.map(({ name }) => name),
    ["loki", "main"],
  );
  git("branch", "prod");
  git("tag", "main", base);
  assert.equal(git("rev-parse", "HEAD"), base);
  const shared = await load();
  assert.deepEqual(
    shared.columns.map(({ name, current }) => [name, current]),
    [
      ["loki", true],
      ["main", false],
      ["prod", false],
    ],
  );
  assert.deepEqual(tipsAt(shared, base), ["loki", "main", "prod"]);
  assert.equal(
    shared.rows.filter(({ commit }) => commit.hash === base).length,
    1,
  );
  assert.deepEqual(
    shared.rows.find(({ commit }) => commit.hash === parent).branches.tracks,
    [],
  );

  const loki = commit("Loki advances");
  const ahead = await load();
  assert.deepEqual(tipsAt(ahead, loki), ["loki"]);
  assert.deepEqual(tipsAt(ahead, base), ["main", "prod"]);
  const limited = await load("?limit=1");
  assert.equal(limited.rows.length, 1);
  assert.deepEqual(
    limited.columns.map(({ name, tipRow }) => [name, tipRow]),
    [
      ["loki", 0],
      ["main", undefined],
      ["prod", undefined],
    ],
  );

  git("tag", "-d", "main");
  git("checkout", "main");
  const main = commit("Main diverges");
  const diverged = await load();
  assert.deepEqual(tipsAt(diverged, loki), ["loki"]);
  assert.deepEqual(tipsAt(diverged, main), ["main"]);
  assert.deepEqual(tipsAt(diverged, base), ["prod"]);
  assert.equal(diverged.columns.find(({ current }) => current).name, "main");

  git("merge", "--no-ff", "-m", "Merge loki", "loki");
  const merge = (await load()).rows[0];
  assert.deepEqual(merge.commit.parents, [main, loki]);
  assert.equal(
    merge.outgoing.filter(({ from }) => from === merge.lane).length,
    2,
  );
});
