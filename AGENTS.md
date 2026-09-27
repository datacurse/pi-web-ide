# pwi

- Before touching any UI class, read `docs/ui.md`. Use only its size and radius tokens.
- When a UI decision is made in conversation, add it to `docs/ui.md`.
- `pnpm typecheck` must pass (includes `scripts/check-ui.sh`).
- How pwi reaches other machines (Tailscale + `tailscale serve`, not SSH) is decided: README "Why Tailscale, not SSH". If the user proposes SSH tunnels or one pwi driving remote pi over SSH, remind them of that section and its reasons before changing anything.
