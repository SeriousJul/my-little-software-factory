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
# asks Stryker to keep the temp dir wants the sandbox to look inside it, so the
# trap stands down for the values that ask it: `false` and `0`, which is exactly
# what Stryker's own option parser reads as "do not delete"
# (parseCleanDirOption in @stryker-mutator/core/dist/src/stryker-cli.js). It
# stands down for nothing else, because this entry point cannot delete less than
# core while core holds the tree. `never` is the plain-English spelling of that
# request and is not one of the parser's values: it reads any text but `false`
# and `0` as truthy, so `--cleanTempDir=never` asks core to delete the temp dir,
# and `TemporaryDirectory.dispose` takes it down on a run that ends cleanly. The
# line below says so at the gate instead of promising a keep this entry point
# cannot deliver. `true`, `always`, and that `never` all leave the trap armed.
#
# Each campaign takes a temp dir of its own, named for this process, because
# Stryker's temp dir is one tree that a cleanup deletes whole: two campaigns in
# one checkout destroy each other's sandbox. Measured on this branch, a campaign
# that ran beside another in the same worktree reported 3 of its 9 mutants as
# errors. The per-campaign dir is also the tree the removal is anchored to: see
# the resolved-path check below, which is what keeps a caller-named dir from
# pointing that removal outside the campaign.

set -u

# Every path this script touches hangs off the repository root above it, and the
# removal below is the one destructive thing it does, so the root is taken once,
# absolutely, and the removal is anchored to it.
repo_root="$(cd "$(dirname "$0")/.." && pwd)" || {
	echo "mutate: cannot enter the repository root above scripts/." >&2
	exit 1
}
cd "$repo_root" || {
	echo "mutate: cannot change into $repo_root." >&2
	exit 1
}

# The campaign's own temp dir, and the two requests read out of the caller's
# arguments that decide what happens to it: Stryker's `--cleanTempDir`, and a
# `--tempDirName` that names a tree of the caller's instead.
temp_dir=".stryker-tmp/campaign-$$"
keep_temp=0
asked_for_never=0
temp_dir_from_caller=0
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
	value=""
	case "${args[i]}" in
		--cleanTempDir=*) value="${args[i]#--cleanTempDir=}" ;;
		# Commander takes a value option in the separated form too, so
		# `--cleanTempDir false` is the same request as `--cleanTempDir=false`.
		--cleanTempDir)
			i=$((i + 1))
			value="${args[i]:-}"
			;;
		--tempDirName=*)
			temp_dir_from_caller=1
			temp_dir="${args[i]#--tempDirName=}"
			continue
			;;
		--tempDirName)
			temp_dir_from_caller=1
			i=$((i + 1))
			temp_dir="${args[i]:-}"
			continue
			;;
	esac
	# Stryker lowercases the value before it reads it, so the match does too.
	case "${value,,}" in
		false | 0) keep_temp=1 ;;
		# The one value whose English reading and whose parsed reading disagree.
		never) asked_for_never=1 ;;
	esac
done

if [ "$asked_for_never" -eq 1 ] && [ "$keep_temp" -eq 0 ]; then
	echo "mutate: Stryker reads --cleanTempDir=never as a request to delete the temp dir, so the sandbox goes with the run. Use --cleanTempDir=false to keep it for inspection." >&2
fi

if [ "$temp_dir_from_caller" -eq 0 ]; then
	args+=("--tempDirName=$temp_dir")
fi

# The tree the removal may name: this campaign's own, under the temp parent, and
# nothing a caller located outside it. The test runs on the resolved path, not on
# the text the caller typed, because a prefix test on an unnormalized string is
# no anchor at all: `.stryker-tmp/../../victim` begins with the right words and
# names the tree above this checkout, where `..` carries `rm -rf` out of the
# campaign. `realpath -m` answers for a tree that does not exist yet, which is
# the normal case here. When it cannot answer, or the name is not a tree under
# the temp parent, this entry point removes nothing and Stryker's own cleanup is
# the only cleanup that runs.
temp_parent="$(realpath -m -- "$repo_root/.stryker-tmp" 2>/dev/null)" || temp_parent=""
campaign_dir="$(realpath -m -- "$temp_dir" 2>/dev/null)" || campaign_dir=""
remove_target=""
if [ "$keep_temp" -eq 0 ] && [ -n "$temp_parent" ] && [ -n "$campaign_dir" ]; then
	# The campaign's own dir and nothing else: a name that resolves to the temp
	# parent itself would take down every sibling campaign's tree with it.
	case "$campaign_dir" in
		"$temp_parent"/*) remove_target="$campaign_dir" ;;
		*)
			echo "mutate: --tempDirName=$temp_dir is no campaign dir under $temp_parent, so this entry point leaves its cleanup to Stryker." >&2
			;;
	esac
fi
if [ -n "$remove_target" ]; then
	# The campaign's dir first, then the parent, and only while it holds nothing
	# else: `rmdir` fails on a tree another campaign is still using. Both names
	# are resolved and absolute, so the removal answers to this script's own
	# repository root wherever the caller ran the command from.
	trap 'rm -rf "$remove_target"; rmdir "$temp_parent" 2>/dev/null || true' EXIT
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

# The installed Stryker entry point, overridable so a test can aim this script at
# its own stub instead of at a third party package's internal layout.
STRYKER_BIN="${STRYKER_BIN:-node_modules/@stryker-mutator/core/bin/stryker.js}"
if [ ! -f "$STRYKER_BIN" ]; then
	echo "mutate: ${STRYKER_BIN} is missing. Run 'bun install' first." >&2
	exit 1
fi

bash "$repo_root/scripts/crash-guard.sh" bun "$STRYKER_BIN" run "${args[@]}"
status=$?
if [ "$keep_temp" -eq 1 ]; then
	echo "mutate: the campaign's sandbox is kept under $temp_dir for inspection." >&2
fi
exit "$status"
