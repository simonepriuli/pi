import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const DEFAULT_MODEL = "kimi-k2.6";
const MAX_SWARM_TASKS = 10;
const MAX_CONCURRENCY = 4;
const MAX_OUTPUT_CHARS = 8000;
const WORKER_TIMEOUT_MS = 5 * 60 * 1000;

const swarmDispatchSchema = Type.Object({
	tasks: Type.Array(Type.String({ description: "Subtask prompt for a delegated sub-agent." }), {
		minItems: 1,
		maxItems: MAX_SWARM_TASKS,
		description: "List of subtasks to run in parallel. Hard limit: 10 tasks.",
	}),
	model: Type.Optional(
		Type.String({
			description: `Model used for delegated workers. Defaults to ${DEFAULT_MODEL}.`,
		}),
	),
	concurrency: Type.Optional(
		Type.Number({
			minimum: 1,
			maximum: MAX_CONCURRENCY,
			description: `Maximum number of workers running concurrently. Max ${MAX_CONCURRENCY}.`,
		}),
	),
});

export type SwarmDispatchToolInput = Static<typeof swarmDispatchSchema>;

interface SwarmDispatchDetails {
	model: string;
	concurrency: number;
	totalTasks: number;
}

interface WorkerResult {
	index: number;
	task: string;
	success: boolean;
	output: string;
}

type WorkerStatus = "queued" | "running" | "done" | "error";

interface WorkerProgress {
	index: number;
	status: WorkerStatus;
	preview?: string;
}

type ProviderModelRef = {
	provider: string;
	id: string;
};

function getDefaultSwarmModel(): string {
	const fromEnv = process.env.OPENHARNESS_SWARM_DEFAULT_MODEL?.trim();
	if (fromEnv) return fromEnv;
	return DEFAULT_MODEL;
}

function normalizeTasks(tasks: Array<string | { task?: unknown }>): string[] {
	return tasks
		.map((item) => {
			if (typeof item === "string") return item.trim();
			if (item && typeof item === "object" && typeof item.task === "string") return item.task.trim();
			return "";
		})
		.filter((task) => task.length > 0);
}

function truncateOutput(text: string): string {
	if (text.length <= MAX_OUTPUT_CHARS) return text;
	return `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n[truncated ${text.length - MAX_OUTPUT_CHARS} chars]`;
}

function parseLatestAssistantText(payload: unknown): string {
	if (!payload || typeof payload !== "object") return "";
	const event = payload as { type?: string; message?: { role?: string; content?: Array<{ type?: string; text?: string }> } };
	if (!event.type?.startsWith("message_") || event.message?.role !== "assistant") return "";
	const part = event.message.content?.find((item) => item.type === "text");
	return part?.text ?? "";
}

function formatTaskLine(progress: WorkerProgress): string {
	const taskNumber = progress.index + 1;
	const statusIcon =
		progress.status === "queued"
			? "..."
			: progress.status === "running"
				? "->"
				: progress.status === "done"
					? "ok"
					: "xx";
	const suffix = progress.preview?.trim() ? ` ${progress.preview.trim()}` : "";
	return `Subagent ${taskNumber}: ${statusIcon}${suffix}`;
}

function isNodeLikeRuntime(): boolean {
	const runtimeName = basename(process.execPath).toLowerCase();
	return runtimeName.includes("node") || runtimeName.includes("bun") || process.env.ELECTRON_RUN_AS_NODE === "1";
}

function isCliEntrypoint(filePath: string | undefined): filePath is string {
	if (!filePath) return false;
	const name = basename(filePath);
	return name === "cli.js" || name === "cli.ts";
}

function resolveLocalCliEntrypoint(): string | undefined {
	const currentModule = fileURLToPath(import.meta.url);
	const candidates = [
		join(dirname(currentModule), "..", "..", "cli.js"),
		join(dirname(currentModule), "..", "..", "cli.ts"),
	];
	return candidates.find((candidate) => existsSync(candidate));
}

function resolvePiInvocation(): { command: string; argsPrefix: string[]; env?: NodeJS.ProcessEnv } {
	const currentScript = process.argv[1];
	const cliEntrypoint = isCliEntrypoint(currentScript) ? currentScript : resolveLocalCliEntrypoint();
	if (cliEntrypoint && isNodeLikeRuntime()) {
		return { command: process.execPath, argsPrefix: [cliEntrypoint], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } };
	}
	return { command: "pi", argsPrefix: [] };
}

function toModelRefString(model: ProviderModelRef): string {
	return `${model.provider}/${model.id}`;
}

