import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { runAccessibleMode } from "../src/modes/accessible/accessible-mode.ts";
import { createFakePrompter, createRecordingWriter, tick } from "./accessible-test-support.ts";
import { createHarness, createHarnessWithExtensions } from "./test-harness.ts";

describe("runAccessibleMode (end to end)", () => {
	it("renders a full turn as a clean linear transcript and exits on /quit", async () => {
		const harness = await createHarness({ responses: ["Hello there"] });
		const runtime = {
			session: harness.session,
			cwd: harness.tempDir,
			dispose: vi.fn().mockResolvedValue(undefined),
			setRebindSession: vi.fn(),
			newSession: vi.fn().mockResolvedValue({ cancelled: false }),
			fork: vi.fn().mockResolvedValue({ cancelled: false }),
			switchSession: vi.fn().mockResolvedValue({ cancelled: false }),
		} as unknown as AgentSessionRuntime;

		const rec = createRecordingWriter();
		const fake = createFakePrompter(["hello", "/quit"]);

		const code = await runAccessibleMode(
			runtime,
			{},
			{ writer: rec.writer, prompter: fake.prompter, registerSignalHandlers: false },
		);

		expect(code).toBe(0);
		const transcript = rec.lines.join("\n");
		expect(rec.lines[0]).toBe("Pi by Jeroen Esseveld.");
		expect(transcript).toContain("Hello there");
		// No "Assistant:" header and no end-of-turn marker (removed as clutter).
		expect(transcript).not.toContain("Assistant:");
		expect(transcript).not.toContain("[turn complete]");
		// Append-only: never an escape byte.
		expect(transcript).not.toContain(String.fromCharCode(27));

		harness.cleanup();
	});

	it("closes each turn with a summary line carrying time, context, and cache hits", async () => {
		const harness = await createHarness({ responses: ["Hello there"] });
		const runtime = {
			session: harness.session,
			cwd: harness.tempDir,
			dispose: vi.fn().mockResolvedValue(undefined),
			setRebindSession: vi.fn(),
			newSession: vi.fn().mockResolvedValue({ cancelled: false }),
			fork: vi.fn().mockResolvedValue({ cancelled: false }),
			switchSession: vi.fn().mockResolvedValue({ cancelled: false }),
		} as unknown as AgentSessionRuntime;

		const rec = createRecordingWriter();
		const fake = createFakePrompter(["hello", "/quit"]);

		await runAccessibleMode(
			runtime,
			{},
			{ writer: rec.writer, prompter: fake.prompter, registerSignalHandlers: false },
		);

		const summaries = rec.lines.filter((line) => line.startsWith("Turn: "));
		expect(summaries).toHaveLength(1);
		expect(summaries[0]).toMatch(/^Turn: \d+ seconds?\./);
		// The reply itself is printed before the summary that describes it.
		expect(rec.lines.indexOf("Hello there")).toBeLessThan(rec.lines.indexOf(summaries[0]));

		harness.cleanup();
	});

	it("marks the turn active around a prompt so out-of-turn keystrokes ring the bell", async () => {
		const harness = await createHarness({ responses: ["Hello there"] });
		const runtime = {
			session: harness.session,
			cwd: harness.tempDir,
			dispose: vi.fn().mockResolvedValue(undefined),
			setRebindSession: vi.fn(),
			newSession: vi.fn().mockResolvedValue({ cancelled: false }),
			fork: vi.fn().mockResolvedValue({ cancelled: false }),
			switchSession: vi.fn().mockResolvedValue({ cancelled: false }),
		} as unknown as AgentSessionRuntime;

		const rec = createRecordingWriter();
		const fake = createFakePrompter(["hello", "/quit"]);

		await runAccessibleMode(
			runtime,
			{},
			{ writer: rec.writer, prompter: fake.prompter, registerSignalHandlers: false },
		);

		// The single turn flips on before the prompt and off after it completes.
		expect(fake.turnActiveCalls).toEqual([true, false]);
		harness.cleanup();
	});

	it("block-output mode emits a multi-line reply as a single block", async () => {
		const harness = await createHarness({ responses: ["line one\nline two"] });
		const runtime = {
			session: harness.session,
			cwd: harness.tempDir,
			dispose: vi.fn().mockResolvedValue(undefined),
			setRebindSession: vi.fn(),
			newSession: vi.fn().mockResolvedValue({ cancelled: false }),
			fork: vi.fn().mockResolvedValue({ cancelled: false }),
			switchSession: vi.fn().mockResolvedValue({ cancelled: false }),
		} as unknown as AgentSessionRuntime;

		const rec = createRecordingWriter();
		const fake = createFakePrompter(["hi", "/quit"]);
		const code = await runAccessibleMode(
			runtime,
			{ blockOutput: true },
			{ writer: rec.writer, prompter: fake.prompter, registerSignalHandlers: false },
		);

		expect(code).toBe(0);
		// The two lines arrive as one recorded write, not two separate line flushes.
		expect(rec.lines).toContain("line one\nline two");
		harness.cleanup();
	});

	it("opens each turn with Working., or Planning. while plan mode is on", async () => {
		const harness = await createHarness({ responses: ["Hello there", "Plan: 1. look around"] });
		const runtime = {
			session: harness.session,
			cwd: harness.tempDir,
			dispose: vi.fn().mockResolvedValue(undefined),
			setRebindSession: vi.fn(),
			newSession: vi.fn().mockResolvedValue({ cancelled: false }),
			fork: vi.fn().mockResolvedValue({ cancelled: false }),
			switchSession: vi.fn().mockResolvedValue({ cancelled: false }),
		} as unknown as AgentSessionRuntime;

		const rec = createRecordingWriter();
		const fake = createFakePrompter(["hello", "/plan", "how would you do it", "/quit"]);

		await runAccessibleMode(
			runtime,
			{},
			{ writer: rec.writer, prompter: fake.prompter, registerSignalHandlers: false },
		);

		// One marker per turn, in mode order: build mode first, then plan mode.
		expect(rec.lines.filter((line) => line === "Working." || line === "Planning.")).toEqual([
			"Working.",
			"Planning.",
		]);
		// The marker opens the turn: it precedes the reply and the closing summary.
		expect(rec.lines.indexOf("Working.")).toBeLessThan(rec.lines.indexOf("Hello there"));
		harness.cleanup();
	});

	it("quits on :q typed at the main prompt instead of sending it to the model", async () => {
		// Regression: the loop only dispatched lines starting with "/", so ":q" was
		// submitted as a prompt. dispatchCommand() unit tests could not catch that.
		const harness = await createHarness({ responses: ["Hello there", "should never be requested"] });
		const runtime = {
			session: harness.session,
			cwd: harness.tempDir,
			dispose: vi.fn().mockResolvedValue(undefined),
			setRebindSession: vi.fn(),
			newSession: vi.fn().mockResolvedValue({ cancelled: false }),
			fork: vi.fn().mockResolvedValue({ cancelled: false }),
			switchSession: vi.fn().mockResolvedValue({ cancelled: false }),
		} as unknown as AgentSessionRuntime;

		const rec = createRecordingWriter();
		const fake = createFakePrompter(["hello", " :q ", "typed after quitting"]);

		const code = await runAccessibleMode(
			runtime,
			{},
			{ writer: rec.writer, prompter: fake.prompter, registerSignalHandlers: false },
		);

		expect(code).toBe(0);
		// Only the first line reached the model.
		expect(harness.faux.callCount).toBe(1);
		expect(rec.lines.filter((line) => line === "Working.")).toHaveLength(1);
		// The loop stopped at :q and never asked for the next line.
		expect(fake.prompts.filter((prompt) => prompt.includes("^"))).toHaveLength(2);
		harness.cleanup();
	});

	it("sends the screen-reader output rules to the model", async () => {
		const harness = await createHarness({ responses: ["Hello there"] });
		const runtime = {
			session: harness.session,
			cwd: harness.tempDir,
			dispose: vi.fn().mockResolvedValue(undefined),
			setRebindSession: vi.fn(),
			newSession: vi.fn().mockResolvedValue({ cancelled: false }),
			fork: vi.fn().mockResolvedValue({ cancelled: false }),
			switchSession: vi.fn().mockResolvedValue({ cancelled: false }),
		} as unknown as AgentSessionRuntime;

		const rec = createRecordingWriter();
		const fake = createFakePrompter(["hello", "/quit"]);
		await runAccessibleMode(
			runtime,
			{},
			{ writer: rec.writer, prompter: fake.prompter, registerSignalHandlers: false },
		);

		expect(harness.faux.contexts).toHaveLength(1);
		expect(JSON.stringify(harness.faux.contexts[0])).toContain("read aloud by a screen reader");
		harness.cleanup();
	});

	it("shows the no-model banner and uses the ^ prompt", async () => {
		const { runtime } = makeStubRuntime({ model: undefined });
		const rec = createRecordingWriter();
		const fake = createFakePrompter(["/quit"]);

		const code = await runAccessibleMode(
			runtime,
			{},
			{ writer: rec.writer, prompter: fake.prompter, registerSignalHandlers: false },
		);

		expect(code).toBe(0);
		expect(rec.lines).toContain("No model selected. Use /login or /model to select a model.");
		expect(fake.prompts.some((prompt) => prompt.includes("^"))).toBe(true);
	});
});

