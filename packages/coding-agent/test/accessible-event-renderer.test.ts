import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { createEventRenderer } from "../src/modes/accessible/event-renderer.ts";
import { createRecordingWriter } from "./accessible-test-support.ts";

const ESC = String.fromCharCode(27);

// --- event builders --------------------------------------------------------

function textStart(): AgentSessionEvent {
	return {
		type: "message_update",
		message: {},
		assistantMessageEvent: { type: "start", partial: {} },
	} as unknown as AgentSessionEvent;
}
function textDelta(delta: string): AgentSessionEvent {
	return {
		type: "message_update",
		message: {},
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: {} },
	} as unknown as AgentSessionEvent;
}
function textEnd(): AgentSessionEvent {
	return {
		type: "message_update",
		message: {},
		assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "", partial: {} },
	} as unknown as AgentSessionEvent;
}
function thinkingDelta(delta: string): AgentSessionEvent {
	return {
		type: "message_update",
		message: {},
		assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta, partial: {} },
	} as unknown as AgentSessionEvent;
}
function thinkingEnd(): AgentSessionEvent {
	return {
		type: "message_update",
		message: {},
		assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "", partial: {} },
	} as unknown as AgentSessionEvent;
}
function toolStart(toolCallId: string, toolName: string, args: unknown): AgentSessionEvent {
	return { type: "tool_execution_start", toolCallId, toolName, args } as unknown as AgentSessionEvent;
}
function textResult(text: string, extra: Record<string, unknown> = {}): unknown {
	return { content: [{ type: "text", text }], ...extra };
}
function toolEnd(toolCallId: string, toolName: string, result: unknown, isError = false): AgentSessionEvent {
	return { type: "tool_execution_end", toolCallId, toolName, result, isError } as unknown as AgentSessionEvent;
}
function turnEnd(): AgentSessionEvent {
	return { type: "turn_end", message: {}, toolResults: [] } as unknown as AgentSessionEvent;
}

function render(events: AgentSessionEvent[]): string[] {
	const rec = createRecordingWriter();
	const renderer = createEventRenderer(rec.writer);
	for (const event of events) {
		renderer.handle(event);
	}
	renderer.endTurn();
	// No escape bytes may ever be emitted.
	for (const line of [...rec.lines, ...rec.errors]) {
		expect(line).not.toContain(ESC);
	}
	return rec.lines;
}

// --- tests -----------------------------------------------------------------

describe("assistant text", () => {
	it("flushes complete lines across chunk boundaries (no header)", () => {
		const lines = render([
			textStart(),
			textDelta("Hel"),
			textDelta("lo wor"),
			textDelta("ld\n"),
			textDelta("second line\n"),
			textEnd(),
		]);
		expect(lines).toEqual(["Hello world", "second line"]);
	});

	it("flushes a trailing partial line at end of message", () => {
		const lines = render([textStart(), textDelta("no newline here"), textEnd()]);
		expect(lines).toEqual(["no newline here"]);
	});
});

