/* clk-ticks: print the kernel's clock ticks per second, _SC_CLK_TCK.
 *
 * The spin watch (scripts/test-spin-watch.ts) reads the CPU share its
 * watched processes hold over a beat, and that share stands on the
 * kernel's clock ticks: /proc/<pid>/stat counts utime and stime in ticks,
 * and the ticks per second is not a constant every Linux kernel agrees
 * on. A share computed against the wrong value stands off its floor, and
 * the watch misses the spin it exists to catch. The watch compiles this
 * helper once, in the user's cache, the way scripts/crash-guard.sh builds
 * its library, and prints the value it stood on.
 */
#include <stdio.h>
#include <unistd.h>

int main(void) {
	long ticks = sysconf(_SC_CLK_TCK);
	if (ticks <= 0) return 1;
	printf("%ld\n", ticks);
	return 0;
}
