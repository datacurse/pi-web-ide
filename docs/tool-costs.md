# Tool costs: what pi's tool calls cost in time and tokens, and what helps

Measured findings, newest first within each section, each with its date and
how much data it rests on. Add to it whenever a measurement says something
new; correct an entry rather than leave a stale one. How pi itself behaves
(event order, extension loading, bash tracing) is in `docs/pi-facts.md` and
the probe results in `docs/plans/tool-metrics.md`.

## Codemode round trips

### 2026-10-01 — batching works; lookup/edit/verify is not yet achieved

- Sample: 13 completed codemode-using turns across six of the ten most
  recently modified top-level repo session logs, excluding the active audit
  and unfinished turns. 476 nested operations across 113 tool-call rounds:
  4.2 operations per round, median seven rounds. Eleven turns edit/write;
  their median is nine rounds. No matched before/after sample establishes
  a causal speedup.
- Latest completed UI tasks (sidebar indicators / global agent instructions
  in Settings / drawn tool arguments): 9 / 14 / 13 rounds, respectively;
  8 / 10 / 8 rounds before the first edit/write. Wall time:
  131.6s / 248.2s / 221.3s. Summed assistant request intervals:
  88.1s / 165.8s / 166.2s, about 67% / 67% / 75% of wall time.
  These intervals include service, reasoning and generation, not just latency.
- Those tasks have 2 / 3 / 3 explicitly truncated codemode results.
  Sidebar reads `docs/ui.md` eight times and `SessionList.tsx` four times;
  Settings reads its main component six times. Slices differ, but scripts
  also repeat overlapping regions after dumping oversized docs/source batches.
- Settings aborts two discovery scripts on a guessed nonexistent
  `src/server/routes/helpers.ts` and a read beyond App.tsx EOF.
  Drawn arguments requires a test-failure follow-up. Nonzero
  `git diff --no-index` exits are expected differences, not failed validation.
- Sidebar already batches edits, active changed-file LSP diagnostics, tests,
  typecheck and diff into its final round. Discovery is the bottleneck.
  Next target: bounded relevant context, resolve then read paths inside one
  script, reuse stored results, and isolate independent lookup failures.
  Existing codemode supports this; only consider a context-bundle helper if
  it remains unreliable, not another batching/edit extension.

## Test-suite timeout investigation

### 2026-10-01 — one shutdown hang, not five minutes of assertion work

- One full `pnpm test` run reached the terminal test's final `ok`, after
  its assertions and synchronous tmux cleanup, but never reported that test
  file as completed. The outer shell deadline killed the run at **300 s**;
  the package test script itself has no Node test timeout.
- A subsequent full run passed all **190 tests in 6.6 s**. Four more full
  runs, instrumented with a five-second per-worker active-handle report and
  a 12-second Node test timeout, all passed in **4.5–6.8 s**. No worker hang
  was reproduced or captured. Isolated terminal/usage tests also passed.
- The log points to `src/server/terminals.test.ts` failing to exit after its
  work, consistent with a PTY/tmux shutdown handle race. `Terminals.close()`
  and `disposeAll()` send SIGHUP without awaiting PTY exit. The exact retained
  handle is **not confirmed** from the original killed process.
- Diagnostic logs: `/tmp/pwi-codemode-ui-tests.log`,
  `/tmp/pwi-timeout-investigation.tap`, and `/tmp/pwi-hang-trial-{1..4}.log`.
  This investigation changed no runtime or test behavior.
- Follow-up: a deliberately leaking worker printed its completion marker but
  remained alive past a 300 ms Node `--test-timeout`; an outer five-second
  deadline ended it with exit 124. Per-test deadlines alone do not cover this
  post-script shutdown failure. The test command now has a 30-second outer
  deadline with five seconds of kill grace, plus ten-second individual-test
  deadlines. Terminal cleanup waits for exit, escalates after one second,
  and reports a missing exit event after two seconds. Runtime tmux commands
  and integration-test tmux cleanup are also bounded at five seconds.
