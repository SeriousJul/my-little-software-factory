/**
 * The decisions and steps that install and run the prebuilt binary.
 *
 * The prebuilt binary is the executable the operator's machine runs
 * (ADR 0056): the release build compiles it per target, and the npm package
 * publishes this module and the thin bin around it instead of the app's
 * source. The launcher resolves the machine's target, takes this package
 * version's binary from the release's GitHub Release, verifies it against
 * the release's SHA-256 checksums, caches it under the data home, and hands
 * it the operator's arguments.
 *
 * Plain JavaScript on purpose: the published package runs on Node, where a
 * .ts module is not a file the runtime reads. The unit tests pin the
 * decisions from here, the way they pin the runtime support from
 * src/runtime-support.mjs: the whole run, `runInstaller` included, reads the
 * machine's facts and takes the network and the child process as injected
 * values, so the bin is the entry plus the entry guard and the process exits.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** The repository the release workflow publishes from. */
export const RELEASE_REPO = "SeriousJul/my-little-software-factory";

/** The directory the installed binary lives in, under the data home. */
export const DATA_DIR = "my-little-software-factory";

/** The subdirectory of the data directory the installed binaries live under. */
export const BIN_SUBDIR = "bin";

/** Every target the release publishes, in the order the checksums list them. */
export const TARGETS = [
	"linux-x64",
	"linux-x64-musl",
	"linux-arm64",
	"linux-arm64-musl",
	"darwin-x64",
	"darwin-arm64",
	"windows-x64",
];

/**
 * How long one download may take before the installer gives up on it. The
 * release's binary is a whole Bun runtime plus the app, so the bound is
 * generous; it exists so a stalled network cannot hang the run forever.
 */
export const DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * The target the machine runs, or null where the release carries none.
 *
 * The facts come from the process: its platform and architecture, and
 * whether the runtime is linked against glibc. On a musl system the glibc
 * fact is absent, so its absence is the musl answer.
 */
export function targetIdFor(facts) {
	const { platform, arch } = facts;
	if (platform === "linux") {
		if (arch === "x64") return facts.glibc ? "linux-x64" : "linux-x64-musl";
		if (arch === "arm64") return facts.glibc ? "linux-arm64" : "linux-arm64-musl";
		return null;
	}
	if (platform === "darwin") {
		if (arch === "x64") return "darwin-x64";
		if (arch === "arm64") return "darwin-arm64";
		return null;
	}
	if (platform === "win32") {
		if (arch === "x64") return "windows-x64";
		return null;
	}
	return null;
}

/** The release asset's file name: the version and the target, `.exe` on Windows. */
export function assetFileName(version, targetId) {
	const extension = targetId.startsWith("windows") ? ".exe" : "";
	return `factory-${version}-${targetId}${extension}`;
}

/** The checksum file's name, beside the assets in the release. */
export function checksumFileName(version) {
	return `factory-${version}.sha256sums`;
}

/** The release's download address of one asset. */
export function assetUrl(version, targetId) {
	return `https://github.com/${RELEASE_REPO}/releases/download/v${version}/${assetFileName(version, targetId)}`;
}

/** The release's download address of the checksum file. */
export function checksumUrl(version) {
	return `https://github.com/${RELEASE_REPO}/releases/download/v${version}/${checksumFileName(version)}`;
}

/**
 * Whether the checksum file carries the file's digest.
 *
 * A line is `<digest>  <name>`; the `*` that marks a binary read is
 * accepted. A name the file does not carry is a mismatch, not a pass.
 */
export function checksumMatches(checksumText, fileName, digestHex) {
	const wanted = digestHex.toLowerCase();
	for (const line of checksumText.split(/\r?\n/)) {
		const match = line.match(/^([0-9a-fA-F]{64})\s+\*?(\S+)$/);
		if (match === null || match[2] !== fileName) continue;
		return match[1].toLowerCase() === wanted;
	}
	return false;
}

