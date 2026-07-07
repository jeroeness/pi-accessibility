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
function toolStart(toolCallId: string, toolName: string, args: unknown): AgentSessionEvent {
	return { type: "tool_execution_start", toolCallId, toolName, args } as unknown as AgentSessionEvent;
}
function textResult(text: string, extra: Record<string, unknown> = {}): unknown {
	return { content: [{ type: "text", text }], ...extra };
}
function toolEnd(toolCallId: string, toolName: string, result: unknown, isError = false): AgentSessionEvent {
	return { type: "tool_execution_end", toolCallId, toolName, result, isError } as unknown as AgentSessionEvent;
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
	it("prints an Assistant header once and flushes complete lines across chunk boundaries", () => {
		const lines = render([
			textStart(),
			textDelta("Hel"),
			textDelta("lo wor"),
			textDelta("ld\n"),
			textDelta("second line\n"),
			textEnd(),
		]);
		expect(lines).toEqual(["Assistant:", "Hello world", "second line"]);
	});

	it("flushes a trailing partial line at end of message", () => {
		const lines = render([textStart(), textDelta("no newline here"), textEnd()]);
		expect(lines).toEqual(["Assistant:", "no newline here"]);
	});
});

describe("thinking", () => {
	it("emits nothing for thinking deltas", () => {
		const lines = render([textStart(), thinkingDelta("secret reasoning"), textDelta("visible\n"), textEnd()]);
		expect(lines).toEqual(["Assistant:", "visible"]);
		expect(lines.join("\n")).not.toContain("secret");
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
		expect(lines).toEqual(["» read: args.ts, main.ts", "» edit: args.ts (1)"]);
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
		expect(lines).toEqual(["» read: a.ts", "» bash: ls", "  ✓ bash ok — out", "» read: b.ts"]);
	});

	it("breaks a failed file op out of the group onto its own line", () => {
		const lines = render([
			toolStart("1", "read", { path: "a.ts" }),
			toolEnd("1", "read", textResult("...")),
			toolStart("2", "read", { path: "missing.ts" }),
			toolEnd("2", "read", textResult("no such file 'missing.ts'"), true),
		]);
		expect(lines).toEqual(["» read: a.ts", "» read: missing.ts — failed: no such file 'missing.ts'"]);
	});

	it("flushes the group before assistant text", () => {
		const lines = render([
			toolStart("1", "read", { path: "a.ts" }),
			toolEnd("1", "read", textResult("...")),
			textStart(),
			textDelta("done\n"),
			textEnd(),
		]);
		expect(lines).toEqual(["» read: a.ts", "Assistant:", "done"]);
	});
});

describe("bash", () => {
	it("shows the command and a single ok summary line", () => {
		const lines = render([
			toolStart("1", "bash", { command: "npm run test -- args" }),
			toolEnd("1", "bash", textResult("running...\n12 passed (12)")),
		]);
		expect(lines).toEqual(["» bash: npm run test -- args", "  ✓ bash ok — 12 passed (12)"]);
	});

	it("shows fail with exit code and a single summary line", () => {
		const lines = render([
			toolStart("1", "bash", { command: "npm run build" }),
			toolEnd("1", "bash", textResult("Cannot find name 'foo'", { details: { exitCode: 2 } }), true),
		]);
		expect(lines).toEqual(["» bash: npm run build", "  ✗ bash failed (exit 2) — Cannot find name 'foo'"]);
	});

	it("truncates a long command to <= 80 columns with an ellipsis", () => {
		const longCommand = `for f in $(git ls-files '*.ts'); do npx tsc --noEmit "$f" && echo "ok $f"; done # ${"x".repeat(40)}`;
		const lines = render([toolStart("1", "bash", { command: longCommand })]);
		const commandLine = lines[0];
		expect(commandLine.startsWith("» bash: ")).toBe(true);
		expect(commandLine.endsWith("…")).toBe(true);
		expect(commandLine.slice("» bash: ".length).length).toBe(80);
	});

	it("strips ANSI from the bash summary line", () => {
		const lines = render([
			toolStart("1", "bash", { command: "echo hi" }),
			toolEnd("1", "bash", textResult(`${ESC}[32mhi${ESC}[0m`)),
		]);
		expect(lines).toEqual(["» bash: echo hi", "  ✓ bash ok — hi"]);
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
