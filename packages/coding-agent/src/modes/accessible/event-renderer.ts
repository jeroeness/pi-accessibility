/**
 * Turns the session event stream into plain, append-only text for screen readers.
 *
 * Design (see PLAN-ACCESSIBILITY.md §2):
 * - Assistant text is line-buffered: deltas accumulate and flush on newline / size cap.
 * - Model reasoning is dropped entirely (no tokens, no marker) unless the user turns it
 *   on with `/verbose`, in which case each reasoning block is announced with a
 *   `Thinking.` line and then streamed like assistant text.
 * - Consecutive file tools (read/edit/write/ls/grep/find) are grouped by type and
 *   accumulate across agent steps until the run is broken by assistant text, a
 *   different tool category, or the turn ending. Repeated targets collapse to one
 *   entry with a count: `» read: a.ts (2), b.ts` then `» edit: c.ts`.
 * - Reading a `SKILL.md` file loads a skill, so it is announced on its own as
 *   `Loaded <skill name>.` (name taken from the file's frontmatter) instead of the
 *   uninformative `» read: SKILL.md` — every skill's entry file has that same basename.
 * - bash is grouped by (command word + status), also across steps: a run renders
 *   one line per distinct word, e.g. `bash grep ok`, `bash grep (5) ok`, or
 *   `bash npm failed`. The word is the first *informative* one, skipping navigation
 *   and wrapper prefixes (`cd pkg && grep …` reads as `grep`, not `cd`). The command
 *   arguments and the full output are never printed. powershell calls are summarised
 *   the same way (`powershell Get-ChildItem ok`).
 * - Calls a tool makes through `ctx.executeTool()` (e.g. from a codemode script) carry
 *   `parentToolCallId`; they are not announced, since the parent tool's own line covers them.
 */

import { basename, dirname } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "../../core/agent-session.ts";
import { lastNonEmptyLine, truncateLine } from "./line-writer.ts";
import type { EventRenderer, LineWriter } from "./types.ts";

const FILE_TOOLS = new Set(["read", "edit", "write", "ls", "grep", "find"]);
/** Shell tools summarised by command word and status. */
const SHELL_TOOLS = new Set(["bash", "powershell"]);
const MAX_BUFFERED_LINE = 2000;
const MAX_SUMMARY = 100;

export interface EventRendererOptions {
	/** Start with model reasoning printed (default false; toggled at runtime by /verbose). */
	verbose?: boolean;
	/** Start in block-streaming mode (buffer whole assistant messages). */
	blockOutput?: boolean;
	/**
	 * Sink for reasoning lines; defaults to the main writer. Accessible mode passes the
	 * unrecorded writer so a verbose turn is spoken but not stored in the resume
	 * transcript: reasoning is bulk rather than conversation, and a replay must not read
	 * back thinking from a turn whose verbose setting no longer applies.
	 */
	thinkingWriter?: LineWriter;
}

interface FileEntry {
	tool: string;
	label: string;
}

interface BashEntry {
	/** Shell tool name (`bash` or `powershell`). */
	shell: string;
	firstWord: string;
	ok: boolean;
}

class AccessibleEventRenderer implements EventRenderer {
	private textBuf = "";
	/** Buffered reasoning deltas; only ever non-empty while verbose is on. */
	private thinkBuf = "";
	/** Whether the current reasoning block has already been announced. */
	private thinkingOpen = false;
	private fileRun: FileEntry[] = [];
	private bashRun: BashEntry[] = [];
	/** toolCallId -> display label captured at tool start (args are not on the end event). */
	private readonly pendingFileLabels = new Map<string, string>();
	/** toolCallId -> first word of command captured at bash start. */
	private readonly pendingBashLabels = new Map<string, string>();
	/** toolCallId -> SKILL.md path captured at read start, so completion can announce the skill by name. */
	private readonly pendingSkillReads = new Map<string, string>();
	private readonly writer: LineWriter;
	/** Sink for reasoning only; the main writer unless the caller separated them. */
	private readonly thinkingWriter: LineWriter;
	private blockOutput: boolean;
	private verbose: boolean;
	/** Error of a failed request, printed once the run ends (see {@link noteRequestError}). */
	private pendingError: string | undefined;

