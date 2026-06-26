import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { ModelRegistry } from "../model-registry.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const DEFAULT_MODEL = "kimi-k2.6";
const MAX_SWARM_TASKS = 10;
const MAX_CONCURRENCY = 4;
const MAX_OUTPUT_CHARS = 8000;
const WORKER_TIMEOUT_MS = 5 * 60 * 1000;
const SWARM_WORKER_APPEND_SYSTEM_PROMPT =
	"Swarm sub-agent: complete the assigned task, then end with a concise plain-text reply for the orchestrator. Do not finish with only tool calls or hidden reasoning.";

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

type WorkerStatus = "queued" | "running" | "done" | "error";

export interface SwarmWorkerProgress {
	index: number;
	status: WorkerStatus;
	action?: string;
	preview?: string;
	task: string;
}

interface SwarmDispatchDetails {
	model: string;
	concurrency: number;
	totalTasks: number;
	workers?: SwarmWorkerProgress[];
}

interface WorkerResult {
	index: number;
	task: string;
	success: boolean;
	output: string;
}

interface WorkerProgress {
	index: number;
	status: WorkerStatus;
	action?: string;
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

type AssistantContentPart = {
	type?: string;
	text?: string;
	thinking?: string;
};

export interface SwarmAssistantCapture {
	text: string;
	thinking: string;
	stopReason?: string;
	errorMessage?: string;
}

export function extractSwarmAssistantCapture(message: {
	role?: string;
	content?: AssistantContentPart[];
	stopReason?: string;
	errorMessage?: string;
}): SwarmAssistantCapture | null {
	if (message.role !== "assistant") return null;
	const textParts: string[] = [];
	const thinkingParts: string[] = [];
	for (const part of message.content ?? []) {
		if (part.type === "text" && typeof part.text === "string" && part.text.length > 0) {
			textParts.push(part.text);
		}
		if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking.length > 0) {
			thinkingParts.push(part.thinking);
		}
	}
	return {
		text: textParts.join("\n").trim(),
		thinking: thinkingParts.join("\n").trim(),
		stopReason: message.stopReason,
		errorMessage: message.errorMessage,
	};
}

/** Resolve sub-agent stdout into user-visible output (exported for tests). */
export function resolveSwarmWorkerOutput(params: {
	captures: SwarmAssistantCapture[];
	stderr: string;
	exitCode: number | null;
}): { output: string; success: boolean } {
	const { captures, stderr, exitCode } = params;
	const processOk = (exitCode ?? 1) === 0;
	const last = captures.at(-1);

	let text = "";
	for (let i = captures.length - 1; i >= 0; i--) {
		if (captures[i]?.text) {
			text = captures[i].text;
			break;
		}
	}

	let thinking = "";
	if (!text) {
		for (let i = captures.length - 1; i >= 0; i--) {
			if (captures[i]?.thinking) {
				thinking = captures[i].thinking;
				break;
			}
		}
	}

	const body = text || thinking;
	if (body) {
		const prefix = !text && thinking ? "[reasoning] " : "";
		return { output: truncateOutput(`${prefix}${body}`), success: processOk };
	}

	if (last?.errorMessage?.trim()) {
		return { output: truncateOutput(last.errorMessage.trim()), success: false };
	}

	const errText = stderr.trim();
	if (errText) {
		return { output: truncateOutput(errText), success: false };
	}

	const stopHint = last?.stopReason ? ` (stop: ${last.stopReason})` : "";
	return {
		output: `Worker completed without text output${stopHint}. Try another swarm model or simplify the subtask.`,
		success: false,
	};
}

export function formatSwarmWorkerAction(toolName: string): string {
	const name = toolName.toLowerCase();
	switch (name) {
		case "read":
		case "read_docx":
		case "read_xlsx":
		case "grep":
		case "find":
		case "ls":
			return "Exploring files";
		case "bash":
			return "Running commands";
		case "edit":
		case "write":
		case "edit_docx":
		case "edit_xlsx":
			return "Editing files";
		case "web_search":
			return "Searching the web";
		default:
			return "Working";
	}
}

export function mapSwarmWorkerProgress(progress: WorkerProgress[], tasks: string[]): SwarmWorkerProgress[] {
	return progress.map((entry) => ({
		index: entry.index,
		status: entry.status,
		action: entry.action,
		preview: entry.preview,
		task: tasks[entry.index] ?? "",
	}));
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
	const label = progress.action?.trim() || progress.preview?.trim();
	const suffix = label ? ` ${label}` : "";
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
		return {
			command: process.execPath,
			argsPrefix: [cliEntrypoint],
			env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
		};
	}
	return { command: "pi", argsPrefix: [] };
}

function toModelRefString(model: ProviderModelRef): string {
	return `${model.provider}/${model.id}`;
}

function parseModelRef(modelRef: string): { provider: string; id: string } | null {
	const trimmed = modelRef.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash >= trimmed.length - 1) return null;
	return { provider: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) };
}

function lookupWorkerModel(
	modelRef: string,
	modelRegistry: ModelRegistry | undefined,
	availableModels: Array<ProviderModelRef>,
): Model<Api> | undefined {
	if (!modelRegistry) return undefined;
	const parsed = parseModelRef(modelRef);
	if (parsed) {
		return modelRegistry.find(parsed.provider, parsed.id);
	}
	const matches = availableModels.filter((candidate) => candidate.id === modelRef);
	if (matches.length === 1) {
		return modelRegistry.find(matches[0].provider, matches[0].id);
	}
	return undefined;
}

