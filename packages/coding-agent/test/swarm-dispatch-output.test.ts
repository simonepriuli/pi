import { getModel } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	buildSwarmWorkerThinkingArgs,
	extractSwarmAssistantCapture,
	formatSwarmWorkerAction,
	mapSwarmWorkerProgress,
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

describe("swarm worker progress details", () => {
	it("maps worker progress into structured details for UI clients", () => {
		const workers = mapSwarmWorkerProgress(
			[
				{ index: 0, status: "running", action: "Exploring files" },
				{ index: 1, status: "queued" },
			],
			["Explore mention/file attachment flow", "Explore work mode workspace cwd"],
		);
		expect(workers).toEqual([
			{
				index: 0,
				status: "running",
				action: "Exploring files",
				preview: undefined,
				task: "Explore mention/file attachment flow",
			},
			{
				index: 1,
				status: "queued",
				action: undefined,
				preview: undefined,
				task: "Explore work mode workspace cwd",
			},
		]);
	});

	it("maps tool names to concise action labels", () => {
		expect(formatSwarmWorkerAction("read")).toBe("Exploring files");
		expect(formatSwarmWorkerAction("bash")).toBe("Running commands");
		expect(formatSwarmWorkerAction("grep")).toBe("Exploring files");
		expect(formatSwarmWorkerAction("custom_tool")).toBe("Working");
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
