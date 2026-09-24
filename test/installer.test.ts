/** The slice of Node's diagnostic report the glibc fact comes from. */
interface ProcessReportHeader {
	header: { glibcVersionRuntime?: string };
}

/**
 * Tests for the install decisions and steps of the prebuilt binary.
 *
 * The launcher runs on Node, so the decisions live in plain JavaScript
 * (src/binary-install.mjs) and these tests pin them from here: the target the
 * machine resolves to, the asset names the producer, the installer, and the
 * release workflow must agree on, the checksum file the release carries, the
 * cache path the install lands in, the install step itself with the network
 * faked, and the whole run with the network and the child process faked. The
 * last group is what the shipped command does on the operator's machine; the
 * section that ends it starts the real bin under Node through the shim shape
 * an npm install writes, with a cache in place so no request is made.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import {
	ASSET_TIMEOUT_MS,
	assetFileName,
	assetUrl,
	BIN_SUBDIR,
	binaryNameFor,
	CHECKSUM_TIMEOUT_MS,
	cacheIsCurrent,
	checksumFileName,
	checksumMatches,
	checksumUrl,
	DATA_DIR,
	DOWNLOAD_TIMEOUT_ENV,
	downloadNote,
	downloadTimeoutOverrideMs,
	formatInstallNote,
	installDirFor,
	installVerified,
	notePathFor,
	parseInstallNote,
	RELEASE_REPO,
	renameFailureLine,
	runInstaller,
	sha256Hex,
	sha256HexOfFile,
	TARGETS,
	targetIdFor,
	versionAnswer,
} from "../src/binary-install.mjs";

const tempDirs: string[] = [];

afterAll(() => {
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function inTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `factory-${prefix}-`));
	tempDirs.push(dir);
	return dir;
}

/** The version the published package carries, the one the run installs. */
function packageJsonVersion(): string {
	return JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")).version;
}

/** Machine facts that point every path decision at one temp home. */
function tempFacts(home: string, overrides: Record<string, unknown> = {}) {
	return {
		platform: "linux",
		arch: "x64",
		glibc: true,
		homedir: home,
		xdgDataHome: join(home, "data-home"),
		...overrides,
	};
}

/** The installed binary's path for one facts set and target. */
function cachedBinaryPath(facts: Record<string, unknown>, targetId: string): string {
	return join(installDirFor(facts, targetId), binaryNameFor(targetId));
}

/** A fetch that serves one named file from memory, and records the asks. */
function fakeFetch(files: Map<string, Uint8Array>) {
	const asked: string[] = [];
	return {
		asked,
		fetchImpl: async (url: string) => {
			asked.push(url);
			const file = files.get(url);
			if (file === undefined) return { status: 404, ok: false };
			const buffer = new Uint8Array(file);
			return { status: 200, ok: true, arrayBuffer: async () => buffer.buffer };
		},
	};
}

/** The one release the installer reads: its checksums file and one asset. */
function fakeRelease(version: string, targetId: string, assetText: string) {
	const assetName = assetFileName(version, targetId);
	const checksumName = checksumFileName(version);
	const base = `https://github.com/${RELEASE_REPO}/releases/download/v${version}/`;
	const assetBytes = new TextEncoder().encode(assetText);
	const fake = fakeFetch(
		new Map([
			[
				`${base}${checksumName}`,
				new TextEncoder().encode(`${sha256Hex(assetBytes)}  ${assetName}\n`),
			],
			[`${base}${assetName}`, assetBytes],
		]),
	);
	return { ...fake, base, assetName, checksumName, assetBytes };
}

/** What the faked child reports about how it ended. */
interface ChildResult {
	status: number | null;
	signal: NodeJS.Signals | null;
	error: Error | undefined;
}

/** An exec recorder: it answers how the child ended and keeps what it ran. */
function fakeExec(result: Partial<ChildResult> = {}) {
	const calls: { binaryPath: string; argv: string[] }[] = [];
	// A field the case names is the answer the child gives, null included; a
	// field it leaves out is the clean end.
	const child: ChildResult = {
		status: result.status === undefined ? 0 : result.status,
		signal: result.signal === undefined ? null : result.signal,
		error: result.error,
	};
	return {
		calls,
		exec: (binaryPath: string, argv: string[]) => {
			calls.push({ binaryPath, argv });
			return child;
		},
	};
}

describe("the target the machine resolves to", () => {
	test.each([
		["glibc x64", { platform: "linux", arch: "x64", glibc: true }, "linux-x64"],
		["glibc arm64", { platform: "linux", arch: "arm64", glibc: true }, "linux-arm64"],
		["musl x64", { platform: "linux", arch: "x64", glibc: false }, "linux-x64-musl"],
		["musl arm64", { platform: "linux", arch: "arm64", glibc: false }, "linux-arm64-musl"],
		["intel macOS", { platform: "darwin", arch: "x64", glibc: false }, "darwin-x64"],
		["Apple Silicon macOS", { platform: "darwin", arch: "arm64", glibc: false }, "darwin-arm64"],
		["x64 Windows", { platform: "win32", arch: "x64", glibc: false }, "windows-x64"],
	])("%s runs %s", (_name, facts, expected) => {
		expect(targetIdFor(facts)).toBe(expected);
	});

	test.each([
		["linux riscv64", { platform: "linux", arch: "riscv64", glibc: true }],
		["arm Windows", { platform: "win32", arch: "arm64", glibc: false }],
		["freebsd x64", { platform: "freebsd", arch: "x64", glibc: true }],
	])("%s has no binary and resolves to null", (_name, facts) => {
		expect(targetIdFor(facts)).toBeNull();
	});

	test("every resolvable target is one the build publishes", () => {
		const resolvable = [
			{ platform: "linux", arch: "x64", glibc: true },
			{ platform: "linux", arch: "arm64", glibc: true },
			{ platform: "linux", arch: "x64", glibc: false },
			{ platform: "linux", arch: "arm64", glibc: false },
			{ platform: "darwin", arch: "x64", glibc: false },
			{ platform: "darwin", arch: "arm64", glibc: false },
			{ platform: "win32", arch: "x64", glibc: false },
		];
		const ids = resolvable
			.map((facts) => targetIdFor(facts))
			.filter((id) => id !== null)
			.map((id) => String(id));
		const allTargets: string[] = [...TARGETS];
		expect([...ids].sort()).toEqual(allTargets.sort());
	});
});