// --- controllable stub session for interrupt tests -------------------------

function makeStubRuntime(sessionOverrides: Record<string, unknown>): {
	runtime: AgentSessionRuntime;
	session: Record<string, unknown>;
} {
	const session: Record<string, unknown> = {
		model: { provider: "faux", id: "faux-1" },
		thinkingLevel: "medium",
		sessionId: "sess-1",
		isStreaming: false,
		agent: { waitForIdle: vi.fn().mockResolvedValue(undefined) },
		waitForIdle: vi.fn().mockResolvedValue(undefined),
		bindExtensions: vi.fn().mockResolvedValue(undefined),
		subscribe: vi.fn(() => () => {}),
		navigateTree: vi.fn().mockResolvedValue({ cancelled: false }),
		reload: vi.fn().mockResolvedValue(undefined),
		prompt: vi.fn().mockResolvedValue(undefined),
		abort: vi.fn().mockResolvedValue(undefined),
		getContextUsage: vi.fn().mockReturnValue(undefined),
	};
	// Copy descriptors (not a spread) so getters like `isStreaming` stay live.
	Object.defineProperties(session, Object.getOwnPropertyDescriptors(sessionOverrides));
	const runtime = {
		session,
		cwd: "/tmp/project",
		dispose: vi.fn().mockResolvedValue(undefined),
		setRebindSession: vi.fn(),
		newSession: vi.fn().mockResolvedValue({ cancelled: false }),
		fork: vi.fn().mockResolvedValue({ cancelled: false }),
		switchSession: vi.fn().mockResolvedValue({ cancelled: false }),
	} as unknown as AgentSessionRuntime;
	return { runtime, session };
}

