# pi-web-ide (pwi)

A thin web UI for the **pi** coding agent.
Chat sessions, files, diffs and terminals open as tabs in one or two columns,
with a session list, file explorer, source control, packages and stats in the
activity bar.

pwi does not link an agent SDK: it spawns `pi --mode rpc` per session and
speaks JSONL over stdio, so pi is a binary dependency, not an npm one.
Conversation state stays in pi's own session files under `~/.pi/agent/sessions`.

## Quick start

Requires Node ≥ 22.19, pnpm, and `pi` on `PATH`. `tmux` is optional (terminals
then survive a server restart); `gh` is optional (enables "Create PR").

```bash
pnpm install
pnpm dev                     # built UI + API :8890, hot-reload UI :5480
pnpm build && pnpm start     # single process, serves dist/ itself
pnpm typecheck               # must pass; includes scripts/check-ui.sh
pnpm deadcode                # unused files/exports/dependencies, including a production-only pass
```

`pnpm dev` builds `dist/`, then starts a backend on :8890 serving that built
UI, plus Vite on :5480 for hot reload. Both UIs use the same backend. No
systemd service or separate `pnpm start` is needed.

Starting production pwi while an older pwi holds the port stops the old one
and takes over; running sessions are adopted, not killed. Anything else on
the port is left alone and startup fails. Dev disables takeover by default
(`PWI_TAKEOVER=0`): it must not fight a systemd service that restarts after
being signalled. Stop an existing dev runner before starting another one.

## Configuration

| variable | meaning | default |
| --- | --- | --- |
| `PWI_CWD` | starting project (or pass it as the first argument) | process cwd |
| `PWI_PORT` | server port | `8890` |
| `PWI_VITE_PORT` | dev server port | `5480` |
| `PWI_MODEL` | startup model, `provider/id` | pi's default |
| `PWI_PI_BIN` | path to the pi binary | `pi` on `PATH` |
| `PWI_NAMING_MODEL` | fallback for commit/session naming unless selected in Settings | `openai-codex/gpt-6.1-sol` |
| `PWI_STATE_DIR` | pwi's own state (projects, favorites, personality) | `~/.config/pi-web-ide` |
| `PWI_PREWARM` | `0` disables the pre-spawned session behind `+ New` | on |
| `PWI_TAKEOVER` | `0` fails instead of taking over the port | on |
| `PWI_PACKAGES_TIMEOUT_MS` | limit for one `pi install/remove/update` | `300000` |
| `PWI_SEARCH_CACHE_MS` | npm package gallery cache lifetime | `600000` |

Settings > Automatic actions selects separate models for commit naming, session naming,
compaction and SoL-Pi log reduction. All default to `openai-codex/gpt-6.1-sol`,
independently of the chat model. Compaction and reducer support applies to newly
started sessions; trusted project SoL-Pi settings can override the reducer.

## Features

- **Sessions**: tabs restored on reload, split columns, full-text search,
  rename or auto-name, fork from any answer, drafts kept across reloads.
- **Chat**: image paste/drop (click one to expand it across the window
  while the composer stays usable, so you can describe what you see),
  file uploads, slash-command picker, thinking
  level, context meter, KaTeX math, answers to `ask`/`confirm`/`select`
  questions, desktop notification when a run finishes.
- **Files**: explorer, CodeMirror editor, conflict-safe saves (409 when the
  file changed on disk), deletes go to the Trash.
- **Git**: source control view, diffs with per-hunk keep/revert, and one
  button for commit / push / branch / PR with an optional model-written
  message.
- **Terminal**: real PTYs with tabs and splits, shared across windows, kept
  alive through tmux across server restarts.
- **Stats**: provider/model filters, ChatGPT and Anthropic subscription usage,
  and per-model comparisons of answer times, tokens, tools, estimated cost,
  errors and aborts; historical sessions are included.
- **Packages**: browse, install, update and remove pi packages.
- **Settings**: themes (Catppuccin, Claude), user-message folding, and a
  personality prompt appended to every new session.

Runs survive closing the tab and restarting the server: pi children are
detached and re-adopted on startup.

## Non-goals