describe("thinking", () => {
	it("emits nothing for thinking deltas", () => {
		const lines = render([textStart(), thinkingDelta("secret reasoning"), textDelta("visible\n"), textEnd()]);
		expect(lines).toEqual(["visible"]);
		expect(lines.join("\n")).not.toContain("secret");
	});

	it("drops thinking even when it is the only content of the turn", () => {
		expect(render([textStart(), thinkingDelta("just musing\n"), thinkingEnd()])).toEqual([]);
	});

	it("prints reasoning behind a Thinking. marker when verbose is on", () => {
		const rec = createRecordingWriter();
		const renderer = createEventRenderer(rec.writer, { verbose: true });
		renderer.handle(textStart());
		renderer.handle(thinkingDelta("first thought\nsecond thought\n"));
		renderer.handle(thinkingEnd());
		renderer.handle(textDelta("the answer\n"));
		renderer.handle(textEnd());
		// The marker opens the block once, then reasoning streams line by line, then the reply.
		expect(rec.lines).toEqual(["Thinking.", "first thought", "second thought", "the answer"]);
	});

	it("re-announces each reasoning block and keeps reasoning ahead of tool lines", () => {
		const rec = createRecordingWriter();
		const renderer = createEventRenderer(rec.writer, { verbose: true });
		renderer.handle(thinkingDelta("look first\n"));
		renderer.handle(thinkingEnd());
		renderer.handle(toolStart("1", "read", { path: "src/args.ts" }));
		renderer.handle(toolEnd("1", "read", textResult("...")));
		renderer.handle(thinkingDelta("now decide\n"));
		renderer.handle(thinkingEnd());
		renderer.handle(textDelta("done\n"));
		renderer.endTurn();
		expect(rec.lines).toEqual(["Thinking.", "look first", "» read: args.ts.", "Thinking.", "now decide", "done"]);
	});

	it("holds a whole reasoning block in block mode", () => {
		const rec = createRecordingWriter();
		const renderer = createEventRenderer(rec.writer, { verbose: true, blockOutput: true });
		renderer.handle(thinkingDelta("line one\nline two\n"));
		expect(rec.lines).toEqual(["Thinking."]);
		renderer.handle(thinkingEnd());
		expect(rec.lines).toEqual(["Thinking.", "line one\nline two"]);
	});

	it("toggles at runtime, and turning it off drops the block still streaming", () => {
		const rec = createRecordingWriter();
		const renderer = createEventRenderer(rec.writer); // reasoning hidden by default
		expect(renderer.getVerbose()).toBe(false);
		renderer.handle(thinkingDelta("hidden\n"));
		expect(rec.lines).toEqual([]);

		renderer.setVerbose(true);
		expect(renderer.getVerbose()).toBe(true);
		renderer.handle(thinkingDelta("shown"));
		renderer.setVerbose(false);
		// The partial line buffered while verbose was on is dropped, not spoken late.
		renderer.handle(thinkingEnd());
		renderer.handle(textDelta("reply\n"));
		renderer.endTurn();
		expect(rec.lines).toEqual(["Thinking.", "reply"]);
	});

	it("sends reasoning to the thinking writer so it stays out of the recorded transcript", () => {
		const spoken = createRecordingWriter();
		const recorded = createRecordingWriter();
		// Mirrors accessible mode: the main writer is the recorded one, reasoning is not.
		const renderer = createEventRenderer(recorded.writer, { verbose: true, thinkingWriter: spoken.writer });
		renderer.handle(thinkingDelta("private reasoning\n"));
		renderer.handle(thinkingEnd());
		renderer.handle(textDelta("public answer\n"));
		renderer.endTurn();
		expect(spoken.lines).toEqual(["Thinking.", "private reasoning"]);
		expect(recorded.lines).toEqual(["public answer"]);
	});
});

