/**
 * solPi.ts — SoL-Pi's settings file, `<pi agent dir>/sol-pi.json`, for the
 * Packages page.
 *
 * SoL-Pi refuses to load on an unknown key or a wrong type, so every write is
 * validated here and only its own keys are written. The file is read at pi
 * startup: a change applies to sessions started afterwards.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { SolPiConfig, SolPiSettings } from "../shared/types.js";
import { agentDir } from "./packages.js";
import { DEFAULT_AUTOMATIC_MODEL } from "../shared/automaticModels.js";

const FLAGS = [
  "actionFusion",
  "observationPack",
  "evidencePreservingReducer",
  "onlineContextCompact",
] as const;
const ROUTE = [
  "evidencePreservingReducerProvider",
  "evidencePreservingReducerModel",
] as const;

function path(): string {
  return join(agentDir(), "sol-pi.json");
}

/** The file's contents; throws on malformed JSON so a write never replaces a file it could not read. */
function readRaw(): Record<string, unknown> | null {
  let text: string;
  try {
    text = readFileSync(path(), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${path()} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path()} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

export function ensureSolPiReducer(): void {
  const raw = readRaw();
  if (
    raw?.evidencePreservingReducer === true &&
    !raw.evidencePreservingReducerProvider &&
    !raw.evidencePreservingReducerModel
  ) {
    writeSolPi({}, process.cwd());
  }
}

export function readSolPi(cwd: string): SolPiSettings {
  const raw = readRaw();
  const config: SolPiConfig = {
    actionFusion: raw?.actionFusion === true,
    observationPack: raw?.observationPack === true,
    evidencePreservingReducer: raw?.evidencePreservingReducer === true,
    onlineContextCompact: raw?.onlineContextCompact === true,
  };
  if (typeof raw?.cacheWriteReadRatio === "number")
    config.cacheWriteReadRatio = raw.cacheWriteReadRatio;
  for (const key of ROUTE)
    if (typeof raw?.[key] === "string") config[key] = raw[key] as string;
  const project = join(cwd, ".pi", "sol-pi.json");
  return {
    path: path(),
    exists: raw !== null,
    config,
    projectFile: existsSync(project) ? project : null,
  };
}

/**
 * Merge a change into the file. A flag takes a boolean; the ratio a finite
 * non-negative number or null; the reducer route a string, where "" or null
 * removes the key so SoL-Pi falls back to its built-in route.
 */
export function writeSolPi(
  change: Record<string, unknown>,
  cwd: string,
): SolPiSettings {
  const next: Record<string, unknown> = { ...(readRaw() ?? {}), version: 1 };
  for (const [key, value] of Object.entries(change)) {
    if ((FLAGS as readonly string[]).includes(key)) {
      if (typeof value !== "boolean")
        throw new Error(`${key} must be a boolean`);
      next[key] = value;
    } else if (key === "cacheWriteReadRatio") {
      if (value === null) delete next[key];
      else if (
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 0
      )
        next[key] = value;
      else throw new Error(`${key} must be a non-negative number`);
    } else if ((ROUTE as readonly string[]).includes(key)) {
      if (value === null || value === "") delete next[key];
      else if (typeof value === "string" && value.trim())
        next[key] = value.trim();
      else throw new Error(`${key} must be a string`);
    } else {
      throw new Error(`unknown setting: ${key}`);
    }
  }
  if (
    next.evidencePreservingReducer === true &&
    !next.evidencePreservingReducerProvider &&
    !next.evidencePreservingReducerModel
  ) {
    const slash = DEFAULT_AUTOMATIC_MODEL.indexOf("/");
    next.evidencePreservingReducerProvider = DEFAULT_AUTOMATIC_MODEL.slice(
      0,
      slash,
    );
    next.evidencePreservingReducerModel = DEFAULT_AUTOMATIC_MODEL.slice(
      slash + 1,
    );
  }
  const file = path();
  mkdirSync(dirname(file), { recursive: true });
  // Temp file and rename: pi reads this at every startup, so it is never left half-written.
  writeFileSync(`${file}.tmp`, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
  return readSolPi(cwd);
}