describe("the asset names the producer, the installer, and the release agree on", () => {
	test.each([
		["linux-x64", "factory-0.2.0-linux-x64"],
		["linux-x64-musl", "factory-0.2.0-linux-x64-musl"],
		["linux-arm64", "factory-0.2.0-linux-arm64"],
		["darwin-arm64", "factory-0.2.0-darwin-arm64"],
		["windows-x64", "factory-0.2.0-windows-x64.exe"],
	])("the asset for %s is %s", (targetId, expected) => {
		expect(assetFileName("0.2.0", targetId)).toBe(expected);
	});

	test("the checksum file names the version only", () => {
		expect(checksumFileName("0.2.0")).toBe("factory-0.2.0.sha256sums");
	});

	test("the download addresses point at the release of this version", () => {
		expect(assetUrl("0.2.0", "linux-x64")).toBe(
			`https://github.com/${RELEASE_REPO}/releases/download/v0.2.0/factory-0.2.0-linux-x64`,
		);
		expect(checksumUrl("0.2.0")).toBe(
			`https://github.com/${RELEASE_REPO}/releases/download/v0.2.0/factory-0.2.0.sha256sums`,
		);
	});
});

describe("the checksum file the release carries", () => {
	const digest = sha256Hex(new TextEncoder().encode("the asset"));
	const checksumText = [
		`${digest}  factory-0.2.0-linux-x64`,
		`${digest} *factory-0.2.0-darwin-arm64`,
		`${digest}  factory-0.2.0-windows-x64.exe`,
		"",
	].join("\n");

	test("a present line with the digest matches", () => {
		expect(checksumMatches(checksumText, "factory-0.2.0-linux-x64", digest)).toBe(true);
	});

	test("the binary-read star is accepted", () => {
		expect(checksumMatches(checksumText, "factory-0.2.0-darwin-arm64", digest)).toBe(true);
	});

	test("a different digest is a mismatch", () => {
		expect(checksumMatches(checksumText, "factory-0.2.0-linux-x64", "f".repeat(64))).toBe(false);
	});

	test("a file the checksum file does not name is a mismatch", () => {
		expect(checksumMatches(checksumText, "factory-0.3.0-linux-x64", digest)).toBe(false);
	});
});

describe("the cache path the install lands in", () => {
	test("the data home wins on a unix machine, and the target keys the path", () => {
		expect(
			installDirFor({ platform: "linux", homedir: "/home/op", xdgDataHome: "/data" }, "linux-x64"),
		).toBe(join("/data", DATA_DIR, "bin", "linux-x64"));
	});

	test("two targets of one shared home never share one cache", () => {
		const facts = { platform: "linux", homedir: "/home/op", xdgDataHome: "/data" };
		expect(installDirFor(facts, "linux-x64")).not.toBe(installDirFor(facts, "linux-arm64"));
	});

	test("without the data home the install sits under the home", () => {
		expect(installDirFor({ platform: "linux", homedir: "/home/op" }, "linux-x64")).toBe(
			join("/home/op", ".local", "share", DATA_DIR, "bin", "linux-x64"),
		);
	});

	test("the install sits under the local app data on Windows", () => {
		expect(
			installDirFor(
				{
					platform: "win32",
					homedir: "C:\\Users\\op",
					localAppData: "C:\\Users\\op\\AppData\\Local",
				},
				"windows-x64",
			),
		).toBe(join("C:\\Users\\op\\AppData\\Local", DATA_DIR, "bin", "windows-x64"));
	});

	// An empty or relative data home is no data home: the XDG Base Directory
	// specification says to ignore it, and src/config.ts does the same for
	// XDG_STATE_HOME. A relative base lands the cache in the working directory,
	// where a planted binary arrives with a note of its own, and the note's
	// digest is the check a cache is held to.
	test.each([
		["the empty string", ""],
		["a relative path", "./.local/share"],
		["a bare name", "share"],
	])("a data home that is %s is treated as unset", (_name, value) => {
		const facts = { platform: "linux", homedir: "/home/op", xdgDataHome: value };
		expect(installDirFor(facts, "linux-x64")).toBe(
			join("/home/op", ".local", "share", DATA_DIR, "bin", "linux-x64"),
		);
	});

	test("a relative local app data is treated as unset", () => {
		const facts = { platform: "win32", homedir: "C:\\Users\\op", localAppData: "AppData\\Local" };
		expect(installDirFor(facts, "windows-x64")).toBe(
			join("C:\\Users\\op", "AppData", "Local", DATA_DIR, "bin", "windows-x64"),
		);
	});

	test("a Windows absolute local app data is a usable one", () => {
		// The absolute test is the target platform's, not the host's: a
		// LOCALAPPDATA value like `C:\Users\op\AppData\Local` is not absolute by
		// the POSIX rule, and treating it as unset would move a Windows machine's
		// cache without naming a reason.
		const facts = {
			platform: "win32",
			homedir: "C:\\Users\\op",
			localAppData: "D:\\factory-cache",
		};
		expect(installDirFor(facts, "windows-x64")).toBe(
			join("D:\\factory-cache", DATA_DIR, "bin", "windows-x64"),
		);
	});

	test("the install directory needs the target it is for", () => {
		expect(() => installDirFor({ platform: "linux", homedir: "/home/op" }, "")).toThrow(
			"needs the machine's target id",
		);
	});

	test("the binary and its install note share one place", () => {
		expect(binaryNameFor("linux-x64")).toBe("factory");
		expect(binaryNameFor("windows-x64")).toBe("factory.exe");
		const binaryPath = join("/data", DATA_DIR, "bin", "linux-x64", "factory");
		expect(notePathFor(binaryPath)).toBe(`${binaryPath}.install`);
	});
});

