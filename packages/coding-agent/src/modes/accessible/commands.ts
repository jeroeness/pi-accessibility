/**
 * Slash-command dispatch for the accessible mode (v1: core + essentials).
 *
 * Handlers reuse AgentSession / runtime methods that rpc-mode already exercises.
 * Unknown `/x` that matches a registered extension command falls through to the
 * agent as a prompt; anything else prints a hint.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { type SessionInfo, SessionManager } from "../../core/session-manager.ts";
import { runLogin, runLogout } from "./login.ts";
import { modelLabel } from "./model-label.ts";
import type { CommandContext, CommandResult } from "./types.ts";
import { handleUsage } from "./usage.ts";

const COMMAND_HELP: Record<string, string> = {
	help: "/help [command]. Show available commands, or explain a specific command.",
	login: "/login. Sign in with a subscription or API key.",
	logout: "/logout. Remove a stored credential.",
	model: "/model [pattern]. Show or switch the active model. Without a pattern, lists all available models and prompts for a selection.",
	effort:
		"/effort [level]. Show or set the thinking level (off, minimal, low, medium, high, xhigh). Without a level, lists the levels the current model supports and prompts for a selection.",
	plan: "/plan. Enter plan mode: disable edit, write, and bash (read-only tools only) and ask the model to produce a numbered plan without making changes.",
	build: "/build. Leave plan mode and restore full tool access (edit, write, bash).",
	compact: "/compact [notes]. Summarize and shrink the conversation context. Optional notes guide the summary.",
	session: "/session. Show session info and stats including model, token counts, and message totals.",
	usage: "/usage. Show the remaining GitHub Copilot premium request quota for your subscription.",
	stream:
		"/stream [block|line]. Show or set how replies stream. Block emits the whole reply at once; line streams line by line.",
	verbose:
		"/verbose [on|off]. Show or set whether the model's reasoning is printed. Off by default; without an argument, toggles it.",
	new: "/new. Start a fresh session.",
	resume:
		"/resume [number]. List up to 10 recent sessions in this project and resume one by number. With a number, resume that session directly. Blank or invalid input does not resume.",
	resumeglobal: "/resumeglobal [number]. Like /resume, but list recent sessions across all projects.",
	quit: "/quit (or Ctrl+D, or :q). Exit.",
};

/** Built-in command names (without the leading slash), used for Tab completion. */
export const COMMAND_NAMES: string[] = Object.keys(COMMAND_HELP);

/**
 * Hidden synonyms, mapped to the command they resolve to. Deliberately absent from
 * COMMAND_HELP so they stay out of the summary and Tab completion, while still being
 * dispatched and explained by /help.
 */
const COMMAND_ALIASES: Record<string, string> = {
	exit: "quit",
	token: "usage",
};

const COMMANDS_SUMMARY = `/help. /login. /logout. /model. /effort. /plan. /build. /compact. /session. /usage. /stream. /verbose. /new. /resume. /resumeglobal. /quit.`;

/**
 * Dispatch a submitted line. Returns `sendAsPrompt` for non-commands and for
 * extension commands (which the agent consumes via prompt).
 */
export async function dispatchCommand(line: string, ctx: CommandContext): Promise<CommandResult> {
	const trimmed = line.trim();
	// Vim muscle memory: ":q" exits, like /quit or Ctrl+D. Checked before the slash test
	// below because it is not a slash command.
	if (trimmed === ":q") {
		return { kind: "exit", code: 0 };
	}
	if (!trimmed.startsWith("/")) {
		return { kind: "sendAsPrompt" };
	}

	const spaceIndex = trimmed.indexOf(" ");
	const typed = (spaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex)).toLowerCase();
	const name = COMMAND_ALIASES[typed] ?? typed;
	const rest = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim();

	switch (name) {
		case "help": {
			const topic = rest.toLowerCase();
			const resolved = COMMAND_ALIASES[topic] ?? topic;
			if (rest && COMMAND_HELP[resolved]) {
				ctx.writer.line(COMMAND_HELP[resolved]);
			} else if (rest) {
				ctx.writer.line(`Unknown command: /${rest}. ${COMMANDS_SUMMARY}`);
			} else {
				ctx.writer.line(COMMANDS_SUMMARY);
			}
			return { kind: "handled" };
		}

		case "quit":
			return { kind: "exit", code: 0 };

		case "new":
			await handleNew(ctx);
			return { kind: "handled" };

		case "resume":
			await handleResume(ctx, "project", rest);
			return { kind: "handled" };

		case "resumeglobal":
			await handleResume(ctx, "global", rest);
			return { kind: "handled" };

		case "login":
			await runLogin(ctx);
			return { kind: "handled" };

		case "logout":
			await runLogout(ctx);
			return { kind: "handled" };

		case "model":
			await handleModel(ctx, rest);
			return { kind: "handled" };

		case "effort":
			await handleEffort(ctx, rest);
			return { kind: "handled" };

		case "plan":
			handlePlan(ctx);
			return { kind: "handled" };

		case "build":
			handleBuild(ctx);
			return { kind: "handled" };

		case "compact":
			await handleCompact(ctx, rest);
			return { kind: "handled" };

		case "session":
			handleSession(ctx);
			return { kind: "handled" };

		case "usage":
			// Everything after the command is ignored, so the `/token quota` spelling this
			// replaced still works.
			await handleUsage(ctx);
			return { kind: "handled" };

		case "stream":
			handleStream(ctx, rest);
			return { kind: "handled" };

		case "verbose":
			handleVerbose(ctx, rest);
			return { kind: "handled" };

		default:
			// Extension-registered commands are consumed by the agent as a prompt.
			if (ctx.session.extensionRunner.getCommand(typed)) {
				return { kind: "sendAsPrompt" };
			}
			ctx.writer.line(`Unknown command: /${typed}. Type /help.`);
			return { kind: "handled" };
	}
}

