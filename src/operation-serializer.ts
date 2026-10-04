/**
 * The Operation serializer: the per-Repository lock.
 *
 * This is a concurrency control, not a Consultation rule, so it stands outside
 * the Consultation rules and is read as what it is: work on one Repository is
 * serialized, and work on another never waits behind it (issue #203). The
 * caller owns the queue map; this module owns the key normalization and the
 * chaining.
 */

/** Serialize topology and cleanup work per Repository without blocking others. */
export function serializeRepositoryOperation<T>(
	queues: Map<string, Promise<void>>,
	repositoryIdentity: string,
	operation: () => Promise<T>,
): Promise<T> {
	const normalized = repositoryIdentity.toLowerCase();
	const key =
		normalized === ""
			? normalized
			: normalized.startsWith("github.com/")
				? normalized
				: `github.com/${normalized}`;
	const previous = queues.get(key) ?? Promise.resolve();
	const current = previous.catch(() => undefined).then(operation);
	const finished = current.then(
		() => undefined,
		() => undefined,
	);
	queues.set(key, finished);
	void finished.then(() => {
		if (queues.get(key) === finished) queues.delete(key);
	});
	return current;
}
