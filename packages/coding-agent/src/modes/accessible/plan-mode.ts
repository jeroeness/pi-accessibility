/**
 * Plan mode for the accessible REPL.
 *
 * A lightweight, screen-reader-friendly toggle between two working modes:
 *
 * - Plan mode (`/plan`): the mutating tools (edit, write, bash, powershell) are removed from
 *   the active set, leaving only read-only tools (read, grep, find, ls, and any
 *   other non-mutating tools). The model physically cannot change the workspace,
 *   and a short directive is prefixed to each turn asking it to investigate and
 *   reply with a numbered plan instead of acting.
 * - Build mode (`/build`): the pre-plan tool set is restored, giving the model
 *   full access again.
 *
 * The tool swap is the hard guarantee (enforced by the session); the prefixed
 * directive is the soft nudge that keeps the model producing a plan.
 */

import type { AgentSession } from "../../core/agent-session.ts";

/** Tools removed from the active set while plan mode is on. powershell is the Windows shell tool. */
const MUTATING_TOOLS = new Set(["edit", "write", "bash", "powershell"]);

/**
 * Read-only tools plan mode ensures are available for exploration. grep/find/ls
 * are registered but off by default, so plan mode turns them on. Any tool the
 * user excluded is not in the registry and is silently dropped by the session.
 */
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

/** Prefixed to each user turn while plan mode is active. */
export const PLAN_MODE_GUIDANCE =
	"[Plan mode is active. Edit, write, and bash are disabled — you have read-only tools only. " +
	'Investigate as needed, then reply with a numbered plan under a "Plan:" heading. ' +
	"Do not attempt to make changes.]";

export interface PlanModeController {
	/** Whether plan mode is currently on. */
	isActive(): boolean;
	/**
	 * Enter plan mode: remember the current tool set, drop the mutating tools, and
	 * ensure the read-only exploration tools are active. Returns the tool names now
	 * active (as resolved by the session's registry). Idempotent.
	 */
	enter(session: AgentSession): string[];
	/** Leave plan mode and restore the tool set captured on {@link enter}. */
	exit(session: AgentSession): void;
	/** Prefix the plan directive to a user message while plan mode is active. */
	decorate(text: string): string;
}

/** Create a plan-mode controller. State is held in the closure, not on the session. */
export function createPlanMode(): PlanModeController {
	let active = false;
	let savedTools: string[] | undefined;

	return {
		isActive: () => active,

		enter(session: AgentSession): string[] {
			// Capture the full tool set once, so a repeated /plan does not overwrite it
			// with the already-restricted set.
			if (!active) {
				savedTools = session.getActiveToolNames();
			}
			const source = savedTools ?? session.getActiveToolNames();
			// Keep any other active non-mutating tools (e.g. custom read-only tools),
			// and add the standard read-only exploration set.
			const planTools = [...new Set([...source.filter((name) => !MUTATING_TOOLS.has(name)), ...READ_ONLY_TOOLS])];
			session.setActiveToolsByName(planTools);
			active = true;
			// Report what the session actually activated (unknown/excluded tools dropped).
			return session.getActiveToolNames();
		},

		exit(session: AgentSession): void {
			if (savedTools) {
				session.setActiveToolsByName(savedTools);
			}
			savedTools = undefined;
			active = false;
		},

		decorate(text: string): string {
			return active ? `${PLAN_MODE_GUIDANCE}\n\n${text}` : text;
		},
	};
}
