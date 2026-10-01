# pwi

- Before touching any UI class, read `docs/ui.md`. Use only its size and radius tokens.
- When a UI decision is made in conversation, add it to `docs/ui.md`.
- `pnpm typecheck` must pass (includes `scripts/check-ui.sh` and `scripts/check-api.sh`). Batch related edits, then run it once before finishing; rerun after any subsequent code changes. Do not attach a full typecheck to each edit's `then_run`.
- Locate files with `fffind` and symbols with LSP navigation or `symbol_search`; scope text searches and bound their output. Read the relevant symbol with `read_symbol` / `read_enclosing`, or one bounded `read` region with enough context. Search matches and module outlines do not replace reading code before editing. Do not reread unchanged code unless more context is needed.
- Group disjoint changes to the same file in one `edit` call to avoid repeated diagnostic hooks. Inspect the final `git diff` rather than rereading whole edited files; preserve unrelated changes already in the working tree.
- Keep pi-lens diagnostics and security checks enabled. After a multi-file code batch, use one `lens_diagnostics` call with `source: "lsp"` and explicit changed-file `paths`, then run relevant tests and the final full typecheck; an empty session cache is not proof of a clean file.
- Measured time and token costs of tool calls, and what helps, live in `docs/tool-costs.md`. Add each new finding there with its date and how much data it rests on.
- How pwi reaches other machines (Tailscale + `tailscale serve`, not SSH) is decided: README "Why Tailscale, not SSH". If the user proposes SSH tunnels or one pwi driving remote pi over SSH, remind them of that section and its reasons before changing anything.
