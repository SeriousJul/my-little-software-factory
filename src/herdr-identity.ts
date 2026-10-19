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
 * The report carries `idle`, not a working state: the plane's pane waits on
 * the operator and runs no turn of its own, and the Agents the plane drives
 * report their own states in their own panes. The report is fire-and-forget:
 * herdr is the plane's face, never a gate on its work, so a refused or slow
 * report degrades to the plane's old face instead of holding the boot or the
 * shutdown.
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
 * process in a pane. Outside herdr the variables are absent and the plane
 * reports nothing: there is no herdr to misread its face.
 */
export function herdrIdentityFromEnv(
	env: Record<string, string | undefined>,
): HerdrIdentityTarget | null {
	if (env["HERDR_ENV"] !== "1") return null;
	const binPath = env["HERDR_BIN_PATH"];
	const paneId = env["HERDR_PANE_ID"];
	if (binPath === undefined || binPath === "" || paneId === undefined || paneId === "") {
		return null;
	}
	return { binPath, paneId };
}

/**
 * The reporter the plane runs in its own pane. While `reporting` stands the
 * run gave herdr the plane's face, and `release` gives the pane back.
 */
export interface HerdrIdentityReporter {
	/** True when this run reports the plane's face to herdr. */
	readonly reporting: boolean;
	/**
	 * Give the pane back to herdr when the run ends. Best effort: a run herdr
	 * kills outright, as a watch restart does, never reaches this call, and
	 * herdr clears a report of its own once the pane is back at its shell
	 * prompt.
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
	/** One line per refused report. */
	log: (line: string) => void;
	/** The report budget. Defaults to `HERDR_IDENTITY_TIMEOUT_MS`. */
	timeoutMs?: number;
}

/**
 * Create the reporter. Inside herdr the creation is the report: it lands
 * before the plane's first frame, so herdr's first detection of the pane
 * reads the report instead of the process. Every report carries a strictly
 * increasing sequence, from the wall clock: a sequence herdr already
 * accepted is refused, so a late duplicate cannot overwrite a newer fact,
 * and a clock that stands still or steps back cannot repeat one.
 */
export function createHerdrIdentityReporter(
	options: HerdrIdentityReporterOptions,
): HerdrIdentityReporter {
	const target = herdrIdentityFromEnv(options.env);
	if (target === null) {
		return {
			reporting: false,
			release(): void {},
		};
	}
	const timeoutMs = options.timeoutMs ?? HERDR_IDENTITY_TIMEOUT_MS;
	let lastSeq = 0;
	const nextSeq = (): string => {
		lastSeq = Math.max(options.now(), lastSeq + 1);
		return String(lastSeq);
	};
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
			nextSeq(),
		]);
	};
	const reporter: HerdrIdentityReporter = {
		reporting: true,
		release: (): void => {
			send([
				"pane",
				"release-agent",
				target.paneId,
				"--source",
				HERDR_IDENTITY_SOURCE,
				"--agent",
				HERDR_IDENTITY_AGENT,
			]);
		},
	};
	report();
	return reporter;
}
