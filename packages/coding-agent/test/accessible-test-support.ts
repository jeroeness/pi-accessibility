/**
 * Shared fakes for accessible-mode tests: a recording LineWriter and a scriptable
 * Prompter. These are the seams every accessible-mode test builds against.
 */

import type { LineWriter, Prompter } from "../src/modes/accessible/types.ts";

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
		},
	};
}

export interface FakePrompter {
	prompter: Prompter;
	/** Prompt strings asked, in order. */
	prompts: string[];
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
	const closeHandlers: Array<() => void> = [];
	let sigintHandler: (() => void) | undefined;
	let pending: { resolve: (value: string) => void; reject: (error: Error) => void } | undefined;
	let closed = false;

	const prompter: Prompter = {
		question(query: string): Promise<string> {
			prompts.push(query);
			if (closed) {
				return Promise.reject(new Error("input closed"));
			}
			if (inputs.length > 0) {
				return Promise.resolve(inputs.shift() as string);
			}
			return new Promise<string>((resolve, reject) => {
				pending = { resolve, reject };
			});
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
			pending?.reject(new Error("input closed"));
			pending = undefined;
			for (const handler of closeHandlers) {
				handler();
			}
		},
	};

	return {
		prompter,
		prompts,
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
