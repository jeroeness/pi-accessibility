/**
 * Node `readline`-backed {@link Prompter}.
 *
 * Uses readline in normal (cooked) line mode: input echoes to the terminal the way
 * a screen reader expects, and the user gets free line editing and history. We never
 * put the terminal into raw mode and never repaint — this is a plain REPL, not a TUI.
 */

import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { Writable } from "node:stream";
import type { Prompter, QuestionOptions } from "./types.ts";

/** U+0007 BEL: rung when the user types out of turn (while the model is responding). */
const BELL = String.fromCharCode(7);

/** Rejected from a pending {@link Prompter.question} when input ends. */
export class InputClosedError extends Error {
	constructor() {
		super("input closed");
		this.name = "InputClosedError";
	}
}

/** Rejected from a pending {@link Prompter.question} when its abort signal fires. */
export class QuestionAbortedError extends Error {
	constructor() {
		super("question aborted");
		this.name = "QuestionAbortedError";
	}
}

export interface NodeReadlinePrompterOptions {
	input?: NodeJS.ReadableStream;
	output?: NodeJS.WritableStream;
	/**
	 * Tab-completion function: given the line up to the cursor, resolves to
	 * `[completions, completeOn]`. readline replaces `completeOn` with the common
	 * prefix of `completions` and lists them when there is more than one.
	 */
	completer?: (line: string) => Promise<[string[], string]>;
}

export function createNodeReadlinePrompter(options: NodeReadlinePrompterOptions = {}): Prompter {
	const input = options.input ?? process.stdin;
	const output = options.output ?? process.stdout;
	const completerOption = options.completer;
	// Adapt the promise-returning completer to readline's node-style callback form;
	// a failed lookup degrades to "no completions" rather than crashing input.
	const completer = completerOption
		? (line: string, callback: (err: null, result: [string[], string]) => void): void => {
				completerOption(line).then(
					(result) => callback(null, result),
					() => callback(null, [[], line]),
				);
			}
		: undefined;
	// readline writes through this gate so a secret answer (an API key) can be read
	// without echoing it: while muted, readline's echo and line redraws are dropped.
	let muted = false;
	const gatedOutput = new Writable({
		write(chunk: Buffer | string, _encoding, callback): void {
			if (!muted) output.write(chunk);
			callback();
		},
	});
	// readline wraps lines at the terminal width and redraws on resize.
	Object.defineProperty(gatedOutput, "columns", { get: () => (output as NodeJS.WriteStream).columns });
	const onResize = (): void => {
		gatedOutput.emit("resize");
	};
	output.on("resize", onResize);
	// readline keeps (and mutates) this array, so a secret answer can be dropped from it.
	const history: string[] = [];
	const rl: ReadlineInterface = createInterface({
		input,
		output: gatedOutput,
		terminal: true,
		history,
		...(completer ? { completer } : {}),
	});

	let closed = false;
	let pendingReject: ((error: Error) => void) | undefined;
	// A model turn is in progress (set by the loop around each prompt).
	let turnActive = false;
	// Number of in-flight questions. Keystrokes are only "out of turn" when the model
	// is responding AND nothing is actively awaiting the user's input.
	let pendingQuestions = 0;

	// While a turn is active and no question is pending, ring the bell for every key so
	// the user hears that it is not their turn yet. Gated on an interactive output so a
	// redirected/piped stream never receives bell bytes. readline (terminal mode) already
	// emits `keypress`; we only add a listener.
	input.on("keypress", () => {
		if (turnActive && pendingQuestions === 0 && (output as NodeJS.WriteStream).isTTY) {
			output.write(BELL);
		}
	});

	rl.on("close", () => {
		closed = true;
		output.off("resize", onResize);
		// Unblock any in-flight question so the caller's loop can exit.
		pendingReject?.(new InputClosedError());
		pendingReject = undefined;
	});

	return {
		question(query: string, signal?: AbortSignal, questionOptions?: QuestionOptions): Promise<string> {
			if (closed) {
				return Promise.reject(new InputClosedError());
			}
			if (signal?.aborted) {
				return Promise.reject(new QuestionAbortedError());
			}
			return new Promise<string>((resolve, reject) => {
				pendingQuestions++;
				let settled = false;
				const secret = questionOptions?.secret === true;
				const settle = (): void => {
					if (settled) return;
					settled = true;
					if (secret) {
						// The muted Enter never reached the terminal; end the prompt line here.
						muted = false;
						output.write("\n");
					}
					pendingQuestions--;
					pendingReject = undefined;
					if (signal) signal.removeEventListener("abort", onAbort);
				};
				function onAbort(): void {
					settle();
					reject(new QuestionAbortedError());
				}
				const done = (answer: string): void => {
					settle();
					// Up-arrow must never recall a secret.
					if (secret && history[0] === answer) history.shift();
					resolve(answer);
				};
				pendingReject = (error: Error): void => {
					settle();
					reject(error);
				};
				// A secret prompt is printed directly; readline then reads an unechoed line.
				if (secret) {
					output.write(query);
					muted = true;
				}
				const readlineQuery = secret ? "" : query;
				if (signal) {
					signal.addEventListener("abort", onAbort, { once: true });
					rl.question(readlineQuery, { signal }, done);
				} else {
					rl.question(readlineQuery, done);
				}
			});
		},
		setTurnActive(active: boolean): void {
			turnActive = active;
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
