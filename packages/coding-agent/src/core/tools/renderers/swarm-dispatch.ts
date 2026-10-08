/**
 * Presentation for the swarm_dispatch tool, apart from its implementation like the other
 * built-in renderers. `swarm-dispatch.ts` spreads these into its definition.
 */

import { Text } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "../../extensions/types.ts";

export const swarmDispatchRenderers: Pick<ToolDefinition<any, any, any>, "renderCall"> = {
	renderCall(args, theme) {
		const tasks = (args as { tasks?: unknown[] } | undefined)?.tasks;
		const text = `swarm_dispatch ${tasks?.length ?? 0} tasks`;
		return new Text(theme.fg("toolTitle", theme.bold(text)), 0, 0);
	},
};
