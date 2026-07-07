/**
 * Turns the session event stream into plain, append-only text for screen readers.
 *
 * Design (see PLAN-ACCESSIBILITY.md §2):
 * - Assistant text is line-buffered: deltas accumulate and flush on newline / size cap.
 * - Model thinking is dropped entirely (no tokens, no marker).
 * - Consecutive file tools (read/edit/write/ls/grep/find) are grouped by type: one
 *   line per tool name, e.g. `» read: a.ts, b.ts` then `» edit: a.ts (1)`.
 * - bash shows its (truncated) command plus a single ok/fail summary line; the full
 *   output is never printed.
 */

import { basename } from "node:path";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "../../core/agent-session.ts";
import { lastNonEmptyLine, truncateLine } from "./line-writer.ts";
import type { EventRenderer, LineWriter } from "./types.ts";

const FILE_TOOLS = new Set(["read", "edit", "write", "ls", "grep", "find"]);
const MAX_BUFFERED_LINE = 2000;
const MAX_COMMAND = 80;
const MAX_SUMMARY = 100;

export interface EventRendererOptions {
	/** Reserved for future diagnostics; never surfaces model thinking. */
	verbose?: boolean;
	/** Start in block-streaming mode (buffer whole assistant messages). */
	blockOutput?: boolean;
}

interface FileEntry {
	tool: string;
	label: string;
}

class AccessibleEventRenderer implements EventRenderer {
	private textBuf = "";
	private fileRun: FileEntry[] = [];
	/** toolCallId -> display label captured at tool start (args are not on the end event). */
	private readonly pendingFileLabels = new Map<string, string>();
	private readonly writer: LineWriter;
	private blockOutput: boolean;

	constructor(writer: LineWriter, blockOutput: boolean) {
		this.writer = writer;
		this.blockOutput = blockOutput;
	}

	setBlockOutput(enabled: boolean): void {
		this.blockOutput = enabled;
	}

	getBlockOutput(): boolean {
		return this.blockOutput;
	}

	handle(event: AgentSessionEvent): void {
		switch (event.type) {
			case "message_update":
				this.handleAssistantEvent(event.assistantMessageEvent);
				break;
			case "message_end":
				this.flushText();
				break;
			case "tool_execution_start":
				this.handleToolStart(event.toolCallId, event.toolName, event.args);
				break;
			case "tool_execution_end":
				this.handleToolEnd(event.toolCallId, event.toolName, event.result, event.isError);
				break;
			case "turn_end":
			case "agent_end":
				this.flushFileRun();
				this.flushText();
				break;
			case "compaction_start":
				this.flushPending();
				this.writer.line("[compacting context…]");
				break;
			case "compaction_end":
				this.handleCompactionEnd(event);
				break;
			case "auto_retry_start":
				this.flushPending();
				this.writer.line(
					`[retrying (attempt ${event.attempt}/${event.maxAttempts}) after error: ${truncateLine(
						event.errorMessage,
						MAX_SUMMARY,
					)}]`,
				);
				break;
			default:
				// turn_start, agent_start, message_start, queue_update, entry_appended,
				// session_info_changed, thinking_level_changed, auto_retry_end: no output.
				break;
		}
	}

	endTurn(): void {
		this.flushFileRun();
		this.flushText();
	}

	// --- assistant streaming -------------------------------------------------

	private handleAssistantEvent(event: AssistantMessageEvent): void {
		switch (event.type) {
			case "start":
				// A new assistant message begins; flush any leftover text from the previous one.
				this.flushText();
				break;
			case "text_delta":
				this.appendText(event.delta);
				break;
			case "text_end":
			case "done":
				this.flushText();
				break;
			case "error": {
				this.flushText();
				const message = event.error?.errorMessage ?? event.reason ?? "request failed";
				this.writer.error(`Error: ${message}`);
				break;
			}
			default:
				// thinking_* and toolcall_* are intentionally ignored.
				break;
		}
	}

	private appendText(delta: string): void {
		// Assistant text follows any pending tool group, in reading order.
		this.flushFileRun();
		this.textBuf += delta;
		// Block mode: hold the whole message; flushText emits it at once on message end.
		if (this.blockOutput) {
			return;
		}
		let newlineIndex = this.textBuf.indexOf("\n");
		while (newlineIndex !== -1) {
			this.writer.line(this.textBuf.slice(0, newlineIndex));
			this.textBuf = this.textBuf.slice(newlineIndex + 1);
			newlineIndex = this.textBuf.indexOf("\n");
		}
		// Progressively flush a newline-free stream so it does not buffer forever.
		if (this.textBuf.length >= MAX_BUFFERED_LINE) {
			this.writer.line(this.textBuf);
			this.textBuf = "";
		}
	}

	private flushText(): void {
		if (this.textBuf.length === 0) {
			return;
		}
		// Emit the buffer as one write (a whole block in block mode); drop trailing blank lines.
		const text = this.textBuf.replace(/\n+$/, "");
		this.textBuf = "";
		if (text.length > 0) {
			this.writer.line(text);
		}
	}

	// --- tools ---------------------------------------------------------------

	private handleToolStart(toolCallId: string, toolName: string, toolArgs: unknown): void {
		if (toolName === "bash") {
			this.flushFileRun();
			this.writer.line(`» bash: ${truncateLine(commandOf(toolArgs), MAX_COMMAND)}`);
			return;
		}
		if (FILE_TOOLS.has(toolName)) {
			this.pendingFileLabels.set(toolCallId, fileLabel(toolName, toolArgs));
			return;
		}
		// Non-file one-off tools render at completion; flush any pending file run first.
		this.flushFileRun();
	}

