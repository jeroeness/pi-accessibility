/**
 * End-of-turn summary line for the accessible REPL.
 *
 * A turn — one user message and everything the model does in response — can span
 * many provider requests. The collector folds in the usage of every assistant
 * message in the turn so the reported cache-hit rate covers the whole turn rather
 * than only its last request (which is what the graphical footer shows).
 *
 * The line is printed once, after the turn resolves, so it stays compatible with
 * the append-only rule: unlike the graphical footer's live counters, a screen
 * reader reads it exactly once and it is never repainted.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "../../core/agent-session.ts";
import type { ContextUsage } from "../../core/extensions/types.ts";

/** Prompt-token totals across every assistant message in one turn. */
export interface TurnUsage {
	/** Prompt tokens the provider served from its cache. */
	cacheRead: number;
	/** Prompt tokens the provider stored into its cache. */
	cacheWrite: number;
	/** All prompt tokens sent: fresh input plus cache reads and cache writes. */
	promptTokens: number;
}

/** Accumulates one turn's token usage from the session event stream. */
export interface TurnUsageCollector {
	/** Drop the previous turn's totals. Call before submitting a prompt. */
	reset(): void;
	/** Fold one session event into the running totals. */
	handle(event: AgentSessionEvent): void;
	/** Totals for the turn so far. */
	total(): TurnUsage;
}

export function createTurnUsageCollector(): TurnUsageCollector {
	let cacheRead = 0;
	let cacheWrite = 0;
	let promptTokens = 0;
	return {
		reset(): void {
			cacheRead = 0;
			cacheWrite = 0;
			promptTokens = 0;
		},
		handle(event: AgentSessionEvent): void {
			if (event.type !== "message_end" || event.message.role !== "assistant") return;
			const { usage } = event.message as AssistantMessage;
			cacheRead += usage.cacheRead;
			cacheWrite += usage.cacheWrite;
			// Providers normalize `input` to exclude cached tokens, so these three sum to
			// exactly what was sent as the prompt.
			promptTokens += usage.input + usage.cacheRead + usage.cacheWrite;
		},
		total: () => ({ cacheRead, cacheWrite, promptTokens }),
	};
}

/** Round a percentage to a whole number for speech. */
function percent(value: number): number {
	return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * Abbreviate a token count for speech in whole units: "512", "10k", "1M". Deliberately
 * coarser than the graphical footer's `formatTokens`, which keeps a decimal in the small
 * tiers ("10.5k") — a fraction spoken aloud costs more than the precision it buys.
 */
function tokenCount(value: number): string {
	if (value < 1000) return value.toString();
	if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
	return `${Math.round(value / 1_000_000)}M`;
}

/** Spoken duration in whole units: "12 seconds", or "3 minutes 5 seconds" past a minute. */
function duration(ms: number): string {
	// Round to whole seconds up front so the minute remainder can never come out as 60.
	const totalSeconds = Math.round(ms / 1000);
	if (totalSeconds < 60) {
		return `${totalSeconds} second${totalSeconds === 1 ? "" : "s"}`;
	}
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	const minuteText = `${minutes} minute${minutes === 1 ? "" : "s"}`;
	return seconds === 0 ? minuteText : `${minuteText} ${seconds} second${seconds === 1 ? "" : "s"}`;
}

/**
 * One spoken line describing a finished turn: wall-clock time, how full the context
 * window is, and how much of the turn's prompt was served from cache.
 *
 * Facts the session cannot supply are omitted rather than reported as zero: there is
 * no context clause without a model (or a model whose window is unknown), and no
 * cache clause when the turn produced no provider request at all (an empty prompt, an
 * immediate abort, or an error before the first response).
 */
export function formatTurnSummary(
	durationMs: number,
	contextUsage: ContextUsage | undefined,
	usage: TurnUsage,
): string {
	const parts = [`Turn: ${duration(durationMs)}.`];
	if (contextUsage) {
		const window = tokenCount(contextUsage.contextWindow);
		// `tokens: null` means a compaction has landed but no response has sized the
		// new context yet; say so instead of implying the window is empty.
		parts.push(
			contextUsage.tokens === null
				? `Context: unknown of ${window} tokens.`
				: `Context: ${tokenCount(contextUsage.tokens)} of ${window} tokens (${percent(contextUsage.percent ?? 0)} percent).`,
		);
	}
	// Only speak a cache figure when the provider actually reported cache activity.
	// Several providers never report cache tokens at all; for those, a permanent
	// "Cache hits: 0 percent" is noise that reads as a broken counter. The graphical
	// footer hides its `CH%` on the same condition.
	if (usage.promptTokens > 0 && (usage.cacheRead > 0 || usage.cacheWrite > 0)) {
		parts.push(`Cache hits: ${percent((usage.cacheRead / usage.promptTokens) * 100)} percent.`);
	}
	return parts.join(" ");
}
