/** Display-only dedenting. Blank lines don't constrain the shared whitespace prefix. */
export function dedentBlocks(blocks: string[][]): string[][] {
  let prefix: string | undefined;
  for (const block of blocks) {
    for (const line of block) {
      if (!line.trim()) continue;
      const indent = /^[ \t]*/.exec(line)?.[0] ?? "";
      if (prefix === undefined) prefix = indent;
      else {
        let shared = 0;
        while (shared < prefix.length && prefix[shared] === indent[shared])
          shared++;
        prefix = prefix.slice(0, shared);
      }
    }
  }
  if (!prefix) return blocks;
  return blocks.map((block) =>
    block.map((line) => (!line.trim() ? "" : line.slice(prefix.length))),
  );
}
