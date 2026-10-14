import type { AppBootFields, AppSetup } from "./app-harness.ts";
import { withApp } from "./app-harness.ts";
import type { Plane, PlaneStanding } from "./plane.ts";
import { plane } from "./plane.ts";

/**
 * Boot the app on the plane a test stands up, and run the test body on the
 * boot it answers. The body receives the rig's setup and the plane record
 * beside it: the record's fake runner, its state, and its home are the body's
 * way to answer the plane, and the rig owns the boot, the wait, and the
 * teardown the boot stands on. A body that stands the app at its own size
 * passes the boot fields the frame needs, named against the plane record the
 * boot stands on, so a field that reads the record names it once. A world
 * the body stands up before the boot - a broken checkout path, a held model
 * list - goes out through the pre-boot step, so the plane's boot probe sees
 * the world the way the test stands it.
 */
export async function appOn(
	standing: PlaneStanding,
	fn: (setup: AppSetup, planeRecord: Plane) => Promise<void>,
	options?: (planeRecord: Plane) => AppBootFields,
	preBoot?: (planeRecord: Plane) => void | Promise<void>,
): Promise<void> {
	const planeRecord = await plane(standing);
	if (preBoot !== undefined) await preBoot(planeRecord);
	await withApp(async (setup) => {
		await fn(setup, planeRecord);
	}, options?.(planeRecord));
}
