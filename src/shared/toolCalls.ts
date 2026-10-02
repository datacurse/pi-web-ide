/**
 * toolCalls.ts — what a tool call did, finer than its tool's name: bash by
 * the program it ran, the file tools by path. The context panel and Stats
 * both group by it. context-extension.ts imports it inside pi, so it imports
 * nothing itself.
 */

/** Steps around the real command: `cd x && grep …` is grep, and so is `for f in …; do grep …`. */
const SETUP = new Set([
  "cd",
  "pushd",
  "popd",
  "export",
  "set",
  "source",
  ".",
  "echo",
  "printf",
  "true",
  "for",
  "while",
  "until",
  "if",
  "[",
  "[[",
  "test",
  "done",
  "fi",
]);
/** Prefixes that run the next word: `sudo`, `do grep …`. */
const WRAPPERS = new Set([
  "sudo",
  "env",
  "nohup",
  "time",
  "exec",
  "command",
  "do",
  "then",
  "else",
]);
/** Programs whose first argument is what they do: `git status`, `pnpm typecheck`. */
const SUBCOMMANDS = new Set([
  "git",
  "pnpm",
  "npm",
  "npx",
  "pnpx",
  "yarn",
  "bun",
  "docker",
  "cargo",
  "go",
  "gh",
  "systemctl",
  "tailscale",
  "kubectl",
  "uv",
  "pip",
]);
/** Their flags that take a value, which is not the subcommand: `git -C dir log`. */
const VALUE_FLAGS = new Set([
  "-C",
  "-c",
  "--dir",
  "--filter",
  "-F",
  "--prefix",
]);
/** A subcommand that names another program: `pnpm exec tsc`. */
const RUNNERS = new Set(["exec", "dlx", "run"]);
const FILE_TOOLS = new Set(["read", "edit", "write"]);

/** `cd ~/x && FOO=1 timeout 30 git -C y log --oneline | head` → `git log`. */
export function program(command: string): string {
  // A `$(...)` substitution runs inside another step: blank it, innermost first.
  let text = command;
  for (let prev = ""; prev !== text;) {
    prev = text;
    text = text.replace(/\$\([^()]*\)|`[^`]*`/g, "$_");
  }
  // Each step from its program on: past `FOO=1`, `sudo`, `timeout 30`.
  const segments = text
    .split(/&&|\|\||[;|\n]/)
    .map((s) => {
      const words = s
        .trim()
        .replace(/^[({!\s]+/, "")
        .split(/\s+/)
        .filter(Boolean);
      let i = 0;
      while (
        i < words.length &&
        (/^\w+=/.test(words[i]!) || WRAPPERS.has(words[i]!))
      )
        i++;
      if (words[i] === "timeout") {
        i++;
        while (
          i < words.length &&
          (words[i]!.startsWith("-") || /^\d/.test(words[i]!))
        )
          i++;
      }
      return words.slice(i);
    })
    .filter((w) => w.length > 0);
  // Not a program either: the rest of `f=$(ls -t …)`, a lone `2>&1`.
  const words =
    segments.find((w) => !SETUP.has(w[0]!) && /^[\w.~/"']/.test(w[0]!)) ??
    segments[0];
  if (!words) return "?";
  const name =
    words[0]!
      .replace(/^["']|["']$/g, "")
      .split("/")
      .pop() || "?";
  if (!SUBCOMMANDS.has(name)) return name;
  const rest: string[] = [];
  for (let j = 1; j < words.length && rest.length < 2; j++) {
    const w = words[j]!;
    if (VALUE_FLAGS.has(w)) j++;
    else if (!w.startsWith("-")) {
      rest.push(w);
      if (!RUNNERS.has(w)) break;
    }
  }
  return [name, ...rest].join(" ");
}

/** The program for bash, the path for read/edit/write, else nothing. */
export function subKey(tool: string, args: unknown): string | undefined {
  const a = (args ?? {}) as Record<string, unknown>;
  if (tool === "bash" && typeof a.command === "string")
    return program(a.command);
  if (FILE_TOOLS.has(tool) && typeof a.path === "string") return a.path;
  return undefined;
}

/** A message's content as pi sizes it: its text, and 4800 chars an image. */
export function contentChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  let n = 0;
  for (const b of Array.isArray(content)
    ? (content as { type?: unknown; text?: unknown }[])
    : []) {
    if (b?.type === "text" && typeof b.text === "string") n += b.text.length;
    else if (b?.type === "image") n += 4800;
  }
  return n;
}

/**
 * A bash call's size shared out over its measured steps (tool-metrics), by
 * what each put in context: its own text and its output the model was shown.
 */
export function splitBySteps(
  total: number,
  steps: { text: string; shown?: number }[],
): number[] {
  const weights = steps.map((s) => s.text.length + (s.shown ?? 0));
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => (sum ? (total * w) / sum : total / steps.length));
}

/** One line saying what a call did, for lists of single calls. */
export function preview(tool: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const text =
    tool === "bash" && typeof a.command === "string"
      ? a.command
      : typeof a.path === "string"
        ? a.path
        : JSON.stringify(args ?? {});
  const line = text.replace(/\s+/g, " ").trim();
  return line.slice(0, 160);
}