- Final validation: all **196 tests passed in 14.5 s** with the new command,
  including five mocked PTY shutdown cases and one leaking-worker deadline
  regression; typecheck passed. The real tmux integration still confirmed that
  server disposal preserves shells for adoption. This bounds and hardens the
  suspected shutdown path; it does not prove which handle caused the original
  intermittent hang.

## Native codemode experiment

### 2026-10-01 — compatible, but no aggregate latency win in the first three pairs

- Pi **0.99.2**, `openai-codex/gpt-6.1-sol`, medium reasoning; six fresh
  persistent RPC sessions, three matched read-only tasks against one frozen
  source snapshot. Ordinary tools versus native `codemode.mode: "only"`;
  same instructions, alternating arm order (ordinary first, codemode first,
  ordinary first). All configured packages and PWI extensions stayed loaded.
- Ordinary tools: **16 provider requests, 120.0 s total**, with 80.6 s
  Requesting and 38.6 s Receiving. Codemode-only: **18 requests, 125.6 s**,
  with 60.1 s Requesting and 63.9 s Receiving: **4.7% slower overall**.
  Task pairs (ordinary → codemode): 4 → 7 requests / 31.3 → 51.1 s;
  6 → 6 / 40.2 → 42.8 s; 6 → 5 / 48.5 → 31.7 s.
  These three pairs do not establish a general performance result; fewer
  Requesting milliseconds alone did not mean a faster completed task.
- Provider payload inspection confirmed only `codemode` was declared in that
  arm. Nested execution events retained `parentToolCallId`; PWI persisted
  parent and child tool spans without double-counting their wall time.
  Codemode-only still made several small programs rather than one large
  exploration batch. One nested bash command exited 1 and was recovered.
- A separate local, no-provider sandbox probe confirmed that pi-lens blocked
  an unread nested edit, credited a nested read, reported an introduced
  TypeScript error through edit hooks and active LSP diagnostics, and checked
  its repair. No guards were disabled. This was not a coding-task benchmark.
- These Codex requests emitted request markers but no HTTP response marker;
  Requesting therefore ran until observed output. No HTTP receipt was
  invented. An initial ordinary-arm startup probe exposed no tools and was
  excluded; the valid ordinary arm explicitly selected the normal tool set.
- Raw results, session logs, saved activity JSON, and probe scripts are local
  to `~/.cache/pwi-codemode-dNttBX/` (`benchmark-results.json`,
  `benchmark-state/`, `sessions/`, `smoke-results.json`). Code-mode only is
  enabled for further real-task trials; this measurement does **not** support
  claiming that it is faster than ordinary batching.

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

### Fast-toggle task: model requests dominate 22-minute completion (2026-10-01)

- One completed turn in session `01a0f7b6-d503-73b1-bd6d-a8d7adea1747`,
  raw entries 207–349: prompt at 14:27:01.161 UTC, final answer at
  14:49:30.001 UTC, 1348.840s total. Sol used low reasoning; the screenshot's
  duration is real, not idle time incorrectly charged to the turn.
- Nested assistant request timestamps to persisted entry timestamps total
  1255.131s across 33 attempts (median 30.383s), about 93% of wall time.
  This includes provider/network/reasoning/generation and does not isolate
  queueing or prove that large context caused the latency. Successful
  requests reported input + cache context growing from 143,468 to 219,081
  tokens; total reported output was 21,221 tokens, including 9,910 reasoning.
- 77 requested tools, including 38 read calls (not 38 distinct files).
  Persisted tool-result intervals total 84.417s on the wall path; 76 matched
  raw metric rows sum to 122.907s tool time and 52.495s hooks, overlapping
  because calls were batched. Do not add those sums to wall time. Final
  tests took 8.293s and typecheck 7.032s; active diagnostics took 37.678s.
- Main feature wiring was written by 14:34:47, about 7m46s after the prompt.
  A subsequent request producing four test-file changes took 224.523s.
  Temporary wire/wrapper verification occupied approximately 14:40:26–
  14:46:50 (6m24s), including three failed probe runs: an interception
  assertion, `.ts` top-level await compiled as CJS, and an unsettled await.
  These were harness failures, not demonstrated feature failures.