	constructor(writer: LineWriter, thinkingWriter: LineWriter, blockOutput: boolean, verbose: boolean) {
		this.writer = writer;
		this.thinkingWriter = thinkingWriter;
		this.blockOutput = blockOutput;
		this.verbose = verbose;
	}

	setBlockOutput(enabled: boolean): void {
		this.blockOutput = enabled;
	}

	getBlockOutput(): boolean {
		return this.blockOutput;
	}

	setVerbose(enabled: boolean): void {
		// Turning verbose off mid-reasoning drops the partial block rather than emitting
		// half a thought after the user asked for silence.
		if (!enabled) {
			this.thinkBuf = "";
			this.thinkingOpen = false;
		}
		this.verbose = enabled;
	}

	getVerbose(): boolean {
		return this.verbose;
	}

	handle(event: AgentSessionEvent): void {
		switch (event.type) {
			case "message_update":
				this.handleAssistantEvent(event.assistantMessageEvent);
				break;
			case "message_end":
				this.flushThinking();
				this.flushText();
				this.noteRequestError(event.message);
				break;
			case "tool_execution_start":
				// Nested calls (made by another tool) are covered by the parent tool's line.
				if (event.parentToolCallId === undefined) {
					this.handleToolStart(event.toolCallId, event.toolName, event.args);
				}
				break;
			case "tool_execution_end":
				if (event.parentToolCallId === undefined) {
					this.handleToolEnd(event.toolCallId, event.toolName, event.result, event.isError);
				}
				break;
			case "agent_end":
				// A retryable failure is announced by the `[retrying …]` line that follows;
				// only a failure that ends the run is reported here.
				if (event.willRetry) {
					this.pendingError = undefined;
				}
				this.flushText();
				this.flushRequestError();
				break;
			case "turn_end":
				// Tool runs are NOT flushed at per-step boundaries: they accumulate across
				// steps so repeated calls collapse into one counted line (e.g. `bash find (2)
				// ok`). They flush when broken by assistant text, a different tool category,
				// or endTurn() when the whole prompt resolves. Text is already flushed by
				// message_end; this is a harmless safety net for any trailing buffer.
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
		this.flushBashRun();
		this.flushFileRun();
		this.flushThinking();
		this.flushText();
		this.flushRequestError();
	}

	// --- assistant streaming -------------------------------------------------

	private handleAssistantEvent(event: AssistantMessageEvent): void {
		switch (event.type) {
			case "start":
				// A new assistant message begins; flush any leftover prose from the previous one.
				this.flushThinking();
				this.flushText();
				break;
			case "text_delta":
				this.appendText(event.delta);
				break;
			case "thinking_delta":
				// Reasoning is clutter for most turns, so it is dropped unless /verbose is on.
				if (this.verbose) {
					this.appendThinking(event.delta);
				}
				break;
			case "thinking_end":
				// Flushed unconditionally: the buffer is empty when verbose is off, and this
				// also closes a block that was still streaming when verbose was turned on.
				this.flushThinking();
				break;
			case "text_end":
			case "done":
			case "error":
				// The agent loop ends the message on `done`/`error` without forwarding them as
				// updates; a failed request is reported from `message_end` instead.
				this.flushThinking();
				this.flushText();
				break;
			default:
				// thinking_start / thinking_signature and toolcall_* are intentionally ignored:
				// the reasoning block announces itself on its first delta.
				break;
		}
	}

	private appendText(delta: string): void {
		// Assistant text follows any pending tool group or reasoning block, in reading order.
		this.flushBashRun();
		this.flushFileRun();
		this.flushThinking();
		this.textBuf = this.appendProse(this.writer, this.textBuf, delta);
	}

	private appendThinking(delta: string): void {
		// Reasoning comes before the text and tool activity of the same message; flush
		// whatever preceded it so reading order holds.
		this.flushBashRun();
		this.flushFileRun();
		this.flushText();
		// One marker per block, on the block's first delta rather than on `thinking_start`,
		// so providers that stream reasoning without a start event are still labeled.
		if (!this.thinkingOpen) {
			this.thinkingOpen = true;
			this.thinkingWriter.line("Thinking.");
		}
		this.thinkBuf = this.appendProse(this.thinkingWriter, this.thinkBuf, delta);
	}

	/**
	 * Add a prose delta to `buf`, emitting each completed line, and return what is left
	 * unflushed. Assistant text and reasoning are separate streams over the same rules:
	 * in block mode nothing is emitted until the stream is flushed, and a newline-free
	 * stream is cut loose at `MAX_BUFFERED_LINE` so it cannot buffer forever.
	 */
	private appendProse(writer: LineWriter, buf: string, delta: string): string {
		let pending = buf + delta;
		if (this.blockOutput) {
			return pending;
		}
		let newlineIndex = pending.indexOf("\n");
		while (newlineIndex !== -1) {
			writer.line(pending.slice(0, newlineIndex));
			pending = pending.slice(newlineIndex + 1);
			newlineIndex = pending.indexOf("\n");
		}
		if (pending.length >= MAX_BUFFERED_LINE) {
			writer.line(pending);
			pending = "";
		}
		return pending;
	}

	private flushText(): void {
		const buf = this.textBuf;
		this.textBuf = "";
		this.writeProse(this.writer, buf);
	}

	private flushThinking(): void {
		const buf = this.thinkBuf;
		this.thinkBuf = "";
		this.thinkingOpen = false;
		this.writeProse(this.thinkingWriter, buf);
	}

	/** Emit a buffered stream as one write (a whole block in block mode), sans trailing blanks. */
	private writeProse(writer: LineWriter, buf: string): void {
		if (buf.length === 0) {
			return;
		}
		const text = buf.replace(/\n+$/, "");
		if (text.length > 0) {
			writer.line(text);
		}
	}

	// --- tools ---------------------------------------------------------------

	private handleToolStart(toolCallId: string, toolName: string, toolArgs: unknown): void {
		if (SHELL_TOOLS.has(toolName)) {
			// A shell call breaks any pending file-tool group so reading order is preserved.
			this.flushFileRun();
			this.pendingBashLabels.set(toolCallId, commandWordOf(commandOf(toolArgs)));
			return;
		}
		if (FILE_TOOLS.has(toolName)) {
			// A file call breaks any pending bash group so reading order is preserved.
			this.flushBashRun();
			const path = pathOf(asRecord(toolArgs));
			// Reading a SKILL.md file loads a skill; remember its path so completion can
			// announce the skill by name instead of a generic `» read: SKILL.md` line
			// (every skill's entry file shares that same, uninformative basename).
			if (toolName === "read" && basename(path) === "SKILL.md") {
				this.pendingSkillReads.set(toolCallId, path);
			}
			this.pendingFileLabels.set(toolCallId, fileLabel(toolName, toolArgs));
			return;
		}
		// Non-file one-off tools render at completion; flush any pending runs first.
		this.flushBashRun();
		this.flushFileRun();
	}

	private handleToolEnd(toolCallId: string, toolName: string, result: unknown, isError: boolean): void {
		if (SHELL_TOOLS.has(toolName)) {
			const firstWord = this.pendingBashLabels.get(toolCallId) ?? toolName;
			this.pendingBashLabels.delete(toolCallId);
			this.bashRun.push({ shell: toolName, firstWord, ok: !isError });
			return;
		}
		if (FILE_TOOLS.has(toolName)) {
			const label = this.pendingFileLabels.get(toolCallId) ?? toolName;
			this.pendingFileLabels.delete(toolCallId);
			const skillPath = this.pendingSkillReads.get(toolCallId);
			this.pendingSkillReads.delete(toolCallId);
			if (isError) {
				this.flushBashRun();
				this.flushFileRun();
				// Minimal failure line: no `»`, no status code, no error text.
				this.writer.line(withStop(`${toolName}: ${label} failed`));
			} else if (skillPath !== undefined) {
				// A successful SKILL.md read means a skill was loaded. Announce it by its
				// declared name (from the file's frontmatter), falling back to the skill's
				// directory name, rather than the uninformative `» read: SKILL.md`.
				const name = skillNameFromContent(extractResultText(result)) || basename(dirname(skillPath)) || "skill";
				this.flushBashRun();
				this.flushFileRun();
				this.writer.line(withStop(`Loaded ${name}`));
			} else {
				this.fileRun.push({ tool: toolName, label });
			}
			return;
		}
		// Other one-off tool.
		if (isError) {
			this.writer.line(withStop(`${toolName}: failed`));
		} else {
			const summary = lastNonEmptyLine(extractResultText(result));
			this.writer.line(withStop(`» ${toolName}: ${summary ? truncateLine(summary, MAX_SUMMARY) : "ok"}`));
		}
	}

	private flushBashRun(): void {
		if (this.bashRun.length === 0) {
			return;
		}
		// Group by (shell, firstWord, ok) preserving first-seen order (Map keeps insertion order).
		const groups = new Map<string, { entry: BashEntry; count: number }>();
		for (const entry of this.bashRun) {
			const key = JSON.stringify([entry.shell, entry.firstWord, entry.ok]);
			const group = groups.get(key);
			if (group) {
				group.count++;
			} else {
				groups.set(key, { entry, count: 1 });
			}
		}
		for (const { entry, count } of groups.values()) {
			const countStr = count > 1 ? ` (${count})` : "";
			const word = entry.firstWord ? `${entry.firstWord}${countStr}` : countStr.trimStart();
			const label = word ? `${entry.shell} ${word}` : entry.shell;
			this.writer.line(withStop(`${label} ${entry.ok ? "ok" : "failed"}`));
		}
		this.bashRun = [];
	}

	private flushFileRun(): void {
		if (this.fileRun.length === 0) {
			return;
		}
		// Group by tool (first-seen order), and within each tool collapse repeated
		// targets to one entry with a `(count)` suffix — again in first-seen order.
		const toolOrder: string[] = [];
		const byTool = new Map<string, { order: string[]; counts: Map<string, number> }>();
		for (const entry of this.fileRun) {
			let group = byTool.get(entry.tool);
			if (!group) {
				group = { order: [], counts: new Map() };
				byTool.set(entry.tool, group);
				toolOrder.push(entry.tool);
			}
			if (!group.counts.has(entry.label)) {
				group.order.push(entry.label);
			}
			group.counts.set(entry.label, (group.counts.get(entry.label) ?? 0) + 1);
		}
		for (const tool of toolOrder) {
			const group = byTool.get(tool)!;
			const parts = group.order.map((label) => {
				const count = group.counts.get(label)!;
				return count > 1 ? `${label} (${count})` : label;
			});
			this.writer.line(withStop(`» ${tool}: ${parts.join(", ")}`));
		}
		this.fileRun = [];
	}

	private flushPending(): void {
		this.flushBashRun();
		this.flushFileRun();
		this.flushThinking();
		this.flushText();
	}

	/**
	 * Remember a failed request. Provider errors (bad API key, rate limits, ...) reach
	 * the session only as an assistant message with `stopReason: "error"`; without a line
	 * for them a screen-reader user hears nothing but the turn summary. The error is
	 * printed once, at `agent_end` (or when the turn ends), so a failure that is about to
	 * be retried is not spoken twice. Aborts are announced by `[interrupted]` instead.
	 */
	private noteRequestError(message: AgentMessage): void {
		if (!("role" in message) || message.role !== "assistant" || message.stopReason !== "error") {
			return;
		}
		this.pendingError = message.errorMessage?.trim() || "request failed";
	}

	private flushRequestError(): void {
		const error = this.pendingError;
		this.pendingError = undefined;
		if (error === undefined) {
			return;
		}
		this.flushBashRun();
		this.flushFileRun();
		this.writer.error(withStop(`Error: ${error}`));
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

/**
 * Ensure a spoken line ends with sentence punctuation. Screen-reader narrators do
 * not register the newline itself, so a tool line ending on a bare word (`ok`,
 * `failed`) or a filename runs straight into the next line unless it ends with a
 * stop. Lines that already end with terminal punctuation are left untouched.
 */
function withStop(line: string): string {
	return /[.!?:…]$/.test(line) ? line : `${line}.`;
}

/** Env-var assignment prefix, e.g. the `NODE_ENV=` in `NODE_ENV=test npm run …`. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Commands that merely wrap another command; the wrapped command is the informative one. */
const WRAPPER_WORDS = new Set(["sudo", "env", "command", "nice", "time", "nohup", "exec", "xargs"]);
/** Pure navigation/assignment segments skipped in favor of the command that follows them. */
const NAVIGATION_WORDS = new Set([
	"cd",
	"pushd",
	"popd",
	"export",
	"set",
	"unset",
	"source",
	".",
	// PowerShell navigation cmdlets.
	"Set-Location",
	"Push-Location",
	"Pop-Location",
]);

/**
 * Pick the most informative single word to label a bash call.
 *
 * The naive "first token" is often noise: agents routinely prefix the real command
 * with `cd <dir> &&`, an env assignment (`FOO=bar cmd`), or a wrapper (`sudo`, `time`).
 * We split on shell connectors (`&&`, `||`, `;`, `|`, newlines) and return the leading
 * word of the first segment that is not pure navigation/assignment — so
 * `cd pkg && grep foo` reads as `grep`, not `cd`. If every segment is navigation
 * (e.g. a bare `cd /foo`), we fall back to that first word.
 */
function commandWordOf(command: string): string {
	const words = command
		.trim()
		.split(/\s*(?:&&|\|\||[;|]|\n)\s*/)
		.map(leadingWordOf)
		.filter((word) => word.length > 0);
	if (words.length === 0) {
		return "";
	}
	return words.find((word) => !NAVIGATION_WORDS.has(word)) ?? words[0];
}

/** Leading command word of one segment, past any env assignments and wrapper commands. */
function leadingWordOf(segment: string): string {
	const tokens = segment.trim().split(/\s+/).filter(Boolean);
	let index = 0;
	while (index < tokens.length && (ENV_ASSIGNMENT.test(tokens[index]) || WRAPPER_WORDS.has(tokens[index]))) {
		index++;
	}
	return tokens[index] ?? "";
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
	// The `(count)` suffix is added at flush time and means "times this file was
	// touched", uniformly across file tools — including edit.
	return basename(path) || path;
}

/**
 * Extract a skill's declared name from SKILL.md content. A SKILL.md file opens with a
 * YAML frontmatter block delimited by `---`; the skill name is its `name:` field.
 * Returns undefined when there is no frontmatter or no readable name, so callers can
 * fall back to the skill's directory name. A small regex keeps this display module free
 * of a YAML parser — skill names are simple slugs, never quoted or spread across lines.
 */
function skillNameFromContent(content: string): string | undefined {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if (!normalized.startsWith("---")) return undefined;
	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) return undefined;
	const match = normalized.slice(3, endIndex).match(/^name:[ \t]*(.+?)[ \t]*$/m);
	const name = match?.[1]?.replace(/^["']|["']$/g, "").trim();
	return name || undefined;
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

export function createEventRenderer(writer: LineWriter, options: EventRendererOptions = {}): EventRenderer {
	// Reasoning stays hidden unless the caller opts in (--verbose) or the user does (/verbose).
	return new AccessibleEventRenderer(
		writer,
		options.thinkingWriter ?? writer,
		options.blockOutput ?? false,
		options.verbose ?? false,
	);
}
