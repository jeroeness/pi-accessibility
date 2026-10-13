import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { accessibleRequestedByEnv, tuiRequestedByEnv } from "../src/cli/ui-mode.ts";
import { accessibleRequested, resolveAppMode, tuiRequested } from "../src/main.ts";

const ENV_KEYS = ["PI_ACCESSIBLE", "NO_TUI", "TERM", "PI_TUI", "PI_LINE_OUTPUT"] as const;

describe("parseArgs --accessible / --tui / --line-output", () => {
	it("sets accessible for --accessible / --repl / --no-tui", () => {
		expect(parseArgs(["--accessible"]).accessible).toBe(true);
		expect(parseArgs(["--repl"]).accessible).toBe(true);
		expect(parseArgs(["--no-tui"]).accessible).toBe(true);
	});

	it("sets tui for --tui and lineOutput for --line-output", () => {
		expect(parseArgs(["--tui"]).tui).toBe(true);
		expect(parseArgs(["--line-output"]).lineOutput).toBe(true);
	});

	it("leaves accessible / tui / lineOutput undefined by default", () => {
		const parsed = parseArgs([]);
		expect(parsed.accessible).toBeUndefined();
		expect(parsed.tui).toBeUndefined();
		expect(parsed.lineOutput).toBeUndefined();
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

		it("accessible by default with a TTY", () => {
			expect(resolveAppMode(parseArgs([]), true, true)).toBe("accessible");
			expect(resolveAppMode(parseArgs(["--accessible"]), true, true)).toBe("accessible");
			process.env.TERM = "dumb";
			expect(resolveAppMode(parseArgs([]), true, true)).toBe("accessible");
		});

		it("interactive (TUI) only when opted in with --tui / PI_TUI on a TTY", () => {
			expect(resolveAppMode(parseArgs(["--tui"]), true, true)).toBe("interactive");
			process.env.PI_TUI = "1";
			expect(resolveAppMode(parseArgs([]), true, true)).toBe("interactive");
		});

		it("explicit accessible signals and print beat --tui", () => {
			// TERM=dumb can never run the TUI.
			process.env.TERM = "dumb";
			expect(resolveAppMode(parseArgs(["--tui"]), true, true)).toBe("accessible");
			process.env.TERM = "xterm-256color";
			// An explicit accessible request wins over a TUI request.
			expect(resolveAppMode(parseArgs(["--tui", "--accessible"]), true, true)).toBe("accessible");
			// Piped output is still print, even with --tui.
			expect(resolveAppMode(parseArgs(["--tui"]), false, true)).toBe("print");
		});
	});

	describe("tuiRequested", () => {
		it("is true for --tui and PI_TUI", () => {
			expect(tuiRequested(parseArgs(["--tui"]))).toBe(true);
			process.env.PI_TUI = "1";
			expect(tuiRequested(parseArgs([]))).toBe(true);
		});

		it("is false by default and when accessible is explicitly signalled", () => {
			expect(tuiRequested(parseArgs([]))).toBe(false);
			expect(tuiRequested(parseArgs(["--tui", "--accessible"]))).toBe(false);
			process.env.NO_TUI = "1";
			expect(tuiRequested(parseArgs(["--tui"]))).toBe(false);
		});
	});
});

describe("environment-only UI mode (package commands)", () => {
	it("defaults to accessible and opts into the TUI only with PI_TUI", () => {
		expect(accessibleRequestedByEnv({ TERM: "xterm-256color" })).toBe(false);
		expect(tuiRequestedByEnv({ TERM: "xterm-256color" })).toBe(false);
		expect(tuiRequestedByEnv({ TERM: "xterm-256color", PI_TUI: "1" })).toBe(true);
	});

	it("lets accessible signals beat PI_TUI", () => {
		for (const env of [{ PI_ACCESSIBLE: "1" }, { NO_TUI: "true" }, { TERM: "dumb" }]) {
			expect(accessibleRequestedByEnv(env)).toBe(true);
			expect(tuiRequestedByEnv({ ...env, PI_TUI: "1" })).toBe(false);
		}
	});
});
