#!/bin/sh
# Every browser call to /api goes through the typed client (src/web/api.ts),
# so a renamed route, body field or response field fails `pnpm typecheck`.
# Allowed raw: /api/upload, whose body is the file's bytes, not JSON. The
# event stream (EventSource), the terminal (WebSocket) and downloads (a link)
# are not fetch calls and are not matched.
cd "$(dirname "$0")/../src/web" || exit 1
hits=$(find . -name '*.ts' -o -name '*.tsx' | xargs perl -0777 -ne '
	while (/\bfetch\(\s*[`"\x27]\/api\/([\w\/-]*)/g) {
		print "$ARGV: fetch(/api/$1\n" unless $1 eq "upload";
	}')
[ -z "$hits" ] && exit 0
echo "Raw fetch to /api (use the typed client in src/web/api.ts):"
echo "$hits"
exit 1
