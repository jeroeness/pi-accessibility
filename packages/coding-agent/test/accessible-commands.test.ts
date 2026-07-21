import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { type SessionInfo, SessionManager } from "../src/core/session-manager.ts";
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
		switchSession?: ReturnType<typeof vi.fn>;
		resumeSession?: ReturnType<typeof vi.fn>;
		usesDefaultSessionDir?: boolean;
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
		sessionManager: {
			getCwd: () => "/project",
			getSessionDir: () => "/project/.pi/sessions",
			usesDefaultSessionDir: () => overrides.usesDefaultSessionDir ?? true,
		},
		...overrides.sessionOverrides,
	} as unknown as AgentSession;

	const newSession = overrides.newSession ?? vi.fn().mockResolvedValue({ cancelled: false });
	const switchSession = overrides.switchSession ?? vi.fn().mockResolvedValue({ cancelled: false });
	const runtime = { session, newSession, switchSession } as unknown as AgentSessionRuntime;
	const rebindSession = overrides.rebindSession ?? vi.fn().mockResolvedValue(undefined);
	const resumeSession = overrides.resumeSession ?? vi.fn().mockResolvedValue({ cancelled: false });

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
		resumeSession: resumeSession as unknown as CommandContext["resumeSession"],
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
		switchSession,
		resumeSession,
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
			"/help. /login. /logout. /model. /effort. /plan. /build. /compact. /session. /token quota. /stream. /new. /resume. /resumeglobal. /quit.",
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

	it("/new clears prior terminal output, leaving only the new-session line", async () => {
		const { ctx, rec } = makeCtx();
		// Simulate an existing conversation on screen before /new.
		rec.writer.line("^ earlier question");
		rec.writer.line("an earlier answer");
		expect(await dispatchCommand("/new", ctx)).toEqual({ kind: "handled" });
		expect(rec.lines).toEqual(["Started a new session."]);
		expect(rec.lines.join("\n")).not.toContain("earlier");
	});

	it("/new does not clear the screen when the new session is cancelled", async () => {
		const newSession = vi.fn().mockResolvedValue({ cancelled: true });
		const { ctx, rec } = makeCtx({ newSession });
		rec.writer.line("keep me visible");
		await dispatchCommand("/new", ctx);
		expect(rec.lines).toEqual(["keep me visible", "New session cancelled."]);
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

describe("/resume and /resumeglobal", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function makeSession(overrides: Partial<SessionInfo>): SessionInfo {
		return {
			path: "/project/.pi/sessions/a.jsonl",
			id: "a",
			cwd: "/project",
			created: new Date(),
			modified: new Date(),
			messageCount: 1,
			firstMessage: "hello",
			allMessagesText: "hello",
			...overrides,
		};
	}

	it("lists project sessions and resumes by number", async () => {
		const sessions = [
			makeSession({ path: "/p/1.jsonl", id: "1", name: "first", modified: new Date(Date.now() - 120000) }),
			makeSession({
				path: "/p/2.jsonl",
				id: "2",
				firstMessage: "fix the bug",
				modified: new Date(Date.now() - 7200000),
			}),
		];
		const list = vi.spyOn(SessionManager, "list").mockResolvedValue(sessions);
		const { ctx, rec, resumeSession } = makeCtx({ prompterInputs: ["2"] });

		expect(await dispatchCommand("/resume", ctx)).toEqual({ kind: "handled" });
		expect(list).toHaveBeenCalledWith("/project", "/project/.pi/sessions");
		expect(rec.lines).toContain("Recent sessions in this project:");
		expect(rec.lines).toContain("  1. first. (2 minutes ago).");
		expect(rec.lines).toContain("  2. fix the bug. (2 hours ago).");
		// An unnamed session passes its first-message preview (not undefined) so the
		// resume gate can identify it by content instead of showing "(unnamed)".
		expect(resumeSession).toHaveBeenCalledWith("/p/2.jsonl", "fix the bug");
	});

	it("does not double the period when a long preview is truncated", async () => {
		const longMessage = "a".repeat(200);
		vi.spyOn(SessionManager, "list").mockResolvedValue([
			makeSession({ firstMessage: longMessage, modified: new Date(Date.now() - 120000) }),
		]);
		const { ctx, rec } = makeCtx({ prompterInputs: [""] });
		await dispatchCommand("/resume", ctx);
		const line = rec.lines.find((l) => l.startsWith("  1."));
		expect(line).toContain("... (2 minutes ago).");
		expect(line).not.toContain("....");
	});

	it("does not resume when the selection is blank", async () => {
		vi.spyOn(SessionManager, "list").mockResolvedValue([makeSession({})]);
		const { ctx, rec, resumeSession } = makeCtx({ prompterInputs: [""] });
		await dispatchCommand("/resume", ctx);
		expect(resumeSession).not.toHaveBeenCalled();
		expect(rec.lines).toContain("Not resuming.");
	});

	it("does not resume on an out-of-range selection", async () => {
		vi.spyOn(SessionManager, "list").mockResolvedValue([makeSession({})]);
		const { ctx, rec, resumeSession } = makeCtx({ prompterInputs: ["9"] });
		await dispatchCommand("/resume", ctx);
		expect(resumeSession).not.toHaveBeenCalled();
		expect(rec.lines).toContain("Not resuming.");
	});

	it("resumes directly from a numeric argument without prompting", async () => {
		const sessions = [makeSession({ path: "/p/1.jsonl", id: "1" }), makeSession({ path: "/p/2.jsonl", id: "2" })];
		vi.spyOn(SessionManager, "list").mockResolvedValue(sessions);
		const { ctx, resumeSession } = makeCtx();
		await dispatchCommand("/resume 1", ctx);
		expect(resumeSession).toHaveBeenCalledWith("/p/1.jsonl", "hello");
	});

	it("reports when a numeric argument is out of range", async () => {
		vi.spyOn(SessionManager, "list").mockResolvedValue([makeSession({})]);
		const { ctx, rec, resumeSession } = makeCtx();
		await dispatchCommand("/resume 5", ctx);
		expect(resumeSession).not.toHaveBeenCalled();
		expect(rec.lines.join("\n")).toContain("No matching session. Not resuming.");
	});

	it("caps the list at 10 sessions", async () => {
		const sessions = Array.from({ length: 15 }, (_, i) =>
			makeSession({ path: `/p/${i}.jsonl`, id: `${i}`, name: `session ${i}` }),
		);
		vi.spyOn(SessionManager, "list").mockResolvedValue(sessions);
		const { ctx, rec } = makeCtx({ prompterInputs: [""] });
		await dispatchCommand("/resume", ctx);
		expect(rec.lines.some((l) => l.startsWith("  10."))).toBe(true);
		expect(rec.lines.some((l) => l.startsWith("  11."))).toBe(false);
	});

	it("reports when no project sessions exist", async () => {
		vi.spyOn(SessionManager, "list").mockResolvedValue([]);
		const { ctx, rec } = makeCtx();
		await dispatchCommand("/resume", ctx);
		expect(rec.lines).toContain("No sessions found in this project.");
	});

	it("/resumeglobal lists sessions across all projects", async () => {
		const listAll = vi.spyOn(SessionManager, "listAll").mockResolvedValue([makeSession({ path: "/p/g.jsonl" })]);
		const { ctx, rec } = makeCtx({ prompterInputs: [""] });
		expect(await dispatchCommand("/resumeglobal", ctx)).toEqual({ kind: "handled" });
		expect(listAll).toHaveBeenCalledWith();
		expect(rec.lines).toContain("Recent sessions across all projects:");
	});

	it("/resumeglobal honors a custom session dir", async () => {
		const listAll = vi.spyOn(SessionManager, "listAll").mockResolvedValue([makeSession({})]);
		const { ctx } = makeCtx({ prompterInputs: [""], usesDefaultSessionDir: false });
		await dispatchCommand("/resumeglobal", ctx);
		expect(listAll).toHaveBeenCalledWith("/project/.pi/sessions");
	});

	it("prints an error when listing fails", async () => {
		vi.spyOn(SessionManager, "list").mockRejectedValue(new Error("disk gone"));
		const { ctx, rec } = makeCtx();
		await dispatchCommand("/resume", ctx);
		expect(rec.errors.join("\n")).toContain("disk gone");
	});
});
