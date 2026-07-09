import { describe, expect, it } from "vitest";
import { createLineWriter, lastNonEmptyLine, stripAnsi, truncateLine } from "../src/modes/accessible/line-writer.ts";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

describe("stripAnsi", () => {
	it("removes SGR color codes", () => {
		expect(stripAnsi(`${ESC}[31mred${ESC}[0m`)).toBe("red");
		expect(stripAnsi(`${ESC}[1;32mbold green${ESC}[0m`)).toBe("bold green");
	});

	it("removes cursor movement / erase sequences", () => {
		expect(stripAnsi(`a${ESC}[2Kb${ESC}[1;1Hc`)).toBe("abc");
	});

	it("removes OSC hyperlinks", () => {
		expect(stripAnsi(`${ESC}]8;;https://pi.dev${BEL}link${ESC}]8;;${BEL}`)).toBe("link");
	});

	it("leaves plain text untouched", () => {
		expect(stripAnsi("» read: args.ts")).toBe("» read: args.ts");
	});
});

describe("createLineWriter", () => {
	it("appends a newline, strips ANSI, and never emits an escape byte", () => {
		const chunks: string[] = [];
		const stream = { write: (s: string) => chunks.push(s) } as unknown as NodeJS.WritableStream;
		const writer = createLineWriter({ out: stream, err: stream });

		writer.line(`${ESC}[32mok${ESC}[0m`);
		writer.blank();

		const output = chunks.join("");
		expect(output).toBe("ok\n\n");
		expect(output).not.toContain(ESC);
	});

	it("writes errors to the error stream", () => {
		const out: string[] = [];
		const err: string[] = [];
		const writer = createLineWriter({
			out: { write: (s: string) => out.push(s) } as unknown as NodeJS.WritableStream,
			err: { write: (s: string) => err.push(s) } as unknown as NodeJS.WritableStream,
		});
		writer.error("boom");
		expect(out.join("")).toBe("");
		expect(err.join("")).toBe("boom\n");
	});

	it("clear() emits the screen+scrollback reset sequence on a TTY", () => {
		const chunks: string[] = [];
		const stream = { write: (s: string) => chunks.push(s), isTTY: true } as unknown as NodeJS.WritableStream;
		const writer = createLineWriter({ out: stream, err: stream });
		writer.clear();
		// Erase screen (2J), erase scrollback (3J), home cursor (H).
		expect(chunks.join("")).toBe(`${ESC}[2J${ESC}[3J${ESC}[H`);
	});

	it("clear() is a no-op when output is not a TTY", () => {
		const chunks: string[] = [];
		const stream = { write: (s: string) => chunks.push(s) } as unknown as NodeJS.WritableStream;
		const writer = createLineWriter({ out: stream, err: stream });
		writer.clear();
		expect(chunks.join("")).toBe("");
	});
});

describe("truncateLine", () => {
	it("keeps short lines as-is", () => {
		expect(truncateLine("hello", 80)).toBe("hello");
	});

	it("collapses whitespace and truncates with an ellipsis", () => {
		const long = "x".repeat(100);
		const result = truncateLine(long, 10);
		expect(result.length).toBe(10);
		expect(result.endsWith("…")).toBe(true);
	});

	it("flattens embedded newlines to a single line", () => {
		expect(truncateLine("a\nb\nc", 80)).toBe("a b c");
	});
});

describe("lastNonEmptyLine", () => {
	it("returns the last non-empty line, ANSI-stripped", () => {
		expect(lastNonEmptyLine(`first\n${ESC}[32m12 passed (12)${ESC}[0m\n\n`)).toBe("12 passed (12)");
	});

	it("returns empty string for blank input", () => {
		expect(lastNonEmptyLine("\n \n")).toBe("");
	});
});
