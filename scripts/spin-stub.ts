/**
 * The stub command the spin watch's end-to-end check stands beside
 * (issue #403, ADR 0138).
 *
 * Run without arguments, it stands one child of its own: this same file,
 * run with `--test-worker` in its argument list - the same list shape a
 * run's real test workers carry. That child is the spin: it holds one
 * core at full CPU inside a synchronous loop that yields nowhere, so its
 * thread makes no voluntary context switches, the signature the watch
 * reads. The stub waits on the child and reports how it died: taken down
 * by a signal, or exited on its own. The child's argument list names the
 * worker role the watch matches on, so the check stands the watch's real
 * match beside the spin it exists to take down.
 *
 * The child bounds its own spin on its wall clock, well past the check's
 * timeout: on a small, loaded runner the child's share can dip under the
 * watch's floor on one beat, the watch takes it down nowhere, the test
 * times out, and the stub, the watch, and the child stand on as orphans.
 * The child holds no state, so a self-exit far past the check's deadline
 * bounds that chain without weakening the check: on the green path the
 * watch takes the child down in about a second and a half, long before
 * the bound stands.
 */
import { spawn } from "node:child_process";

if (process.argv.includes("--test-worker")) {
	// The spin: hold the core with a loop that yields nowhere. The loop
	// writes no state the process ever reads, so the only thing it holds
	// is the CPU share, and the only thing it makes is none of the
	// switches a healthy process makes on every event-loop turn. The
	// loop bounds itself on its own wall clock, well past the check's
	// timeout: a run the watch fails to pull red on a small, loaded
	// runner must not stand on the machine at full CPU without end, and
	// the clock read writes no state of the loop, so the spin the watch
	// reads stands as it did. On the green path the watch takes the
	// child down long before the bound stands, so the bound does not
	// weaken the check. The bound's default is 120 s against the check's
	// 30 s timeout; SPIN_STUB_SELF_EXIT_MS stands it shorter, so the
	// suite stands the mechanism beside a short bound without touching
	// the default the red path stands on.
	const rawSelfExitMs = Number(process.env.SPIN_STUB_SELF_EXIT_MS);
	const selfExitMs = Number.isFinite(rawSelfExitMs) && rawSelfExitMs > 0 ? rawSelfExitMs : 120_000;
	const bound = Date.now() + selfExitMs;
	let held = 0;
	for (;;) {
		held = (held + 1) | 0;
		if (Date.now() >= bound) break;
	}
	// The child exits here on its own. It must not fall through to the
	// parent branch below: that branch stands one more spin child and
	// waits on it, and the child would pass the spin on without end.
	process.exit(0);
}

const self = process.argv[1];
const child = spawn(process.execPath, [self, "--test-worker"], { stdio: "ignore" });
child.on("close", (code, signal) => {
	process.stderr.write(
		`[spin-stub] the spin child ${child.pid} died: ${signal !== null ? `taken down by ${signal}` : `exited ${code}`}\n`,
	);
	process.exit(0);
});
