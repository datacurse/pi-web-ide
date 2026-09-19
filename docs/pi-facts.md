# pi facts

Probe results for Phase 0 of the pi-web-ide spec. Every later phase cites this file
instead of re-deriving the behaviour.

- **pi version:** `0.85.1`
- **Probed on:** 2026-09-19, Linux (WSL2), node v24.21.0
- **Probe method:** `pi --mode rpc` child driven over stdin/stdout by a throwaway
  JSONL harness; scratch projects under `/tmp/pi-probe*`; scratch agent home via
  `PI_CODING_AGENT_DIR=/tmp/pi-agentdir`.

---

## 0.0 Credentials

pi does not read anything under `~/.omp/`. Its own credential store is:

- `~/.pi/agent/auth.json`, mode `0600`, one object per provider id.
- Observed entries: `anthropic` (`{access, refresh, expires, type}`) and
  `pi-sub-anthropic` (`{access, refresh, expires, type, accountId, email, orgId, orgName}`)
  — both `type: "oauth"` subscription credentials obtained via `/login`.
- `~/.pi/agent/provider-keys.json` holds plain API keys (empty here).
- Environment API keys (`ANTHROPIC_API_KEY`, …) are read as a fallback.

Consequence for deployment: the service unit must run as the user that owns
`~/.pi/agent/auth.json`, or supply a provider key through the environment file.
The agent dir can be relocated with `PI_CODING_AGENT_DIR`.

## 0.1 Flag set (`pi --help`)

Confirmed present:

| Flag | Notes |
|---|---|
| `--mode <text\|json\|rpc>` | `text` is the default; `rpc-ui` does not exist |
| `--session <path\|id>` | takes a path or a partial UUID |
| `--session-id <id>`, `--fork <path\|id>`, `--session-dir <dir>`, `--no-session` | |
| `--name, -n <name>` | initial session display name |
| `--append-system-prompt <text>` | text **or a file path**; repeatable |
| `--system-prompt <text>` | replaces the base prompt |
| `--no-tools, -nt`, `--no-builtin-tools`, `--tools`, `--exclude-tools` | |
| `--no-extensions, -ne`, `--no-skills, -ns`, `--no-prompt-templates, -np`, `--no-themes` | all three of the questioned `--no-*` flags exist |
| `--no-context-files, -nc` | disables AGENTS.md *and* CLAUDE.md discovery |
| `--thinking <off\|minimal\|low\|medium\|high\|xhigh\|max>` | |
| `--approve, -a` / `--no-approve, -na` | trust project-local files for this run |
| `--model <pattern>`, `--provider <name>`, `--models <patterns>` | `--model provider/id` accepted, `:<thinking>` suffix accepted |
| `--print, -p`, `--continue, -c`, `--resume, -r` | `-r` takes **no** path; it opens a picker |
| `--version, -v`, `--offline`, `--verbose`, `--export <file>`, `--list-models` | |

**No `--cwd` flag exists.** The working directory must be set on the spawn call.

There is no `--approval-mode`, no `--no-lsp`, no `--no-rules`, no `--no-title`.

Subcommands: `pi install|remove|uninstall|update|list|config|auth`.

## 0.2 Startup frame

`pi --mode rpc --no-session` emits **nothing** unprompted (3 s observation window,
zero stdout frames, empty stderr). There is no `ready` frame, no protocol
negotiation, no `rpc_chunk` framing.

`get_state` sent immediately after spawn answered in **3 ms**. Readiness is therefore
"the first successful `get_state` response".

Framing is strict JSONL: split on `\n` only, strip one optional trailing `\r`.

## 0.3 Session store

- Root: `~/.pi/agent/sessions/` (overridable with `--session-dir` or
  `PI_CODING_AGENT_SESSION_DIR`).
- Directory per project cwd, encoded by replacing every `/` with `-` and wrapping in
  a leading and trailing `--`: `/tmp/pi-probe` → `--tmp-pi-probe--`.
- Filename: `<ISO timestamp with : and . replaced by ->_<uuid>.jsonl`, e.g.
  `2026-09-19T22-39-41-089Z_01a0bbd3-4820-7185-89e0-855de317c027.jsonl`.
