# Tool metrics format

`collector.ts` appends one JSON object per line to
`<PWI_TOOL_METRICS_DIR>/<sessionId>.jsonl`, one line per finished tool call.
pwi sets the directory to `<state dir>/tool-metrics/`.

| Field        | Type   | Meaning |
| ------------ | ------ | ------- |
| `v`          | `1`    | Format version. |
| `toolCallId` | string | The call's id, as in the session file. Join on this, not the file name: forks copy calls into a new session. |
| `tool`       | string | Tool name. |
| `ms`         | number | `tool_execution_start` to `tool_execution_end`, monotonic clock, whole ms. Parallel calls each get their own. |
| `hookMs`     | number | `tool_result` to `tool_execution_end`: time other extensions spent on the result (pi-lens's diagnostics after an edit). Absent if no `tool_result` was seen. |
| `at`         | number | When the call ended, epoch ms. |
| `steps`      | array  | bash only: each command of the call, in order (below). Absent when the call ran untraced (it set `BASH_ENV` or `set -x`). |

A step (`bash.ts`, `steps.ts`): a pipeline is one step; a loop body is one
step run many times.

| Field   | Type   | Meaning |
| ------- | ------ | ------- |
| `text`  | string | The command as written, or bash's reprint when it could not be found in the text. |
| `ms`    | number | Its time, 0.1 ms; summed over `runs`. |
| `exit`  | number | Its exit status. |
| `bytes` | number | Its output, stdout and stderr, in bytes. Absent if the markers were lost. |
| `shown` | number | Of `bytes`, those in the tail pi showed the model after truncating. |
| `runs`  | number | Times it ran, when more than once. |

A background job started by a call gets its own line once it is gone:
`{"v":1,"type":"background","toolCallId","tool":"bash","pid","step","ms","at"}`,
where `ms` is launch to gone (checked every second) and `step` indexes the
call's `steps` (absent for a `( ... ) &` subshell). Jobs still running when pi
exits get no line. Readers indexing calls by `toolCallId` skip lines with a
`type`.

Rules: fields may be added without a version change; `v` changes only when
an existing field changes meaning. Readers skip lines they cannot parse (the
last line of a live file may be half-written).
