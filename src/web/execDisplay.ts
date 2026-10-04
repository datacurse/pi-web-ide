/** Only the Code/Notebook exec tool gets payload decoding; other tools stay literal. */
export function isExecTool(name: string): boolean {
  return name.split(".").pop() === "exec";
}

export type ExecOutput = { text: string; lang?: string };

/** Decode shell envelopes without treating their contents as Markdown or HTML. */
export function execOutput(text: string, depth = 0): ExecOutput[] {
  if (depth >= 4 || !text.trim()) return [{ text }];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // A cell can emit several JSON values alongside ordinary log lines.
    const lines = text.split("\n");
    if (lines.length > 1) {
      const parts: ExecOutput[] = [];
      for (const line of lines) {
        for (const part of execOutput(line, depth + 1)) {
          const previous = parts.at(-1);
          if (previous && !previous.lang && !part.lang)
            previous.text += `\n${part.text}`;
          else parts.push(part);
        }
      }
      return parts;
    }
    return [{ text }];
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const { output, ...metadata } = value as Record<string, unknown>;
    if (typeof output === "string") {
      const parts = execOutput(output, depth + 1);
      if (Object.keys(metadata).length)
        parts.push({ text: JSON.stringify(metadata, null, 2), lang: "json" });
      return parts;
    }
  }
  return [{ text: JSON.stringify(value, null, 2), lang: "json" }];
}
