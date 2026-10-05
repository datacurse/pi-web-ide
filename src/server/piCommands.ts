import {
  getAgentDir,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** Persist through Pi's own stores, not by editing its settings/session JSON. */
export function projectTrust(cwd: string, decision?: boolean | null) {
  const store = new ProjectTrustStore(getAgentDir());
  if (decision !== undefined) store.set(cwd, decision);
  return store.get(cwd);
}

export async function scopedModels(cwd: string, patterns?: string[]) {
  const settings = SettingsManager.create(cwd, getAgentDir());
  if (patterns !== undefined) {
    if (
      patterns.length > 100 ||
      patterns.some(
        (pattern) =>
          typeof pattern !== "string" ||
          !pattern.trim() ||
          pattern.length > 200,
      )
    )
      throw new Error("Invalid model scope.");
    settings.setEnabledModels(patterns.length ? patterns : undefined);
    await settings.flush();
  }
  return settings.getEnabledModels() ?? [];
}

export function importSessionFile(path: string, cwd: string): string {
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim());
  if (!lines.length) throw new Error("The import is empty.");
  let entries: unknown[];
  try {
    entries = lines.map((line) => JSON.parse(line));
  } catch {
    throw new Error("The import contains invalid JSON.");
  }
  const header = entries[0];
  if (
    !header ||
    typeof header !== "object" ||
    !("type" in header) ||
    header.type !== "session"
  )
    throw new Error("Expected a Pi session JSONL file.");
  const manager = SessionManager.forkFrom(path, cwd);
  const file = manager.getSessionFile();
  if (!file) throw new Error("Pi could not save the imported session.");
  return file;
}

export function piChangelog(): string {
  const packageEntry = fileURLToPath(
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  );
  return readFileSync(
    join(dirname(packageEntry), "..", "CHANGELOG.md"),
    "utf8",
  );
}
