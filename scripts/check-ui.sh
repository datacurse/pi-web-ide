#!/bin/sh
# Fails on type sizes and radii outside the tokens in src/web/index.css (@theme).
# Tailwind emits no CSS for removed classes, so without this they fail silently.
cd "$(dirname "$0")/../src/web" || exit 1
bad=$(grep -rnP --include='*.tsx' --include='*.ts' \
	'\btext-(xs|sm|base|lg|[2-9]?xl)\b|\btext-\[[0-9.]+(px|rem|em)\]|\brounded(-[a-z]{1,2})?(-(xs|xl|[2-4]xl|\[[^]]*\]))?(?=["'"'"'`\s}]|$)(?<!-sm|-md|-lg|-full|-none)' .)
[ -z "$bad" ] && exit 0
echo "Off-scale size or radius (see docs/ui.md):"
echo "$bad"
exit 1