- No multi-user, no plugin system of pwi's own (pi packages cover it).
- No approval gate: pi has none, so tools run unattended.
- No session tree, no tab reordering, no nested terminal splits.
- No central gateway across machines (see below).

## Architecture

```text
src/shared/types.ts       wire contract, zero imports
src/server/agent.ts       the RPC boundary: the only file that spawns or speaks to pi
src/server/registry.ts    session cache + server-authoritative message state
src/server/index.ts       the process: startup, static client, terminal WebSocket, shutdown
src/server/app.ts         the HTTP API (Hono): origin/host guard, body limit, error shape
src/server/routes/        one module per area: sessions, files, git, packages, terminals, system
src/server/sessions.ts    session list, read from ~/.pi/agent/sessions
src/server/files.ts       project file access; the path check is a trust boundary
src/server/git.ts         git status/log/diff and actions; argv only, no shell
src/server/terminals.ts   PTYs, optionally inside tmux
src/server/…              projects, models, packages, stats, usage, fleet, takeover
src/web/                  React UI; UI rules in docs/ui.md
```

Design decisions and the reasoning behind them are in
[docs/design.md](docs/design.md); pi's RPC behavior is in
[docs/pi-facts.md](docs/pi-facts.md).

## Multiple machines

Each machine runs its own pwi, bound to `127.0.0.1`, serving that machine's
projects with that machine's credentials. Reach another machine's pwi over
Tailscale:

```bash
tailscale serve --bg --http=8890 http://127.0.0.1:8890   # once, on that host
# then open http://<host>.<tailnet>.ts.net:8890/
```

The Fleet page lists every tailnet machine with its link, a shell on it, and a
Start button that starts the service and sets up the serve.

### Why Tailscale, not SSH

Decided after weighing the alternatives; re-read this before reopening it.
Tailscale does two jobs here:

- **The network.** Every machine is reachable from anywhere, including ones
  behind a home router. SSH needs this too, so it stays either way.
- **`tailscale serve`.** Each loopback-bound pwi gets a fixed link that works
  from any tailnet device, phone included, with nothing running on the
  viewing side.

Rejected:

- **One pwi driving every machine's pi over SSH.** Spawning `ssh host pi` in
  `agent.ts` is easy, but the explorer, editor, git, sessions, search, stats,
  terminals and packages all read the local disk. Each would need a remote
  version: most of the app.
- **SSH tunnels (`ssh -L`) instead of `tailscale serve`.** Something has to
  keep each tunnel alive, and the link only works on the computer holding it.
  pwi once managed tunnels itself (~2000 lines: a machine list, supervised
  `ssh -L` children, a hub with cross-origin access) and deleted it.

What this buys: no cross-origin surface at all, no hub to be down, each host's
`~/.pi/agent/auth.json` stays on that host, and the agent runs where the code
is. The cost is a browser tab per machine and keeping pi and pwi current on
each box yourself.

Tunnels still make sense for one case: a machine you can SSH into that is not
on the tailnet. Add that for that machine only.

## Deployment

`deploy/` installs pwi as a systemd **user** service (it must run as the user
who owns the pi credentials):

```bash
pnpm build && ./deploy/install.sh     # idempotent, no sudo; --dry-run prints the plan
loginctl enable-linger $USER          # once per machine, or it dies on logout
journalctl --user -u pi-web-ide -f
```

Settings go in `~/.config/pi-web-ide/env` (template:
`deploy/pi-web-ide.env.example`). The unit uses `KillMode=process` so a restart
does not kill running pi children, and runs through a login shell so `node`
and `pi` are on `PATH`. `install.sh` refuses to run without `systemctl --user`
(e.g. WSL without systemd) and prints a manual command instead.

## Security

- The server binds `127.0.0.1` only; there is no bind-address option. Use
  `tailscale serve` for remote access.
- Same-origin only: a foreign `Origin`, or a `Host` that is not loopback or a
  tailnet name, gets a 403. There is no CORS.
- Whoever reaches the port has your shell (the terminal) and an agent running
  tools unattended with your provider credentials. Deploy it only on hosts you
  control, for code you own.

## History

Forked from omp-web-ide@omp-final, which ran on the omp agent.
