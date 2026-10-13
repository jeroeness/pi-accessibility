/**
 * System prompt construction and project context loading
 */

import { getSystemMessageText } from "@earendil-works/pi-ai";
import { getDocsPath, getExamplesPath, getReadmePath } from "../config.ts";
import type { ExtensionMode } from "./extensions/types.ts";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces the default prefix). */
	customPrompt?: string;
	/** Exact full prompt replacement set by a before_agent_start handler. */
	forceSystemPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write]. */
	selectedTools?: string[];
	/**
	 * Selected tools whose declarations requests leave out (`prepareLoadout` hidden declarations).
	 * They are reachable only through another tool, so the tool list and rules leave them out too.
	 */
	hiddenTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Guideline bullets contributed by each tool, keyed by tool name. */
	toolGuidelines?: Record<string, string[]>;
	/** Additional guideline bullets appended to the default system prompt rules. */
	promptGuidelines?: string[];
	/** Text appended from user configuration before project context, skills, and cwd. */
	appendSystemPrompt?: string;
	/** Additional XML-wrapped prompt sections keyed by tag name. */
	sections?: Record<string, string>;
	/** Working directory. */
	cwd: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
	/** Session UI mode. `accessible` adds the screen-reader output rules section. */
	mode?: ExtensionMode;
}

export type NormalizedBuildSystemPromptOptions = BuildSystemPromptOptions & {
	selectedTools: string[];
	hiddenTools: string[];
	toolSnippets: Record<string, string>;
	toolGuidelines: Record<string, string[]>;
	promptGuidelines: string[];
	appendSystemPrompt: string;
	sections: Record<string, string>;
	contextFiles: Array<{ path: string; content: string }>;
	skills: Skill[];
};

/**
 * Ordered system prompt sections, keyed by name. `preamble` is untagged text; every other
 * section is wrapped in a tag of the same name so the model can match later updates to it.
 * These become `SystemMessage.sections` in the transcript.
 */
export type SystemPromptSections = Record<string, string>;

const SYSTEM_PROMPT_SECTION_NAME = /^[a-z][a-z0-9_-]*$/;

/** Name of the prompt section that carries the accessible-mode output rules. */
export const SCREEN_READER_OUTPUT_SECTION = "screen_reader_output";

/**
 * Output rules added to the system prompt when running in accessible
 * (screen-reader / REPL) mode. Responses are spoken aloud, linearly, so the
 * model must avoid visual formatting and front-load information.
 *
 * Added as their own section in both the default and custom-prompt paths, and
 * appended to a prompt forced by a `before_agent_start` handler, so neither a
 * custom base prompt nor an extension can silently drop the accessibility
 * constraints. See PLAN-ACCESSIBILITY.md.
 * In particular, put NO blank lines between items of a numbered or bulleted list: list items must be on consecutive lines with no gap between them.
 */
const SCREEN_READER_OUTPUT_RULES_BODY = `Your responses are read aloud by a screen reader, one line at a time, in order. The user cannot skim, see layout, color, bold, or position. Optimize for listening.

- Be brief by default: use as few tokens as possible. Expand only when the user asks for more detail.
- Lead with the answer, then any detail. Every word is heard, so cut filler.
- Do not speak alphanumeric identifiers (session ids, commit hashes, UUIDs, tokens, ticket numbers, long file hashes) unless the user specifically asks for one. They are noise when read aloud; refer to things by name or by list number instead.
- Avoid reading out long or complex URLs (query parameters, tokens, tracking codes, deep paths); they are painful to hear character by character. Name the destination instead ("the pull request", "the pricing docs"), and give a full URL only when the user asks or must copy it.
- Use blank lines sparingly. A screen reader voices each blank line as a pause, so separate ideas with a single line break and never stack consecutive blank lines. 
- End every line with a punctuation mark (. ? ! : or ;). A screen reader relies on it to pause and drop intonation at the end of the line; a line without one slurs into the next. Use a colon for a line that introduces what follows (like "Run this:"). Exception: never append punctuation to a line that is itself a command, path, or code snippet, since it would corrupt what the user copies.
- Plain text only. No markdown (*, _, #, backticks, code fences), emojis, or decorative symbols; a screen reader speaks them literally.
- No tables, ASCII art, or diagrams. Give structured data as prose or a numbered list.
- Prefer numbered lists over bullets so the user can refer back by number ("more on 2").
- Announce structure in words, not headings ("First,", "Three files changed:").
- No spatial references ("above", "below", "on the left"); restate the thing instead.
- Put each file path, command, and code snippet on its own line, introduced first ("Run this:"). Keep snippets short, plain indentation, no fences.
- Describe changes in words, not diffs ("in config.ts I changed the timeout from 30 to 60"). Say what code does before showing it.
- Convey meaning with words, never formatting.

Any of these rules may be overridden by the user: if they explicitly ask for something a rule discourages (a full URL, a raw id, markdown, a diff), honor the request for that response.`;