/**
 * The directory one target's installed binary lives in, under the machine's
 * data home.
 *
 * The target id is part of the path: two machines of different architecture
 * that share one home - an NFS home, a moved profile - must not read each
 * other's note and exec a binary their kernel cannot run.
 */
export function installDirFor(facts, targetId) {
	if (targetId === undefined || targetId === "") {
		throw new Error("the install directory needs the machine's target id");
	}
	if (facts.platform === "win32") {
		const local = facts.localAppData ?? join(facts.homedir, "AppData", "Local");
		return join(local, DATA_DIR, BIN_SUBDIR, targetId);
	}
	const base = facts.xdgDataHome ?? join(facts.homedir, ".local", "share");
	return join(base, DATA_DIR, BIN_SUBDIR, targetId);
}

/** The installed binary's file name, per target. */
export function binaryNameFor(targetId) {
	return targetId.startsWith("windows") ? "factory.exe" : "factory";
}

/** The install note beside the installed binary. */
export function notePathFor(binaryPath) {
	return `${binaryPath}.install`;
}

/**
 * The install note's text: the version, the target, and the binary's
 * SHA-256, one `key=value` per line. The digest is what lets a later run
 * check the cached bytes without the network.
 */
export function formatInstallNote(record) {
	return `version=${record.version}\ntarget=${record.targetId}\ndigest=${record.digest}\n`;
}

/**
 * The install note as a value, or undefined where it cannot be trusted.
 *
 * A note the parser cannot read - missing, empty, a field absent, a digest
 * that is not 64 hex digits - is no note: the run re-downloads rather than
 * exec a binary it cannot account for.
 */
export function parseInstallNote(text) {
	if (typeof text !== "string" || text === "") return undefined;
	const fields = new Map();
	for (const line of text.split(/\r?\n/)) {
		if (line === "") continue;
		const separator = line.indexOf("=");
		if (separator < 0) return undefined;
		fields.set(line.slice(0, separator), line.slice(separator + 1));
	}
	const version = fields.get("version");
	const targetId = fields.get("target");
	const digest = fields.get("digest");
	if (typeof version !== "string" || version === "") return undefined;
	if (typeof targetId !== "string" || targetId === "") return undefined;
	if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) return undefined;
	return { version, targetId, digest };
}

/** The note read from disk, or undefined where it is missing or unreadable. */
export function readInstallNote(notePath) {
	try {
		return parseInstallNote(readFileSync(notePath, "utf8").trim());
	} catch {
		return undefined;
	}
}

/**
 * Whether the cached binary may run as it stands: the note names this
 * version and this target, and the digest the note carries is the digest of
 * the bytes on disk.
 *
 * A false answer is a re-download, never a failure: a note from another
 * machine's target, a binary that was overwritten, and a damaged file all
 * heal the same way.
 */
export function cacheIsCurrent(check) {
	const { note, wantedVersion, wantedTargetId, cachedDigest } = check;
	if (note === undefined) return false;
	if (note.version !== wantedVersion) return false;
	if (note.targetId !== wantedTargetId) return false;
	if (cachedDigest === undefined) return false;
	return cachedDigest.toLowerCase() === note.digest.toLowerCase();
}

/** The SHA-256 of a buffer, in the hex the checksum file carries. */
export function sha256Hex(data) {
	return createHash("sha256").update(data).digest("hex");
}

/**
 * The SHA-256 of a file, read in chunks, or undefined where the file cannot
 * be read. A release binary is a whole runtime, so the read never lands the
 * whole file in memory.
 */
export function sha256HexOfFile(path) {
	let handle;
	try {
		handle = openSync(path, "r");
	} catch {
		return undefined;
	}
	try {
		const hash = createHash("sha256");
		const chunk = Buffer.allocUnsafe(1024 * 1024);
		let position = 0;
		for (;;) {
			const read = readSync(handle, chunk, 0, chunk.length, position);
			if (read === 0) break;
			hash.update(chunk.subarray(0, read));
			position += read;
		}
		return hash.digest("hex");
	} catch {
		return undefined;
	} finally {
		try {
			closeSync(handle);
		} catch {
			// The hash is already taken or already failed; the handle is not the run's problem.
		}
	}
}

