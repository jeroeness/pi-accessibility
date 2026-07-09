/**
 * Per-session transcript recording + replay for accessible mode.
 *
 * A session's transcript is a plain-text sidecar file next to its JSONL
 * (`<session>.transcript`) capturing only the conversation the user hears:
 * their own submitted messages, assistant text, and tool activity. Command
 * output, prompts, the banner, and errors are deliberately NOT recorded.
 *
 * On resume the transcript is replayed verbatim so a screen-reader user can walk
 * back through the whole session linearly (see accessible-mode resume flow).
 */

import { appendFileSync, readFileSync } from "node:fs";
import { stripAnsi } from "./line-writer.ts";
import type { LineWriter } from "./types.ts";

/** Sidecar transcript path for a session file: `<session>.jsonl` -> `<session>.transcript`. */
export function transcriptPathFor(sessionFile: string): string {
	return sessionFile.endsWith(".jsonl")
		? `${sessionFile.slice(0, -".jsonl".length)}.transcript`
		: `${sessionFile}.transcript`;
}

/** Read a session's stored transcript as lines. Returns [] when missing or unreadable. */
export function readTranscriptLines(sessionFile: string): string[] {
	let content: string;
	try {
		content = readFileSync(transcriptPathFor(sessionFile), "utf8");
	} catch {
		return [];
	}
	if (content.length === 0) {
		return [];
	}
	const lines = content.split("\n");
	// A trailing newline yields a spurious empty final element; drop it.
	if (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines;
}

/**
 * Records the conversation for the active session to its sidecar transcript file.
 *
 * `setSessionFile` retargets the recorder when the active session changes (new,
 * resume, fork); passing `undefined` (in-memory session) disables recording.
 */
export interface TranscriptRecorder {
	/** Point recording at a session file's transcript, or `undefined` to disable. */
	setSessionFile(sessionFile: string | undefined): void;
	/** Record a user-submitted message (shown on replay the way the prompt echoed it). */
	recordUserMessage(text: string): void;
	/** Wrap a writer so assistant/tool lines it prints are also recorded (errors are not). */
	wrapWriter(writer: LineWriter): LineWriter;
}

export interface TranscriptRecorderDeps {
	/** Append hook (defaults to fs.appendFileSync); injected in tests. */
	append?: (path: string, data: string) => void;
}

export function createTranscriptRecorder(deps: TranscriptRecorderDeps = {}): TranscriptRecorder {
	const append = deps.append ?? ((path: string, data: string): void => appendFileSync(path, data));
	let targetPath: string | undefined;

	const write = (data: string): void => {
		if (!targetPath) {
			return;
		}
		try {
			append(targetPath, data);
		} catch {
			// A failed transcript write must never break the session; drop it silently.
		}
	};

	return {
		setSessionFile(sessionFile: string | undefined): void {
			targetPath = sessionFile ? transcriptPathFor(sessionFile) : undefined;
		},
		recordUserMessage(text: string): void {
			// Blank separator + the caret prompt, mirroring the live "^ <text>" echo.
			write(`\n^ ${stripAnsi(text)}\n`);
		},
		wrapWriter(writer: LineWriter): LineWriter {
			return {
				line(text: string): void {
					writer.line(text);
					write(`${stripAnsi(text)}\n`);
				},
				blank(): void {
					writer.blank();
					write("\n");
				},
				error(text: string): void {
					// Errors are diagnostics, not conversation; print but do not record.
					writer.error(text);
				},
				clear(): void {
					// Terminal chrome, not conversation; clear the screen but record nothing.
					writer.clear();
				},
			};
		},
	};
}