/** The screen-reader output rules exactly as they appear in the rendered prompt. */
export const SCREEN_READER_OUTPUT_RULES = `<${SCREEN_READER_OUTPUT_SECTION}>\n${SCREEN_READER_OUTPUT_RULES_BODY}\n</${SCREEN_READER_OUTPUT_SECTION}>`;

/**
 * Text sent in place of the structured prompt when a `before_agent_start` handler forces one.
 * In accessible mode the screen-reader rules are appended unless the forced text already has them.
 */
export function renderForcedSystemPrompt(forceSystemPrompt: string, mode: ExtensionMode | undefined): string {
	if (mode !== "accessible" || forceSystemPrompt.includes(SCREEN_READER_OUTPUT_RULES)) return forceSystemPrompt;
	return forceSystemPrompt.length > 0
		? `${forceSystemPrompt}\n\n${SCREEN_READER_OUTPUT_RULES}`
		: SCREEN_READER_OUTPUT_RULES;
}

/** Normalize prompt input into the mutable, collection-complete shape exposed to extensions. */
export function normalizeBuildSystemPromptOptions(input: BuildSystemPromptOptions): NormalizedBuildSystemPromptOptions {
	return {
		customPrompt: input.customPrompt,
		forceSystemPrompt: input.forceSystemPrompt,
		selectedTools: [...(input.selectedTools ?? ["read", "bash", "edit", "write"])],
		hiddenTools: [...(input.hiddenTools ?? [])],
		toolSnippets: { ...(input.toolSnippets ?? {}) },
		toolGuidelines: Object.fromEntries(
			Object.entries(input.toolGuidelines ?? {}).map(([name, guidelines]) => [name, [...guidelines]]),
		),
		promptGuidelines: [...(input.promptGuidelines ?? [])],
		appendSystemPrompt: input.appendSystemPrompt ?? "",
		sections: { ...(input.sections ?? {}) },
		cwd: input.cwd,
		contextFiles: (input.contextFiles ?? []).map((file) => ({ ...file })),
		skills: (input.skills ?? []).map((skill) => ({ ...skill })),
		mode: input.mode,
	};
}

function renderProjectContext(contextFiles: Array<{ path: string; content: string }>): string {
	return [
		"Project-specific instructions and guidelines:",
		...contextFiles.map(
			({ path, content }) => `<project_instructions path="${path}">\n${content}\n</project_instructions>`,
		),
	].join("\n\n");
}

function buildRules(
	selectedTools: string[],
	toolGuidelines: Record<string, string[]>,
	promptGuidelines: string[],
): string {
	const rules: string[] = [];
	const seen = new Set<string>();
	const addRule = (rule: string): void => {
		const normalized = rule.trim();
		if (!normalized || seen.has(normalized)) return;
		seen.add(normalized);
		rules.push(normalized);
	};

	const hasBash = selectedTools.includes("bash");
	const hasPowerShell = selectedTools.includes("powershell");
	const hasGrep = selectedTools.includes("grep");
	const hasFind = selectedTools.includes("find");
	const hasLs = selectedTools.includes("ls");

	if ((hasBash || hasPowerShell) && !hasGrep && !hasFind && !hasLs) {
		if (hasBash && hasPowerShell) {
			addRule("Use bash or PowerShell for file operations like listing, searching, and finding files");
		} else if (hasPowerShell) {
			addRule("Use PowerShell for file operations like listing, searching, and finding files");
		} else {
			addRule("Use bash for file operations like ls, rg, find");
		}
	}

	for (const name of selectedTools) {
		for (const rule of toolGuidelines[name] ?? []) addRule(rule);
	}
	for (const rule of promptGuidelines) addRule(rule);
	addRule("Be concise in your responses");
	addRule("Show file paths clearly when working with files");
	return rules.map((rule) => `- ${rule}`).join("\n");
}