describe("file tool grouping", () => {
	it("groups consecutive file tools by type (read, read, edit -> two lines)", () => {
		const lines = render([
			toolStart("1", "read", { path: "src/args.ts" }),
			toolEnd("1", "read", textResult("...")),
			toolStart("2", "read", { path: "src/main.ts" }),
			toolEnd("2", "read", textResult("...")),
			toolStart("3", "edit", { path: "src/args.ts", edits: [{ oldText: "a", newText: "b" }] }),
			toolEnd("3", "edit", textResult("ok")),
		]);
		expect(lines).toEqual(["» read: args.ts, main.ts.", "» edit: args.ts."]);
	});

	it("collapses repeated targets within a group to one counted entry", () => {
		const lines = render([
			toolStart("1", "read", { path: "src/a.ts" }),
			toolEnd("1", "read", textResult("...")),
			toolStart("2", "read", { path: "src/a.ts" }),
			toolEnd("2", "read", textResult("...")),
			toolStart("3", "read", { path: "src/b.ts" }),
			toolEnd("3", "read", textResult("...")),
		]);
		expect(lines).toEqual(["» read: a.ts (2), b.ts."]);
	});

	it("counts repeated edits to the same file (uniform times-touched count)", () => {
		const lines = render([
			toolStart("1", "edit", { path: "src/a.ts", edits: [{ oldText: "x", newText: "y" }] }),
			toolEnd("1", "edit", textResult("ok")),
			toolStart("2", "edit", { path: "src/a.ts", edits: [{ oldText: "p", newText: "q" }] }),
			toolEnd("2", "edit", textResult("ok")),
		]);
		expect(lines).toEqual(["» edit: a.ts (2)."]);
	});

	it("does not merge across assistant text (reading order preserved)", () => {
		const lines = render([
			toolStart("1", "read", { path: "a.ts" }),
			toolEnd("1", "read", textResult("...")),
			textStart(),
			textDelta("looking\n"),
			textEnd(),
			toolStart("2", "read", { path: "a.ts" }),
			toolEnd("2", "read", textResult("...")),
		]);
		expect(lines).toEqual(["» read: a.ts.", "looking", "» read: a.ts."]);
	});

	it("breaks the group at a bash call (read, bash, read -> three groups)", () => {
		const lines = render([
			toolStart("1", "read", { path: "a.ts" }),
			toolEnd("1", "read", textResult("...")),
			toolStart("2", "bash", { command: "ls" }),
			toolEnd("2", "bash", textResult("out")),
			toolStart("3", "read", { path: "b.ts" }),
			toolEnd("3", "read", textResult("...")),
		]);
		expect(lines).toEqual(["» read: a.ts.", "bash ls ok.", "» read: b.ts."]);
	});

	it("breaks a failed file op out of the group onto its own minimal line (no status or message)", () => {
		const lines = render([
			toolStart("1", "read", { path: "a.ts" }),
			toolEnd("1", "read", textResult("...")),
			toolStart("2", "read", { path: "pi" }),
			toolEnd("2", "read", textResult("EISDIR: illegal operation on a directory, read"), true),
		]);
		expect(lines).toEqual(["» read: a.ts.", "read: pi failed."]);
	});

	it("flushes the group before assistant text", () => {
		const lines = render([
			toolStart("1", "read", { path: "a.ts" }),
			toolEnd("1", "read", textResult("...")),
			textStart(),
			textDelta("done\n"),
			textEnd(),
		]);
		expect(lines).toEqual(["» read: a.ts.", "done"]);
	});
});

describe("skill loads", () => {
	const skillFile = "/home/user/.pi/skills/deep-research/SKILL.md";
	function skillContent(name: string): string {
		return `---\nname: ${name}\ndescription: Do deep research.\n---\nSkill body here.`;
	}

	it("announces a SKILL.md read by its frontmatter name instead of `» read: SKILL.md`", () => {
		const lines = render([
			toolStart("1", "read", { path: skillFile }),
			toolEnd("1", "read", textResult(skillContent("deep-research"))),
		]);
		expect(lines).toEqual(["Loaded deep-research."]);
	});

	it("falls back to the skill directory name when the frontmatter has no name field", () => {
		const lines = render([
			toolStart("1", "read", { path: skillFile }),
			toolEnd("1", "read", textResult("---\ndescription: No name field.\n---\nBody.")),
		]);
		expect(lines).toEqual(["Loaded deep-research."]);
	});

	it("keeps a skill announcement on its own line, preserving reading order", () => {
		const lines = render([
			toolStart("1", "read", { path: "src/a.ts" }),
			toolEnd("1", "read", textResult("...")),
			toolStart("2", "read", { path: skillFile }),
			toolEnd("2", "read", textResult(skillContent("deep-research"))),
			toolStart("3", "read", { path: "src/b.ts" }),
			toolEnd("3", "read", textResult("...")),
		]);
		expect(lines).toEqual(["» read: a.ts.", "Loaded deep-research.", "» read: b.ts."]);
	});

	it("still reports a failed SKILL.md read as a failure, not a load", () => {
		const lines = render([
			toolStart("1", "read", { path: skillFile }),
			toolEnd("1", "read", textResult("EACCES: permission denied"), true),
		]);
		expect(lines).toEqual(["read: SKILL.md failed."]);
	});
});

