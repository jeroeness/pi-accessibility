import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { accessibleRequested, resolveAppMode } from "../src/main.ts";

const ENV_KEYS = ["PI_ACCESSIBLE", "NO_TUI", "TERM"] as const;

describe("parseArgs --accessible", () => {
	it("sets accessible for --accessible / --repl / --no-tui", () => {
		expect(parseArgs(["--accessible"]).accessible).toBe(true);
		expect(parseArgs(["--repl"]).accessible).toBe(true);
		expect(parseArgs(["--no-tui"]).accessible).toBe(true);
	});

	it("leaves accessible undefined by default", () => {
		expect(parseArgs([]).accessible).toBeUndefined();
	});
});

describe("accessible environment detection", () => {
	const saved: Record<string, string | undefined> = {};
	beforeEach(() => {
		for (const key of ENV_KEYS) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
		process.env.TERM = "xterm-256color";
	});
	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = saved[key];
			}
		}
	});

	it("accessibleRequested is true for the flag and the recognized env signals", () => {
		expect(accessibleRequested(parseArgs(["--accessible"]))).toBe(true);

		process.env.PI_ACCESSIBLE = "1";
		expect(accessibleRequested(parseArgs([]))).toBe(true);
		delete process.env.PI_ACCESSIBLE;

		process.env.NO_TUI = "true";
		expect(accessibleRequested(parseArgs([]))).toBe(true);
		delete process.env.NO_TUI;

		process.env.TERM = "dumb";
		expect(accessibleRequested(parseArgs([]))).toBe(true);
	});

	it("accessibleRequested is false with no signal", () => {
		expect(accessibleRequested(parseArgs([]))).toBe(false);
	});

	describe("resolveAppMode routing", () => {
		it("explicit rpc/json modes win first", () => {
			expect(resolveAppMode(parseArgs(["--mode", "rpc"]), true, true)).toBe("rpc");
			expect(resolveAppMode(parseArgs(["--mode", "json"]), true, true)).toBe("json");
		});

		it("print wins over accessible when output is piped or --print is set", () => {
			expect(resolveAppMode(parseArgs(["--print"]), true, true)).toBe("print");
			expect(resolveAppMode(parseArgs([]), false, true)).toBe("print");
			expect(resolveAppMode(parseArgs([]), true, false)).toBe("print");
			expect(resolveAppMode(parseArgs(["--accessible"]), false, true)).toBe("print");
		});

		it("accessible when requested with a TTY", () => {
			expect(resolveAppMode(parseArgs(["--accessible"]), true, true)).toBe("accessible");
			process.env.TERM = "dumb";
			expect(resolveAppMode(parseArgs([]), true, true)).toBe("accessible");
		});

		it("interactive by default with a TTY", () => {
			expect(resolveAppMode(parseArgs([]), true, true)).toBe("interactive");
		});
	});
});
