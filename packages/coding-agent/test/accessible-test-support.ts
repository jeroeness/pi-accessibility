/**
 * Shared fakes for accessible-mode tests: a recording LineWriter and a scriptable
 * Prompter. These are the seams every accessible-mode test builds against.
 */

import { InputClosedError, QuestionAbortedError } from "../src/modes/accessible/prompter.ts";
import type { LineWriter, Prompter, QuestionOptions } from "../src/modes/accessible/types.ts";

export interface RecordingWriter {
	writer: LineWriter;
	/** stdout lines in order (blank() records an empty string). */
	lines: string[];
	/** stderr lines in order. */
	errors: string[];
}

/** A LineWriter that records everything written (raw, no stripping) for assertions. */
export function createRecordingWriter(): RecordingWriter {
	const lines: string[] = [];
	const errors: string[] = [];
	return {
		lines,
		errors,
		writer: {
			line(text: string): void {
				lines.push(text);
			},
			blank(): void {
				lines.push("");
			},
			error(text: string): void {
				errors.push(text);
			},
			clear(): void {
				// Model a terminal reset: the visible buffer (stdout lines) is wiped.
				lines.length = 0;
			},
		},
	};
}

export interface FakePrompter {
	prompter: Prompter;
	/** Prompt strings asked, in order. */
	prompts: string[];
	/** The abort signal passed with each question, in order (undefined when none). */
	signals: Array<AbortSignal | undefined>;
	/** The options passed with each question, in order (undefined when none). */
	options: Array<QuestionOptions | undefined>;
	/** Every `setTurnActive` value in call order (true when a turn begins, false when it ends). */
	turnActiveCalls: boolean[];
	/** Trigger the registered SIGINT handler. */
	fireSigint(): void;
	/** Resolve the currently pending question with `text`. */
	resolveNext(text: string): void;
	/** Close the prompter (fires close handlers, rejects any pending question). */
	fireClose(): void;
	isClosed(): boolean;
}

/**
 * Scriptable Prompter. `question` resolves from `queued` while inputs remain, then
 * pends (resolvable via `resolveNext`) so tests can inject SIGINT / EOF timing.
 */
export function createFakePrompter(queued: string[] = []): FakePrompter {
	const inputs = [...queued];
	const prompts: string[] = [];
	const signals: Array<AbortSignal | undefined> = [];
	const options: Array<QuestionOptions | undefined> = [];
	const turnActiveCalls: boolean[] = [];
	const closeHandlers: Array<() => void> = [];
	let sigintHandler: (() => void) | undefined;
	let pending: { resolve: (value: string) => void; reject: (error: Error) => void } | undefined;
	let closed = false;

	const prompter: Prompter = {
		question(query: string, signal?: AbortSignal, questionOptions?: QuestionOptions): Promise<string> {
			prompts.push(query);
			signals.push(signal);
			options.push(questionOptions);
			if (closed) {
				return Promise.reject(new InputClosedError());
			}
			if (signal?.aborted) {
				return Promise.reject(new QuestionAbortedError());
			}
			if (inputs.length > 0) {
				return Promise.resolve(inputs.shift() as string);
			}
			return new Promise<string>((resolve, reject) => {
				pending = { resolve, reject };
				signal?.addEventListener(
					"abort",
					() => {
						if (pending) {
							pending = undefined;
							reject(new QuestionAbortedError());
						}
					},
					{ once: true },
				);
			});
		},
		setTurnActive(active: boolean): void {
			turnActiveCalls.push(active);
		},
		onSigint(handler: () => void): void {
			sigintHandler = handler;
		},
		onClose(handler: () => void): void {
			closeHandlers.push(handler);
		},
		write(): void {},
		close(): void {
			if (closed) return;
			closed = true;
			pending?.reject(new InputClosedError());
			pending = undefined;
			for (const handler of closeHandlers) {
				handler();
			}
		},
	};

	return {
		prompter,
		prompts,
		signals,
		options,
		turnActiveCalls,
		fireSigint: () => sigintHandler?.(),
		resolveNext: (text: string) => {
			pending?.resolve(text);
			pending = undefined;
		},
		fireClose: () => prompter.close(),
		isClosed: () => closed,
	};
}

/** Yield to the microtask/timer queue so pending promises settle. */
export function tick(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}
