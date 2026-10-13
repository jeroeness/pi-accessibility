/**
 * Text-based `/login` and `/logout` for accessible mode.
 *
 * Reuses the same auth logic as the TUI (`modelRuntime.login()` for subscriptions /
 * OAuth and API keys, `modelRuntime.logout()` for removal), but drives every
 * interaction point through readline text prompts instead of TUI dialogs.
 */

import type { AuthEvent, AuthPrompt, Model } from "@earendil-works/pi-ai";
import { getAuthPath } from "../../config.ts";
import { defaultModelPerProvider } from "../../core/model-resolver.ts";
import { CredentialSynchronizationError } from "../../core/model-runtime.ts";
import { isUnknownModel } from "./model-label.ts";
import type { CommandContext } from "./types.ts";

const LOGIN_CANCELLED = "Login cancelled";

interface ProviderOption {
	id: string;
	name: string;
	authType: "oauth" | "api_key";
	/** Display name of the auth method (e.g. "Anthropic API key"). */
	methodName: string;
	/** False for ambient-only API-key auth (AWS profiles, ADC files, ...) that pi cannot set up. */
	canLogin: boolean;
}

function hasDefaultModelProvider(providerId: string): providerId is keyof typeof defaultModelPerProvider {
	return providerId in defaultModelPerProvider;
}

/** Print a numbered list and read a 1-based choice; returns a 0-based index or undefined. */
async function selectNumber(
	ctx: CommandContext,
	title: string,
	labels: readonly string[],
	signal?: AbortSignal,
): Promise<number | undefined> {
	ctx.writer.line(title);
	labels.forEach((label, index) => {
		ctx.writer.line(`  ${index + 1}. ${label}`);
	});
	const answer = (await ctx.prompter.question("Enter a number (Enter to cancel): ", signal)).trim();
	if (answer === "" || answer.toLowerCase() === "q") {
		return undefined;
	}
	const choice = Number.parseInt(answer, 10);
	if (Number.isNaN(choice) || choice < 1 || choice > labels.length) {
		return undefined;
	}
	return choice - 1;
}

function getLoginProviderOptions(ctx: CommandContext, authType: "oauth" | "api_key"): ProviderOption[] {
	const options: ProviderOption[] = [];
	for (const provider of ctx.session.modelRuntime.getProviders()) {
		if (authType === "oauth" && provider.auth.oauth) {
			options.push({
				id: provider.id,
				name: provider.name,
				authType,
				methodName: provider.auth.oauth.name,
				canLogin: true,
			});
		}
		if (authType === "api_key" && provider.auth.apiKey) {
			options.push({
				id: provider.id,
				name: provider.name,
				authType,
				methodName: provider.auth.apiKey.name,
				canLogin: provider.auth.apiKey.login !== undefined,
			});
		}
	}
	return options.sort((a, b) => a.name.localeCompare(b.name));
}

/** Answer one login prompt (text, secret, manual code, or a choice) through readline. */
async function answerPrompt(ctx: CommandContext, prompt: AuthPrompt): Promise<string> {
	if (prompt.type === "select") {
		const index = await selectNumber(
			ctx,
			prompt.message,
			prompt.options.map((option) => option.label),
			prompt.signal,
		);
		if (index === undefined) {
			throw new Error(LOGIN_CANCELLED);
		}
		return prompt.options[index].id;
	}
	// End the question with punctuation so a screen reader pauses before the input.
	ctx.writer.line(/[.?!:]$/.test(prompt.message) ? prompt.message : `${prompt.message}:`);
	// A secret (an API key) is read without echo, so it never lands on screen or in
	// scrollback; the prompt says so, since typing then gives no feedback.
	const secret = prompt.type === "secret";
	const query = `${secret ? "(typing is hidden) " : ""}${prompt.placeholder ? `(${prompt.placeholder}) ` : "> "}`;
	const answer = (await ctx.prompter.question(query, prompt.signal, secret ? { secret: true } : undefined)).trim();
	// An empty answer cancels, so a stray Enter never stores an empty key.
	if (answer === "") {
		throw new Error(LOGIN_CANCELLED);
	}
	return answer;
}

function renderAuthEvent(ctx: CommandContext, event: AuthEvent): void {
	switch (event.type) {
		case "auth_url":
			ctx.writer.line("Open this URL in a browser to authenticate:");
			ctx.writer.line(event.url);
			if (event.instructions) {
				ctx.writer.line(event.instructions);
			}
			return;
		case "device_code":
			ctx.writer.line(`Go to ${event.verificationUri} and enter this code: ${event.userCode}`);
			if (event.expiresInSeconds) {
				ctx.writer.line(`The code expires in about ${Math.round(event.expiresInSeconds / 60)} minute(s).`);
			}
			ctx.writer.line("Waiting for authentication…");
			return;
		case "info":
			ctx.writer.line(event.message);
			for (const link of event.links ?? []) {
				ctx.writer.line(link.label ? `${link.label}: ${link.url}` : link.url);
			}
			return;
		case "progress":
			ctx.writer.line(`[${event.message}]`);
			return;
	}
}

/**
 * After a successful login, select the provider's default model when no usable model
 * is active yet, then report. The provider's catalog is refreshed first so dynamic
 * catalogs (e.g. GitHub Copilot) list their models.
 */
