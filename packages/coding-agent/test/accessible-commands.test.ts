import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { dispatchCommand } from "../src/modes/accessible/commands.ts";
import type { CommandContext } from "../src/modes/accessible/types.ts";
import { createFakePrompter, createRecordingWriter } from "./accessible-test-support.ts";

const MODELS = [
	{ provider: "anthropic", id: "opus" },
	{ provider: "openai", id: "gpt" },
];

function makeCtx(
	overrides: {
		prompterInputs?: string[];
		getCommand?: (name: string) => unknown;
		sessionOverrides?: Record<string, unknown>;
		newSession?: ReturnType<typeof vi.fn>;
		rebindSession?: ReturnType<typeof vi.fn>;
	} = {},
) {
	const rec = createRecordingWriter();
	const fake = createFakePrompter(overrides.prompterInputs ?? []);
	const setModel = vi.fn().mockResolvedValue(undefined);
	const compact = vi.fn().mockResolvedValue({});
	const session = {
		model: { provider: "anthropic", id: "opus" },
		sessionId: "sess-1",
		sessionName: undefined,
		thinkingLevel: "medium",
		modelRegistry: { getAvailable: vi.fn().mockResolvedValue(MODELS) },
		setModel,
		compact,
		getSessionStats: () => ({
			totalMessages: 3,
			userMessages: 1,
			assistantMessages: 1,
			toolCalls: 0,
			tokens: { input: 10, output: 5, total: 15 },
			sessionFile: "/tmp/x.jsonl",
		}),
		extensionRunner: { getCommand: vi.fn(overrides.getCommand ?? (() => undefined)) },
		...overrides.sessionOverrides,
	} as unknown as AgentSession;

	const newSession = overrides.newSession ?? vi.fn().mockResolvedValue({ cancelled: false });
	const runtime = { session, newSession } as unknown as AgentSessionRuntime;
	const rebindSession = overrides.rebindSession ?? vi.fn().mockResolvedValue(undefined);

	let blockOutput = false;
	const setBlockOutput = vi.fn((value: boolean) => {
		blockOutput = value;
	});
	const renderer = {
		handle: () => {},
		endTurn: () => {},
		setBlockOutput,
		getBlockOutput: () => blockOutput,
	};

	const ctx: CommandContext = {
		session,
		runtime,
		writer: rec.writer,
		prompter: fake.prompter,
		renderer,
		rebindSession: rebindSession as unknown as () => Promise<void>,
	};
	return { ctx, rec, setModel, compact, newSession, rebindSession, session, setBlockOutput };
}

describe("dispatchCommand routing", () => {
	it("sends non-slash lines to the agent", async () => {
		const { ctx } = makeCtx();
		expect(await dispatchCommand("hello there", ctx)).toEqual({ kind: "sendAsPrompt" });
	});

	it("/quit exits with code 0", async () => {
		const { ctx } = makeCtx();
		expect(await dispatchCommand("/quit", ctx)).toEqual({ kind: "exit", code: 0 });
		expect(await dispatchCommand("/exit", makeCtx().ctx)).toEqual({ kind: "exit", code: 0 });
	});

	it("/help prints the command list", async () => {
		const { ctx, rec } = makeCtx();
		expect(await dispatchCommand("/help", ctx)).toEqual({ kind: "handled" });
		expect(rec.lines[0]).toBe("Commands:");
	});

	it("unknown command prints a hint and is handled", async () => {
		const { ctx, rec } = makeCtx();
		expect(await dispatchCommand("/bogus", ctx)).toEqual({ kind: "handled" });
		expect(rec.lines.join("\n")).toContain("Unknown command: /bogus");
	});

	it("falls through to the agent for a registered extension command", async () => {
		const { ctx } = makeCtx({ getCommand: (name) => (name === "deploy" ? { invocationName: "deploy" } : undefined) });
		expect(await dispatchCommand("/deploy prod", ctx)).toEqual({ kind: "sendAsPrompt" });
	});
});

describe("/model", () => {
	it("lists models grouped by provider and switches by number", async () => {
		const { ctx, rec, setModel } = makeCtx({ prompterInputs: ["2"] });
		expect(await dispatchCommand("/model", ctx)).toEqual({ kind: "handled" });
		// Grouped: provider headers with model ids indented under them, numbered across the list.
		expect(rec.lines).toContain("anthropic:");
		expect(rec.lines).toContain("  1. opus");
		expect(rec.lines).toContain("openai:");
		expect(rec.lines).toContain("  2. gpt");
		expect(setModel).toHaveBeenCalledWith(MODELS[1]);
	});

	it("keeps current model when selection is blank", async () => {
		const { ctx, setModel } = makeCtx({ prompterInputs: [""] });
		await dispatchCommand("/model", ctx);
		expect(setModel).not.toHaveBeenCalled();
	});

	it("switches by pattern argument", async () => {
		const { ctx, setModel } = makeCtx();
		await dispatchCommand("/model gpt", ctx);
		expect(setModel).toHaveBeenCalledWith(MODELS[1]);
	});

	it("reports when a pattern does not match", async () => {
		const { ctx, rec, setModel } = makeCtx();
		await dispatchCommand("/model nope", ctx);
		expect(setModel).not.toHaveBeenCalled();
		expect(rec.lines.join("\n")).toContain('No model matching "nope"');
	});
});

describe("/compact and /session and /new", () => {
	it("/compact forwards instructions to the session", async () => {
		const { ctx, compact } = makeCtx();
		await dispatchCommand("/compact keep the API notes", ctx);
		expect(compact).toHaveBeenCalledWith("keep the API notes");
	});

	it("/session prints labeled stats", async () => {
		const { ctx, rec } = makeCtx();
		await dispatchCommand("/session", ctx);
		expect(rec.lines.some((l) => l.startsWith("Session: sess-1"))).toBe(true);
		expect(rec.lines.some((l) => l.startsWith("Messages: 3"))).toBe(true);
	});

	it("/new creates a session and rebinds", async () => {
		const newSession = vi.fn().mockResolvedValue({ cancelled: false });
		const rebindSession = vi.fn().mockResolvedValue(undefined);
		const { ctx } = makeCtx({ newSession, rebindSession });
		expect(await dispatchCommand("/new", ctx)).toEqual({ kind: "handled" });
		expect(newSession).toHaveBeenCalled();
		expect(rebindSession).toHaveBeenCalled();
	});
});

describe("/stream", () => {
	it("toggles block and line streaming and reports the current mode", async () => {
		const { ctx, rec, setBlockOutput } = makeCtx();

		expect(await dispatchCommand("/stream block", ctx)).toEqual({ kind: "handled" });
		expect(setBlockOutput).toHaveBeenLastCalledWith(true);

		await dispatchCommand("/stream line", ctx);
		expect(setBlockOutput).toHaveBeenLastCalledWith(false);

		await dispatchCommand("/stream", ctx);
		expect(rec.lines.join("\n")).toContain("Streaming mode: line");
	});
});