- First line (header entry):

  ```json
  {"type":"session","version":3,"id":"01a0bbd3-…","timestamp":"2026-09-19T22:39:41.089Z","cwd":"/tmp/pi-probe"}
  ```

  Fields: `type`, `version`, `id`, `timestamp`, `cwd`. There is **no** `title` field.
- Subsequent entry types observed: `model_change`, `thinking_level_change`,
  `message` (with `message.role` of `user` / `assistant` / `toolResult`),
  `session_info`.
- **Session name persistence:** `set_session_name` appends a `session_info` entry:

  ```json
  {"type":"session_info","id":"8f3b510a","parentId":"d5b3b545","timestamp":"…","name":"probe session name"}
  ```

  The last such entry wins. `get_state.sessionName` reports it.

## 0.4 Resume identity

Spawning `pi --mode rpc --session <file>` against an existing session returned the
same `sessionId`, the same `sessionFile`, the restored `sessionName`, and
`messageCount: 5`. Disposable children are safe.

## 0.5 Default model keys

`~/.pi/agent/settings.json` top level:

```json
{
  "defaultProvider": "pi-sub-anthropic",
  "defaultModel": "claude-sonnet-5",
  "defaultThinkingLevel": "off",
  "theme": "dark",
  "lastChangelogVersion": "0.85.1",
  "packages": [ … ],
  "warnings": { … }
}
```

So: `defaultProvider`, `defaultModel`, `defaultThinkingLevel`. Any write must preserve
the other keys.

## 0.6 Global auto-install

**Yes.** A package added by hand to the global `packages` array installs on the next
pi start, including in `--mode rpc`. Probe: a scratch agent dir containing only
`settings.json` with `["npm:pi-web-access"]` produced `~/.pi/agent/npm/` (npm reported
"added 134 packages"), and `get_commands` then listed that package's commands
(`websearch`, `curator`, `google-account`, `search`).

npm progress output goes to **stderr**, not stdout, so it does not corrupt the RPC stream.

## 0.7 Message shape

Full frame transcript of a `read` + `bash` turn is committed at
`src/server/fixtures/pi-turn.jsonl` (44 frames).

Frame order for that turn:

```
response/get_state, response/prompt,
agent_start, turn_start,
message_start(user), message_end(user),
message_start(assistant),
  message_update/thinking_start … thinking_delta … thinking_end
  message_update/toolcall_start … toolcall_delta × n … toolcall_end   (read)
  message_update/toolcall_start … toolcall_delta × n … toolcall_end   (bash)
message_end(assistant),
tool_execution_start × 2, tool_execution_update × 2, tool_execution_end × 2,
message_start(toolResult), message_end(toolResult),   × 2
turn_end, turn_start,
message_start(assistant), message_update/text_start … text_delta … text_end, message_end,
turn_end, agent_end, agent_settled
```

Message shapes match what `toPiMessage` already expects:

- user: `{role:"user", content:[{type:"text",text}], timestamp}` (content may also be a bare string)
- assistant: `{role:"assistant", content:[{type:"text"|"thinking"|"toolCall", …}], api, provider, model, usage, stopReason, timestamp}`
  - thinking blocks: `{type:"thinking", thinking, thinkingSignature}`
  - tool calls: `{type:"toolCall", id, name, arguments}`
- tool result: `{role:"toolResult", toolCallId, toolName, content:[{type:"text",text}], isError, timestamp}`

`message_update` carries no cumulative `message` and no `partial` flag — deltas only,
keyed by `contentIndex`. `message_end.message` is authoritative.

An in-flight assistant `message_start` has `stopReason: "pending"` and empty `content`.

`healDanglingToolCalls` stays valid: tool calls live on assistant messages, results
arrive as separate `toolResult` messages keyed by `toolCallId`.

## 0.8 Slash commands

`get_commands` returns, per command:

```json
{
  "name": "probe-ping",
  "description": "probe local command",
  "source": "extension" | "prompt" | "skill",
  "sourceInfo": {
    "path": "/tmp/pi-probe2/.pi/extensions/probe.ts",
    "source": "auto" | "inline",
    "scope": "project" | "user" | "temporary",
    "origin": "top-level",
    "baseDir": "/tmp/pi-probe2/.pi"
  }
}
```

Note: the RPC doc's flat `location` / `path` fields are **not** what 0.85.1 emits; the
data is nested under `sourceInfo` (`sourceInfo.scope` replaces `location`,
`sourceInfo.path` replaces `path`). Skills are named `skill:<name>`.

