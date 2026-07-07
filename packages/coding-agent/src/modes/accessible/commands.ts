/**
 * Slash-command dispatch for the accessible mode (v1: core + essentials).
 *
 * Handlers reuse AgentSession / runtime methods that rpc-mode already exercises.
 * Unknown `/x` that matches a registered extension command falls through to the
 * agent as a prompt; anything else prints a hint.
 */

import type { Model } from "@earendil-works/pi-ai";
import { runLogin, runLogout } from "./login.ts";
import { modelLabel } from "./model-label.ts";
import type { CommandContext, CommandResult } from "./types.ts";

const HELP_LINES = [
	"Commands:",
	"  /help              Show this help",
	"  /login             Sign in (subscription or API key)",
	"  /logout            Remove a stored credential",
	"  /model [pattern]   Show or switch the active model",
	"  /compact [notes]   Summarize and shrink the conversation context",
	"  /session           Show session info and stats",
	"  /stream [block|line] Show or set how replies stream (block = whole message at once)",
	"  /new               Start a fresh session",
	"  /quit  (or Ctrl+D) Exit",
	"Type anything else to send it to the agent. Ctrl+C interrupts a running turn.",
];

/**
 * Dispatch a submitted line. Returns `sendAsPrompt` for non-commands and for
 * extension commands (which the agent consumes via prompt).
 */
export async function dispatchCommand(line: string, ctx: CommandContext): Promise<CommandResult> {
	const trimmed = line.trim();
	if (!trimmed.startsWith("/")) {
		return { kind: "sendAsPrompt" };
	}

	const spaceIndex = trimmed.indexOf(" ");
	const name = (spaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex)).toLowerCase();
	const rest = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim();

	switch (name) {
		case "help":
			for (const helpLine of HELP_LINES) {
				ctx.writer.line(helpLine);
			}
			return { kind: "handled" };

		case "quit":
		case "exit":
			return { kind: "exit", code: 0 };

		case "new":
			await handleNew(ctx);
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

		case "compact":
			await handleCompact(ctx, rest);
			return { kind: "handled" };

		case "session":
			handleSession(ctx);
			return { kind: "handled" };

		case "stream":
			handleStream(ctx, rest);
			return { kind: "handled" };

		default:
			// Extension-registered commands are consumed by the agent as a prompt.
			if (ctx.session.extensionRunner.getCommand(name)) {
				return { kind: "sendAsPrompt" };
			}
			ctx.writer.line(`Unknown command: /${name}. Type /help.`);
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
	// The session was replaced; read the id from the runtime, not the stale ctx.session.
	ctx.writer.line(`Started a new session (${ctx.runtime.session.sessionId}).`);
}

async function handleModel(ctx: CommandContext, pattern: string): Promise<void> {
	const models = await ctx.session.modelRegistry.getAvailable();
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
		await ctx.session.setModel(match);
		ctx.writer.line(`Model set to ${match.provider}/${match.id}.`);
		return;
	}

	// Group by provider so the list reads as "provider: model" instead of repeating the
	// provider prefix on every line. Numbering runs across the whole (grouped) list.
	const byProvider = new Map<string, Model<any>[]>();
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

	ctx.writer.line(`Current model: ${modelLabel(current)}`);
	ctx.writer.line("Available models:");
	const ordered: Model<any>[] = [];
	for (const provider of providerOrder) {
		ctx.writer.line(`${provider}:`);
		const providerModels = (byProvider.get(provider) ?? []).slice().sort((a, b) => a.id.localeCompare(b.id));
		for (const model of providerModels) {
			ordered.push(model);
			ctx.writer.line(`  ${ordered.length}. ${model.id}`);
		}
	}

	const answer = await ctx.prompter.question("Select a model number (Enter to keep current): ");
	const choice = Number.parseInt(answer.trim(), 10);
	if (answer.trim() === "" || Number.isNaN(choice) || choice < 1 || choice > ordered.length) {
		ctx.writer.line("Keeping current model.");
		return;
	}
	const selected = ordered[choice - 1];
	await ctx.session.setModel(selected);
	ctx.writer.line(`Model set to ${selected.provider}/${selected.id}.`);
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