/** OpenRouter reasoning models reject effort "none" when user settings default thinking to off. */
export function buildSwarmWorkerThinkingArgs(model: Model<Api> | undefined): string[] {
	if (!model?.reasoning) return [];
	const supported = getSupportedThinkingLevels(model);
	const preferred: ModelThinkingLevel[] = ["low", "minimal", "medium", "high", "xhigh"];
	for (const level of preferred) {
		if (supported.includes(level)) return ["--thinking", level];
	}
	const fallback = supported.find((level) => level !== "off");
	if (fallback) return ["--thinking", fallback];
	return ["--thinking", "low"];
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
	thinkingArgs: string[],
	signal: AbortSignal | undefined,
	index: number,
	onProgress?: (progress: WorkerProgress) => void,
): Promise<WorkerResult> {
	return new Promise((resolve) => {
		const invocation = resolvePiInvocation();
		const args = [
			...invocation.argsPrefix,
			"--mode",
			"json",
			"--model",
			model,
			...thinkingArgs,
			"--append-system-prompt",
			SWARM_WORKER_APPEND_SYSTEM_PROMPT,
			"-p",
			"--no-session",
			task,
		];
		const child = spawn(invocation.command, args, {
			cwd,
			env: { ...process.env, ...invocation.env },
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdoutBuffer = "";
		let stderr = "";
		const assistantCaptures: SwarmAssistantCapture[] = [];
		let workerAction = "Starting…";
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

		const emitWorkerProgress = (action: string, status: WorkerStatus = "running") => {
			workerAction = action;
			onProgress?.({ index, status, action });
		};

		const processLine = (line: string) => {
			if (!line.trim()) return;
			try {
				const parsed = JSON.parse(line) as {
					type?: string;
					toolName?: string;
					assistantMessageEvent?: { type?: string };
					message?: {
						role?: string;
						content?: AssistantContentPart[];
						stopReason?: string;
						errorMessage?: string;
					};
				};

				if (parsed.type === "tool_execution_start" && parsed.toolName) {
					emitWorkerProgress(formatSwarmWorkerAction(parsed.toolName));
					return;
				}

				if (parsed.type === "agent_start" || parsed.type === "turn_start") {
					if (workerAction === "Starting…") {
						emitWorkerProgress("Reasoning");
					}
					return;
				}

				if (parsed.type === "message_update" && parsed.assistantMessageEvent) {
					const eventType = parsed.assistantMessageEvent.type;
					if (
						eventType === "thinking_start" ||
						eventType === "thinking_delta" ||
						eventType === "toolcall_start" ||
						eventType === "toolcall_delta" ||
						eventType === "text_start" ||
						eventType === "text_delta"
					) {
						if (workerAction === "Starting…" || workerAction === "Reasoning") {
							emitWorkerProgress("Reasoning");
						}
					}
					return;
				}

				if (parsed.type === "message_end" && parsed.message) {
					const capture = extractSwarmAssistantCapture(parsed.message);
					if (capture) {
						assistantCaptures.push(capture);
						if (capture.thinking && !capture.text && workerAction === "Starting…") {
							emitWorkerProgress("Reasoning");
						}
					}
					return;
				}
				if (!parsed.type?.startsWith("message_") || !parsed.message) return;
				const capture = extractSwarmAssistantCapture(parsed.message);
				if (!capture) return;
				if (capture.thinking && !capture.text && workerAction === "Starting…") {
					emitWorkerProgress("Reasoning");
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
			const { output, success } = resolveSwarmWorkerOutput({
				captures: assistantCaptures,
				stderr,
				exitCode: code,
			});
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
		onProgress?.({ index, status: "running", action: workerAction });
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

export function createSwarmDispatchToolDefinition(
	cwd: string,
): ToolDefinition<typeof swarmDispatchSchema, SwarmDispatchDetails> {
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
			"Never tell the user swarm analysis is running unless you called swarm_dispatch in the same turn.",
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
			const availableModels = (ctx?.modelRegistry ? await ctx.modelRegistry.getAvailable() : []).map(
				(candidate) => ({
					provider: candidate.provider,
					id: candidate.id,
				}),
			);
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
					details: {
						model,
						concurrency,
						totalTasks: tasks.length,
						workers: mapSwarmWorkerProgress(progress, tasks),
					},
				});
			};
			emitProgress();

			const workerModel = lookupWorkerModel(model, ctx?.modelRegistry, availableModels);
			const thinkingArgs = buildSwarmWorkerThinkingArgs(workerModel);

			const results = await mapWithConcurrency(tasks, concurrency, async (task, index) => {
				const result = await runSingleTask(cwd, task, model, thinkingArgs, signal, index, (nextProgress) => {
					progress[index] = {
						...progress[index],
						status: nextProgress.status,
						action: nextProgress.action ?? progress[index]?.action,
						preview: nextProgress.preview ?? progress[index]?.preview,
					};
					emitProgress();
				});
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
							(hasRequestedModel
								? ""
								: ` Requested model \`${requestedModel}\` was unavailable, fallback applied.`) +
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