async function handleNew(ctx: CommandContext): Promise<void> {
	const result = await ctx.runtime.newSession();
	if (result.cancelled) {
		ctx.writer.line("New session cancelled.");
		return;
	}
	await ctx.rebindSession();
	// A new session is a fresh start: wipe the previous conversation from the terminal
	// (and its scrollback) so only the new session's output remains. Done after the
	// session actually switches, so a cancelled /new leaves the screen untouched.
	ctx.writer.clear();
	// The session id (a UUID) is noise for a screen reader, so it is not announced.
	ctx.writer.line("Started a new session.");
}

async function handleModel(ctx: CommandContext, pattern: string): Promise<void> {
	const models = await ctx.session.modelRuntime.getAvailable(undefined, { signal: AbortSignal.timeout(15_000) });
	const current = ctx.session.model;

	if (models.length === 0) {
		ctx.writer.line("No models are available. Use /login to sign in to a provider.");
		return;
	}

	if (pattern) {
		const lowered = pattern.toLowerCase();
		const match =
			models.find((m) => `${m.provider}/${m.id}`.toLowerCase() === lowered) ??
			models.find((m) => `${m.provider}/${m.id}`.toLowerCase().includes(lowered)) ??
			models.find((m) => m.id.toLowerCase().includes(lowered));
		if (!match) {
			ctx.writer.line(`No model matching "${pattern}". Current model: ${modelLabel(current)}.`);
			return;
		}
		await ctx.session.setModel(match, { persist: true });
		ctx.writer.line(`Model set to ${match.provider}/${match.id}.`);
		return;
	}

	// Group by provider so the list reads as "provider: model" instead of repeating the
	// provider prefix on every line. Numbering runs across the whole (grouped) list.
	const byProvider = new Map<string, Model<Api>[]>();
	const providerOrder: string[] = [];
	for (const model of models) {
		let list = byProvider.get(model.provider);
		if (!list) {
			list = [];
			byProvider.set(model.provider, list);
			providerOrder.push(model.provider);
		}
		list.push(model);
	}
	providerOrder.sort((a, b) => a.localeCompare(b));

	ctx.writer.line(`Current model: ${modelLabel(current)}.`);
	ctx.writer.line("Available models:");
	const ordered: Model<Api>[] = [];
	for (const provider of providerOrder) {
		ctx.writer.line(`${provider}:`);
		const providerModels = (byProvider.get(provider) ?? []).slice().sort((a, b) => a.id.localeCompare(b.id));
		for (const model of providerModels) {
			ordered.push(model);
			ctx.writer.line(`  ${ordered.length}. ${model.id}.`);
		}
	}

	const answer = await ctx.prompter.question("Select a model number (Enter to keep current): ");
	const choice = Number.parseInt(answer.trim(), 10);
	if (answer.trim() === "" || Number.isNaN(choice) || choice < 1 || choice > ordered.length) {
		ctx.writer.line("Keeping current model.");
		return;
	}
	const selected = ordered[choice - 1];
	await ctx.session.setModel(selected, { persist: true });
	ctx.writer.line(`Model set to ${selected.provider}/${selected.id}.`);
}