describe("runAccessibleMode Ctrl+C", () => {
	it("interrupts a streaming turn via abort without exiting", async () => {
		let streaming = false;
		let resolvePrompt: (() => void) | undefined;
		const abort = vi.fn().mockImplementation(async () => {
			streaming = false;
			resolvePrompt?.();
		});
		const { runtime } = makeStubRuntime({
			get isStreaming() {
				return streaming;
			},
			prompt: vi.fn().mockImplementation(() => {
				streaming = true;
				return new Promise<void>((resolve) => {
					resolvePrompt = resolve;
				});
			}),
			abort,
		});

		const rec = createRecordingWriter();
		const fake = createFakePrompter(["do something"]);
		const promise = runAccessibleMode(
			runtime,
			{},
			{ writer: rec.writer, prompter: fake.prompter, registerSignalHandlers: false },
		);

		// Wait until the prompt is in flight (streaming), then interrupt.
		while (!streaming) {
			await tick();
		}
		fake.fireSigint();

		// After the abort resolves the turn, the loop asks again; end input to exit.
		while (fake.prompts.length < 2) {
			await tick();
		}
		fake.fireClose();

		const code = await promise;
		expect(abort).toHaveBeenCalledTimes(1);
		expect(rec.lines).toContain("[interrupted]");
		expect(code).toBe(0);
	});

	it("exits with 130 on a second Ctrl+C at an idle prompt", async () => {
		const { runtime } = makeStubRuntime({ isStreaming: false });
		const rec = createRecordingWriter();
		const fake = createFakePrompter([]); // first question pends at idle

		const promise = runAccessibleMode(
			runtime,
			{},
			{ writer: rec.writer, prompter: fake.prompter, registerSignalHandlers: false },
		);

		while (fake.prompts.length === 0) {
			await tick();
		}
		fake.fireSigint(); // hint
		fake.fireSigint(); // exit

		const code = await promise;
		expect(code).toBe(130);
		expect(rec.lines).toContain("(press Ctrl+C again or type /quit to exit)");
	});

	it("exits cleanly (no crash) on a second Ctrl+C while a command awaits its own prompt", async () => {
		// Regression: closing the prompter rejects the command's pending question with
		// InputClosedError. That used to propagate out of the unguarded dispatchCommand
		// await and crash the process instead of exiting.
		const { runtime } = makeStubRuntime({
			isStreaming: false,
			modelRuntime: { getAvailable: vi.fn().mockResolvedValue([{ provider: "faux", id: "faux-1" }]) },
		});
		const rec = createRecordingWriter();
		// The main prompt resolves to /model; the command's model-selection prompt then pends.
		const fake = createFakePrompter(["/model"]);

		const promise = runAccessibleMode(
			runtime,
			{},
			{ writer: rec.writer, prompter: fake.prompter, registerSignalHandlers: false },
		);

		// Wait until the command's own question is pending (main prompt + selection prompt asked).
		while (fake.prompts.length < 2) {
			await tick();
		}
		fake.fireSigint(); // hint
		fake.fireSigint(); // exit -> closes prompter -> rejects the command's pending question

		const code = await promise;
		expect(code).toBe(130);
		expect(rec.errors).toHaveLength(0); // not surfaced as an error; treated as clean shutdown
	});
});