/** Build the ordered, independently replaceable sections of the structured system prompt. */
export function buildSystemPromptSections(input: BuildSystemPromptOptions): SystemPromptSections {
	const options = normalizeBuildSystemPromptOptions(input);
	const {
		customPrompt,
		selectedTools,
		hiddenTools,
		toolSnippets,
		toolGuidelines,
		promptGuidelines,
		appendSystemPrompt,
		sections: customSections,
		cwd,
		contextFiles,
		skills,
		mode,
	} = options;

	for (const name of Object.keys(customSections)) {
		if (!SYSTEM_PROMPT_SECTION_NAME.test(name) || name === "preamble") {
			throw new Error(`Invalid system prompt section name: ${name}`);
		}
	}

	const declaredTools = selectedTools.filter((name) => !hiddenTools.includes(name));
	const promptSections: Record<string, string> = {};
	if (customPrompt) {
		promptSections.preamble = customPrompt;
	} else {
		promptSections.preamble =
			"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";
		const visibleTools = declaredTools.filter((name) => !!toolSnippets[name]);
		const tools =
			visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets[name]}`).join("\n") : "(none)";
		promptSections.tools = `${tools}\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.`;
		promptSections.rules = buildRules(declaredTools, toolGuidelines, promptGuidelines);
		promptSections.docs = `Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${getReadmePath()}
- Additional docs: ${getDocsPath()}
- Examples: ${getExamplesPath()} (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md), environment variables (docs/environment-variables.md), MCP servers (docs/mcp.md), codemode scripts and non-LLM models such as classifiers and image models (docs/codemode.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;
	}

	if (appendSystemPrompt) promptSections.addendum = appendSystemPrompt;
	if (contextFiles.length > 0) promptSections.project_context = renderProjectContext(contextFiles);
	// A hidden reader is still reachable through another tool, so skills stay but the hint names no tool.
	const readers = ["read", "bash"] as const;
	const skillFileReadTool =
		readers.find((tool) => declaredTools.includes(tool)) ??
		(readers.some((tool) => selectedTools.includes(tool)) ? "indirect" : undefined);
	if (skillFileReadTool && skills.length > 0) {
		const skillsPrompt = formatSkillsForPrompt(skills, skillFileReadTool).trim();
		if (skillsPrompt) promptSections.skills = skillsPrompt;
	}
	// Accessibility output rules apply regardless of custom vs. default base prompt.
	if (mode === "accessible") promptSections[SCREEN_READER_OUTPUT_SECTION] = SCREEN_READER_OUTPUT_RULES_BODY;
	promptSections.cwd = cwd.replace(/\\/g, "/");
	for (const [name, content] of Object.entries(customSections)) {
		// Custom sections cannot replace the accessibility rules.
		if (content && !(mode === "accessible" && name === SCREEN_READER_OUTPUT_SECTION)) promptSections[name] = content;
	}

	const sections: SystemPromptSections = { preamble: promptSections.preamble };
	for (const [name, content] of Object.entries(promptSections)) {
		if (name !== "preamble") sections[name] = `<${name}>\n${content}\n</${name}>`;
	}
	return sections;
}

/**
 * The complete prompt state for `input`. A forced prompt is opaque and lives in `content`
 * with no sections; otherwise `content` is empty and the structured sections carry the prompt.
 */
export function buildSystemPromptState(input: BuildSystemPromptOptions): {
	content: string;
	sections?: SystemPromptSections;
} {
	if (input.forceSystemPrompt !== undefined) {
		return { content: renderForcedSystemPrompt(input.forceSystemPrompt, input.mode) };
	}
	return { content: "", sections: buildSystemPromptSections(input) };
}

/** Build the system prompt text, rendered exactly as the transcript's system message replays it. */
export function buildSystemPrompt(input: BuildSystemPromptOptions): string {
	return getSystemMessageText({ role: "system", ...buildSystemPromptState(input), timestamp: 0 });
}

/**
 * Diff the sections the model currently has (replayed from the transcript, so never null)
 * against the desired ones. Returns a `SystemMessage.sections` patch, or undefined when
 * nothing changed.
 */
export function diffSystemPromptSections(
	previous: Record<string, string | null>,
	current: SystemPromptSections,
): Record<string, string | null> | undefined {
	const patch: Record<string, string | null> = {};
	for (const [name, text] of Object.entries(current)) {
		if (previous[name] !== text) patch[name] = text;
	}
	for (const name of Object.keys(previous)) {
		if (current[name] === undefined) patch[name] = null;
	}
	return Object.keys(patch).length > 0 ? patch : undefined;
}
