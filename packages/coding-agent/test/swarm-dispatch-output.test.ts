import { getModel } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	buildSwarmWorkerThinkingArgs,
	extractSwarmAssistantCapture,
	resolveSwarmWorkerOutput,
} from "../src/core/tools/swarm-dispatch.ts";

describe("swarm worker thinking args", () => {
	it("forces a thinking level for reasoning models so OpenRouter does not get effort none", () => {
		const model = getModel("openrouter", "openai/gpt-oss-120b:free");
		expect(buildSwarmWorkerThinkingArgs(model)).toEqual(["--thinking", "low"]);
	});

	it("does not pass thinking flags for non-reasoning models", () => {
		const model = getModel("openai", "gpt-4o-mini");
		expect(buildSwarmWorkerThinkingArgs(model)).toEqual([]);
	});
});

describe("swarm worker output extraction", () => {
	it("extracts text and thinking from assistant messages", () => {
		const capture = extractSwarmAssistantCapture({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "internal notes" },
				{ type: "text", text: "visible answer" },
			],
			stopReason: "stop",
		});
		expect(capture).toEqual({
			text: "visible answer",
			thinking: "internal notes",
			stopReason: "stop",
			errorMessage: undefined,
		});
	});

	it("prefers the latest assistant text across turns", () => {
		const { output, success } = resolveSwarmWorkerOutput({
			captures: [
				{ text: "first", thinking: "" },
				{ text: "", thinking: "" },
				{ text: "final", thinking: "" },
			],
			stderr: "",
			exitCode: 0,
		});
		expect(success).toBe(true);
		expect(output).toBe("final");
	});

	it("falls back to thinking when no text was emitted", () => {
		const { output, success } = resolveSwarmWorkerOutput({
			captures: [{ text: "", thinking: "only reasoning", stopReason: "stop" }],
			stderr: "",
			exitCode: 0,
		});
		expect(success).toBe(true);
		expect(output).toBe("[reasoning] only reasoning");
	});

	it("marks empty completions as failures with a helpful message", () => {
		const { output, success } = resolveSwarmWorkerOutput({
			captures: [{ text: "", thinking: "", stopReason: "toolUse" }],
			stderr: "",
			exitCode: 0,
		});
		expect(success).toBe(false);
		expect(output).toContain("without text output");
		expect(output).toContain("toolUse");
	});
});
