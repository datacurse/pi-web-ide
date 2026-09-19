#!/usr/bin/env bash
#
# install.sh — put piw under systemd --user on this machine.
#
# Idempotent: safe to re-run after `git pull`, a `pnpm build`, or an edit to the
# env file. Never uses sudo — piw is a user service holding user credentials, so
# there is nothing here that root should own.
#
# Env knobs:
#   PIW_INSTALL_COPY=1   copy the unit instead of symlinking it
#
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"

unit_name="piw.service"
# The unit dir honours XDG_CONFIG_HOME because that is where `systemctl --user`
# actually looks. The env file does NOT: the unit references it as
# %h/.config/piw/env, and systemd has no XDG-aware specifier, so both sides
# must stay literally $HOME/.config to agree.
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
conf_dir="$HOME/.config/piw"
env_file="$conf_dir/env"
dropin_dir="$unit_dir/$unit_name.d"
dropin="$dropin_dir/10-workdir.conf"

say() { printf 'piw install: %s\n' "$*"; }
fail() {
	printf 'piw install: %s\n' "$*" >&2
	exit 1
}

# Created once, then owned by the user: re-running install.sh must never
# clobber a hand-tuned port or workspace. This runs BEFORE the systemd check
# because the no-systemd fallback tells you to source this file, and printing
# instructions that reference a file we declined to create is worse than
# useless.
ensure_env_file() {
	mkdir -p "$conf_dir"
	if [ -f "$env_file" ]; then
		say "kept existing $env_file"
		return
	fi
	sed "s|@HOME@|$HOME|g" "$here/piw.env.example" >"$env_file"
	# No secrets today — credentials live in ~/.omp/agent/auth.json — but this
	# is service configuration in a dotfile directory, so 0600 costs nothing
	# and is already right if a token ever lands here.
	chmod 0600 "$env_file"
	say "created $env_file from piw.env.example — review it"
}

# PIW_PORT from the installed env file, defaulting exactly as index.ts does.
# Last match wins, which is what systemd does with a repeated key.
read_port() {
	local p
	p="$(sed -n 's/^PIW_PORT=\([0-9][0-9]*\).*/\1/p' "$env_file" | tail -1)"
	printf '%s' "${p:-8790}"
}

# ---------------------------------------------------------------------------
# Preflight.
# ---------------------------------------------------------------------------
for cmd in systemctl loginctl sed install; do
	command -v "$cmd" >/dev/null 2>&1 || fail "required command not found: $cmd"
done

[ -f "$here/$unit_name" ] || fail "missing $here/$unit_name"
[ -f "$here/piw.env.example" ] || fail "missing $here/piw.env.example"

ensure_env_file

# A user manager may be absent for two quite different reasons — no systemd at
# all (plain WSL without systemd=true in /etc/wsl.conf, a container) or a
# systemd host you are reaching over ssh without a login session. Either way
# `systemctl --user` cannot work, and pretending otherwise leaves the user with
# a "successful" install and nothing running. Print the exact fallback instead.
if ! systemctl --user show-environment >/dev/null 2>&1; then
	port_hint="$(read_port)"
	cat >&2 <<EOF
piw install: no systemd user manager on this machine.

  \`systemctl --user\` is unavailable, so there is nothing to install into.
  On WSL, enable it by putting the following in /etc/wsl.conf and running
  \`wsl --shutdown\` from Windows:

      [boot]
      systemd=true

  Until then, run piw detached by hand. This survives the shell that starts it
  but NOT a reboot, and nothing will restart it if it dies:

      mkdir -p "\$HOME/.local/state/piw"
      cd $repo
      set -a; . "$env_file"; set +a
      setsid nohup pnpm start >>"\$HOME/.local/state/piw/piw.log" 2>&1 </dev/null &

  Then: http://127.0.0.1:$port_hint   (log: ~/.local/state/piw/piw.log)
EOF
	exit 1
fi

# The unit starts the production server, which serves dist/ itself. Without a
# build it would come up healthy and serve nothing, so refuse early rather than
# hand back a green `systemctl status` that lies.
[ -d "$repo/dist" ] || fail "no $repo/dist — run \`pnpm build\` first"

# ---------------------------------------------------------------------------
# Unit file. Symlink by default so `git pull` updates it (a daemon-reload is
# still required, and this script does one). Copy when the checkout lives
# somewhere the user manager may not be able to read, or on request.
# ---------------------------------------------------------------------------
mkdir -p "$unit_dir"

if [ "${PIW_INSTALL_COPY:-}" = "1" ]; then
	install -m 0644 "$here/$unit_name" "$unit_dir/$unit_name"
	say "copied $unit_dir/$unit_name"
else
	ln -sfn "$here/$unit_name" "$unit_dir/$unit_name"
	say "linked $unit_dir/$unit_name -> $here/$unit_name"
fi

# The shipped unit hardcodes WorkingDirectory=%h/code/piw because that is where
# the checkout lives on every machine so far. A drop-in, rather than rewriting
# the unit, keeps the unit file itself identical everywhere and diffable against
# git — and lets us delete the override cleanly when it is not needed.
if [ "$repo" = "$HOME/code/piw" ]; then
	if [ -e "$dropin" ]; then
		rm -f "$dropin"
		rmdir "$dropin_dir" 2>/dev/null || true
		say "removed stale WorkingDirectory drop-in"
	fi
else
	mkdir -p "$dropin_dir"
	cat >"$dropin" <<EOF
# Generated by deploy/install.sh. Checkout is not at \$HOME/code/piw.
[Service]
WorkingDirectory=$repo
EOF
	say "wrote $dropin (WorkingDirectory=$repo)"
fi

# ---------------------------------------------------------------------------
# Activate.
# ---------------------------------------------------------------------------
systemctl --user daemon-reload
systemctl --user enable "$unit_name" >/dev/null
systemctl --user restart "$unit_name"

port="$(read_port)"

echo
systemctl --user --no-pager --full status "$unit_name" || true
echo
say "http://127.0.0.1:$port"
say "logs:    journalctl --user -u $unit_name -f"
say "restart: systemctl --user restart $unit_name"

# ---------------------------------------------------------------------------
# Linger. This is the actual point of the exercise on a headless agent host: a
# user manager without linger is torn down when your last session ends, so the
# service dies the moment you log out of ssh — precisely when you wanted the
# agent to keep working. It needs polkit, so we tell rather than do.
# ---------------------------------------------------------------------------
echo
linger="$(loginctl show-user "$USER" --property=Linger --value 2>/dev/null || true)"
if [ "$linger" = "yes" ]; then
	say "linger is already enabled for $USER — the service survives logout"
else
	say "linger is NOT enabled. Without it this service stops when your last"
	say "session ends. Run once per machine:"
	say "    loginctl enable-linger $USER"
fi