describe("bash", () => {
	it("shows the tool, first command word, and ok status; never the args or output", () => {
		const lines = render([
			toolStart("1", "bash", { command: "npm run test -- args" }),
			toolEnd("1", "bash", textResult("running...\n12 passed (12)")),
		]);
		expect(lines).toEqual(["bash npm ok."]);
	});

	it("shows failed status without the command output or exit code", () => {
		const lines = render([
			toolStart("1", "bash", { command: "npm run build" }),
			toolEnd("1", "bash", textResult("Cannot find name 'foo'", { details: { exitCode: 2 } }), true),
		]);
		expect(lines).toEqual(["bash npm failed."]);
	});

	it("groups a run of same-command calls into one counted line", () => {
		const events: AgentSessionEvent[] = [];
		for (let i = 1; i <= 5; i++) {
			events.push(toolStart(String(i), "bash", { command: `grep -n foo file${i}.ts` }));
			events.push(toolEnd(String(i), "bash", textResult("...")));
		}
		expect(render(events)).toEqual(["bash grep (5) ok."]);
	});

	it("groups repeated tool calls across agent steps into counted lines", () => {
		// Each agent step ends with turn_end; tool runs must accumulate across them
		// so separate-step duplicates collapse instead of printing one line per step.
		const lines = render([
			toolStart("1", "bash", { command: "find . -name x" }),
			toolEnd("1", "bash", textResult("...")),
			turnEnd(),
			toolStart("2", "bash", { command: "find . -name y" }),
			toolEnd("2", "bash", textResult("...")),
			turnEnd(),
			toolStart("3", "read", { path: "src/system-prompt.ts" }),
			toolEnd("3", "read", textResult("...")),
			turnEnd(),
			toolStart("4", "read", { path: "src/system-prompt.ts" }),
			toolEnd("4", "read", textResult("...")),
			toolStart("5", "read", { path: "src/prompt-templates.ts" }),
			toolEnd("5", "read", textResult("...")),
			turnEnd(),
		]);
		expect(lines).toEqual(["bash find (2) ok.", "» read: system-prompt.ts (2), prompt-templates.ts."]);
	});

	it("splits ok and failed of the same command into separate lines within a run", () => {
		const lines = render([
			toolStart("1", "bash", { command: "grep a" }),
			toolEnd("1", "bash", textResult("...")),
			toolStart("2", "bash", { command: "grep b" }),
			toolEnd("2", "bash", textResult("boom"), true),
			toolStart("3", "bash", { command: "grep c" }),
			toolEnd("3", "bash", textResult("...")),
		]);
		expect(lines).toEqual(["bash grep (2) ok.", "bash grep failed."]);
	});

	it("skips a leading `cd` and reports the command that follows the connector", () => {
		const lines = render([
			toolStart("1", "bash", { command: "cd packages/coding-agent && grep -rn foo src" }),
			toolEnd("1", "bash", textResult("...")),
		]);
		expect(lines).toEqual(["bash grep ok."]);
	});

	it("skips env-assignment and wrapper prefixes", () => {
		const lines = render([
			toolStart("1", "bash", { command: "NODE_ENV=test npm run test" }),
			toolEnd("1", "bash", textResult("...")),
			toolStart("2", "bash", { command: "sudo apt-get install ripgrep" }),
			toolEnd("2", "bash", textResult("...")),
		]);
		expect(lines).toEqual(["bash npm ok.", "bash apt-get ok."]);
	});

	it("keeps the navigation word when the whole command is just navigation", () => {
		const lines = render([
			toolStart("1", "bash", { command: "cd /tmp/build" }),
			toolEnd("1", "bash", textResult("")),
		]);
		expect(lines).toEqual(["bash cd ok."]);
	});

	it("distinguishes real commands that share a `cd` prefix instead of merging them", () => {
		// The motivating bug: every `cd … && <cmd>` collapsed into one `bash cd` bucket.
		const lines = render([
			toolStart("1", "bash", { command: "cd pkg && npm test" }),
			toolEnd("1", "bash", textResult("...")),
			toolStart("2", "bash", { command: "cd pkg && grep -n foo x" }),
			toolEnd("2", "bash", textResult("...")),
		]);
		expect(lines).toEqual(["bash npm ok.", "bash grep ok."]);
	});
});

