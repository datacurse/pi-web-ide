# pwi

- Before touching any UI class, read `docs/ui.md`. Use only its size and radius tokens.
- When a UI decision is made in conversation, add it to `docs/ui.md`.
- `pnpm typecheck` must pass (includes `scripts/check-ui.sh`).
- Measured time and token costs of tool calls, and what helps, live in `docs/tool-costs.md`. Add each new finding there with its date and how much data it rests on.
- How pwi reaches other machines (Tailscale + `tailscale serve`, not SSH) is decided: README "Why Tailscale, not SSH". If the user proposes SSH tunnels or one pwi driving remote pi over SSH, remind them of that section and its reasons before changing anything.
