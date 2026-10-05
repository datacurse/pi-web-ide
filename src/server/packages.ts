/**
 * packages.ts — THE PACKAGE BOUNDARY.
 *
 * The only file that runs `pi install|remove|update` or reads the `packages`
 * key of pi's settings. Everything else asks this module.
 *
 * What a package is, and why this is short: pi already owns installation.
 * `packages` in `~/.pi/agent/settings.json` is the desired state, pi installs
 * anything missing at startup (verified — docs/pi-facts.md §0.6), and the CLI
 * does the resolving, cloning and `npm install`. So this module reads that
 * one array, shells out for the four mutations, and reports what is on disk.
 * It does not maintain a second inventory.
 *
 * Security: a pi package runs with full system access — extensions are code,
 * and skills instruct the model. Installing one is therefore the same class
 * of action as opening a terminal here, which this server already offers.
 * That is the ceiling, not a licence to widen it: sources are validated
 * before a process is spawned, every mutation goes through an args array so
 * nothing reaches a shell, and local paths are refused from the API.
 */

import { execFile } from "node:child_process";
import {
  accessSync,
  constants,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { PI_BIN } from "./agent.js";
import { latestVersion } from "./gallery.js";
import { isRecord } from "./guards.js";
import { readSettings, writeSettings } from "./models.js";
import type { PiwPackage, PiwPackagesView } from "../shared/types.js";

/** One `pi install` can clone a repo and run `npm install`; a minute is not enough. */
const TIMEOUT_MS = Number(process.env.PWI_PACKAGES_TIMEOUT_MS ?? 300_000);

/** The tail of combined output kept for the UI. npm is verbose and the end is the verdict. */
const LOG_KEEP = 4_096;

/**
 * Non-interactive git. Without these a private repo with no usable
 * credential does not fail — it blocks on a credential prompt reading from a
 * stdin that will never answer, and the install sits there until the timeout.
 */
const GIT_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=5",
};

export type { PiwPackage };

/** `GET /api/packages` minus the pi version, which index.ts adds. */
export type PackagesView = Omit<
  PiwPackagesView,
  "piVersion" | "piLatestVersion"
>;

/**
 * Bumped on every successful mutation.
 *
 * Extensions, skills and prompt templates are read when a pi child STARTS, so
 * a session that was already open when a package landed cannot see it. The
 * epoch is how the UI knows which sessions are stale; restarting one is the
 * fix, and it is the user's to make — never automatic, because the session
 * being restarted may be mid-turn.
 */
let epoch = 0;

/**
 * One mutation at a time, per machine.
 *
 * Two concurrent `pi install` runs share `~/.pi/agent/npm/package-lock.json`
 * and one `npm install` tree; letting them overlap is how a lockfile ends up
 * describing neither install. A second request waits its turn — it does not
 * fail, because from the browser two clicks a second apart are not a race the
 * user should have to think about.
 */
let queue: Promise<unknown> = Promise.resolve();
let running = false;

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(async () => {
    running = true;
    try {
      return await fn();
    } finally {
      running = false;
    }
  });
  // The chain must not break on a rejection, or every later mutation is
  // rejected with the first one's error.
  queue = next.catch(() => {});
  return next;
}

// ---------------------------------------------------------------------------
// Source parsing
// ---------------------------------------------------------------------------

/**
 * Split a trailing `@ref` off a source.
 *
 * The `@` that matters is the LAST one that comes after the last `/`:
 * `npm:@scope/pkg@1.2.3` pins 1.2.3, `npm:@scope/pkg` pins nothing, and
 * `git:git@github.com:user/repo` pins nothing either — its `@` belongs to the
 * ssh user.
 */
function splitRef(spec: string): { base: string; ref: string | null } {
  const at = spec.lastIndexOf("@");
  if (at <= 0 || at < spec.lastIndexOf("/")) return { base: spec, ref: null };
  return { base: spec.slice(0, at), ref: spec.slice(at + 1) || null };
}

