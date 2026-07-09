/**
 * Append-only line writer + ANSI stripping for the accessible mode.
 *
 * Everything a screen-reader user hears goes through here. The writer strips ANSI
 * escape sequences from every string so control bytes never reach the terminal,
 * and it only ever appends. The lone exception is `clear()` (used by /new), the one
 * sanctioned place that emits a control sequence to reset the terminal.
 */

import type { LineWriter } from "./types.ts";

const ESC = String.fromCharCode(27); // U+001B escape
const BEL = String.fromCharCode(7); // U+0007 bell
// Erase screen (2J), erase scrollback (3J), and home the cursor (H) so /new starts
// on a genuinely empty terminal rather than just scrolling old output out of view.
const CLEAR_SCREEN = `${ESC}[2J${ESC}[3J${ESC}[H`;

// CSI sequences: colors, cursor movement, erase, etc. (ESC [ ... final-byte)
const CSI_RE = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g");
// OSC sequences: e.g. hyperlinks (ESC ] ... BEL or ESC \)
const OSC_RE = new RegExp(`${ESC}\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)`, "g");
// Any lone remaining escape characters
const ESC_RE = new RegExp(ESC, "g");

/** Remove ANSI escape sequences (colors, cursor control, hyperlinks) from a string. */
export function stripAnsi(text: string): string {
	return text.replace(OSC_RE, "").replace(CSI_RE, "").replace(ESC_RE, "");
}

export interface LineWriterOptions {
	out?: NodeJS.WritableStream;
	err?: NodeJS.WritableStream;
}

/**
 * Create a {@link LineWriter} over the given streams (defaults to process stdout/stderr).
 * All text is ANSI-stripped before being written.
 */
export function createLineWriter(options: LineWriterOptions = {}): LineWriter {
	const out = options.out ?? process.stdout;
	const err = options.err ?? process.stderr;
	return {
		line(text: string): void {
			out.write(`${stripAnsi(text)}\n`);
		},
		blank(): void {
			out.write("\n");
		},
		error(text: string): void {
			err.write(`${stripAnsi(text)}\n`);
		},
		clear(): void {
			// Only meaningful on an interactive terminal; when output is piped or
			// redirected, emitting the sequence would just corrupt the captured text.
			if ((out as NodeJS.WriteStream).isTTY) {
				out.write(CLEAR_SCREEN);
			}
		},
	};
}

/** Truncate a single line to `max` columns, appending an ellipsis when shortened. */
export function truncateLine(text: string, max: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	if (oneLine.length <= max) {
		return oneLine;
	}
	return `${oneLine.slice(0, Math.max(0, max - 1))}…`;
}

/** Last non-empty, ANSI-stripped line of a block of text (for one-line summaries). */
export function lastNonEmptyLine(text: string): string {
	const lines = stripAnsi(text).split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const trimmed = lines[i].trim();
		if (trimmed.length > 0) {
			return trimmed;
		}
	}
	return "";
}
