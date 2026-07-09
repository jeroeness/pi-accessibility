import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { dispatchCommand } from "../src/modes/accessible/commands.ts";
import { createPlanMode } from "../src/modes/accessible/plan-mode.ts";
import type { CommandContext } from "../src/modes/accessible/types.ts";
import { createFakePrompter, createRecordingWriter } from "./accessible-test-support.ts";

const MODELS = [
	{ provider: "anthropic", id: "opus" },
	{ provider: "openai", id: "gpt" },
];

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

function makeCtx(
	overrides: {
		prompterInputs?: string[];
		getCommand?: (name: string) => unknown;
		sessionOverrides?: Record<string, unknown>;
		newSession?: ReturnType<typeof vi.fn>;
		rebindSession?: ReturnType<typeof vi.fn>;
		thinkingLevel?: string;
		supportsThinking?: boolean;
		thinkingLevels?: string[];
		activeTools?: string[];
	} = {},
) {
	const rec = createRecordingWriter();
	const fake = createFakePrompter(overrides.prompterInputs ?? []);
	const setModel = vi.fn().mockResolvedValue(undefined);
	const compact = vi.fn().mockResolvedValue({});
	let thinkingLevel = overrides.thinkingLevel ?? "medium";
	// Mirrors the real session: setThinkingLevel updates the current level in place.
	const setThinkingLevel = vi.fn((level: string) => {
		thinkingLevel = level;
	});
	// Matches the real default active set; grep/find/ls are registered but off by default.
	let activeTools = overrides.activeTools ?? ["read", "bash", "edit", "write"];
	// Mirrors the real session: setActiveToolsByName swaps the active tool set in place.
	const setActiveToolsByName = vi.fn((names: string[]) => {
		activeTools = names;
	});
	const session = {
		model: { provider: "anthropic", id: "opus" },
		sessionId: "sess-1",
		sessionName: undefined,
		get thinkingLevel() {
			return thinkingLevel;
		},
		supportsThinking: () => overrides.supportsThinking ?? true,
		getAvailableThinkingLevels: () => overrides.thinkingLevels ?? THINKING_LEVELS,
		setThinkingLevel,
		getActiveToolNames: () => activeTools,
		setActiveToolsByName,
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

	const planMode = createPlanMode();

	const ctx: CommandContext = {
		session,
		runtime,
		writer: rec.writer,
		prompter: fake.prompter,
		renderer,
		planMode,
		rebindSession: rebindSession as unknown as () => Promise<void>,
	};
	return {
		ctx,
		rec,
		setModel,
		setThinkingLevel,
		setActiveToolsByName,
		planMode,
		compact,
		newSession,
		rebindSession,
		session,
		setBlockOutput,
	};
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
		expect(rec.lines[0]).toBe(
			"/help. /login. /logout. /model. /effort. /plan. /build. /compact. /session. /stream. /new. /quit.",
		);
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
		expect(rec.lines).toContain("  1. opus.");
		expect(rec.lines).toContain("openai:");
		expect(rec.lines).toContain("  2. gpt.");
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

describe("/effort", () => {
	it("lists the levels and switches by number", async () => {
		const { ctx, rec, setThinkingLevel } = makeCtx({ prompterInputs: ["5"] });
		expect(await dispatchCommand("/effort", ctx)).toEqual({ kind: "handled" });
		expect(rec.lines).toContain("Current thinking level: medium.");
		expect(rec.lines).toContain("Available levels:");
		expect(rec.lines).toContain("  5. high.");
		expect(setThinkingLevel).toHaveBeenCalledWith("high");
		expect(rec.lines).toContain("Thinking level set to high.");
	});

	it("keeps the current level when the selection is blank", async () => {
		const { ctx, rec, setThinkingLevel } = makeCtx({ prompterInputs: [""] });
		await dispatchCommand("/effort", ctx);
		expect(setThinkingLevel).not.toHaveBeenCalled();
		expect(rec.lines).toContain("Keeping current thinking level.");
	});

	it("sets the level directly from an argument", async () => {
		const { ctx, rec, setThinkingLevel } = makeCtx();
		await dispatchCommand("/effort xhigh", ctx);
		expect(setThinkingLevel).toHaveBeenCalledWith("xhigh");
		expect(rec.lines).toContain("Thinking level set to xhigh.");
	});

	it("reports when an argument does not match a level", async () => {
		const { ctx, rec, setThinkingLevel } = makeCtx();
		await dispatchCommand("/effort turbo", ctx);
		expect(setThinkingLevel).not.toHaveBeenCalled();
		expect(rec.lines.join("\n")).toContain('No thinking level matching "turbo"');
	});

	it("reports when the model does not support thinking", async () => {
		const { ctx, rec, setThinkingLevel } = makeCtx({ supportsThinking: false, thinkingLevel: "off" });
		await dispatchCommand("/effort", ctx);
		expect(setThinkingLevel).not.toHaveBeenCalled();
		expect(rec.lines.join("\n")).toContain("does not support thinking");
	});
});

describe("/plan and /build", () => {
	it("/plan restricts to read-only tools and enters plan mode", async () => {
		const { ctx, rec, setActiveToolsByName, planMode } = makeCtx();
		expect(await dispatchCommand("/plan", ctx)).toEqual({ kind: "handled" });
		expect(setActiveToolsByName).toHaveBeenCalledWith(["read", "grep", "find", "ls"]);
		expect(planMode.isActive()).toBe(true);
		expect(rec.lines).toContain("Plan mode on. Edit, write, and bash are disabled.");
		expect(rec.lines).toContain("Active tools: read, grep, find, ls.");
	});

	it("/build restores the full tool set and leaves plan mode", async () => {
		const { ctx, rec, setActiveToolsByName, planMode } = makeCtx();
		await dispatchCommand("/plan", ctx);
		setActiveToolsByName.mockClear();
		expect(await dispatchCommand("/build", ctx)).toEqual({ kind: "handled" });
		expect(setActiveToolsByName).toHaveBeenCalledWith(["read", "bash", "edit", "write"]);
		expect(planMode.isActive()).toBe(false);
		expect(rec.lines.join("\n")).toContain("Build mode on.");
	});

	it("plan mode decorates prompts and build mode leaves them untouched", async () => {
		const { ctx, planMode } = makeCtx();
		await dispatchCommand("/plan", ctx);
		expect(planMode.decorate("do the thing")).toContain("Plan mode is active");
		expect(planMode.decorate("do the thing")).toContain("do the thing");
		await dispatchCommand("/build", ctx);
		expect(planMode.decorate("do the thing")).toBe("do the thing");
	});

	it("/build is a no-op when already in build mode", async () => {
		const { ctx, rec, setActiveToolsByName } = makeCtx();
		expect(await dispatchCommand("/build", ctx)).toEqual({ kind: "handled" });
		expect(setActiveToolsByName).not.toHaveBeenCalled();
		expect(rec.lines.join("\n")).toContain("Already in build mode");
	});

	it("/plan is idempotent and does not lose the original tool set", async () => {
		const { ctx, rec, setActiveToolsByName, planMode } = makeCtx();
		await dispatchCommand("/plan", ctx);
		await dispatchCommand("/plan", ctx);
		expect(rec.lines.join("\n")).toContain("Already in plan mode");
		// A second /plan must not capture the already-restricted set as the restore point.
		setActiveToolsByName.mockClear();
		await dispatchCommand("/build", ctx);
		expect(setActiveToolsByName).toHaveBeenCalledWith(["read", "bash", "edit", "write"]);
		expect(planMode.isActive()).toBe(false);
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

	it("/new creates a session and rebinds without announcing the session id", async () => {
		const newSession = vi.fn().mockResolvedValue({ cancelled: false });
		const rebindSession = vi.fn().mockResolvedValue(undefined);
		const { ctx, rec } = makeCtx({ newSession, rebindSession });
		expect(await dispatchCommand("/new", ctx)).toEqual({ kind: "handled" });
		expect(newSession).toHaveBeenCalled();
		expect(rebindSession).toHaveBeenCalled();
		expect(rec.lines).toEqual(["Started a new session."]);
		expect(rec.lines.join("\n")).not.toContain("sess-1");
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
