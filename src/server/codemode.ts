import { readSettings, writeSettings } from "./models.js";
import { isRecord } from "./guards.js";

export type CodemodeMode = "off" | "on" | "only";

/** Pi's native tool, not the Codex conversion extension's Code/Notebook mode. */
export function nativeCodemode(): { mode: CodemodeMode } {
  const settings = readSettings();
  let enabled = false;
  if (Array.isArray(settings.defaultTools)) {
    enabled = settings.defaultTools.includes("codemode");
    for (const tool of settings.defaultTools) {
      if (tool === "+codemode") enabled = true;
      if (tool === "-codemode") enabled = false;
    }
  }
  return {
    mode: !enabled
      ? "off"
      : isRecord(settings.codemode) && settings.codemode.mode === "only"
        ? "only"
        : "on",
  };
}

export function setNativeCodemode(mode: CodemodeMode): void {
  const settings = readSettings();
  const tools = Array.isArray(settings.defaultTools)
    ? settings.defaultTools.filter(
        (tool) =>
          tool !== "codemode" && tool !== "+codemode" && tool !== "-codemode",
      )
    : [];
  // A modifier-only selection retains Pi's default tools (an empty list does not).
  settings.defaultTools = [
    ...tools,
    mode === "off" ? "-codemode" : "+codemode",
  ];
  settings.codemode = {
    ...(isRecord(settings.codemode) ? settings.codemode : {}),
    mode: mode === "only" ? "only" : "on",
  };
  writeSettings(settings);
}
