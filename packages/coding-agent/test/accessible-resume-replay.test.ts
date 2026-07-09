import { describe, expect, it, vi } from "vitest";
import { type ResumeReplayDeps, runResumeReplay } from "../src/modes/accessible/resume-replay.ts";
import { createRecordingWriter } from "./accessible-test-support.ts";

/**
 * Build ResumeReplayDeps with a scriptable question. `answer` is returned by the
 * gate question; when `cancelDuringQuestion` is true the registered cancel handler
 * is fired (aborting the signal) before the question would resolve, simulating Ctrl+C.
 */
function makeDeps(options: {
	transcript?: string[];
	answer?: string;
	switchResult?: { cancelled: boolean };
	cancelDuringQuestion?: boolean;
}) {
	const rec = createRecordingWriter();
	const switchSession = vi.fn().mockResolvedValue(options.switchResult ?? { cancelled: false });
	let cancelHandler: (() => void) | undefined;

	const question = vi.fn((_query: string, signal?: AbortSignal): Promise<string> => {
		if (options.cancelDuringQuestion) {
			// Fire the cancel path the way the SIGINT hook would, then reject as aborted.
			cancelHandler?.();
			return Promise.reject(new Error("aborted"));
		}
		return signal?.aborted ? Promise.reject(new Error("aborted")) : Promise.resolve(options.answer ?? "");
	});

	const deps: ResumeReplayDeps = {
		writer: rec.writer,
		question,
		switchSession,
		readTranscriptLines: () => options.transcript ?? [],
		onCancelSignal: (handler) => {
			cancelHandler = handler;
			return () => {
				if (cancelHandler === handler) cancelHandler = undefined;
			};
		},
	};
	return { deps, rec, switchSession, question };
}

describe("runResumeReplay", () => {
	it("resumes without a gate and notes an empty transcript", async () => {
		const { deps, rec, switchSession, question } = makeDeps({ transcript: [] });
		const result = await runResumeReplay(deps, "/s/a.jsonl", "my session");
		expect(result).toEqual({ cancelled: false });
		expect(question).not.toHaveBeenCalled();
		expect(switchSession).toHaveBeenCalledWith("/s/a.jsonl");
		expect(rec.lines).toEqual(["Session has been loaded, transcript was empty."]);
	});

	it("prints the transcript after an empty Enter confirmation", async () => {
		const { deps, rec, switchSession, question } = makeDeps({
			transcript: ["^ hi", "hello back"],
			answer: "",
		});
		const result = await runResumeReplay(deps, "/s/a.jsonl", "my session");
		expect(result).toEqual({ cancelled: false });
		expect(question).toHaveBeenCalledTimes(1);
		expect(question.mock.calls[0][0]).toContain(
			'Resuming session "my session". Press Enter to replay its transcript (2 lines), or type anything else to skip.',
		);
		expect(switchSession).toHaveBeenCalledWith("/s/a.jsonl");
		// Blank line, the transcript lines, blank line.
		expect(rec.lines).toEqual(["", "^ hi", "hello back", ""]);
	});

	it("uses the singular noun for a one-line transcript", async () => {
		const { deps, question } = makeDeps({ transcript: ["only line"], answer: "" });
		await runResumeReplay(deps, "/s/a.jsonl", "n");
		expect(question.mock.calls[0][0]).toContain("replay its transcript (1 line)");
	});

	it("falls back to 'untitled session' when no label is supplied", async () => {
		const { deps, question } = makeDeps({ transcript: ["x"], answer: "" });
		await runResumeReplay(deps, "/s/a.jsonl", undefined);
		expect(question.mock.calls[0][0]).toContain('Resuming session "untitled session".');
	});

	it("resumes but skips printing when the user types a non-empty answer", async () => {
		const { deps, rec, switchSession } = makeDeps({ transcript: ["^ hi", "hello"], answer: "n" });
		await runResumeReplay(deps, "/s/a.jsonl", "s");
		expect(switchSession).toHaveBeenCalledWith("/s/a.jsonl");
		expect(rec.lines).toEqual(["Resumed session. Transcript not printed."]);
		expect(rec.lines).not.toContain("hello");
	});

	it("cancels the resume on Ctrl+C without switching", async () => {
		const { deps, rec, switchSession } = makeDeps({ transcript: ["^ hi"], cancelDuringQuestion: true });
		const result = await runResumeReplay(deps, "/s/a.jsonl", "s");
		expect(result).toEqual({ cancelled: true });
		expect(switchSession).not.toHaveBeenCalled();
		expect(rec.lines).toEqual(["Resume cancelled."]);
	});

	it("reports a cancelled switch", async () => {
		const { deps, rec } = makeDeps({ transcript: ["^ hi"], answer: "", switchResult: { cancelled: true } });
		const result = await runResumeReplay(deps, "/s/a.jsonl", "s");
		expect(result).toEqual({ cancelled: true });
		expect(rec.lines).toContain("Resume cancelled.");
		expect(rec.lines).not.toContain("^ hi");
	});
});