async function handleEffort(ctx: CommandContext, arg: string): Promise<void> {
	const current = ctx.session.thinkingLevel;

	if (!ctx.session.supportsThinking()) {
		ctx.writer.line(`The current model does not support thinking. Current level: ${current}.`);
		return;
	}

	const levels = ctx.session.getAvailableThinkingLevels();

	// Direct set: /effort high
	if (arg) {
		const wanted = arg.trim().toLowerCase();
		const match = levels.find((level) => level === wanted);
		if (!match) {
			ctx.writer.line(
				`No thinking level matching "${arg}". Current level: ${current}. Available levels: ${levels.join(", ")}.`,
			);
			return;
		}
		ctx.session.setThinkingLevel(match, { persist: true });
		// Report the resulting level (setThinkingLevel clamps to the model's range).
		ctx.writer.line(`Thinking level set to ${ctx.session.thinkingLevel}.`);
		return;
	}

	// Numbered picker.
	ctx.writer.line(`Current thinking level: ${current}.`);
	ctx.writer.line("Available levels:");
	levels.forEach((level, index) => {
		ctx.writer.line(`  ${index + 1}. ${level}.`);
	});

	const answer = await ctx.prompter.question("Select a level number (Enter to keep current): ");
	const choice = Number.parseInt(answer.trim(), 10);
	if (answer.trim() === "" || Number.isNaN(choice) || choice < 1 || choice > levels.length) {
		ctx.writer.line("Keeping current thinking level.");
		return;
	}
	const selected = levels[choice - 1];
	ctx.session.setThinkingLevel(selected, { persist: true });
	ctx.writer.line(`Thinking level set to ${ctx.session.thinkingLevel}.`);
}

function handlePlan(ctx: CommandContext): void {
	if (ctx.planMode.isActive()) {
		ctx.writer.line("Already in plan mode. Read-only tools only. Use /build to restore full access.");
		return;
	}
	const tools = ctx.planMode.enter(ctx.session);
	ctx.writer.line("Plan mode on. Edit, write, and bash are disabled.");
	ctx.writer.line(`Active tools: ${tools.join(", ")}.`);
	ctx.writer.line("Investigate, then reply with a numbered plan. Use /build to restore full access.");
}

function handleBuild(ctx: CommandContext): void {
	if (!ctx.planMode.isActive()) {
		ctx.writer.line("Already in build mode. Full tool access is enabled.");
		return;
	}
	ctx.planMode.exit(ctx.session);
	ctx.writer.line("Build mode on. Full tool access restored (edit, write, bash).");
}

/**
 * Show or set whether the model's reasoning is spoken. A bare `/verbose` flips the
 * current state, so the toggle needs no argument to be useful; `on`/`off` set it
 * explicitly for scripted use and for users who would rather not track the state.
 */
function handleVerbose(ctx: CommandContext, arg: string): void {
	const value = arg.trim().toLowerCase();
	let enabled: boolean;
	if (value === "on" || value === "true") {
		enabled = true;
	} else if (value === "off" || value === "false") {
		enabled = false;
	} else if (value === "") {
		enabled = !ctx.renderer.getVerbose();
	} else {
		ctx.writer.line(
			`Verbose: ${ctx.renderer.getVerbose() ? "on" : "off"}. Usage: /verbose on|off, or /verbose to toggle.`,
		);
		return;
	}
	ctx.renderer.setVerbose(enabled);
	ctx.writer.line(
		enabled ? "Verbose: on (the model's reasoning is printed)." : "Verbose: off (the model's reasoning is hidden).",
	);
}

function handleStream(ctx: CommandContext, arg: string): void {
	const mode = arg.trim().toLowerCase();
	if (mode === "block") {
		ctx.renderer.setBlockOutput(true);
		ctx.writer.line("Streaming mode: block (each reply is emitted as one block).");
	} else if (mode === "line") {
		ctx.renderer.setBlockOutput(false);
		ctx.writer.line("Streaming mode: line (replies stream line by line).");
	} else {
		const current = ctx.renderer.getBlockOutput() ? "block" : "line";
		ctx.writer.line(`Streaming mode: ${current}. Usage: /stream block|line`);
	}
}

