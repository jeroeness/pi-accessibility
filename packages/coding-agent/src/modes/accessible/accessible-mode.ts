/**
 * Accessible mode: a plain, append-only REPL for screen-reader users.
 *
 * Drives the same AgentSession as every other mode, but reads input with Node
 * `readline` (cooked line mode) and renders events as linear text — no TUI, no
 * repaint, no spinners. See PLAN-ACCESSIBILITY.md.
 */

import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { MissingSessionCwdError } from "../../core/session-cwd.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { createCompleter } from "./autocomplete.ts";
import { COMMAND_NAMES, dispatchCommand } from "./commands.ts";
import { createEventRenderer } from "./event-renderer.ts";
import { createLineWriter } from "./line-writer.ts";
import { isUnknownModel } from "./model-label.ts";
import { createPlanMode } from "./plan-mode.ts";
import { createNodeReadlinePrompter, InputClosedError, QuestionAbortedError } from "./prompter.ts";
import { runResumeReplay } from "./resume-replay.ts";
import { confirmMissingSessionCwd, createTextProjectTrustContext } from "./session-prompts.ts";
import { createTextUIContext } from "./text-ui-context.ts";
import { createTranscriptRecorder, readTranscriptLines } from "./transcript.ts";
import { createTurnUsageCollector, formatTurnSummary } from "./turn-summary.ts";
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
	// Records the active session's conversation (user + assistant + tool activity)
	// to its sidecar transcript for replay on resume. Retargeted on every rebind.
	const recorder = createTranscriptRecorder();

	let session = runtime.session;
	let unsubscribe: (() => void) | undefined;
	let disposed = false;
	const planMode = createPlanMode();
	// Fed from the session subscription below so the end-of-turn line can report the
	// cache-hit rate across every provider request the turn made.
	const turnUsage = createTurnUsageCollector();

	// Tab completion for the readline prompt: command names, command arguments, and
	// file/path tokens. Closures read the current (rebindable) session at Tab time.
	const argCompletionsFor = (command: string): string[] | null => {
		switch (command) {
			case "effort":
				return session.supportsThinking() ? [...session.getAvailableThinkingLevels()] : [];
			case "stream":
				return ["block", "line"];
			case "verbose":
				return ["on", "off"];
			case "help":
				return COMMAND_NAMES;
			case "model":
				return session.modelRuntime.getAvailableSnapshot().map((m) => `${m.provider}/${m.id}`);
			default:
				return null;
		}
	};
	const completer = createCompleter({
		cwd: runtime.cwd,
		getCommandNames: () => COMMAND_NAMES,
		getArgCompletions: (command) => argCompletionsFor(command),
	});

	const prompter = deps.prompter ?? createNodeReadlinePrompter({ completer });
	// The renderer writes through the recorder wrapper so assistant text and tool
	// activity land in the transcript; the plain `writer` (banner, commands, prompts,
	// errors, resume replay) is never recorded.
	const renderer = createEventRenderer(recorder.wrapWriter(writer), {
		verbose: options.verbose,
		blockOutput: options.blockOutput,
		// Reasoning is spoken through the plain writer: it is bulk rather than conversation,
		// so a resume replay must not read back the thinking of a turn recorded while
		// /verbose happened to be on.
		thinkingWriter: writer,
	});

	// Extension dialogs, project trust prompts, and other questions are asked as text.
	const textUI = createTextUIContext(prompter, writer);

	let exitCode: number | null = null;
	const requestExit = (code: number): void => {
		if (exitCode === null) exitCode = code;
	};

	const dispose = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		unsubscribe?.();
		await runtime.dispose();
		prompter.close();
	};

	const rebindSession = async (): Promise<void> => {
		session = runtime.session;
		// Follow the active session so recording (and future resumes) target its transcript.
		recorder.setSessionFile(session.sessionFile);
		await session.bindExtensions({
			uiContext: textUI,
			mode: "accessible",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
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
			// An extension asked pi to shut down: leave the loop once the current turn ends.
			shutdownHandler: () => {
				requestExit(0);
				prompter.close();
			},
			onError: (err) => {
				writer.error(`Extension error (${err.extensionPath}): ${err.error}`);
			},
		});
		// Plan mode belongs to the REPL: a new or resumed session starts with its own
		// full tool set, so restrict it again rather than leaving the flag on with
		// mutating tools active.
		planMode.reapply(session);
		unsubscribe?.();
		unsubscribe = session.subscribe((event) => {
			turnUsage.handle(event);
			renderer.handle(event);
		});
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

	prompter.onClose(() => requestExit(0));

	let awaitingExitConfirm = false;
	let interrupted = false;
	// A submitted prompt is running (including run setup and extension follow-up runs),
	// so Ctrl+C aborts it rather than arming the exit confirmation.
	let turnRunning = false;
	// While a modal prompt (e.g. the resume confirmation) is open, Ctrl+C is routed
	// here to cancel that prompt instead of arming the app-exit confirmation.
	let modalSigint: (() => void) | undefined;
	prompter.onSigint(() => {
		if (modalSigint) {
			modalSigint();
			return;
		}
		if (turnRunning || session.isStreaming) {
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

	// Resume a session behind the transcript confirmation gate + replay. Wired here
	// (not in commands.ts) because it needs the plain writer, the prompter's abort
	// support, and the modal Ctrl+C hook.
	const resumeSession = (sessionPath: string, sessionLabel?: string): Promise<{ cancelled: boolean }> =>
		runResumeReplay(
			{
				writer,
				question: (query, signal) => prompter.question(query, signal),
				readTranscriptLines,
				switchSession: async (path) => {
					// Project trust for a session in another project is asked as text.
					const projectTrustContextFactory = (cwd: string) => createTextProjectTrustContext(cwd, textUI);
					try {
						try {
							return await runtime.switchSession(path, { projectTrustContextFactory });
						} catch (error: unknown) {
							if (!(error instanceof MissingSessionCwdError)) throw error;
							if (!(await confirmMissingSessionCwd(textUI, error.issue))) {
								return { cancelled: true };
							}
							return await runtime.switchSession(path, {
								cwdOverride: error.issue.fallbackCwd,
								projectTrustContextFactory,
							});
						}
					} catch (error: unknown) {
						writer.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
						return { cancelled: true };
					}
				},
				onCancelSignal: (handler) => {
					modalSigint = handler;
					return () => {
						if (modalSigint === handler) {
							modalSigint = undefined;
						}
					};
				},
			},
			sessionPath,
			sessionLabel,
		);

	const submit = async (text: string, images?: ImageContent[]): Promise<void> => {
		interrupted = false;
		// Record the user's original message (pre plan-mode decoration) for transcript replay.
		recorder.recordUserMessage(text);
		// It is now the model's turn: keystrokes typed before it finishes ring the bell.
		prompter.setTurnActive(true);
		turnUsage.reset();
		// One spoken line opening the turn, so the user hears that the assistant has taken
		// over before any of its output arrives, and which mode it is working under.
		// Written with the plain writer, not the recorder: like the end-of-turn line it
		// describes this run, so replaying it on a later resume would be noise.
		// Extension commands run their handler with the raw arguments, so plan mode neither
		// announces planning nor appends its directive (which would land in the arguments).
		// Parsed like AgentSession._tryExecuteExtensionCommand: the name ends at the first space.
		const spaceIndex = text.indexOf(" ");
		const isExtensionCommand =
			text.startsWith("/") &&
			session.extensionRunner.getCommand(spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex)) !==
				undefined;
		const planning = planMode.isActive() && !isExtensionCommand;
		writer.line(planning ? "Planning." : "Working.");
		const startedAt = Date.now();
		turnRunning = true;
		try {
			// In plan mode, add the plan directive so the model produces a plan rather
			// than acting, and drop tools activated since /plan (for example codemode
			// when an MCP server connected). The tool-call guard blocks the rest.
			planMode.enforce(session);
			// followUp only applies while a run the REPL did not start (e.g. an extension's)
			// is streaming: the message is queued after it instead of being rejected.
			await session.prompt(planning ? planMode.decorate(text) : text, {
				streamingBehavior: "followUp",
				...(images ? { images } : {}),
			});
			// Runs an extension starts when this one settles belong to the same turn, so the
			// turn summary and the end of the bell wait for them too.
			await session.waitForIdle();
		} catch (error: unknown) {
			writer.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			turnRunning = false;
			prompter.setTurnActive(false);
		}
		renderer.endTurn();
		if (interrupted) {
			writer.line("[interrupted]");
		}
		// The one end-of-turn line. Written with the plain writer, not the recorder: it
		// describes this run, so replaying stale timings on a later resume would mislead.
		writer.line(formatTurnSummary(Date.now() - startedAt, session.getContextUsage(), turnUsage.total()));
	};

	// --- banner + initial messages ------------------------------------------

	const model = session.model;
	writer.line("Pi by Jeroen Esseveld.");
	if (!model || isUnknownModel(model)) {
		writer.line("No model selected. Use /login or /model to select a model.");
	} else {
		writer.line(`Model: ${model.id}.`);
		// A resumed session whose model is gone (or lacks auth) silently falls back to
		// another model; say so, as the TUI does. Without a model the line above already
		// covers it.
		const fallback = runtime.modelFallbackMessage?.trim();
		if (fallback) {
			writer.line(`Warning: ${/[.!?]$/.test(fallback) ? fallback : `${fallback}.`}`);
		}
	}
	writer.line("Type something or type /help.");

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
			// The separating newline is written on its own: inside the readline prompt it
			// makes every redraw (Tab completion, history, editing mid-line) move the
			// cursor up a line first.
			prompter.write("\n");
			try {
				line = await prompter.question("^ ");
			} catch {
				// Input closed (EOF / Ctrl+D, or Ctrl+C twice): end the prompt line so the
				// shell prompt does not start right after "^ ".
				prompter.write("\n");
				break;
			}
			if (exitCode !== null) break;
			awaitingExitConfirm = false;

			const trimmed = line.trim();
			if (trimmed === "") continue;

			// Slash commands, plus `:q` (quit), go through the command dispatcher; anything
			// else is a prompt for the model.
			if (trimmed.startsWith("/") || trimmed === ":q") {
				try {
					const result = await dispatchCommand(trimmed, {
						session,
						runtime,
						writer,
						prompter,
						renderer,
						planMode,
						rebindSession,
						resumeSession,
					});
					if (result.kind === "exit") {
						requestExit(result.code);
						break;
					}
					if (result.kind === "handled") {
						continue;
					}
					// "sendAsPrompt" falls through to submit the raw line.
				} catch (error: unknown) {
					// A command awaiting its own prompt (e.g. /model, /resume) when input ends or
					// Ctrl+C fires rejects here. That is a clean shutdown, not a crash: the close/
					// SIGINT handler already armed exitCode, so just stop looping.
					if (error instanceof InputClosedError || error instanceof QuestionAbortedError) {
						break;
					}
					// Any other command failure is surfaced but keeps the REPL alive (mirrors submit()).
					writer.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
					continue;
				}
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