function resolveWorkerModelReference(params: {
	requestedModel: string;
	currentModel: ProviderModelRef | undefined;
	availableModels: Array<ProviderModelRef>;
}): string {
	const { requestedModel, currentModel, availableModels } = params;
	const trimmedRequested = requestedModel.trim();

	// If caller already passed canonical provider/model, keep it.
	if (trimmedRequested.includes("/")) {
		return trimmedRequested;
	}

	// Prefer exact current model when IDs align (preserves provider).
	if (currentModel && currentModel.id === trimmedRequested) {
		return toModelRefString(currentModel);
	}

	// Resolve bare IDs to canonical provider/model when available.
	const matches = availableModels.filter((candidate) => candidate.id === trimmedRequested);
	if (matches.length === 1) {
		return toModelRefString(matches[0]);
	}
	if (matches.length > 1 && currentModel) {
		const currentProviderMatch = matches.find((candidate) => candidate.provider === currentModel.provider);
		if (currentProviderMatch) {
			return toModelRefString(currentProviderMatch);
		}
	}

	return trimmedRequested;
}

async function runSingleTask(
	cwd: string,
	task: string,
	model: string,
	signal: AbortSignal | undefined,
	index: number,
	onProgress?: (progress: WorkerProgress) => void,
): Promise<WorkerResult> {
	return new Promise((resolve) => {
		const invocation = resolvePiInvocation();
		const args = [...invocation.argsPrefix, "--mode", "json", "--model", model, "-p", "--no-session", task];
		const child = spawn(invocation.command, args, {
			cwd,
			env: invocation.env,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdoutBuffer = "";
		let stderr = "";
		let latestAssistantText = "";
		let finished = false;
		let timeout: NodeJS.Timeout | undefined;
		let abort: (() => void) | undefined;

		const finish = (result: WorkerResult) => {
			if (finished) return;
			finished = true;
			if (timeout) clearTimeout(timeout);
			if (signal && abort) signal.removeEventListener("abort", abort);
			resolve(result);
		};

		const processLine = (line: string) => {
			if (!line.trim()) return;
			try {
				const parsed = JSON.parse(line);
				const assistantText = parseLatestAssistantText(parsed);
				if (assistantText) {
					latestAssistantText = assistantText;
					onProgress?.({
						index,
						status: "running",
						preview: truncateOutput(assistantText).split("\n")[0],
					});
				}
			} catch {
				// ignore non-json lines
			}
		};

		child.stdout.on("data", (chunk) => {
			stdoutBuffer += chunk.toString();
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});

		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		child.on("close", (code) => {
			if (stdoutBuffer.trim()) processLine(stdoutBuffer);
			const success = (code ?? 1) === 0;
			const output = truncateOutput(latestAssistantText || stderr || "(no output)");
			finish({ index, task, success, output });
		});

		child.on("error", (error) => {
			finish({
				index,
				task,
				success: false,
				output: truncateOutput(error.message || "Failed to spawn sub-agent process"),
			});
		});

		const forceKill = () => {
			if (!child.killed) child.kill("SIGKILL");
		};
		timeout = setTimeout(() => {
			child.kill("SIGTERM");
			setTimeout(forceKill, 1_000).unref();
			finish({
				index,
				task,
				success: false,
				output: `Swarm sub-agent timed out after ${Math.round(WORKER_TIMEOUT_MS / 1000)}s.`,
			});
		}, WORKER_TIMEOUT_MS);
		timeout.unref();

		abort = () => {
			child.kill("SIGTERM");
			setTimeout(forceKill, 1_000).unref();
			finish({
				index,
				task,
				success: false,
				output: "Swarm sub-agent was aborted.",
			});
		};
		if (signal) {
			if (signal.aborted) abort();
			else signal.addEventListener("abort", abort, { once: true });
		}
		onProgress?.({ index, status: "running" });
	});
}

async function mapWithConcurrency<T, R>(
	items: T[],
	concurrency: number,
	run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	const limit = Math.max(1, Math.min(concurrency, items.length));
	let next = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (next < items.length) {
			const current = next++;
			results[current] = await run(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

export function createSwarmDispatchToolDefinition(cwd: string): ToolDefinition<typeof swarmDispatchSchema, SwarmDispatchDetails> {
	return {
		name: "swarm_dispatch",
		label: "swarm_dispatch",
		description:
			"Delegate substantial multi-step work into smaller parallel subtasks handled by cheaper sub-agents. Supports up to 10 subtasks per call. Do not use for simple questions, tool inventory, or requests that can be answered directly.",
		promptSnippet: "Delegate substantial multi-step work to parallel sub-agents when Swarm mode is enabled",
		promptGuidelines: [
			"Use swarm_dispatch only when Swarm mode is enabled and the task benefits from delegation.",
			"When Swarm mode is disabled, do not call swarm_dispatch.",
			"Do not use swarm_dispatch for tool inventory questions or other requests you can answer directly.",
			"When answering tool inventory questions, describe Swarm as an enabled delegation mode instead of listing the internal swarm_dispatch tool.",
			"Pass at most 10 concise subtasks and aggregate the returned outputs.",
		],
		parameters: swarmDispatchSchema,
		prepareArguments(args) {
			if (!args || typeof args !== "object") {
				return { tasks: [] };
			}
			const raw = args as { tasks?: unknown; model?: unknown; concurrency?: unknown };
			const rawTasks = Array.isArray(raw.tasks) ? raw.tasks : [];
			return {
				tasks: normalizeTasks(rawTasks as Array<string | { task?: unknown }>),
				model: typeof raw.model === "string" ? raw.model : undefined,
				concurrency: typeof raw.concurrency === "number" ? raw.concurrency : undefined,
			};
		},
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (ctx?.getSwarmMode && !ctx.getSwarmMode()) {
				return {
					content: [
						{
							type: "text",
							text: "Swarm mode is off for this thread. Ask the user to enable Swarm mode before using swarm_dispatch.",
						},
					],
					isError: true,
					details: { model: ctx?.model?.id ?? DEFAULT_MODEL, concurrency: 0, totalTasks: 0 },
				};
			}
			const requestedModel = params.model?.trim() || getDefaultSwarmModel();
			const concurrency = Math.max(1, Math.min(params.concurrency ?? 3, MAX_CONCURRENCY));
			const availableModels = (ctx?.modelRegistry ? await ctx.modelRegistry.getAvailable() : []).map((candidate) => ({
				provider: candidate.provider,
				id: candidate.id,
			}));
			const currentModel = ctx?.model
				? {
						provider: ctx.model.provider,
						id: ctx.model.id,
					}
				: undefined;
			let model = resolveWorkerModelReference({
				requestedModel,
				currentModel,
				availableModels,
			});
			const hasRequestedModel = availableModels.some(
				(candidate) =>
					candidate.id === requestedModel ||
					toModelRefString(candidate).toLowerCase() === requestedModel.toLowerCase(),
			);
			if (!hasRequestedModel && currentModel) {
				model = toModelRefString(currentModel);
			}
			const tasks = normalizeTasks(params.tasks);
			if (tasks.length === 0) {
				return {
					content: [{ type: "text", text: "No swarm subtasks were provided." }],
					isError: true,
					details: { model, concurrency, totalTasks: 0 },
				};
			}
			if (tasks.length > MAX_SWARM_TASKS) {
				return {
					content: [{ type: "text", text: `Too many subtasks (${tasks.length}). Max is ${MAX_SWARM_TASKS}.` }],
					isError: true,
					details: { model, concurrency, totalTasks: tasks.length },
				};
			}

			const progress: WorkerProgress[] = tasks.map((_task, index) => ({
				index,
				status: "queued",
			}));
			const emitProgress = () => {
				if (!onUpdate) return;
				onUpdate({
					content: [
						{
							type: "text",
							text: progress.map((entry) => formatTaskLine(entry)).join("\n"),
						},
					],
					details: { model, concurrency, totalTasks: tasks.length },
				});
			};
			emitProgress();

			const results = await mapWithConcurrency(tasks, concurrency, async (task, index) => {
				const result = await runSingleTask(
					cwd,
					task,
					model,
					signal,
					index,
					(nextProgress) => {
						progress[index] = {
							...progress[index],
							status: nextProgress.status,
							preview: nextProgress.preview ?? progress[index]?.preview,
						};
						emitProgress();
					},
				);
				progress[index] = {
					index,
					status: result.success ? "done" : "error",
					preview: result.output.split("\n")[0],
				};
				emitProgress();
				return result;
			});
			const successCount = results.filter((item) => item.success).length;
			const sections = results
				.map((result) => {
					const status = result.success ? "ok" : "error";
					return `### Task ${result.index + 1} (${status})\n${result.output}`;
				})
				.join("\n\n---\n\n");
			return {
				content: [
					{
						type: "text",
						text:
							`Swarm completed ${successCount}/${results.length} subtasks using \`${model}\`.` +
							(hasRequestedModel ? "" : ` Requested model \`${requestedModel}\` was unavailable, fallback applied.`) +
							`\n\n${sections}`,
					},
				],
				isError: successCount !== results.length,
				details: { model, concurrency, totalTasks: results.length },
			};
		},
		renderCall(args, theme) {
			const text = `swarm_dispatch ${args.tasks?.length ?? 0} tasks`;
			return new Text(theme.fg("toolTitle", theme.bold(text)), 0, 0);
		},
	};
}

export function createSwarmDispatchTool(cwd: string): AgentTool<typeof swarmDispatchSchema, SwarmDispatchDetails> {
	return wrapToolDefinition(createSwarmDispatchToolDefinition(cwd));
}
