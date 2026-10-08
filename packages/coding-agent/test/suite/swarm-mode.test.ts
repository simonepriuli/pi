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

	it("declares swarm_dispatch only while swarm mode is on", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		expect(harness.session.swarmMode).toBe(false);
		expect(harness.session.getAllTools().map((tool) => tool.name)).toContain("swarm_dispatch");
		expect(harness.session.getActiveToolNames()).not.toContain("swarm_dispatch");
		expect(harness.session.systemPrompt).not.toContain("swarm_dispatch");

		harness.session.setSwarmMode(true);
		expect(harness.session.swarmMode).toBe(true);
		expect(harness.session.getActiveToolNames()).toContain("swarm_dispatch");
		expect(harness.session.systemPrompt).toContain("Swarm mode is enabled");
		expect(harness.session.systemPrompt).toContain("Never claim swarm work has started");

		harness.session.setSwarmMode(false);
		expect(harness.session.swarmMode).toBe(false);
		expect(harness.session.getActiveToolNames()).not.toContain("swarm_dispatch");
		expect(harness.session.systemPrompt).not.toContain("Swarm mode is enabled");
	});
});
