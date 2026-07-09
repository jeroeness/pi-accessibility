/**
 * Tests for the readline-backed prompter's "out of turn" bell: while the model is
 * responding (a turn is active) and nothing is awaiting the user's input, each
 * keystroke rings the terminal bell so the user hears that it is not their turn.
 */

import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createNodeReadlinePrompter } from "../src/modes/accessible/prompter.ts";

const BELL = String.fromCharCode(7);

/** A Writable that records everything written synchronously; optionally a TTY. */
class RecordingOutput extends Writable {
	chunks: string[] = [];
	isTTY: boolean;
	constructor(isTTY = true) {
		super();
		this.isTTY = isTTY;
	}
	override _write(chunk: Buffer | string, _enc: string, cb: (error?: Error | null) => void): void {
		this.chunks.push(chunk.toString());
		cb();
	}
	text(): string {
		return this.chunks.join("");
	}
	bellCount(): number {
		return this.text().split(BELL).length - 1;
	}
}

/** Emit a synthetic keypress the way readline's terminal decoder would. */
function pressKey(input: PassThrough, ch: string): void {
	input.emit("keypress", ch, { name: ch, ctrl: false, meta: false, shift: false, sequence: ch });
}

describe("createNodeReadlinePrompter out-of-turn bell", () => {
	it("rings the bell once per keystroke while a turn is active and no question is pending", () => {
		const input = new PassThrough();
		const output = new RecordingOutput();
		const prompter = createNodeReadlinePrompter({ input, output });

		prompter.setTurnActive(true);
		pressKey(input, "a");
		pressKey(input, "b");
		pressKey(input, "c");
		prompter.close();

		expect(output.bellCount()).toBe(3);
	});

	it("stays silent when no turn is active (idle at the prompt)", () => {
		const input = new PassThrough();
		const output = new RecordingOutput();
		const prompter = createNodeReadlinePrompter({ input, output });

		pressKey(input, "a");
		prompter.close();

		expect(output.text()).not.toContain(BELL);
	});

	it("stays silent while a question is pending, even during a turn (extension is asking)", () => {
		const input = new PassThrough();
		const output = new RecordingOutput();
		const prompter = createNodeReadlinePrompter({ input, output });

		prompter.setTurnActive(true);
		// A pending question means the user IS being asked for input mid-turn.
		prompter.question("answer: ").catch(() => {});
		pressKey(input, "a");

		expect(output.text()).not.toContain(BELL);
		prompter.close();
	});

	it("rings again once the question settles but the turn is still active", async () => {
		const input = new PassThrough();
		const output = new RecordingOutput();
		const prompter = createNodeReadlinePrompter({ input, output });

		prompter.setTurnActive(true);
		const controller = new AbortController();
		const answer = prompter.question("answer: ", controller.signal).catch(() => "settled");
		// While the question is in flight, keystrokes are the user answering — no bell.
		pressKey(input, "a");
		expect(output.bellCount()).toBe(0);

		// The question ends (e.g. aborted). The turn is still running, so keystrokes are
		// out of turn again.
		controller.abort();
		expect(await answer).toBe("settled");
		pressKey(input, "b");
		prompter.close();

		expect(output.bellCount()).toBe(1);
	});

	it("never writes a bell byte when output is not a TTY (piped/redirected)", () => {
		const input = new PassThrough();
		const output = new RecordingOutput(false);
		const prompter = createNodeReadlinePrompter({ input, output });

		prompter.setTurnActive(true);
		pressKey(input, "a");
		prompter.close();

		expect(output.text()).not.toContain(BELL);
	});
});
