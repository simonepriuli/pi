export type CodexLimitErrorBody = {
	code?: string;
	type?: string;
	message?: string;
	plan_type?: string;
	resets_at?: number;
	resets_in_seconds?: number;
};

export function formatCodexResetDelay(seconds: number | undefined): string {
	if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) {
		return "";
	}
	const mins = Math.round(seconds / 60);
	if (mins < 60) {
		return ` Try again in ~${mins} min.`;
	}
	const hours = Math.round(mins / 60);
	if (hours < 24) {
		return ` Try again in ~${hours} hour${hours === 1 ? "" : "s"}.`;
	}
	const days = Math.round(hours / 24);
	return ` Try again in ~${days} day${days === 1 ? "" : "s"}.`;
}

export function getCodexResetDelaySeconds(err: CodexLimitErrorBody): number | undefined {
	if (typeof err.resets_in_seconds === "number" && Number.isFinite(err.resets_in_seconds)) {
		return Math.max(0, err.resets_in_seconds);
	}
	if (typeof err.resets_at === "number" && Number.isFinite(err.resets_at)) {
		return Math.max(0, err.resets_at - Date.now() / 1000);
	}
	return undefined;
}

export function isCodexUsageLimitError(code: string, statusCode?: number): boolean {
	if (/usage_limit_reached|usage_not_included|rate_limit_exceeded/i.test(code)) {
		return true;
	}
	return statusCode === 429;
}

export function formatCodexLimitError(err: CodexLimitErrorBody, statusCode?: number): string | undefined {
	const code = err.code || err.type || "";
	if (!isCodexUsageLimitError(code, statusCode)) {
		return undefined;
	}
	const plan = err.plan_type ? ` (${err.plan_type.toLowerCase()} plan)` : "";
	const when = formatCodexResetDelay(getCodexResetDelaySeconds(err));
	return `You have hit your ChatGPT usage limit${plan}.${when}`.trim();
}

export function formatCodexStreamErrorEvent(event: Record<string, unknown>): { message: string; code?: string } {
	const nested = event.error as CodexLimitErrorBody | undefined;
	const statusCode = typeof event.status_code === "number" ? event.status_code : undefined;
	const topLevelCode = typeof event.code === "string" ? event.code : "";
	const topLevelMessage = typeof event.message === "string" ? event.message : "";

	if (nested) {
		const friendly = formatCodexLimitError(nested, statusCode);
		const code = nested.type || nested.code || topLevelCode;
		const message = nested.message || topLevelMessage;
		if (friendly) {
			return { message: friendly, code: code || undefined };
		}
		if (message) {
			return { message, code: code || undefined };
		}
		if (code) {
			return { message: code, code };
		}
	}

	if (topLevelMessage || topLevelCode) {
		return { message: topLevelMessage || topLevelCode, code: topLevelCode || undefined };
	}

	return { message: `Codex error: ${JSON.stringify(event)}` };
}
