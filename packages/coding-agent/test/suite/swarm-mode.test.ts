import { afterEach, describe, expect, it } from "vitest";
import type { Harness } from "./harness.ts";
import { createHarness } from "./harness.ts";

describe("Swarm mode", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("toggles swarm mode state without removing swarm_dispatch", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		expect(harness.session.swarmMode).toBe(false);
		expect(harness.session.getAllTools().map((tool) => tool.name)).toContain("swarm_dispatch");
		expect(harness.session.getActiveToolNames()).toContain("swarm_dispatch");
		expect(harness.session.systemPrompt).toContain("swarm_dispatch");

		harness.session.setSwarmMode(true);
		expect(harness.session.swarmMode).toBe(true);
		expect(harness.session.getActiveToolNames()).toContain("swarm_dispatch");
		expect(harness.session.systemPrompt).toContain("Swarm mode is enabled");
		expect(harness.session.systemPrompt).toContain("Never claim swarm work has started");

		harness.session.setSwarmMode(false);
		expect(harness.session.swarmMode).toBe(false);
		expect(harness.session.getActiveToolNames()).toContain("swarm_dispatch");
		expect(harness.session.systemPrompt).toContain("Swarm mode is disabled");
	});
});
