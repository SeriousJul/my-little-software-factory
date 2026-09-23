#!/usr/bin/env bash
# Run Stryker mutation testing through the crash guard and always remove the
# temp dir afterwards.
#
# A separate script (instead of a compound package command) keeps the extra
# arguments in "$@", where the package runner appends them, so they forward to
# Stryker: `bun run mutate -- --dryRunOnly`, `bun run mutate -- --help`.
#
# Every test child this campaign spawns is a real `bun test` run of the plane's
# suite, so it loads OpenTUI's native core and opens SQLite files. A mutant
# that breaks a dispose path can die on a native crash; without containment the
# desktop records a crash report for each death and the run's siblings are left
# orphaned. The guard covers both: the tree runs non-dumpable, no core file is
# written, and every survivor is reaped when the command exits. The plugin's own
# per-child timeout and process-group kill handle a child that merely hangs;
# the guard is the backstop for a child that dies natively and for a guard-level
# kill of the campaign itself.
#
# The temp dir removal also covers the path Stryker's own cleanup cannot: a
# native crash kills the runner before its JavaScript runs. The trap covers the
# path the script's last line cannot: a cancelled campaign dies on a signal
# before it reaches that line, and the EXIT trap still runs. An operator who
# passes Stryker's own `--cleanTempDir` option wants the sandbox kept to look
# inside it, so the trap stands down for a `--cleanTempDir=false` call.

set -u

cd "$(dirname "$0")/.."

keep_temp=0
for arg in "$@"; do
	case "$arg" in --cleanTempDir=*) keep_temp=1 ;; esac
done
if [ "$keep_temp" -eq 0 ]; then
	trap 'rm -rf .stryker-tmp' EXIT
fi

# The Bun test-runner plugin correlates a test run to its mutants through the
# inspector's TestReporter events, which Bun added in 1.3.7. On an older Bun the
# campaign fails in ways that read like a broken suite, so the gate says what is
# missing. The control plane itself still runs on the 1.3.0 floor ADR 0035 set;
# this floor belongs to the mutation harness, not to the app.
REQUIRED_BUN=1.3.7

# version_ge A B is true when the dotted version A is at least B.
version_ge() {
	local IFS=.
	local -a a=($1) b=($2)
	local i n x y
	n=${#a[@]}
	[ ${#b[@]} -gt "$n" ] && n=${#b[@]}
	for ((i = 0; i < n; i++)); do
		x=${a[i]:-0}
		y=${b[i]:-0}
		x=${x%%[!0-9]*}
		y=${y%%[!0-9]*}
		[ "$((10#${x:-0}))" -gt "$((10#${y:-0}))" ] && return 0
		[ "$((10#${x:-0}))" -lt "$((10#${y:-0}))" ] && return 1
	done
	return 0
}

have_bun=$(bun --version 2>/dev/null) || have_bun=""
if [ -z "$have_bun" ]; then
	echo "mutate: no bun on PATH. The campaign runs the suite on bun:test." >&2
	exit 1
fi
if ! version_ge "$have_bun" "$REQUIRED_BUN"; then
	echo "mutate: needs Bun ${REQUIRED_BUN} or newer, this machine has ${have_bun}." >&2
	echo "mutate: the test-runner plugin reads the inspector events that release added." >&2
	exit 1
fi

STRYKER_BIN=node_modules/@stryker-mutator/core/bin/stryker.js
if [ ! -f "$STRYKER_BIN" ]; then
	echo "mutate: ${STRYKER_BIN} is missing. Run 'bun install' first." >&2
	exit 1
fi

bash scripts/crash-guard.sh bun "$STRYKER_BIN" run "$@"
status=$?
exit "$status"
