import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createTranscriptRecorder,
	readTranscriptLines,
	transcriptPathFor,
} from "../src/modes/accessible/transcript.ts";
import { createRecordingWriter } from "./accessible-test-support.ts";

describe("transcriptPathFor", () => {
	it("replaces a .jsonl extension with .transcript", () => {
		expect(transcriptPathFor("/a/b/session.jsonl")).toBe("/a/b/session.transcript");
	});

	it("appends .transcript when the path is not a .jsonl file", () => {
		expect(transcriptPathFor("/a/b/session")).toBe("/a/b/session.transcript");
	});
});

describe("createTranscriptRecorder", () => {
	function makeRecorder() {
		const writes: Array<{ path: string; data: string }> = [];
		const recorder = createTranscriptRecorder({ append: (path, data) => writes.push({ path, data }) });
		return { recorder, writes };
	}

	it("does not record until a session file is set", () => {
		const { recorder, writes } = makeRecorder();
		recorder.recordUserMessage("hello");
		expect(writes).toEqual([]);
	});

	it("records user messages with a blank separator and caret prefix", () => {
		const { recorder, writes } = makeRecorder();
		recorder.setSessionFile("/s/abc.jsonl");
		recorder.recordUserMessage("do the thing");
		expect(writes).toEqual([{ path: "/s/abc.transcript", data: "\n^ do the thing\n" }]);
	});

	it("tees writer lines and blanks but not errors", () => {
		const { recorder, writes } = makeRecorder();
		const rec = createRecordingWriter();
		recorder.setSessionFile("/s/abc.jsonl");
		const wrapped = recorder.wrapWriter(rec.writer);

		wrapped.line("assistant text");
		wrapped.blank();
		wrapped.error("boom");

		// The underlying writer still receives everything.
		expect(rec.lines).toEqual(["assistant text", ""]);
		expect(rec.errors).toEqual(["boom"]);
		// Only line + blank are recorded; the error is not.
		expect(writes.map((w) => w.data)).toEqual(["assistant text\n", "\n"]);
	});

	it("strips ANSI before recording", () => {
		const { recorder, writes } = makeRecorder();
		const rec = createRecordingWriter();
		recorder.setSessionFile("/s/abc.jsonl");
		recorder.wrapWriter(rec.writer).line("\u001b[31mred\u001b[0m");
		expect(writes[0].data).toBe("red\n");
	});

	it("stops recording when the session file is cleared", () => {
		const { recorder, writes } = makeRecorder();
		recorder.setSessionFile("/s/abc.jsonl");
		recorder.setSessionFile(undefined);
		recorder.recordUserMessage("ignored");
		expect(writes).toEqual([]);
	});

	it("swallows append errors so recording never breaks the session", () => {
		const recorder = createTranscriptRecorder({
			append: () => {
				throw new Error("disk full");
			},
		});
		recorder.setSessionFile("/s/abc.jsonl");
		expect(() => recorder.recordUserMessage("hello")).not.toThrow();
	});
});

describe("readTranscriptLines", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-transcript-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns [] when the transcript file is missing", () => {
		expect(readTranscriptLines(join(dir, "missing.jsonl"))).toEqual([]);
	});

	it("reads lines and drops the trailing empty element from a final newline", () => {
		const sessionFile = join(dir, "s.jsonl");
		writeFileSync(join(dir, "s.transcript"), "line one\nline two\n");
		expect(readTranscriptLines(sessionFile)).toEqual(["line one", "line two"]);
	});

	it("round-trips content written by the recorder", () => {
		const sessionFile = join(dir, "rt.jsonl");
		const recorder = createTranscriptRecorder({
			append: (path, data) => {
				// Append for real so readTranscriptLines can read it back.
				const existing = (() => {
					try {
						return readFileSync(path, "utf8");
					} catch {
						return "";
					}
				})();
				writeFileSync(path, existing + data);
			},
		});
		recorder.setSessionFile(sessionFile);
		recorder.recordUserMessage("hi");
		const rec = createRecordingWriter();
		recorder.wrapWriter(rec.writer).line("hello back");

		expect(readTranscriptLines(sessionFile)).toEqual(["", "^ hi", "hello back"]);
	});
});