- One additional request failed with `WebSocket closed 1012` after 37.595s;
  the retry took 42.257s before diagnostics could run. No compaction entry
  appears within the turn. Supported targets are fewer sequential model
  requests, narrower context, and simpler verification harnesses—not
  disabling checks or optimizing filesystem reads. Context reduction is a
  plausible improvement, not a measured causal result from this one turn.

### Action Fusion helps selectively, not a measured task-wide speedup (2026-10-01)

- Same-repo raw history, deduplicated by assistant entry ID: 460
  `gpt-6.1-sol` requests, 173 edit/write calls, and 14 calls with non-null
  `then_run` across four sessions. All 14 were sole-tool requests; fusion
  raw frequency is 8.1% of edit/write calls, not an opportunity-based
  adoption rate. No corresponding tool result was
  marked `isError`; this does not prove every nested shell command passed.
- If each follow-up would otherwise require its own model request, these
  represent 14 avoided requests: 2.95% versus an estimated 474-request
  unfused equivalent. This is a counterfactual estimate, not an A/B test;
  checks could otherwise be batched with other work.
- 36 short bash-only requests (reported output below 200 tokens) took a
  median 8.49s, with observed quartiles 6.50–9.89s. Applying that proxy to
  14 avoided requests suggests about 119s saved (91–139s using quartiles),
  around 1.4% of the sample's 8319s summed model-request intervals. These
  intervals include transport/service/reasoning, not just generation.
  Commands still execute; fusion removes a round trip, not their run time.
- No matched on/off tasks establish actual end-to-end latency or billed
  token savings. The supported finding is small likely savings, not a broad
  demonstrated performance improvement.
