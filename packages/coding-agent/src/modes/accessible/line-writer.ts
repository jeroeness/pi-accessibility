/**
 * Append-only line writer + ANSI stripping for the accessible mode.
 *
 * Everything a screen-reader user hears goes through here. The writer strips ANSI
 * escape sequences from every string so control bytes never reach the terminal,
 * and it only ever appends (it never moves the cursor or clears the screen).
 */

import type { LineWriter } from "./types.ts";

const ESC = String.fromCharCode(27); // U+001B escape
const BEL = String.fromCharCode(7); // U+0007 bell

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
