import type { Token } from "./codeHighlight.js";

export interface ChangedRange {
  from: number;
  to: number;
}
export interface InlineChanges {
  removed: ChangedRange[][];
  added: ChangedRange[][];
}
export type DiffToken = Token & { changed: boolean };

/** Convert document offsets to per-line spans; newline characters aren't painted as whole rows. */
function lineRanges(text: string, ranges: ChangedRange[]): ChangedRange[][] {
  let offset = 0;
  let index = 0;
  return text.split("\n").map((line) => {
    const end = offset + line.length;
    while (index < ranges.length && ranges[index].to <= offset) index++;
    const spans: ChangedRange[] = [];
    for (let i = index; i < ranges.length && ranges[i].from < end; i++) {
      const from = Math.max(offset, ranges[i].from);
      const to = Math.min(end, ranges[i].to);
      if (from < to) spans.push({ from: from - offset, to: to - offset });
    }
    offset = end + 1;
    return spans;
  });
}

/** Reuse the editor’s bounded, word-aligned diff without painting whole rows. */
export async function inlineChanges(
  before: string,
  after: string,
): Promise<InlineChanges> {
  const { presentableDiff } = await import("@codemirror/merge");
  const changes = presentableDiff(before, after, {
    scanLimit: 10_000,
    timeout: 50,
  });
  return {
    removed: lineRanges(
      before,
      changes.flatMap((c) =>
        c.fromA < c.toA ? [{ from: c.fromA, to: c.toA }] : [],
      ),
    ),
    added: lineRanges(
      after,
      changes.flatMap((c) =>
        c.fromB < c.toB ? [{ from: c.fromB, to: c.toB }] : [],
      ),
    ),
  };
}

/** Split syntax tokens at edit boundaries so both syntax color and character highlighting survive. */
export function changedTokens(
  tokens: Token[],
  ranges: ChangedRange[],
): DiffToken[] {
  const result: DiffToken[] = [];
  let offset = 0;
  let index = 0;
  for (const token of tokens) {
    const end = offset + token.text.length;
    let at = offset;
    while (at < end) {
      while (index < ranges.length && ranges[index].to <= at) index++;
      const range = ranges[index];
      const changed = range !== undefined && range.from <= at && at < range.to;
      const to = Math.min(end, changed ? range.to : (range?.from ?? end));
      result.push({
        text: token.text.slice(at - offset, to - offset),
        cls: token.cls,
        changed,
      });
      at = to;
    }
    offset = end;
  }
  return result;
}

/** Keep one highlight around adjacent syntax tokens, so only the run’s outer corners are rounded. */
export function changedTokenGroups(
  tokens: Token[],
  ranges: ChangedRange[],
): { changed: boolean; tokens: DiffToken[] }[] {
  const groups: { changed: boolean; tokens: DiffToken[] }[] = [];
  for (const token of changedTokens(tokens, ranges)) {
    const previous = groups.at(-1);
    if (previous?.changed === token.changed) previous.tokens.push(token);
    else groups.push({ changed: token.changed, tokens: [token] });
  }
  return groups;
}
