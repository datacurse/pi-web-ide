/** Only the Code/Notebook exec tool gets payload decoding; other tools stay literal. */
export function isExecTool(name: string): boolean {
  return name.split(".").pop() === "exec";
}

export type ExecOutput = {
  text: string;
  lang?: string;
  metadata?: Record<string, unknown>;
};

export function execSource(args: unknown): string | undefined {
  if (typeof args === "string") return args;
  if (!args || typeof args !== "object") return;
  const code = (args as Record<string, unknown>).code;
  return typeof code === "string" ? code : undefined;
}

type Token = { raw: string; value?: string; start: number; end: number };

/** A conservative literal reader, not an evaluator. Interpolated templates stay source. */
function tokens(source: string): Token[] {
  const result: Token[] = [];
  for (let i = 0; i < source.length;) {
    if (/\s/.test(source[i])) {
      i++;
      continue;
    }
    if (source.startsWith("//", i)) {
      const end = source.indexOf("\n", i);
      i = end < 0 ? source.length : end + 1;
      continue;
    }
    if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    const start = i;
    const quote = source[i];
    if (quote === '"' || quote === "'" || quote === "`") {
      i++;
      let value = "";
      let safe = true;
      while (i < source.length && source[i] !== quote) {
        if (quote === "`" && source.startsWith("${", i)) safe = false;
        if (source[i] !== "\\") {
          value += source[i++];
          continue;
        }
        const escaped = source[++i];
        i++;
        const escapes: Record<string, string> = {
          n: "\n",
          r: "\r",
          t: "\t",
          b: "\b",
          f: "\f",
          v: "\v",
          "\\": "\\",
          '"': '"',
          "'": "'",
          "`": "`",
          $: "$",
        };
        if (escaped === "\n") continue;
        if (escaped === "\r") {
          if (source[i] === "\n") i++;
          continue;
        }
        if (escaped === "x" || escaped === "u") {
          const size = escaped === "x" ? 2 : 4;
          const hex = source.slice(i, i + size);
          if (new RegExp(`^[0-9a-f]{${size}}$`, "i").test(hex)) {
            value += String.fromCharCode(parseInt(hex, 16));
            i += size;
          } else safe = false;
        } else if (escaped in escapes) value += escapes[escaped];
        else safe = false;
      }
      if (source[i] !== quote) safe = false;
      else i++;
      result.push({
        raw: source.slice(start, i),
        value: safe ? value : undefined,
        start,
        end: i,
      });
    } else {
      const word = source.slice(i).match(/^[\w$]+/);
      i += word ? word[0].length : 1;
      result.push({ raw: source.slice(start, i), start, end: i });
    }
  }
  return result;
}

export type ExecCall = {
  name: string;
  source: string;
  command?: string;
  cwd?: string;
  patch?: string;
};

/** Only complete, static arguments get a friendly view; original JS is always retained. */
export function execCalls(source: string): ExecCall[] {
  const ts = tokens(source);
  const calls: ExecCall[] = [];
  for (let i = 0; i < ts.length - 4; i++) {
    if (ts[i].raw !== "tools" || ts[i + 1].raw !== "." || ts[i + 3].raw !== "(")
      continue;
    let end = i + 4;
    let depth = 1;
    for (; end < ts.length; end++) {
      if (ts[end].raw === "(") depth++;
      if (ts[end].raw === ")" && --depth === 0) break;
    }
    if (end === ts.length) continue;
    const name = ts[i + 2].raw;
    const args = ts.slice(i + 4, end);
    const call: ExecCall = {
      name,
      source: source.slice(ts[i].start, ts[end].end),
    };
    if (name === "apply_patch" && args.length === 1) call.patch = args[0].value;
    if (
      name === "exec_command" &&
      args[0]?.raw === "{" &&
      args.at(-1)?.raw === "}"
    ) {
      // Only top-level properties, with no spreads or computed keys.
      const fields = new Map<string, string | undefined>();
      let start = 1;
      let level = 0;
      let safe = true;
      for (let j = 1; j < args.length; j++) {
        const raw = args[j].raw;
        if (level === 0 && (raw === "," || j === args.length - 1)) {
          const part = args.slice(start, j);
          if (part.length) {
            const key = part[0].value ?? part[0].raw;
            if (part[1]?.raw !== ":" || !/^[\w$]+$/.test(key)) safe = false;
            fields.set(key, part.length === 3 ? part[2].value : undefined);
          }
          start = j + 1;
        }
        if (["{", "[", "("].includes(raw)) level++;
        if (["}", "]", ")"].includes(raw)) level--;
      }
      if (safe) {
        call.command = fields.get("cmd");
        call.cwd = fields.get("workdir");
      }
    }
    calls.push(call);
    i = end;
  }
  return calls;
}

/** Find a complete JSON container, respecting quoted braces and escaped quotes. */
function jsonEnd(text: string, start: number): number | undefined {
  const stack: string[] = [];
  let quoted = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === "\\") i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "{" || c === "[") stack.push(c);
    else if (c === "}" || c === "]") {
      if (stack.pop() !== (c === "}" ? "{" : "[")) return;
      if (!stack.length) return i + 1;
    }
  }
}

/** Decode shell envelopes without treating their contents as Markdown or HTML. */
export function execOutput(text: string, depth = 0): ExecOutput[] {
  if (depth >= 4 || !text.trim()) return [{ text }];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // text() emissions can touch with no newline (patch log + shell envelope).
    const parts: ExecOutput[] = [];
    let plainStart = 0;
    // Malformed/unmatched braces in very large logs must not cause quadratic work.
    let candidates = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== "{" && text[i] !== "[") continue;
      if (++candidates > 64) break;
      const end = jsonEnd(text, i);
      if (!end) continue;
      const fragment = text.slice(i, end);
      try {
        JSON.parse(fragment);
      } catch {
        i = end - 1;
        continue;
      }
      if (i > plainStart) parts.push({ text: text.slice(plainStart, i) });
      parts.push(...execOutput(fragment, depth + 1));
      plainStart = end;
      i = end - 1;
    }
    if (plainStart) {
      if (plainStart < text.length)
        parts.push({ text: text.slice(plainStart) });
      return parts;
    }
    return [{ text }];
  }
  if (Array.isArray(value)) {
    // Parallel shell calls often return an array of envelopes.
    if (
      value.length &&
      value.every(
        (item) =>
          item && typeof item === "object" && typeof item.output === "string",
      )
    )
      return value.flatMap((item) =>
        execOutput(JSON.stringify(item), depth + 1),
      );
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const { output, ...metadata } = value as Record<string, unknown>;
    if (typeof output === "string") {
      const parts = execOutput(output, depth + 1);
      if (Object.keys(metadata).length) parts.push({ text: "", metadata });
      return parts;
    }
  }
  return [{ text: JSON.stringify(value, null, 2), lang: "json" }];
}