**Invocation signals.** Sending `{"type":"prompt","message":"/probe-ping hi"}`:

```
extension_ui_request {method:"notify", message:"probe pong hi", notifyType:"info"}
response {command:"prompt", success:true}
```

and nothing else. No `agent_start`, no `agent_end`, no `agent_settled`, no message
events. **There is no explicit "agent was not invoked" field.** The only signal is the
absence of `agent_start`, and command output arrives (if the extension chooses) as a
fire-and-forget `notify` UI request.

By contrast an unrecognised `/whatever` is sent to the model as ordinary text and
produces the full `agent_start … agent_settled` sequence.

Prompt templates (`/hello`) and skills (`/skill:greeter`) are expanded client-side by pi
and *do* invoke the agent.

⇒ The spec's fallback rule stands: for a prompt whose text starts with `/`, if no
`agent_start` arrives within ~1500 ms of the success response, settle as local.

## 0.9 Context files

pi reads **both** `AGENTS.md` and `CLAUDE.md` (`--no-context-files` disables both).
Probe: a project containing only `CLAUDE.md` with a codeword — pi answered with the
codeword without using tools. No `AGENTS.md` symlink is needed for `games42_mono`.

## 0.10 `pi list`

Human-readable text only; there is no `--json`. Output:

```
User packages:
  npm:pi-sub-anthropic
    /home/loki/.pi/agent/npm/node_modules/pi-sub-anthropic
  npm:pi-lens (filtered)
    /home/loki/.pi/agent/npm/node_modules/pi-lens
```

`(filtered)` marks an entry written in object form with filter keys. `settings.json`
remains the source of truth; `pi list` is not parsed by the product.

## 0.11 Project trust in RPC

Decisive. A project with `.pi/extensions/`, `.pi/prompts/`, `.pi/skills/` and an
untrusted cwd:

| spawn | `get_commands` |
|---|---|
| `pi --mode rpc` | `["llama"]` — only the built-in inline extension |
| `pi --mode rpc --approve` | `["probe-ping", "llama", "hello", "skill:greeter"]` |

So `--approve` is required for project-local resources in RPC mode; without it they are
silently skipped (no prompt, no stderr). Trust is otherwise recorded in
`~/.pi/agent/trust.json` as `{ "<abs path>": true }`.

**Project resource layout** (contradicts the RPC doc's `.pi/agent/prompts` example):
project resources live at `.pi/extensions/`, `.pi/prompts/`, `.pi/skills/`,
`.pi/themes/`, with settings at `.pi/settings.json`, npm installs at `.pi/npm/` and git
clones at `.pi/git/`. Nothing is read from `.pi/agent/`.

---

## Package manager facts (Phase 2 inputs)

- npm installs land at `~/.pi/agent/npm/node_modules/<name>/`, with a shared
  `~/.pi/agent/npm/package-lock.json`. So `installed` version reads from
  `~/.pi/agent/npm/node_modules/<name>/package.json`.
- git clones land at `~/.pi/agent/git/<host>/<path>`.
- Settings entries are either a bare string or an object. Besides the documented filter
  keys (`extensions`, `skills`, `prompts`, `themes`) real installs also carry
  `autoload: false`, which `pi list` renders as `(filtered)`.
- `pi update --self` updates the CLI; `pi update --extensions` updates packages and
  reconciles pinned git refs; versioned npm specs and pinned git refs are skipped.

### npm registry endpoints (7.4)

Confirmed by curl:

- Search: `https://registry.npmjs.org/-/v1/search?text=keywords:pi-package%20<q>&size=30`
  — the `keywords:` qualifier works, terms are space-separated. Each hit carries
  `package.{name,version,description,keywords,date,publisher{username,email},links{npm,repository,homepage}}`.
  The `total` field is npm's fuzzy total for the query and is not a count of keyword matches.
- Detail: `https://registry.npmjs.org/<name>/latest` → includes the `pi` manifest
  (`{extensions,skills,prompts,themes,image,video}`), `version`, `repository`, `keywords`.
- Downloads: `https://api.npmjs.org/downloads/point/last-week/<name>` →
  `{downloads, start, end, package}`. Works for unscoped names.
