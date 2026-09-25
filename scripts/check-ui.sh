#!/bin/sh
# Enforces docs/ui.md. Tailwind emits no CSS for removed classes, so without
# this an off-scale class fails silently.
cd "$(dirname "$0")/../src/web" || exit 1
fail=0
check() { # message, PCRE; ui.tsx is where the primitives are defined, so it is exempt
	hits=$(grep -rnP --include='*.tsx' --include='*.ts' --exclude='ui.tsx' "$2" .)
	[ -z "$hits" ] && return
	echo "$1:"; echo "$hits"; fail=1
}
check "Off-scale size or radius (tokens in index.css @theme)" \
	'\btext-(xs|sm|base|lg|[2-9]?xl)\b|\btext-\[[0-9.]+(px|rem|em)\]|\brounded(-[a-z]{1,2})?(-(xs|xl|[2-4]xl|\[[^]]*\]))?(?=["'"'"'`\s}]|$)(?<!-sm|-md|-lg|-full|-none)'
check "Hand-rolled primary button (use <Button variant=\"primary\">)" 'bg-amber-500 px-[2-9]'
check "Hand-rolled subtle button (use <Button variant=\"subtle\">)" 'rounded-sm bg-neutral-800 px-2'
check "Hand-rolled input (use inputClass)" 'outline-none[^"`]*focus(-visible)?:border-'
check "Hand-rolled section label (use sectionLabel)" 'text-caption tracking-wide text-neutral-500 uppercase'
check "Arbitrary spacing or height (use the 4px scale or a control token)" '\b-?(p|m)[xytblr]?-\[[0-9.]+px\]|\b(gap(-[xy])?|h|size|min-h)-\[[0-9.]+px\]'
[ $fail = 1 ] && echo "See docs/ui.md."
exit $fail
