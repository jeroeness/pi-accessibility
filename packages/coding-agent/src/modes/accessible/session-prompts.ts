/**
 * Text prompts for session setup in accessible mode: project trust and a missing
 * session working directory. The TUI shows these as selector dialogs; accessible
 * mode asks them as plain numbered / yes-no questions through readline.
 */

import type { ExtensionUIContext, ProjectTrustContext } from "../../core/extensions/types.ts";
import type { SessionCwdIssue } from "../../core/session-cwd.ts";
import { createLineWriter } from "./line-writer.ts";
import { createNodeReadlinePrompter } from "./prompter.ts";
import { createTextUIContext } from "./text-ui-context.ts";

type TextPromptUI = Pick<ExtensionUIContext, "select" | "confirm" | "input" | "notify">;

/** Project trust context whose prompts are asked as text questions. */
export function createTextProjectTrustContext(cwd: string, ui: TextPromptUI): ProjectTrustContext {
	return {
		cwd,
		mode: "accessible",
		hasUI: true,
		ui: {
			select: (title, options, opts) => ui.select(title, options, opts),
			confirm: (title, message, opts) => ui.confirm(title, message, opts),
			input: (title, placeholder, opts) => ui.input(title, placeholder, opts),
			notify: (message, type) => ui.notify(message, type),
		},
	};
}

/** Ask whether to continue a session whose stored working directory no longer exists. */
export function confirmMissingSessionCwd(
	ui: Pick<ExtensionUIContext, "confirm">,
	issue: SessionCwdIssue,
): Promise<boolean> {
	return ui.confirm(
		"Session working directory not found.",
		`The session's working directory no longer exists: ${issue.sessionCwd}\nContinue in the current directory instead: ${issue.fallbackCwd}`,
	);
}

/**
 * Run `fn` with a short-lived readline text UI on stdin/stdout, for questions asked
 * before the accessible REPL starts. Ctrl+C or end of input cancels the question.
 */
export async function withStartupTextUI<T>(fn: (ui: ExtensionUIContext) => Promise<T>): Promise<T> {
	const prompter = createNodeReadlinePrompter();
	prompter.onSigint(() => prompter.close());
	try {
		return await fn(createTextUIContext(prompter, createLineWriter()));
	} finally {
		prompter.close();
	}
}
