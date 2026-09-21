#!/usr/bin/env bun
/**
 * Standalone bin wrapper for the shared control gallery.
 *
 * Bun's FFI is stable and built in, so the gallery entry runs directly in this
 * process with no flag and no re-spawn. The gallery is a development tool, not
 * a published entry, so it carries no runtime floor of its own.
 */
await import("../src/gallery.ts");