describe("the install note beside the cached binary", () => {
	const digest = "a".repeat(64);

	test("the note names the version, the target, and the digest, and reads back", () => {
		const text = formatInstallNote({ version: "0.2.0", targetId: "linux-x64", digest });
		expect(parseInstallNote(text)).toEqual({ version: "0.2.0", targetId: "linux-x64", digest });
	});

	test.each([
		["no text at all", ""],
		["no digest", "version=0.2.0\ntarget=linux-x64\n"],
		["a short digest", "version=0.2.0\ntarget=linux-x64\ndigest=abc\n"],
		["no target", `version=0.2.0\ndigest=${digest}\n`],
		["no version", `target=linux-x64\ndigest=${digest}\n`],
		["a line that is not a field", `garbage\ndigest=${digest}\n`],
	])("a note that cannot be trusted is no note: %s", (_name, text) => {
		expect(parseInstallNote(text)).toBeUndefined();
	});

	test("a note read from a path that is not there is no note", () => {
		const missing = join(inTempDir("note-absent"), "factory.install");
		expect(parseInstallNote(readFileSyncOrNull(missing))).toBeUndefined();
	});

	test("the digest of a file is the digest of its bytes, read in chunks", () => {
		const path = join(inTempDir("note-digest"), "factory");
		const bytes = new Uint8Array(3 * 1024 * 1024 + 7).fill(7);
		writeFileSync(path, bytes);
		expect(sha256HexOfFile(path)).toBe(sha256Hex(bytes));
	});

	test("the digest of a file that is not there is undefined", () => {
		expect(sha256HexOfFile(join(inTempDir("note-absent-file"), "factory"))).toBeUndefined();
	});
});