async function completeAuth(
	ctx: CommandContext,
	provider: ProviderOption,
	previousModel: Model<any> | undefined,
): Promise<void> {
	const { session } = ctx;
	const actionLabel =
		provider.authType === "oauth" ? `Logged in to ${provider.name}` : `Saved API key for ${provider.name}`;

	try {
		const result = await session.modelRuntime.refresh({
			providers: [provider.id],
			signal: AbortSignal.timeout(15_000),
		});
		if (result.aborted) {
			ctx.writer.line(`${actionLabel}, but its model catalog refresh timed out; using cached models.`);
		} else if (result.errors.size > 0) {
			ctx.writer.line(`${actionLabel}, but its model catalog could not be refreshed; using cached models.`);
		}
	} catch (error: unknown) {
		ctx.writer.line(
			`${actionLabel}, but its model catalog could not be refreshed: ${error instanceof Error ? error.message : String(error)}.`,
		);
	}

	let selected: Model<any> | undefined;
	if (!previousModel || isUnknownModel(previousModel)) {
		const providerModels = session.modelRuntime.getAvailableSnapshot().filter((m) => m.provider === provider.id);
		const defaultId = hasDefaultModelProvider(provider.id) ? defaultModelPerProvider[provider.id] : undefined;
		selected = providerModels.find((m) => m.id === defaultId) ?? providerModels[0];
		if (selected) {
			try {
				await session.setModel(selected, { persist: true });
			} catch {
				selected = undefined;
			}
		}
	}

	if (selected) {
		ctx.writer.line(
			`${actionLabel}. Selected ${selected.provider}/${selected.id}. Credentials saved to ${getAuthPath()}.`,
		);
	} else {
		ctx.writer.line(`${actionLabel}. Credentials saved to ${getAuthPath()}. Use /model to select a model.`);
	}
}

async function authenticate(ctx: CommandContext, provider: ProviderOption): Promise<void> {
	const previousModel = ctx.session.model;
	await ctx.session.modelRuntime.login(
		provider.id,
		provider.authType,
		{
			prompt: (prompt) => answerPrompt(ctx, prompt),
			notify: (event) => renderAuthEvent(ctx, event),
		},
		{ getDeviceId: () => ctx.session.settingsManager.getOrCreateDeviceId() },
	);
	await completeAuth(ctx, provider, previousModel);
}

/** Run the `/login` flow: choose subscription vs API key, pick a provider, authenticate. */
export async function runLogin(ctx: CommandContext): Promise<void> {
	const method = await selectNumber(ctx, "Select authentication method:", ["Use a subscription", "Use an API key"]);
	if (method === undefined) {
		ctx.writer.line("Login cancelled.");
		return;
	}

	const authType = method === 0 ? "oauth" : "api_key";
	const options = getLoginProviderOptions(ctx, authType);
	if (options.length === 0) {
		ctx.writer.line(
			authType === "oauth" ? "No subscription providers available." : "No API key providers available.",
		);
		return;
	}

	const index = await selectNumber(
		ctx,
		authType === "oauth" ? "Select a subscription provider:" : "Select an API key provider:",
		options.map((option) => option.name),
	);
	if (index === undefined) {
		ctx.writer.line("Login cancelled.");
		return;
	}

	const provider = options[index];
	if (!provider.canLogin) {
		// Ambient-only auth (environment variables, cloud credential files) is set up outside pi.
		ctx.writer.line(`${provider.methodName} is configured outside pi, not with /login.`);
		ctx.writer.line("See docs/providers.md.");
		return;
	}
	try {
		await authenticate(ctx, provider);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		if (error instanceof CredentialSynchronizationError) {
			ctx.writer.error(
				`${provider.authType === "oauth" ? `Logged in to ${provider.name}` : `Saved API key for ${provider.name}`}, but local model state could not be synchronized: ${message}`,
			);
		} else if (message === LOGIN_CANCELLED) {
			ctx.writer.line("Login cancelled.");
		} else {
			ctx.writer.error(`Login failed for ${provider.name}: ${message}`);
		}
	}
}

/** Run the `/logout` flow: pick a stored credential and remove it. */
export async function runLogout(ctx: CommandContext): Promise<void> {
	const { modelRuntime } = ctx.session;
	let options: Array<{ id: string; name: string; authType: "oauth" | "api_key" }>;
	try {
		options = (await modelRuntime.listCredentials({ signal: AbortSignal.timeout(15_000) }))
			.map(({ providerId, type }) => ({
				id: providerId,
				name: modelRuntime.getProvider(providerId)?.name ?? providerId,
				authType: type,
			}))
			.sort((a, b) => a.name.localeCompare(b.name));
	} catch (error: unknown) {
		ctx.writer.error(`Could not read stored credentials: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}

	if (options.length === 0) {
		ctx.writer.line(
			"No stored credentials to remove. /logout only removes credentials saved by /login; environment variables and models.json are unchanged.",
		);
		return;
	}

	const index = await selectNumber(
		ctx,
		"Select a provider to log out of:",
		options.map((option) => option.name),
	);
	if (index === undefined) {
		ctx.writer.line("Logout cancelled.");
		return;
	}

	const provider = options[index];
	try {
		await modelRuntime.logout(provider.id, { signal: AbortSignal.timeout(15_000) });
		ctx.writer.line(
			provider.authType === "oauth"
				? `Logged out of ${provider.name}.`
				: `Removed stored API key for ${provider.name}. Environment variables and models.json are unchanged.`,
		);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.writer.error(
			error instanceof CredentialSynchronizationError
				? `Credentials removed for ${provider.name}, but local model state could not be synchronized: ${message}`
				: `Logout failed: ${message}`,
		);
	}
}
