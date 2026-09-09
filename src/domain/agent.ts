/**
 * The agent-side domain facts the control plane shares across every Agent
 * type.
 *
 * The Thinking level set is one standard set (ADR 0010): the union of the
 * levels the supported agent runtimes accept. An Agent type declares the
 * subset it maps, so the override panel and the startup check always have a
 * list to work with, and a config never depends on an agent's own spelling of
 * a level.
 */

/** The standard Thinking levels, from no reasoning to the deepest. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** One Thinking level of the standard set. */
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

const LEVELS: readonly string[] = THINKING_LEVELS;

/** The standard levels, in one readable list, for an error message. */
export function thinkingLevelList(): string {
	return LEVELS.join(", ");
}

/** True when a config value names a standard Thinking level. */
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && LEVELS.includes(value);
}