/** A file's text, or the empty string where it cannot be read. */
function readFileSyncOrNull(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

describe("the decision to reuse the cached binary", () => {
	const digest = sha256Hex(new TextEncoder().encode("the prebuilt binary"));
	const note = { version: "0.2.0", targetId: "linux-x64", digest };

	test("the note names this version and target, and the bytes match the note", () => {
		expect(
			cacheIsCurrent({
				note,
				wantedVersion: "0.2.0",
				wantedTargetId: "linux-x64",
				cachedDigest: digest,
			}),
		).toBe(true);
	});

	test("the digest is read case-insensitively", () => {
		expect(
			cacheIsCurrent({
				note: { ...note, digest: digest.toUpperCase() },
				wantedVersion: "0.2.0",
				wantedTargetId: "linux-x64",
				cachedDigest: digest,
			}),
		).toBe(true);
	});

	test.each([
		["no note at all", undefined, digest],
		["a binary that is not there", note, undefined],
		["a binary whose bytes changed", note, sha256Hex(new TextEncoder().encode("tampered"))],
	])("a cache that cannot be accounted for re-downloads: %s", (_name, cached, onDisk) => {
		expect(
			cacheIsCurrent({
				note: cached,
				wantedVersion: "0.2.0",
				wantedTargetId: "linux-x64",
				cachedDigest: onDisk,
			}),
		).toBe(false);
	});

	test.each([
		["an older version cached", { wantedVersion: "0.3.0" }],
		["another target on a shared home", { wantedTargetId: "linux-arm64" }],
	])("the cache heals for %s", (_name, override) => {
		expect(
			cacheIsCurrent({
				note,
				wantedVersion: "0.2.0",
				wantedTargetId: "linux-x64",
				cachedDigest: digest,
				...override,
			}),
		).toBe(false);
	});
});

describe("the install step, with the network faked", () => {
	const version = "0.2.0";
	const targetId = "linux-x64";

	test("a verified asset lands at its path with its install note", async () => {
		const dir = inTempDir("install-ok");
		const release = fakeRelease(version, targetId, "the prebuilt binary");
		const binaryPath = await installVerified({
			version,
			targetId,
			dir,
			platform: "linux",
			fetchImpl: release.fetchImpl,
		});
		expect(binaryPath).toBe(join(dir, "factory"));
		expect(Buffer.compare(readFileSync(binaryPath), Buffer.from(release.assetBytes))).toBe(0);
		expect(parseInstallNote(readFileSync(notePathFor(binaryPath), "utf8"))).toEqual({
			version,
			targetId,
			digest: sha256Hex(release.assetBytes),
		});
		// The checksum file was read before the asset: an unverifiable asset
		// is never kept.
		expect(release.asked[0]).toBe(`${release.base}${release.checksumName}`);
		expect(release.asked[1]).toBe(`${release.base}${release.assetName}`);
		// The executable bit is set on a unix install.
		if (process.platform !== "win32") {
			expect(statSync(binaryPath).mode & 0o100).toBe(0o100);
		}
	});

	test("the install directory and its note are private to their owner", async () => {
		const home = inTempDir("install-mode");
		const dir = installDirFor(tempFacts(home), targetId);
		const binaryPath = await installVerified({
			version,
			targetId,
			dir,
			platform: "linux",
			fetchImpl: fakeRelease(version, targetId, "bytes").fetchImpl,
		});
		// No group and no other bits: a shared home cannot hold a binary or a
		// note this run would later trust.
		if (process.platform !== "win32") {
			expect(statSync(dir).mode & 0o077).toBe(0);
			expect(statSync(notePathFor(binaryPath)).mode & 0o077).toBe(0);
		}
	});

	test("an asset that fails the checksum is not installed", async () => {
		const dir = inTempDir("install-mismatch");
		const good = new TextEncoder().encode("the real bytes");
		const fake = fakeFetch(
			new Map([
				[
					checksumUrl(version),
					new TextEncoder().encode(`${sha256Hex(good)}  ${assetFileName(version, targetId)}\n`),
				],
				[assetUrl(version, targetId), new TextEncoder().encode("tampered bytes")],
			]),
		);
		await expect(
			installVerified({ version, targetId, dir, platform: "linux", fetchImpl: fake.fetchImpl }),
		).rejects.toThrow("does not match the release's SHA-256 checksum");
		expect(existsSync(join(dir, "factory"))).toBe(false);
		expect(existsSync(notePathFor(join(dir, "factory")))).toBe(false);
	});

	test("a 404 release is a readable line and installs nothing", async () => {
		const dir = inTempDir("install-404");
		const fake = fakeFetch(new Map());
		await expect(
			installVerified({ version, targetId, dir, platform: "linux", fetchImpl: fake.fetchImpl }),
		).rejects.toThrow("the GitHub release does not carry the checksum file");
		expect(existsSync(join(dir, "factory"))).toBe(false);
	});

	test("a failed asset download is a readable line and installs nothing", async () => {
		const dir = inTempDir("install-500");
		const release = fakeRelease(version, targetId, "the real bytes");
		const assetName = assetFileName(version, targetId);
		const fetchImpl = async (url: string) => {
			if (url.endsWith(assetName)) return { status: 500, ok: false };
			return release.fetchImpl(url);
		};
		await expect(
			installVerified({ version, targetId, dir, platform: "linux", fetchImpl }),
		).rejects.toThrow(`the download of the asset ${assetName} failed (HTTP 500)`);
		expect(existsSync(join(dir, "factory"))).toBe(false);
	});

	test("an unreachable release is a readable line", async () => {
		const dir = inTempDir("install-offline");
		const fetchImpl = async () => {
			throw new Error("getaddrinfo ENOTFOUND github.com");
		};
		await expect(
			installVerified({ version, targetId, dir, platform: "linux", fetchImpl }),
		).rejects.toThrow("cannot reach the GitHub release");
	});

	test("a stalled download ends on its timeout instead of hanging the run", async () => {
		const dir = inTempDir("install-stall");
		// The fake answers only when its signal says stop, the way a socket
		// that never delivers does.
		const fetchImpl = (_url: string, init: { signal: AbortSignal }) =>
			new Promise((_resolve, reject) => {
				if (init.signal.aborted) {
					reject(new Error("This operation was aborted"));
					return;
				}
				init.signal.addEventListener("abort", () => reject(new Error("socket hang up")));
			});
		await expect(
			installVerified({
				version,
				targetId,
				dir,
				platform: "linux",
				fetchImpl,
				checksumTimeoutMs: 20,
			}),
		).rejects.toThrow(
			`the checksum file did not finish downloading within ${0.02} s; nothing was installed. A slow connection can be given more time with ${DOWNLOAD_TIMEOUT_ENV}`,
		);
		expect(existsSync(join(dir, "factory"))).toBe(false);
	});

	test("every download carries the timeout signal", async () => {
		const dir = inTempDir("install-signal");
		const release = fakeRelease(version, targetId, "bytes");
		const seen: (AbortSignal | undefined)[] = [];
		const fetchImpl = async (url: string, init: { signal?: AbortSignal }) => {
			seen.push(init?.signal);
			return release.fetchImpl(url);
		};
		await installVerified({
			version,
			targetId,
			dir,
			platform: "linux",
			fetchImpl,
			checksumTimeoutMs: 5_000,
			assetTimeoutMs: 5_000,
		});
		expect(seen).toHaveLength(2);
		for (const signal of seen) {
			expect(signal).toBeInstanceOf(AbortSignal);
			expect(signal?.aborted).toBe(false);
		}
	});

	test("a Windows install keeps the .exe name", async () => {
		const dir = inTempDir("install-win");
		const release = fakeRelease(version, "windows-x64", "the windows binary");
		const binaryPath = await installVerified({
			version,
			targetId: "windows-x64",
			dir,
			platform: "win32",
			fetchImpl: release.fetchImpl,
		});
		expect(binaryPath).toBe(join(dir, "factory.exe"));
		expect(readFileSync(binaryPath, "utf8")).toBe("the windows binary");
	});

	test("a rename the system refuses because the binary runs says what to do", () => {
		expect(renameFailureLine({ platform: "win32", binaryName: "factory.exe", code: "EBUSY" })).toBe(
			"cannot replace the running factory.exe: close the control plane that is already running, then run the command again",
		);
		expect(
			renameFailureLine({ platform: "win32", binaryName: "factory.exe", code: "EACCES" }),
		).toBeDefined();
		// A unix busy rename, and any other code, stay the raw failure: nothing
		// the operator can do is hidden behind a line about closing the app.
		expect(
			renameFailureLine({ platform: "linux", binaryName: "factory", code: "EBUSY" }),
		).toBeUndefined();
		expect(
			renameFailureLine({ platform: "win32", binaryName: "factory.exe", code: "ENOSPC" }),
		).toBeUndefined();
	});
});

describe("the whole run, with the network and the child process faked", () => {
	const version = "0.2.0";
	const targetId = "linux-x64";

	test("a machine with no cache downloads, installs, and runs the binary", async () => {
		const home = inTempDir("run-first");
		const facts = tempFacts(home);
		const release = fakeRelease(version, targetId, "the prebuilt binary");
		const exec = fakeExec();
		const outcome = await runInstaller({
			facts,
			version,
			argv: ["--config", "/tmp/one.toml"],
			fetchImpl: release.fetchImpl,
			exec: exec.exec,
		});
		expect(outcome).toEqual({ kind: "exit", code: 0 });
		expect(exec.calls).toEqual([
			{ binaryPath: cachedBinaryPath(facts, targetId), argv: ["--config", "/tmp/one.toml"] },
		]);
		expect(release.asked).toEqual([
			`${release.base}${release.checksumName}`,
			`${release.base}${release.assetName}`,
		]);
	});

	test("a second run reads the note, checks the bytes, and makes no request", async () => {
		const home = inTempDir("run-cached");
		const facts = tempFacts(home);
		const release = fakeRelease(version, targetId, "the prebuilt binary");
		await runInstaller({
			facts,
			version,
			fetchImpl: release.fetchImpl,
			exec: fakeExec().exec,
		});
		const askedAfterFirst = release.asked.length;
		const exec = fakeExec({ status: 3 });
		const outcome = await runInstaller({
			facts,
			version,
			fetchImpl: release.fetchImpl,
			exec: exec.exec,
		});
		expect(outcome).toEqual({ kind: "exit", code: 3 });
		expect(release.asked).toHaveLength(askedAfterFirst);
	});

	test("a new version downloads its own binary", async () => {
		const home = inTempDir("run-upgrade");
		const facts = tempFacts(home);
		const old = fakeRelease(version, targetId, "the old binary");
		await runInstaller({ facts, version, fetchImpl: old.fetchImpl, exec: fakeExec().exec });
		const newer = fakeRelease("0.3.0", targetId, "the new binary");
		const outcome = await runInstaller({
			facts,
			version: "0.3.0",
			fetchImpl: newer.fetchImpl,
			exec: fakeExec().exec,
		});
		expect(outcome).toEqual({ kind: "exit", code: 0 });
		expect(newer.asked).toHaveLength(2);
		const binaryPath = cachedBinaryPath(facts, targetId);
		expect(readFileSync(binaryPath, "utf8")).toBe("the new binary");
		expect(parseInstallNote(readFileSync(notePathFor(binaryPath), "utf8"))).toEqual({
			version: "0.3.0",
			targetId,
			digest: sha256Hex(newer.assetBytes),
		});
	});

	test("a damaged cache re-downloads instead of failing the run", async () => {
		const home = inTempDir("run-damaged");
		const facts = tempFacts(home);
		const release = fakeRelease(version, targetId, "the prebuilt binary");
		await runInstaller({ facts, version, fetchImpl: release.fetchImpl, exec: fakeExec().exec });
		const binaryPath = cachedBinaryPath(facts, targetId);
		writeFileSync(binaryPath, "overwritten by something else");
		const exec = fakeExec();
		const outcome = await runInstaller({
			facts,
			version,
			fetchImpl: release.fetchImpl,
			exec: exec.exec,
		});
		expect(outcome).toEqual({ kind: "exit", code: 0 });
		// The second run took the network again and left the good bytes in place.
		expect(release.asked).toHaveLength(4);
		expect(readFileSync(binaryPath, "utf8")).toBe("the prebuilt binary");
		expect(exec.calls).toHaveLength(1);
	});

	test("another target's note in a shared home cannot be trusted", async () => {
		const home = inTempDir("run-shared-home");
		const facts = tempFacts(home);
		const binaryPath = cachedBinaryPath(facts, targetId);
		mkdirSync(installDirFor(facts, targetId), { recursive: true, mode: 0o700 });
		writeFileSync(binaryPath, "a binary this kernel cannot run");
		writeFileSync(
			notePathFor(binaryPath),
			formatInstallNote({
				version,
				targetId: "linux-arm64",
				digest: sha256HexOfFile(binaryPath),
			}),
			"utf8",
		);
		const release = fakeRelease(version, targetId, "the right binary");
		const outcome = await runInstaller({
			facts,
			version,
			fetchImpl: release.fetchImpl,
			exec: fakeExec().exec,
		});
		expect(outcome).toEqual({ kind: "exit", code: 0 });
		expect(release.asked).toHaveLength(2);
		expect(readFileSync(binaryPath, "utf8")).toBe("the right binary");
	});

	test("a planted cache at a relative data home cannot be the one that runs", async () => {
		// The review's repro, held to its shape: an empty XDG_DATA_HOME used to
		// resolve the cache against the working directory, where the planted
		// binary and its note arrive together and the note's own digest is the
		// check - so the digest passes and the planted program runs with no
		// network at all. The value is ignored now, the cache lands under the
		// home, and the run has to reach the release.
		const workdir = inTempDir("run-planted-relative-cwd");
		const home = inTempDir("run-planted-relative-home");
		const previous = process.cwd();
		process.chdir(workdir);
		try {
			const facts = tempFacts(home, { xdgDataHome: "" });
			// The path the old decision produced: the empty value used as the
			// base, so the result was relative and resolved against the working
			// directory. It is written out here rather than through installDirFor,
			// because installDirFor no longer produces it.
			const plantedDir = join(".", DATA_DIR, BIN_SUBDIR, targetId);
			mkdirSync(plantedDir, { recursive: true, mode: 0o700 });
			const plantedPath = join(plantedDir, binaryNameFor(targetId));
			writeFileSync(plantedPath, "a program that is not the control plane");
			writeFileSync(
				notePathFor(plantedPath),
				formatInstallNote({
					version,
					targetId,
					digest: sha256HexOfFile(plantedPath),
				}),
				"utf8",
			);
			const release = fakeRelease(version, targetId, "the real binary");
			const exec = fakeExec();
			const outcome = await runInstaller({
				facts,
				version,
				fetchImpl: release.fetchImpl,
				exec: exec.exec,
			});
			expect(outcome).toEqual({ kind: "exit", code: 0 });
			expect(release.asked).toHaveLength(2);
			// What ran is the release's bytes under the home, not the planted file
			// beside the checkout.
			expect(exec.calls[0]?.binaryPath).toBe(cachedBinaryPath(facts, targetId));
			expect(isAbsolute(exec.calls[0]?.binaryPath ?? "")).toBe(true);
			expect(readFileSync(join(workdir, plantedPath), "utf8")).toBe(
				"a program that is not the control plane",
			);
		} finally {
			process.chdir(previous);
		}
	});

	test("a machine the release builds nothing for is one readable line", async () => {
		const home = inTempDir("run-no-target");
		const release = fakeRelease(version, targetId, "bytes");
		const exec = fakeExec();
		const outcome = await runInstaller({
			facts: tempFacts(home, { platform: "freebsd", arch: "x64" }),
			version,
			fetchImpl: release.fetchImpl,
			exec: exec.exec,
		});
		expect(outcome).toEqual({
			kind: "fail",
			line: `the control plane has no binary for freebsd-x64; supported targets: ${TARGETS.join(", ")}`,
		});
		expect(exec.calls).toHaveLength(0);
		expect(release.asked).toHaveLength(0);
	});

	test("an install that cannot be verified is the failure line, and nothing runs", async () => {
		const home = inTempDir("run-404");
		const missing = fakeFetch(new Map());
		const exec = fakeExec();
		const outcome = await runInstaller({
			facts: tempFacts(home),
			version,
			fetchImpl: missing.fetchImpl,
			exec: exec.exec,
		});
		expect(outcome.kind).toBe("fail");
		expect((outcome as { line: string }).line).toContain(
			"the GitHub release does not carry the checksum file",
		);
		expect(exec.calls).toHaveLength(0);
	});

	test("a binary that will not start is a failure line naming the path", async () => {
		const home = inTempDir("run-exec-fails");
		const facts = tempFacts(home);
		const release = fakeRelease(version, targetId, "bytes");
		const exec = fakeExec({ error: new Error("ENOEXEC: cannot execute binary file") });
		const outcome = await runInstaller({
			facts,
			version,
			fetchImpl: release.fetchImpl,
			exec: exec.exec,
		});
		expect(outcome).toEqual({
			kind: "fail",
			line: `cannot run the control plane binary at ${cachedBinaryPath(facts, targetId)}: ENOEXEC: cannot execute binary file`,
		});
	});

	test("a child the operator signalled ends as a signal to re-raise", async () => {
		const home = inTempDir("run-signal");
		const release = fakeRelease(version, targetId, "bytes");
		const outcome = await runInstaller({
			facts: tempFacts(home),
			version,
			fetchImpl: release.fetchImpl,
			exec: fakeExec({ status: null, signal: "SIGINT" }).exec,
		});
		expect(outcome).toEqual({ kind: "signal", signal: "SIGINT" });
	});

	test("a child that reported no code and no signal is a failed run", async () => {
		const home = inTempDir("run-no-code");
		const release = fakeRelease(version, targetId, "bytes");
		const outcome = await runInstaller({
			facts: tempFacts(home),
			version,
			fetchImpl: release.fetchImpl,
			exec: fakeExec({ status: null }).exec,
		});
		expect(outcome).toEqual({ kind: "exit", code: 1 });
	});

	// The flag's whole point (ADR 0056) is that it answers on a machine with no
	// state. Paying for a ~100 MB download to print one line contradicts that,
	// so the installer answers it from the version it installs when the cache
	// holds no binary, and the exec path stays the answer once it does.
	test("a cold --version answers from the installer and downloads nothing", async () => {
		const home = inTempDir("run-version-cold");
		const release = fakeRelease(version, targetId, "bytes");
		const exec = fakeExec();
		const outcome = await runInstaller({
			facts: tempFacts(home),
			version,
			argv: ["--version"],
			fetchImpl: release.fetchImpl,
			exec: exec.exec,
		});
		expect(outcome).toEqual({ kind: "print", line: `factory ${version}` });
		expect(release.asked).toHaveLength(0);
		expect(exec.calls).toHaveLength(0);
	});

	test("a cached --version still goes to the binary itself", async () => {
		const home = inTempDir("run-version-warm");
		const facts = tempFacts(home);
		const release = fakeRelease(version, targetId, "bytes");
		await runInstaller({ facts, version, fetchImpl: release.fetchImpl, exec: fakeExec().exec });
		const exec = fakeExec();
		const outcome = await runInstaller({
			facts,
			version,
			argv: ["--version"],
			fetchImpl: release.fetchImpl,
			exec: exec.exec,
		});
		// The answer the operator reads comes from the program the flag names, so
		// a warm cache execs as any other argument list does.
		expect(outcome).toEqual({ kind: "exit", code: 0 });
		expect(exec.calls).toEqual([
			{ binaryPath: cachedBinaryPath(facts, targetId), argv: ["--version"] },
		]);
	});

	test("a --version beside another argument is not the version flag", async () => {
		const home = inTempDir("run-version-mixed");
		const release = fakeRelease(version, targetId, "bytes");
		const outcome = await runInstaller({
			facts: tempFacts(home),
			version,
			argv: ["--version", "--config", "/tmp/one.toml"],
			fetchImpl: release.fetchImpl,
			exec: fakeExec().exec,
		});
		expect(outcome).toEqual({ kind: "exit", code: 0 });
		// The list is the app's to answer, so the install runs and the binary takes
		// the arguments as written.
		expect(release.asked).toHaveLength(2);
	});

	test("the first run says it is downloading before it asks for anything", async () => {
		const home = inTempDir("run-download-note");
		const facts = tempFacts(home);
		const release = fakeRelease(version, targetId, "the prebuilt binary");
		// What had been asked for when the note was written: nothing. The note
		// exists so a slow transfer is not mistaken for a hang, and a line written
		// after the first request - or after the bytes land - cannot do that.
		const askedAtNote: string[] = [];
		const notes: string[] = [];
		await runInstaller({
			facts,
			version,
			fetchImpl: release.fetchImpl,
			report: (line: string) => {
				notes.push(line);
				askedAtNote.push(release.asked.join(","));
			},
		});
		expect(notes).toEqual([downloadNote(version, targetId)]);
		expect(askedAtNote).toEqual([""]);
		expect(release.asked).toEqual([
			`${release.base}${release.checksumName}`,
			`${release.base}${release.assetName}`,
		]);
	});

	test("a cached run writes no note and makes no request", async () => {
		const home = inTempDir("run-cached-note");
		const facts = tempFacts(home);
		const release = fakeRelease(version, targetId, "bytes");
		const notes: string[] = [];
		await runInstaller({
			facts,
			version,
			fetchImpl: release.fetchImpl,
			report: (l) => notes.push(l),
		});
		const before = release.asked.length;
		await runInstaller({
			facts,
			version,
			fetchImpl: release.fetchImpl,
			report: (l) => notes.push(l),
		});
		expect(notes).toHaveLength(1);
		expect(release.asked).toHaveLength(before);
	});
});

describe("the version answer and the download note, as text", () => {
	test("--version alone is the only list the installer answers itself", () => {
		expect(versionAnswer(["--version"], "0.2.0")).toBe("factory 0.2.0");
		expect(versionAnswer([], "0.2.0")).toBeUndefined();
		expect(versionAnswer(["--version", "--json"], "0.2.0")).toBeUndefined();
		expect(versionAnswer(["--config", "x.toml"], "0.2.0")).toBeUndefined();
	});

	test("the installer's line is the answer the compiled binary gives", () => {
		// src/factory.ts writes `factory <version>` for the same flag: the two
		// answers are read as one product line, so they cannot drift by accident.
		const entry = readFileSync(join(import.meta.dir, "..", "src", "factory.ts"), "utf8");
		// The version answer and the download note must reach the operator's
		// terminal, so this test names them by a marker built without a live
		// template placeholder.
		const dollar = String.fromCharCode(36);
		const line = ["`factory ", dollar, "{await factoryVersion()}\\n`"].join("");
		expect(entry).toContain(line);
		expect(versionAnswer(["--version"], "0.2.0")).toBe("factory 0.2.0");
	});

	test("the note names the asset the run is about to transfer", () => {
		expect(downloadNote("0.2.0", "linux-x64")).toBe(
			"the control plane is not installed for linux-x64 yet; downloading " +
				"factory-0.2.0-linux-x64 from the release. It happens once per version.",
		);
	});
});

describe("the download bounds", () => {
	test("the small file and the whole runtime are not bound by one number", () => {
		// 300 bytes and about 100 MB, fetched in one install: a single bound can
		// only be right for one of them.
		expect(CHECKSUM_TIMEOUT_MS).toBe(30_000);
		expect(ASSET_TIMEOUT_MS).toBeGreaterThan(CHECKSUM_TIMEOUT_MS);
	});

	test.each([
		["unset", undefined, ASSET_TIMEOUT_MS],
		["empty", "", ASSET_TIMEOUT_MS],
		["a real override", "900000", 900_000],
		["spaces around the number", " 45000 ", 45_000],
		["not a number", "soon", ASSET_TIMEOUT_MS],
		["zero", "0", ASSET_TIMEOUT_MS],
		["a negative bound", "-5", ASSET_TIMEOUT_MS],
	])("the override %s gives the default or the number", (_name, value, expected) => {
		expect(downloadTimeoutOverrideMs(ASSET_TIMEOUT_MS, value)).toBe(expected);
	});
});

describe("the shipped bin, started the way npm starts it", () => {
	const REAL_BIN = join(import.meta.dir, "..", "bin", "factory-bin.mjs");

	/** The facts the spawned bin resolves for this machine. */
	function machineFacts(home: string) {
		const header = (process.report.getReport() as unknown as ProcessReportHeader).header;
		return {
			platform: process.platform,
			arch: process.arch,
			glibc: typeof header.glibcVersionRuntime === "string",
			homedir: home,
			xdgDataHome: join(home, "data-home"),
			localAppData: join(home, "local-app-data"),
		};
	}

	/**
	 * A cache already in place for this machine and version, holding a script
	 * instead of a real binary: the run has no reason to reach the network, and
	 * the script's own output is what proves the exec happened.
	 */
	function seedCache(home: string): string {
		const facts = machineFacts(home);
		const targetId = targetIdFor(facts);
		expect(targetId).not.toBeNull();
		const binaryPath = cachedBinaryPath(facts, targetId as string);
		mkdirSync(installDirFor(facts, targetId as string), { recursive: true, mode: 0o700 });
		const marker = "the cached control plane ran";
		const script =
			process.platform === "win32"
				? `@echo off\r\necho ${marker} %1\r\nexit /b 42\r\n`
				: `#!/bin/sh\necho ${marker} "$1"\nexit 42\n`;
		writeFileSync(binaryPath, script);
		if (process.platform !== "win32") chmodSync(binaryPath, 0o755);
		writeFileSync(
			notePathFor(binaryPath),
			formatInstallNote({
				version: packageJsonVersion(),
				targetId: targetId as string,
				digest: sha256HexOfFile(binaryPath),
			}),
			"utf8",
		);
		return marker;
	}

	/** Start the published entry under Node, the runtime npx provides. */
	function runUnderNode(entryPath: string, argv: string[], home: string) {
		const env = {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			XDG_DATA_HOME: join(home, "data-home"),
			LOCALAPPDATA: join(home, "local-app-data"),
		};
		if (process.platform === "win32" && entryPath.endsWith(".cmd")) {
			return spawnSync(entryPath, argv, { encoding: "utf8", env, shell: true, timeout: 60_000 });
		}
		return spawnSync("node", [entryPath, ...argv], { encoding: "utf8", env, timeout: 60_000 });
	}

	test("node is on this machine, the runtime the published bin runs on", () => {
		const probe = spawnSync("node", ["--version"], { encoding: "utf8" });
		expect(probe.status).toBe(0);
	});

	test("an npm bin shim reaches the install step and runs the cached binary", () => {
		const home = inTempDir("bin-shim");
		const marker = seedCache(home);
		// The shape npm writes: a launcher in a bin directory that names the
		// package's real bin. Node realpaths the module URL of the file it runs
		// but not argv[1], so a guard that compares the two by their given paths
		// matches nothing here.
		const shimDir = join(home, "node_modules", ".bin");
		mkdirSync(shimDir, { recursive: true });
		let shim: string;
		if (process.platform === "win32") {
			shim = join(shimDir, "factory.cmd");
			writeFileSync(shim, `@echo off\r\nnode "${REAL_BIN}" %*\r\n`);
		} else {
			shim = join(shimDir, "factory");
			symlinkSync(REAL_BIN, shim);
		}

		const result = runUnderNode(shim, ["--config", "/tmp/one.toml"], home);
		// Before the guard resolved both sides, this was the whole failure: the
		// run section was skipped, and the process ended 0 with no output, no
		// install, and no error.
		expect(result.status).toBe(42);
		expect(result.stdout).toContain(marker);
		expect(result.stdout).toContain("--config");
		expect(result.stderr).not.toContain("mlsf:");
	});

	test("the same bin by its real path runs the same way", () => {
		const home = inTempDir("bin-real");
		const marker = seedCache(home);
		const result = runUnderNode(REAL_BIN, ["--version"], home);
		expect(result.status).toBe(42);
		expect(result.stdout).toContain(marker);
		expect(result.stderr).not.toContain("mlsf:");
	});

	test("a cold --version answers through the shipped bin, with no cache and no request", () => {
		// The empty home holds no cache, so the only way this prints a version is
		// the installer's own answer: the flag that exists to work on a machine
		// with no state cannot pay for the binary to do it (ADR 0056). Nothing on
		// this machine holds the release's bytes for this version either - the
		// run that reached the network would say so in its own line.
		const home = inTempDir("bin-version-cold");
		const result = runUnderNode(REAL_BIN, ["--version"], home);
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe(`factory ${packageJsonVersion()}`);
		expect(result.stderr).toBe("");
		// No cache was written for a line the launcher already knew.
		expect(
			existsSync(installDirFor(machineFacts(home), targetIdFor(machineFacts(home)) as string)),
		).toBe(false);
	});

	test("a child the signal killed ends the shipped bin by that signal, not by 0", () => {
		const home = inTempDir("bin-signal");
		// The seeded cache runs a script that kills itself, the way the operator's
		// Ctrl+C ends the real binary.
		const facts = machineFacts(home);
		const targetId = targetIdFor(facts) as string;
		const binaryPath = cachedBinaryPath(facts, targetId);
		mkdirSync(installDirFor(facts, targetId), { recursive: true, mode: 0o700 });
		const script =
			process.platform === "win32"
				? "@echo off\r\nexit /b 0\r\n"
				: "#!/bin/sh\nkill -TERM $$\nsleep 5\n";
		writeFileSync(binaryPath, script);
		if (process.platform !== "win32") chmodSync(binaryPath, 0o755);
		writeFileSync(
			notePathFor(binaryPath),
			formatInstallNote({
				version: packageJsonVersion(),
				targetId,
				digest: sha256HexOfFile(binaryPath),
			}),
			"utf8",
		);

		const result = runUnderNode(REAL_BIN, [], home);
		if (process.platform === "win32") {
			// The cmd script ends by its own code: the shape this machine can
			// measure is the unix one below.
			expect(result.status).toBe(0);
			return;
		}
		// The launcher re-raised the child's signal on itself, so the process the
		// operator sees died of SIGTERM with no exit code of its own.
		expect(result.signal).toBe("SIGTERM");
		expect(result.status).toBeNull();
	});
});
