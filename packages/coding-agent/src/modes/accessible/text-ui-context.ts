/**
 * ExtensionUIContext for the accessible mode.
 *
 * Interactive methods (select/confirm/input/notify/editor) are backed by readline
 * text prompts. Everything that requires the TUI (widgets, footer/header, working
 * indicators, custom components, themes) is a safe no-op, mirroring rpc-mode.ts.
 */

import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.ts";
import { type Theme, theme } from "../interactive/theme/theme.ts";
import type { LineWriter, Prompter } from "./types.ts";

/**
 * Ask a question via the prompter, resolving to `undefined` if the dialog's abort
 * signal fires or its timeout elapses first. The cancellation is passed into the
 * question itself, so readline drops it: a question left pending would swallow the
 * user's next line and hang the REPL prompt that follows.
 */
async function ask(
	prompter: Prompter,
	query: string,
	opts: ExtensionUIDialogOptions | undefined,
): Promise<string | undefined> {
	if (opts?.signal?.aborted) return undefined;
	const controller = new AbortController();
	const cancel = (): void => controller.abort();
	opts?.signal?.addEventListener("abort", cancel, { once: true });
	const timer = opts?.timeout ? setTimeout(cancel, opts.timeout) : undefined;
	try {
		return await prompter.question(query, controller.signal);
	} catch {
		// Aborted, timed out, or input closed.
		return undefined;
	} finally {
		if (timer) clearTimeout(timer);
		opts?.signal?.removeEventListener("abort", cancel);
	}
}

export function createTextUIContext(prompter: Prompter, writer: LineWriter): ExtensionUIContext {
	return {
		async select(title, options, opts) {
			if (opts?.signal?.aborted) return undefined;
			writer.line(`Select: ${title}`);
			options.forEach((option, index) => {
				writer.line(`  ${index + 1}. ${option}`);
			});
			const answer = await ask(prompter, "Enter a number (Enter to cancel): ", opts);
			if (answer === undefined) return undefined;
			const trimmed = answer.trim();
			if (trimmed === "" || trimmed.toLowerCase() === "q") return undefined;
			const choice = Number.parseInt(trimmed, 10);
			if (Number.isNaN(choice) || choice < 1 || choice > options.length) return undefined;
			return options[choice - 1];
		},

		async confirm(title, message, opts) {
			if (opts?.signal?.aborted) return false;
			writer.line(`Confirm: ${title}`);
			if (message) writer.line(message);
			const answer = await ask(prompter, "[y/N]: ", opts);
			if (answer === undefined) return false;
			const trimmed = answer.trim().toLowerCase();
			return trimmed === "y" || trimmed === "yes";
		},

		async input(title, placeholder, opts) {
			if (opts?.signal?.aborted) return undefined;
			writer.line(title);
			const answer = await ask(prompter, placeholder ? `(${placeholder}) ` : "> ", opts);
			if (answer === undefined) return undefined;
			return answer.trim() === "" ? undefined : answer;
		},

		notify(message: string, type?: "info" | "warning" | "error"): void {
			const prefix = type === "error" ? "Error: " : type === "warning" ? "Warning: " : "Note: ";
			if (type === "error") {
				writer.error(`${prefix}${message}`);
			} else {
				writer.line(`${prefix}${message}`);
			}
		},

		async editor(title: string, prefill?: string): Promise<string | undefined> {
			writer.line(title);
			const answer = await ask(prompter, "> ", undefined);
			if (answer === undefined) return undefined;
			return answer.trim() === "" ? prefill : answer;
		},

		onTerminalInput(): () => void {
			// Raw terminal input is not supported in accessible mode.
			return () => {};
		},

		setStatus(_key: string, _text: string | undefined): void {
			// Status is footer chrome (token/TPS counters, git branch, …). It updates constantly
			// and is pure clutter for a screen reader, so it is dropped in accessible mode.
		},

		setTitle(_title: string): void {
			// Terminal title control is not surfaced in accessible mode.
		},

		// --- TUI-only methods: safe no-ops --------------------------------------

		setWorkingMessage(_message?: string): void {},
		setWorkingVisible(_visible: boolean): void {},
		setWorkingIndicator(_options?: WorkingIndicatorOptions): void {},
		setHiddenThinkingLabel(_label?: string): void {},
		setWidget(_key: string, _content?: unknown, _options?: ExtensionWidgetOptions): void {},
		setFooter(_factory: unknown): void {},
		setHeader(_factory: unknown): void {},
		async custom() {
			return undefined as never;
		},
		pasteToEditor(text: string): void {
			this.setEditorText(text);
		},
		setEditorText(_text: string): void {},
		getEditorText(): string {
			return "";
		},
		addAutocompleteProvider(): void {},
		setEditorComponent(): void {},
		getEditorComponent() {
			return undefined;
		},
		get theme() {
			return theme;
		},
		getAllThemes() {
			return [];
		},
		getTheme(_name: string) {
			return undefined;
		},
		setTheme(_theme: string | Theme) {
			return { success: false, error: "Theme switching not supported in accessible mode" };
		},
		getToolsExpanded() {
			return false;
		},
		setToolsExpanded(_expanded: boolean) {},
	};
}