describe("other one-off tools", () => {
	it("renders a failure minimally, without the error message", () => {
		const lines = render([
			toolStart("1", "webfetch", { url: "https://x" }),
			toolEnd("1", "webfetch", textResult("403 Forbidden"), true),
		]);
		expect(lines).toEqual(["webfetch: failed."]);
	});
});

describe("block streaming", () => {
	it("buffers the whole message and emits it as one block on message end", () => {
		const rec = createRecordingWriter();
		const renderer = createEventRenderer(rec.writer, { blockOutput: true });
		renderer.handle(textStart());
		renderer.handle(textDelta("Hello world\n"));
		renderer.handle(textDelta("second line\n"));
		// Nothing is emitted mid-stream in block mode.
		expect(rec.lines).toEqual([]);
		renderer.handle(textEnd());
		// One write containing the whole message (trailing blank line trimmed).
		expect(rec.lines).toEqual(["Hello world\nsecond line"]);
	});

	it("can be toggled on at runtime", () => {
		const rec = createRecordingWriter();
		const renderer = createEventRenderer(rec.writer); // starts in line mode
		renderer.setBlockOutput(true);
		expect(renderer.getBlockOutput()).toBe(true);
		renderer.handle(textStart());
		renderer.handle(textDelta("a\nb\n"));
		expect(rec.lines).toEqual([]);
		renderer.endTurn();
		expect(rec.lines).toEqual(["a\nb"]);
	});
});

describe("session events", () => {
	it("renders compaction and retry markers", () => {
		const rec = createRecordingWriter();
		const renderer = createEventRenderer(rec.writer);
		renderer.handle({ type: "compaction_start", reason: "manual" } as unknown as AgentSessionEvent);
		renderer.handle({
			type: "compaction_end",
			reason: "manual",
			result: undefined,
			aborted: false,
			willRetry: false,
		} as unknown as AgentSessionEvent);
		renderer.handle({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 1000,
			errorMessage: "529 overloaded",
		} as unknown as AgentSessionEvent);
		expect(rec.lines).toEqual([
			"[compacting context…]",
			"[context compacted]",
			"[retrying (attempt 1/3) after error: 529 overloaded]",
		]);
	});
});

describe("powershell and nested tool calls", () => {
	it("summarises powershell calls like bash, grouped by command word", () => {
		const events = [
			toolStart("p1", "powershell", { command: "Set-Location src; Get-ChildItem -Recurse" }),
			toolEnd("p1", "powershell", textResult("a.ts")),
			toolStart("p2", "powershell", { command: "Get-ChildItem" }),
			toolEnd("p2", "powershell", textResult("b.ts")),
			toolStart("b1", "bash", { command: "ls" }),
			toolEnd("b1", "bash", textResult("x")),
		];
		expect(render(events)).toEqual(["powershell Get-ChildItem (2) ok.", "bash ls ok."]);
	});

	it("does not announce calls another tool made through ctx.executeTool()", () => {
		const nested = (event: AgentSessionEvent) => ({ ...event, parentToolCallId: "c1" }) as AgentSessionEvent;
		const events = [
			toolStart("c1", "codemode", { code: "await tools.read({ path: 'a.ts' })" }),
			nested(toolStart("n1", "read", { path: "a.ts" })),
			nested(toolEnd("n1", "read", textResult("content"))),
			toolEnd("c1", "codemode", textResult("done")),
		];
		expect(render(events)).toEqual(["» codemode: done."]);
	});
});
