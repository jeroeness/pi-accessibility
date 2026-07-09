import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCompleter } from "../src/modes/accessible/autocomplete.ts";
import { COMMAND_NAMES } from "../src/modes/accessible/commands.ts";

let dir: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-autocomplete-"));
	writeFileSync(join(dir, "AGENTS.md"), "");
	writeFileSync(join(dir, "server.ts"), "");
	mkdirSync(join(dir, "src"));
	mkdirSync(join(dir, "scripts"));
	writeFileSync(join(dir, "src", "main.ts"), "");
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

function makeCompleter() {
	return createCompleter({
		cwd: dir,
		getCommandNames: () => COMMAND_NAMES,
		getArgCompletions: (command) => {
			switch (command) {
				case "effort":
					return ["off", "minimal", "low", "medium", "high", "xhigh"];
				case "stream":
					return ["block", "line"];
				case "help":
					return COMMAND_NAMES;
				case "model":
					return ["anthropic/opus", "openai/gpt"];
				default:
					return null;
			}
		},
	});
}

describe("file/path completion", () => {
	it("completes a bare file token by prefix (read AG -> AGENTS.md)", async () => {
		const [completions, completeOn] = await makeCompleter()("read AG");
		expect(completeOn).toBe("AG");
		expect(completions).toEqual(["AGENTS.md"]);
	});

	it("returns all matches (readline keeps the common prefix) for read s", async () => {
		const [completions, completeOn] = await makeCompleter()("read s");
		expect(completeOn).toBe("s");
		expect(completions).toEqual(expect.arrayContaining(["server.ts", "src/", "scripts/"]));
	});

	it("completes a nested path token (read src/ma -> src/main.ts)", async () => {
		const [completions, completeOn] = await makeCompleter()("read src/ma");
		expect(completeOn).toBe("src/ma");
		expect(completions).toEqual(["src/main.ts"]);
	});

	it("lists a directory's contents once the token ends with a slash", async () => {
		const [completions, completeOn] = await makeCompleter()("read src/");
		expect(completeOn).toBe("src/");
		expect(completions).toEqual(expect.arrayContaining(["src/main.ts"]));
	});
});

describe("command name completion", () => {
	it("completes a partial command (/he -> /help)", async () => {
		const [completions, completeOn] = await makeCompleter()("/he");
		expect(completeOn).toBe("/he");
		expect(completions).toEqual(["/help"]);
	});

	it("lists every command for a bare slash", async () => {
		const [completions, completeOn] = await makeCompleter()("/");
		expect(completeOn).toBe("/");
		expect(completions).toEqual(expect.arrayContaining(["/help", "/effort", "/plan", "/build", "/model"]));
	});
});

describe("command argument completion", () => {
	it("completes an /effort level", async () => {
		const [completions, completeOn] = await makeCompleter()("/effort hi");
		expect(completeOn).toBe("hi");
		expect(completions).toEqual(["high"]);
	});

	it("completes a /stream mode", async () => {
		const [completions, completeOn] = await makeCompleter()("/stream l");
		expect(completeOn).toBe("l");
		expect(completions).toEqual(["line"]);
	});

	it("completes a /help argument with command names", async () => {
		const [completions, completeOn] = await makeCompleter()("/help mod");
		expect(completeOn).toBe("mod");
		expect(completions).toEqual(["model"]);
	});

	it("returns nothing for a command without argument completions", async () => {
		const [completions] = await makeCompleter()("/quit ab");
		expect(completions).toEqual([]);
	});
});
