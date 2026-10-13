import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createNodeReadlinePrompter } from "../src/modes/accessible/prompter.ts";
import { createTextUIContext } from "../src/modes/accessible/text-ui-context.ts";
import { createFakePrompter, createRecordingWriter } from "./accessible-test-support.ts";

describe("select", () => {
	it("returns the chosen option and prints a numbered list", async () => {
		const rec = createRecordingWriter();
		const fake = createFakePrompter(["2"]);
		const ui = createTextUIContext(fake.prompter, rec.writer);
		const result = await ui.select("Pick one", ["alpha", "beta", "gamma"]);
		expect(result).toBe("beta");
		expect(rec.lines).toContain("Select: Pick one");
		expect(rec.lines).toContain("  2. beta");
	});

	it("cancels on empty input", async () => {
		const fake = createFakePrompter([""]);
		const ui = createTextUIContext(fake.prompter, createRecordingWriter().writer);
		expect(await ui.select("t", ["a"])).toBeUndefined();
	});

	it("cancels on out-of-range selection", async () => {
		const fake = createFakePrompter(["9"]);
		const ui = createTextUIContext(fake.prompter, createRecordingWriter().writer);
		expect(await ui.select("t", ["a", "b"])).toBeUndefined();
	});

	it("returns undefined immediately when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const fake = createFakePrompter([]);
		const ui = createTextUIContext(fake.prompter, createRecordingWriter().writer);
		expect(await ui.select("t", ["a"], { signal: controller.signal })).toBeUndefined();
		expect(fake.prompts.length).toBe(0);
	});
});

describe("confirm", () => {
	it("returns true for y/yes and false otherwise", async () => {
		const ui1 = createTextUIContext(createFakePrompter(["y"]).prompter, createRecordingWriter().writer);
		expect(await ui1.confirm("Proceed?", "details")).toBe(true);
		const ui2 = createTextUIContext(createFakePrompter(["n"]).prompter, createRecordingWriter().writer);
		expect(await ui2.confirm("Proceed?", "details")).toBe(false);
		const ui3 = createTextUIContext(createFakePrompter([""]).prompter, createRecordingWriter().writer);
		expect(await ui3.confirm("Proceed?", "details")).toBe(false);
	});
});

describe("input", () => {
	it("returns the entered text, or undefined when empty", async () => {
		const ui1 = createTextUIContext(createFakePrompter(["hello"]).prompter, createRecordingWriter().writer);
		expect(await ui1.input("Name?")).toBe("hello");
		const ui2 = createTextUIContext(createFakePrompter([""]).prompter, createRecordingWriter().writer);
		expect(await ui2.input("Name?")).toBeUndefined();
	});
});

describe("notify", () => {
	it("prefixes by type and routes errors to stderr", () => {
		const rec = createRecordingWriter();
		const ui = createTextUIContext(createFakePrompter().prompter, rec.writer);
		ui.notify("all good");
		ui.notify("careful", "warning");
		ui.notify("broke", "error");
		expect(rec.lines).toEqual(["Note: all good", "Warning: careful"]);
		expect(rec.errors).toEqual(["Error: broke"]);
	});
});

describe("timeout", () => {
	it("resolves to undefined when the dialog times out", async () => {
		const fake = createFakePrompter([]); // question pends forever
		const ui = createTextUIContext(fake.prompter, createRecordingWriter().writer);
		expect(await ui.input("slow?", undefined, { timeout: 5 })).toBeUndefined();
	});
});

describe("cancelled dialogs", () => {
	it("aborts the pending question when the dialog times out", async () => {
		const fake = createFakePrompter([]);
		const ui = createTextUIContext(fake.prompter, createRecordingWriter().writer);
		expect(await ui.select("t", ["a"], { timeout: 5 })).toBeUndefined();
		expect(fake.signals[0]?.aborted).toBe(true);
	});

	it("aborts the pending question when the dialog's signal fires", async () => {
		const fake = createFakePrompter([]);
		const ui = createTextUIContext(fake.prompter, createRecordingWriter().writer);
		const controller = new AbortController();
		const result = ui.input("Name", undefined, { signal: controller.signal });
		controller.abort();
		expect(await result).toBeUndefined();
		expect(fake.signals[0]?.aborted).toBe(true);
	});

	it("leaves the readline prompter usable after a timed-out dialog (next question gets the next line)", async () => {
		// Regression: the dialog raced the question against its timeout without cancelling
		// it, so readline kept the stale question, swallowed the next line, and the REPL's
		// following prompt never resolved.
		const input = new PassThrough();
		const output = new PassThrough();
		const prompter = createNodeReadlinePrompter({ input, output });
		const ui = createTextUIContext(prompter, createRecordingWriter().writer);

		expect(await ui.confirm("Proceed?", "details", { timeout: 5 })).toBe(false);

		const next = prompter.question("^ ");
		input.write("hello\n");
		expect(await next).toBe("hello");
		prompter.close();
	});
});
