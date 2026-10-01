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

### Incremental checking enabled; safety checks retained (2026-10-01, this repo)

- Five successful timed full `pnpm typecheck` runs: non-incremental baseline
  6.68s, incremental cold 5.59s, unchanged warm 1.68s and 1.78s, and 6.45s
  after adding/removing a source file with an intentional type error.
  Warm unchanged checks averaged 1.73s (74% less than this baseline);
  source changes can still require nearly a full check. This is a small,
  sequential sample, not a controlled benchmark or a measured task-speed gain.
- `tsconfig.json` now enables incremental checking; build info lives in the
  already-ignored `node_modules/.cache/pwi/typecheck.tsbuildinfo`, outside
  source. UI/API checks still run on every `pnpm typecheck` invocation.
- A separate expected-failure run caught TS2322 in a temporary new source
  file; removing it restored a passing check. The probe was removed.
  All 112 tests passed; an active LSP check of tsconfig reported clean.
- `AGENTS.md` now directs focused reads, same-file edit batching, one active
  changed-path diagnostic batch, and one final full typecheck after related
  edits rather than attaching a full check to every edit.
- Installed pi-lens settings already default to deferred formatting and
  delta diagnostics; no supported per-edit diagnostic batch switch was found
  in its configuration reference. No diagnostics, security scans, formatting,
  or global settings were disabled. Hook/task/token improvements from the
  new instructions are not yet measured; compare future measured sessions.

### Rank measured work, not historical command labels (2026-10-01)

- Live Stats: 450 sessions, 1919 turns, 22,312 tool/command units; 7247
  (32.5%) measured. Actual tool invocations: bash 12,383, edit 2375,
  read 1502, write 370. Measured bash steps and loop runs count separately
  in the command table, so those rows are not invocation counts.
- Historical `cat` totals 88.4 minutes and `grep` 43.7 minutes, but some
  outliers include a 30-minute test or a whole-filesystem scan in the same
  call. Unmeasured calls attribute the whole wait to their command label;
  these totals cannot tell us how much faster cat or grep could help.
- 1992 unique raw measured calls across local and mirrored metrics:
  406 edits took 51.6 minutes, including 21.2 minutes of result hooks;
  median edit 3.25s, median hook 1.97s. The three slowest local edits
  (175s, 110s, 87s) all ran `pnpm typecheck` through `then_run`, so not all
  edit time is editing or pi-lens. Batch related edits, then validate once.
- Measured steps: 102 plain `pnpm typecheck` commands took 1597s (15.7s
  each), with more validation under timeout wrappers and other tsc commands.
  Faster/incremental checking and fewer redundant runs remain strong targets.
- Local measured steps: 695 sed steps took 4.5s, 155 cat steps 2.3s,
  914 grep steps 20.7s. Faster lookup executables are a low-value target.

### `pnpm typecheck` is almost all `tsc` (2026-09-29, this repo)

- 9 runs, 128s, 14.2s each: the largest single time cost in a pwi session.
- `tsc --noEmit` 14.1s (3381 files, 10.9s checking); `check-ui.sh` 0.09s,
  `check-api.sh` 0.02s.
- `tsc --incremental` (build info outside `src`): 5.9s unchanged, 4.5s after
  touching one file. Enabled on 2026-10-01; see the newer measurements above.
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

### Lookup volume still dominates (2026-10-01, 450 sessions / 1919 turns)

- Live Stats estimates 11.20M tool argument/result tokens; sed, read, cat,
  and grep account for 6.13M (54.7%). These are characters divided by four,
  not billed input tokens or their repeated cost in subsequent model turns.
- Most-called command labels: grep 3694, sed 2679; edit 2375, read 1502,
  cat 1172, python3 1003. Narrower reads and fewer discovery round trips
  matter more than speeding up these executables.

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

- Try `tsgo` once the CSS declaration is in.
- Rank results by tokens × turns they stay in context, not by size: an early
  large read is paid for on every later request until compaction.
- Look at pi-lens's settings for a faster post-edit mode.
