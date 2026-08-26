import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { createTurnUsageCollector, formatTurnSummary } from "../src/modes/accessible/turn-summary.ts";

function usage(input: number, cacheRead: number, cacheWrite: number): Usage {
	return {
		input,
		output: 10,
		cacheRead,
		cacheWrite,
		totalTokens: input + cacheRead + cacheWrite + 10,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistantEnd(input: number, cacheRead: number, cacheWrite: number): AgentSessionEvent {
	const message = {
		role: "assistant",
		content: [],
		stopReason: "stop",
		usage: usage(input, cacheRead, cacheWrite),
	} as unknown as AssistantMessage;
	return { type: "message_end", message };
}

describe("createTurnUsageCollector", () => {
	it("sums prompt tokens across every assistant message in the turn", () => {
		const collector = createTurnUsageCollector();
		collector.handle(assistantEnd(100, 900, 0));
		collector.handle(assistantEnd(50, 1950, 0));

		expect(collector.total()).toEqual({ cacheRead: 2850, cacheWrite: 0, promptTokens: 3000 });
	});

	it("counts cache writes as prompt tokens but not as hits", () => {
		const collector = createTurnUsageCollector();
		collector.handle(assistantEnd(100, 0, 300));

		expect(collector.total()).toEqual({ cacheRead: 0, cacheWrite: 300, promptTokens: 400 });
	});

	it("ignores non-assistant messages and other events", () => {
		const collector = createTurnUsageCollector();
		collector.handle({ type: "message_end", message: { role: "user", content: "hi" } } as AgentSessionEvent);
		collector.handle({ type: "turn_start" } as AgentSessionEvent);

		expect(collector.total()).toEqual({ cacheRead: 0, cacheWrite: 0, promptTokens: 0 });
	});

	it("reset() drops the previous turn's totals", () => {
		const collector = createTurnUsageCollector();
		collector.handle(assistantEnd(100, 900, 0));
		collector.reset();

		expect(collector.total()).toEqual({ cacheRead: 0, cacheWrite: 0, promptTokens: 0 });
	});
});

describe("formatTurnSummary", () => {
	it("reports duration, context fill, and cache hits in one spoken line", () => {
		const line = formatTurnSummary(
			12_400,
			{ tokens: 34_214, contextWindow: 200_000, percent: 17.107 },
			{ cacheRead: 2850, cacheWrite: 150, promptTokens: 3000 },
		);

		expect(line).toBe("Turn: 12 seconds. Context: 34k of 200k tokens (17 percent). Cache hits: 95 percent.");
	});

	it("rounds the duration to whole seconds", () => {
		expect(formatTurnSummary(12_600, undefined, { cacheRead: 0, cacheWrite: 0, promptTokens: 0 })).toBe(
			"Turn: 13 seconds.",
		);
		expect(formatTurnSummary(1400, undefined, { cacheRead: 0, cacheWrite: 0, promptTokens: 0 })).toBe(
			"Turn: 1 second.",
		);
		expect(formatTurnSummary(200, undefined, { cacheRead: 0, cacheWrite: 0, promptTokens: 0 })).toBe(
			"Turn: 0 seconds.",
		);
	});

	it("speaks whole minutes and seconds for turns over a minute", () => {
		const line = formatTurnSummary(185_400, undefined, { cacheRead: 0, cacheWrite: 0, promptTokens: 0 });

		expect(line).toBe("Turn: 3 minutes 5 seconds.");
	});

	it("uses the singular and drops a zero seconds remainder", () => {
		expect(formatTurnSummary(60_000, undefined, { cacheRead: 0, cacheWrite: 0, promptTokens: 0 })).toBe(
			"Turn: 1 minute.",
		);
		// 59.7s rounds up to a full minute rather than speaking "60 seconds".
		expect(formatTurnSummary(59_700, undefined, { cacheRead: 0, cacheWrite: 0, promptTokens: 0 })).toBe(
			"Turn: 1 minute.",
		);
	});

	it("abbreviates token counts in whole units, never a fraction", () => {
		const window = (tokens: number, contextWindow: number) =>
			formatTurnSummary(
				1000,
				{ tokens, contextWindow, percent: 0 },
				{ cacheRead: 0, cacheWrite: 0, promptTokens: 0 },
			);

		expect(window(512, 128_000)).toContain("Context: 512 of 128k tokens");
		expect(window(3400, 128_000)).toContain("Context: 3k of 128k tokens");
		expect(window(10_500, 128_000)).toContain("Context: 11k of 128k tokens");
		expect(window(340_000, 1_000_000)).toContain("Context: 340k of 1M tokens");
	});

	it("omits the context clause when the session cannot supply usage", () => {
		const line = formatTurnSummary(1200, undefined, { cacheRead: 500, cacheWrite: 0, promptTokens: 1000 });

		expect(line).toBe("Turn: 1 second. Cache hits: 50 percent.");
	});

	it("says the context size is unknown after a compaction instead of implying zero", () => {
		const line = formatTurnSummary(
			1000,
			{ tokens: null, contextWindow: 200_000, percent: null },
			{ cacheRead: 0, cacheWrite: 0, promptTokens: 0 },
		);

		expect(line).toBe("Turn: 1 second. Context: unknown of 200k tokens.");
	});

	it("omits cache hits when the turn made no provider request", () => {
		const line = formatTurnSummary(
			800,
			{ tokens: 9500, contextWindow: 128_000, percent: 7.4 },
			{ cacheRead: 0, cacheWrite: 0, promptTokens: 0 },
		);

		expect(line).toBe("Turn: 1 second. Context: 10k of 128k tokens (7 percent).");
	});

	it("omits cache hits entirely when the provider reports no cache activity", () => {
		// Providers that never report cache tokens would otherwise pin the line to a
		// permanent "Cache hits: 0 percent", which reads as a broken counter.
		const line = formatTurnSummary(
			800,
			{ tokens: 9500, contextWindow: 128_000, percent: 7.4 },
			{ cacheRead: 0, cacheWrite: 0, promptTokens: 12_000 },
		);

		expect(line).toBe("Turn: 1 second. Context: 10k of 128k tokens (7 percent).");
	});

	it("reports a genuine zero when the turn only wrote the cache", () => {
		// First request of a session: the whole prompt is a cache write, nothing was hit.
		const line = formatTurnSummary(2000, undefined, { cacheRead: 0, cacheWrite: 12_000, promptTokens: 12_000 });

		expect(line).toBe("Turn: 2 seconds. Cache hits: 0 percent.");
	});
});
