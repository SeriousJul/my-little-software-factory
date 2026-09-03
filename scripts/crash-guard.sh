#!/usr/bin/env bash
# crash-guard: run a command with crash containment.
#
# The test suite spawns `node factory.ts` children. When a runner process
# dies on a native crash (the node 26.5.0 node:sqlite use-after-free under
# Stryker is the known case), those children are left orphaned under
# systemd, and the OS records a crash report for every death. This guard
# contains both:
#
# 1. RLIMIT_CORE is set to 0 for the command and everything it spawns.
#    A crashed process writes no core file, so the OS records no crash
#    and the desktop shows no crash report.
# 2. The command runs as the leader of its own session (setsid), so its
#    whole process tree is one unit. When the command exits, by success,
#    failure, or crash, the guard terminates every surviving descendant:
#    SIGTERM, a grace period, then SIGKILL.
#
# The exit code of the command is passed through unchanged.
#
# Usage: crash-guard.sh COMMAND [ARGS...]

set -u

GRACE_SECONDS=5

if [ "$#" -lt 1 ]; then
	echo "usage: crash-guard.sh COMMAND [ARGS...]" >&2
	exit 2
fi

# No core file for this process or any of its descendants.
ulimit -c 0

# Start the command in its own session. It becomes the session and the
# process group leader, so its whole tree answers to one group id.
# A background child can never already be a group leader, so setsid does
# not fork and $! is the real leader.
if command -v setsid > /dev/null 2>&1; then
	setsid "$@" &
else
	perl -e 'POSIX::setsid() or die "setsid: $!"; exec @ARGV or die "exec $ARGV[0]: $!"' "$@" &
fi
run_pid=$!

forwarded=0
forward() {
	if [ "$forwarded" -eq 0 ]; then
		forwarded=1
		kill -TERM -- "-$run_pid" 2>/dev/null || true
	fi
}
# INT/TERM from a Ctrl+C or a killer, HUP from a closing terminal: all of
# them cancel the run and must reach the whole group, not just the leader.
trap forward INT TERM HUP

wait "$run_pid"
code=$?
# A trapped signal interrupts wait with 128+sig of the guard, not the
# command's exit code. If the command is still running when that happens,
# wait again for its real status; it dies from the forwarded signal.
if [ "$forwarded" -eq 1 ] && kill -0 "$run_pid" 2>/dev/null; then
	wait "$run_pid"
	code=$?
fi
trap - INT TERM HUP

# All still-alive transitive descendants of $1, one pid per line.
descendants() {
	local -A seen=()
	local -a queue=("$1")
	local pid child
	while [ "${#queue[@]}" -gt 0 ]; do
		pid="${queue[0]}"
		queue=("${queue[@]:1}")
		for child in $(pgrep -P "$pid" 2>/dev/null); do
			if [ -z "${seen[$child]:-}" ]; then
				seen[$child]=1
				queue+=("$child")
				printf '%s\n' "$child"
			fi
		done
	done
}

# Every process still alive in the run's tree. When a member of the tree
# dies, its children are reparented and the parent link is lost, so the
# process group is the only reliable roster: members keep their group id
# through reparenting. The descendant scan adds stragglers that moved to
# a group of their own while their parent still lived.
living_tree() {
	{ ps -o pid= -g "$run_pid" 2>/dev/null; descendants "$run_pid"; } | sort -un
}

count_living() {
	local n
	n=$(living_tree | wc -l)
	echo "$n"
}

# Signal every surviving member of the run's tree: the whole process
# group first, then any stragglers that moved to a group of their own.
reap() {
	local sig="$1"
	local pid
	kill "-$sig" -- "-$run_pid" 2>/dev/null || true
	while IFS= read -r pid; do
		[ -n "$pid" ] && kill "-$sig" "$pid" 2>/dev/null || true
	done < <(living_tree)
}

left=$(count_living)
if [ "$left" -gt 0 ]; then
	reap TERM
	deadline=$(( $(date +%s) + GRACE_SECONDS ))
	while [ "$(count_living)" -gt 0 ] && [ "$(date +%s)" -lt "$deadline" ]; do
		sleep 0.2
	done
	if [ "$(count_living)" -gt 0 ]; then
		# The grace is over and the survivors ignore SIGTERM.
		reap KILL
	fi
	echo "crash-guard: ended $left leftover process(es) from the run." >&2
fi

if [ "$code" -gt 128 ]; then
	sig=$((code - 128))
	signame=$(kill -l "$sig" 2>/dev/null || echo "unknown")
	echo "crash-guard: the command died of signal $sig ($signame), exit code $code. No core file was written." >&2
elif [ "$code" -ne 0 ]; then
	echo "crash-guard: the command exited with code $code." >&2
fi

exit "$code"
