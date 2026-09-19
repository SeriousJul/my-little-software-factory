/* nondumpable: an LD_PRELOAD library that makes a process non-dumpable.
 *
 * A non-dumpable process that dies on a fatal signal invokes no coredump
 * handler at all: the kernel records no core file and no journal entry,
 * so the desktop shows no crash report.
 *
 * The flag is reset to dumpable by every execve, so the constructor
 * re-asserts it. Because the library rides in LD_PRELOAD, the dynamic
 * loader re-runs the constructor in every process of the tree that
 * execs, and forked children inherit the flag, so the whole tree runs
 * non-dumpable. crash-guard.sh builds this library once, in the user's
 * cache, and exports it for the run. A statically linked binary skips
 * the loader, so the flag never lands there; the guard's core file
 * limit still covers that case.
 *
 * Usage: LD_PRELOAD=libnondumpable.so COMMAND [ARGS...]
 */
#include <sys/prctl.h>

__attribute__((constructor))
static void mlsf_make_nondumpable(void) {
	prctl(PR_SET_DUMPABLE, 0, 0, 0, 0);
}
