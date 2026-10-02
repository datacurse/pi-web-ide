import { readFileSync } from "node:fs";
import {
  DEFAULT_AUTOMATIC_MODEL,
  type AutomaticAction,
} from "../shared/automaticModels.ts";
import { statePath } from "./state.ts";

export function readAutomaticModels(): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(statePath("automatic-models.json"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("automatic-models.json is not a valid JSON object");
  }
}

export function autoCompactionEnabled(): boolean {
  return readAutomaticModels().autoCompaction === true;
}

export function automaticModel(
  action: Exclude<AutomaticAction, "reducer">,
): string {
  const saved = readAutomaticModels()[action];
  if (typeof saved === "string" && saved) return saved;
  if (action !== "compaction" && process.env.PWI_NAMING_MODEL)
    return process.env.PWI_NAMING_MODEL;
  return DEFAULT_AUTOMATIC_MODEL;
}
