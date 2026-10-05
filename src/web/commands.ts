/**
 * commands.ts — slash-command completion for the composer.
 *
 * The matching lives here, apart from the panel that renders it, because it is
 * the part with rules: what counts as "completing a command", which commands a
 * query matches, and what pressing Enter on a row puts in the box. The panel
 * itself is a list with a highlight.
 *
 * Extension commands come from the session (`Snapshot.commands`). Browser
 * equivalents for Pi's TUI-only built-ins are merged into that catalog;
 * unsupported commands are rejected rather than sent to the model.
 */

import type { PiCommand } from "../shared/types.js";

/** Terminal commands with browser/RPC equivalents; extensions remain session-owned. */
export const WEB_COMMANDS: PiCommand[] = [
  {
    name: "reload",
    description:
      "Reload Pi extensions and configuration; keep this conversation",
    source: "pwi",
  },
  {
    name: "compact",
    description: "Summarise older messages (optional: focus instructions)",
    source: "pwi",
  },
  {
    name: "model",
    description: "Show current model or set provider/model",
    source: "pwi",
  },
  {
    name: "thinking",
    description: "Show or set reasoning level",
    source: "pwi",
  },
  {
    name: "name",
    description: "Rename this session: /name new title",
    source: "pwi",
  },
  {
    name: "session",
    description: "Show session details and context usage",
    source: "pwi",
  },
  {
    name: "copy",
    description: "Copy the last assistant response",
    source: "pwi",
  },
  { name: "settings", description: "Open web settings", source: "pwi" },
  {
    name: "login",
    description: "Open provider authentication settings",
    source: "pwi",
  },
  {
    name: "new",
    description: "Open a new conversation in this column",
    source: "pwi",
  },
  {
    name: "resume",
    description: "Open the saved-session picker",
    source: "pwi",
  },
  {
    name: "help",
    description: "List available web and extension commands",
    source: "pwi",
  },
  {
    name: "tree",
    description: "Navigate conversation branches (optional: entry ID)",
    source: "pwi",
  },
  {
    name: "export",
    description:
      "Download HTML or JSONL: /export [filename.html|filename.jsonl]",
    source: "pwi",
  },
  {
    name: "share",
    description: "Share as an unlisted GitHub gist after confirmation",
    source: "pwi",
  },
  {
    name: "clone",
    description: "Duplicate this conversation into a new session",
    source: "pwi",
  },
  { name: "fork", description: "Fork from an earlier response", source: "pwi" },
  {
    name: "import",
    description: "Import a Pi JSONL file from the project",
    source: "pwi",
  },
  {
    name: "changelog",
    description: "Download the installed Pi changelog",
    source: "pwi",
  },
  {
    name: "hotkeys",
    description: "Open web keyboard-shortcut settings",
    source: "pwi",
  },
  {
    name: "bug",
    description: "Open a Pi bug-report form (optional: description)",
    source: "pwi",
  },
  {
    name: "scoped-models",
    description: "Configure model-cycling patterns",
    source: "pwi",
  },
  {
    name: "trust",
    description: "Show/save project trust: /trust [on|off|reset]",
    source: "pwi",
  },
  {
    name: "logout",
    description: "Manage authentication, or /logout provider",
    source: "pwi",
  },
  {
    name: "quit",
    description: "Close this chat tab; other sessions keep running",
    source: "pwi",
  },
];

export function commandCatalog(commands: PiCommand[]): PiCommand[] {
  return [
    ...WEB_COMMANDS,
    ...commands.filter(
      (command) => !WEB_COMMANDS.some((web) => web.name === command.name),
    ),
  ];
}

export function parseSlashCommand(
  text: string,
): { name: string; args: string } | null {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? { name: match[1], args: match[2]?.trim() ?? "" } : null;
}

/** What the composer is currently completing: the command word itself. */
export interface Completion {
  /** The text after the slash: "" for a bare `/`, "co" for `/co`. */
  query: string;
}

/**
 * One row of the picker. `insert` replaces the whole composer text; `label`
 * is the row as it reads, which is why it carries its own leading slash.
 */
export interface CommandOption {
  insert: string;
  label: string;
  description?: string;
  /** `extension`, `prompt` or `skill`, shown as a dim tag on the right. */
  source?: string;
}

/**
 * Read the composer text as a completion in progress, or nothing.
 *
 * Deliberately strict: the picker opens only while the WHOLE composer is one
 * unfinished command word. A slash mid-sentence is prose ("and/or"), a slash
 * on the second line belongs to whatever the first line is saying, and text
 * after the name is the argument the user is writing, not a name the picker
 * can help with.
 */
export function parseCompletion(text: string): Completion | null {
  if (text.includes("\n")) return null;
  const m = /^\/(\S*)$/.exec(text);
  return m ? { query: m[1] ?? "" } : null;
}

/** Case-insensitive, prefix-first ranking. `-1` means "no match". */
function rank(candidate: string, query: string): number {
  if (!query) return 0;
  const at = candidate.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return -1;
  return at === 0 ? 0 : 1;
}

/**
 * The rows to show for a completion, best match first.
 *
 * Every row inserts a TRAILING SPACE, because every pi command that takes
 * arguments takes them as free text after the name: `/skill:review the auth
 * change`. One keypress leaves the caret where the argument goes.
 */
export function completionOptions(
  commands: PiCommand[],
  completion: Completion,
): CommandOption[] {
  return commands
    .map((c) => ({ c, r: rank(c.name, completion.query) }))
    .filter(({ r }) => r >= 0)
    .sort((a, b) => a.r - b.r || a.c.name.localeCompare(b.c.name))
    .map(({ c }) => ({
      insert: `/${c.name} `,
      label: `/${c.name}`,
      ...(c.description ? { description: c.description } : {}),
      ...(c.source ? { source: c.source } : {}),
    }));
}
