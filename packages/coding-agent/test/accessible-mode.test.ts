import { describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { runAccessibleMode } from "../src/modes/accessible/accessible-mode.ts";
import { createFakePrompter, createRecordingWriter, tick } from "./accessible-test-support.ts";
import { createHarness } from "./test-harness.ts";

describe("runAccessibleMode (end to end)", () => {
	it("renders a full turn as a clean linear transcript and exits on /quit", async () => {
		const harness = createHarness({ responses: ["Hello there"] });
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
		expect(rec.lines[0].startsWith("Pi coding agent v")).toBe(true);
		expect(transcript).toContain("Hello there");
		// No "Assistant:" header and no end-of-turn marker (removed as clutter).
		expect(transcript).not.toContain("Assistant:");
		expect(transcript).not.toContain("[turn complete]");
		// Append-only: never an escape byte.
		expect(transcript).not.toContain(String.fromCharCode(27));

		harness.cleanup();
	});

	it("block-output mode emits a multi-line reply as a single block", async () => {
		const harness = createHarness({ responses: ["line one\nline two"] });
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

	it("shows the no-model banner and uses the Δ prompt", async () => {
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
		expect(fake.prompts.some((prompt) => prompt.includes("Δ"))).toBe(true);
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
		bindExtensions: vi.fn().mockResolvedValue(undefined),
		subscribe: vi.fn(() => () => {}),
		navigateTree: vi.fn().mockResolvedValue({ cancelled: false }),
		reload: vi.fn().mockResolvedValue(undefined),
		prompt: vi.fn().mockResolvedValue(undefined),
		abort: vi.fn().mockResolvedValue(undefined),
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
});
