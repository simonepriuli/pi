import { describe, expect, it } from "vitest";
import {
	formatCodexLimitError,
	formatCodexResetDelay,
	formatCodexStreamErrorEvent,
} from "../src/providers/codex-limit-error.ts";

describe("codex-limit-error", () => {
	it("formats reset delay in days for long windows", () => {
		expect(formatCodexResetDelay(2_398_228)).toBe(" Try again in ~28 days.");
	});

	it("formats reset delay in hours for sub-day windows", () => {
		expect(formatCodexResetDelay(7_200)).toBe(" Try again in ~2 hours.");
	});

	it("formats reset delay in minutes for short windows", () => {
		expect(formatCodexResetDelay(1_800)).toBe(" Try again in ~30 min.");
	});

	it("formats usage limit from nested SSE error events", () => {
		const event = {
			type: "error",
			error: {
				type: "usage_limit_reached",
				message: "The usage limit has been reached",
				plan_type: "go",
				resets_at: 1_785_399_393,
				resets_in_seconds: 2_398_228,
			},
			status_code: 429,
		};

		const formatted = formatCodexStreamErrorEvent(event);
		expect(formatted.message).toBe("You have hit your ChatGPT usage limit (go plan). Try again in ~28 days.");
		expect(formatted.code).toBe("usage_limit_reached");
	});

	it("formats usage limit from HTTP-style error bodies", () => {
		const message = formatCodexLimitError(
			{
				type: "usage_limit_reached",
				message: "The usage limit has been reached",
				plan_type: "go",
				resets_in_seconds: 2_398_228,
			},
			429,
		);
		expect(message).toBe("You have hit your ChatGPT usage limit (go plan). Try again in ~28 days.");
	});

	it("falls back to nested message for non-limit stream errors", () => {
		const formatted = formatCodexStreamErrorEvent({
			type: "error",
			error: {
				type: "server_error",
				message: "Upstream unavailable",
			},
		});
		expect(formatted.message).toBe("Upstream unavailable");
		expect(formatted.code).toBe("server_error");
	});
});
