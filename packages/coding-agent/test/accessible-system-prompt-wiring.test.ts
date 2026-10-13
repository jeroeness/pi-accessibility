/**
 * Regression: the accessible-mode system prompt (screen-reader output rules) must
 * actually reach the model. The rules are mode-dependent, but the base prompt is
 * built at construction before the run mode is known; binding the mode later must
 * rebuild it. buildSystemPrompt() unit tests pass mode directly and cannot catch a
 * wiring gap here.
 */

import { describe, expect, it } from "vitest";
import { createHarness } from "./test-harness.ts";

const RULES_MARKER = "<screen_reader_output>";

describe("accessible mode system-prompt wiring", () => {
	it("injects the screen-reader output rules when the session is bound to accessible mode", async () => {
		const harness = await createHarness();

		// Built at construction with the default (non-accessible) mode.
		expect(harness.session.systemPrompt).not.toContain(RULES_MARKER);

		await harness.session.bindExtensions({ mode: "accessible" });

		expect(harness.session.systemPrompt).toContain(RULES_MARKER);
		expect(harness.session.systemPrompt).toContain("read aloud by a screen reader");

		harness.cleanup();
	});

	it("does not inject the rules for a non-accessible mode", async () => {
		const harness = await createHarness();

		await harness.session.bindExtensions({ mode: "tui" });

		expect(harness.session.systemPrompt).not.toContain(RULES_MARKER);

		harness.cleanup();
	});
});