describe("runAccessibleMode request errors and startup warnings", () => {
	it("prints a request error that only arrives as stopReason error, once", async () => {
		// Regression: a provider failure (e.g. 401) reaches the session only as an assistant
		// message with stopReason "error"; the REPL printed nothing but the turn summary.
		const harness = await createHarness({
			responses: [{ error: "OpenAI API error (401): Incorrect API key provided" }],
			settings: { retry: { enabled: false } },
		});
		const runtime = {
			session: harness.session,
			cwd: harness.tempDir,
			dispose: vi.fn().mockResolvedValue(undefined),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const rec = createRecordingWriter();
		const fake = createFakePrompter(["hello", "/quit"]);

		await runAccessibleMode(
			runtime,
			{},
			{ writer: rec.writer, prompter: fake.prompter, registerSignalHandlers: false },
		);

		expect(rec.errors).toEqual(["Error: OpenAI API error (401): Incorrect API key provided."]);
		expect(rec.lines.some((line) => line.startsWith("Turn: "))).toBe(true);
		harness.cleanup();
	});

	it("warns after the banner when the session's model could not be restored", async () => {
		const { runtime } = makeStubRuntime({});
		Object.defineProperty(runtime, "modelFallbackMessage", {
			value: "Could not restore model gone/model-x. Using faux/faux-1",
		});
		const rec = createRecordingWriter();
		const fake = createFakePrompter(["/quit"]);

		await runAccessibleMode(
			runtime,
			{},
			{ writer: rec.writer, prompter: fake.prompter, registerSignalHandlers: false },
		);

		expect(rec.lines.slice(0, 4)).toEqual([
			"Pi by Jeroen Esseveld.",
			"Model: faux-1.",
			"Warning: Could not restore model gone/model-x. Using faux/faux-1.",
			"Type something or type /help.",
		]);
	});
});

describe("runAccessibleMode plan mode", () => {
	async function runWithNewSession(lines: string[]) {
		const first = await createHarness();
		const second = await createHarness();
		const runtime = {
			session: first.session,
			cwd: first.tempDir,
			dispose: vi.fn().mockResolvedValue(undefined),
			setRebindSession: vi.fn(),
			newSession: vi.fn(async () => {
				runtime.session = second.session;
				return { cancelled: false };
			}),
		};
		const rec = createRecordingWriter();
		const fake = createFakePrompter(lines);
		await runAccessibleMode(
			runtime as unknown as AgentSessionRuntime,
			{},
			{ writer: rec.writer, prompter: fake.prompter, registerSignalHandlers: false },
		);
		return { first, second, rec };
	}

	it("keeps plan mode across /new and restricts the new session's tools too", async () => {
		const { first, second } = await runWithNewSession(["/plan", "/new", "/quit"]);
		const tools = second.session.getActiveToolNames();
		expect(tools).toContain("read");
		for (const name of ["bash", "edit", "write"]) {
			expect(tools).not.toContain(name);
		}
		first.cleanup();
		second.cleanup();
	});

	it("/build after /new restores the new session's own full tool set", async () => {
		const { first, second } = await runWithNewSession(["/plan", "/new", "/build", "/quit"]);
		expect(second.session.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "bash", "edit", "write"]));
		first.cleanup();
		second.cleanup();
	});

	it("dispatches extension commands with their raw args, without the plan directive", async () => {
		const calls: string[] = [];
		const harness = await createHarnessWithExtensions({
			responses: ["should never be requested"],
			extensionFactories: [
				(pi) => {
					pi.registerCommand("ext", {
						description: "Test command",
						handler: async (args) => {
							calls.push(args);
						},
					});
				},
			],
		});
		const runtime = {
			session: harness.session,
			cwd: harness.tempDir,
			dispose: vi.fn().mockResolvedValue(undefined),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const rec = createRecordingWriter();
		const fake = createFakePrompter(["/plan", "/ext login github", "/ext", "/quit"]);

		await runAccessibleMode(
			runtime,
			{},
			{ writer: rec.writer, prompter: fake.prompter, registerSignalHandlers: false },
		);

		expect(calls).toEqual(["login github", ""]);
		expect(harness.faux.callCount).toBe(0);
		expect(rec.lines).not.toContain("Planning.");
		harness.cleanup();
	});

	it("the session tool-call guard blocks an active tool before it runs", async () => {
		const harness = await createHarness({
			responses: [{ toolCalls: [{ name: "bash", args: { command: "echo hi > guarded.txt" } }] }, "done"],
		});
		harness.session.setToolCallGuard((name) =>
			name === "bash" ? "Plan mode is active: bash is disabled." : undefined,
		);
		await harness.session.prompt("go");

		const ends = harness.eventsOfType("tool_execution_end");
		expect(ends).toHaveLength(1);
		expect(ends[0].isError).toBe(true);
		expect(JSON.stringify(ends[0].result)).toContain("Plan mode is active: bash is disabled.");
		expect(existsSync(join(harness.tempDir, "guarded.txt"))).toBe(false);
		harness.cleanup();
	});
});
