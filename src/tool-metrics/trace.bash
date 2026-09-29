# trace.bash — sourced through BASH_ENV by the shell of each bash tool call
# (bash.ts sets it in that call's env only).
#
# Before each command: one trace line (sequence number, time, the previous
# command's status, the command) and a marker on a saved copy of stdout,
# which bash.ts strips before anything reads the output, so output can be
# split by command. At exit: the end time and status.
#
# Does nothing unless bash.ts set PWI_TM_TRACE and PWI_TM_MARK, on bash
# without $EPOCHREALTIME (before 5.0), or when the trace file cannot be
# opened. Every write is silenced and can never fail the command, even under
# `set -eu`. Never enables functrace: it breaks background jobs. Under
# `set -x` bash would print the trap into the output, so bash.ts does not
# trace commands that turn it on.

unset BASH_ENV
if [ -n "${PWI_TM_TRACE-}" ] && [ -n "${PWI_TM_MARK-}" ] && [ -n "${EPOCHREALTIME-}" ] \
	&& { exec {__pwi_tm_fd}>>"$PWI_TM_TRACE"; } 2>/dev/null \
	&& { exec {__pwi_tm_out}>&1; } 2>/dev/null; then
	__pwi_tm_mark=$PWI_TM_MARK
	unset PWI_TM_TRACE PWI_TM_MARK
	__pwi_tm_n=0
	__pwi_tm_bg=
	# $1: the previous command's status. The trap passes "$_" last so that
	# `$_` is still the user's after the trap.
	__pwi_tm_step() {
		# Its own EXIT trap, which bash reports as the DEBUG trap's `trap` line.
		case $BASH_COMMAND in __pwi_tm_* | "trap '__pwi_tm_"*) return 0 ;; esac
		{
			__pwi_tm_n=$((__pwi_tm_n + 1))
			if [ -n "${!-}" ] && [ "${!-}" != "$__pwi_tm_bg" ]; then
				__pwi_tm_bg=${!-}
				printf 'B\t%s\t%s\t%s\n' "$__pwi_tm_n" "$EPOCHREALTIME" "$__pwi_tm_bg" >&"$__pwi_tm_fd"
			fi
			printf 'S\t%s\t%s\t%s\t%s\n' "$__pwi_tm_n" "$EPOCHREALTIME" "$1" "${BASH_COMMAND//$'\n'/$'\035'}" >&"$__pwi_tm_fd"
			printf '\036PWI%s:%s\037' "$__pwi_tm_mark" "$__pwi_tm_n" >&"$__pwi_tm_out"
		} 2>/dev/null || :
		return 0
	}
	__pwi_tm_end() {
		{
			# A job started by the last command has no later command to notice it.
			if [ -n "${!-}" ] && [ "${!-}" != "$__pwi_tm_bg" ]; then
				printf 'B\t%s\t%s\t%s\n' "$((__pwi_tm_n + 1))" "$EPOCHREALTIME" "${!-}" >&"$__pwi_tm_fd"
			fi
			printf 'E\t%s\t%s\t%s\n' "$__pwi_tm_n" "$EPOCHREALTIME" "$1" >&"$__pwi_tm_fd"
		} 2>/dev/null || :
	}
	trap '__pwi_tm_end "$?"' EXIT
	trap '__pwi_tm_step "$?" "$_"' DEBUG
fi