/** `github.com/user/repo`, `git@github.com:user/repo`, `https://host/user/repo` → host + path. */
function gitLocation(base: string): { host: string; path: string } | null {
  let rest = base;
  for (const scheme of ["https://", "http://", "ssh://", "git://"]) {
    if (rest.startsWith(scheme)) {
      rest = rest.slice(scheme.length);
      break;
    }
  }
  // ssh userinfo is not part of the identity: the same repo cloned as `git@`
  // and as `https://` is one package.
  const userinfo = rest.indexOf("@");
  const firstSlash = rest.indexOf("/");
  if (userinfo > 0 && (firstSlash === -1 || userinfo < firstSlash))
    rest = rest.slice(userinfo + 1);
  // `host:user/repo` is the scp-like form; `host:2222/user/repo` is a port.
  const colon = rest.indexOf(":");
  if (colon > 0 && !/^\d+\//.test(rest.slice(colon + 1))) {
    rest = `${rest.slice(0, colon)}/${rest.slice(colon + 1)}`;
  }
  const parts = rest
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);
  if (parts.length < 2) return null;
  return { host: parts[0], path: parts.slice(1).join("/") };
}

const NPM_NAME = /^(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/;
const GIT_REF = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;
/** npm accepts ranges and dist-tags, so this rejects shape, not semantics. */
const NPM_VERSION = /^[A-Za-z0-9.^~><=|*+ -]+$/;

/**
 * Parse a source the way pi does, or say why it cannot be used here.
 *
 * Local paths parse (a hand-edited settings entry has to be listable) but are
 * refused at the API boundary by `validate`: a path is meaningful on exactly
 * one machine, and accepting one from a browser would be a path-traversal
 * surface for no benefit.
 */
export function parseSource(source: string): PiwPackage | null {
  const spec = source.trim();
  if (!spec) return null;

  if (spec.startsWith("npm:")) {
    const { base, ref } = splitRef(spec.slice(4));
    if (!base) return null;
    return {
      source: spec,
      kind: "npm",
      identity: base,
      pinned: ref,
      installed: null,
      filtered: false,
      autoload: true,
      disabled: false,
    };
  }

  const isGit =
    spec.startsWith("git:") ||
    spec.startsWith("https://") ||
    spec.startsWith("http://") ||
    spec.startsWith("ssh://") ||
    spec.startsWith("git://");
  if (isGit) {
    const { base, ref } = splitRef(
      spec.startsWith("git:") ? spec.slice(4) : spec,
    );
    const at = gitLocation(base);
    if (!at) return null;
    return {
      source: spec,
      kind: "git",
      // pi's identity for a git package is the repo without its ref, and
      // normalising the transport away means `https://` and `git@` forms of
      // one repo do not read as two packages.
      identity: `${at.host}/${at.path}`,
      pinned: ref,
      installed: null,
      filtered: false,
      autoload: true,
      disabled: false,
    };
  }

  if (spec.startsWith("/") || spec.startsWith("./") || spec.startsWith("../")) {
    return {
      source: spec,
      kind: "local",
      identity: spec,
      pinned: null,
      installed: null,
      filtered: false,
      autoload: true,
      disabled: false,
    };
  }

  return null;
}

/**
 * Accept a source from the API, or explain the refusal.
 *
 * Returns the parsed package. Throws for anything this server will not spawn
 * a process for: an unrecognised shape, a malformed npm name, a ref with
 * characters git would not accept, or a local path.
 */
export function validate(source: string): PiwPackage {
  const parsed = parseSource(source);
  if (!parsed) {
    throw new Error(
      `not a package source: ${source} — use npm:<name>[@version], git:<host>/<path>[@ref], or an https/ssh URL`,
    );
  }
  if (parsed.kind === "local") {
    throw new Error(
      "local paths can only be added by editing pi's settings.json by hand",
    );
  }
  if (parsed.kind === "npm" && !NPM_NAME.test(parsed.identity)) {
    throw new Error(`not an npm package name: ${parsed.identity}`);
  }
  if (
    parsed.kind === "npm" &&
    parsed.pinned &&
    !NPM_VERSION.test(parsed.pinned)
  ) {
    throw new Error(`not an npm version: ${parsed.pinned}`);
  }
  if (parsed.kind === "git" && parsed.pinned && !GIT_REF.test(parsed.pinned)) {
    throw new Error(`not a git ref: ${parsed.pinned}`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/** The version npm actually put on disk, or null if the package is not there. */
function npmVersion(name: string): string | null {
  try {
    const raw: unknown = JSON.parse(
      readFileSync(
        join(agentDir(), "npm", "node_modules", name, "package.json"),
        "utf8",
      ),
    );
    return isRecord(raw) && typeof raw.version === "string"
      ? raw.version
      : null;
  } catch {
    return null;
  }
}

/** The commit a git package's clone is actually at, short form. */
async function gitHead(identity: string): Promise<string | null> {
  const clone = join(agentDir(), "git", ...identity.split("/"));
  try {
    const { stdout } = await run(
      "git",
      ["-C", clone, "rev-parse", "--short", "HEAD"],
      10_000,
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * The installed packages, as pi's settings describe them plus what is on disk.
 *
 * Tolerant by construction: the array may be absent, entries may be plain
 * strings or objects, and an entry may be something no version of this code
 * understands. An unparseable entry is skipped rather than thrown on — this
 * list is also the only way to SEE that a settings file has gone wrong.
 */
export async function list(): Promise<PiwPackage[]> {
  const raw = readSettings().packages;
  if (!Array.isArray(raw)) return [];

  const out: PiwPackage[] = [];
  for (const entry of raw) {
    const source =
      typeof entry === "string"
        ? entry
        : isRecord(entry)
          ? entry.source
          : undefined;
    if (typeof source !== "string") continue;
    const parsed = parseSource(source);
    if (!parsed) continue;

    if (isRecord(entry)) {
      parsed.filtered = ["extensions", "skills", "prompts", "themes"].some(
        (k) => k in entry,
      );
      parsed.autoload = entry.autoload !== false;
      parsed.disabled = isRecord(entry.pwiDisabled);
    }
    parsed.installed =
      parsed.kind === "npm"
        ? npmVersion(parsed.identity)
        : parsed.kind === "git"
          ? await gitHead(parsed.identity)
          : null;
    out.push(parsed);
  }
  return out;
}

/**
 * A project's own packages, from its `.pi/settings.json`.
 *
 * Read-only and never checked against disk: these are installed into the
 * project's `.pi/npm`, by pi, at startup, and the file usually lives in
 * someone's repository. Showing them keeps "why does this project have an
 * extra command" answerable without leaving the browser; writing them is
 * git's job, not ours.
 */
export function listProject(cwd: string): PiwPackage[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(cwd, ".pi", "settings.json"), "utf8"));
  } catch {
    // No project settings is the normal case, not an error.
    return [];
  }
  if (!isRecord(raw) || !Array.isArray(raw.packages)) return [];

  const out: PiwPackage[] = [];
  for (const entry of raw.packages) {
    const source =
      typeof entry === "string"
        ? entry
        : isRecord(entry)
          ? entry.source
          : undefined;
    if (typeof source !== "string") continue;
    const parsed = parseSource(source);
    if (!parsed) continue;
    if (isRecord(entry)) {
      parsed.filtered = ["extensions", "skills", "prompts", "themes"].some(
        (k) => k in entry,
      );
      parsed.autoload = entry.autoload !== false;
      parsed.disabled = isRecord(entry.pwiDisabled);
    }
    out.push(parsed);
  }
  return out;
}

export async function view(): Promise<PackagesView> {
  return { packages: await list(), epoch, busy: running };
}

/** The epoch a session's child was started under. Compared to spot stale sessions. */
export function currentEpoch(): number {
  return epoch;
}

/** Re-read after updates: global package managers can replace the pi shim. */
export async function piVersion(): Promise<string | null> {
  try {
    const { stdout } = await run(PI_BIN, ["--version"], 10_000);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Registry outages must not prevent listing or updating installed packages. */
export async function piLatestVersion(): Promise<string | null> {
  try {
    return await latestVersion(
      pnpmGlobalPi()?.name ??
        pnpmLocalPi()?.name ??
        "@earendil-works/pi-coding-agent",
    );
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export interface MutationResult {
  ok: boolean;
  /** The tail of pi's combined output: what npm or git said, verbatim. */
  log: string;
  /** One line, for a UI that has room for one line. Absent on success. */
  reason?: string;
}

function run(
  bin: string,
  args: string[],
  timeout: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ stdout: string; stderr: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{
    stdout: string;
    stderr: string;
  }>();
  execFile(
    bin,
    args,
    {
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...env, ...GIT_ENV },
    },
    (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout, stderr });
    },
  );
  return promise;
}

/** Combined output, newest end kept: npm's verdict is its last few lines. */
function tail(stdout: unknown, stderr: unknown): string {
  return `${String(stdout ?? "")}${String(stderr ?? "")}`
    .slice(-LOG_KEEP)
    .trim();
}

async function mutate(
  args: string[],
  bin = PI_BIN,
  env = process.env,
  expectedVersion?: string,
): Promise<MutationResult> {
  return serialize(async () => {
    try {
      const { stdout, stderr } = await run(bin, args, TIMEOUT_MS, env);
      epoch++;
      if (expectedVersion) {
        const installed = await piVersion();
        if (installed !== expectedVersion) {
          return {
            ok: false,
            log: tail(stdout, stderr),
            reason: `Requested pi ${expectedVersion}, but the configured executable reports ${installed ?? "an unknown version"}. The update was not applied to this executable. Check the package manager output and its release-age policy.`,
          };
        }
      }
      return { ok: true, log: tail(stdout, stderr) };
    } catch (err) {
      const e = err as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        killed?: boolean;
      };
      const log = tail(e.stdout, e.stderr);
      const reason =
        e.code === "ENOENT"
          ? `cannot run "${bin}": not found on PATH.${bin === PI_BIN ? " Set PWI_PI_BIN to its absolute path." : ""}`
          : e.killed
            ? `timed out after ${Math.round(TIMEOUT_MS / 1000)}s`
            : // The last non-empty line is the complaint; the rest is npm.
              (log.split("\n").filter(Boolean).at(-1) ?? e.message);
      return { ok: false, log, reason };
    }
  });
}

export async function install(source: string): Promise<MutationResult> {
  return mutate(["install", validate(source).source]);
}

export async function remove(source: string): Promise<MutationResult> {
  return mutate(["remove", validate(source).source]);
}

/** Keep the declaration (and installation), but load none of its resources.
 * The backup lives in the same entry, not a second package inventory. Pi ignores
 * this pwi-only field. Project declarations can still override personal ones.
 */
export async function setEnabled(
  source: string,
  enabled: boolean,
): Promise<MutationResult> {
  const target = parseSource(source);
  if (!target) throw new Error("not a package source");
  return serialize(async () => {
    const settings = readSettings();
    const entries = settings.packages;
    if (!Array.isArray(entries)) throw new Error("package is not configured");
    let found = false;
    let changed = false;
    settings.packages = entries.map((entry: unknown) => {
      const spec =
        typeof entry === "string"
          ? entry
          : isRecord(entry)
            ? entry.source
            : undefined;
      if (typeof spec !== "string" || spec.trim() !== target.source)
        return entry;
      found = true;
      const backup =
        isRecord(entry) && isRecord(entry.pwiDisabled)
          ? entry.pwiDisabled
          : null;
      if (enabled) {
        if (!backup) return entry;
        const original = backup.original;
        if (typeof original !== "string" && !isRecord(original))
          throw new Error(
            "cannot restore package: invalid disabled declaration",
          );
        changed = true;
        return typeof original === "string"
          ? spec
          : { ...original, source: spec };
      }
      if (backup) return entry;
      changed = true;
      return {
        ...(isRecord(entry) ? entry : { source: spec }),
        extensions: [],
        skills: [],
        prompts: [],
        themes: [],
        pwiDisabled: { original: entry },
      };
    });
    if (!found) throw new Error("package is not configured");
    if (changed) {
      try {
        writeSettings(settings);
      } catch (err) {
        return {
          ok: false,
          log: "",
          reason: err instanceof Error ? err.message : String(err),
        };
      }
      epoch++;
    }
    return {
      ok: true,
      log: `${target.source}: ${enabled ? "enabled" : "disabled"}. Restart existing sessions to apply. Project package declarations may override this personal setting.`,
    };
  });
}

/**
 * Update one package, or every unpinned one.
 *
 * `pi update --extensions` deliberately skips a pinned npm version or git
 * ref, so a pinned package is untouched here — moving a pin is an install,
 * not an update.
 */
export async function update(source?: string): Promise<MutationResult> {
  return mutate(
    source ? ["update", validate(source).source] : ["update", "--extensions"],
  );
}

/** Resolve only the executable we actually spawn, including pnpm's cmd-shim. */
function configuredPi(): { executable: string; entry: string } | null {
  const candidates = PI_BIN.includes("/")
    ? [resolve(PI_BIN)]
    : (process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, PI_BIN));
  for (const candidate of candidates) {
    let executable: string;
    try {
      accessSync(candidate, constants.X_OK);
      executable = realpathSync(candidate);
    } catch {
      continue;
    }
    try {
      const shim =
        statSync(executable).size <= 65_536
          ? readFileSync(executable, "utf8")
          : "";
      const target = shim.match(/^# cmd-shim-target=(.+)\r?$/m)?.[1].trim();
      return {
        executable,
        entry: target && isAbsolute(target) ? realpathSync(target) : executable,
      };
    } catch {
      return null;
    }
  }
  return null;
}

/** A local dependency must belong to the configured CLI, not the open workspace. */
function pnpmLocalPi(): { root: string; name: string; dev: boolean } | null {
  const pi = configuredPi();
  if (!pi) return null;
  let root = dirname(pi.entry);
  while (root !== dirname(root)) {
    try {
      const pkg: unknown = JSON.parse(
        readFileSync(join(root, "package.json"), "utf8"),
      );
      accessSync(join(root, "pnpm-lock.yaml"));
      if (isRecord(pkg) && pi.entry.startsWith(`${root}/node_modules/`)) {
        for (const section of ["dependencies", "devDependencies"] as const) {
          const deps = pkg[section];
          if (!isRecord(deps)) continue;
          for (const name of [
            "@earendil-works/pi-coding-agent",
            "@mariozechner/pi-coding-agent",
          ]) {
            if (
              typeof deps[name] !== "string" ||
              /^(?:workspace:|link:|file:|git|https?:)/.test(deps[name])
            )
              continue;
            const installed = realpathSync(join(root, "node_modules", name));
            if (pi.entry.startsWith(`${installed}/`))
              return { root, name, dev: section === "devDependencies" };
          }
        }
      }
    } catch {
      // Keep walking: pnpm's real entry lives below its virtual store.
    }
    root = dirname(root);
  }
  return null;
}

/**
 * pnpm's v11 global installs live in isolated, hashed projects. Pi cannot
 * self-update those, and updating the project directly would leave its global
 * shim pointing at the old installation. Use the owning global manager instead.
 * Inspect only the configured executable; never replace an unrelated pi on PATH.
 */
function pnpmGlobalPi(): {
  bin: string;
  globalDir: string;
  binDir: string;
  name: string;
} | null {
  const pi = configuredPi();
  if (!pi) return null;
  const { executable, entry } = pi;
  try {
    const globalDir = entry.match(
      /^(.*\/node_modules)\/v11\/[^/]+\/node_modules\//,
    )?.[1];
    if (!globalDir) return null;
    let root = dirname(entry);
    while (root !== dirname(root)) {
      try {
        const pkg: unknown = JSON.parse(
          readFileSync(join(root, "package.json"), "utf8"),
        );
        if (
          isRecord(pkg) &&
          (pkg.name === "@earendil-works/pi-coding-agent" ||
            pkg.name === "@mariozechner/pi-coding-agent")
        ) {
          const binDir = dirname(executable);
          const bin = join(binDir, "pnpm");
          accessSync(bin, constants.X_OK);
          return { bin, globalDir, binDir, name: pkg.name };
        }
      } catch {
        // The CLI may be nested several directories below package.json.
      }
      root = dirname(root);
    }
  } catch {
    // Unknown wrappers remain the CLI's responsibility.
  }
  return null;
}

/** Update the pi CLI itself on this machine. Never automatic. */
export async function updateSelf(): Promise<MutationResult> {
  const pnpm = pnpmGlobalPi();
  const local = pnpm ? null : pnpmLocalPi();
  if (pnpm || local) {
    const name = pnpm?.name ?? local!.name;
    let target: string;
    try {
      // Use a concrete release and respect the manager's release-age policy.
      target = await latestVersion(name, true);
    } catch (err) {
      return {
        ok: false,
        log: "",
        reason: `Cannot check the latest pi version: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const result = pnpm
      ? await mutate(
          ["add", "--global", `${name}@${target}`],
          pnpm.bin,
          {
            ...process.env,
            PNPM_CONFIG_GLOBAL_DIR: pnpm.globalDir,
            PNPM_CONFIG_GLOBAL_BIN_DIR: pnpm.binDir,
            PATH: `${pnpm.binDir}${delimiter}${process.env.PATH ?? ""}`,
          },
          target,
        )
      : await mutate(
          [
            "--dir",
            local!.root,
            "add",
            "--save-exact",
            ...(local!.dev ? ["--save-dev"] : []),
            `${name}@${target}`,
          ],
          "pnpm",
          process.env,
          target,
        );
    if (result.ok)
      result.log += `\nPi ${target} is installed.${local ? " The owning project's package.json and pnpm-lock.yaml were updated. Restart the web IDE server and existing sessions to use this version." : " Restart existing sessions to use this version."}`;
    return result;
  }
  return mutate(["update", "--self"]);
}
