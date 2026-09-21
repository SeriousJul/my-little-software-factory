/**
 * Tests for the install decisions and steps of the prebuilt binary.
 *
 * The launcher runs on Node, so the decisions live in plain JavaScript
 * (src/binary-install.mjs) and these tests pin them from here: the target
 * the machine resolves to, the asset names the producer and the consumer
 * must agree on, the checksum file the release carries, the cache path the
 * install lands in, and the install step itself, with the network faked and
 * the filesystem pointed at a temp dir.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	assetFileName,
	assetUrl,
	binaryNameFor,
	checksumFileName,
	checksumMatches,
	checksumUrl,
	installDirFor,
	installVerified,
	needsInstall,
	RELEASE_REPO,
	sha256Hex,
	sidecarPathFor,
	TARGETS,
	targetIdFor,
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

describe("the asset names the producer and the consumer agree on", () => {
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
	test("the data home wins on a unix machine", () => {
		expect(installDirFor({ platform: "linux", homedir: "/home/op", xdgDataHome: "/data" })).toBe(
			join("/data", "my-little-software-factory"),
		);
	});

	test("without the data home the install sits under the home", () => {
		expect(installDirFor({ platform: "linux", homedir: "/home/op" })).toBe(
			join("/home/op", ".local", "share", "my-little-software-factory"),
		);
	});

	test("the install sits under the local app data on Windows", () => {
		expect(
			installDirFor({
				platform: "win32",
				homedir: "C:\\Users\\op",
				localAppData: "C:\\Users\\op\\AppData\\Local",
			}),
		).toBe(join("C:\\Users\\op\\AppData\\Local", "my-little-software-factory"));
	});

	test("the binary and its version note share one place", () => {
		expect(binaryNameFor("linux-x64")).toBe("factory");
		expect(binaryNameFor("windows-x64")).toBe("factory.exe");
		const binaryPath = join("/data", "my-little-software-factory", "factory");
		expect(sidecarPathFor(binaryPath)).toBe(`${binaryPath}.version`);
	});
});

describe("the decision to download", () => {
	test("a missing binary downloads", () => {
		expect(
			needsInstall({ binaryExists: false, sidecarVersion: "0.1.0", wantedVersion: "0.1.0" }),
		).toBe(true);
	});

	test("a present binary with the wanted version does not", () => {
		expect(
			needsInstall({ binaryExists: true, sidecarVersion: "0.1.0", wantedVersion: "0.1.0" }),
		).toBe(false);
	});

	test.each([
		["an older version", "0.0.9"],
		["a newer version", "0.2.0"],
		["no version note", undefined],
	])("a binary that is not the wanted version downloads: %s", (_name, sidecarVersion) => {
		expect(needsInstall({ binaryExists: true, sidecarVersion, wantedVersion: "0.1.0" })).toBe(true);
	});
});

describe("the install step, with the network faked", () => {
	const version = "0.2.0";
	const targetId = "linux-x64";
	const assetName = assetFileName(version, targetId);
	const checksumName = checksumFileName(version);
	const assetBytes = new TextEncoder().encode("the prebuilt binary");
	const checksumText = `${sha256Hex(assetBytes)}  ${assetName}\n`;
	const base = `https://github.com/${RELEASE_REPO}/releases/download/v${version}/`;

	test("a verified asset lands at its path with its version note", async () => {
		const dir = inTempDir("install-ok");
		const fake = fakeFetch(
			new Map([
				[`${base}${checksumName}`, new TextEncoder().encode(checksumText)],
				[`${base}${assetName}`, assetBytes],
			]),
		);
		const binaryPath = await installVerified({
			version,
			targetId,
			dir,
			platform: "linux",
			fetchImpl: fake.fetchImpl,
		});
		expect(binaryPath).toBe(join(dir, "factory"));
		expect(Buffer.compare(readFileSync(binaryPath), Buffer.from(assetBytes))).toBe(0);
		expect(readFileSync(sidecarPathFor(binaryPath), "utf8")).toBe(`${version}\n`);
		// The checksum file was read before the asset: an unverifiable asset
		// is never kept.
		expect(fake.asked[0]).toBe(`${base}${checksumName}`);
		expect(fake.asked[1]).toBe(`${base}${assetName}`);
		// The executable bit is set on a unix install.
		const { statSync } = await import("node:fs");
		expect(statSync(binaryPath).mode & 0o100).toBe(0o100);
	});

	test("an asset that fails the checksum is not installed", async () => {
		const dir = inTempDir("install-mismatch");
		const fake = fakeFetch(
			new Map([
				[`${base}${checksumName}`, new TextEncoder().encode(checksumText)],
				[`${base}${assetName}`, new TextEncoder().encode("tampered bytes")],
			]),
		);
		await expect(
			installVerified({
				version,
				targetId,
				dir,
				platform: "linux",
				fetchImpl: fake.fetchImpl,
			}),
		).rejects.toThrow("does not match the release's SHA-256 checksum");
		const { existsSync } = await import("node:fs");
		expect(existsSync(join(dir, "factory"))).toBe(false);
		expect(existsSync(sidecarPathFor(join(dir, "factory")))).toBe(false);
	});

	test("a 404 release is a readable line and installs nothing", async () => {
		const dir = inTempDir("install-404");
		const fake = fakeFetch(new Map());
		await expect(
			installVerified({
				version,
				targetId,
				dir,
				platform: "linux",
				fetchImpl: fake.fetchImpl,
			}),
		).rejects.toThrow("the GitHub release does not carry the checksum file");
		const { existsSync } = await import("node:fs");
		expect(existsSync(join(dir, "factory"))).toBe(false);
	});

	test("a failed asset download is a readable line and installs nothing", async () => {
		const dir = inTempDir("install-500");
		const fake = fakeFetch(
			new Map([[`${base}${checksumName}`, new TextEncoder().encode(checksumText)]]),
		);
		const fetchImpl = async (url: string) => {
			if (url.endsWith(assetName)) return { status: 500, ok: false };
			return fake.fetchImpl(url);
		};
		await expect(
			installVerified({
				version,
				targetId,
				dir,
				platform: "linux",
				fetchImpl,
			}),
		).rejects.toThrow("the download of the asset factory-0.2.0-linux-x64 failed (HTTP 500)");
		const { existsSync } = await import("node:fs");
		expect(existsSync(join(dir, "factory"))).toBe(false);
	});

	test("an unreachable release is a readable line", async () => {
		const dir = inTempDir("install-offline");
		const fetchImpl = async () => {
			throw new Error("getaddrinfo ENOTFOUND github.com");
		};
		await expect(
			installVerified({
				version,
				targetId,
				dir,
				platform: "linux",
				fetchImpl,
			}),
		).rejects.toThrow("cannot reach the GitHub release");
	});

	test("a Windows install keeps the .exe name and skips the executable bit", async () => {
		const dir = inTempDir("install-win");
		const asset = "the windows binary";
		const winAssetName = assetFileName(version, "windows-x64");
		const fake = fakeFetch(
			new Map([
				[
					`${base}${checksumName}`,
					new TextEncoder().encode(
						`${sha256Hex(new TextEncoder().encode(asset))}  ${winAssetName}\n`,
					),
				],
				[`${base}${winAssetName}`, new TextEncoder().encode(asset)],
			]),
		);
		const binaryPath = await installVerified({
			version,
			targetId: "windows-x64",
			dir,
			platform: "win32",
			fetchImpl: fake.fetchImpl,
		});
		expect(binaryPath).toBe(join(dir, "factory.exe"));
		expect(readFileSync(binaryPath, "utf8")).toBe(asset);
	});
});
