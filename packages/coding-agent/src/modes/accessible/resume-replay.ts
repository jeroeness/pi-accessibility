/**
 * Resume confirmation + transcript replay for accessible mode.
 *
 * When a session is resumed we print its stored transcript so a screen-reader
 * user can review the whole conversation linearly. Because that can be thousands
 * of lines, we gate the replay behind a confirmation that states the line count.
 *
 * Gate behaviour (see accessible-mode wiring):
 * - Empty Enter: resume and print the transcript.
 * - Any non-empty line: resume but skip printing.
 * - Ctrl+C: cancel the resume entirely (stay in the current session).
 * - Empty transcript: resume with no gate, just note it was empty.
 */

import type { LineWriter } from "./types.ts";

export interface ResumeReplayDeps {
	/** Plain writer (NOT the transcript-recording wrapper) used for gate + replay output. */
	writer: LineWriter;
	/** Ask a question; rejects if `signal` aborts (used for Ctrl+C cancel). */
	question: (query: string, signal?: AbortSignal) => Promise<string>;
	/** Perform the actual session switch; should surface its own errors and return cancelled. */
	switchSession: (sessionPath: string) => Promise<{ cancelled: boolean }>;
	/** Read the target session's stored transcript lines ([] when none). */
	readTranscriptLines: (sessionFile: string) => string[];
	/**
	 * Register a handler fired on Ctrl+C while the confirmation is open; returns an
	 * unregister function. The handler typically aborts the confirmation's signal.
	 */
	onCancelSignal: (handler: () => void) => () => void;
}

/**
 * Resume `sessionPath`, gating a transcript replay behind a line-count confirmation.
 * Returns `{ cancelled }` mirroring the underlying switch (cancel also when the user
 * aborts the gate with Ctrl+C).
 */
export async function runResumeReplay(
	deps: ResumeReplayDeps,
	sessionPath: string,
	sessionLabel?: string,
): Promise<{ cancelled: boolean }> {
	const label = sessionLabel && sessionLabel.trim().length > 0 ? sessionLabel.trim() : "untitled session";
	const lines = deps.readTranscriptLines(sessionPath);

	if (lines.length === 0) {
		const result = await deps.switchSession(sessionPath);
		if (result.cancelled) {
			deps.writer.line("Resume cancelled.");
			return result;
		}
		deps.writer.line("Session has been loaded, transcript was empty.");
		return result;
	}

	const noun = lines.length === 1 ? "line" : "lines";
	const controller = new AbortController();
	const unregister = deps.onCancelSignal(() => controller.abort());
	let answer: string;
	try {
		answer = await deps.question(
			`Resuming session "${label}". Press Enter to replay its transcript (${lines.length} ${noun}), or type anything else to skip. `,
			controller.signal,
		);
	} catch (error: unknown) {
		if (controller.signal.aborted) {
			deps.writer.line("Resume cancelled.");
			return { cancelled: true };
		}
		throw error;
	} finally {
		unregister();
	}

	const result = await deps.switchSession(sessionPath);
	if (result.cancelled) {
		deps.writer.line("Resume cancelled.");
		return result;
	}

	if (answer.trim() === "") {
		deps.writer.blank();
		for (const line of lines) {
			deps.writer.line(line);
		}
		deps.writer.blank();
	} else {
		deps.writer.line("Resumed session. Transcript not printed.");
	}
	return result;
}
