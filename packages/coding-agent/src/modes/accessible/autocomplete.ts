/**
 * Tab completion for the accessible REPL.
 *
 * Produces a Node `readline` completer (see {@link https://nodejs.org/api/readline.html}).
 * readline's Tab inserts the longest common prefix of the returned completions and,
 * when there is more than one, lists them — a familiar, bash-style experience.
 *
 * Three contexts are completed, chosen by inspecting the text before the cursor:
 * - `/he`            → command names            (`/help`)
 * - `/effort hi`     → command arguments        (`high`)
 * - `read AG`        → file/path tokens         (`AGENTS.md`)
 *
 * File/path completion reuses the same prefix-based directory walk the TUI uses for
 * its `@` mentions, via {@link CombinedAutocompleteProvider} from pi-tui.
 */

import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";

type Awaitable<T> = T | Promise<T>;

/** readline completer result: `[completions, substringBeingCompleted]`. */
export type CompletionResult = [string[], string];

export interface CompleterDeps {
	/** Working directory that file/path completion is relative to. */
	cwd: string;
	/** Current slash-command names (without the leading slash). */
	getCommandNames: () => string[];
	/**
	 * Candidate values for a command's argument, or null when the command has no
	 * completable argument. Candidates are prefix-matched against the typed token.
	 */
	getArgCompletions: (command: string, argPrefix: string) => Awaitable<string[] | null>;
}

// Whitespace separates argument tokens; anything before the last run is context.
const LAST_TOKEN = /[^\s]*$/;

function lastToken(text: string): string {
	return LAST_TOKEN.exec(text)?.[0] ?? "";
}

/**
 * Build a readline-style completer. The returned function takes the line up to the
 * cursor and resolves to `[completions, completeOn]`; readline replaces `completeOn`
 * with the common prefix of `completions`.
 */
export function createCompleter(deps: CompleterDeps): (line: string) => Promise<CompletionResult> {
	// A never-aborting signal: the accessible completer runs to completion each Tab.
	const signal = new AbortController().signal;
	// fd is not needed: file completion here is prefix-based (readdir), not fuzzy.
	const fileProvider = new CombinedAutocompleteProvider([], deps.cwd, null);

	return async (line: string): Promise<CompletionResult> => {
		// Command name: a leading slash with no further slash or space yet ("/he").
		const nameMatch = /^\/([^\s/]*)$/.exec(line);
		if (nameMatch) {
			const prefix = nameMatch[1];
			const completions = deps
				.getCommandNames()
				.filter((name) => name.startsWith(prefix))
				.map((name) => `/${name}`);
			return [completions, line];
		}

		// Command argument: "/<known-command> <args>". Unknown leading "/x/y" tokens
		// fall through to file completion (e.g. an absolute path as the first word).
		const argMatch = /^\/(\S+)\s+(.*)$/.exec(line);
		if (argMatch && deps.getCommandNames().includes(argMatch[1])) {
			const command = argMatch[1];
			const token = lastToken(argMatch[2]);
			const values = await deps.getArgCompletions(command, token);
			if (values && values.length > 0) {
				return [values.filter((value) => value.startsWith(token)), token];
			}
			return [[], token];
		}

		// File / path token (default). Force extraction so a bare word (no "/" or ".")
		// still completes, matching the "read AG" → "read AGENTS.md" example.
		const suggestions = await fileProvider.getSuggestions([line], 0, line.length, { signal, force: true });
		if (!suggestions) {
			return [[], ""];
		}
		return [suggestions.items.map((item) => item.value), suggestions.prefix];
	};
}