	private handleToolEnd(toolCallId: string, toolName: string, result: unknown, isError: boolean): void {
		if (toolName === "bash") {
			this.renderBashEnd(result, isError);
			return;
		}
		if (FILE_TOOLS.has(toolName)) {
			const label = this.pendingFileLabels.get(toolCallId) ?? toolName;
			this.pendingFileLabels.delete(toolCallId);
			if (isError) {
				this.flushFileRun();
				const message = lastNonEmptyLine(extractResultText(result)) || "failed";
				this.writer.line(`» ${toolName}: ${label} — failed: ${truncateLine(message, MAX_SUMMARY)}`);
			} else {
				this.fileRun.push({ tool: toolName, label });
			}
			return;
		}
		// Other one-off tool.
		if (isError) {
			const message = lastNonEmptyLine(extractResultText(result)) || "error";
			this.writer.line(`» ${toolName}: failed — ${truncateLine(message, MAX_SUMMARY)}`);
		} else {
			const summary = lastNonEmptyLine(extractResultText(result));
			this.writer.line(`» ${toolName}: ${summary ? truncateLine(summary, MAX_SUMMARY) : "ok"}`);
		}
	}

	private renderBashEnd(result: unknown, isError: boolean): void {
		const summary = lastNonEmptyLine(extractResultText(result));
		const suffix = summary ? ` — ${truncateLine(summary, MAX_SUMMARY)}` : "";
		if (isError) {
			const code = exitCodeOf(result);
			this.writer.line(`  ✗ bash failed${code !== undefined ? ` (exit ${code})` : ""}${suffix}`);
		} else {
			this.writer.line(`  ✓ bash ok${suffix}`);
		}
	}

	private flushFileRun(): void {
		if (this.fileRun.length === 0) {
			return;
		}
		const order: string[] = [];
		const byTool = new Map<string, string[]>();
		for (const entry of this.fileRun) {
			let labels = byTool.get(entry.tool);
			if (!labels) {
				labels = [];
				byTool.set(entry.tool, labels);
				order.push(entry.tool);
			}
			labels.push(entry.label);
		}
		for (const tool of order) {
			this.writer.line(`» ${tool}: ${byTool.get(tool)?.join(", ")}`);
		}
		this.fileRun = [];
	}

	private flushPending(): void {
		this.flushFileRun();
		this.flushText();
	}

	private handleCompactionEnd(event: Extract<AgentSessionEvent, { type: "compaction_end" }>): void {
		this.flushPending();
		if (event.aborted) {
			this.writer.line("[compaction aborted]");
			return;
		}
		if (event.errorMessage) {
			this.writer.error(`Error compacting context: ${truncateLine(event.errorMessage, MAX_SUMMARY)}`);
			return;
		}
		this.writer.line("[context compacted]");
	}
}

// --- helpers ---------------------------------------------------------------

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function pathOf(argsRecord: Record<string, unknown> | undefined): string {
	if (!argsRecord) return "";
	return str(argsRecord.file_path) || str(argsRecord.path) || str(argsRecord.dir);
}

function commandOf(argsValue: unknown): string {
	const argsRecord = asRecord(argsValue);
	if (!argsRecord) return "";
	return str(argsRecord.command) || str(argsRecord.script) || str(argsRecord.cmd);
}

/** Short label for a file tool, derived from its start-time args. */
function fileLabel(toolName: string, argsValue: unknown): string {
	const argsRecord = asRecord(argsValue);
	if (toolName === "grep" || toolName === "find") {
		const pattern = argsRecord ? str(argsRecord.pattern) || str(argsRecord.query) : "";
		return pattern ? `"${pattern}"` : toolName;
	}
	const path = pathOf(argsRecord);
	if (!path) {
		return toolName;
	}
	const name = basename(path) || path;
	if (toolName === "edit") {
		return `${name} (${editCount(argsRecord)})`;
	}
	return name;
}

function editCount(argsRecord: Record<string, unknown> | undefined): number {
	if (argsRecord && Array.isArray(argsRecord.edits)) {
		return argsRecord.edits.length;
	}
	return 1;
}

/** Best-effort extraction of a tool result's text (AgentToolResult content, or common shapes). */
function extractResultText(result: unknown): string {
	if (typeof result === "string") {
		return result;
	}
	const record = asRecord(result);
	if (!record) {
		return "";
	}
	if (Array.isArray(record.content)) {
		return record.content
			.filter(
				(part): part is { type: string; text: string } =>
					!!part &&
					typeof part === "object" &&
					(part as { type?: unknown }).type === "text" &&
					typeof (part as { text?: unknown }).text === "string",
			)
			.map((part) => part.text)
			.join("\n");
	}
	if (typeof record.output === "string") return record.output;
	if (typeof record.text === "string") return record.text;
	if (typeof record.stdout === "string") {
		return typeof record.stderr === "string" ? `${record.stdout}\n${record.stderr}` : record.stdout;
	}
	return "";
}

function exitCodeOf(result: unknown): number | undefined {
	const record = asRecord(result);
	const details = asRecord(record?.details);
	if (details && typeof details.exitCode === "number") {
		return details.exitCode;
	}
	if (record && typeof record.exitCode === "number") {
		return record.exitCode;
	}
	return undefined;
}

export function createEventRenderer(writer: LineWriter, options: EventRendererOptions = {}): EventRenderer {
	// `verbose` is reserved for future diagnostics; the renderer never surfaces model thinking.
	return new AccessibleEventRenderer(writer, options.blockOutput ?? false);
}
