/**
 * Node `readline`-backed {@link Prompter}.
 *
 * Uses readline in normal (cooked) line mode: input echoes to the terminal the way
 * a screen reader expects, and the user gets free line editing and history. We never
 * put the terminal into raw mode and never repaint — this is a plain REPL, not a TUI.
 */

import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { Prompter } from "./types.ts";

/** Rejected from a pending {@link Prompter.question} when input ends. */
export class InputClosedError extends Error {
	constructor() {
		super("input closed");
		this.name = "InputClosedError";
	}
}

export interface NodeReadlinePrompterOptions {
	input?: NodeJS.ReadableStream;
	output?: NodeJS.WritableStream;
}

export function createNodeReadlinePrompter(options: NodeReadlinePrompterOptions = {}): Prompter {
	const input = options.input ?? process.stdin;
	const output = options.output ?? process.stdout;
	const rl: ReadlineInterface = createInterface({ input, output, terminal: true });

	let closed = false;
	let pendingReject: ((error: Error) => void) | undefined;

	rl.on("close", () => {
		closed = true;
		// Unblock any in-flight question so the caller's loop can exit.
		pendingReject?.(new InputClosedError());
		pendingReject = undefined;
	});

	return {
		question(query: string): Promise<string> {
			if (closed) {
				return Promise.reject(new InputClosedError());
			}
			return new Promise<string>((resolve, reject) => {
				pendingReject = reject;
				rl.question(query, (answer) => {
					pendingReject = undefined;
					resolve(answer);
				});
			});
		},
		onSigint(handler: () => void): void {
			rl.on("SIGINT", handler);
		},
		onClose(handler: () => void): void {
			rl.on("close", handler);
		},
		write(text: string): void {
			output.write(text);
		},
		close(): void {
			if (!closed) {
				rl.close();
			}
		},
	};
}