/**
 * Download one asset and verify it against the release's checksum file,
 * then install it at its path: the temp file and the rename keep a failed
 * download from leaving a half-written binary behind.
 *
 * The checksum is fetched first and checked before anything is written.
 * `fetchImpl` is injectable; the default is the runtime's fetch, and the
 * tests pass a fake that serves from memory.
 */
export async function installVerified(options) {
	const { version, targetId, dir, platform, fetchImpl, timeoutMs = DOWNLOAD_TIMEOUT_MS } = options;
	const fetcher = fetchImpl ?? fetch;
	const binaryName = binaryNameFor(targetId);
	const binaryPath = join(dir, binaryName);
	const notePath = notePathFor(binaryPath);
	const assetName = assetFileName(version, targetId);

	const checksumText = await downloadText(
		checksumUrl(version),
		fetcher,
		"checksum file",
		timeoutMs,
	);
	const asset = await downloadBuffer(
		assetUrl(version, targetId),
		fetcher,
		`asset ${assetName}`,
		timeoutMs,
	);
	const digest = sha256Hex(asset);
	if (!checksumMatches(checksumText, assetName, digest)) {
		throw new Error(
			`the downloaded ${assetName} does not match the release's SHA-256 checksum; nothing was installed`,
		);
	}

	// The private mode keeps a shared home from letting another user plant a
	// binary the next run would trust.
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const tempPath = `${binaryPath}.tmp-${process.pid}-${Date.now()}`;
	try {
		writeFileSync(tempPath, asset);
		if (platform !== "win32") chmodSync(tempPath, 0o755);
		try {
			renameSync(tempPath, binaryPath);
		} catch (error) {
			// On Windows the rename of a .exe another instance still runs is the
			// busy case, and its raw code says nothing the operator can act on.
			const line = renameFailureLine({ platform, binaryName, code: error?.code });
			if (line !== undefined) throw new Error(line);
			throw error;
		}
	} finally {
		// A failed write leaves no temp file behind for the next run. A
		// finished install has already renamed the temp away, so the name is
		// gone and this is a no-op.
		try {
			if (existsSync(tempPath)) rmSync(tempPath, { force: true });
		} catch {
			// The install failed already; a left-behind temp name is cosmetic.
		}
	}
	writeFileSync(notePath, formatInstallNote({ version, targetId, digest }), {
		encoding: "utf8",
		mode: 0o600,
	});
	return binaryPath;
}

/**
 * The whole run of the installer: resolve the target, reuse or install the
 * cached binary, and hand it the operator's arguments.
 *
 * Everything it touches from the outside is a value: `facts` are the
 * machine's, `argv` the operator's arguments, `fetchImpl` the network, and
 * `exec` the child process.
 * The function returns what the entry does - a line to show and a failure, an
 * exit code, or a signal to re-raise - and never touches `process.exit`
 * itself, so a unit test drives the path the shipped command takes.
 *
 * @param {object} options
 * @param {{platform: string, arch: string, glibc: boolean, homedir: string, xdgDataHome?: string, localAppData?: string}} options.facts
 * @param {string} options.version
 * @param {string[]} [options.argv]
 * @param {(url: string, init: {signal: AbortSignal}) => Promise<object>} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @param {(binaryPath: string, argv: string[]) => {status: number | null, signal: string | null, error: Error | undefined}} [options.exec]
 * @param {(path: string) => string | undefined} [options.readDigest]
 */
