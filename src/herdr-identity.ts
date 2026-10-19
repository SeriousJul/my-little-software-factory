/**
 * The plane's own face in herdr.
 *
 * Herdr identifies each pane's foreground process from the process's shape
 * and the screen it draws. The plane, run by `bun --watch`, reads to herdr's
 * pi detection as a pi agent in some screen states and as nothing in others,
 * so the pane's Agent fact flips over the run: herdr's client re-renders its
 * Agent panel and its workspace rollup on every flip, the panes it shows
 * reflow, and a pi session the operator is watching reads as a scroll that
 * runs back and forth (issue #405). The plane answers with the one identity
 * herdr cannot misread: the process's own report. Inside a herdr pane the
 * plane reports itself as the `factory` agent of the pane it runs in, and it
 * releases the report when the run ends; outside herdr the module stands
 * inert and the plane keeps whatever face herdr always gave it (ADR 0139).
 *
 * The in-herdr mark is the theme's own: a non-empty `HERDR_ENV`, whatever
 * its value (ADR 0024). A partial pane environment - the mark set, the
 * binary or the pane id absent - names no target, stands inert beside the
 * old face, and leaves one line in the run's record, so a misconfigured
 * herdr is visible there instead of silent.
 *
 * The report carries `idle`, not a working state: the plane's pane waits on
 * the operator and runs no turn of its own, and the Agents the plane drives
 * report their own states in their own panes. The report is fire-and-forget:
 * herdr is the plane's face, never a gate on its work, so a refused or slow
 * report degrades to the plane's old face instead of holding the boot or the
 * shutdown. The report and the release carry the wall clock read at each end
 * as their sequence; the clock is not monotonic, so a backward step between
 * the run's boot and its end can leave a release the installed herdr takes
 * as a no-op, and the row stands (ADR 0139).
 */
import { type CommandRunner, commandFailureText } from "./runner.ts";

/** The source and the face the plane reports under: one name in both places. */
export const HERDR_IDENTITY_SOURCE = "factory";
export const HERDR_IDENTITY_AGENT = "factory";

/**
 * The report is a small socket write the herdr CLI answers in a couple of
 * hundred milliseconds. The budget is long enough for a loaded machine and
 * short enough that a wedged herdr cannot hold the plane's boot or its
 * shutdown for the command runner's ten-minute handoff budget.
 */
export const HERDR_IDENTITY_TIMEOUT_MS = 5_000;

/** The pane the plane reports from, read from one process environment. */
export interface HerdrIdentityTarget {
	/** The herdr binary that owns the pane. */
	binPath: string;
	/** The pane the plane runs in. */
	paneId: string;
}

/**
 * The pane the plane reports from, from the variables herdr sets on every
 * process in a pane. The in-herdr mark is a non-empty `HERDR_ENV`, whatever
 * its value, the same fact the theme read takes (ADR 0024); the binary and
 * the plane's pane id must stand beside it. Outside herdr the mark is absent
 * and the plane reports nothing: there is no herdr to misread its face.
 */
export function herdrIdentityFromEnv(
	env: Record<string, string | undefined>,
): HerdrIdentityTarget | null {
	const mark = env.HERDR_ENV;
	if (mark === undefined || mark === "") return null;
	const binPath = env.HERDR_BIN_PATH;
	const paneId = env.HERDR_PANE_ID;
	if (binPath === undefined || binPath === "" || paneId === undefined || paneId === "") {
		return null;
	}
	return { binPath, paneId };
}

/**
 * The reporter the plane runs in its own pane. Inside herdr the run gives
 * herdr the plane's face, and `release` gives the pane back.
 */