- Follow-up opportunity audit (same day, 142 edit-bearing assistant requests,
  including the initial measurement's documentation edit): 14 fused requests;
  71 unfused requests immediately continued editing, and 12 immediately
  requested only active LSP diagnostics. These are reasonable non-fusion
  cases: don't run premature checks or replace diagnostic tools with shell
  commands. Other cases involved reads, discovery, or mixed-tool requests.
- Ten unfused requests immediately led to bash-only requests. At least four
  were clear missed opportunities: final SessionTabs edit followed by tests;
  the measurement documentation edit followed by diff checking; agent test
  edits followed by diff review; and an intentional-error source probe
  followed by its preplanned check/cleanup. Multi-file parallel writes and
  new discovery/probes are not automatically safe/useful fusion candidates.
- The 14 actual uses were meaningful: six documentation diff checks,
  four write/edit-and-run analysis probes, two typecheck/test runs, and two
  compaction smoke runs. Raw edit frequency therefore understated sensible
  usage; nevertheless, direct safe follow-ups were sometimes missed.

### Request-path probes find little local send overhead (2026-10-01, 5 live Sol requests)

- Temporary RPC children retained global/project extensions, medium reasoning,
  and current personality/reminder settings; they used private `/tmp` copies
  of the same completed session with about 40K tokens of reported context.
  Three prompts requested `OK` without tools; a fourth requested one read of
  `package.json` and its package name, yielding two more model requests.
  No production code/settings were changed; temporary observers logged only
  timings, transport hosts, counts, status, and usage, not credentials/payloads.
- Monotonic hooks plus Node HTTP diagnostics and WebSocket observation:
  local preparation from input (or next `turn_start`) to connection creation
  on cold calls, or `WebSocket.send` on warm calls, took 6.8–23.4ms.
  Cold connection creation to send took 517.5–521.7ms across two processes;
  subsequent requests reused the socket. This includes DNS/TCP/TLS/upgrade
  and cannot be assigned entirely to either side. `send` is the application
  handoff, not proof that every byte has reached the network/provider.
- Send to first incoming WebSocket event: 363.6–563.5ms; that event to first
  model delta: 2.11–4.86s. Send to complete assistant message: 2.77–6.13s.
  Three no-tool prompt totals: 4.42s / 3.30s / 2.78s; the read-only tool task
  took 10.83s, including roughly 0.21s between its two model responses.
  Streaming output was 5 tokens on each `OK` request, then 35 / 6 tokens
  on the tool-call/final requests. This small probe is not a coding benchmark.
- Historical recent-sample gaps, user message to first assistant request
  timestamp: 27 Sol / 60 Opus, median 19ms / 81ms. Last persisted tool
  result to next assistant request timestamp: 291 / 422 intervals, median
  11ms / 32.5ms, p90 1.00s / 2.20s. These gaps are outside the previously
  reported model-request intervals and can include hooks/auth/compaction;
  they are not pure send-time measurements, but do not show a Sol median
  local-preparation bottleneck. Browser submit/startup delay is not covered.
- Provider source confirms model requests are made inside pi, not through
  pwi's browser/server per tool round trip. The Codex assistant timestamp is
  created before payload hooks/transport; `message_start` is emitted only
  after the first incoming WebSocket event. Neither timestamp is TTFT.
  No per-request provider processing timing was available on this WS path,
  so post-send time remains provider + network, not proven pure provider time.
- A live Opus comparison was blocked by Anthropic OAuth refresh returning
  HTTP 400 `invalid_grant` / `account_on_hold`; all three attempts failed
  before inference and must not be treated as fast successful Opus replies.
  Sol's loaded Anthropic authentication extension also attempted a background
  refresh, but it did not block these successful Sol requests.

### Historical speed comparison refreshed (2026-10-01, 27 Sol / 60 Opus turns)

- Replayed local raw session JSONL, deduplicating identical user/assistant
  entry sequences and retaining only single-model turns ending in `stop`;
  active, failed, aborted, and mixed-model turns are excluded. Same-repo
  sample: all 27 completed `gpt-6.1-sol` turns versus the latest 60
  `claude-opus-5-5` turns; both record medium reasoning. Opus dates are
  September 29–30 UTC, Sol October 1; these are different tasks/days.
- Tool-using subsets (19 Sol / 50 Opus): median completion 209.3s / 94.9s,
  model requests per turn 12 / 8.5, tool invocations 21 / 7.5. Across their
  313 / 474 request intervals, median request duration is 11.73s / 5.06s.
  Median summed request time per turn is 184.0s / 56.6s, versus remaining
  wall time 25.3s / 43.5s; these separate medians do not add to wall medians.
- Short requests with 30K–60K reported input + cache context and 1–199
  output tokens: 66 Sol / 20 Opus, median 7.28s / 2.61s. Median context
  39.5K / 42.2K and output 65.5 / 162.5 tokens, respectively. Slower Sol
  request intervals persist within this context band despite shorter output.
- No-tool turns (8 Sol / 10 Opus) complete at median 15.3s / 7.2s;
  restricting to 10–30 tool invocations (11 / 17 turns) gives 191.8s /
  189.3s. Tool-count bands are not equivalent-work benchmarks, but show why
  the overall 2.2x task gap cannot be attributed to model speed alone.
- Broader same-repo history: 584 completed Opus turns versus 27 Sol, median
  43.0s / 128.6s; old Opus turns include differing reasoning levels and
  workloads, so the recent medium-reasoning sample is more useful.
- Request intervals use assistant message timestamp to session-entry
  timestamp, not time to first visible token or isolated generation speed;
  they cannot distinguish service waits, reasoning, or transport. No completed
  new task in this snapshot starts after the personality/instructions rollout
  at 13:57 UTC, so this does not yet measure that change.

### Split personality and global workflow instructions (2026-10-01)

- Applied the agreed drafts to `~/.config/pi-web-ide/personality.md` and
  `~/.pi/agent/AGENTS.md`. Personality now contains only communication
  guidance; global instructions contain implementation, efficient exploration,
  batched validation, and existing environment/read-guard rules. Repo-specific
  instructions and the personality repetition setting are unchanged.
- Use the new files' modification timestamps as the rollout boundary, and
  compare new sessions only: existing pwi children retain their old personality
  snapshot. No model/reasoning/diagnostic settings changed in this rollout.
- Prior recorded same-repo baseline: 13 completed GPT tool-using turns,
  median 216.6s, 12 requests per task, 11.89s per request. This is an
  observational baseline, not a matched-task benchmark; performance after
  this policy split has not been measured yet. Compare task duration,
  model-request count, and correctness on comparable new-session tasks.

### Timing recheck confirms the live Stats fix (2026-10-01, 19 GPT / 60 Opus turns)

- Live `/api/stats` now reports the affected optimization task as 229.406s,
  matching raw session replay. Completed same-repo GPT turns now number 19;
  active `toolUse` turns are excluded, as are mixed-model turns in Stats.
- Tool-using medians (13 GPT / 50 Opus): 216.6s / 94.9s; median request
  duration 11.89s / 5.06s, with 12 / 8.5 requests per task. Median summed
  request time remains 184.8s / 56.6s; remaining wall time 28.8s / 43.5s.
- Restricting to 10–30 tool calls (10 GPT / 17 Opus) gives 200.5s / 189.3s.
  This remains an unmatched observational sample, not a controlled comparison.
- Latest completed Stats bug fix: 184.3s total, 155.5s in model-request
  intervals and 28.8s elsewhere. The timing correction fixes reporting,
  not generation speed; model/service waits remain the larger contributor.

### Recent GPT turns wait more on model requests, not tools (2026-10-01)

- Same local pwi repo, completed turns only, excluding the active analysis:
  17 GPT (`gpt-6.1-sol`) turns today versus the latest 60 Opus
  (`claude-opus-5-5`) turns. Tool-using subsets: 11 GPT and 50 Opus turns.
  Using actual final-assistant timestamps, median task duration is 216.6s
  versus 94.9s; no-tool subsets (6 / 10) are 13.0s versus 7.2s.
- Tool-using turns have median 14 GPT model requests versus 8.5 Opus,
  and 24 tool invocations versus 7.5. Bash may contain several commands,
  so invocation counts do not measure equivalent amounts of filesystem work.
  Median request duration is 11.6s versus 5.1s (assistant message timestamp
  to session-entry timestamp, not time to first visible token).
- Short tool-call requests (under 200 reported output tokens): 107 GPT
  versus 80 Opus requests, median 7.59s versus 2.57s, with similar median
  input + cache-read context (32.2K / 34.4K). Both session groups record
  medium reasoning; levels/token accounting are not necessarily equivalent
  across providers. These intervals include service, reasoning and generation
  time; the logs cannot isolate queueing, transport or model computation.
- Median summed request time per tool-using task: 184.8s GPT / 56.6s Opus;
  median remaining wall time: 29.8s / 43.5s. Measured edit medians improve
  (63 GPT edits: 1.66s, hook 1.59s; 73 Opus edits: 8.50s, hook 3.27s).
  Opus edit totals can include `then_run`, so these are not edit-only costs.
- After optimization finished: just four subsequent tool-using GPT turns,
  five plain measured typechecks at median 5.10s (2.27–14.80s). Real changed
  code still needs checking; unchanged-cache speed is not whole-task speed.
  Task medians before/after (7 / 4 tasks) are 209.3s / 240.0s, but differing
  tasks and the tiny sample cannot establish a regression caused by tuning.
- Workload sensitivity: restricting to 10–30 tool invocations gives 9 GPT
  tasks / 17 Opus tasks with median 209.3s / 189.3s. This observational
  comparison is not a controlled model benchmark; slower request intervals
  and more round trips are better-supported findings than a universal 2.3×
  task slowdown.
- Found a Stats timing bug: `parseLines` updates its turn end for any
  message before filtering roles. A system reminder before the next prompt
  charged idle time to the previous completed turn: the optimization task
  shows 1570s in Stats but actually completed in 229s. Analysis above uses
  raw final-assistant timestamps. Fixed on 2026-10-01 by letting only
  assistant/tool-result messages advance the turn end; regression coverage
  checks system/custom reminders both before the next prompt and at EOF.
  Replaying the affected session now yields 229.406s; all seven Stats tests
  and `pnpm typecheck` pass.

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
