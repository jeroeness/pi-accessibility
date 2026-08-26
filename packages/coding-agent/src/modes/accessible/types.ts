/**
 * Shared contracts for the accessible (screen-reader-friendly) REPL mode.
 *
 * These interfaces are the seams between the mode's pieces: the loop, the event
 * renderer, the readline prompter, the text-based extension UI, and the command
 * dispatcher. Keeping them here lets each piece be built and unit-tested in
 * isolation against a contract rather than against another piece's implementation.
 */

import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type { PlanModeController } from "./plan-mode.ts";

/** Options for {@link runAccessibleMode}. */
export interface AccessibleModeOptions {
	/** First message to send before the interactive loop starts. */
	initialMessage?: string;
	/** Images attached to the initial message. */
	initialImages?: ImageContent[];
	/** Additional messages to send (in order) after the initial message. */
	initialMessages?: string[];
	/**
	 * Start with the model's reasoning printed. Off by default — reasoning is clutter on
	 * most turns — and toggled at runtime with /verbose.
	 */
	verbose?: boolean;
	/**
	 * When true, buffer each assistant message and emit it as a single block instead of
	 * streaming it line by line (can be less confusing for some screen readers).
	 */
	blockOutput?: boolean;
}

/**
 * Append-only text sink.
 *
 * Implementations MUST only append plain text; they must never emit cursor-control
 * or alt-screen escape sequences, and should strip ANSI from anything written so a
 * screen reader never receives escape bytes. The sole sanctioned exception is
 * {@link LineWriter.clear}, which resets the terminal on explicit user request.
 */
export interface LineWriter {
	/** Write one line to stdout (a trailing newline is added). */
	line(text: string): void;
	/** Write a blank separator line to stdout. */
	blank(): void;
	/** Write one line to stderr (a trailing newline is added). */
	error(text: string): void;
	/**
	 * Clear the terminal screen and scrollback (a fresh start, e.g. on /new). This is
	 * the one place a writer may emit a control sequence; on non-interactive output it
	 * is a no-op so redirected logs and captured streams stay clean.
	 */
	clear(): void;
}

/**
 * Minimal readline seam so the loop and the text UI prompts can be exercised in
 * tests without a real TTY.
 */
export interface Prompter {
	/**
	 * Print a prompt and resolve with the user's line (without the trailing newline).
	 * Rejects when input ends (EOF / close) so callers can break their loop. When a
	 * `signal` is supplied and aborts, the pending question is cancelled and the
	 * promise rejects.
	 */
	question(query: string, signal?: AbortSignal): Promise<string>;
	/**
	 * Mark whether a model turn is in progress. While a turn is active and no
	 * {@link Prompter.question} is pending, keystrokes are "out of turn": the
	 * prompter rings the terminal bell for each one so the user hears that the
	 * model has not finished yet and their input is not being read.
	 */
	setTurnActive(active: boolean): void;
	/** Register a handler for Ctrl+C (SIGINT). */
	onSigint(handler: () => void): void;
	/** Register a handler for end-of-input (Ctrl+D / stream close). */
	onClose(handler: () => void): void;
	/** Write raw text to the output stream (no added newline). */
	write(text: string): void;
	/** Close the prompter and release the input stream. */
	close(): void;
}

/** Turns a stream of session events into plain, append-only text lines. */
export interface EventRenderer {
	/** Handle one session event, emitting any lines it produces. */
	handle(event: AgentSessionEvent): void;
	/** Flush any pending buffers/tool groups (call when a turn ends). */
	endTurn(): void;
	/** Buffer whole assistant messages (true) vs stream line by line (false). */
	setBlockOutput(enabled: boolean): void;
	/** Whether block streaming is currently enabled. */
	getBlockOutput(): boolean;
	/** Print the model's reasoning (true) vs drop it (false). */
	setVerbose(enabled: boolean): void;
	/** Whether the model's reasoning is currently printed. */
	getVerbose(): boolean;
}

/** Result of dispatching a slash command. */
export type CommandResult =
	/** The command ran to completion; the caller should reprompt. */
	| { kind: "handled" }
	/** Not a known command; the caller should send the raw line to the agent. */
	| { kind: "sendAsPrompt" }
	/** The user asked to quit; the caller should exit with this code. */
	| { kind: "exit"; code: number };

/** Everything a command handler needs to act on the session. */
export interface CommandContext {
	session: AgentSession;
	runtime: AgentSessionRuntime;
	writer: LineWriter;
	prompter: Prompter;
	/** The active event renderer (for the /stream and /verbose toggles). */
	renderer: EventRenderer;
	/** Plan/build mode toggle (for the /plan and /build commands). */
	planMode: PlanModeController;
	/** Re-wire extensions + event subscription after a session is replaced. */
	rebindSession: () => Promise<void>;
	/**
	 * Resume a session by file path, showing the transcript confirmation gate and
	 * replay. `sessionLabel` is a human-readable identifier (name or message preview)
	 * shown in the gate. Returns `{ cancelled }`; a cancelled result leaves the current session.
	 */
	resumeSession: (sessionPath: string, sessionLabel?: string) => Promise<{ cancelled: boolean }>;
}
