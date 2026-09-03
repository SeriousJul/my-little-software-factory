#!/usr/bin/env bash
# Run Stryker mutation testing through the crash guard and always remove
# the temp dir afterwards. A separate script (instead of a compound npm
# command) keeps the extra arguments in "$@", where npm appends them, so
# they forward to Stryker: `npm run mutate -- --dryRunOnly`.
#
# The temp dir removal also covers the path Stryker's own cleanup cannot:
# a native crash kills the runner before its JavaScript runs.

set -u

cd "$(dirname "$0")/.."

if [ -n "${NODE_OPTIONS:-}" ]; then
	export NODE_OPTIONS="$NODE_OPTIONS --experimental-ffi"
else
	export NODE_OPTIONS="--experimental-ffi"
fi

bash scripts/crash-guard.sh node_modules/.bin/stryker run "$@"
status=$?
rm -rf .stryker-tmp
exit "$status"
