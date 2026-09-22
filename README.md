# pi-web-ide

A deliberately thin web UI for the **pi** coding agent (`pi/0.85.1` here).
Two panels: session list on the left, chat on the right.

pwi does not link an agent SDK. It spawns `pi --mode rpc` and talks JSONL
over stdio, so the agent is a *binary* dependency rather than an npm one.

```bash
pnpm install
pnpm dev                     # server :8890 + vite :5480
pnpm build && pnpm start     # single process, serves dist/ itself
```

Point it at a workspace with `PWI_CWD=/path/to/project` (or pass the path as
the first argument). `PWI_MODEL=provider/id` overrides the model,
`PWI_PI_BIN=/path/to/pi` the binary. To run it as a background service on a
machine, see [Deployment](#deployment).

Another machine runs its own pwi the same way. Reach it by forwarding its
port (`ssh -L 8890:localhost:8890 orangepi`) or with `tailscale serve`, and
open that in a browser tab. See [Multiple machines](#multiple-machines).

**Restarting takes the port.** Starting pwi while an older pwi holds `:8890`
kills the old one and binds — restarting is never anything else, and "find
the pid, kill it, start again" was three steps of ceremony. It only ever
kills a process that identifies itself as pwi on `/api/health`; an
unrecognised occupant is left alone and startup fails as before. Set
`PWI_TAKEOVER=0` to always fail instead, which is what you want under a
supervisor where two units could otherwise kill each other in a loop. See
[Port takeover](#port-takeover).

## Non-goals

These are decisions, not omissions. Scope creep should have to argue with this
list:

- no plugins, no goal mode
- no file tree, no multi-user
- no NESTED terminal splits: each terminal tab is one row or one column of
  shells, never a tree. Panes inside panes are tmux's job, and tmux is one
  command away — see [Terminal](#terminal)
- no settings *page* — one dialog. Everything in it is browser-local (theme,
  whether thinking is shown) with exactly one exception: the personality
  field, which edits the extra system-prompt text this server passes to every
  session it starts (`~/.config/pi-web-ide/personality.md`). The rule it bends
  was "no second place to look", and a field that reads and writes that file
  in place keeps it: there is no second copy of it anywhere. Everything else
  that changes how the agent runs still belongs in pi's own config
- no session **tree** — the list is flat and read-only; forking a session is
  the TUI's job
- no tab reordering and no drag-drop. Tabs are ordered by when you opened
  them, which is information; a hand-sorted strip is another piece of state to
  persist, reconcile and debug for no gain
- no syntax highlighting — assistant text goes through `markdown-to-jsx` (one
  dependency, no plugin chain) and user text stays `whitespace-pre-wrap`,
  because you typed it and know what it says. Math is the one exception: see
  [Math](#math)
- no approval gate to configure — pi has none, and a browser has no terminal
  to answer one on. The blocking questions an extension does raise — `ask`,
  `confirm` — are answered in the browser (see [Questions](#questions)),
  though a session left running with nobody attached will sit on one
- no image *generation*, no file attachments beyond images, no clipboard
  history — pasting a screenshot is in scope; a file manager is not
- no central gateway across machines, no merged cross-machine session list,
  and no fleet manager. One pwi per machine, serving its own browser; you
  reach another machine by opening that machine's pwi. See
  [Multiple machines](#multiple-machines)

## Architecture

```
src/shared/types.ts       wire contract, zero imports — FROZEN
src/server/agent.ts       THE RPC BOUNDARY — only file that spawns or speaks to pi
src/server/sessions.ts    session list, parsed from ~/.pi/agent/sessions
src/server/models.ts      model catalog + startup default, asked of pi over RPC
src/server/registry.ts    session cache + server-authoritative message state
src/server/index.ts       SSE for events, POST for commands
src/server/takeover.ts    claims :8890 from the previous pwi on startup
src/server/state.ts       ~/.config/pi-web-ide, where this server keeps its own state
src/server/autoname.ts    one-shot `pi -p` children: commit messages, session names
src/server/personality.ts the extra system-prompt text, read and replaced in place
src/server/terminals.ts   one login shell per project, on a real PTY
src/server/git.ts         branch/commit/push/PR, argv-only, no shell
src/web/commands.ts       slash-command completion rules for the composer
src/web/math.ts           pulls TeX out of markdown before markdown eats it
src/web/termLayout.ts     terminal tabs + splits: the arrangement, not the shells
src/web/                  React: SessionTabs + SessionList + Chat + Settings
```

`types.ts` keeps its `Pi*` names (`PiEvent`, `PiMessage`, `PiBlock`,
`PiPartial`, `Snapshot`, `PiSessionInfo`, `PiImage`): the agent on the other
end of the wire is pi, so the prefix says exactly what those shapes are.

SSE rather than WebSocket, because this is one-directional streaming plus
discrete commands. The browser gives us reconnect semantics for free and
prompt/abort are plain POSTs; a WebSocket would buy nothing and cost us a
framing/reconnect/ack protocol to write and debug.

## Port takeover

pwi binds one fixed port, and the only thing that ever holds it is the pwi
you are restarting. So startup claims it: probe the port, ask who is there,
stop them, bind.

"Ask who is there" is the whole safety argument. `/api/health` answers
`{ ok: true, product: "pi-web-ide", cwd, pid }` and nothing else on the
machine does, so an occupant that does not name itself that way is **not**
killed — startup fails with the
old message instead. A web UI for a coding agent has no business killing
whatever program happens to hold a port, and "it was on my port" is not
identification.

The pid comes from `/api/health` when the occupant is new enough to report
one, and otherwise from `/proc/net/tcp` + `/proc/*/fd` — the listening
socket's inode, matched to the process holding it. That fallback exists for
exactly one case, and it is the important one: the pwi you are replacing is
by definition the *older* build, so on the upgrade that introduced this
feature it is the only path that works. No `lsof`, no `ss`, no shelling out
to find a pid we are about to signal.

`SIGTERM` first — the old server disposes its sessions and closes cleanly —
then `SIGKILL` after 5s, because a server wedged in shutdown still has to let
go of the port and everything it owns is on disk anyway. If the port is still
held after that, startup fails rather than looping.

`PWI_TAKEOVER=0` restores fail-and-tell-you. Under a supervisor that restarts
units automatically, two units configured for one port would otherwise take
turns killing each other forever.

**This kills the agent runs of the server it replaces.** That is what
restarting a server means, the sessions are all on disk, and a detached run
is the one thing you might be losing — so it is worth knowing before you
restart mid-turn.

## Why a subprocess instead of the SDK

pwi used to import the agent in-process, and `pi.ts` was the one file allowed
to do it. That rule existed because the SDK's churn is concentrated in
*construction* — the credentials/models/session boilerplate was rewritten at
least twice upstream (`AuthStorage` + `ModelRegistry` → `discoverAuthStorage` →
`ModelRuntime.create`) and the npm scope moved `@mariozechner/*` →
`@earendil-works/*`, while the agent's actual behavior stayed put.

`pi --mode rpc` removes the reason for the rule instead of restating it: it is
a documented wire contract — commands in, frames out, strict JSONL — rather
than a constructor whose shape is whatever the SDK settled on this week. Two
more properties fall out of it:

- **Process isolation per session.** One child per open conversation. A tool
  that wedges its host, an OOM inside one turn, or a panic in the agent takes
  down that child and nothing else. In-process, all of it was one heap.
- **Restartability.** Conversation state lives in pi's own JSONL under
  `~/.pi/agent/sessions/<cwd>/`, so a child is disposable: `--session <file>`
  rehydrates one for the cost of a spawn. Restarting the server loses at most
  an in-flight turn, never the work — which is what makes running pwi under a
  supervisor with `Restart=always` a reasonable thing to do.

The cost is real and worth naming: everything is async, and nothing can be read
out of a live object. `agent.ts` therefore keeps a small server-side mirror of
each session (messages, model, streaming) fed by the frame stream, so
`messages()` can stay synchronous for its callers.

It also normalizes pi's frame types down to the same six events the UI already
consumed: `text`, `thinking`, `tool_start`, `tool_end`, `message_done`, `idle`,
`error`. That is why `types.ts` did not have to change, and why the browser has
never seen an `assistantMessageEvent`.

Sessions are listed by reading the JSONL store directly rather than by asking
the CLI, for two reasons documented in `sessions.ts`: RPC mode is one
subprocess per *open* session, so enumeration would mean spawning a process
just to list (~1s of Node startup per poll); and the per-project directory
name is not a usable key, because the cwd encoding is lossy (`/tmp/pi-probe` →
`--tmp-pi-probe--`, with every separator becoming a character the path may
already contain). Reimplementing that encoding would be a guess that fails by
returning an empty list. Every session file carries its own `cwd` in a `session` header entry, so
we scan the store and filter on that.

## Image attachments

Ctrl+V pastes a screenshot into the composer; drag-drop and an Attach button
use the same path. Images ride along with the next prompt.

Three things are deliberate:

- **Raw base64 on the wire, no `data:` prefix.** That is what pi's image
  content wants, so the prefix is stripped once at the browser edge and there
  is a single representation everywhere else.
- **No resizing here.** The in-process version shrank screenshots through the
  SDK's Photon/WASM `resizeImage`. Across RPC the image is pi's to normalize
  for the provider, and the only way to keep resizing in pwi would be a native
  image dependency — a large cost for a step the agent already owns. `agent.ts`
  validates instead (type allowlist, non-empty, 20MB ceiling) and passes the
  bytes through. A rejection here is reportable to the user; a provider 400 is
  not.
- **`supportsImages` is server-authoritative** and part of the snapshot, read
  off the model's `input`. Selecting a text-only model hides the attach
  affordance instead of letting the user stage a screenshot that would 400. It
  fails closed: absent metadata means no.

An image with no text is a valid prompt ("what is this?" is implied), so a
prompt is only rejected as empty when text *and* images are both empty.
Attachment failures are rejected before the prompt is sent, so they surface as
a failed POST rather than a turn that dies mid-flight.

## Thinking level and context usage

The status bar carries both: a reasoning-effort select next to the model, and
an occupancy meter next to the spinner.

**Thinking level.** `get_state` already returns `thinkingLevel` and, on the
resolved model, `thinking.efforts` — and the list is genuinely per-model
(`claude-opus-5` offers `low…max`, `claude-haiku-4-5` offers `minimal…xhigh`),
which is why the picker is built from the session rather than from the model
catalog. `"off"` is prepended: every model with a `thinking` block accepts it.
A model with no block at all reports an empty list and the control is not
rendered.

Setting it is `set_thinking_level`, and the **validation is on our side of the
boundary on purpose**: pi answers `success: true` to any string, including
`"bogus"`, and the session then reports *no* level at all — a state worse than
the one the user asked for, and invisible until a later turn reasons
differently. `agent.ts` rejects a level outside the model's list, the route
answers 400, and the session keeps the level it had. Switching models re-reads
the whole set, because the new model's levels are its own.

Unlike a model switch, this is allowed mid-stream: it applies from the next
turn, so there is no in-flight request for it to disturb.

**Context usage** is measured, never estimated, and it comes from the session
rather than from the transcript: `get_session_stats.contextUsage` is pi's own
occupancy for this conversation, already including the system prompt, the tool
schemas and the cached prefix that a token count computed in the browser would
miss. The distinction is load-bearing after a compaction — the newest
assistant message's `usage.totalTokens` still describes the prefix that was
just folded away, so a meter fed from messages reads full until the next turn.
During a turn the streamed `usage` keeps it live; every settle, compaction and
model switch re-reads it.

The meter reads `35k/1.0M` with the exact figures in its tooltip, and goes
amber at 75% and red at 90% — the band where the next big tool result triggers
a compaction. It is hidden for a model that declares no window.

## Slash commands answer below the transcript

Anything typed into the composer goes to pi as a prompt, so the commands this
project's extensions, prompt templates and skills define work. Some of them
are **local**: pi handles them itself, which means no turn, no message
appended, and no `agent_start`. Their entire output is whatever `notify` the
extension chooses to send, and pi's own maintenance — a compaction, an
auto-retry — talks through the same one-way channel. pwi used to drop all of
it, which is why such a command looked like it had done nothing at all.

Now those frames land under the transcript as notice lines (info neutral,
warnings amber, failures red), they are part of the snapshot so a reload or a
dropped `EventSource` does not lose them, and the next prompt clears them:
the answer to a command belongs to that command.

Three details cost a while to find:

- **There is no "the agent was not invoked" field.** A prompt is acknowledged
  with a plain `{ success: true }` whether it reached the model or not, and a
  local command then emits nothing further — no `agent_start`, no
  `agent_settled`. The absence is the only evidence there is, so it is timed:
  a prompt beginning with `/` that has produced no `agent_start` within 1.5s
  is settled as local.
- **Nothing tells a client the transcript changed.** Settling as local
  re-reads the transcript and the session stats and then emits one `idle`,
  which is what makes an attached browser refetch. A local command really is
  idle: there was no turn.
- **The command itself is never in the transcript.** It appends no message, so
  the `/compact` you typed disappears with the composer text, and the ack
  lands in milliseconds while the work runs on. So the composer echoes what it
  sent as a user row, marked `working…` until the answer arrives (a notice, a
  real turn, or an error), and the row stays afterwards as the question its
  notice answers. Both are cleared by the next prompt.

A compaction boundary is rendered as a divider — `COMPACTED — CONTEXT STARTS
HERE` — that expands to the summary: everything above it is out of the model's
context and only the summary remains. Its text comes from the entry's
`summary` field, not `content`, which a `compactionSummary` message does not
have at all — reading `content` rendered the boundary as a blank row.

### The picker

Typing `/` at the start of an empty composer raises the command list, the way
the CLI does: one row per command with its description and a dim tag saying
where it came from (`extension`, `prompt`, `skill`), narrowing as you type. ↑/↓ move, Tab completes the highlighted row, Enter takes it too
(with one exception, below), Escape hides the list for the text it was
showing (typing another character brings it back), and the mouse works on
`mousedown` rather than `click`, because `click` lands after the blur and the
caret would have nowhere to go.

Not a modal, deliberately. The list is only useful *while* you keep typing
into the box it is completing, and a dialog would take the keyboard away and
put a backdrop over the transcript you are writing about.

Accepting a row always leaves a trailing space, because every pi command that
takes arguments takes them as free text after the name — `/skill:review the
auth change` — so one keypress leaves the caret where the argument goes. The
picker opens only while the WHOLE composer is one unfinished command, so
`and/or` is prose, a slash on a second line belongs to the sentence above it,
and `/compact soft focus on X` is arguments being written rather than a name
to complete. Matching is prefix-first and then substring, which is what makes
a long skill name findable from its distinctive middle. `commands.test.ts`
pins those rules.

The exception: Enter **sends** when the highlighted row would only add the
trailing space you are missing. `/compact` + Enter runs `/compact` instead of
costing a second Enter, while `/co` + Enter still completes. Found by typing a
whole command into the box and watching it not run.

The catalog comes from the session, never from a table in pwi: `get_commands`
when the session opens, re-read whenever the menu is raised. Which commands
exist depends on the project's `.pi/extensions`, `.pi/prompts` and
`.pi/skills` — and on whichever packages are installed globally — so a
hardcoded list would confidently offer commands the agent does not have. It
rides in the snapshot because it is per-session state, like the model or the
thinking levels.

## Opening a session blanks the pane

Clicking a session in the list has always switched the tab immediately, but
the window kept showing the PREVIOUS conversation until the open resolved —
and opening spawns a pi child and reads the whole transcript, which on a
706-message session is ~6s. A click that changes a strip at the top of the
screen and nothing else reads as a click that did nothing, so the pane now
blanks and says `Opening session…`.

The label holds at zero opacity for the first quarter of a 1.2s fade
(`.opening-label` in `index.css`), because a warm session — one the server
still has live — answers in under 30ms, and a message that flashes for two
frames reads as a glitch rather than as information. Keyframes rather than a
`setTimeout`: it costs no render, and reduced motion gets the same delay
without the fade, since the text is information.

A reattach to the session already on screen deliberately keeps its
transcript. An `EventSource` that dropped, or a server that restarted, is not
a new session to wait for, and blanking what is already correct would be a
flicker for nothing. `opening` is therefore a separate flag from `busy`: the
first means "no transcript yet", the second "the agent is working".

Opening is slow enough to change your mind during, so every attach takes a
ticket and a stale one may not touch the screen. Clicking a big session (or
`+ New`) and then selecting something else used to end with the first answer
landing seconds later and yanking you into a tab you had already left. A
superseded attach still *registers* its tab — the session exists server-side
and a created session with no tab would be unreachable — but it does not take
the selection, does not replace the transcript, and above all does not install
its `EventSource`, which would stream one session's deltas into the pane of
another. Its retry-on-unreachable is dropped for the same reason.

## The transcript follows the stream only when you are at the bottom

Auto-scrolling on every delta made reading back impossible: the transcript
grows several times a second while a run is going, so scrolling up to inspect
an earlier tool call was undone before it could be read. Being parked at the
bottom is the only state in which "keep me at the bottom" is what the reader
asked for, so that is the only state that follows.

"At the bottom" is a flag set from the container's scroll event — within
`PINNED_SLACK_PX` (24px, one line) of the end — and not measured when new
content arrives: by then the content has already grown the scroll height, so
the reader is never at the bottom by that definition. The last scroll the
*user* made is the intent worth reading. Scrolling back down re-arms
following, and opening another session jumps to its latest turn and resets the
flag, since the previous one may have been left scrolled up.

The jump is instant, and that is what keeps the flag honest. A scroll event
cannot say who caused it, so a *smooth* follow un-pins itself: text arrives
faster than the animation travels, the handler sees a gap well short of the
bottom, reads it as the reader scrolling away, and following stops mid-stream.
Landing exactly at the bottom means the event our own scroll produces
re-states "still pinned" instead of contradicting it. Measured while streaming
at the bottom, the gap stays `0`; scrolled up, `scrollTop` held at 595px while
the transcript grew from 2118px to 2335px.

It scrolls the container rather than a sentinel child, because
`scrollIntoView` also scrolls every ancestor — on a narrow viewport that moves
the page itself.

## Open tabs are restored on reload

Several sessions of one project stay open as tabs, switched like editor tabs,
but only the **selected** tab is attached — one `EventSource`, exactly as
before. Inactive tabs are just files in a list; their live dot comes from the
session list the app already polls, so there is no per-tab connection and no
new endpoint. Closing a tab closes only the tab: no abort, no delete, the
session keeps streaming server-side and stays in the list. That is the first
invariant below, applied to the client.

The session list is therefore no longer the primary navigation but the "all
sessions" surface: clicking an entry opens it in a tab, and at ≤768px it
collapses into a drawer so the chat gets the width.

The ordered open set and the selection are kept in `localStorage` under
`pwi:tabs:<project cwd>` (value `{"files":[…],"active":"…"}`). One key per
project, because the strip only ever shows one project's sessions: the key is
read and written whole, and switching projects cannot corrupt the other
project's entry.

The session **file** is the identity, not the id. It is the stable on-disk
identity, it is exactly what `/api/sessions/open` takes, and `pi --session <file>`
resumes to the same session — so a restored tab travels the same path a click
would, and survives both a server restart and an idle eviction that
invalidates the in-memory id. Storage rather than the URL because this is
per-window UI state, not a shareable address, and pwi has no router.

A remembered session that no longer exists is dropped, but only on positive
evidence: a session list actually received for that project. A failed fetch, or
one against a server still starting, is not evidence of absence, and pruning on
it would wipe the whole strip on a transient error. Sessions this page opened
are exempt, because the JSONL is written lazily — a `+ New` session not yet
prompted is legitimately absent from the listing while being perfectly alive.

`Alt+1..9` selects the Nth tab. Alt and not Ctrl/Cmd because `Ctrl/Cmd+1..9`
and `Ctrl/Cmd+W` are the browser's own tab bindings and a web app stealing them
is hostile; the handler reads `e.code` rather than `e.key`, since Alt+digit
produces a different character on several layouts (macOS Alt+1 is `¡`) while
the physical digit key is what the user pressed.

The strip is a real ARIA tablist with **manual** activation: arrows, `Home` and
`End` move focus, and native button activation selects. Automatic activation
would open — and therefore stream — every session you arrowed past.

This feature turned three latent server bugs into everyday ones, so all three
are now fixed:

1. **`acquire()` reused sessions by id only.** Opening a file always built a
   fresh session, and since the id derives from the file, the new entry
   *overwrote* the old one under the same key — leaking the old session and
   orphaning its SSE subscribers, so an already-attached tab went silent
   forever. Harmless when opening took a click; routine once every reload
   reopens. `acquire()` now matches on file as well as id.
2. **Opening a missing file silently created it.** Correct for `+ New`, wrong
   for "resume this file": a remembered-but-deleted session came back as an
   empty ghost. Now a 404, which the client treats as "forget it".
3. **A session was served to whichever project asked for it.** A tab remembers
   a session *file*, and nothing checked that the file belongs to the selected
   project — while `openSession` deliberately resumes in the cwd from the
   session's own header. So a session file remembered under the wrong project's
   key opened happily and was then displayed, and prompted, under a project it
   does not live in: the tab strip said one directory, the agent's tools read
   and wrote another. `/api/sessions/open` now answers **409** when the live
   session's cwd is not the requested project, and the client drops such a tab
   exactly as it drops a 404. The comparison is canonical, because a cwd
   recorded through a symlink is the same project — a false 409 would silently
   cost the user a tab — and it runs against the live session rather than the
   file's header, since a `+ New` session has no file on disk to read a header
   from yet.

The subtlety in (2) is the same lazy write seen from the server: absence on
disk does not mean gone, and reloading immediately after `+ New` must not 404.
The registry is therefore the first authority and the filesystem only the
fallback.

A blank `cwd` on that route is now a **400** rather than a fallback. It used
to be accepted, and `""` survives `cwd ?? CWD` all the way into `spawn`, where
Node reads it as "inherit" — so the session was created wherever the *server
process* happens to run, which is not even the project the server was launched
for (`PWI_CWD`). The browser sent exactly that whenever `+ New` was pressed
before `/api/projects` answered, so the client now waits for a project before
creating anything: a create needs a project, and an omitted `cwd` still means
`PWI_CWD` for a single-project launch.

### The selected project is per window, not per browser

Two keys, and the split is the whole point:

- `sessionStorage["pwi:project"]` — **this window's** selection. Scoped to the
  browser tab, survives a reload, an HMR refresh and a session restore, and is
  invisible to every other window.
- `localStorage["pwi:lastProject"]` — the project someone last *explicitly*
  selected, anywhere. It is only ever the seed for a brand-new window.

One `localStorage` key did both jobs, and two windows on two projects then
fought over it: the second selection overwrote the first, and the next reload
of *either* window silently adopted the other's project — dragging in that
project's tab strip and pointing `+ New` at a directory nobody had selected.
A window's resolved project is therefore pinned to `sessionStorage` on mount,
including a value inherited from the shared key, so a window that never
touches the dropdown still keeps what it opened on. Only an explicit
selection writes the shared key, since restoring a window is not a choice.

Two windows deliberately on the *same* project still share that project's
`pwi:tabs:` entry, so the last one to change its strip wins what a future
reload restores. Live strips are independent; only the remembered one is
shared.

## What a session is called

Three sources, one precedence, resolved in `src/web/sessionName.ts` so the
session list and the tab strip cannot disagree: **a name pi holds**, else
**the first user message**, else the uuid half of the filename.

**Right-clicking a row** opens its menu (the keyboard's own menu key raises
the same event, and a keyboard-raised menu reports `(0,0)`, so it is anchored
to the row instead of to the corner). No always-visible control per row: a
pencil on every row is forty pencils down a panel whose job is opening
sessions, not naming them. Three items, cheapest first:

| item | what happens | cost |
| --- | --- | --- |
| **Rename…** | the row becomes an input | none |
| **Name from first prompt** | derived locally, written immediately | one rename request |
| **Summarise with pi** | a one-shot `pi` child reads the opening request and titles it | a model call, seconds |

The menu closes on a click, Escape, a scroll (captured, since a scroll inside
the list does not bubble) or a resize — every gesture that would make its
position a lie is also one that means "not this".

**Rename…** replaces the row with an input: the thing being named is in front
of you, and the new name lands exactly where the old one was. Enter commits;
Escape *and* a click elsewhere both cancel, because committing on blur would
write a half-typed name from a misclick.

Every write goes through pi, not through the file: `POST
/api/sessions/rename` → `Registry.rename` → `set_session_name`, which appends
a `session_info` entry to the JSONL and wins over every earlier one. pi owns
the name: that file is one pi has open and is still appending to, so writing
the entry ourselves is the kind of clever that corrupts transcripts. The name
therefore shows up in the TUI and in every other pwi window too.

A rename addresses the session by **file or id**, because both callers are
real: a list row may be a session nobody has opened, while an open tab knows
its live id. Renaming a cold session costs one `pi` spawn, since pi is the
writer, so the client applies the new name optimistically and refetches after
— a rename that takes seconds to appear reads as one that did not work.

### Summarise with pi

pi has no titler of its own, so `POST /api/sessions/autoname` writes the name
here: the session's FIRST user turn (the request it was opened to serve, not
its most recent detour) is handed to a separate one-shot `pi -p --no-session`
child, and the sentence that comes back is written through
`set_session_name`. That write is synchronous, so there is nothing to poll
for and no second channel to watch.

The child is the same shape as the commit namer in `autoname.ts` — no tools,
no extensions, no skills, no prompt templates, no context files, no thinking
— because the job is one short label about text that is already in the
prompt, and every discovery pass is pure latency on a click.
`PWI_NAMING_MODEL` picks the model; unset means pi's default. A session with
no messages yet has nothing to summarise and is refused as such, and while
the request is in flight the row reads `Naming…`.

**Name from first prompt** is the same derivation as the short-names
preference, written permanently instead of only displayed. It is deliberately
not a model call: instant, free, and stable across re-renders.

**Short names** (settings, off by default) change only what an *unnamed*
session is called: instead of the first 60 characters of the first prompt, the
row reads like a title — `Not a fan of opening directory like this`, `For our
favicon create orange brain icon`.

The rules, all of which exist because a real prompt broke the previous
version (`src/web/sessionName.test.ts` pins them):

- **First sentence**, not first N characters. A prompt says what it is about
  and then qualifies it for three more lines.
- **A comma ends the clause only before a conjunction** (`and`, `then`, `but`,
  `so`, `or`, `also`, `plus`). Cutting at every comma named one session `Hey`
  (`hey, can you fix the parser`) and another `Tell me please` — the
  politeness, with the subject dropped. A word-count threshold had the same
  failure with different inputs.
- **Eight words and 48 characters**, whichever comes first: eight words of
  prose fit a row, eight words of flags do not. A single word over the ceiling
  is truncated rather than dropped, since the alternative is an empty name.
- Trailing `,;:-` is removed (it is where the cut happened, not part of the
  name) and the first letter is capitalised, which is what makes a fragment of
  someone's typing read as a title.

## Unsent text survives a reload

The composer used to live only in React state, so a reload cost you it — and
a reload is not rare: the dev server restarts, a stray refresh lands, the page
is reloaded mid-run. A half-written question and a pasted screenshot were both
simply gone. `src/web/drafts.ts` keeps them in `localStorage`, which is the
same promise the restored tab strip already makes.

Drafts are **per session**, keyed by session id, so switching tabs swaps
composers instead of carrying one half-written message into another
conversation. The id and not the file: a session keeps its id across a
reload, while the *file* is not listed until a new session is first prompted
— keying on it would move the draft out from under a composer being typed
into.

Three things this is careful about:

- **Two storage entries, text and images.** The text is rewritten on every
  keystroke and a pasted screenshot is megabytes of base64; one entry would
  re-serialise the images for every character typed.
- **Writes happen in the change handlers, not in an effect.** An effect
  depending on `[key, text]` runs after a tab switch with the NEW key and the
  PREVIOUS session's text still in state, and copies one composer onto the
  other. The restore is the only place the composer is set from outside a user
  action.
- **Quota is finite (~5MB) and screenshots are not.** Staging images evicts
  other sessions' attachments to make room — the ones being attached right now
  are the ones being looked at. If they do not fit even alone, the entry is
  removed rather than left stale, and the composer says so: *"Attached, but
  too large to keep if the page reloads."* They are still attached and still
  send; only the draft is memory-only.

Sending clears both entries. A cap of 16 drafts prunes the oldest, since
nothing else ever reclaims a screenshot staged in a conversation nobody
returns to. `src/web/drafts.test.ts` covers the quota, validation and pruning
paths with a fake `localStorage` that has a settable ceiling.

## Projects

A project IS a cwd. pi already partitions its store by working directory
(`~/.pi/agent/sessions/<encoded-cwd>/`) and every session header carries its
own `cwd`, so pwi models nothing extra: the picker at the top of the session
list swaps which directory's sessions are listed, and `+ New` launches pi in
that directory. The list of directories you care about is a flat array in
`~/.config/pi-web-ide/projects.json`.

`+` opens a folder explorer over the **server's** filesystem
(`src/web/DirectoryPicker.tsx`, fed by `GET /api/browse`). The browser's own
directory input cannot do this job: it enumerates the machine the *browser*
runs on, which is the wrong filesystem the moment the page is opened through
an ssh forward, and it hands back file lists rather than a path. So the server
lists subdirectories — directories only, dotted names sorted last rather than
hidden, a `git` chip on anything holding a `.git`, and already-added
directories marked `added`.

Clicking a row **enters** it; adding is always the explicit footer button on
the directory named in the breadcrumb, so there is no double-click rule and no
ambiguity about what is about to be added. The listing is not sandboxed to any
root, which grants nothing new: pwi binds loopback only and its agents already
run tools against this machine. `addProject` still validates what it is
handed, since the path can also arrive typed.

**The path field also filters.** Text beyond the directory being listed — the
`tra` in `/home/loki/code/tra` — narrows the rows instead of being treated as
a path, which is what typing into a path bar means to anyone who has used a
shell; `~/code` here holds 90 directories, and scrolling to one of them was
the entire cost of the picker. Anything containing a further `/` is a path
being typed, not a name being filtered, so navigation still works unchanged.
The match is case-insensitive and anywhere in the name (`db` finds `ftp-db`),
and Enter takes the exact name if there is one, otherwise the first row shown
— submitting the half-typed text instead would 400 on exactly the input the
filter exists to make cheap. The fragment is derived from the field rather
than kept as its own state, so navigating (which rewrites the field) clears it
by construction. The filtering is local: the listing is already in memory, so
rows narrow on the keystroke and not on a round trip.

**Pinned folders** are the shortcut row under the breadcrumb: the star pins
the directory being listed, a chip jumps back to it, and its `×` unpins.
They live on the SERVER (`~/.config/pi-web-ide/favorites.json`, `/api/favorites`)
and not in `localStorage`, because they are paths on the machine pwi runs on:
a per-origin copy would follow the browser to a machine where those paths mean
nothing, and a second pwi port on the same host would silently get its own
set. Unpinning skips the existence check — a favourite whose directory was
deleted is the one you most need to be able to remove.

A typed or pasted path (`~` included) still navigates for when you already
know where you are going, and an unreadable path leaves the listing you were
browsing alone, showing the OS message (`EACCES`, `ENOENT`) instead.

`×` removes the selected project **from the list only**: the directory and its
sessions stay on disk, and re-adding the path brings all of them back, because
pi's store was keyed by cwd the whole time. The startup project (`PWI_CWD`)
has no `×` — the server seeds it back on every read, so a button for it would
appear to do nothing.

One active project at a time, and a dropdown rather than a list of all of
them, because the 5s poll is then exactly one request. Listing every project's
sessions at once would mean parsing every session file on the machine on every
tick.

### Ordering

Two orders, one button above the list: **Created** (default) and **Last
active**. Each row shows the timestamp it is being sorted by, and its tooltip
carries both, so the order is always explained by what you can see.

The list used to be ordered by the session file's **mtime**, and that was
wrong in a way worth recording. pi appends rows that are not conversation —
`session_info`, `model_change`, `thinking_level_change` — and a bare *resume*
writes some of them. So opening an old session bumped its mtime, which shoved
it to the top of the list and relabelled it "just now" while its message count
sat unchanged. The list reordered itself just from being looked at.

`created` is `session.timestamp` from the file's header, written once and
never touched again. `lastActive` is the timestamp of the last `message`
entry — not the last *line*, which on a resumed session is bookkeeping. mtime
is no longer on the wire at all, because a timestamp that moves without the
conversation has no use in this list.

## Personality

The settings dialog has one field that is not browser-local: it edits
`~/.config/pi-web-ide/personality.md`, extra system-prompt text this server
owns. pi has no personality file and no such setting — the only way to add
text to a system prompt is `--append-system-prompt`, which takes a path and
is read at spawn — so the file is ours, and it lives in the state directory
with everything else this server persists. The dialog names the absolute path
it writes, because a box that silently writes a file somewhere is worse than
no box.

There is no second copy and no template: the field is read from disk every
time the dialog opens, saving replaces the file byte for byte (plus the
trailing newline a text file should have), and an edit made in `$EDITOR`
shows up on the next open. Unsaved edits suppress that reload, since a
refetch mid-typing would throw away the paragraph you just wrote.

Three details that are the feature rather than incidental:

- **A save lands on the next session, not the current one.** Each session is
  its own pi child and its system prompt is built at spawn, so sessions
  already running keep the personality they started with. The status line says
  so instead of implying a live effect.
- **Clearing the box is how you turn the override off.** An empty file is not
  passed to the next spawn at all, so nothing here deletes anything — "empty"
  is a valid state with a documented meaning, and a web UI quietly removing a
  file you wrote is not.
- **The write is atomic.** Temp file plus `rename(2)` in the same directory,
  because `writeFileSync` truncates first: a crash mid-write would otherwise
  leave half a personality on disk for every future session to read. There is
  a 256 KB cap for the same class of reason — a paste accident would otherwise
  ride along in every request.

There is no project-level personality: one file, named in the dialog, for
every session this server starts. `PWI_STATE_DIR` relocates it along with the
rest of this server's state, which is how the test works on a temp directory
instead of your real file.

## Themes

Five palettes — the four Catppuccin flavors, Mocha (default), Macchiato,
Frappé and the light Latte, plus **Claude**, a near-black neutral dark theme
under warm ivory text with Anthropic's clay orange as its accent — from the
settings dialog in the bottom-left corner of the session list.

No component knows a theme exists. Tailwind v4 compiles `bg-neutral-900` to
`background-color: var(--color-neutral-900)`, so `src/web/index.css`
re-points those variables at the active palette and every utility already in
the app follows. The whole feature is one CSS file, one attribute on `<html>`
and `src/web/prefs.ts`; not a single `className` changed, and a further
palette is one palette block plus one entry in that module. Claude is exactly
that: one block of greys sampled off Claude's own chrome (`#141414` chrome,
`#1f1f1f` raised, `#2b2b2b` border, `#383838` hover) plus the four accents
the UI can show, and nothing outside it knows the palette is not a flavor.

Tailwind's numeric scale is therefore read as a ramp of **roles**, not of
brightnesses: `950` backdrop, `900` raised surface, `800`/`700` borders and
buttons, `600` through `100` text from barely-there to body. The roles are
identical in every palette; the direction is not, which is all Latte needs —
`950` is darker than `100` in the four dark palettes and lighter in the
light one, and nothing outside the mapping had to care.

Accents move with the palette too (the working-indicator amber onto peach or
clay, links onto blue/lavender, ANSI tool output onto the terminal palette).
Error panels are a `color-mix` tint of the palette's own red over its own
base rather than a fixed `red-950`, which on a light page would be a black
hole.

The choice is stored in `localStorage` under `pwi:theme` and applied by a
small inline script in `index.html` **before the first paint**: the app sets
the same attribute on mount, but the module graph loads first, which is long
enough to flash a dark window at someone who chose Latte. An unrecognised
stored value matches no palette, falls through to the defaults on `:root` and
is normalised on mount — so that script never needs the list of palettes.

The dialog is a native `<dialog>` opened with `showModal()`, for the focus
trap, the `Escape` binding, the inert page behind it and the top layer (no
z-index to reason about against the session drawer). Its swatches are
rendered inside a `data-theme` subtree of the palette they advertise, so a
preview is the palette itself and no hex value is duplicated outside
`index.css`.

## Settings

One dialog, reached from the bottom-left corner of the session list, holding
everything that is a property of *this browser* rather than of the agent:

| setting | key | default |
| --- | --- | --- |
| theme | `pwi:theme` | `mocha` |
| show thinking | `pwi:showThinking` | on |
| tool calls | `pwi:tools` | `live` |
| short session names | `pwi:shortNames` | off |
| notify when finished | `pwi:notify` | off |

All of them live in `localStorage` via `src/web/prefs.ts`, which validates on
every read — storage is user-writable and outlives any rename, so an unknown
value falls back rather than rendering something broken.

**Show thinking** hides reasoning blocks, streaming and historical, and it
*filters* rather than `display: none`s them: reasoning is routinely the
longest part of a message, and a hidden subtree would still pay for the
markdown render and still turn up in find-in-page. A message that was
nothing but reasoning disappears entirely instead of leaving an empty
`assistant` label behind, and the streaming placeholder waits for real
output for the same reason. The status line still says "Thinking…" while it
happens — that is state, not content, and hiding the transcript of a thought
should not hide the fact that the agent is having one.

**Tool calls** is five-way, because "collapsed" and "hidden" are different
answers to one question and two checkboxes would let you pick both:

- `live` — a call with no result yet is expanded, so a long-running tool
  shows progress without a click, and collapses once it settles. The default,
  and the noisiest: a run of twenty edits turns the pane into a wall of
  arguments while you are waiting for prose.
- `collapsed` — one line per call; click to open. Settled calls already look
  like this, so this only changes the in-flight ones.
- `grouped` — one line per *run* of calls: `Ran 3 commands, read 2 files,
  edited a file ✓`. Click it to list the run, click a call in it to open that
  call. See below.
- `answer` — one line per *turn*: every call, every thought and every
  intermediate paragraph folds into it, and only the prose the turn ended on
  stays. See below.
- `hidden` — tool blocks are filtered out entirely, same mechanism as
  thinking, and a message that was nothing but tool calls disappears with
  them.

The setting reaches calls already on screen, not just the next ones: `open`
is decided when a call mounts, so switching to `collapsed` would otherwise
leave exactly the wall of expanded calls you switched to get rid of. A call
opened by hand stays open until the setting itself moves.

Under `hidden` the status line still reads "Running eval…". That is the same
rule as thinking: the setting hides the *transcript* of the work, never the
fact that work is happening.

**Notify when a run finishes** raises a desktop notification titled with the
session and carrying the first line of the answer, so a long run can be left
alone. Three guards, each for a different kind of wrong:

- **Only in the background.** `document.visibilityState === "visible" &&
  document.hasFocus()` suppresses it: on screen and focused, the status line
  and the tab title already said so, and a notification would be a second
  copy of news you are looking at.
- **Only for a run this page watched.** An `idle` event also arrives right
  after attaching to a session that had already finished, so a per-attachment
  flag is set by the first `text`/`thinking`/`tool_start` (and seeded from
  `isStreaming`, so a mid-stream reattach still counts). Without it, opening
  a tab would notify.
- **Only with real consent.** Off by default and never auto-enabled by
  already having permission: turning it on is what calls
  `requestPermission()`, because the click is the user gesture the prompt
  needs, and a refused prompt leaves the switch off rather than on and
  silently mute. The dialog reads `Notification.permission` at render — the
  browser owns it, it can be revoked from the address bar, and a copy in
  React state would be the stale one.

A failed run notifies too (`Failed: …`), which is the case you least want to
discover an hour later. `tag` is the session file, so a session that finishes
twice replaces its own notification instead of stacking. The preference is
read through a ref inside the SSE handler: making `attach` depend on it would
tear down and rebuild a live `EventSource` every time it was toggled.

### Grouped

`collapsed` fixes the wrong axis. One line per call is still twenty lines,
and twenty lines of `▸ read ✓` is the same wall in a smaller font — it was
measured on a real transcript: 12331px of scroll height became 2452px, five
times shorter, with nothing removed.

A group is a run of consecutive calls, and the run **spans messages**,
because that is the shape of a turn: one agent turn is a dozen one-call
messages in a row. Prose is what ends a run, since prose is what the reader
came for — a paragraph after three calls closes that group and the next call
opens a new one.

Reasoning between two calls collapses *with* the run, even with **Show
thinking** on. With a thought between every pair of calls, a group that broke
on reasoning would be a group of one, which is the wall this mode exists to
fold away. The reasoning is not dropped: expanding the group shows the run in
order, thoughts and calls interleaved exactly as they happened, each call
still openable for its arguments and output.

Three details that are the difference between a summary and a lie:

- **Failures are counted on the collapsed line** (`✗ 1 failed`, and the line
  goes red). A group may hide detail; it may never hide that something went
  wrong.
- **The phrase list is capped at three**, then `+5 more`. A run of forty
  calls across eight tools is a sentence nobody reads, wrapped over two lines
  where the point was to have one.
- **A tool with no phrase still summarises**, as `mcp_fetch ×2`, so a package
  can add a tool without this going stale or — worse — wrong.

While a turn streams there are at most two lines: the calls that have settled
are one group, and the call in flight is the streaming row's own group, which
grows in place instead of adding a line per call. They merge into one the
moment the turn ends.

### Answer only

`grouped` still leaves the shape of a console: a paragraph of "now let me
check X" between every two runs, and the answer somewhere at the bottom of
eight of them. `answer` folds the whole turn instead — one line for
everything the assistant did between two of your messages, then the prose it
ended on. That is how a chat assistant reads, and on a long agent turn it is
the difference between a page of work with an answer in it and an answer with
the work behind one line.

**The answer is found from the END of the turn, not by picking the best
paragraph.** Text blocks (and images, which is how a turn that ends on a
screenshot keeps it) are peeled off the back; everything before them folds.
The model stopping there is what makes it the answer — no heuristic about
length or position could say the same, and any guess would eventually fold
away the thing you were reading. A turn that ends on a tool call therefore
has no answer yet and folds whole, which is exactly the state of a turn that
is still streaming.

A turn ends when someone else speaks: your next message, or a compaction
boundary. Those stay rows of their own — the fold is over the assistant's
work, never over the conversation.

The folded line says `Read 23 files, grepped 3 times, edited 16 files, +3
more ✗ 3 failed`, same summary and same failure count as `grouped`. When the
fold contains no calls at all — a turn that only thought — it says `4 steps`
rather than pretending to have run something. Expanding shows the turn in
order: thoughts, calls, intermediate prose, exactly as it happened.

## Your side of the conversation

What you sent is a **pill**: a rounded card in the reading column, the shape
every current chat client uses for your half of the transcript. It replaced a
full-bleed stripe, which at this measure was a band of slightly different
grey running the whole width of the window — loud about the row, quiet about
the words in it. The pill carries no `USER` label either: nothing else in the
transcript is shaped like it, so the label was a caption on the obvious.

**Attachments go on top of the pill, as squares.** An attachment is an item
in a list here, not content: a screenshot rendered at its own aspect ratio
pushes the question it belongs to off the screen, and a row of mixed shapes
cannot be read as a set. `object-cover` crops to the square instead of
letterboxing, so the middle of the picture — the part that identifies it —
stays visible. Image blocks are pulled to the front of the pill whatever
order they arrived in, because a screenshot is context for the question.

The composer is the same shape and the same rule: one rounded box holding the
staged squares on top, the field under them, and the controls on a row inside
the same border — `+` and the model on the left, `↑` on the right. The
thumbnails used to sit *above* the box and the model selector above that,
which read as three widgets that happened to be adjacent rather than as one
thing you were about to send. The model select is capped at `max-w-44`,
because a box sized to `claude-sonnet-4-5-20250929` pushed the send button
off the row.

**Clicking any thumbnail expands it**, staged or sent, and Escape or a click
on the backdrop closes it. An overlay rather than a new tab because the image
is a base64 data URL: a tab would show a megabyte of address bar, and some
browsers refuse to navigate to one at all. It is a React context rather than
a prop chain — the two places that show an image, a sent message deep in the
transcript and the composer's staging row, have no common parent short of
`Chat`, and threading a callback through `Message`, `Block` and `ToolGroup`
would put an image concern in three components that have none.

## Icons

One set, [Phosphor](https://phosphoricons.com), at 11–16px. Before this the
chrome was Unicode glyphs — `+`, `↑`, `×`, `>_`, `▸`, `☆`, `✓`, `✗` — which
is tempting because it costs nothing and wrong because a glyph is a FONT
choice: each one is drawn by whichever installed face claims it, so the set
never shares a weight, a stroke or an optical size, and `×` sat a pixel high
next to `+` on every machine differently.

Icons are imported per name, so the bundle carries the fifteen in use and not
the library (main bundle 314KB → 350KB). Text stays text: the tool-fold lines
are still `Read 23 files, edited 2 files` in mono with a caret icon, because
the sentence is the content and only the caret is furniture.

## Commit & Push

A split button above the composer: the primary action on the left, the other
seven behind the chevron. An agent session ends with a working tree full of
changes, and the next thing anybody does is commit them — from a browser on
another machine there is no terminal to do it in, and typing `git add -A &&
git commit -m …` on a phone is not the point of having the button.

**Deliberately not a git client.** No staging UI, no hunks, no log, no diff
viewer: that is a real application, and the [terminal](#terminal) covers
everything this does not. What is here is the end of a turn, composed from
four steps applied in one order — branch → commit → push → PR — because
every action anybody asks for is a subset of those four:

| action | branch | commit | push | PR |
| --- | --- | --- | --- | --- |
| Commit & Push | | ✓ | ✓ | |
| Commit | | ✓ | | |
| Push | | | ✓ | |
| Create Branch & Commit | ✓ | ✓ | | |
| Create Branch, Commit & Push | ✓ | ✓ | ✓ | |
| Create Branch | ✓ | | | |
| Commit & Create PR | | ✓ | ✓ | ✓ |
| Create PR | | | | ✓ |

- **It stops at the first failure.** Pushing a branch whose commit failed, or
  opening a PR for a push that did not land, produces a state nobody asked
  for and that the UI would then have to explain. Each step's output comes
  back, so the button can say `2 files changed` rather than "done", and
  `nothing to commit, working tree clean` rather than "failed".
- **No shell, ever.** Every call is `execFile` with an argv array: a commit
  message is arbitrary user text, and through a shell `"; rm -rf ~"` would be
  a commit message that means something else. Branch names are additionally
  checked against `/^[\w./-]+$/` here rather than left to git, whose own
  message for a bad ref name is a wall of rules and the UI has one line.
- **The dialog asks for the two things this host cannot invent**: a commit
  message and a branch name. Actions that need neither (`Push`, `Create PR`)
  run on the click, because a confirmation whose only content is a button is
  not a confirmation.
- **The message is prefilled with the changed file list**, not with a
  generated sentence: the placeholder has to appear instantly and can never
  fail, so it costs a `git status` and nothing else. Leaving it untouched
  means "use it".
- **`Auto-name` writes the real message.** The file list says what was
  touched and nothing about what was done, so the button next to it hands
  the diff to a model and puts the answer in the box, where it is still
  editable. It is a separate `pi -p --no-session` process, not the session
  on screen: naming a commit must not append a turn to the transcript you
  are reading, inherit that session's tools, or queue behind a run that is
  still going. Everything optional is off — no tools, no extensions, no
  skills, no prompt templates, no context files, no thinking — because the
  job is one sentence about a diff that is already in the prompt: 4.9s
  instead of 22.5s on this repo's own 20 kB diff, which is also the cap on
  how much patch is sent. `PWI_NAMING_MODEL` picks the model; unset means
  pi's default.
- **`Auto-name commits` in the menu skips the dialog entirely.** Toggled on,
  `Commit & Push` is one click: the message is written by the model and the
  branch (for the `Create Branch` actions) is the dated `pwi/` suggestion.
  Off by default, remembered per browser, and flipped where the actions it
  changes are rather than in the settings dialog. When the model cannot be
  reached the dialog opens after all, with the reason in it — a name that
  could not be written is a reason to type one, never a reason to commit
  something the model did not choose.
- **A first push sets its own upstream** (`--set-upstream <remote> <branch>`),
  which is the difference between `Push` working and `Push` printing git's
  suggestion for the command you should have run.
- **`Create PR` needs `gh`**, and `Push` needs a remote. Both are shown
  disabled with the reason in the tooltip rather than hidden, so the menu
  does not change shape between repositories.

The state (branch, changed count, upstream) is read fresh on open rather than
polled: the tree changes constantly while an agent works in it, and a count
that is thirty seconds stale is worse than one fetched when you looked. The
button hides itself entirely outside a git repository.

A **jump to latest** button appears next to it whenever the transcript is
scrolled away from the bottom, and only then: a button that does nothing is
worse than no button. It reads from state, while the follow-the-stream logic
keeps using a ref — that one is read on every frame of a stream, and a
re-render per scroll event would cost more than the button is worth.

## Packages

A pi package bundles extensions, skills, prompt templates and themes, and pi
already owns installing them: `packages` in `~/.pi/agent/settings.json` is
the desired state, and pi installs anything missing at startup. So this
screen is a view over that array on this machine.

**One row per package.** Each row is the installed version, with `pinned`,
`filtered` and `off` where they apply, and update/remove on hover.

**Search is the npm gallery** — packages carrying the `pi-package` keyword —
asked through this server, so there is no third origin to allow and npm
learns nothing about who is browsing. Git-only packages cannot appear there,
which is what **Add by source** is for. The install dialog shows the
resolved, *pinned* source, what the package contains, its repository and
preview, and one sentence that does not go away: packages run with full
system access.

**A session open at install time cannot see the package.** pi reads
extensions, skills and prompt templates when a child starts, so the server
records which package epoch each session was spawned under and the chat says
so, with a restart button. The restart disposes the child and reopens from
the session file: same id, same transcript, new process. It is refused
mid-turn, because a restart there loses the turn — and for the same reason a
successful install discards prewarmed spares, so the next `+ New` is not
stale before anybody types.

Two kinds of package are deliberately outside this screen. A project's own
`.pi/settings.json` is committed and git is its sync, so it is listed
read-only under "This project". And pi itself is updated with its own button,
never automatically: extensions declare pi's packages as peer dependencies,
so version skew is how a package works on one box and throws on another.

## Terminal

`Ctrl+\`` (or the terminal button in the tab strip) splits a shell in beside
the chat, on a draggable divider. It is the other half of the work: the agent
changes the tests, and then somebody has to run them, read the log, look at
`git diff`. Over an ssh forward from a phone or from another machine there is
no terminal to switch to, which is exactly when that matters.

**A real PTY**, through a native binding (`@homebridge/node-pty-prebuilt-multiarch`
— the prebuilt fork, because the stock `node-pty` ships no Linux binaries and
would need a compiler on every machine this gets deployed to, Pi included).
Piping a `bash` would have been dependency-free and useless: no job control,
no `clear`, no line editing, no `stty size`, and `vim`, `htop` and every
progress bar broken.

The process lives on the server (`terminals.ts`), the browser is a view onto
it, and that split is the whole design:

- **Hiding the pane does not kill anything.** Closing the browser does not
  either. A build you started keeps going, and reattaching replays the last
  256KB of output, so a reload lands you back where you were rather than in
  front of a blank pane. Closing a split or a tab is the only thing that ends
  a shell — SIGHUP, the signal closing a terminal window sends, so the shell
  tells its children the terminal went away.
- **Shells are shared, not owned.** Two windows on the same project attach to
  the same shells and see the same screens, the tmux-attach model.
- **The size is real, and per shell.** Each PTY is resized from its own pane,
  so `tput cols` tracks the divider and full-screen programs fill it — two
  splits of one project are different widths at the same time. Nonsense sizes
  are dropped, because a pane measured mid-layout reports 0 columns and a
  0-column PTY wedges the shell permanently.
- **Sixteen shells, across all projects.** Terminals are never swept — an
  idle one may be holding a finished build's output, and a busy one must not
  be reaped at all — so the only bound is a cap, and past it the pane says so
  instead of forking until the machine stops.

### Tabs and splits

`+` opens a terminal tab, `split` puts another shell beside the focused one,
and the `│`/`─` button flips that tab between side-by-side and stacked. Every
divider drags. Closing a split (the `×` on the pane) kills that shell; a tab
closes with its last split.

**The shells are the server's and the arrangement is the client's**
(`termLayout.ts`), which is what makes a shell survive being moved, hidden
and restored. The layout is per project in `localStorage`, and on load it is
`reconcile`d against the server's terminal list — in both directions, because
both are real: stored ids the server no longer has would render panes wired
to nothing, and shells the layout does not mention would be unreachable, with
no pane referencing them and so nothing able to close them either.

**One level of splits per tab, not a tree.** A split tree is what tmux and
every editor grew into, and it brings a whole vocabulary with it: focus
traversal, promoting a pane when its sibling closes, serialising nested
sizes. A row-or-column per tab covers "server here, tests there, shell to
poke around in", and the tab strip is the dimension a tree would otherwise
be for. Real nesting is tmux's job, and tmux is one command away in any of
these panes.

Three details that are each a bug avoided:

- **A split appears next to what you split**, not at the end of the row —
  inserted after the focused pane, because that is the only placement that
  matches the gesture.
- **Focus is per tab.** Switching away and back lands on the pane you left;
  a single focus field would jump to the first split of every tab you
  returned to.
- **A divider moves only its own pair.** The two panes either side trade
  percentages and their total is conserved, so dragging one divider never
  shifts a pane at the other end of the tab.

**WebSocket, not SSE.** A terminal is the one bidirectional surface in the
app, so it is the one place with a second protocol:
`/api/terminal/socket?id=…`, JSON both ways (`input`/`resize` up,
`data`/`exit` down). Creating a shell is the `POST /api/terminals` beside it
and never the socket — a socket that created its own would mint a second
shell on every reconnect, leaving the layout pointing at the first. A resize
travels the same ordered channel as the keystrokes around it, because over
two channels a redraw can land before the size that caused it. The dev server
needs `ws: true` on its `/api` proxy, or the upgrade is answered with a 200
and the terminal connects, says nothing, and closes.

xterm.js is loaded on demand like KaTeX (332KB), so a session that never
opens the pane never downloads it; its 5KB stylesheet is eager, because a
terminal painting before its CSS lands is a column of scrambled characters.
The colors are read out of the active theme at mount — xterm paints to a
canvas and cannot resolve a CSS variable, so without that it would be the one
panel ignoring the theme.

Below the narrow breakpoint the terminal is not a split but the whole view:
a 40% chat column on a phone is two words a line. The width is a percentage
of the track and not pixels, so the same browser used at 1280 and at 2560
keeps the proportion instead of restoring a pane that does not fit.

**This is shell access on the port.** It is not a new exposure — the agent
already runs tools unattended on this machine, which is strictly more than a
shell — but it is a much more obvious one, so: loopback only, forward it, see
[Security](#security).

## Math

`$…$` and `$$…$$` (and `\(…\)` / `\[…\]`) render through KaTeX. This was a
non-goal until a message about accelerometer offsets arrived and the pane
showed `$$a_{\text{sensor}} = a_{\text{body}} + \underbrace{...` with half of
it italicised — because markdown had eaten it.

**Which is the actual problem: the delimiters are fine, markdown is not.**
`a_{\text{sensor}}` contains three underscores, so the parser resolves them
as emphasis and hands the renderer `<em>` tags wrapped around fragments of
TeX. Nothing downstream can reassemble that; the source is gone. And
markdown-to-jsx has no way to add an inline rule — `renderRule` overrides
rules that exist, it cannot introduce one — so math cannot be parsed in the
same pass either.

So math comes out **before** the parse (`math.ts`), each expression replaced
by a `\uE000<index>\uE001` placeholder: private-use codepoints, which no
markdown rule touches and no real prose contains. `renderRule` then
substitutes the rendered expressions back into the parsed `text` nodes. That
ordering is what makes math work inside a list item, a table cell or a
heading — splitting the document into math and non-math segments, the obvious
alternative, would break every markdown block it cut through.

Four things the scanner has to get right, each of which is a real message:

- **Money is not math.** "It costs $5 and $10 more" is the sentence every
  naive implementation renders as an expression. TeX never opens with
  whitespace and never closes after it, so both inner edges must be
  non-space; a newline inside inline math is rejected for the same reason.
- **Code is verbatim.** Fences and inline spans are skipped, not scanned:
  `awk '{print $1}'` and `$HOME` are exactly what would otherwise be read as
  math, in the one kind of text that must survive character for character.
- **An unterminated delimiter is text.** A streamed message ends
  mid-expression on nearly every delta, and guessing would make the answer
  flicker between prose and math as it arrives.
- **`\$` stays escaped.** Markdown is what resolves it to a dollar sign;
  unescaping in the scanner would hand the parser a live delimiter.

KaTeX's **JavaScript is loaded on demand** — 259KB, more than half this app,
and most conversations have no math at all — so the first expression on the
page pays for it and a session without math never downloads it. Until it
lands, the TeX source shows in monospace: it is what the author wrote, it is
readable, and it does not reflow the paragraph when the rendering replaces
it. The 23KB stylesheet is eager, because CSS arriving with the JavaScript
would render the first expression unpositioned for a frame — which looks like
scrambled math rather than like math arriving. Font faces are fetched only
when a glyph uses one.

`throwOnError` is off: a model writes `\undebrace` eventually, and KaTeX's
own error rendering (the source, in red) names what broke instead of throwing
inside the transcript and taking the message down with it.

## Reading measure

Prose is clamped to a reading column; code, tool output, tables and images
are not. A transcript that fills a 2560px window puts ~200 characters on a
line — about three times what every authority converges on (Bringhurst
45–75 with 66 "ideal", WCAG 1.4.8 AAA ≤80, Tailwind's `prose` 65ch), and
long lines are expensive at the *return sweep*: past ~80 characters the eye
starts landing on the wrong next line.

Two tracks, one left edge:

| track | width | what lives there |
| --- | --- | --- |
| measure | `--measure: 38rem` (~66 characters, 608px) | paragraphs, lists, headings, quotes, user text, thinking, error text, role labels, the status line, the composer |
| content | `--content-max: 68rem` (1088px) | code blocks, tool output, tables, images |

The measure used to sit flush left inside the content track. That kept every
left edge aligned and left the reading column hugging the left of the pane
with a third of the window empty beside it — the wider the window, the more
it read as a layout bug rather than as a measure. So the measure is
**centred** (`margin-inline: auto`), and the scanned track starts on the
centred column's left edge and grows **rightward** into the slack
(`.chat-wide`, `margin-inline-start: max(0px, (100% - var(--measure)) / 2)`
— the same offset `auto` computes, so the two agree by construction rather
than by a matching magic number).

Centring each scanned box instead was the first attempt and it was worse: a
short table or a one-line tool summary centred *itself*, so its text began
150px right of the paragraph above it and nothing in the transcript had a
common left edge. Left edges are what the eye returns to, so they are the
thing worth keeping aligned; the extra width a diff needs comes out of the
right-hand slack, where there is nothing to disturb.

`--measure` is 608px and not 66 *characters* of the actual font because `ch`
is the width of a **zero**, which in a proportional face is much wider than
the average character (0.64em vs 0.52em in the default UI sans): `68ch`
measured out at **84** real characters on screen. The number came from
Bringhurst's copyfitting check — render a paragraph and count the characters
on a line — and should be re-checked if the body font ever changes.

It is `rem` and no longer `ch` because **`ch` resolves against the font of
the element using it**. That was invisible while the column was flush left
and became a bug the moment it was centred: the 10px `ASSISTANT` label
computed its own 56ch as 280px, centred that, and ended up 125px to the right
of the paragraph it labelled. `rem` is the same width in every element and
still tracks the reader's own font size, which is the part that matters.

Prose is 17px at `line-height: 1.6` (16px is the floor, and line height rises
with the measure); code is 15px monospace at 1.5, which is the optical match.
The measure is applied **per element** rather than to a wrapper, which is
what lets a code block or table inside a paragraph flow break out to the full
track instead of being trapped in 66 characters — a diff squeezed into the
prose column is unreadable in a way a long line is not. Code blocks scroll
horizontally rather than soft-wrap (soft-wrapping destroys the visual
structure PEP 8 keeps its own limit for); ANSI tool output still wraps,
because it is log text being scanned, not source being read.

The track is expressed as `padding-inline: max(1rem, (100% - 68rem) / 2)` on
the row rather than as a nested centred box, so a row keeps its full-bleed
background and rule — the compaction divider, a user message's pill — while
its contents sit in the column, and no component needs a wrapper div to say
so. Below ~1100px the `max()` collapses to a plain 1rem gutter, and the prose
stays centred in whatever is left, so narrowing the window closes the margins
evenly instead of pulling the column to one side.

The composer is in the **measure**, sharing both edges with the answer above
it, and there is no rule between them. It used to span the full content track
with a `border-t` across the pane, which drew a second panel docked under the
chat: a wide input under narrow prose reads as a different surface, and a
separator says so out loud. The status line, context meter and git button are
in the same column for the same reason — everything from the last paragraph
to the send button now shares one pair of edges.

There is no full-width toggle. The leftover space on a wide screen is the
point; the obvious thing to spend it on later is a right-hand rail for the
tool-call timeline (the Stripe docs pattern), not wider prose.

## `+ New` is instant because a session is already warm

Creating a session is one `pi` spawn, and that spawn pays for package,
extension and skill discovery before it answers anything — the couple of
seconds `+ New` used to sit there for, none of which can be made faster *on*
the click. So it is paid before the click: the server keeps **one unclaimed,
fully-ready session** for the project on screen, and `+ New` claims it, which
turns the wait into a map lookup.

What makes this cheap rather than clever is that a child that has never been
prompted writes **no messages** to its JSONL. So a spare is invisible to the
session list, invisible to the TUI, and free to throw away.

The rules around it are all about never handing somebody a session they did not
ask for:

- **One spare, for the project being looked at.** The warm is triggered by the
  session-list poll, which is the only continuous signal of which project is
  selected — and which also resets the spare's idle clock, so it survives while
  that page is open and ages out through the ordinary 30-minute sweep once it is
  closed. Switching projects disposes the old spare.
- **Only the plain create path claims one.** Resuming needs *that* file, and a
  create carrying an explicit model is not what the spare booted with.
- **A spare that became wrong is dropped, not handed over.** Changing the
  default model discards spares, including one mid-spawn: it would otherwise
  quietly serve the model you just changed away from.
- **A click mid-spawn joins the spawn** instead of starting a second one. It
  pays the old price, which is the price either way, rather than holding two
  children.

`PWI_PREWARM=0` turns it off and gives back the one idle child.

## Two invariants

1. **Never evict a streaming session, attached or not.** "No client attached"
   must not imply "idle" — a detached session that is still working is exactly
   the case that must keep running. Closing a tab must not kill the run.
   Eviction requires `no subscribers && !isStreaming && idle > 30min`, and is
   lossless anyway since everything is on disk.

2. **The server owns the message list.** Clients get a full snapshot on attach
   and apply deltas after; on any doubt they refetch. The session JSONL is the
   source of truth — we never build a second one in React and then debug why
   they disagree. Streaming text accumulates server-side, so a mid-stream
   reattach sees the partial message rather than a hole.

Client disconnect never aborts. `abort()` is only ever an explicit user action.

## Crash policy

Three layers, decreasing confidence:

1. **try/catch around every prompt** (in `registry.ts`) — the workhorse.
   Provider 400s, auth failures, throwing tools, context overflow. Marks one
   conversation errored, surfaces it over that session's SSE, server
   unaffected. Under RPC this layer got cheaper: a child that dies takes its
   own session with it and nothing else.
2. **`unhandledRejection` → log and survive.** These almost always originate in
   one session. Node has crashed the process on these since v15, so surviving
   is opt-in.
3. **`uncaughtException` → log, mark degraded, keep serving.** Node's guidance
   is to exit, and that guidance is correct in general. The reason to stay up
   was the absence of a supervisor: on a personal tool, exiting means every
   other conversation dies for one bug. `deploy/` supplies that supervisor, so
   **on a machine running the systemd unit this should be `process.exit(1)`** —
   `Restart=always` plus on-disk sessions makes restarting strictly better than
   limping.

The real safety net is persistence, not the handlers: conversation state is
pi's own JSONL, which makes all three layers optimizations rather than
load-bearing.

## Four things found the hard way

All four are documented in `agent.ts` where they bite.

**A failed turn does not throw.** pi reports provider errors (401s, quota,
overload) as an assistant message with `stopReason: "error"`, empty content,
and `errorMessage` set. The command resolves normally. Without an explicit
branch on that stop reason the UI renders a blank assistant message and never
learns anything went wrong — the exact silent failure this design was supposed
to prevent. Verified against a real 401.

**`agent_end` is not the idle signal.** A run can end and then continue: a
retry, a compaction retry or a queued message all follow one, and the
`messages` field it carries describes only the run that just ended, so
assigning it truncates the transcript. `agent_settled` is the frame that means
pi will not continue on its own, and it is the only thing that puts a session
back to idle. The exception is a prompt pi handled locally, which produces no
agent frames at all — and no "the agent was not invoked" field either, so the
absence of `agent_start` is timed instead (1.5s).

**Split stdout on raw `0x0A` bytes, not on decoded strings.** A frame can be a
megabyte of UTF-8 arriving in arbitrary pieces; decoding each piece
independently corrupts any multi-byte character straddling a chunk boundary.
`0x0A` never appears inside a multi-byte UTF-8 sequence, so splitting first and
decoding whole lines is the only safe order.

**`extension_ui_request` carries two unrelated things.** The display-only
methods — `setStatus`, `setWidget`, `setTitle`, `set_editor_text` — expect no
response and are dropped, because there is no status line or widget rail here
to render them in; `notify` is the exception, and it lands as a notice,
because it is the only output a locally handled command produces. The
blocking ones (`confirm`, `input`, `select`, `editor`) are the trap: left
unanswered they stall the extension that asked, which from the browser is
indistinguishable from a hung agent. They are put to the user; see
**Questions** below.

## Questions

The `ask` tool and an extension's `confirm` and `select`: all of them arrive
as one blocking `extension_ui_request`, and pi waits inside the tool call
until it is answered. pwi used to **cancel** every one of them, on the
reasoning that answering on the user's behalf is the one thing here that could
do real damage. It was the wrong conclusion from a correct premise: the third
option is to ask the user, which is what the frame was for. The old behavior
failed the call with `Ask tool was cancelled by the user` and threw away the
question — the agent's actual blocker — leaving an error where a decision
should have been.

So the question is rendered in the transcript, under the work that led to it:

- `select` — one button per option, with pi's positional `optionDetails`
  descriptions underneath. `Other (type your own)` is one of pi's own
  options, and picking it makes pi send the follow-up `editor` request, which
  renders as the field.
- `confirm` — Yes / No, answered as `{ confirmed }`.
- `input` / `editor` — a field, prefilled with pi's `value`. Enter answers a
  one-line `input`; `editor` is multi-line, so there it is Ctrl+Enter.
- **Cancel** stays, and it is not a close button: it sends a real
  cancellation, which fails the tool call and lets the turn end. A question
  you do not want to answer needs an exit that is not "abort the turn".

Four details, each of which was a bug first:

- **The answer carries pi's request id**, and the server checks it against
  the question it is actually waiting on. A click and a timeout cross
  routinely; without the check, the answer to the question you saw would be
  delivered to the one pi asked next. A stale id is a `409`, and the client
  refetches instead of showing an error.
- **The question is in the snapshot, not only in the event.** The agent stays
  blocked across a reload, and a question that lived in an event stream would
  leave the session waiting on a dialog no page can show any more.
- **It is not a modal.** A modal would have to be dismissable to be honest
  about the agent still waiting — and a dismissed question is a stalled
  session with nothing on screen saying why.
- **pi's titles are TUI text.** The `editor` that follows a picker's "Other"
  carries the whole rendered picker as its title — question, every option,
  every description, `Enter your response:` — with Nerd Font radio glyphs in
  front of the options. Those glyphs are private-use codepoints that mean
  something only to a font the terminal has, so they are stripped, and the
  title is rendered as the multi-line text it is rather than as a label.

A question also raises a desktop notification when the tab is in the
background, under the same rules as a finished run: it is the one event where
nothing moves until you come back.


## Multiple machines

There is one pwi per machine — `local`, `orangepi`, `tg` — each running its
own systemd user service, each bound to `127.0.0.1`, each serving its own
host's projects with that host's own credentials. To work on another machine,
open that machine's pwi:

```bash
ssh -L 8890:localhost:8890 orangepi     # then open http://127.0.0.1:8890
```

or put it on a tailnet with `tailscale serve --bg 8890` on that host and open
`https://opi.tail.ts.net`. The remote stays bound to loopback either way; the
tailnet form also gets you HTTP/2, which matters for a page holding an event
stream plus a few terminal sockets.

**pwi used to manage this itself** — a machine list, a supervised `ssh -L`
child per host with a capped backoff ladder, a reachability poll, a pinned
package manifest reconciled from a hub, and `PWI_HUB_ORIGINS` so a remote
would answer another page's cross-origin requests. It was ~2000 lines and it
was the wrong shape: nothing about a session crosses a host boundary anyway,
since the agent stays where the code and the credentials are. All of that
machinery existed to render one merged sidebar over an arrangement that
already worked. A shell command you type when you want it does the same job.

What that buys, beyond the deleted code:

- **No cross-origin surface at all.** Same-origin is the whole policy. There
  is no CORS in the server, and no configuration that can let another page
  start an agent run here — which is what `PWI_HUB_ORIGINS` was.
- **No single point of failure.** There is no hub to be down, and no machine
  whose being asleep is a state something else has to track.
- **Each host owns its credentials.** `~/.pi/agent/auth.json` never leaves the
  machine it was created on.
- **The agent runs where the code is.** Sessions are partitioned by cwd, and a
  cwd only means something on the machine that has it.

Per-project state — the tab strip, the terminal layout — is keyed by
directory alone (`pwi:tabs:/home/…`), since a pwi only ever serves its own
machine's paths.

The cost is a browser tab per machine instead of a dropdown, and keeping pi
and pwi current on each box yourself. `pi install <source>@<pin>` on each
machine is the sync; pinning is still worth doing, so a rebuilt box gets the
code that was working rather than whatever published since.

## Deployment

`deploy/` installs pi-web-ide as a **systemd user service** on one machine:

```
deploy/pi-web-ide.service      systemd user unit: pnpm start, Restart=always, journald
deploy/pi-web-ide.env.example  template for ~/.config/pi-web-ide/env
deploy/install.sh              idempotent installer, no sudo; --dry-run prints the plan
```

```bash
pnpm build && ./deploy/install.sh
loginctl enable-linger $USER          # once per machine; install.sh checks
journalctl --user -u pi-web-ide -f
```

A *user* unit, not a system unit, because the process holds the same provider
credentials the interactive agent uses and must run as the human who owns them.
A system unit would need a service account, a copy of those credentials, and a
policy for who may reach the socket — all of it solving a problem we do not
have.

Four details that are easy to get wrong:

- **Linger is the whole point.** Without `enable-linger`, the user manager is
  torn down when your last session ends, so the service dies the moment you log
  out of ssh — precisely when you wanted the agent to keep working.
- **systemd user units do not source your shell profile.** The inherited PATH
  usually omits the directory `pi` lives in and any fnm/nvm shim (where
  `node` and `pnpm` live). The unit therefore execs through a login shell —
  `/usr/bin/env /bin/bash -lc "exec pnpm start"` — which picks both up from the
  profile you already maintain instead of pinning a node version into a unit
  file. `exec` is load-bearing: without it systemd supervises the shell and
  `SIGTERM` never reaches the server. Set `PWI_PI_BIN` if you would rather not
  depend on the profile.
- **The unit adds no network exposure of its own.** No bind-address knob exists
  to set by accident — `index.ts` passes the literal `127.0.0.1` to `listen()`.
  There is deliberately no `IPAddressAllow=`/`PrivateNetwork=` either: the pi
  children live in this cgroup and must reach provider APIs, so such a rule
  would be inert or would break the agent.
- **Crashes exit under systemd and survive without it.** An
  `uncaughtException` under a supervisor is `process.exit(1)`; the same
  exception under `pnpm dev` marks the process `degraded` on `/api/health`
  and keeps every other conversation alive, because nothing would restart
  it. The switch is `INVOCATION_ID`, which systemd sets for every unit it
  starts, so there is no flag to keep in step with the unit. Note what the
  exit code does and does not do: the unit is `Restart=always`, so any exit
  is restarted and the code is not what brings pwi back. It is what makes
  the crash a *failure* in journald and `systemctl status` rather than a
  quiet restart, which is the difference between noticing and not.

`install.sh` refuses to run where `systemctl --user` is unavailable — plain WSL
without `systemd=true` in `/etc/wsl.conf`, or a container — and prints the
`setsid nohup` command to run the server by hand instead of reporting a success
it did not achieve. `--dry-run` prints every file it would write and every
`systemctl` command it would run, and changes nothing.

## Security

pi reads `~/.pi/agent/auth.json` and `~/.pi/agent/provider-keys.json`, so
provider credentials are in the child processes pwi spawns, on the machine
pwi runs on. The server binds `127.0.0.1` only. For remote access forward the
port yourself (`ssh -L`, key auth) or use `tailscale serve`, which gives the
loopback port a tailnet HTTPS name without changing the bind; never a
bind-address change. Nothing is proxied between hosts: each machine's pwi is
reached at its own origin, so the only credentials in play are the ssh key or
the tailnet identity you already use, and each host's `auth.json` stays on
that host.

**Same-origin is the whole policy.** pwi answers no cross-origin request —
there is no CORS in the server and nothing to configure that would add one —
and the terminal's WebSocket upgrade checks the same rule, since CORS would
not have covered it anyway. An earlier version had `PWI_HUB_ORIGINS`, which
let a named origin drive this pwi from another machine's page; it was the
CSRF boundary and it is gone with the feature that needed it.

The children run their tools unattended (see the non-goals): pi has no
approval gate, and a browser has no terminal to answer one on. pwi is a tool
for driving an agent over code you own, on a host you control, and it should
be deployed on that basis. A blocking question an extension does raise still
renders as a [question](#questions) — at the cost that a detached run stops at
it until somebody opens the page.

The [terminal](#terminal) is an interactive login shell on the same port, and
it makes that trust boundary impossible to misread: whoever reaches this port
has your shell. It is not a new capability — an agent running tools
unattended is strictly more — but treat the port accordingly.

## History

Forked from omp-web-ide@omp-final, which ran on the omp agent.