async function handleCompact(ctx: CommandContext, instructions: string): Promise<void> {
	// The subscribed renderer prints [compacting context…] / [context compacted]
	// from the compaction_start / compaction_end events this triggers.
	try {
		await ctx.session.compact(instructions || undefined);
	} catch (error: unknown) {
		ctx.writer.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function handleSession(ctx: CommandContext): void {
	const stats = ctx.session.getSessionStats();
	const model = ctx.session.model;
	const name = ctx.session.sessionName ? ` (${ctx.session.sessionName})` : " (unnamed)";
	ctx.writer.line(`Session: ${ctx.session.sessionId}${name}`);
	ctx.writer.line(`Model: ${modelLabel(model)}   Thinking: ${ctx.session.thinkingLevel}`);
	ctx.writer.line(
		`Messages: ${stats.totalMessages} (user ${stats.userMessages}, assistant ${stats.assistantMessages}, tool calls ${stats.toolCalls})`,
	);
	ctx.writer.line(`Tokens: input ${stats.tokens.input}, output ${stats.tokens.output}, total ${stats.tokens.total}`);
	if (stats.sessionFile) {
		ctx.writer.line(`File: ${stats.sessionFile}`);
	}
}

/** Maximum number of sessions shown by /resume and /resumeglobal. */
const RESUME_LIST_LIMIT = 10;

/**
 * List recent sessions (project-scoped or global) and resume one by number.
 *
 * With a numeric argument, resume that entry directly. Without an argument, print
 * a numbered list and prompt. A blank, non-numeric, or out-of-range choice does not
 * resume (matches /model and /effort). Sessions are sorted newest-first.
 */
async function handleResume(ctx: CommandContext, scope: "project" | "global", arg: string): Promise<void> {
	const sessionManager = ctx.session.sessionManager;
	let sessions: SessionInfo[];
	try {
		if (scope === "global") {
			sessions = sessionManager.usesDefaultSessionDir()
				? await SessionManager.listAll()
				: await SessionManager.listAll(sessionManager.getSessionDir());
		} else {
			sessions = await SessionManager.list(sessionManager.getCwd(), sessionManager.getSessionDir());
		}
	} catch (error: unknown) {
		ctx.writer.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}

	if (sessions.length === 0) {
		ctx.writer.line(scope === "global" ? "No sessions found." : "No sessions found in this project.");
		return;
	}

	const top = sessions.slice(0, RESUME_LIST_LIMIT);

	// Direct resume by number, e.g. /resume 3. The number indexes the same newest-first
	// list that would be printed, so it stays consistent with the interactive picker.
	if (arg) {
		const choice = Number.parseInt(arg.trim(), 10);
		if (Number.isNaN(choice) || choice < 1 || choice > top.length) {
			ctx.writer.line("No matching session. Not resuming.");
			return;
		}
		const selected = top[choice - 1];
		await ctx.resumeSession(selected.path, sessionPreview(selected));
		return;
	}

	ctx.writer.line(scope === "global" ? "Recent sessions across all projects:" : "Recent sessions in this project:");
	top.forEach((session, index) => {
		ctx.writer.line(`  ${index + 1}. ${sessionResumeLabel(session)}.`);
	});

	const answer = await ctx.prompter.question("Select a session number (Enter to cancel): ");
	const choice = Number.parseInt(answer.trim(), 10);
	if (answer.trim() === "" || Number.isNaN(choice) || choice < 1 || choice > top.length) {
		ctx.writer.line("Not resuming.");
		return;
	}
	const selected = top[choice - 1];
	await ctx.resumeSession(selected.path, sessionPreview(selected));
}

/** One-line label for a session: a short preview plus how long ago it was last active. */
function sessionResumeLabel(session: SessionInfo): string {
	const preview = sessionPreview(session);
	// Avoid a double period when the preview was truncated (ends with "...") or already
	// ends with a sentence-ending period.
	const separator = preview.endsWith(".") ? "" : ".";
	return `${preview}${separator} (${formatRelativeTime(session.modified)})`;
}

/** Collapse a session name or first message into a single, length-capped line. */
function sessionPreview(session: SessionInfo): string {
	const raw = session.name?.trim() || session.firstMessage.trim() || "(no messages)";
	const collapsed = raw.replace(/\s+/g, " ").trim();
	return collapsed.length > 72 ? `${collapsed.slice(0, 71)}...` : collapsed;
}

/** Screen-reader-friendly relative time ("3 minutes ago") for the resume list. */
function formatRelativeTime(date: Date): string {
	const diffMs = Date.now() - date.getTime();
	const minutes = Math.floor(diffMs / 60000);
	const hours = Math.floor(diffMs / 3600000);
	const days = Math.floor(diffMs / 86400000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
	if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
	if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
	const months = Math.floor(days / 30);
	if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
	const years = Math.floor(days / 365);
	return `${years} year${years === 1 ? "" : "s"} ago`;
}
