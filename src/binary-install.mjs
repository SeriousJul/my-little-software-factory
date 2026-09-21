/**
 * The decisions and steps that install the prebuilt binary.
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
 * src/runtime-support.mjs; the network and the exec live in the bin's run
 * section.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The repository the release workflow publishes from. */
export const RELEASE_REPO = "SeriousJul/my-little-software-factory";

/** The directory the installed binary lives in, under the data home. */
export const DATA_DIR = "my-little-software-factory";

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

/** The directory the installed binary lives in, under the machine's data home. */
export function installDirFor(facts) {
	if (facts.platform === "win32") {
		const local = facts.localAppData ?? join(facts.homedir, "AppData", "Local");
		return join(local, DATA_DIR);
	}
	const base = facts.xdgDataHome ?? join(facts.homedir, ".local", "share");
	return join(base, DATA_DIR);
}

/** The installed binary's file name, per target. */
export function binaryNameFor(targetId) {
	return targetId.startsWith("windows") ? "factory.exe" : "factory";
}

/** The version note beside the installed binary. */
export function sidecarPathFor(binaryPath) {
	return `${binaryPath}.version`;
}

/**
 * Whether a run takes the download step: the binary is absent, or its
 * version note names a version other than the one the package carries.
 * The sidecar's absence is a re-download: a binary without its note is a
 * binary the launcher cannot trust to be the one it wants.
 */
export function needsInstall(facts) {
	if (!facts.binaryExists) return true;
	return facts.sidecarVersion !== facts.wantedVersion;
}

/** The SHA-256 of a buffer, in the hex the checksum file carries. */
export function sha256Hex(data) {
	return createHash("sha256").update(data).digest("hex");
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
	const { version, targetId, dir, platform, fetchImpl } = options;
	const fetcher = fetchImpl ?? fetch;
	const binaryName = binaryNameFor(targetId);
	const binaryPath = join(dir, binaryName);
	const sidecarPath = sidecarPathFor(binaryPath);
	const assetName = assetFileName(version, targetId);

	const checksumText = await downloadText(checksumUrl(version), fetcher, "checksum file");
	const asset = await downloadBuffer(assetUrl(version, targetId), fetcher, `asset ${assetName}`);
	if (!checksumMatches(checksumText, assetName, sha256Hex(asset))) {
		throw new Error(
			`the downloaded ${assetName} does not match the release's SHA-256 checksum; nothing was installed`,
		);
	}

	mkdirSync(dir, { recursive: true });
	const tempPath = `${binaryPath}.tmp-${process.pid}-${Date.now()}`;
	try {
		writeFileSync(tempPath, asset);
		if (platform !== "win32") chmodSync(tempPath, 0o755);
		renameSync(tempPath, binaryPath);
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
	writeFileSync(sidecarPath, `${version}\n`, "utf8");
	return binaryPath;
}

/** Fetch one file's text, with a readable line where the release is missing or unreachable. */
async function downloadText(url, fetcher, what) {
	const buffer = await downloadBuffer(url, fetcher, what);
	return Buffer.from(buffer).toString("utf8");
}

/** Fetch one file's bytes, with a readable line where the release is missing or unreachable. */
async function downloadBuffer(url, fetcher, what) {
	let response;
	try {
		response = await fetcher(url);
	} catch (error) {
		throw new Error(`cannot reach the GitHub release (fetching the ${what}): ${String(error)}`);
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
	const bytes = await response.arrayBuffer();
	return new Uint8Array(bytes);
}
