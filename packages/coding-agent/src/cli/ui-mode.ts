/**
 * Environment signals that choose between the accessible REPL (the default) and the
 * full-screen TUI. Shared by the main entry point and the package commands
 * (`pi install`, `pi remove`, ...), which take no `--tui`/`--accessible` flags.
 */

function isTruthy(value: string | undefined): boolean {
	if (!value) return false;
	const lowered = value.toLowerCase();
	return value === "1" || lowered === "true" || lowered === "yes";
}

/** PI_ACCESSIBLE, NO_TUI, and TERM=dumb ask for (or imply) the plain accessible REPL. */
export function accessibleRequestedByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
	return isTruthy(env.PI_ACCESSIBLE) || isTruthy(env.NO_TUI) || env.TERM === "dumb";
}

/** PI_TUI opts into the TUI, unless an accessible signal is also present. */
export function tuiRequestedByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
	return !accessibleRequestedByEnv(env) && isTruthy(env.PI_TUI);
}