export interface HerdrIdentityReporter {
	/**
	 * Give the pane back to herdr when the run ends. The release carries the
	 * wall clock read at the end as its sequence, ahead of the boot report's,
	 * so a landed release clears the report at once: on herdr 0.9.1 a release
	 * without a higher sequence is a silent no-op. The wall clock is not
	 * monotonic, so a backward step between the report and the release can
	 * leave the release not ahead of the report, and the installed herdr takes
	 * such a release as a no-op too, with the row standing (ADR 0139). Best
	 * effort: the SIGTERM
	 * and SIGHUP endings call it in their handler and exit before the command
	 * is guaranteed to land, and the `kill -9` and crash endings never reach
	 * it; those endings leave the report standing until the pane is reused,
	 * closed, or the herdr session restarts (herdr 0.9.1 clears no report of
	 * its own when the pane returns to its shell prompt, measured).
	 */
	release(): void;
}

export interface HerdrIdentityReporterOptions {
	/** The process environment the plane booted with. */
	env: Record<string, string | undefined>;
	/** The runner the report and the release go through. */
	runner: CommandRunner;
	/** The clock the report sequence reads. */
	now: () => number;
	/** One line per refused report, and one line for a partial pane environment. */
	log: (line: string) => void;
	/** The report budget. Defaults to `HERDR_IDENTITY_TIMEOUT_MS`. */
	timeoutMs?: number;
}

/**
 * Create the reporter. Inside herdr the creation is the report: it is sent
 * before the plane's first frame, so herdr's first detection of the pane
 * reads the report instead of the process. That ordering is a race the
 * detector can win on the boot screen, and the report's wall-clock sequence
 * stands ahead of the detector's, so the report supersedes the transient
 * detection when it lands (ADR 0139). The run reports once, so the clock's
 * own advance keeps the report ahead of any sequence herdr has already
 * accepted.
 */
export function createHerdrIdentityReporter(
	options: HerdrIdentityReporterOptions,
): HerdrIdentityReporter {
	const target = herdrIdentityFromEnv(options.env);
	if (target === null) {
		const mark = options.env.HERDR_ENV;
		if (mark !== undefined && mark !== "") {
			// The herdr mark stands without the pane's variables: the
			// environment is partial, the report stands inert, and the plane
			// keeps herdr's own reading of its face. One line names the
			// variables the environment is missing, so a misconfigured herdr
			// shows in the run's record.
			const missing: string[] = [];
			if (options.env.HERDR_BIN_PATH === undefined || options.env.HERDR_BIN_PATH === "")
				missing.push("HERDR_BIN_PATH");
			if (options.env.HERDR_PANE_ID === undefined || options.env.HERDR_PANE_ID === "")
				missing.push("HERDR_PANE_ID");
			options.log(
				`herdr identity: the pane environment is partial (absent: ${missing.join(
					", ",
				)}); the report stands inert and herdr keeps its own reading of the pane`,
			);
		}
		return {
			release(): void {},
		};
	}
	const timeoutMs = options.timeoutMs ?? HERDR_IDENTITY_TIMEOUT_MS;
	const send = (args: readonly string[]): void => {
		// Fire-and-forget: the runner's contract is to never throw, and a
		// refused report is a line, not a failure of the run.
		void options.runner.run(target.binPath, [...args], { timeoutMs }).then((result) => {
			if (result.code !== 0) {
				options.log(`herdr identity: ${commandFailureText(result)}`);
			}
		});
	};
	const report = (): void => {
		send([
			"pane",
			"report-agent",
			target.paneId,
			"--source",
			HERDR_IDENTITY_SOURCE,
			"--agent",
			HERDR_IDENTITY_AGENT,
			"--state",
			"idle",
			"--seq",
			String(options.now()),
		]);
	};
	const reporter: HerdrIdentityReporter = {
		release: (): void => {
			send([
				"pane",
				"release-agent",
				target.paneId,
				"--source",
				HERDR_IDENTITY_SOURCE,
				"--agent",
				HERDR_IDENTITY_AGENT,
				"--seq",
				String(options.now()),
			]);
		},
	};
	report();
	return reporter;
}
