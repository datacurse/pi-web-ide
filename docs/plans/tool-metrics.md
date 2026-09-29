# Tool metrics: exact per-call and per-step timing and output

Goal: Stats and the context panel show, for every tool call, how long it
really took, and for bash, how long each step of a combined command took and
how much output each step produced. Today both are estimates from session
timestamps (a parallel batch's wait is split evenly) and one label per call.

Only sessions pwi starts are measured; older sessions and terminal pi keep
the estimates, marked as such.

## Where the data lives

- One append-only JSONL per session: `<state dir>/tool-metrics/<sessionId>.jsonl`
  (`~/.config/pi-web-ide/tool-metrics/`). pwi passes the path to pi in
  `PWI_TOOL_METRICS_DIR`; the collector writes only where it is told.
- One writer per file (one pi per session), so lines never interleave.
- Joined to the session file by `toolCallId`, not session id: forks copy
  entries under a new session id but keep call ids.
- Bytes, not tokens: pwi converts when it reads.
- Format in `src/tool-metrics/FORMAT.md`, versioned with `"v"`.
- `machines.ts` mirrors the directory alongside the session store.

## Code layout

`src/tool-metrics/`, importing nothing from pwi's server or web code:

- `collector.ts` — the pi extension.
- `trace.bash` — loaded by bash through `BASH_ENV`.
- `format.ts` — the record type, shared with pwi's reader.

## Steps

### 0. Probes (throwaway, no pwi changes)

1. Handler order: does an extension loaded with `-e` see `tool_result`
   before pi-lens's handler? Decides whether `hookMs` isolates pi-lens.
2. `BASH_ENV` on the pi process reaches the bash tool's shell through
   `getShellEnv()`; pi-lens's own `bash` runs lack `PI_SESSION_ID`.
3. DEBUG + EXIT traps on this bash: pipelines, loops, `$?`/`$_` preserved,
   user redirects, syntax errors, `set -e`, `exit N`.
4. `createBashTool(cwd, { operations })` re-registered as `bash` behaves as
   the built-in (truncation, temp file, `PI_*` env, exit codes, abort,
   timeout) and pi-lens's read-guard still credits bash reads.

Results (pi 0.87.1 on this machine, bash 5.3):

1. Pass. `-e` extensions load before installed packages
   (`mergePaths(cliEnabledExtensions, enabledExtensions)`), and the probe's
   `tool_result` saw the edit result before pi-lens appended its line: edit
   10ms, pi-lens 3.28s after it. Parallel calls end separately.
2. Pass, with a change: `BASH_ENV` reaches the tool's shell, but on the pi
   process it also reaches every other `bash` pi starts, and `PI_SESSION_ID`
   is inherited when pi runs inside pi. So the wrapper (step 3) sets
   `BASH_ENV` and the trace variables in each call's own env instead; step 2
   is built on top of step 3's wrapper.
3. Pass. `$?`, `$_`, `set -e`, `exit N`, syntax-error line numbers and
   redirects are unchanged; child `bash` is not traced; `$!` catches
   background jobs. Two things shape the design:
   - Every pipeline stage fires its own DEBUG record, and `( … )` subshells
     and loops piped into something fire none. Records are grouped into
     steps by matching `$BASH_COMMAND` against the command text.
   - `$BASH_COMMAND` is bash's reprint: spacing normalised
     (`2>/dev/null` → `2> /dev/null`), quotes kept. Match with whitespace
     removed.
4. Pass. `createBashToolDefinition(cwd, { operations, shellPath,
   commandPrefix })` registered as `bash` returns the same output, stderr
   and exit codes; pi-lens credited a bash `cat` before an edit. The tool
   throws on a non-zero exit, so metrics are written in `finally`. A fresh
   definition per call keeps parallel calls' operations apart.

### 1. Per-call observer

- `tool_execution_start` → start; `tool_result` → result time;
  `tool_execution_end` → append `{v, toolCallId, tool, ms, hookMs}`.
- Synchronous, returns nothing, never hooks `tool_call`. Any throw disables
  the collector for the session.
- pwi loads it like `context-extension.ts`.

Done: `src/tool-metrics/collector.ts`, loaded first by `spawnArgs`; Stats
uses measured times by `toolCallId` and shows Hooks. Live check: a parallel
`sleep 2` and `echo` got 2055ms and 21ms; an edit's 6407ms was 6399ms pi-lens.

Steps 2 and 3 done together: `bash.ts` re-registers pi's bash with wrapped
operations; `trace.bash`, `markers.ts`, `steps.ts`. Commands turning on
`set -x`, or calls with their own `BASH_ENV`, run untraced. A `( ... ) &`
subshell's job has no step. Live check: `cd; cat; echo; sleep 1; seq | wc`
split into five steps with the right bytes and exit codes, the model saw no
markers, pi-lens credited a bash `cat`, background jobs got lifetimes.

### 2. Step timing

- `trace.bash`: no-op unless `PI_SESSION_ID` and the trace fd env are set;
  `unset BASH_ENV` first; DEBUG trap records start, previous `$?`,
  `$BASH_COMMAND`, `$!` changes; EXIT trap records the end. No `functrace`.
- The collector reads the trace at the end of the call and adds `segments`.
- Background PIDs: polled with `process.kill(pid, 0)` for their lifetime.

### 3. Bytes per step (bash wrapper)

- Re-register `bash` via `createBashTool` with wrapped `operations`, copying
  `shellPath` and the command prefix from pi's settings.
- Nonce'd markers to a saved dup of stdout, stripped in `onData` before
  anything else sees them; bytes per step mapped onto the tail the model saw.
- Any throw: pass output through untouched, instrumentation off.

### 4. pwi reads it

- `stats.ts`: exact values replace estimates by `toolCallId`; per-program
  totals from steps; background jobs as their own list.
- Context panel: steps nested under each bash call.

Done: Stats counts a measured bash call per command plus `bash: (shell)`, splits
its tokens by text and shown output (`splitBySteps`), ranks commands in the
outlier lists and lists background jobs; the context panel splits measured
calls the same way from the session's metrics file; `machines.ts` mirrors
each machine's `~/.config/pi-web-ide/tool-metrics/` into
`machine-metrics/<id>`, never read as sessions. A background job's line lands
after its session may be cached, so Stats drops its cache when their count
changes.

### 5. Packages

- A "pwi extensions" section: Reminders and Tool metrics, each on/off. Off
  leaves out the collector, `BASH_ENV` and the wrapper for new sessions.

## Checks

- Unit tests with recorded fixtures; `pnpm typecheck`.
- One real session: a combined call's step times and bytes match its output;
  pi-lens still credits bash reads.
- Report after the probes and after step 1.
