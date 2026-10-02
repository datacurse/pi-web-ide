import { readFile, readdir } from "node:fs/promises";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { agentDir } from "./packages.js";

export async function readAgentFile(path: string) {
  try {
    return { path, content: await readFile(path, "utf8"), error: null };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { path, content: null, error: null };
    }
    return {
      path,
      content: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function instructionPath(cwd: string, scope: "global" | "local") {
  return join(scope === "global" ? agentDir() : cwd, "AGENTS.md");
}

function backlogDir(path: string) {
  return join(
    agentDir(),
    "pwi-instruction-backlog",
    createHash("sha256").update(resolve(path)).digest("hex"),
  );
}

const VERSION =
  /^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.md$/;

async function backlog(path: string) {
  let names: string[];
  try {
    names = await readdir(backlogDir(path));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return Promise.all(
    names
      .filter((name) => VERSION.test(name))
      .sort()
      .reverse()
      .map(async (id) => ({
        id,
        createdAt: Number(id.slice(0, 13)),
        content: await readFile(join(backlogDir(path), id), "utf8"),
      })),
  );
}

export async function agentInstructions(cwd: string) {
  const globalPath = instructionPath(cwd, "global");
  const localPath = instructionPath(cwd, "local");
  const [global, local, globalBacklog, localBacklog] = await Promise.all([
    readAgentFile(globalPath),
    readAgentFile(localPath),
    backlog(globalPath),
    backlog(localPath),
  ]);
  return {
    global,
    local,
    backlog: { global: globalBacklog, local: localBacklog },
  };
}

export function switchAgentInstructions(
  cwd: string,
  scope: "global" | "local",
  version: string | null,
  expected: string | null,
) {
  if (scope !== "global" && scope !== "local")
    throw new Error("invalid instruction scope");
  if (
    version !== null &&
    (typeof version !== "string" || !VERSION.test(version))
  )
    throw new Error("invalid instruction version");
  const content =
    version === null
      ? ""
      : readFileSync(
          join(backlogDir(instructionPath(cwd, scope)), version),
          "utf8",
        );
  saveAgentInstructions(cwd, scope, content, expected);
}

export function saveAgentInstructions(
  cwd: string,
  scope: "global" | "local",
  content: string,
  expected: string | null,
) {
  if (scope !== "global" && scope !== "local")
    throw new Error("invalid instruction scope");
  if (typeof content !== "string")
    throw new Error("instruction contents required");
  if (expected !== null && typeof expected !== "string")
    throw new Error("expected contents required");
  const path = instructionPath(cwd, scope);
  let current: string | null = null;
  let mode = 0o600;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile())
      throw new Error(
        "AGENTS.md must be a regular file, not a symlink or directory",
      );
    mode = stat.mode & 0o777;
    current = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (current !== expected)
    throw new Error(
      "AGENTS.md changed on disk. Reopen Settings before saving or switching.",
    );
  if (current !== null) {
    mkdirSync(backlogDir(path), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(backlogDir(path), `${Date.now()}-${randomUUID()}.md`),
      current,
      { flag: "wx", mode: 0o600 },
    );
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.AGENTS.md-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { flag: "wx", mode });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
