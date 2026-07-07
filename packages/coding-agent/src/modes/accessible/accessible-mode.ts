/**
 * Accessible mode: a plain, append-only REPL for screen-reader users.
 *
 * Drives the same AgentSession as every other mode, but reads input with Node
 * `readline` (cooked line mode) and renders events as linear text — no TUI, no
 * repaint, no spinners. See PLAN-ACCESSIBILITY.md.
 */

import type { ImageContent } from "@earendil-works/pi-ai";
import { VERSION } from "../../config.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { dispatchCommand } from "./commands.ts";
import { createEventRenderer } from "./event-renderer.ts";
import { createLineWriter } from "./line-writer.ts";
import { isUnknownModel } from "./model-label.ts";
import { createNodeReadlinePrompter } from "./prompter.ts";
import { createTextUIContext } from "./text-ui-context.ts";
import type { AccessibleModeOptions, LineWriter, Prompter } from "./types.ts";

export type { AccessibleModeOptions } from "./types.ts";

/** Injectable dependencies (tests supply fakes; production uses real readline/stdout). */
export interface AccessibleModeDeps {
	writer?: LineWriter;
	prompter?: Prompter;
	/** Register SIGTERM/SIGHUP handlers (default true; tests pass false). */
	registerSignalHandlers?: boolean;
}

export async function runAccessibleMode(
	runtime: AgentSessionRuntime,
	options: AccessibleModeOptions = {},
	deps: AccessibleModeDeps = {},
): Promise<number> {
	const writer = deps.writer ?? createLineWriter();
	const prompter = deps.prompter ?? createNodeReadlinePrompter();
	const renderer = createEventRenderer(writer, { verbose: options.verbose, blockOutput: options.blockOutput });

	let session = runtime.session;
	let unsubscribe: (() => void) | undefined;
	let disposed = false;

	const dispose = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		unsubscribe?.();
		await runtime.dispose();
		prompter.close();
	};

	const rebindSession = async (): Promise<void> => {
		session = runtime.session;
		await session.bindExtensions({
			uiContext: createTextUIContext(prompter, writer),
			mode: "accessible",
			commandContextActions: {
				waitForIdle: () => session.agent.waitForIdle(),
				newSession: async (newSessionOptions) => runtime.newSession(newSessionOptions),
				fork: async (entryId, forkOptions) => {
					const result = await runtime.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, navigateOptions) => {
					const result = await session.navigateTree(targetId, {
						summarize: navigateOptions?.summarize,
						customInstructions: navigateOptions?.customInstructions,
						replaceInstructions: navigateOptions?.replaceInstructions,
						label: navigateOptions?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, switchOptions) => runtime.switchSession(sessionPath, switchOptions),
				reload: async () => {
					await session.reload();
				},
			},
			onError: (err) => {
				writer.error(`Extension error (${err.extensionPath}): ${err.error}`);
			},
		});
		unsubscribe?.();
		unsubscribe = session.subscribe((event) => renderer.handle(event));
	};

	runtime.setRebindSession(async () => {
		await rebindSession();
	});

	const signalCleanupHandlers: Array<() => void> = [];
	if (deps.registerSignalHandlers ?? true) {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}
		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void dispose().finally(() => process.exit(signal === "SIGHUP" ? 129 : 143));
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	}

	await rebindSession();

	// --- exit + interrupt wiring --------------------------------------------

	let exitCode: number | null = null;
	const requestExit = (code: number): void => {
		if (exitCode === null) exitCode = code;
	};
	prompter.onClose(() => requestExit(0));

	let awaitingExitConfirm = false;
	let interrupted = false;
	prompter.onSigint(() => {
		if (session.isStreaming) {
			interrupted = true;
			void session.abort();
		} else if (awaitingExitConfirm) {
			requestExit(130);
			prompter.close();
		} else {
			awaitingExitConfirm = true;
			writer.line("(press Ctrl+C again or type /quit to exit)");
		}
	});

	const submit = async (text: string, images?: ImageContent[]): Promise<void> => {
		interrupted = false;
		try {
			await session.prompt(text, images ? { images } : undefined);
		} catch (error: unknown) {
			writer.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		}
		renderer.endTurn();
		if (interrupted) {
			writer.line("[interrupted]");
		}
		// No end-of-turn marker: the next prompt (prefixed with a blank line) separates turns.
	};

	// --- banner + initial messages ------------------------------------------

	const model = session.model;
	writer.line(`Pi coding agent v${VERSION}`);
	if (!model || isUnknownModel(model)) {
		writer.line("No model selected. Use /login or /model to select a model.");
	} else {
		writer.line(`Model: ${model.provider}/${model.id}   Thinking: ${session.thinkingLevel}`);
	}
	writer.line(`Directory: ${runtime.cwd}`);
	writer.line("Type your message and press Enter. Type /help for commands, /quit to exit.");

	try {
		if (options.initialMessage) {
			await submit(options.initialMessage, options.initialImages);
		}
		for (const message of options.initialMessages ?? []) {
			if (exitCode !== null) break;
			await submit(message);
		}

		// --- main loop ------------------------------------------------------
		while (exitCode === null) {
			let line: string;
			try {
				line = await prompter.question("\n^ ");
			} catch {
				break; // input closed (EOF / Ctrl+D)
			}
			if (exitCode !== null) break;
			awaitingExitConfirm = false;

			const trimmed = line.trim();
			if (trimmed === "") continue;

			if (trimmed.startsWith("/")) {
				const result = await dispatchCommand(trimmed, {
					session,
					runtime,
					writer,
					prompter,
					renderer,
					rebindSession,
				});
				if (result.kind === "exit") {
					requestExit(result.code);
					break;
				}
				if (result.kind === "handled") {
					continue;
				}
				// "sendAsPrompt" falls through to submit the raw line.
			}

			await submit(trimmed);
		}
	} finally {
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		await dispose();
	}

	return exitCode ?? 0;
}