export async function runInstaller({
	facts,
	version,
	argv = [],
	fetchImpl,
	timeoutMs = DOWNLOAD_TIMEOUT_MS,
	exec = defaultExec,
	readDigest = sha256HexOfFile,
}) {
	const targetId = targetIdFor(facts);
	if (targetId === null) {
		return {
			kind: "fail",
			line:
				`the control plane has no binary for ${facts.platform}-${facts.arch}; ` +
				`supported targets: ${TARGETS.join(", ")}`,
		};
	}
	const dir = installDirFor(facts, targetId);
	const binaryPath = join(dir, binaryNameFor(targetId));
	const note = readInstallNote(notePathFor(binaryPath));

	if (
		!cacheIsCurrent({
			note,
			wantedVersion: version,
			wantedTargetId: targetId,
			cachedDigest: existsSync(binaryPath) ? readDigest(binaryPath) : undefined,
		})
	) {
		try {
			await installVerified({
				version,
				targetId,
				dir,
				platform: facts.platform,
				fetchImpl,
				timeoutMs,
			});
		} catch (error) {
			return { kind: "fail", line: errorMessage(error) };
		}
	}

	const child = exec(binaryPath, argv);
	if (child.error !== null && child.error !== undefined) {
		return {
			kind: "fail",
			line: `cannot run the control plane binary at ${binaryPath}: ${errorMessage(child.error)}`,
		};
	}
	// The child took the operator's signal: the entry ends this process the
	// same way, the shape the old alias process forwarded.
	if (child.signal !== null && child.signal !== undefined) {
		return { kind: "signal", signal: child.signal };
	}
	return { kind: "exit", code: child.status ?? 1 };
}

/** The message of an error, without the `Error:` prefix the value carries. */
export function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The readable line for a rename the operating system refused because the
 * binary is in use, or undefined where the code is not the busy one.
 *
 * Windows reports a rename over a running `.exe` as `EBUSY`, `EPERM`, or
 * `EACCES` depending on what holds the file; on any platform the rest of the
 * codes stay the raw failure they are, because nothing the operator can do
 * fixes them.
 */
export function renameFailureLine(refused) {
	if (refused.platform !== "win32") return undefined;
	if (!["EBUSY", "EPERM", "EACCES"].includes(refused.code)) return undefined;
	return `cannot replace the running ${refused.binaryName}: close the control plane that is already running, then run the command again`;
}

/**
 * Run the installed binary in the operator's terminal and report how it ended,
 * as the three facts the run reads: the exit code, the signal that took it, and
 * the error that stopped it from starting.
 */
function defaultExec(binaryPath, argv) {
	const child = spawnSync(binaryPath, argv, { stdio: "inherit" });
	return {
		status: typeof child.status === "number" ? child.status : null,
		signal: typeof child.signal === "string" ? child.signal : null,
		error: child.error,
	};
}

/** Fetch one file's text, with a readable line where the release is missing or unreachable. */
async function downloadText(url, fetcher, what, timeoutMs) {
	const buffer = await downloadBuffer(url, fetcher, what, timeoutMs);
	return Buffer.from(buffer).toString("utf8");
}

/** Fetch one file's bytes, with a readable line where the release is missing or unreachable. */
async function downloadBuffer(url, fetcher, what, timeoutMs) {
	const signal = AbortSignal.timeout(timeoutMs);
	let response;
	try {
		response = await fetcher(url, { signal });
	} catch (error) {
		throw fetchFailure(what, error, signal);
	}
	if (response.status === 404) {
		throw new Error(
			`the GitHub release does not carry the ${what}; the release for this version is incomplete, and nothing was installed`,
		);
	}
	if (!response.ok) {
		throw new Error(
			`the download of the ${what} failed (HTTP ${String(response.status)}); nothing was installed`,
		);
	}
	try {
		const bytes = await response.arrayBuffer();
		return new Uint8Array(bytes);
	} catch (error) {
		// The body arrives after the response, so a stall or a half-sent file
		// is caught here rather than at the fetch.
		throw fetchFailure(what, error, signal);
	}
}

/** One readable line for a download that never finished, named for its cause. */
function fetchFailure(what, error, signal) {
	if (signal.aborted) {
		return new Error(
			`the download of the ${what} stopped: the GitHub release did not answer within the timeout; nothing was installed`,
		);
	}
	return new Error(`cannot reach the GitHub release (fetching the ${what}): ${String(error)}`);
}
