/**
 * Plan mode for the accessible REPL.
 *
 * A lightweight, screen-reader-friendly toggle between two working modes:
 *
 * - Plan mode (`/plan`): only read-only tools stay active. The model cannot change
 *   the workspace, and a short directive is appended to each turn asking it to
 *   investigate and reply with a numbered plan instead of acting.
 * - Build mode (`/build`): the pre-plan tool set is restored, giving the model
 *   full access again.
 *
 * Read-only is an allowlist, not a denylist: the built-in exploration tools (read,
 * grep, find, ls) plus any tool whose definition declares `annotations.readOnlyHint`
 * (MCP servers report this per tool) and cannot call other tools. Everything else
 * is dropped, including bash, edit, write, powershell, codemode, tool_search,
 * subagent-style extension tools, and MCP tools that are not marked read-only.
 *
 * Two layers enforce it:
 * - The active tool set (what is declared to the model) is restricted on `/plan`,
 *   and re-restricted before each turn so tools activated later (for example
 *   codemode, when an MCP server connects) are dropped again.
 * - A session tool-call guard blocks any call to a tool outside the allowlist,
 *   including calls a tool makes through `ctx.executeTool()`.
 *
 * Plan mode belongs to the REPL, not to one session: after `/new` or `/resume` the
 * restriction is re-applied to the new session (see {@link PlanModeController.reapply}).
 */

import type { AgentSession } from "../../core/agent-session.ts";

/**
 * Built-in read-only tools plan mode keeps and turns on for exploration. grep/find/ls
 * are registered but off by default. Any tool the user excluded is not in the
 * registry and is silently dropped by the session.
 */
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

/** Appended to each user turn while plan mode is active. */
export const PLAN_MODE_GUIDANCE =
	"[Plan mode is active. Only read-only tools are available; edit, write, bash, and other tools that can make changes are disabled. " +
	'Investigate as needed, then reply with a numbered plan under a "Plan:" heading. ' +
	"Do not attempt to make changes.]";

/** Whether `name` may run in plan mode: a built-in read-only tool, or one declared read-only that reaches no other tools. */
export function isPlanModeTool(session: AgentSession, name: string): boolean {
	if (READ_ONLY_TOOLS.includes(name)) return true;
	const definition = session.getToolDefinition(name);
	return definition?.annotations?.readOnlyHint === true && definition.reachesTools === undefined;
}

export interface PlanModeController {
	/** Whether plan mode is currently on. */
	isActive(): boolean;
	/**
	 * Enter plan mode: remember the current tool set, keep only the read-only tools,
	 * and block calls to every other tool. Returns the tool names now active (as
	 * resolved by the session's registry). Idempotent.
	 */
	enter(session: AgentSession): string[];
	/** Leave plan mode and restore the tool set captured on {@link enter}. */
	exit(session: AgentSession): void;
	/**
	 * Re-apply plan mode to `session` when it is active: a new session (`/new`,
	 * `/resume`) starts with its own tools, so its full set becomes the restore point
	 * and is restricted again. A no-op when plan mode is off or `session` is the one
	 * already restricted (a rebind of the same session).
	 */
	reapply(session: AgentSession): void;
	/**
	 * Drop tools activated since plan mode was entered (they are kept for `/build`).
	 * Called before each turn. A no-op when plan mode is off.
	 */
	enforce(session: AgentSession): void;
	/** Append the plan directive to a user message while plan mode is active. */
	decorate(text: string): string;
}

/** Create a plan-mode controller. State is held in the closure, not on the session. */
export function createPlanMode(): PlanModeController {
	let active = false;
	let savedTools: string[] | undefined;
	// The session the restriction was applied to; a rebind of the same session keeps it.
	let appliedTo: AgentSession | undefined;

	const restrict = (session: AgentSession, source: readonly string[]): void => {
		appliedTo = session;
		const planTools = [...new Set([...source.filter((name) => isPlanModeTool(session, name)), ...READ_ONLY_TOOLS])];
		session.setActiveToolsByName(planTools);
		session.setToolCallGuard((name) =>
			isPlanModeTool(session, name)
				? undefined
				: `Plan mode is active: ${name} is disabled. Only read-only tools are available. The user can type /build to restore full access.`,
		);
	};

	return {
		isActive: () => active,

		enter(session: AgentSession): string[] {
			// Capture the full tool set once, so a repeated /plan does not overwrite it
			// with the already-restricted set.
			if (!active) {
				savedTools = session.getActiveToolNames();
			}
			restrict(session, savedTools ?? session.getActiveToolNames());
			active = true;
			// Report what the session actually activated (unknown/excluded tools dropped).
			return session.getActiveToolNames();
		},

		exit(session: AgentSession): void {
			session.setToolCallGuard(undefined);
			if (savedTools) {
				session.setActiveToolsByName(savedTools);
			}
			savedTools = undefined;
			appliedTo = undefined;
			active = false;
		},

		reapply(session: AgentSession): void {
			if (!active || session === appliedTo) return;
			savedTools = session.getActiveToolNames();
			restrict(session, savedTools);
		},

		enforce(session: AgentSession): void {
			if (!active) return;
			const current = session.getActiveToolNames();
			// Tools activated since /plan are restored by /build, whether or not they may run now.
			const added = current.filter((name) => !savedTools?.includes(name) && !READ_ONLY_TOOLS.includes(name));
			if (added.length === 0) return;
			savedTools = [...(savedTools ?? []), ...added];
			if (added.some((name) => !isPlanModeTool(session, name))) {
				restrict(session, current);
			}
		},

		decorate(text: string): string {
			// The directive follows the user's text, so the session is titled (and listed by
			// /resume) after what the user asked rather than after the directive.
			return active ? `${text}\n\n${PLAN_MODE_GUIDANCE}` : text;
		},
	};
}
