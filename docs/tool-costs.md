# Tool costs: what pi's tool calls cost in time and tokens, and what helps

Measured findings, newest first within each section, each with its date and
how much data it rests on. Add to it whenever a measurement says something
new; correct an entry rather than leave a stale one. How pi itself behaves
(event order, extension loading, bash tracing) is in `docs/pi-facts.md` and
the probe results in `docs/plans/tool-metrics.md`.

## How to measure

- **Stats page, Tool calls:** per tool and per bash command, tokens, time,
  per call, and Hooks (other extensions' share, mostly pi-lens). Slowest and
  Largest calls, Background jobs.
- **Raw data:** `~/.config/pi-web-ide/tool-metrics/<sessionId>.jsonl`, one
  line per call (`src/tool-metrics/FORMAT.md`). Exact for sessions pwi
  started with Tool metrics on; older sessions and terminal pi are estimated
  from session timestamps.
- **pi-lens:** `~/.pi-lens/latency.log`, NDJSON with `phase` and
  `durationMs`. Phases nest, so their totals overlap.
- **A command:** time its parts on their own before optimizing the whole
  (`tsc` vs the check scripts, below).

## Time

### `pnpm typecheck` is almost all `tsc` (2026-09-29, this repo)

- 9 runs, 128s, 14.2s each: the largest single time cost in a pwi session.
- `tsc --noEmit` 14.1s (3381 files, 10.9s checking); `check-ui.sh` 0.09s,
  `check-api.sh` 0.02s.
- `tsc --incremental` (build info outside `src`): 5.9s unchanged, 4.5s after
  touching one file. No risk; not yet switched on.
- `tsgo` (`@typescript/native-preview`, TypeScript's Go port): under 5s
  including `pnpm dlx` overhead. Still a preview, and it checks side-effect
  imports, so `import "./index.css"` in `src/web/main.tsx` needs a CSS module
  declaration first.

### pi-lens is most of every edit (2026-09-29, 48 edits, 7 writes)

- `edit`: 2.4s per call, 2.1s of it pi-lens (`hookMs`); the edit itself is
  milliseconds. `write`: 4.7s, 4.6s pi-lens.
- Over the history (estimated): ~1700 edits at ~2.9s, about 80 minutes.
- pi-lens's log that day: TypeScript server project lookup ~1.1s per file,
  opening the file ~0.6s, diagnostic waits that time out at ~2.5s, knip
  ~1.8s. This is the price of seeing type errors right after each edit;
  `docs/settings.md` in the pi-lens package may trade some of it away.

### Lookups are fast; shell startup is noise (2026-09-29, 79 lookups, 47 bash calls)

- `grep` 6ms, `sed` 3ms, `cat` 5ms per run. Rust rewrites (`rg`, `fd`, `bat`)
  cannot save anything worth having here.
- A traced bash call spends ~18ms outside its commands (shell start, pi).

### Combined bash calls hold most of the bash time (2026-09-29, full history, estimated)

- Calls with two or more programs: 52% of bash calls, 54% of bash tokens,
  71% of bash time, and 100 of the 141 calls over 30s. Why Stats splits a
  measured call per command.

## Tokens

### Lookup output is the token sink (2026-09-29)

- Full history (estimated, first program of each call): `sed` 1.43M, `read`
  1.20M, `cat` 0.98M, `grep` 0.91M tokens; `edit` 0.77M.
- One measured session: `sed` 40KB and `grep` 21KB of output shown to the
  model, nearly all of the bash output.
- Faster tools do not help; narrower reads do: `read_symbol` /
  `read_enclosing` for one function, smaller `sed -n` ranges, `ffgrep` with a
  limit instead of a broad `grep -rn`.

### The agent barely uses fff or pi-lens's read tools (2026-09-29)

- This session: 158 bash, 81 edit, 14 write, 9 read, 3 `ffgrep`; no
  `fffind`, `read_symbol`, `read_enclosing` or `symbol_search`.
- Full history (estimated), tokens per call: `ffgrep` ~380 and `grep` ~380
  (the same); `read_symbol` ~510 against `sed` ~835, `read` ~1020, `cat`
  ~1070. The saving is in reading one symbol instead of a range or a file,
  not in swapping grep for ffgrep.
- Why bash wins: pi-lens's read-before-edit guard credits `cat`, `sed -n`
  and `grep -n` but never `ffgrep`, so the agent reads with bash to be
  allowed to edit; several lookups fit in one bash call; and habit.

## Ideas not yet tried

- Switch on incremental `tsc` for `pnpm typecheck`.
- Try `tsgo` once the CSS declaration is in.
- Rank results by tokens × turns they stay in context, not by size: an early
  large read is paid for on every later request until compaction.
- Look at pi-lens's settings for a faster post-edit mode.
