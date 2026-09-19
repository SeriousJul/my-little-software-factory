/**
 * A drop-in for the vitest environment stubs (`vi.stubEnv` /
 * `vi.unstubAllEnvs`) on the bun:test runner, which has no built-in env
 * stubbing. Each stubbed key is saved on first stub and restored by
 * `unstubAllEnvs`, matching vitest: a key is returned to its pre-stub value,
 * or removed if it was unset.
 */
const saved = new Map<string, string | undefined>();

/** Set an environment variable for the rest of the current test. */
export function stubEnv(key: string, value: string): void {
	if (!saved.has(key)) saved.set(key, process.env[key]);
	process.env[key] = value;
}

/** Restore every variable stubbed by `stubEnv` since the last call. */
export function unstubAllEnvs(): void {
	for (const [key, original] of saved) {
		if (original === undefined) delete process.env[key];
		else process.env[key] = original;
	}
	saved.clear();
}
